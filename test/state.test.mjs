import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createJob,
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
  createJob({ id, status: "queued", phase: "queued", counter: 0, logs: resolveJobLogs(id, env) }, env);

  await Promise.all(Array.from({ length: 12 }, () =>
    updateJob(id, (job) => ({ ...job, counter: job.counter + 1 }), env)
  ));

  assert.equal(readJob(id, env).counter, 12);
});
