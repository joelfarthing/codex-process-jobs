#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { spawn } from "node:child_process";

import { isCliEntry } from "./cli-entry.mjs";
import { enqueueCodexNotification } from "./codex-queue.mjs";
import {
  cliLiveInjectionEnabled,
  startCliAppServerNotificationTurn,
} from "./cli-app-server-ipc.mjs";
import { startDesktopNotificationTurn } from "./desktop-ipc.mjs";
import {
  RUNTIME_DISPLAY_NAME,
  RUNTIME_PLUGIN_NAME,
  RUNTIME_PLUGIN_VERSION,
} from "./plugin-identity.mjs";
import { COMPLETION_MODES, readPreferences } from "./preferences.mjs";
import { resolveOwnerRolloutFile, sanitizeThreadId } from "./session.mjs";
import { listJobs, nowIso, readJob, TERMINAL_STATUSES, updateJob } from "./state.mjs";

export { resolveOwnerRolloutFile } from "./session.mjs";

const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 12;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_IDLE_SETTLE_MS = 1_500;
const DEFAULT_IDLE_WATCH_MS = 60 * 60_000;
const DEFAULT_IDLE_WATCH_POLL_MS = 5_000;
const MAX_LIFECYCLE_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_APP_SERVER_PROTOCOL_LINE_BYTES = 1024 * 1024;
const MAX_APP_SERVER_STDERR_BYTES = 64 * 1024;
const MAX_NOTIFICATION_BATCH = 20;
const MAX_PRIVATE_IPC_FALLBACK_REASON_BYTES = 4096;
const INSPECT_SURFACES = new Set(["app", "remote", "vscode"]);
// Codex 0.149+ can render a queued completion turn in an already-open TUI.
// The queue prompt itself stays concise, while its trusted hook boundary carries
// the full inspection contract. Legacy CLI fallbacks use that same contract on
// the next visible user turn.
const HOOK_INSPECT_SURFACES = new Set(["app", "remote", "vscode", "cli"]);
const PRIVATE_IPC_SURFACES = new Set(["app", "vscode"]);

function parsePositiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function resolveCompletionMode(job, env, autoInspectSurfaces) {
  const override = String(env.CODEX_PROCESS_JOBS_COMPLETION_MODE ?? "").trim().toLowerCase();
  if (override && !COMPLETION_MODES.has(override)) return "report";
  let configured = override;
  if (!configured) {
    try {
      configured = readPreferences(env).completionMode;
    } catch {
      return "report";
    }
  }
  if (configured === "inspect" || configured === "report") return configured;
  return autoInspectSurfaces.has(job.ownerSurface) ? "inspect" : "report";
}

export function completionMode(job, env = process.env) {
  return resolveCompletionMode(job, env, INSPECT_SURFACES);
}

export function hookCompletionMode(job, env = process.env) {
  return resolveCompletionMode(job, env, HOOK_INSPECT_SURFACES);
}

function normalizeNotificationJobs(jobOrJobs) {
  const jobs = Array.isArray(jobOrJobs) ? jobOrJobs : [jobOrJobs];
  if (jobs.length === 0 || jobs.length > MAX_NOTIFICATION_BATCH) {
    throw new Error(`Notification batch must contain 1 to ${MAX_NOTIFICATION_BATCH} jobs.`);
  }
  for (const job of jobs) {
    const id = String(job?.id ?? "");
    if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(id)) throw new Error("Invalid job id for notification relay.");
    const status = String(job.status ?? "");
    if (!TERMINAL_STATUSES.has(status)) throw new Error(`Job ${id} is not terminal.`);
  }
  return jobs;
}

function batchInstructionKey(job, env) {
  return job.goalMode ? "goal" : completionMode(job, env);
}

