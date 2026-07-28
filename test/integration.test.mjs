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

function writeTerminalRecord(context, id, overrides = {}) {
  const stateRoot = path.join(context.env.CODEX_HOME, "process-jobs");
  const jobs = path.join(stateRoot, "jobs");
  const logs = path.join(stateRoot, "logs");
  fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const logPaths = {
    stdout: path.join(logs, `${id}.stdout.log`),
    stderr: path.join(logs, `${id}.stderr.log`),
  };
  fs.writeFileSync(logPaths.stdout, "", { mode: 0o600 });
  fs.writeFileSync(logPaths.stderr, "", { mode: 0o600 });
  const timestamp = new Date().toISOString();
  const record = {
    schemaVersion: 2,
    id,
    status: "completed",
    phase: "done",
    critical: false,
    goalMode: false,
    execution: { kind: "argv" },
    argv: [process.execPath, "--version"],
    cwd: ROOT,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
    logs: logPaths,
    ...overrides,
  };
  fs.writeFileSync(
    path.join(jobs, `${id}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o600 },
  );
  return record;
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

test("Goal-mode start persists the marker and emits Goal-specific release guidance", (t) => {
  const context = makeEnv(t);
  const started = runCli([
    "start",
    "--goal-mode",
    "--name",
    "goal-integrated build",
    "--",
    process.execPath,
    "-e",
    "process.exit(0)",
  ], context.env);
  assert.match(started.stdout, /Goal mode is active/i);
  assert.match(started.stdout, /automatic Goal continuation is not permission to monitor/i);
  assert.match(started.stdout, /do not call status, wait, sleep, or probe the job/i);
  assert.match(started.stdout, /apply the host Goal blocked audit/i);
  assert.match(started.stdout, /When a hook surfaces terminal state, inspect its bounded saved result and continue the already-authorized Goal/i);
  const id = /Started (job-[a-z0-9-]+)/.exec(started.stdout)?.[1];
  assert.ok(id);
  context.startedIds.push(id);
  const job = JSON.parse(runCli(["status", id, "--json"], context.env).stdout).job;
  assert.equal(job.goalMode, true);
  assert.equal(waitJson(id, context.env).job.status, "completed");
});

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
  assert.equal(result.outputTrust, "untrusted-process-output");
  assert.equal(result.job.dataTrust, "untrusted-local-job-metadata");
  assert.match(result.stdout, /done/);
  assert.match(result.stderr, /warning/);
});

test("documented shell option order launches successfully on the first invocation", (t) => {
  const context = makeEnv(t);
  const started = runCli([
    "start",
    "--name",
    "documented shell order",
    "--cwd",
    ROOT,
    "--shell",
    "--json",
    "--",
    "printf 'canonical-first-launch\\n'",
  ], context.env);
  const payload = JSON.parse(started.stdout);
  context.startedIds.push(payload.job.id);

  const completed = waitJson(payload.job.id, context.env).job;
  assert.equal(completed.status, "completed");
  assert.equal(completed.exitCode, 0);

  const result = JSON.parse(runCli(["result", payload.job.id, "--peek", "--json"], context.env).stdout);
  assert.match(result.stdout, /canonical-first-launch/);
});

test("reruns a terminal invocation as a fresh job with distinct logs and lineage", (t) => {
  const context = makeEnv(t);
  const marker = path.join(context.env.CODEX_HOME, "rerun-marker");
  const program = [
    "const fs = require('node:fs');",
    "const marker = process.argv[1];",
    "if (!fs.existsSync(marker)) {",
    "  fs.writeFileSync(marker, 'first run failed');",
    "  console.error('intentional first failure');",
    "  process.exit(7);",
    "}",
    "console.log('rerun succeeded');",
  ].join("\n");
  const source = startJson([
    "--name", "rerun integration",
    "--", process.execPath, "-e", program, marker,
  ], context);
  const first = waitJson(source.id, context.env);
  assert.equal(first.job.status, "failed");
  assert.equal(first.job.exitCode, 7);

  const rerun = JSON.parse(runCli([
    "rerun", source.id, "--json",
  ], context.env).stdout).job;
  context.startedIds.push(rerun.id);
  assert.notEqual(rerun.id, source.id);
  assert.equal(rerun.rerunOf, source.id);
  assert.equal(rerun.command, source.command);
  assert.equal(rerun.cwd, source.cwd);
  assert.deepEqual(rerun.execution, source.execution);
  assert.notEqual(rerun.logs.stdout, source.logs.stdout);
  assert.notEqual(rerun.logs.stderr, source.logs.stderr);

  const second = waitJson(rerun.id, context.env);
  assert.equal(second.job.status, "completed");
  assert.equal(second.job.exitCode, 0);
  const result = JSON.parse(runCli([
    "result", rerun.id, "--peek", "--json",
  ], context.env).stdout);
  assert.match(result.stdout, /rerun succeeded/);
  assert.equal(result.stderr, "");
});

test("rerun preserves explicit Bash execution semantics", (t) => {
  const context = makeEnv(t);
  const source = startJson([
    "--shell",
    "--",
    "set -o pipefail; test -n \"$BASH_VERSION\"; printf 'bash-rerun\\n' | cat",
  ], context);
  assert.equal(waitJson(source.id, context.env).job.status, "completed");

  const rerun = JSON.parse(runCli([
    "rerun", source.id, "--json",
  ], context.env).stdout).job;
  context.startedIds.push(rerun.id);
  assert.equal(rerun.rerunOf, source.id);
  assert.deepEqual(rerun.execution, { kind: "shell", interpreter: "bash" });

  const completed = waitJson(rerun.id, context.env).job;
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.execution, { kind: "shell", interpreter: "bash" });
  const result = JSON.parse(runCli([
    "result", rerun.id, "--peek", "--json",
  ], context.env).stdout);
  assert.equal(result.stdout, "bash-rerun\n");
});

test("rerun refuses active jobs and critical jobs without explicit force", (t) => {
  const context = makeEnv(t);
  const active = startJson([
    "--name", "active rerun refusal",
    "--", process.execPath, "-e", "setTimeout(() => process.exit(0), 5000)",
  ], context);
  const activeRefusal = runCli([
    "rerun", active.id, "--json",
  ], context.env, { expectStatus: 1 });
  assert.match(activeRefusal.stderr, /allowed only after terminal state/i);

  const critical = startJson([
    "--critical", "--name", "critical rerun guard",
    "--", process.execPath, "-e", "process.exit(0)",
  ], context);
  assert.equal(waitJson(critical.id, context.env).job.status, "completed");
  const guarded = runCli([
    "rerun", critical.id, "--json",
  ], context.env, { expectStatus: 1 });
  assert.match(guarded.stderr, /CRITICAL/);
  assert.match(guarded.stderr, /--force/);

  const forced = JSON.parse(runCli([
    "rerun", critical.id, "--force", "--json",
  ], context.env).stdout).job;
  context.startedIds.push(forced.id);
  assert.equal(forced.critical, true);
  assert.equal(forced.rerunOf, critical.id);
  assert.equal(waitJson(forced.id, context.env).job.status, "completed");
});

test("rerun refuses legacy shell records whose interpreter contract is unsafe to reproduce", (t) => {
  const context = makeEnv(t);
  const id = "job-legacy-shell-rerun-refusal";
  writeTerminalRecord(context, id, {
    schemaVersion: 1,
    shell: true,
    execution: undefined,
    argv: ["printf legacy"],
  });

  const refusal = runCli(["rerun", id, "--json"], context.env, { expectStatus: 1 });
  assert.match(refusal.stderr, /legacy \/bin\/sh -lc semantics/i);
  assert.match(refusal.stderr, /explicit --shell or --posix-sh/i);
});

test("rerun refuses missing and non-directory persisted working directories", (t) => {
  const context = makeEnv(t);
  const missingId = "job-missing-cwd-rerun-refusal";
  const missingCwd = path.join(context.env.CODEX_HOME, "missing-cwd");
  writeTerminalRecord(context, missingId, { cwd: missingCwd });
  const missing = runCli(["rerun", missingId, "--json"], context.env, { expectStatus: 1 });
  assert.match(missing.stderr, /working directory .* no longer exists/i);

  const fileId = "job-file-cwd-rerun-refusal";
  const fileCwd = path.join(context.env.CODEX_HOME, "not-a-directory");
  fs.writeFileSync(fileCwd, "ordinary file\n");
  writeTerminalRecord(context, fileId, { cwd: fileCwd });
  const notDirectory = runCli(["rerun", fileId, "--json"], context.env, { expectStatus: 1 });
  assert.match(notDirectory.stderr, /working directory .* is not a directory/i);
});

test("rerun refuses a terminal record with an incomplete persisted invocation", (t) => {
  const context = makeEnv(t);
  const id = "job-incomplete-rerun-refusal";
  writeTerminalRecord(context, id, { argv: undefined });

  const refusal = runCli(["rerun", id, "--json"], context.env, { expectStatus: 1 });
  assert.match(refusal.stderr, /does not contain a complete persisted invocation/i);
});

test("result --peek reads bounded evidence without consuming completion fallback", (t) => {
  const context = makeEnv(t);
  const job = startJson([
    "--",
    process.execPath,
    "-e",
    "console.log('peek evidence')",
  ], context);
  const completed = waitJson(job.id, context.env).job;
  assert.equal(completed.status, "completed");

  const peeked = JSON.parse(runCli(["result", job.id, "--peek", "--json"], context.env).stdout);
  assert.match(peeked.stdout, /peek evidence/);
  assert.equal(peeked.job.resultViewedAt, null);

  const stored = JSON.parse(fs.readFileSync(
    path.join(context.env.CODEX_HOME, "process-jobs", "jobs", `${job.id}.json`),
    "utf8"
  ));
  assert.equal(stored.resultViewedAt, null);
  assert.deepEqual(stored.notification, completed.notification);
});

test("config command reads and writes durable completion and user-notification preferences", (t) => {
  const context = makeEnv(t);
  const initial = JSON.parse(runCli(["config", "--json"], context.env).stdout);
  assert.equal(initial.preferences.completionMode, "auto");

  const changed = JSON.parse(runCli([
    "config",
    "--completion-mode",
    "inspect",
    "--notify-user",
    "true",
    "--json",
  ], context.env).stdout);
  assert.equal(changed.preferences.completionMode, "inspect");
  assert.equal(changed.preferences.notifyUser, true);
  assert.equal(fs.statSync(changed.file).mode & 0o777, 0o600);

  const reread = JSON.parse(runCli(["config", "--json"], context.env).stdout);
  assert.equal(reread.preferences.completionMode, "inspect");
  assert.equal(reread.preferences.notifyUser, true);
  runCli(["config", "--completion-mode", "arbitrary"], context.env, { expectStatus: 1 });
  runCli(["config", "--notify-user", "sometimes"], context.env, { expectStatus: 1 });
});

test("CLI-owned jobs default to one desktop completion notice unless overridden", (t) => {
  const stubBin = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-notify-stub-"));
  t.after(() => fs.rmSync(stubBin, { recursive: true, force: true }));
  const marker = path.join(stubBin, "notified.log");
  for (const name of ["osascript", "notify-send"]) {
    fs.writeFileSync(
      path.join(stubBin, name),
      `#!/bin/sh\nprintf '%s ' "$@" >> "${marker}"\n`,
      { mode: 0o755 },
    );
  }
  const stubbedPath = `${stubBin}${path.delimiter}${process.env.PATH}`;
  const context = makeEnv(t, {
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_cli",
    PATH: stubbedPath,
  });

  const defaulted = startJson(["--name", "cli-default-notice", "--", process.execPath, "-e", "process.exit(0)"], context);
  assert.equal(defaulted.ownerSurface, "cli");
  assert.equal(defaulted.notifyUser, true);
  assert.equal(waitJson(defaulted.id, context.env).job.status, "completed");
  assert.equal(waitUntil(() => {
    try {
      return fs.readFileSync(marker, "utf8").includes(defaulted.id);
    } catch {
      return false;
    }
  }, 5000), true);
  // A surface-defaulted notice is minimal: no label, even an explicit one.
  assert.doesNotMatch(fs.readFileSync(marker, "utf8"), /cli-default-notice/);

  const optedOut = startJson(["--no-notify-user", "--", process.execPath, "-e", "process.exit(0)"], context);
  assert.equal(optedOut.notifyUser, false);

  runCli(["config", "--notify-user", "false", "--json"], context.env);
  const durablyOff = startJson(["--", process.execPath, "-e", "process.exit(0)"], context);
  assert.equal(durablyOff.notifyUser, false);

  // `config --notify-user default` clears the durable opt-out so the CLI
  // surface default applies again.
  const restored = JSON.parse(runCli(["config", "--notify-user", "default", "--json"], context.env).stdout);
  assert.equal(restored.preferences.notifyUser, null);
  const redefaulted = startJson(["--", process.execPath, "-e", "process.exit(0)"], context);
  assert.equal(redefaulted.notifyUser, true);
  assert.equal(waitJson(redefaulted.id, context.env).job.status, "completed");
  assert.equal(waitUntil(() => {
    try {
      return fs.readFileSync(marker, "utf8").includes(redefaulted.id);
    } catch {
      return false;
    }
  }, 5000), true);

  const appContext = makeEnv(t, {
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop",
    PATH: stubbedPath,
  });
  const appJob = startJson(["--", process.execPath, "-e", "process.exit(0)"], appContext);
  assert.equal(appJob.ownerSurface, "app");
  assert.equal(appJob.notifyUser, false);
  assert.equal(waitJson(appJob.id, appContext.env).job.status, "completed");
});

