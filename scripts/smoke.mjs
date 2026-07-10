#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "job.mjs");
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-smoke-"));
const env = {
  ...process.env,
  CODEX_HOME: codexHome,
  CODEX_THREAD_ID: "portable-smoke-test",
  CODEX_PROCESS_JOBS_DISABLE_NOTIFY: "1",
};

function run(args, timeout = 15_000) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout,
  });
  assert.equal(result.status, 0, `command: ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result.stdout;
}

try {
  const startedAt = Date.now();
  const started = JSON.parse(run([
    "start",
    "--json",
    "--name",
    "portable smoke",
    "--",
    process.execPath,
    "-e",
    "console.log('configure 25%'); setTimeout(() => console.log('compile 63%'), 300); setTimeout(() => console.log('link 100%'), 600); setTimeout(() => process.exit(0), 1200)",
  ]));
  const launchMs = Date.now() - startedAt;
  assert.ok(launchMs < 2_000, `detached launch took ${launchMs} ms`);

  const immediate = JSON.parse(run(["status", started.job.id, "--json"]));
  assert.ok(["queued", "starting", "running"].includes(immediate.job.status));

  const waited = JSON.parse(run([
    "status",
    started.job.id,
    "--wait",
    "--timeout-ms",
    "5000",
    "--poll-interval-ms",
    "50",
    "--json",
  ]));
  assert.equal(waited.timedOut, false);
  assert.equal(waited.job.status, "completed");
  assert.equal(waited.job.exitCode, 0);

  const result = JSON.parse(run(["result", started.job.id, "--json"]));
  assert.match(result.stdout, /configure 25%/);
  assert.match(result.stdout, /compile 63%/);
  assert.match(result.stdout, /link 100%/);
  process.stdout.write([
    "PASS codex-process-jobs portable smoke test",
    `  job: ${started.job.id}`,
    `  detached launch: ${launchMs} ms`,
    `  immediate status: ${immediate.job.status}`,
    `  terminal status: ${waited.job.status} (exit ${waited.job.exitCode})`,
    "  isolated records: removed",
  ].join("\n") + "\n");
} finally {
  fs.rmSync(codexHome, { recursive: true, force: true });
}
