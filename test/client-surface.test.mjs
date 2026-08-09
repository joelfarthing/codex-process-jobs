import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { detectClientSurface, notificationPresentation } from "../scripts/client-surface.mjs";

test("detects the Codex VS Code extension from its exact originator marker", () => {
  assert.deepEqual(
    detectClientSurface({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_vscode" }),
    { surface: "vscode", detectedBy: "codex-originator" }
  );
  assert.equal(notificationPresentation("vscode", "pending"), "durable-refresh-required");
});

test("does not mistake Codex Desktop for the VS Code extension", () => {
  assert.deepEqual(
    detectClientSurface({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" }),
    { surface: "app", detectedBy: "codex-originator" }
  );
  assert.equal(notificationPresentation("app", "pending"), "durable-refresh-required");
});

test("supports an explicit normalized surface override for wrappers and tests", () => {
  assert.deepEqual(
    detectClientSurface({
      CODEX_PROCESS_JOBS_CLIENT_SURFACE: "CLI",
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_vscode",
    }),
    { surface: "cli", detectedBy: "process-jobs-override" }
  );
  assert.deepEqual(
    detectClientSurface({ CODEX_PROCESS_JOBS_CLIENT_SURFACE: "unknown" }),
    { surface: "unknown", detectedBy: "process-jobs-override" }
  );
  assert.deepEqual(
    detectClientSurface({ CODEX_PROCESS_JOBS_CLIENT_SURFACE: "remote" }),
    { surface: "remote", detectedBy: "process-jobs-override" }
  );
  assert.equal(notificationPresentation("cli", "pending"), "durable-refresh-required");
  assert.equal(notificationPresentation("unknown", "pending"), "durable-refresh-required");
});

test("detects a TUI-owned session from exact rollout metadata when env origin is absent", (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-surface-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const threadId = "thread-tui-escalated-001";
  const directory = path.join(codexHome, "sessions", "2026", "07", "27");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `rollout-test-${threadId}.jsonl`), `${JSON.stringify({
    timestamp: "2026-07-27T03:32:50.000Z",
    type: "session_meta",
    payload: {
      id: threadId,
      source: "cli",
      originator: "codex-tui",
    },
  })}\n`);
  const env = { CODEX_HOME: codexHome, CODEX_THREAD_ID: threadId };
  // An escalated sandbox launch can lose the originator environment; the
  // owning TUI rollout's exact scalar pair keeps the job on the cli surface.
  assert.deepEqual(
    detectClientSurface(env),
    { surface: "cli", detectedBy: "rollout-session-meta" }
  );
  // Any non-empty env originator still takes precedence over rollout metadata.
  assert.deepEqual(
    detectClientSurface({ ...env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_vscode" }),
    { surface: "vscode", detectedBy: "codex-originator" }
  );
  // Other cli-source pairs stay unknown rather than being guessed.
  fs.writeFileSync(path.join(directory, `rollout-test-${threadId}.jsonl`), `${JSON.stringify({
    timestamp: "2026-07-27T03:32:50.000Z",
    type: "session_meta",
    payload: { id: threadId, source: "cli", originator: "custom-wrapper" },
  })}\n`);
  assert.deepEqual(detectClientSurface(env), { surface: "unknown", detectedBy: null });
});

test("detects an App-Server-backed TUI from its rollout metadata", (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-surface-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const threadId = "thread-tui-app-server-001";
  const directory = path.join(codexHome, "sessions", "2026", "08", "09");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `rollout-test-${threadId}.jsonl`), `${JSON.stringify({
    timestamp: "2026-08-09T14:15:46.000Z",
    type: "session_meta",
    payload: {
      id: threadId,
      source: "vscode",
      originator: "codex-tui",
    },
  })}\n`);
  assert.deepEqual(
    detectClientSurface({ CODEX_HOME: codexHome, CODEX_THREAD_ID: threadId }),
    { surface: "cli", detectedBy: "rollout-session-meta" }
  );
});

test("detects Cartesian remote sessions from exact rollout metadata when env origin is absent", (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-surface-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const threadId = "thread-cartesian-001";
  const directory = path.join(codexHome, "sessions", "2026", "07", "10");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `rollout-test-${threadId}.jsonl`), `${JSON.stringify({
    timestamp: "2026-07-11T02:07:03.874Z",
    type: "session_meta",
    payload: {
      id: threadId,
      source: "vscode",
      originator: "Codex Desktop",
    },
  })}\n`);
  const env = { CODEX_HOME: codexHome, CODEX_THREAD_ID: threadId };
  assert.deepEqual(
    detectClientSurface(env),
    { surface: "remote", detectedBy: "rollout-session-meta" }
  );
  assert.equal(notificationPresentation("remote", "pending"), "durable-refresh-required");
  assert.deepEqual(
    detectClientSurface({ ...env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" }),
    { surface: "app", detectedBy: "codex-originator" }
  );
  assert.deepEqual(
    detectClientSurface({ ...env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "custom-client" }),
    { surface: "unknown", detectedBy: null }
  );
  assert.deepEqual(
    detectClientSurface({ ...env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_cli" }),
    { surface: "cli", detectedBy: "codex-originator" }
  );
  assert.deepEqual(
    detectClientSurface({ ...env, CODEX_PROCESS_JOBS_CLIENT_SURFACE: "unknown" }),
    { surface: "unknown", detectedBy: "process-jobs-override" }
  );
});

test("generic vscode session metadata alone is not enough to infer remote", (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-surface-ambiguous-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const threadId = "thread-ambiguous-001";
  const directory = path.join(codexHome, "sessions");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `rollout-test-${threadId}.jsonl`), `${JSON.stringify({
    type: "session_meta",
    payload: { id: threadId, source: "vscode", originator: "custom-client" },
  })}\n`);
  assert.deepEqual(
    detectClientSurface({ CODEX_HOME: codexHome, CODEX_THREAD_ID: threadId }),
    { surface: "unknown", detectedBy: null }
  );

  const subagentThreadId = "thread-subagent-001";
  fs.writeFileSync(path.join(directory, `rollout-test-${subagentThreadId}.jsonl`), `${JSON.stringify({
    type: "session_meta",
    payload: {
      id: subagentThreadId,
      source: { subagent: "reviewer" },
      originator: "Codex Desktop",
    },
  })}\n`);
  assert.deepEqual(
    detectClientSurface({ CODEX_HOME: codexHome, CODEX_THREAD_ID: subagentThreadId }),
    { surface: "unknown", detectedBy: null }
  );
});

test("uses status-only wording when no owning thread is available", () => {
  assert.equal(notificationPresentation("vscode", "unavailable"), "status-only");
  assert.equal(notificationPresentation("vscode", "disabled"), "disabled");
});
