import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_JOB_RECORD_BYTES,
  createJob,
  ensureStateDirs,
  listJobs,
  readJob,
  resolveJobLogs,
  updateJob,
  validateJobRecord,
} from "../scripts/state.mjs";

function withTemporaryHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { CODEX_HOME: root };
}

test("creates private state and updates it under a per-job lock", async (t) => {
  const env = withTemporaryHome(t);
  const logs = resolveJobLogs("job-test-001", env);
  const created = createJob({
    id: "job-test-001",
    status: "queued",
    phase: "queued",
    name: "test job",
    cwd: process.cwd(),
    shell: false,
    argv: [process.execPath, "--version"],
    logs,
  }, env);
  assert.equal(created.status, "queued");
  assert.equal(created.schemaVersion, 2);
  assert.deepEqual(created.execution, { kind: "argv" });
  assert.equal(created.shell, undefined);
  assert.equal(readJob(created.id, env).name, "test job");

  const updated = await updateJob(created.id, (job) => ({
    ...job,
    status: "running",
    phase: "running",
    pid: 123,
  }), env);
  assert.equal(updated.status, "running");
  assert.equal(readJob(created.id, env).pid, 123);
  assert.deepEqual(listJobs(env).map((job) => job.id), [created.id]);

  const mode = fs.statSync(path.join(env.CODEX_HOME, "process-jobs", "jobs", `${created.id}.json`)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("schema v2 validates fixed execution descriptors and schema v1 remains readable", (t) => {
  const env = withTemporaryHome(t);
  const base = {
    schemaVersion: 2,
    id: "job-execution-v2",
    status: "queued",
    phase: "queued",
    cwd: process.cwd(),
    argv: ["printf ok"],
    logs: resolveJobLogs("job-execution-v2", env),
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
  assert.doesNotThrow(() => validateJobRecord({
    ...base,
    execution: { kind: "shell", interpreter: "bash" },
  }, { expectedId: base.id, env }));
  assert.throws(() => validateJobRecord({
    ...base,
    execution: { kind: "shell", interpreter: "/tmp/evil" },
  }, { expectedId: base.id, env }), /execution descriptor/i);
  assert.throws(() => validateJobRecord({
    ...base,
    execution: { kind: "argv" },
    shell: true,
  }, { expectedId: base.id, env }), /legacy shell flag/i);

  assert.doesNotThrow(() => validateJobRecord({
    ...base,
    schemaVersion: 1,
    shell: true,
    execution: undefined,
  }, { expectedId: base.id, env }));
});

test("validates rerun lineage as a distinct job id", (t) => {
  const env = withTemporaryHome(t);
  const base = {
    id: "job-rerun-child",
    status: "completed",
    phase: "completed",
    cwd: process.cwd(),
    execution: { kind: "argv" },
    argv: [process.execPath, "--version"],
    logs: resolveJobLogs("job-rerun-child", env),
  };
  const created = createJob({
    ...base,
    rerunOf: "job-rerun-parent",
  }, env);
  assert.equal(created.rerunOf, "job-rerun-parent");
  assert.throws(
    () => createJob({
      ...base,
      id: "job-rerun-self",
      rerunOf: "job-rerun-self",
      logs: resolveJobLogs("job-rerun-self", env),
    }, env),
    /cannot rerun itself/i,
  );
  assert.throws(
    () => createJob({
      ...base,
      id: "job-rerun-invalid",
      rerunOf: "../parent",
      logs: resolveJobLogs("job-rerun-invalid", env),
    }, env),
    /invalid job id/i,
  );
});

test("a sandbox-style permission failure preparing state dirs is actionable", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("permission bits do not restrict root");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-state-denied-"));
  t.after(() => {
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(codexHome);
  fs.chmodSync(root, 0o500);
  fs.chmodSync(codexHome, 0o500);
  assert.throws(
    () => ensureStateDirs({ CODEX_HOME: codexHome }),
    (error) => {
      assert.match(error.message, /Cannot prepare durable job state at /);
      assert.match(error.message, /scoped or escalated permissions/);
      assert.match(error.message, /Do not substitute a different state directory/);
      assert.ok(["EPERM", "EACCES"].includes(error.code));
      return true;
    },
  );
});

test("updating a legacy v1 shell record preserves its schema and execution semantics", async (t) => {
  const env = withTemporaryHome(t);
  ensureStateDirs(env);
  const id = "job-legacy-shell-update";
  const record = {
    schemaVersion: 1,
    id,
    status: "queued",
    phase: "queued",
    cwd: process.cwd(),
    shell: true,
    argv: ["printf legacy"],
    logs: resolveJobLogs(id, env),
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
  fs.writeFileSync(
    path.join(env.CODEX_HOME, "process-jobs", "jobs", `${id}.json`),
    `${JSON.stringify(record)}\n`,
    { mode: 0o600 },
  );
  const updated = await updateJob(id, (job) => ({ ...job, phase: "waiting" }), env);
  assert.equal(updated.schemaVersion, 1);
  assert.equal(updated.shell, true);
  assert.equal(updated.execution, undefined);
});

test("serializes concurrent state updates without corrupting JSON", async (t) => {
  const env = withTemporaryHome(t);
  const id = "job-test-002";
  createJob({
    id,
    status: "queued",
    phase: "queued",
    cwd: process.cwd(),
    shell: false,
    argv: [process.execPath, "--version"],
    counter: 0,
    logs: resolveJobLogs(id, env),
  }, env);

  await Promise.all(Array.from({ length: 12 }, () =>
    updateJob(id, (job) => ({ ...job, counter: job.counter + 1 }), env)
  ));

  assert.equal(readJob(id, env).counter, 12);
});

test("accepts only known persisted notification transports", (t) => {
  const env = withTemporaryHome(t);
  assert.throws(() => createJob({
    id: "job-invalid-transport",
    status: "completed",
    notification: { status: "delivered", transport: "untrusted-router" },
    logs: resolveJobLogs("job-invalid-transport", env),
  }, env), /notification transport/i);

  assert.throws(() => createJob({
    id: "job-premature-transport",
    status: "completed",
    notification: { status: "pending", transport: "desktop-ipc" },
    logs: resolveJobLogs("job-premature-transport", env),
  }, env), /requires delivered status/i);

  const created = createJob({
    id: "job-desktop-transport",
    status: "completed",
    notification: { status: "delivered", transport: "desktop-ipc" },
    logs: resolveJobLogs("job-desktop-transport", env),
  }, env);
  assert.equal(created.notification.transport, "desktop-ipc");

  const vscode = createJob({
    id: "job-vscode-transport",
    status: "completed",
    notification: { status: "delivered", transport: "vscode-ipc" },
    logs: resolveJobLogs("job-vscode-transport", env),
  }, env);
  assert.equal(vscode.notification.transport, "vscode-ipc");

  assert.throws(() => createJob({
    id: "job-oversized-ipc-diagnostic",
    status: "completed",
    notification: {
      status: "delivered",
      transport: "app-server",
      privateIpcFallbackReason: "x".repeat(4097),
    },
    logs: resolveJobLogs("job-oversized-ipc-diagnostic", env),
  }, env), /private IPC fallback reason/i);
});

test("validates persisted launch-boundary claim metadata", (t) => {
  const env = withTemporaryHome(t);
  assert.throws(() => createJob({
    id: "job-invalid-launch-time",
    status: "completed",
    notification: { status: "pending", launchBoundaryInjectedAt: "not-a-time" },
    logs: resolveJobLogs("job-invalid-launch-time", env),
  }, env), /launch-boundary timestamp/i);

  assert.throws(() => createJob({
    id: "job-invalid-launch-turn",
    status: "completed",
    notification: { status: "pending", launchBoundaryTurnId: "invalid turn id" },
    logs: resolveJobLogs("job-invalid-launch-turn", env),
  }, env), /launch-boundary turn id/i);

  const created = createJob({
    id: "job-valid-launch-marker",
    status: "completed",
    notification: {
      status: "pending",
      launchBoundaryInjectedAt: "2026-07-21T12:00:00.000Z",
      launchBoundaryTurnId: "turn-valid-launch-marker",
    },
    logs: resolveJobLogs("job-valid-launch-marker", env),
  }, env);
  assert.equal(created.notification.launchBoundaryTurnId, "turn-valid-launch-marker");
});

test("validates persisted Stop-continuation timestamps", (t) => {
  const env = withTemporaryHome(t);
  for (const field of ["stopContinuationPromptedAt", "stopContinuationContextInjectedAt"]) {
    assert.throws(() => createJob({
      id: `job-invalid-${field.toLowerCase()}`,
      status: "completed",
      notification: { status: "fallback_notified", [field]: "not-a-time" },
      logs: resolveJobLogs(`job-invalid-${field.toLowerCase()}`, env),
    }, env), new RegExp(field, "i"));
  }

  const created = createJob({
    id: "job-valid-stop-continuation",
    status: "failed",
    exitCode: 1,
    notification: {
      status: "fallback_notified",
      stopContinuationPromptedAt: "2026-08-03T19:00:00.000Z",
      stopContinuationContextInjectedAt: "2026-08-03T19:00:01.000Z",
    },
    logs: resolveJobLogs("job-valid-stop-continuation", env),
  }, env);
  assert.equal(created.notification.stopContinuationContextInjectedAt, "2026-08-03T19:00:01.000Z");
});

test("rejects a non-boolean persisted Goal-mode marker", (t) => {
  const env = withTemporaryHome(t);
  assert.throws(() => createJob({
    id: "job-invalid-goal-mode",
    status: "completed",
    goalMode: "active",
    logs: resolveJobLogs("job-invalid-goal-mode", env),
  }, env), /goal mode flag/i);
});

test("rejects a non-boolean persisted critical marker", (t) => {
  const env = withTemporaryHome(t);
  assert.throws(() => createJob({
    id: "job-invalid-critical",
    status: "completed",
    critical: "yes",
    logs: resolveJobLogs("job-invalid-critical", env),
  }, env), /critical flag/i);
});

test("rejects a non-boolean persisted user-notification marker", (t) => {
  const env = withTemporaryHome(t);
  assert.throws(() => createJob({
    id: "job-invalid-user-notification",
    status: "completed",
    notifyUser: "yes",
    logs: resolveJobLogs("job-invalid-user-notification", env),
  }, env), /user notification flag/i);
});

test("rejects tampered log paths and skips the record during listing", (t) => {
  const env = withTemporaryHome(t);
  const id = "job-tampered-logs";
  createJob({
    id,
    status: "completed",
    phase: "completed",
    exitCode: 0,
    logs: resolveJobLogs(id, env),
  }, env);
  const file = path.join(env.CODEX_HOME, "process-jobs", "jobs", `${id}.json`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.logs.stdout = path.join(env.CODEX_HOME, "private-secret.txt");
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`);

  assert.throws(() => readJob(id, env), /log paths.*private state directory/i);
  assert.deepEqual(listJobs(env), []);
});

test("rejects filename mismatches and oversized records without poisoning job listing", (t) => {
  const env = withTemporaryHome(t);
  const jobs = path.join(env.CODEX_HOME, "process-jobs", "jobs");
  fs.mkdirSync(jobs, { recursive: true });
  const mismatchId = "job-file-mismatch";
  fs.writeFileSync(path.join(jobs, `${mismatchId}.json`), `${JSON.stringify({
    schemaVersion: 1,
    id: "job-different-id",
    status: "completed",
    logs: resolveJobLogs("job-different-id", env),
  })}\n`, { mode: 0o600 });
  const oversizedId = "job-oversized-record";
  fs.writeFileSync(
    path.join(jobs, `${oversizedId}.json`),
    JSON.stringify({ padding: "x".repeat(MAX_JOB_RECORD_BYTES) }),
    { mode: 0o600 }
  );

  assert.throws(() => readJob(mismatchId, env), /does not match its file name/i);
  assert.throws(() => readJob(oversizedId, env), /exceeds.*bytes/i);
  assert.deepEqual(listJobs(env), []);
});

test("normalizes state-directory permissions and refuses symlinked job records", (t) => {
  const env = withTemporaryHome(t);
  const jobs = path.join(env.CODEX_HOME, "process-jobs", "jobs");
  const logs = path.join(env.CODEX_HOME, "process-jobs", "logs");
  fs.mkdirSync(jobs, { recursive: true, mode: 0o755 });
  fs.mkdirSync(logs, { recursive: true, mode: 0o755 });
  fs.chmodSync(jobs, 0o755);
  fs.chmodSync(logs, 0o755);
  ensureStateDirs(env);
  assert.equal(fs.statSync(jobs).mode & 0o777, 0o700);
  assert.equal(fs.statSync(logs).mode & 0o777, 0o700);

  const id = "job-symlink-record";
  const expectedLogs = resolveJobLogs(id, env);
  const target = path.join(env.CODEX_HOME, "outside-record.json");
  fs.writeFileSync(target, `${JSON.stringify({
    schemaVersion: 1,
    id,
    status: "completed",
    logs: expectedLogs,
  })}\n`, { mode: 0o600 });
  fs.symlinkSync(target, path.join(jobs, `${id}.json`));

  assert.throws(() => readJob(id, env));
  assert.deepEqual(listJobs(env), []);
});

test("refuses symlinked state directories without chmodding their targets", (t) => {
  const env = withTemporaryHome(t);
  const stateRoot = path.join(env.CODEX_HOME, "process-jobs");
  const target = path.join(env.CODEX_HOME, "redirected-jobs");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(target, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
  fs.symlinkSync(target, path.join(stateRoot, "jobs"));

  assert.throws(() => ensureStateDirs(env), /not a real directory/i);
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
});
