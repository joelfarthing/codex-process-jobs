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
