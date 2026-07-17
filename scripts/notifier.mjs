#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { startDesktopNotificationTurn } from "./desktop-ipc.mjs";
import { resolveOwnerRolloutFile, sanitizeThreadId } from "./session.mjs";
import { nowIso, readJob, updateJob } from "./state.mjs";

export { resolveOwnerRolloutFile } from "./session.mjs";

const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 12;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_IDLE_SETTLE_MS = 1_500;
const MAX_LIFECYCLE_TAIL_BYTES = 8 * 1024 * 1024;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "cancel_failed"]);

function parsePositiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

export function buildNotificationPrompt(job) {
  const id = String(job.id ?? "");
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(id)) throw new Error("Invalid job id for notification relay.");
  const status = String(job.status ?? "");
  if (!TERMINAL_STATUSES.has(status)) throw new Error(`Job ${id} is not terminal.`);
  const exitCode = Number.isInteger(job.exitCode) ? String(job.exitCode) : "not reported";
  const outcome = status === "completed" ? "finished successfully" : `finished with status ${status}`;
  return [
    "### Background job finished",
    "",
    `\`${id}\` ${outcome} with exit code \`${exitCode}\`.`,
    "",
    "_This automatic Codex Process Jobs notice contains no process output._",
    "",
    "> **Codex Process Jobs notice:** Briefly acknowledge this completion and mention that the saved result is available. Wait for the user's direction before inspecting it or resuming other work.",
  ].join("\n");
}

export function readLatestTaskLifecycle(file) {
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, MAX_LIFECYCLE_TAIL_BYTES);
  if (length === 0) return null;
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(file, "r");
  try {
    fs.readSync(descriptor, buffer, 0, length, stat.size - length);
  } finally {
    fs.closeSync(descriptor);
  }
  const lines = buffer.toString("utf8").split("\n");
  if (stat.size > length) lines.shift();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      const lifecycle = event?.type === "event_msg" ? event?.payload?.type : null;
      if (lifecycle === "task_started" || lifecycle === "task_complete") {
        return {
          type: lifecycle,
          turnId: event.payload?.turn_id ?? null,
          timestamp: event.timestamp ?? null,
        };
      }
    } catch {}
  }
  return null;
}

export async function waitForOwnerIdle(job, env = process.env) {
  if (env.CODEX_PROCESS_JOBS_SKIP_SESSION_IDLE_CHECK === "1") {
    return { idle: true, reason: "session lifecycle check disabled for isolated testing" };
  }
  const rolloutFile = resolveOwnerRolloutFile(job.ownerThreadId, env);
  if (!rolloutFile) return { idle: false, reason: "owning Codex session transcript was not found" };
  const first = readLatestTaskLifecycle(rolloutFile);
  if (first?.type !== "task_complete") {
    return { idle: false, reason: `latest owning-thread lifecycle is ${first?.type ?? "unknown"}` };
  }
  const settleMs = parsePositiveInteger(
    env.CODEX_PROCESS_JOBS_NOTIFY_IDLE_SETTLE_MS,
    DEFAULT_IDLE_SETTLE_MS,
    30_000
  );
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const second = readLatestTaskLifecycle(rolloutFile);
  if (second?.type !== "task_complete" || second.turnId !== first.turnId) {
    return { idle: false, reason: `owning Codex thread changed during the ${settleMs}ms idle-settle window` };
  }
  return {
    idle: true,
    reason: `owning Codex thread is settled after ${second.turnId ?? "its latest turn"}`,
    turnId: second.turnId ?? null,
  };
}

function relayError(message, { accepted = false } = {}) {
  const error = new Error(message);
  error.turnAccepted = accepted;
  return error;
}

