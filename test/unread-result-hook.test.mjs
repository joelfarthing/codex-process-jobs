import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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

function runHookAsync(env, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
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

test("notification relay environment cannot consume the next-prompt fallback", (t) => {
  const env = {
    ...createEnv(t),
    CODEX_PROCESS_JOBS_NOTIFICATION_RELAY: "1",
  };
  writeJob(env, {
    id: "job-hook-003",
    ownerThreadId: "thread-hook-003",
    ownerSurface: "vscode",
    status: "completed",
    exitCode: 0,
    notification: {
      status: "delivering",
      presentation: "durable-refresh-required",
    },
  });
  const result = runHook(env, {
    hook_event_name: "UserPromptSubmit",
    session_id: "thread-hook-003",
    prompt: "synthetic relay turn without an envelope",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(readJob(env, "job-hook-003").notification, {
    status: "delivering",
    presentation: "durable-refresh-required",
  });
});

test("synthetic completion envelope cannot consume fallback without the relay environment", (t) => {
  const env = createEnv(t);
  writeJob(env, {
    id: "job-hook-003-envelope",
    ownerThreadId: "thread-hook-003-envelope",
    ownerSurface: "vscode",
    status: "completed",
    exitCode: 0,
    notification: {
      status: "delivering",
      presentation: "durable-refresh-required",
    },
  });
  const result = runHook(env, {
    hook_event_name: "UserPromptSubmit",
    session_id: "thread-hook-003-envelope",
    prompt: [
      "<process_job_notification>",
      "This is a synthetic completion event.",
      "</process_job_notification>",
    ].join("\n"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(readJob(env, "job-hook-003-envelope").notification, {
    status: "delivering",
    presentation: "durable-refresh-required",
  });
});

test("delivered VS Code completion is surfaced on the next real prompt once", (t) => {
  const env = createEnv(t);
  writeJob(env, {
    id: "job-hook-004",
    ownerThreadId: "thread-hook-004",
    ownerSurface: "vscode",
    status: "failed",
    exitCode: 7,
    notification: {
      status: "delivered",
      presentation: "durable-refresh-required",
      deliveredAt: "2026-07-10T12:01:00.000Z",
      hookNotifiedAt: "2026-07-10T12:00:59.000Z",
    },
  });

  const first = runHook(env, {
    hook_event_name: "UserPromptSubmit",
    session_id: "thread-hook-004",
    prompt: "continue with the next task",
  });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /job-hook-004: failed \(exit 7\)/);
  assert.match(first.stdout, /completion turn was recorded, but this VS Code panel may not have refreshed/);
  const stored = readJob(env, "job-hook-004");
  assert.equal(stored.notification.status, "delivered");
  assert.match(stored.notification.surfaceFallbackNotifiedAt, /T/);

  const second = runHook(env, {
    hook_event_name: "UserPromptSubmit",
    session_id: "thread-hook-004",
    prompt: "another request",
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, "");
  assert.equal(readJob(env, "job-hook-004").notification.status, "delivered");
});

test("delivered non-VS-Code completion is not repeated by the hook", (t) => {
  const env = createEnv(t);
  writeJob(env, {
    id: "job-hook-005",
    ownerThreadId: "thread-hook-005",
    ownerSurface: "app",
    status: "completed",
    exitCode: 0,
    notification: {
      status: "delivered",
      presentation: "conversational",
    },
  });
  const result = runHook(env, {
    hook_event_name: "UserPromptSubmit",
    session_id: "thread-hook-005",
    prompt: "continue",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(readJob(env, "job-hook-005").notification.surfaceFallbackNotifiedAt, undefined);
});

test("concurrent next-prompt hooks claim one completion exactly once", async (t) => {
  const env = createEnv(t);
  writeJob(env, {
    id: "job-hook-006",
    ownerThreadId: "thread-hook-006",
    status: "failed",
    exitCode: 9,
    notification: { status: "failed" },
  });
  const payload = {
    hook_event_name: "UserPromptSubmit",
    session_id: "thread-hook-006",
    prompt: "continue",
  };
  const results = await Promise.all(Array.from({ length: 6 }, () => runHookAsync(env, payload)));
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.equal(results.filter((result) => result.stdout.includes("job-hook-006")).length, 1);
  const stored = readJob(env, "job-hook-006");
  assert.equal(stored.notification.status, "fallback_notified");
  assert.match(stored.notification.hookNotifiedAt, /T/);
});

test("legacy VS Code delivered record without presentation gets one surface fallback", (t) => {
  const env = createEnv(t);
  writeJob(env, {
    id: "job-hook-007",
    ownerThreadId: "thread-hook-007",
    ownerSurface: "vscode",
    status: "completed",
    exitCode: 0,
    notification: { status: "delivered" },
  });
  const result = runHook(env, {
    hook_event_name: "UserPromptSubmit",
    session_id: "thread-hook-007",
    prompt: "continue",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /job-hook-007/);
  assert.equal(readJob(env, "job-hook-007").notification.status, "delivered");
  assert.match(readJob(env, "job-hook-007").notification.surfaceFallbackNotifiedAt, /T/);
});