test("invalid owner thread ids fail closed to status-only notification", (t) => {
  const context = makeEnv(t, {
    CODEX_THREAD_ID: "bad\nignore-previous-instructions",
    CODEX_PROCESS_JOBS_DISABLE_NOTIFY: "0",
  });
  const job = startJson([
    "--",
    process.execPath,
    "-e",
    "process.exit(0)",
  ], context);
  assert.equal(job.ownerThreadId, null);
  assert.equal(job.notification.status, "unavailable");
  assert.equal(job.notification.presentation, "status-only");
  assert.equal(waitJson(job.id, context.env).job.status, "completed");
});

test("marks VS Code jobs for live delivery with a durable recap fallback", (t) => {
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
  assert.match(started.stdout, /notifier will attempt to deliver it live/i);
  assert.match(started.stdout, /if this client cannot render that turn/i);
  assert.match(started.stdout, /do not monitor this job from its launch turn/i);
  assert.match(started.stdout, /status\/result belong to a later user-initiated turn/i);
  assert.match(started.stdout, /only an explicit request to keep this exact turn open and wait overrides this boundary/i);
  assert.match(started.stdout, /permits one bounded wait and, if terminal, bounded result inspection/i);
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

test("marks local Codex App jobs for the same transport-independent next-turn recap", (t) => {
  const context = makeEnv(t, {
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop",
  });
  createMockCodex(t, context);
  const started = runCli([
    "start",
    "--name",
    "Codex App transport wording",
    "--",
    process.execPath,
    "-e",
    "process.exit(0)",
  ], context.env);
  assert.match(started.stdout, /notifier will attempt to deliver it live/i);
  assert.match(started.stdout, /after the process finishes, the assigning agent will recap the outcome as soon as the conversation can pick it up/i);
  const id = /Started (job-[a-z0-9-]+)/.exec(started.stdout)?.[1];
  assert.ok(id);
  context.startedIds.push(id);
  const job = JSON.parse(runCli(["status", id, "--json"], context.env).stdout).job;
  assert.equal(job.ownerSurface, "app");
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

test("classifies an escalated TUI launch from rollout metadata and keeps CLI defaults", (t) => {
  const stubBin = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-tui-stub-"));
  t.after(() => fs.rmSync(stubBin, { recursive: true, force: true }));
  for (const name of ["osascript", "notify-send"]) {
    fs.writeFileSync(path.join(stubBin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  // An escalated sandbox retry can scrub CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  // the owning TUI rollout's exact session metadata must keep the job on the
  // cli surface so the desktop-notice default still applies.
  const context = makeEnv(t, {
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "",
    PATH: `${stubBin}${path.delimiter}${process.env.PATH}`,
  });
  writeSessionMeta(context.env, { source: "cli", originator: "codex-tui" });
  const job = startJson(["--", process.execPath, "-e", "process.exit(0)"], context);
  assert.equal(job.ownerSurface, "cli");
  assert.equal(job.ownerSurfaceDetectedBy, "rollout-session-meta");
  assert.equal(job.notifyUser, true);
  assert.equal(waitJson(job.id, context.env).job.status, "completed");
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
  assert.match(started.stdout, /notifier will attempt to deliver it live/i);
  assert.match(started.stdout, /if this client cannot render that turn/i);
  assert.match(started.stdout, /after the process finishes, the assigning agent will recap the outcome as soon as the conversation can pick it up/i);
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

test("refuses tampered persisted log paths instead of reading another local file", (t) => {
  const context = makeEnv(t);
  const job = startJson([
    "--",
    process.execPath,
    "-e",
    "process.exit(0)",
  ], context);
  assert.equal(waitJson(job.id, context.env).job.status, "completed");
  const secret = path.join(context.env.CODEX_HOME, "must-not-leak.txt");
  fs.writeFileSync(secret, "PRIVATE-CONTENT-MUST-NOT-LEAK");
  const jobFile = path.join(context.env.CODEX_HOME, "process-jobs", "jobs", `${job.id}.json`);
  const record = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  record.logs.stdout = secret;
  fs.writeFileSync(jobFile, `${JSON.stringify(record)}\n`);

  const result = runCli(["result", job.id], context.env, { expectStatus: 1 });
  assert.match(result.stderr, /log paths.*private state directory/i);
  assert.doesNotMatch(result.stdout, /PRIVATE-CONTENT-MUST-NOT-LEAK/);
  assert.doesNotMatch(result.stderr, /PRIVATE-CONTENT-MUST-NOT-LEAK/);
});

test("a refused symlinked log does not consume the unread result", (t) => {
  const context = makeEnv(t);
  const job = startJson([
    "--",
    process.execPath,
    "-e",
    "process.exit(0)",
  ], context);
  assert.equal(waitJson(job.id, context.env).job.status, "completed");
  const secret = path.join(context.env.CODEX_HOME, "symlink-target.txt");
  fs.writeFileSync(secret, "SYMLINK-TARGET-MUST-NOT-LEAK");
  fs.rmSync(job.logs.stdout);
  fs.symlinkSync(secret, job.logs.stdout);

  const result = runCli(["result", job.id], context.env, { expectStatus: 1 });
  assert.doesNotMatch(result.stdout, /SYMLINK-TARGET-MUST-NOT-LEAK/);
  assert.doesNotMatch(result.stderr, /SYMLINK-TARGET-MUST-NOT-LEAK/);
  const stored = JSON.parse(fs.readFileSync(
    path.join(context.env.CODEX_HOME, "process-jobs", "jobs", `${job.id}.json`),
    "utf8"
  ));
  assert.equal(stored.resultViewedAt, null);
  assert.equal(stored.notification.status, "disabled");
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

test("Bash shell mode supports pipefail and stores its execution contract", (t) => {
  const context = makeEnv(t);
  const job = startJson([
    "--shell",
    "--",
    "set -o pipefail; test -n \"$BASH_VERSION\"; printf bash-pipefail | cat",
  ], context);
  assert.deepEqual(job.execution, { kind: "shell", interpreter: "bash" });
  const waited = waitJson(job.id, context.env);
  assert.equal(waited.job.status, "completed");
  assert.deepEqual(waited.job.execution, { kind: "shell", interpreter: "bash" });
  assert.equal(waited.job.command, "set -o pipefail; test -n \"$BASH_VERSION\"; printf bash-pipefail | cat");
  const result = JSON.parse(runCli(["result", job.id, "--json"], context.env).stdout);
  assert.equal(result.stdout, "bash-pipefail");
});

test("Bash pipefail propagates a failing pipeline", (t) => {
  const context = makeEnv(t);
  const job = startJson(["--shell", "--", "set -o pipefail; false | true"], context);
  const waited = waitJson(job.id, context.env);
  assert.equal(waited.job.status, "failed");
  assert.equal(waited.job.exitCode, 1);
});

test("POSIX shell mode is explicit and shell flags are mutually exclusive", (t) => {
  const context = makeEnv(t);
  const job = startJson(["--posix-sh", "--", "printf posix-sh | cat"], context);
  assert.deepEqual(job.execution, { kind: "shell", interpreter: "posix-sh" });
  const waited = waitJson(job.id, context.env);
  assert.equal(waited.job.status, "completed");
  const result = JSON.parse(runCli(["result", job.id, "--json"], context.env).stdout);
  assert.equal(result.stdout, "posix-sh");

  const rejected = runCli(["start", "--shell", "--posix-sh", "--", "printf never"], context.env, { expectStatus: 1 });
  assert.match(rejected.stderr, /only one of --shell or --posix-sh/i);
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

test("cancellation kills a surviving descendant after the process-group leader exits", (t) => {
  const context = makeEnv(t);
  const descendantCode = [
    "process.on('SIGTERM', () => {});",
    "console.log(`ready ${process.pid}`);",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const leaderCode = [
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { stdio: ['ignore', 'inherit', 'inherit'] });`,
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const job = startJson(["--", process.execPath, "-e", leaderCode], context);
  waitJson(job.id, context.env, 200);

  const stdoutPath = path.join(context.env.CODEX_HOME, "process-jobs", "logs", `${job.id}.stdout.log`);
  assert.equal(waitUntil(() => fs.existsSync(stdoutPath) && /ready \d+/.test(fs.readFileSync(stdoutPath, "utf8"))), true);
  const descendantPid = Number.parseInt(/ready (\d+)/.exec(fs.readFileSync(stdoutPath, "utf8"))?.[1], 10);
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
  t.after(() => {
    try {
      process.kill(descendantPid, "SIGKILL");
    } catch {}
  });

  const cancelled = JSON.parse(runCli(["cancel", job.id, "--json"], context.env).stdout);
  assert.equal(cancelled.cancellation.forced, true);
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
