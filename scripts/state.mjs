import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const SCHEMA_VERSION = 1;
export const ACTIVE_STATUSES = new Set([
  "queued",
  "starting",
  "running",
  "cancelling",
]);
export const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "cancel_failed",
]);

const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 20;

export function nowIso() {
  return new Date().toISOString();
}

export function resolveCodexHome(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function resolveStateRoot(env = process.env) {
  return path.join(resolveCodexHome(env), "process-jobs");
}

export function resolveJobsDir(env = process.env) {
  return path.join(resolveStateRoot(env), "jobs");
}

export function resolveLogsDir(env = process.env) {
  return path.join(resolveStateRoot(env), "logs");
}

export function ensureStateDirs(env = process.env) {
  fs.mkdirSync(resolveJobsDir(env), { recursive: true, mode: 0o700 });
  fs.mkdirSync(resolveLogsDir(env), { recursive: true, mode: 0o700 });
}

export function sanitizeJobId(jobId) {
  const normalized = String(jobId ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(normalized)) {
    throw new Error(`Invalid job id: ${normalized || "(empty)"}`);
  }
  return normalized;
}

export function generateJobId() {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString("hex");
  return `job-${timestamp}-${random}`;
}

export function resolveJobFile(jobId, env = process.env) {
  return path.join(resolveJobsDir(env), `${sanitizeJobId(jobId)}.json`);
}

export function resolveJobLockFile(jobId, env = process.env) {
  return `${resolveJobFile(jobId, env)}.lock`;
}

export function resolveJobLogs(jobId, env = process.env) {
  const safeId = sanitizeJobId(jobId);
  return {
    stdout: path.join(resolveLogsDir(env), `${safeId}.stdout.log`),
    stderr: path.join(resolveLogsDir(env), `${safeId}.stderr.log`),
  };
}

function atomicWriteJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
    throw error;
  }
}

export function createJob(job, env = process.env) {
  ensureStateDirs(env);
  const file = resolveJobFile(job.id, env);
  const record = {
    schemaVersion: SCHEMA_VERSION,
    ...job,
    createdAt: job.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  return record;
}

export function tryReadJob(jobId, env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(resolveJobFile(jobId, env), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function readJob(jobId, env = process.env) {
  const job = tryReadJob(jobId, env);
  if (!job) throw new Error(`Unknown process job: ${jobId}`);
  return job;
}

export function listJobs(env = process.env) {
  ensureStateDirs(env);
  const jobs = [];
  for (const entry of fs.readdirSync(resolveJobsDir(env), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      jobs.push(JSON.parse(fs.readFileSync(path.join(resolveJobsDir(env), entry.name), "utf8")));
    } catch {
      // A malformed record is ignored here so one damaged job cannot hide all others.
    }
  }
  return jobs.sort((left, right) =>
    String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? ""))
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(jobId, env = process.env) {
  ensureStateDirs(env);
  const lockFile = resolveJobLockFile(jobId, env);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(fd, `${process.pid}\n`, "utf8");
      return { fd, lockFile };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const ageMs = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (ageMs > STALE_LOCK_MS) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for state lock for ${jobId}`);
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

function releaseLock(lock) {
  try {
    fs.closeSync(lock.fd);
  } finally {
    fs.rmSync(lock.lockFile, { force: true });
  }
}

export async function updateJob(jobId, updater, env = process.env) {
  const lock = await acquireLock(jobId, env);
  try {
    const current = readJob(jobId, env);
    const proposed = await updater({ ...current });
    const next = proposed == null ? current : proposed;
    const record = {
      ...next,
      id: current.id,
      schemaVersion: SCHEMA_VERSION,
      createdAt: current.createdAt,
      updatedAt: nowIso(),
    };
    atomicWriteJson(resolveJobFile(jobId, env), record);
    return record;
  } finally {
    releaseLock(lock);
  }
}

export function selectJob(jobId, env = process.env, { activeFirst = false } = {}) {
  if (jobId) return readJob(jobId, env);
  const jobs = listJobs(env);
  if (activeFirst) {
    const active = jobs.find((job) => ACTIVE_STATUSES.has(job.status));
    if (active) return active;
  }
  if (jobs.length === 0) throw new Error("No tracked process jobs found.");
  return jobs[0];
}
