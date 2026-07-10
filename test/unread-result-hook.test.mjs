import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "hooks", "unread-result-hook.mjs");

function createEnv(t) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-hook-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  return { ...process.env, CODEX_HOME: codexHome };
}

function writeJob(env, job) {
  const jobs = path.join(env.CODEX_HOME, "process-jobs", "jobs");
  fs.mkdirSync(jobs, { recursive: true });
  fs.writeFileSync(path.join(jobs, `${job.id}.json`), `${JSON.stringify({
    schemaVersion: 1,
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:01:00.000Z",
    ...job,
  }, null, 2)}\n`);
}

function readJob(env, id) {
  return JSON.parse(fs.readFileSync(path.join(env.CODEX_HOME, "process-jobs", "jobs", `${id}.json`), "utf8"));
}

function runHook(env, payload) {
  return spawnSync(process.execPath, [HOOK], {
    cwd: ROOT,
    env,
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 5000,
  });
}

test("next-prompt hook surfaces one same-thread unread completion once", (t) => {
  const env = createEnv(t);
  writeJob(env, {
    id: "job-hook-001",
    ownerThreadId: "thread-hook-001",
    status: "completed",
    exitCode: 0,
    notification: { status: "failed" },
  });
  writeJob(env, {
    id: "job-hook-other",
    ownerThreadId: "thread-other-001",
    status: "failed",
    exitCode: 2,
    notification: { status: "failed" },
  });

  const first = runHook(env, {
    hook_event_name: "UserPromptSubmit",
    session_id: "thread-hook-001",
    prompt: "continue with the next task",
  });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /job-hook-001/);
  assert.doesNotMatch(first.stdout, /job-hook-other/);
  assert.equal(readJob(env, "job-hook-001").notification.status, "fallback_notified");

  const second = runHook(env, {
    hook_event_name: "UserPromptSubmit",
    session_id: "thread-hook-001",
    prompt: "another request",
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, "");
});

test("explicit status prompt bypasses fallback context", (t) => {
  const env = createEnv(t);
  writeJob(env, {
    id: "job-hook-002",
    ownerThreadId: "thread-hook-002",
    status: "failed",
    exitCode: 1,
    notification: { status: "failed" },
  });
  const result = runHook(env, {
    hook_event_name: "UserPromptSubmit",
    session_id: "thread-hook-002",
    prompt: "$codex-process-jobs:status job-hook-002",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(readJob(env, "job-hook-002").notification.status, "failed");
});
