#!/usr/bin/env node

import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createBoundedLogWriter, resolveMaxLogBytes } from "./logs.mjs";
import { getProcessIdentity } from "./process-control.mjs";
import {
  TERMINAL_STATUSES,
  nowIso,
  readJob,
  resolveJobLogs,
  updateJob,
} from "./state.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOTIFIER_PATH = path.join(ROOT_DIR, "scripts", "notifier.mjs");

function parseJobId(argv) {
  const index = argv.indexOf("--job-id");
  if (index < 0 || !argv[index + 1]) throw new Error("worker requires --job-id <id>");
  return argv[index + 1];
}

function spawnJobProcess(job) {
  const command = job.shell ? "/bin/sh" : job.argv[0];
  const args = job.shell ? ["-lc", job.argv[0]] : job.argv.slice(1);
  return spawn(command, args, {
    cwd: job.cwd,
    env: process.env,
    detached: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function waitForClose(child) {
  return new Promise((resolve, reject) => {
    let spawnError = null;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      if (spawnError) reject(spawnError);
      else resolve({ code, signal });
    });
  });
}

async function launchNotificationRelay(job, env) {
  if (job.notification?.status !== "pending" || !job.ownerThreadId) return job;
  try {
    const notifier = spawn(process.execPath, [NOTIFIER_PATH, "--job-id", job.id], {
      cwd: job.cwd,
      env,
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    notifier.unref();
    return await updateJob(job.id, (current) => ({
      ...current,
      notification: {
        ...(current.notification ?? {}),
        status: "pending",
        relayPid: notifier.pid ?? null,
        relayStartedAt: nowIso(),
      },
    }), env);
  } catch (error) {
    return await updateJob(job.id, (current) => ({
      ...current,
      notification: {
        ...(current.notification ?? {}),
        status: "failed",
        failedAt: nowIso(),
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    }), env);
  }
}

export async function runWorker(jobId, env = process.env) {
  const initial = readJob(jobId, env);
  if (initial.status !== "queued") return initial;

  let workerIdentity = null;
  try {
    workerIdentity = getProcessIdentity(process.pid);
  } catch {}

  const starting = await updateJob(
    jobId,
    (current) => {
      if (current.status !== "queued") return current;
      return {
        ...current,
        status: "starting",
        phase: "starting",
        startedAt: current.startedAt || nowIso(),
        workerPid: process.pid,
        workerIdentity,
      };
    },
    env
  );
  if (starting.status !== "starting") return starting;

  const logs = resolveJobLogs(jobId, env);
  const limit = resolveMaxLogBytes(env);
  const stdout = createBoundedLogWriter(logs.stdout, limit);
  const stderr = createBoundedLogWriter(logs.stderr, limit);

  try {
    const child = spawnJobProcess(starting);
    child.stdout?.on("data", (chunk) => stdout.append(chunk));
    child.stderr?.on("data", (chunk) => stderr.append(chunk));

    let pidIdentity = null;
    if (Number.isInteger(child.pid)) {
      try {
        pidIdentity = getProcessIdentity(child.pid);
      } catch {}
    }

    const running = await updateJob(
      jobId,
      (current) => {
        if (current.status === "cancelled" || current.status === "cancelling") return current;
        if (current.status !== "starting") return current;
        return {
          ...current,
          status: "running",
          phase: "running",
          pid: child.pid ?? null,
          pidIdentity,
        };
      },
      env
    );

    if (running.status === "cancelled" || running.status === "cancelling") {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {}
    }

    const { code, signal } = await waitForClose(child);
    const completedAt = nowIso();
    const terminal = await updateJob(
      jobId,
      (current) => {
        if (current.status === "cancelled" || current.status === "cancel_failed") return current;
        if (current.status === "cancelling") {
          return {
            ...current,
            status: "cancelled",
            phase: "cancelled",
            completedAt,
            exitCode: code,
            signal,
            lastPid: child.pid ?? current.pid ?? null,
            pid: null,
            pidIdentity: null,
          };
        }
        if (TERMINAL_STATUSES.has(current.status)) return current;
        const succeeded = code === 0 && signal == null;
        return {
          ...current,
          status: succeeded ? "completed" : "failed",
          phase: succeeded ? "done" : "failed",
          completedAt,
          exitCode: code,
          signal,
          errorMessage: succeeded
            ? null
            : signal
              ? `Process terminated by ${signal}.`
              : `Process exited with code ${code}.`,
          lastPid: child.pid ?? current.pid ?? null,
          pid: null,
          pidIdentity: null,
        };
      },
      env
    );
    await launchNotificationRelay(terminal, env);
    return terminal;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.append(`\n[codex-process-jobs] ${message}\n`);
    const terminal = await updateJob(
      jobId,
      (current) => {
        if (TERMINAL_STATUSES.has(current.status)) return current;
        return {
          ...current,
          status: "failed",
          phase: "failed",
          completedAt: nowIso(),
          errorMessage: message,
          pid: null,
          pidIdentity: null,
        };
      },
      env
    );
    await launchNotificationRelay(terminal, env);
    return terminal;
  } finally {
    stdout.close();
    stderr.close();
  }
}

async function main() {
  await runWorker(parseJobId(process.argv.slice(2)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
