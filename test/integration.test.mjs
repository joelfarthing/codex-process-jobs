import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "job.mjs");

function runCli(args, env, { expectStatus = 0 } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(
    result.status,
    expectStatus,
    `command: ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result;
}

function makeEnv(t, overrides = {}) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-integration-"));
  const env = {
    CODEX_HOME: codexHome,
    CODEX_THREAD_ID: "test-thread-id",
    CODEX_PROCESS_JOBS_MAX_LOG_BYTES: "4096",
    CODEX_PROCESS_JOBS_DISABLE_NOTIFY: "1",
    ...overrides,
  };
  const startedIds = [];
  t.after(() => {
    for (const id of startedIds) {
      try {
        runCli(["cancel", id, "--force", "--json"], env);
      } catch {}
    }
    fs.rmSync(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });
  return { env, startedIds };
}

function writeSessionMeta(env, { source, originator }) {
  const threadId = env.CODEX_THREAD_ID;
  const directory = path.join(env.CODEX_HOME, "sessions", "2026", "07", "10");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `rollout-test-${threadId}.jsonl`), `${JSON.stringify({
    timestamp: "2026-07-11T02:07:03.874Z",
    type: "session_meta",
    payload: { id: threadId, source, originator },
  })}\n`);
}

function startJson(args, context) {
  const started = runCli(["start", "--json", ...args], context.env);
  const payload = JSON.parse(started.stdout);
  context.startedIds.push(payload.job.id);
  return payload.job;
}

function waitJson(id, env, timeoutMs = 8_000) {
  const waited = runCli([
    "status",
    id,
    "--wait",
    "--timeout-ms",
    String(Math.min(timeoutMs, 55_000)),
    "--poll-interval-ms",
    "50",
    "--json",
  ], env);
  return JSON.parse(waited.stdout);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return predicate();
}

function createMockCodex(t, context) {
  const bin = path.join(context.env.CODEX_HOME, "mock-bin");
  fs.mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, "codex");
  const promptFile = path.join(context.env.CODEX_HOME, "notification-prompt.txt");
  fs.writeFileSync(executable, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const readline = require('node:readline');",
    "const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
    "lines.on('line', (line) => {",
    "  const message = JSON.parse(line);",
    "  if (message.id === 1) send({ id: 1, result: {} });",
    "  else if (message.id === 2) send({ id: 2, result: { thread: { id: message.params.threadId, status: { type: 'idle' } } } });",
    "  else if (message.id === 3) {",
    "    fs.writeFileSync(process.env.MOCK_NOTIFY_PROMPT, message.params.input[0].text);",
    "    send({ id: 3, result: { turn: { id: 'turn-integration-001' } } });",
    "    setTimeout(() => send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: 'turn-integration-001', status: 'completed' } } }), 10);",
    "  }",
    "});",
  ].join("\n") + "\n", { mode: 0o755 });
  context.env.CODEX_PROCESS_JOBS_CODEX_BIN = executable;
  context.env.MOCK_NOTIFY_PROMPT = promptFile;
  context.env.CODEX_PROCESS_JOBS_DISABLE_NOTIFY = "0";
  context.env.CODEX_THREAD_ID = "thread-integration-001";
  context.env.CODEX_PROCESS_JOBS_NOTIFY_TURN_TIMEOUT_MS = "3000";
  context.env.CODEX_PROCESS_JOBS_SKIP_SESSION_IDLE_CHECK = "1";
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  return promptFile;
}

test("launches a detached command, returns immediately, and stores its result", (t) => {
  const context = makeEnv(t);
  const startedAt = Date.now();
  const job = startJson([
    "--name",
    "quick integration",
    "--",
    process.execPath,
    "-e",
    "setTimeout(() => { console.log('done'); console.error('warning'); }, 250)",
  ], context);
  assert.ok(Date.now() - startedAt < 2_000, "start should not wait for command completion");
  assert.equal(job.ownerThreadId, "test-thread-id");

  const waited = waitJson(job.id, context.env);
  assert.equal(waited.timedOut, false);
  assert.equal(waited.job.status, "completed");
  assert.equal(waited.job.exitCode, 0);

  const result = JSON.parse(runCli(["result", job.id, "--json"], context.env).stdout);
  assert.match(result.stdout, /done/);
  assert.match(result.stderr, /warning/);
});

test("marks VS Code jobs as durable completions that may require panel refresh", (t) => {
  const context = makeEnv(t, {
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_vscode",
  });
  createMockCodex(t, context);
  const started = runCli([
    "start",
    "--name",
    "VS Code surface wording",
    "--",
    process.execPath,
    "-e",
    "process.exit(0)",
  ], context.env);
  assert.match(started.stdout, /open VS Code panel may need a reload/i);
  assert.match(started.stdout, /status\/result work at any time/i);
  const id = /Started (job-[a-z0-9-]+)/.exec(started.stdout)?.[1];
  assert.ok(id);
  context.startedIds.push(id);
  const job = JSON.parse(runCli(["status", id, "--json"], context.env).stdout).job;
  assert.equal(job.ownerSurface, "vscode");
  assert.equal(job.ownerSurfaceDetectedBy, "codex-originator");
  assert.equal(job.notification.presentation, "durable-refresh-required");
  assert.equal(waitJson(id, context.env).job.status, "completed");
  const jobFile = path.join(context.env.CODEX_HOME, "process-jobs", "jobs", `${id}.json`);
  assert.equal(waitUntil(() => {
    try {
      return JSON.parse(fs.readFileSync(jobFile, "utf8")).notification?.status === "delivered";
    } catch {
      return false;
    }
  }, 5000), true);
});

test("marks mobile-to-remote Cartesian jobs for durable next-turn refresh", (t) => {
  const context = makeEnv(t, { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "" });
  createMockCodex(t, context);
  writeSessionMeta(context.env, { source: "vscode", originator: "Codex Desktop" });
  const started = runCli([
    "start",
    "--name",
    "Cartesian remote surface wording",
    "--",
    process.execPath,
    "-e",
    "process.exit(0)",
  ], context.env);
  assert.match(started.stdout, /remote client may not refresh/i);
  assert.match(started.stdout, /agent will learn the outcome on the next exchange/i);
  const id = /Started (job-[a-z0-9-]+)/.exec(started.stdout)?.[1];
  assert.ok(id);
  context.startedIds.push(id);
  const job = JSON.parse(runCli(["status", id, "--json"], context.env).stdout).job;
  assert.equal(job.ownerSurface, "remote");
  assert.equal(job.ownerSurfaceDetectedBy, "rollout-session-meta");
  assert.equal(job.notification.presentation, "durable-refresh-required");
  assert.equal(waitJson(id, context.env).job.status, "completed");
  const jobFile = path.join(context.env.CODEX_HOME, "process-jobs", "jobs", `${id}.json`);
  assert.equal(waitUntil(() => {
    try {
      return JSON.parse(fs.readFileSync(jobFile, "utf8")).notification?.status === "delivered";
    } catch {
      return false;
    }
  }, 5000), true);
});

test("detached worker relays completion to the owning Codex thread", (t) => {
  const context = makeEnv(t);
  const promptFile = createMockCodex(t, context);
  const job = startJson([
    "--name",
    "relay integration",
    "--",
    process.execPath,
    "-e",
    "console.log('process output must not enter notification'); setTimeout(() => process.exit(0), 100)",
  ], context);
  assert.equal(waitJson(job.id, context.env).job.status, "completed");
  const jobFile = path.join(context.env.CODEX_HOME, "process-jobs", "jobs", `${job.id}.json`);
  assert.equal(waitUntil(() => {
    try {
      return JSON.parse(fs.readFileSync(jobFile, "utf8")).notification?.status === "delivered";
    } catch {
      return false;
    }
  }, 5000), true);
  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.notification.turnId, "turn-integration-001");
  const prompt = fs.readFileSync(promptFile, "utf8");
  assert.match(prompt, new RegExp(job.id));
  assert.doesNotMatch(prompt, /process output must not enter notification/);
});

test("caps high-volume output while preserving the latest bytes", (t) => {
  const context = makeEnv(t);
  const job = startJson([
    "--",
    process.execPath,
    "-e",
    "process.stdout.write('x'.repeat(20000)); console.error('final-stderr')",
  ], context);
  const waited = waitJson(job.id, context.env);
  assert.equal(waited.job.status, "completed");
  const stdoutPath = waited.job.logs.stdout;
  assert.ok(fs.statSync(stdoutPath).size <= 4096);
  assert.match(fs.readFileSync(stdoutPath, "utf8"), /^\[\.\.\. earlier output truncated \.\.\.\]\n/);
});

test("critical jobs refuse cancellation without an explicit force flag", (t) => {
  const context = makeEnv(t);
  const job = startJson([
    "--critical",
    "--name",
    "critical integration",
    "--",
    process.execPath,
    "-e",
    "setInterval(() => {}, 1000)",
  ], context);

  const running = waitJson(job.id, context.env, 200);
  assert.ok(["starting", "running"].includes(running.job.status));
  const refused = runCli(["cancel", job.id], context.env, { expectStatus: 1 });
  assert.match(refused.stderr, /CRITICAL/);

  const cancelled = JSON.parse(runCli(["cancel", job.id, "--force", "--json"], context.env).stdout);
  assert.equal(cancelled.job.status, "cancelled");
});

test("shell mode is explicit and stores the authorized command string", (t) => {
  const context = makeEnv(t);
  const job = startJson([
    "--shell",
    "--",
    "printf shell-mode",
  ], context);
  const waited = waitJson(job.id, context.env);
  assert.equal(waited.job.status, "completed");
  assert.equal(waited.job.command, "printf shell-mode");
  const result = JSON.parse(runCli(["result", job.id, "--json"], context.env).stdout);
  assert.equal(result.stdout, "shell-mode");
});

test("status --all returns stored jobs instead of slicing to an empty list", (t) => {
  const context = makeEnv(t);
  const first = startJson(["--", process.execPath, "-e", "process.exit(0)"], context);
  const second = startJson(["--", process.execPath, "-e", "process.exit(0)"], context);
  waitJson(first.id, context.env);
  waitJson(second.id, context.env);
  const status = JSON.parse(runCli(["status", "--all", "--json"], context.env).stdout);
  assert.equal(status.jobs.length, 2);
});

test("cancellation terminates descendants in the detached process group", (t) => {
  const context = makeEnv(t);
  const childCode = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "console.log(child.pid);",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const job = startJson(["--", process.execPath, "-e", childCode], context);
  waitJson(job.id, context.env, 200);

  const stdoutPath = path.join(context.env.CODEX_HOME, "process-jobs", "logs", `${job.id}.stdout.log`);
  assert.equal(waitUntil(() => fs.existsSync(stdoutPath) && fs.readFileSync(stdoutPath, "utf8").trim()), true);
  const descendantPid = Number.parseInt(fs.readFileSync(stdoutPath, "utf8").trim(), 10);
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
  assert.equal(processExists(descendantPid), true);

  const cancelled = JSON.parse(runCli(["cancel", job.id, "--json"], context.env).stdout);
  assert.equal(cancelled.job.status, "cancelled");
  assert.equal(waitUntil(() => !processExists(descendantPid)), true);
});

test("name-based status returns a lightweight recent-output snapshot", (t) => {
  const context = makeEnv(t);
  const job = startJson([
    "--name",
    "cmake build",
    "--",
    process.execPath,
    "-e",
    "console.log('Compiling target 63%'); console.error('one warning'); setTimeout(() => process.exit(0), 500)",
  ], context);
  assert.equal(waitUntil(() => fs.existsSync(job.logs.stdout) && fs.readFileSync(job.logs.stdout, "utf8").includes("63%")), true);

  const status = JSON.parse(runCli(["status", "--name", "build", "--json"], context.env).stdout);
  assert.equal(status.job.id, job.id);
  assert.ok(["starting", "running"].includes(status.job.status));
  assert.deepEqual(status.progress.recentStdout, ["Compiling target 63%"]);
  assert.deepEqual(status.progress.recentStderr, ["one warning"]);
  assert.ok(status.progress.stdoutBytes > 0);
  assert.ok(status.progress.stderrBytes > 0);
  assert.ok(status.progress.lastActivityAt);

  assert.equal(waitJson(job.id, context.env).job.status, "completed");
});