export async function waitForNotificationTurnComplete(job, turnId, timeoutMs, env = process.env) {
  const rolloutFile = resolveOwnerRolloutFile(job.ownerThreadId, env);
  if (!rolloutFile) throw relayError("Owning Codex session transcript was not found after Desktop IPC accepted the turn.", { accepted: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lifecycle = readLatestTaskLifecycle(rolloutFile);
    if (lifecycle?.type === "task_complete" && lifecycle.turnId === turnId) {
      return { threadId: sanitizeThreadId(job.ownerThreadId), turnId, status: "completed", transport: "desktop-ipc" };
    }
    await delay(100);
  }
  throw relayError(`Desktop IPC notification turn timed out after ${timeoutMs}ms (turn ${turnId}).`, { accepted: true });
}

async function deliverAppServerNotificationTurn(job, threadId, prompt, timeoutMs, env) {
  const codex = env.CODEX_PROCESS_JOBS_CODEX_BIN || "codex";

  return await new Promise((resolve, reject) => {
    const child = spawn(codex, ["app-server"], {
      cwd: job.cwd,
      env: { ...env, CODEX_PROCESS_JOBS_NOTIFICATION_RELAY: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let settled = false;
    let accepted = false;
    let turnId = null;
    let stderr = "";

    const timeout = setTimeout(() => {
      finish(reject, relayError(
        `Notification turn timed out after ${timeoutMs}ms${turnId ? ` (turn ${turnId})` : ""}.`,
        { accepted }
      ));
    }, timeoutMs);

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function cleanup() {
      clearTimeout(timeout);
      lines.close();
      child.stdin.end();
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
    }

    function finish(handler, value) {
      if (settled) return;
      settled = true;
      cleanup();
      handler(value);
    }

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      finish(reject, relayError(`Unable to start Codex app-server: ${error.message}`, { accepted }));
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
      finish(reject, relayError(`Codex app-server exited early (code=${code}, signal=${signal})${detail}`, { accepted }));
    });
    child.stdin.on("error", (error) => {
      finish(reject, relayError(`Unable to write to Codex app-server: ${error.message}`, { accepted }));
    });

    lines.on("line", (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      if (message.id === 1) {
        if (message.error) {
          finish(reject, relayError(`Codex app-server initialize failed: ${JSON.stringify(message.error)}`));
          return;
        }
        send({ method: "initialized", params: {} });
        send({ id: 2, method: "thread/resume", params: { threadId } });
        return;
      }

      if (message.id === 2) {
        if (message.error) {
          finish(reject, relayError(`Unable to resume owning Codex thread: ${JSON.stringify(message.error)}`));
          return;
        }
        const threadStatus = message.result?.thread?.status?.type ?? "unknown";
        if (threadStatus !== "idle") {
          finish(reject, relayError(`Owning Codex thread is ${threadStatus}; notification will retry when it is idle.`));
          return;
        }
        send({
          id: 3,
          method: "turn/start",
          params: {
            threadId,
            input: [{ type: "text", text: prompt }],
          },
        });
        return;
      }

      if (message.id === 3) {
        if (message.error) {
          finish(reject, relayError(`Unable to start notification turn: ${JSON.stringify(message.error)}`));
          return;
        }
        accepted = true;
        turnId = message.result?.turn?.id ?? null;
        return;
      }

      if (message.method === "turn/completed" && message.params?.threadId === threadId) {
        const turn = message.params?.turn ?? {};
        if (turn.status === "completed") {
          finish(resolve, { threadId, turnId: turn.id ?? turnId, status: turn.status, transport: "app-server" });
        } else {
          finish(reject, relayError(
            `Notification turn ended with status ${turn.status ?? "unknown"}.`,
            { accepted: true }
          ));
        }
      }
    });

    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex-process-jobs",
          title: "Codex Process Jobs",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

export async function deliverNotificationTurn(job, env = process.env) {
  const threadId = sanitizeThreadId(job.ownerThreadId);
  const prompt = buildNotificationPrompt(job);
  const timeoutMs = parsePositiveInteger(
    env.CODEX_PROCESS_JOBS_NOTIFY_TURN_TIMEOUT_MS,
    DEFAULT_TURN_TIMEOUT_MS,
    10 * 60_000
  );

  const idle = await waitForOwnerIdle(job, env);
  if (!idle.idle) throw relayError(`Owning Codex thread is not safely idle: ${idle.reason}.`);

  try {
    const accepted = await startDesktopNotificationTurn(job, prompt, threadId, timeoutMs, env, {
      beforeStart: async () => {
        const rolloutFile = resolveOwnerRolloutFile(job.ownerThreadId, env);
        const latest = rolloutFile ? readLatestTaskLifecycle(rolloutFile) : null;
        if (
          latest?.type !== "task_complete"
          || latest.turnId !== idle.turnId
        ) {
          throw relayError("Owning Codex thread changed before Desktop IPC delivery could start.");
        }
      },
    });
    if (accepted) return await waitForNotificationTurnComplete(job, accepted.turnId, timeoutMs, env);
  } catch (error) {
    if (error?.turnAccepted) throw error;
  }

  return await deliverAppServerNotificationTurn(job, threadId, prompt, timeoutMs, env);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function notificationSuppressed(job) {
  return Boolean(job.resultViewedAt) || [
    "disabled",
    "unavailable",
    "suppressed",
    "accepted",
    "delivered",
    "fallback_notified",
  ].includes(job.notification?.status);
}

function relayInFlight(job) {
  return job.notification?.status === "delivering";
}

export async function runNotifier(jobId, env = process.env) {
  let job = readJob(jobId, env);
  if (!TERMINAL_STATUSES.has(job.status)) throw new Error(`Job ${job.id} is not terminal.`);
  if (notificationSuppressed(job) || relayInFlight(job)) return job;
  if (!job.ownerThreadId) {
    return await updateJob(job.id, (current) => ({
      ...current,
      notification: {
        ...(current.notification ?? {}),
        status: "unavailable",
        errorMessage: "No owning persistent Codex thread id was captured.",
      },
    }), env);
  }

  const maxAttempts = parsePositiveInteger(
    env.CODEX_PROCESS_JOBS_NOTIFY_MAX_ATTEMPTS,
    DEFAULT_MAX_ATTEMPTS,
    100
  );
  const retryDelayMs = parsePositiveInteger(
    env.CODEX_PROCESS_JOBS_NOTIFY_RETRY_DELAY_MS,
    DEFAULT_RETRY_DELAY_MS,
    60_000
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    job = readJob(job.id, env);
    if (notificationSuppressed(job) || relayInFlight(job)) return job;
    let attemptClaimed = false;
    job = await updateJob(job.id, (current) => {
      if (notificationSuppressed(current) || relayInFlight(current)) return current;
      attemptClaimed = true;
      return {
        ...current,
        notification: {
          ...(current.notification ?? {}),
          status: "delivering",
          attempts: attempt,
          lastAttemptAt: nowIso(),
          errorMessage: null,
        },
      };
    }, env);
    if (!attemptClaimed) return job;

    try {
      const delivered = await deliverNotificationTurn(job, env);
      return await updateJob(job.id, (current) => {
        if (notificationSuppressed(current)) return current;
        return {
          ...current,
          notification: {
            ...(current.notification ?? {}),
            status: "delivered",
            deliveredAt: nowIso(),
            threadId: delivered.threadId,
            turnId: delivered.turnId,
            transport: delivered.transport,
            relayPid: null,
            errorMessage: null,
          },
        };
      }, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const accepted = Boolean(error?.turnAccepted);
      let failureRecorded = false;
      job = await updateJob(job.id, (current) => {
        if (notificationSuppressed(current)) return current;
        failureRecorded = true;
        return {
          ...current,
          notification: {
            ...(current.notification ?? {}),
            status: accepted ? "accepted" : attempt === maxAttempts ? "failed" : "pending",
            errorMessage: message,
            failedAt: attempt === maxAttempts || accepted ? nowIso() : null,
            relayPid: attempt === maxAttempts || accepted ? null : current.notification?.relayPid ?? null,
          },
        };
      }, env);
      if (!failureRecorded || accepted || attempt === maxAttempts) return job;
      await delay(Math.min(30_000, retryDelayMs * attempt));
    }
  }
  return readJob(job.id, env);
}

function parseJobId(argv) {
  const index = argv.indexOf("--job-id");
  if (index < 0 || !argv[index + 1]) throw new Error("notifier requires --job-id <id>");
  return argv[index + 1];
}

async function main() {
  await runNotifier(parseJobId(process.argv.slice(2)));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
