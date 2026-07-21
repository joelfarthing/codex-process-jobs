import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { isCliEntry } from "../scripts/cli-entry.mjs";
import { applyCancellationOutcome } from "../scripts/job.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runCli(cli, args, env, { expectStatus = 0 } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
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

test("CLI and detached worker run from an installation path containing spaces", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex process jobs space-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  assert.match(root, / /);
  fs.cpSync(path.join(ROOT, "scripts"), path.join(root, "scripts"), { recursive: true });
  const cli = path.join(root, "scripts", "job.mjs");
  const env = {
    CODEX_HOME: path.join(root, "codex-home"),
    CODEX_PROCESS_JOBS_DISABLE_NOTIFY: "1",
  };

  const help = runCli(cli, ["--help"], env);
  assert.match(help.stdout, /Usage:/);

  const started = JSON.parse(runCli(cli, [
    "start",
    "--json",
    "--name",
    "space path",
    "--",
    process.execPath,
    "-e",
    "console.log('space-path-ok')",
  ], env).stdout);
  const waited = JSON.parse(runCli(cli, [
    "status",
    started.job.id,
    "--wait",
    "--timeout-ms",
    "8000",
    "--poll-interval-ms",
    "50",
    "--json",
  ], env).stdout);
  assert.equal(waited.timedOut, false);
  assert.equal(waited.job.status, "completed");
  assert.equal(waited.job.exitCode, 0);
  const result = JSON.parse(runCli(cli, ["result", started.job.id, "--json"], env).stdout);
  assert.match(result.stdout, /space-path-ok/);
});

test("CLI entry detection tolerates spaces and symlinked launch paths and fails closed", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-entry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const realDir = path.join(root, "real dir");
  fs.mkdirSync(realDir);
  const script = path.join(realDir, "tool.mjs");
  fs.writeFileSync(script, "export {};\n");
  const linkDir = path.join(root, "linked");
  fs.symlinkSync(realDir, linkDir);

  const moduleUrl = pathToFileURL(script).href;
  assert.equal(isCliEntry(moduleUrl, script), true);
  assert.equal(isCliEntry(moduleUrl, path.join(linkDir, "tool.mjs")), true);
  assert.equal(isCliEntry(moduleUrl, path.join(realDir, "other.mjs")), false);
  assert.equal(isCliEntry(moduleUrl, undefined), false);
});

test("tail JSON exposes reusable incremental cursors", (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-tail-cursor-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const cli = path.join(ROOT, "scripts", "job.mjs");
  const env = { CODEX_HOME: codexHome, CODEX_PROCESS_JOBS_DISABLE_NOTIFY: "1" };
  const started = JSON.parse(runCli(cli, [
    "start", "--json", "--name", "cursor", "--",
    process.execPath, "-e", "process.stdout.write('one\\ntwo\\n')",
  ], env).stdout);
  runCli(cli, [
    "status", started.job.id, "--wait", "--timeout-ms", "8000",
    "--poll-interval-ms", "50", "--json",
  ], env);
  const first = JSON.parse(runCli(cli, [
    "tail", started.job.id, "--stdout", "--json",
  ], env).stdout);
  assert.equal(first.stdout.text, "one\ntwo\n");
  assert.equal(first.stdout.nextOffset, 8);
  const second = JSON.parse(runCli(cli, [
    "tail", started.job.id, "--stdout", "--since-byte", String(first.stdout.nextOffset), "--json",
  ], env).stdout);
  assert.equal(second.stdout.text, "");
  assert.equal(second.stdout.nextOffset, first.stdout.nextOffset);
});

test("incremental cursors remain independent across stdout and stderr", (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-stream-cursors-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const cli = path.join(ROOT, "scripts", "job.mjs");
  const env = { CODEX_HOME: codexHome, CODEX_PROCESS_JOBS_DISABLE_NOTIFY: "1" };
  const started = JSON.parse(runCli(cli, [
    "start", "--json", "--name", "stream-cursors", "--",
    process.execPath, "-e", "process.stdout.write('stdout-long\\n'); process.stderr.write('err\\n')",
  ], env).stdout);
  runCli(cli, [
    "status", started.job.id, "--wait", "--timeout-ms", "8000",
    "--poll-interval-ms", "50", "--json",
  ], env);
  const first = JSON.parse(runCli(cli, [
    "result", started.job.id,
    "--stdout-since-byte", "0", "--stderr-since-byte", "0", "--peek", "--json",
  ], env).stdout);
  assert.equal(first.stdout, "stdout-long\n");
  assert.equal(first.stderr, "err\n");
  assert.equal(first.cursors.stdout.nextOffset, 12);
  assert.equal(first.cursors.stderr.nextOffset, 4);
  assert.throws(
    () => runCli(cli, ["tail", started.job.id, "--both", "--since-byte", "0", "--json"], env),
    /shared cursor is ambiguous/
  );
});

