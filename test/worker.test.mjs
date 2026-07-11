import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createJob, readJob, resolveJobLogs } from "../scripts/state.mjs";
import { recordNotificationRelaySpawn } from "../scripts/worker.mjs";

function createEnv(t) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-worker-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  return { ...process.env, CODEX_HOME: codexHome };
}

function terminalJob(id, notification, env) {
  return {
    id,
    name: id,
    status: "completed",
    cwd: process.cwd(),
    ownerThreadId: "thread-worker-test",
    notification,
    logs: resolveJobLogs(id, env),
  };
}

test("worker relay bookkeeping cannot overwrite a prompt fallback claim", async (t) => {
  const env = createEnv(t);
  createJob(terminalJob("job-worker-fallback", {
    status: "fallback_notified",
    hookNotifiedAt: "2026-07-10T12:00:00.000Z",
  }, env), env);

  await recordNotificationRelaySpawn("job-worker-fallback", 12345, env);
  const stored = readJob("job-worker-fallback", env);
  assert.equal(stored.notification.status, "fallback_notified");
  assert.equal(stored.notification.hookNotifiedAt, "2026-07-10T12:00:00.000Z");
  assert.equal(stored.notification.relayPid, undefined);
});

test("worker records relay metadata without overwriting notifier-owned delivering state", async (t) => {
  const env = createEnv(t);
  createJob(terminalJob("job-worker-delivering", {
    status: "delivering",
    attempts: 1,
  }, env), env);

  await recordNotificationRelaySpawn("job-worker-delivering", 23456, env);
  const stored = readJob("job-worker-delivering", env);
  assert.equal(stored.notification.status, "delivering");
  assert.equal(stored.notification.attempts, 1);
  assert.equal(stored.notification.relayPid, 23456);
  assert.match(stored.notification.relayStartedAt, /T/);
});
