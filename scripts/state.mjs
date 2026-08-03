import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { isExecutionDescriptor } from "./execution.mjs";

export const SCHEMA_VERSION = 2;
const SUPPORTED_SCHEMA_VERSIONS = new Set([1, SCHEMA_VERSION]);
export const MAX_JOB_RECORD_BYTES = 256 * 1024;
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
const JOB_STATUSES = new Set([...ACTIVE_STATUSES, ...TERMINAL_STATUSES]);
const NOTIFICATION_STATUSES = new Set([
  "pending",
  "delivering",
  "delivered",
  "accepted",
  "failed",
  "fallback_notified",
  "suppressed",
  "disabled",
  "unavailable",
]);
const NOTIFICATION_PRESENTATIONS = new Set([
  "conversational",
  "durable-refresh-required",
  "status-only",
  "disabled",
]);
const NOTIFICATION_TRANSPORTS = new Set(["app-server", "desktop-ipc", "vscode-ipc"]);
const OWNER_SURFACES = new Set(["app", "cli", "vscode", "remote", "unknown"]);

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

function ensurePrivateDirectory(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Process-jobs state path is not a real directory: ${directory}`);
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`Process-jobs state directory is not owned by the current user: ${directory}`);
    }
    fs.chmodSync(directory, 0o700);
  } catch (error) {
    // A sandboxed launch commonly hits EPERM/EACCES here before anything else.
    // Surface an actionable instruction instead of a bare errno so the agent
    // retries the identical command through the scoped-permission path the
    // start skill documents, rather than improvising a different state root.
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      const wrapped = new Error(
        `Cannot prepare durable job state at ${directory} (${error.code}): the active sandbox `
        + "denies writes to this path. Re-run the exact same command with scoped or escalated "
        + "permissions for this directory. Do not substitute a different state directory; "
        + "durable job state must stay under the configured CODEX_HOME.",
      );
      wrapped.code = error.code;
      throw wrapped;
    }
    throw error;
  }
}

export function ensureStateDirs(env = process.env) {
  ensurePrivateDirectory(resolveStateRoot(env));
  const jobs = resolveJobsDir(env);
  const logs = resolveLogsDir(env);
  ensurePrivateDirectory(jobs);
  ensurePrivateDirectory(logs);
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

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function validateOptionalString(job, field, maximum) {
  if (job[field] == null) return;
  if (typeof job[field] !== "string" || job[field].length > maximum) {
    throw new Error(`Invalid persisted ${field} for ${job.id}.`);
  }
}

export function validateJobRecord(job, { expectedId = null, env = process.env } = {}) {
  if (!isObject(job)) throw new Error("Persisted job record must be a JSON object.");
  if (!SUPPORTED_SCHEMA_VERSIONS.has(job.schemaVersion)) {
    throw new Error(`Unsupported persisted job schema version: ${job.schemaVersion ?? "(missing)"}.`);
  }
  if (typeof job.id !== "string") throw new Error("Persisted job id must be a string.");
  const id = sanitizeJobId(job.id);
  if (expectedId != null && id !== sanitizeJobId(expectedId)) {
    throw new Error(`Persisted job id ${id} does not match its file name ${expectedId}.`);
  }
  if (!JOB_STATUSES.has(job.status)) {
    throw new Error(`Invalid persisted status for ${id}: ${String(job.status ?? "(missing)")}.`);
  }
  if (
    job.ownerThreadId != null
    && (typeof job.ownerThreadId !== "string" || !/^[A-Za-z0-9_-]{8,160}$/.test(job.ownerThreadId))
  ) {
    throw new Error(`Invalid persisted owner thread id for ${id}.`);
  }
  if (job.ownerSurface != null && !OWNER_SURFACES.has(job.ownerSurface)) {
    throw new Error(`Invalid persisted owner surface for ${id}.`);
  }
  if (job.exitCode != null && !Number.isSafeInteger(job.exitCode)) {
    throw new Error(`Invalid persisted exit code for ${id}.`);
  }
  for (const [field, maximum] of [
    ["name", 512],
    ["displayCommand", 64 * 1024],
    ["cwd", 4096],
    ["errorMessage", 8192],
    ["signal", 64],
    ["phase", 64],
  ]) {
    validateOptionalString(job, field, maximum);
  }
  if (job.rerunOf != null) {
    if (typeof job.rerunOf !== "string") {
      throw new Error(`Invalid persisted rerun source for ${id}.`);
    }
    const rerunOf = sanitizeJobId(job.rerunOf);
    if (rerunOf === id) throw new Error(`Persisted job ${id} cannot rerun itself.`);
  }
  if (job.cwd != null && !path.isAbsolute(job.cwd)) {
    throw new Error(`Persisted cwd for ${id} must be absolute.`);
  }
  if (job.schemaVersion === 1) {
    if (job.shell != null && typeof job.shell !== "boolean") {
      throw new Error(`Invalid persisted shell flag for ${id}.`);
    }
  } else {
    if (job.shell != null) throw new Error(`Schema v2 job ${id} cannot contain the legacy shell flag.`);
    if (!isExecutionDescriptor(job.execution)) {
      throw new Error(`Invalid persisted execution descriptor for ${id}.`);
    }
  }
  if (job.critical != null && typeof job.critical !== "boolean") {
    throw new Error(`Invalid persisted critical flag for ${id}.`);
  }
  if (job.goalMode != null && typeof job.goalMode !== "boolean") {
    throw new Error(`Invalid persisted goal mode flag for ${id}.`);
  }
  if (job.notifyUser != null && typeof job.notifyUser !== "boolean") {
    throw new Error(`Invalid persisted user notification flag for ${id}.`);
  }
  if (job.notifyUserExplicit != null && typeof job.notifyUserExplicit !== "boolean") {
    throw new Error(`Invalid persisted user notification provenance for ${id}.`);
  }
  if (job.nameExplicit != null && typeof job.nameExplicit !== "boolean") {
    throw new Error(`Invalid persisted name provenance for ${id}.`);
  }
  if (job.argv != null) {
    if (
      !Array.isArray(job.argv)
      || job.argv.length === 0
      || job.argv.length > 4096
      || job.argv.some((argument) => typeof argument !== "string" || argument.length > 64 * 1024)
    ) {
      throw new Error(`Invalid persisted argv for ${id}.`);
    }
  }
  if (ACTIVE_STATUSES.has(job.status)) {
    const executionMissing = job.schemaVersion === 1
      ? typeof job.shell !== "boolean"
      : !isExecutionDescriptor(job.execution);
    if (!job.cwd || !job.argv || executionMissing) {
      throw new Error(`Active persisted job ${id} is missing validated execution fields.`);
    }
  }
  for (const field of ["pid", "lastPid", "workerPid"]) {
    if (job[field] != null && (!Number.isSafeInteger(job[field]) || job[field] <= 0)) {
      throw new Error(`Invalid persisted ${field} for ${id}.`);
    }
  }
  if (job.notification != null) {
    if (!isObject(job.notification)) throw new Error(`Invalid persisted notification object for ${id}.`);
    if (!NOTIFICATION_STATUSES.has(job.notification.status)) {
      throw new Error(`Invalid persisted notification status for ${id}.`);
    }
    if (
      job.notification.presentation != null
      && !NOTIFICATION_PRESENTATIONS.has(job.notification.presentation)
    ) {
      throw new Error(`Invalid persisted notification presentation for ${id}.`);
    }
    if (
      job.notification.transport != null
      && !NOTIFICATION_TRANSPORTS.has(job.notification.transport)
    ) {
      throw new Error(`Invalid persisted notification transport for ${id}.`);
    }
    if (job.notification.transport != null && job.notification.status !== "delivered") {
      throw new Error(`Persisted notification transport for ${id} requires delivered status.`);
    }
    if (
      job.notification.errorMessage != null
      && (
        typeof job.notification.errorMessage !== "string"
        || job.notification.errorMessage.length > 8192
      )
    ) {
      throw new Error(`Invalid persisted notification error for ${id}.`);
    }
    if (
      job.notification.privateIpcFallbackReason != null
      && (
        typeof job.notification.privateIpcFallbackReason !== "string"
        || Buffer.byteLength(job.notification.privateIpcFallbackReason, "utf8") > 4096
      )
    ) {
      throw new Error(`Invalid persisted private IPC fallback reason for ${id}.`);
    }
    if (
      job.notification.attempts != null
      && (!Number.isSafeInteger(job.notification.attempts) || job.notification.attempts < 0)
    ) {
      throw new Error(`Invalid persisted notification attempts for ${id}.`);
    }
    if (
      job.notification.launchBoundaryInjectedAt != null
      && (
        typeof job.notification.launchBoundaryInjectedAt !== "string"
        || job.notification.launchBoundaryInjectedAt.length > 64
        || !Number.isFinite(Date.parse(job.notification.launchBoundaryInjectedAt))
      )
    ) {
      throw new Error(`Invalid persisted launch-boundary timestamp for ${id}.`);
    }
    for (const field of ["stopContinuationPromptedAt", "stopContinuationContextInjectedAt"]) {
      if (
        job.notification[field] != null
        && (
          typeof job.notification[field] !== "string"
          || job.notification[field].length > 64
          || !Number.isFinite(Date.parse(job.notification[field]))
        )
      ) {
        throw new Error(`Invalid persisted ${field} for ${id}.`);
      }
    }
    if (
      job.notification.launchBoundaryTurnId != null
      && (
        typeof job.notification.launchBoundaryTurnId !== "string"
        || !/^[A-Za-z0-9_-]{1,160}$/.test(job.notification.launchBoundaryTurnId)
      )
    ) {
      throw new Error(`Invalid persisted launch-boundary turn id for ${id}.`);
    }
  }
  if (!isObject(job.logs)) throw new Error(`Persisted job ${id} has no valid log paths.`);
  const expectedLogs = resolveJobLogs(id, env);
  if (job.logs.stdout !== expectedLogs.stdout || job.logs.stderr !== expectedLogs.stderr) {
    throw new Error(`Persisted log paths for ${id} do not match its private state directory.`);
  }
  return job;
}

function serializeJobRecord(record) {
  const body = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_JOB_RECORD_BYTES) {
    throw new Error(`Persisted job record exceeds ${MAX_JOB_RECORD_BYTES} bytes.`);
  }
  return body;
}

function readJobFile(file) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Persisted job record is not a regular file: ${file}`);
    if ((stat.mode & 0o077) !== 0) throw new Error(`Persisted job record is not private: ${file}`);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`Persisted job record is not owned by the current user: ${file}`);
    }
    if (stat.size > MAX_JOB_RECORD_BYTES) {
      throw new Error(`Persisted job record exceeds ${MAX_JOB_RECORD_BYTES} bytes: ${file}`);
    }
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

function atomicWriteJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  const body = serializeJobRecord(value);
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
  const normalized = { ...job };
  normalized.execution ??= normalized.shell
    ? { kind: "shell", interpreter: "bash" }
    : { kind: "argv" };
  delete normalized.shell;
  const record = {
    schemaVersion: SCHEMA_VERSION,
    ...normalized,
    createdAt: job.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
  validateJobRecord(record, { expectedId: job.id, env });
  const body = serializeJobRecord(record);
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, body, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  return record;
}

export function tryReadJob(jobId, env = process.env) {
  try {
    const expectedId = sanitizeJobId(jobId);
    return validateJobRecord(readJobFile(resolveJobFile(expectedId, env)), { expectedId, env });
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
      const expectedId = sanitizeJobId(entry.name.slice(0, -".json".length));
      const record = readJobFile(path.join(resolveJobsDir(env), entry.name));
      jobs.push(validateJobRecord(record, { expectedId, env }));
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
      schemaVersion: current.schemaVersion,
      createdAt: current.createdAt,
      updatedAt: nowIso(),
    };
    validateJobRecord(record, { expectedId: jobId, env });
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
