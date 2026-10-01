import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { detectClientSurface } from "../scripts/client-surface.mjs";
import { deliverNotificationTurn, runNotifier, waitForOwnerIdle } from "../scripts/notifier.mjs";
import { createJob, readJob, resolveJobLogs } from "../scripts/state.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpj-work-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, "transport-started");
  const codex = path.join(root, "mock-codex");
  fs.writeFileSync(codex, `#!${process.execPath}\nimport('node:fs').then(fs => { fs.writeFileSync(${JSON.stringify(marker)}, 'started'); process.exit(1); });\n`, { mode: 0o700 });
  const env = {
    CODEX_HOME: root,
    CODEX_PROCESS_JOBS_CODEX_BIN: codex,
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_work_desktop",
    CODEX_PROCESS_JOBS_NOTIFY_IDLE_SETTLE_MS: "1",
  };
  const job = {
    id: "job-work-owner-test",
    status: "completed",
    exitCode: 0,
    cwd: root,
    argv: [process.execPath, "--version"],
    ownerThreadId: "thread-work-owner-test",
    ownerSurface: detectClientSurface(env).surface,
    logs: resolveJobLogs("job-work-owner-test", env),
  };
  return { root, env, job, marker };
}

test("Work executor originator survives durable job validation", (t) => {
  const { env, job } = fixture(t);
  assert.equal(job.ownerSurface, "work");
  createJob(job, env);
  assert.equal(readJob(job.id, env).ownerSurface, "work");
});

test("Work owner without a local rollout fails before any delivery transport", async (t) => {
  const { env, job, marker } = fixture(t);
  await assert.rejects(deliverNotificationTurn(job, env), (error) => {
    assert.match(error.message, /Work owner has no local Codex session transcript/);
    assert.match(error.message, /does not establish whether the Work task is idle/);
    assert.equal(error.turnAccepted, false);
    assert.equal(error.retryWhenIdle, true);
    return true;
  });
  assert.equal(fs.existsSync(marker), false);
});

test("Work classification does not reject an available local lifecycle", async (t) => {
  const { root, env, job } = fixture(t);
  const sessions = path.join(root, "sessions");
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, `rollout-${job.ownerThreadId}.jsonl`), JSON.stringify({
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "turn-synthetic" },
  }) + "\n");
  assert.equal((await waitForOwnerIdle(job, env)).idle, true);
});

test("Work notification failure preserves the successful durable process result", async (t) => {
  const { env, job, marker } = fixture(t);
  createJob({ ...job, notification: { requested: true, status: "pending", attempts: 0 } }, env);
  await runNotifier(job.id, {
    ...env,
    CODEX_PROCESS_JOBS_NOTIFY_MAX_ATTEMPTS: "1",
    CODEX_PROCESS_JOBS_NOTIFY_IDLE_WATCH_MS: "1",
    CODEX_PROCESS_JOBS_NOTIFY_IDLE_WATCH_POLL_MS: "1",
  });
  const stored = readJob(job.id, env);
  assert.equal(stored.status, "completed");
  assert.equal(stored.exitCode, 0);
  assert.equal(stored.notification.status, "failed");
  assert.equal(stored.notification.attempts, 1);
  assert.match(stored.notification.errorMessage, /Work owner has no local Codex session transcript/);
  assert.equal(stored.notification.transport, null);
  assert.equal(stored.notification.acceptedAt, null);
  assert.equal(fs.existsSync(marker), false);
});

test("unavailable Work notifications perform no retries, idle watch, or transport", async (t) => {
  const { env, job, marker } = fixture(t);
  createJob({ ...job, notification: { requested: true, status: "unavailable", attempts: 0 } }, env);
  const result = await runNotifier(job.id, env);
  assert.equal(result.notification.status, "unavailable");
  assert.equal(result.notification.attempts, 0);
  assert.equal(result.notification.lastAttemptAt, undefined);
  assert.equal(result.notification.idleWatchStartedAt, undefined);
  assert.equal(fs.existsSync(marker), false);
});