test("a start rejected by record validation leaves no orphaned log files", (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-badstart-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const cli = path.join(ROOT, "scripts", "job.mjs");
  const env = { CODEX_HOME: codexHome, CODEX_PROCESS_JOBS_DISABLE_NOTIFY: "1" };

  runCli(cli, [
    "start",
    "--name",
    "x".repeat(600),
    "--",
    process.execPath,
    "-e",
    "process.exit(0)",
  ], env, { expectStatus: 1 });

  const logsDir = path.join(codexHome, "process-jobs", "logs");
  const leftover = fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [];
  assert.deepEqual(leftover, []);
  const jobsDir = path.join(codexHome, "process-jobs", "jobs");
  const jobs = fs.existsSync(jobsDir)
    ? fs.readdirSync(jobsDir).filter((name) => name.endsWith(".json"))
    : [];
  assert.deepEqual(jobs, []);
});

test("status reconciles a stale active record whose worker and process identities are gone", (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-reconcile-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const cli = path.join(ROOT, "scripts", "job.mjs");
  const env = { CODEX_HOME: codexHome };
  const id = "job-stale-worker";
  const jobsDir = path.join(codexHome, "process-jobs", "jobs");
  const logsDir = path.join(codexHome, "process-jobs", "logs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, `${id}.json`), `${JSON.stringify({
    schemaVersion: 1,
    id,
    name: "stale worker",
    status: "running",
    phase: "running",
    cwd: process.cwd(),
    shell: false,
    argv: [process.execPath, "-e", "process.exit(0)"],
    pid: process.pid,
    pidIdentity: "darwin:identity-of-a-previous-boot",
    workerPid: process.pid,
    workerIdentity: "darwin:identity-of-a-previous-boot",
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:00:00.000Z",
    logs: {
      stdout: path.join(logsDir, `${id}.stdout.log`),
      stderr: path.join(logsDir, `${id}.stderr.log`),
    },
  }, null, 2)}\n`, { mode: 0o600 });

  const status = JSON.parse(runCli(cli, ["status", id, "--json"], env).stdout);
  assert.equal(status.job.status, "failed");
  assert.match(status.job.errorMessage, /ended without reporting a terminal status/);
  assert.equal(status.job.pid, null);
});

test("cancellation outcome never downgrades a worker-won terminal record", () => {
  const timestamp = "2026-07-20T12:00:00.000Z";
  const workerWon = {
    id: "job-cancel-race",
    status: "cancelled",
    phase: "cancelled",
    completedAt: "2026-07-20T11:59:59.000Z",
    exitCode: 0,
    lastPid: 4242,
    pid: null,
    pidIdentity: null,
    notification: { requested: true, status: "pending", mode: "app-server-turn" },
  };
  const outcome = applyCancellationOutcome(
    workerWon,
    { terminated: false, forced: false, reason: "process identity mismatch" },
    timestamp
  );
  assert.equal(outcome.status, "cancelled");
  assert.equal(outcome.completedAt, "2026-07-20T11:59:59.000Z");
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.notification.status, "suppressed");
  assert.equal(outcome.notification.suppressedAt, timestamp);
});

test("cancellation outcome preserves a delivered notification on a terminal record", () => {
  const delivered = {
    id: "job-cancel-delivered",
    status: "failed",
    exitCode: 3,
    notification: { status: "delivered", transport: "app-server" },
  };
  const outcome = applyCancellationOutcome(delivered, { terminated: true, forced: false });
  assert.equal(outcome, delivered);
});

test("cancellation outcome records terminal cancel results for active records", () => {
  const timestamp = "2026-07-20T12:00:00.000Z";
  const active = {
    id: "job-cancel-active",
    status: "cancelling",
    pid: 555,
    pidIdentity: "linux:123",
    notification: { status: "pending" },
  };

  const cancelled = applyCancellationOutcome(active, { terminated: true, forced: true }, timestamp);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pid, null);
  assert.equal(cancelled.pidIdentity, null);
  assert.equal(cancelled.lastPid, 555);
  assert.equal(cancelled.notification.status, "suppressed");

  const refused = applyCancellationOutcome(
    active,
    { terminated: false, forced: false, reason: "still running" },
    timestamp
  );
  assert.equal(refused.status, "cancel_failed");
  assert.equal(refused.pid, 555);
  assert.equal(refused.pidIdentity, "linux:123");
  assert.match(refused.errorMessage, /still running/);
});
