import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { enqueueCodexNotification } from "../scripts/codex-queue.mjs";

function writeExecutable(root, lines) {
  const executable = path.join(root, "mock-codex");
  fs.writeFileSync(executable, ["#!/usr/bin/env node", ...lines].join("\n") + "\n", { mode: 0o755 });
  return executable;
}

test("Codex queue receives the thread and sanitized completion as argv", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpj-codex-queue-success-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const argsFile = path.join(root, "args.json");
  const executable = writeExecutable(root, [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.MOCK_QUEUE_ARGS, JSON.stringify(process.argv.slice(2)));",
    "process.exit(process.argv[2] === 'queue' ? 0 : 90);",
  ]);
  const result = await enqueueCodexNotification(
    [{ type: "text", text: "CPJ background job `job-safe-001` finished successfully with exit code 0." }],
    "thread-safe-001",
    3_000,
    { ...process.env, CODEX_PROCESS_JOBS_CODEX_BIN: executable, MOCK_QUEUE_ARGS: argsFile },
  );

  assert.deepEqual(result, {
    threadId: "thread-safe-001",
    turnId: null,
    status: "accepted",
    transport: "codex-queue",
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, "utf8")), [
    "queue",
    "--thread",
    "thread-safe-001",
    "--message",
    "CPJ background job `job-safe-001` finished successfully with exit code 0.",
  ]);
});

test("unsupported Codex queue returns a bounded fallback reason", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpj-codex-queue-unsupported-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = writeExecutable(root, [
    "process.stderr.write(\"error: unrecognized subcommand 'queue'\\n\");",
    "process.exit(2);",
  ]);
  let unavailable = null;
  const result = await enqueueCodexNotification(
    [{ type: "text", text: "bounded message" }],
    "thread-safe-002",
    3_000,
    { ...process.env, CODEX_PROCESS_JOBS_CODEX_BIN: executable },
    { onUnavailable: (reason) => { unavailable = reason; } },
  );

  assert.equal(result, null);
  assert.equal(
    unavailable,
    "Codex queue is unavailable (exit 2): error: unrecognized subcommand 'queue'",
  );
});

test("a queue acknowledgment timeout is acceptance-uncertain and cannot fall through", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpj-codex-queue-timeout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = writeExecutable(root, ["setInterval(() => {}, 1000);"]);

  await assert.rejects(
    enqueueCodexNotification(
      [{ type: "text", text: "bounded message" }],
      "thread-safe-003",
      20,
      { ...process.env, CODEX_PROCESS_JOBS_CODEX_BIN: executable },
    ),
    (error) => (
      error?.turnAccepted === true
      && error?.transport === "codex-queue"
      && /within 20ms/.test(error.message)
    ),
  );
});