export function buildNotificationPrompt(jobOrJobs, env = process.env) {
  const jobs = normalizeNotificationJobs(jobOrJobs);
  const instructionKey = batchInstructionKey(jobs[0], env);
  if (jobs.some((job) => batchInstructionKey(job, env) !== instructionKey)) {
    throw new Error("Notification batch mixes incompatible completion instructions.");
  }
  const lines = jobs.map((job) => {
    const outcome = job.status === "completed" ? "finished successfully" : `finished with status ${job.status}`;
    const exitCode = Number.isInteger(job.exitCode) ? ` with exit code ${job.exitCode}` : "";
    return `\`${job.id}\` ${outcome}${exitCode}.`;
  });
  if (jobs.length === 1) return `CPJ background job ${lines[0]}`;
  return ["CPJ background jobs finished.", ...lines].join("\n");
}

export function buildNotificationInput(jobOrJobs, env = process.env) {
  const jobs = normalizeNotificationJobs(jobOrJobs);
  return [{ type: "text", text: buildNotificationPrompt(jobs, env) }];
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

function relayError(message, { accepted = false, retryWhenIdle = false } = {}) {
  const error = new Error(message);
  error.turnAccepted = accepted;
  error.retryWhenIdle = retryWhenIdle;
  return error;
}

function boundedIpcFallbackReason(value) {
  const message = value instanceof Error ? value.message : String(value ?? "");
  if (!message) return null;
  return Buffer.from(message, "utf8")
    .subarray(0, MAX_PRIVATE_IPC_FALLBACK_REASON_BYTES)
    .toString("utf8");
}

function attachDeliveryDiagnostics(error, diagnostics) {
  if (!error || typeof error !== "object") return error;
  for (const [key, value] of Object.entries(diagnostics)) {
    if (value) error[key] = value;
  }
  return error;
}

export async function waitForNotificationTurnComplete(
  job,
  turnId,
  timeoutMs,
  env = process.env,
  transport = "desktop-ipc",
) {
  const rolloutFile = resolveOwnerRolloutFile(job.ownerThreadId, env);
  if (!rolloutFile) throw relayError("Owning Codex session transcript was not found after private IPC accepted the turn.", { accepted: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lifecycle = readLatestTaskLifecycle(rolloutFile);
    if (lifecycle?.type === "task_complete" && lifecycle.turnId === turnId) {
      return { threadId: sanitizeThreadId(job.ownerThreadId), turnId, status: "completed", transport };
    }
    await delay(100);
  }
  throw relayError(`Private IPC notification turn timed out after ${timeoutMs}ms (turn ${turnId}).`, { accepted: true });
}

async function deliverAppServerNotificationTurn(job, threadId, input, timeoutMs, env) {
  const codex = env.CODEX_PROCESS_JOBS_CODEX_BIN || "codex";

  return await new Promise((resolve, reject) => {
    const child = spawn(codex, ["app-server"], {
      cwd: job.cwd,
      env: { ...env, CODEX_PROCESS_JOBS_NOTIFICATION_RELAY: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let settled = false;
    let accepted = false;
    let turnId = null;
    const stdoutLine = Buffer.allocUnsafe(MAX_APP_SERVER_PROTOCOL_LINE_BYTES);
    let stdoutLineLength = 0;
    const stderrBuffer = Buffer.allocUnsafe(MAX_APP_SERVER_STDERR_BYTES);
    let stderrLength = 0;

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
      child.stdout.off("data", onStdoutData);
      child.stderr.off("data", onStderrData);
      child.stdin.end();
      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGTERM");
        const forceKill = setTimeout(() => {
          if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
        }, 1_000);
        forceKill.unref();
        child.once("exit", () => clearTimeout(forceKill));
      }
    }

    function finish(handler, value) {
      if (settled) return;
      settled = true;
      cleanup();
      handler(value);
    }

    function onStderrData(chunk) {
      if (stderrLength + chunk.length > MAX_APP_SERVER_STDERR_BYTES) {
        finish(reject, relayError(
          `Codex app-server stderr exceeded ${MAX_APP_SERVER_STDERR_BYTES} bytes.`,
          { accepted },
        ));
        return;
      }
      chunk.copy(stderrBuffer, stderrLength);
      stderrLength += chunk.length;
    }

    function handleStdoutLine(line) {
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
          const serialized = JSON.stringify(message.error);
          finish(reject, relayError(
            `Unable to resume owning Codex thread: ${serialized}`,
            { retryWhenIdle: /already has an active writer/i.test(serialized) },
          ));
          return;
        }
        const threadStatus = message.result?.thread?.status?.type ?? "unknown";
        if (threadStatus !== "idle") {
          finish(reject, relayError(`Owning Codex thread is ${threadStatus}; notification will retry when it is idle.`, { retryWhenIdle: true }));
          return;
        }
        send({
          id: 3,
          method: "turn/start",
          params: {
            threadId,
            input,
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
        if (!accepted || turnId == null || turn.id !== turnId) return;
        if (turn.status === "completed") {
          finish(resolve, { threadId, turnId, status: turn.status, transport: "app-server" });
        } else {
          finish(reject, relayError(
            `Notification turn ended with status ${turn.status ?? "unknown"}.`,
            { accepted: true }
          ));
        }
      }
    }

    function onStdoutData(chunk) {
      let offset = 0;
      while (!settled && offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline === -1 ? chunk.length : newline;
        const segmentLength = end - offset;
        if (stdoutLineLength + segmentLength > MAX_APP_SERVER_PROTOCOL_LINE_BYTES) {
          finish(reject, relayError(
            `Codex app-server protocol line exceeded ${MAX_APP_SERVER_PROTOCOL_LINE_BYTES} bytes.`,
            { accepted },
          ));
          return;
        }
        chunk.copy(stdoutLine, stdoutLineLength, offset, end);
        stdoutLineLength += segmentLength;
        if (newline === -1) return;
        handleStdoutLine(stdoutLine.subarray(0, stdoutLineLength).toString("utf8"));
        stdoutLineLength = 0;
        offset = newline + 1;
      }
    }

    child.stderr.on("data", onStderrData);
    child.stdout.on("data", onStdoutData);
    child.on("error", (error) => {
      finish(reject, relayError(`Unable to start Codex app-server: ${error.message}`, { accepted }));
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      const stderr = stderrBuffer.subarray(0, stderrLength).toString("utf8").trim();
      const detail = stderr ? `: ${stderr}` : "";
      finish(reject, relayError(`Codex app-server exited early (code=${code}, signal=${signal})${detail}`, { accepted }));
    });
    child.stdin.on("error", (error) => {
      finish(reject, relayError(`Unable to write to Codex app-server: ${error.message}`, { accepted }));
    });

    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: RUNTIME_PLUGIN_NAME,
          title: RUNTIME_DISPLAY_NAME,
          version: RUNTIME_PLUGIN_VERSION,
        },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

export async function deliverNotificationTurn(jobOrJobs, env = process.env) {
  const jobs = normalizeNotificationJobs(jobOrJobs);
  const job = jobs[0];
  const threadId = sanitizeThreadId(job.ownerThreadId);
  const input = buildNotificationInput(jobs, env);
  const timeoutMs = parsePositiveInteger(
    env.CODEX_PROCESS_JOBS_NOTIFY_TURN_TIMEOUT_MS,
    DEFAULT_TURN_TIMEOUT_MS,
    10 * 60_000
  );

  let codexQueueFallbackReason = null;
  try {
    const queued = await enqueueCodexNotification(input, threadId, timeoutMs, env, {
      onUnavailable: (reason) => {
        codexQueueFallbackReason = boundedIpcFallbackReason(reason);
      },
    });
    if (queued) return queued;
  } catch (error) {
    if (error?.turnAccepted) throw error;
    codexQueueFallbackReason = boundedIpcFallbackReason(error);
  }

  const idle = await waitForOwnerIdle(job, env);
  if (!idle.idle) {
    throw attachDeliveryDiagnostics(
      relayError(`Owning Codex thread is not safely idle: ${idle.reason}.`, { retryWhenIdle: true }),
      { codexQueueFallbackReason },
    );
  }

  let cliLiveInjectionFallbackReason = null;
  if (job.ownerSurface === "cli" && cliLiveInjectionEnabled(env)) {
    try {
      const accepted = await startCliAppServerNotificationTurn(
        job,
        input,
        threadId,
        timeoutMs,
        env,
        {
          onUnavailable: (reason) => {
            cliLiveInjectionFallbackReason = boundedIpcFallbackReason(reason);
          },
          beforeStart: async () => {
            const rolloutFile = resolveOwnerRolloutFile(job.ownerThreadId, env);
            const latest = rolloutFile ? readLatestTaskLifecycle(rolloutFile) : null;
            if (latest?.type !== "task_complete" || latest.turnId !== idle.turnId) {
              throw relayError(
                "Owning Codex thread changed before CLI live injection could start.",
                { retryWhenIdle: true },
              );
            }
          },
        },
      );
      if (accepted) {
        return await waitForNotificationTurnComplete(
          job,
          accepted.turnId,
          timeoutMs,
          env,
          accepted.transport,
        );
      }
    } catch (error) {
      if (error?.turnAccepted || error?.retryWhenIdle) {
        throw attachDeliveryDiagnostics(error, { codexQueueFallbackReason });
      }
      cliLiveInjectionFallbackReason = boundedIpcFallbackReason(error);
    }
  }

  let privateIpcFallbackReason = null;
  try {
    const accepted = await startDesktopNotificationTurn(job, input, threadId, timeoutMs, env, {
      onUnavailable: (reason) => {
        if (PRIVATE_IPC_SURFACES.has(job.ownerSurface)) {
          privateIpcFallbackReason = boundedIpcFallbackReason(reason);
        }
      },
      beforeStart: async () => {
        const rolloutFile = resolveOwnerRolloutFile(job.ownerThreadId, env);
        const latest = rolloutFile ? readLatestTaskLifecycle(rolloutFile) : null;
        if (
          latest?.type !== "task_complete"
          || latest.turnId !== idle.turnId
        ) {
          throw relayError("Owning Codex thread changed before private IPC delivery could start.", { retryWhenIdle: true });
        }
      },
    });
    if (accepted) {
      return await waitForNotificationTurnComplete(
        job,
        accepted.turnId,
        timeoutMs,
        env,
        accepted.transport,
      );
    }
  } catch (error) {
    if (error?.turnAccepted || error?.retryWhenIdle) {
      throw attachDeliveryDiagnostics(error, {
        codexQueueFallbackReason,
        cliLiveInjectionFallbackReason,
      });
    }
    privateIpcFallbackReason = boundedIpcFallbackReason(error);
  }

  try {
    const delivered = await deliverAppServerNotificationTurn(job, threadId, input, timeoutMs, env);
    return {
      ...delivered,
      ...(codexQueueFallbackReason ? { codexQueueFallbackReason } : {}),
      ...(privateIpcFallbackReason ? { privateIpcFallbackReason } : {}),
      ...(cliLiveInjectionFallbackReason ? { cliLiveInjectionFallbackReason } : {}),
    };
  } catch (error) {
    throw attachDeliveryDiagnostics(error, {
      codexQueueFallbackReason,
      privateIpcFallbackReason,
      cliLiveInjectionFallbackReason,
    });
  }
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
    const outcome = await attemptNotificationBatch(job.id, attempt, {
      retryOnFailure: attempt < maxAttempts,
      watchOnBusy: attempt === maxAttempts,
    }, env);
    if (outcome.done) return readJob(job.id, env);
    if (outcome.watch) {
      const watched = await waitForOwnerIdleWatch(job.id, env);
      if (!watched.ready) {
        await markNotificationBatchFailed(outcome.batchIds, outcome.message || watched.reason, env);
        return readJob(job.id, env);
      }
      await attemptNotificationBatch(job.id, maxAttempts + 1, {
        retryOnFailure: false,
        watchOnBusy: false,
      }, env);
      await markNotificationBatchFailed(
        outcome.batchIds,
        "Idle-watch final delivery did not retain every original batch claim; hook fallback remains available.",
        env,
      );
      return readJob(job.id, env);
    }
    await delay(Math.min(30_000, retryDelayMs * attempt));
  }
  return readJob(job.id, env);
}

async function claimNotificationBatch(jobId, attempt, env) {
  const seed = readJob(jobId, env);
  const instructionKey = batchInstructionKey(seed, env);
  const batchId = `${jobId}:${attempt}:${Date.now().toString(36)}`;
  const claimed = [];

  async function claim(candidateId, { seedJob = false } = {}) {
    let didClaim = false;
    const updated = await updateJob(candidateId, (current) => {
      const allowedStatus = seedJob
        ? ["pending", "failed"].includes(current.notification?.status)
        : current.notification?.status === "pending";
      if (
        !allowedStatus
        || !TERMINAL_STATUSES.has(current.status)
        || current.ownerThreadId !== seed.ownerThreadId
        || batchInstructionKey(current, env) !== instructionKey
        || notificationSuppressed(current)
        || relayInFlight(current)
      ) return current;
      didClaim = true;
      return {
        ...current,
        notification: {
          ...(current.notification ?? {}),
          status: "delivering",
          attempts: attempt,
          deliveryBatchId: batchId,
          lastAttemptAt: nowIso(),
          errorMessage: null,
        },
      };
    }, env);
    if (didClaim) claimed.push(updated);
  }

  await claim(seed.id, { seedJob: true });
  if (claimed.length === 0) return { batchId, jobs: [] };
  const siblings = listJobs(env)
    .filter((candidate) => candidate.id !== seed.id)
    .filter((candidate) => candidate.ownerThreadId === seed.ownerThreadId)
    .filter((candidate) => TERMINAL_STATUSES.has(candidate.status))
    .filter((candidate) => candidate.notification?.status === "pending")
    .filter((candidate) => batchInstructionKey(candidate, env) === instructionKey)
    .slice(0, MAX_NOTIFICATION_BATCH - 1);
  for (const sibling of siblings) {
    try {
      await claim(sibling.id);
    } catch {}
  }
  return { batchId, jobs: claimed };
}

async function finalizeNotificationBatch(batchId, jobs, mutateNotification, env) {
  for (const job of jobs) {
    try {
      await updateJob(job.id, (current) => {
        if (
          current.notification?.status !== "delivering"
          || current.notification?.deliveryBatchId !== batchId
        ) return current;
        const notification = mutateNotification(current.notification);
        delete notification.deliveryBatchId;
        return { ...current, notification };
      }, env);
    } catch {}
  }
}

async function attemptNotificationBatch(jobId, attempt, options, env) {
  const claimed = await claimNotificationBatch(jobId, attempt, env);
  if (claimed.jobs.length === 0) return { done: true, watch: false, batchIds: [] };
  try {
    const delivered = await deliverNotificationTurn(claimed.jobs, env);
    const accepted = delivered.status === "accepted";
    await finalizeNotificationBatch(claimed.batchId, claimed.jobs, (notification) => ({
      ...notification,
      status: accepted ? "accepted" : "delivered",
      acceptedAt: accepted ? nowIso() : notification.acceptedAt ?? null,
      deliveredAt: accepted ? notification.deliveredAt ?? null : nowIso(),
      threadId: delivered.threadId,
      turnId: delivered.turnId,
      transport: delivered.transport,
      codexQueueFallbackReason: delivered.codexQueueFallbackReason ?? null,
      privateIpcFallbackReason: delivered.privateIpcFallbackReason ?? null,
      cliLiveInjectionFallbackReason: delivered.cliLiveInjectionFallbackReason ?? null,
      relayPid: null,
      errorMessage: null,
    }), env);
    return { done: true, watch: false, batchIds: claimed.jobs.map((item) => item.id) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const accepted = Boolean(error?.turnAccepted);
    const watch = !accepted && options.watchOnBusy && Boolean(error?.retryWhenIdle);
    const retry = !accepted && (options.retryOnFailure || watch);
    await finalizeNotificationBatch(claimed.batchId, claimed.jobs, (notification) => ({
      ...notification,
      status: accepted ? "accepted" : retry ? "pending" : "failed",
      acceptedAt: accepted ? nowIso() : notification.acceptedAt ?? null,
      threadId: error?.threadId ?? notification.threadId ?? null,
      transport: error?.transport ?? notification.transport ?? null,
      codexQueueFallbackReason: error?.codexQueueFallbackReason ?? notification.codexQueueFallbackReason ?? null,
      privateIpcFallbackReason: error?.privateIpcFallbackReason ?? notification.privateIpcFallbackReason ?? null,
      cliLiveInjectionFallbackReason: error?.cliLiveInjectionFallbackReason ?? notification.cliLiveInjectionFallbackReason ?? null,
      errorMessage: message,
      failedAt: !accepted && !retry ? nowIso() : null,
      idleWatchStartedAt: watch ? nowIso() : notification.idleWatchStartedAt ?? null,
      relayPid: accepted || !retry ? null : notification.relayPid ?? null,
    }), env);
    const current = readJob(jobId, env);
    if (notificationSuppressed(current) || relayInFlight(current)) {
      return { done: true, watch: false, batchIds: claimed.jobs.map((item) => item.id), message };
    }
    return {
      done: accepted || !retry,
      watch,
      batchIds: claimed.jobs.map((item) => item.id),
      message,
    };
  }
}

export async function waitForOwnerIdleWatch(jobId, env = process.env) {
  const watchMs = parsePositiveInteger(
    env.CODEX_PROCESS_JOBS_NOTIFY_IDLE_WATCH_MS,
    DEFAULT_IDLE_WATCH_MS,
    24 * 60 * 60_000
  );
  const pollMs = parsePositiveInteger(
    env.CODEX_PROCESS_JOBS_NOTIFY_IDLE_WATCH_POLL_MS,
    DEFAULT_IDLE_WATCH_POLL_MS,
    60_000
  );
  const deadline = Date.now() + watchMs;
  while (Date.now() < deadline) {
    const job = readJob(jobId, env);
    if (notificationSuppressed(job) || relayInFlight(job) || job.notification?.status !== "pending") {
      return { ready: false, reason: `notification became ${job.notification?.status ?? "unavailable"}` };
    }
    if (env.CODEX_PROCESS_JOBS_SKIP_SESSION_IDLE_CHECK === "1") return { ready: true, reason: "idle check disabled" };
    const rolloutFile = resolveOwnerRolloutFile(job.ownerThreadId, env);
    const lifecycle = rolloutFile ? readLatestTaskLifecycle(rolloutFile) : null;
    if (lifecycle?.type === "task_complete") return { ready: true, reason: "owning thread reached an idle boundary" };
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  return { ready: false, reason: `idle-watch ceiling expired after ${watchMs}ms` };
}

async function markNotificationBatchFailed(jobIds, message, env) {
  for (const id of jobIds) {
    try {
      await updateJob(id, (current) => {
        if (current.notification?.status !== "pending") return current;
        return {
          ...current,
          notification: {
            ...(current.notification ?? {}),
            status: "failed",
            failedAt: nowIso(),
            relayPid: null,
            errorMessage: message,
          },
        };
      }, env);
    } catch {}
  }
}

function parseJobId(argv) {
  const index = argv.indexOf("--job-id");
  if (index < 0 || !argv[index + 1]) throw new Error("notifier requires --job-id <id>");
  return argv[index + 1];
}

async function main() {
  await runNotifier(parseJobId(process.argv.slice(2)));
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
