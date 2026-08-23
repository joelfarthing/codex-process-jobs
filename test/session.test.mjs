import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isSpawnedSubagentThread,
  resolveHookThreadId,
  resolveNotificationOwnerThreadId,
} from "../scripts/session.mjs";

function writeMeta(codexHome, threadId, payload) {
  const directory = path.join(codexHome, "sessions", "2026", "08", "23");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `rollout-test-${threadId}.jsonl`),
    `${JSON.stringify({ type: "session_meta", payload: { id: threadId, ...payload } })}\n`,
  );
}

test("routes spawned-subagent completion to the highest user-visible ancestor", (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-session-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const root = "thread-user-visible-root-001";
  const child = "thread-spawned-child-001";
  const grandchild = "thread-spawned-grandchild-001";
  writeMeta(codexHome, root, { source: "vscode", originator: "Codex Desktop" });
  writeMeta(codexHome, child, {
    source: { subagent: { thread_spawn: { parent_thread_id: root, depth: 1 } } },
    parent_thread_id: root,
    originator: "Codex Desktop",
  });
  writeMeta(codexHome, grandchild, {
    source: { subagent: { thread_spawn: { parent_thread_id: child, depth: 2 } } },
    parent_thread_id: child,
    originator: "Codex Desktop",
  });
  const env = { CODEX_HOME: codexHome };
  assert.equal(isSpawnedSubagentThread(root, env), false);
  assert.equal(isSpawnedSubagentThread(child, env), true);
  assert.equal(isSpawnedSubagentThread(grandchild, env), true);
  assert.equal(resolveNotificationOwnerThreadId(root, env), root);
  assert.equal(resolveNotificationOwnerThreadId(child, env), root);
  assert.equal(resolveNotificationOwnerThreadId(grandchild, env), root);
});

test("fails closed to the current thread when parent metadata is invalid or cyclic", (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-session-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const first = "thread-cycle-first-001";
  const second = "thread-cycle-second-001";
  writeMeta(codexHome, first, { parent_thread_id: second });
  writeMeta(codexHome, second, { parent_thread_id: first });
  assert.equal(resolveNotificationOwnerThreadId(first, { CODEX_HOME: codexHome }), first);

  const invalid = "thread-invalid-parent-001";
  writeMeta(codexHome, invalid, { parent_thread_id: "bad\nparent" });
  assert.equal(isSpawnedSubagentThread(invalid, { CODEX_HOME: codexHome }), false);
  assert.equal(resolveNotificationOwnerThreadId(invalid, { CODEX_HOME: codexHome }), invalid);
});

test("does not classify an ordinary child-like task as a spawned subagent without a subagent declaration", (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-session-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const threadId = "thread-user-fork-001";
  writeMeta(codexHome, threadId, {
    thread_source: "user",
    parent_thread_id: "thread-user-parent-001",
    source: "vscode",
  });
  assert.equal(isSpawnedSubagentThread(threadId, { CODEX_HOME: codexHome }), false);
  assert.equal(resolveNotificationOwnerThreadId(threadId, { CODEX_HOME: codexHome }), threadId);
});

test("hook thread identity prefers the validated executing subagent over the parent-shaped payload session", (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-session-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const parent = "thread-user-visible-parent-001";
  const child = "thread-spawned-child-001";
  writeMeta(codexHome, child, {
    session_id: parent,
    thread_source: "subagent",
    parent_thread_id: parent,
    source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } },
  });
  assert.equal(resolveHookThreadId(
    { session_id: parent },
    { CODEX_HOME: codexHome, CODEX_THREAD_ID: child },
  ), child);
  assert.equal(resolveHookThreadId({ session_id: parent }, {}), parent);
});
