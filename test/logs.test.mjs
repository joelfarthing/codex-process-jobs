import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_MODEL_LOG_BYTES,
  createBoundedLogWriter,
  readLog,
  readLogSince,
  readTail,
} from "../scripts/logs.mjs";

test("bounded writer keeps the latest bytes and a truncation marker", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "job.log");
  const writer = createBoundedLogWriter(file, 1024);
  writer.append(Buffer.from("a".repeat(800)));
  writer.append(Buffer.from("b".repeat(800)));
  writer.close();

  const contents = fs.readFileSync(file, "utf8");
  assert.ok(Buffer.byteLength(contents) <= 1024);
  assert.match(contents, /^\[\.\.\. earlier output truncated \.\.\.\]\n/);
  assert.ok(contents.endsWith("b".repeat(800)));
  assert.equal(readTail(file, 20).toString("utf8"), "b".repeat(20));
});

test("incremental log cursors return disjoint ranges and a stable next offset", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-cursor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "cursor.log");
  fs.writeFileSync(file, "one\n");
  const first = readLogSince(file, 0, { maxBytes: 1024 });
  assert.equal(first.text, "one\n");
  assert.equal(first.nextOffset, 4);
  assert.equal(first.compacted, false);
  fs.appendFileSync(file, "two\n");
  const second = readLogSince(file, first.nextOffset, { maxBytes: 1024 });
  assert.equal(second.text, "two\n");
  assert.equal(second.startOffset, 4);
  assert.equal(second.nextOffset, 8);
  assert.equal(second.compacted, false);
});

test("incremental cursors recover from compaction and remain model bounded", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-cursor-compact-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "cursor.log");
  fs.writeFileSync(file, "abcdefghij");
  const compacted = readLogSince(file, 99, { maxBytes: 4 });
  assert.equal(compacted.text, "ghij");
  assert.equal(compacted.nextOffset, 10);
  assert.equal(compacted.compacted, true);
  assert.equal(compacted.truncated, true);
  const bounded = readLogSince(file, 0, { maxBytes: 4 });
  assert.equal(bounded.text, "ghij");
  assert.equal(bounded.truncated, true);
  assert.equal(Buffer.byteLength(bounded.text), 4);
});

test("cursor generations detect same-size compaction", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-cursor-generation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "cursor.log");
  fs.writeFileSync(file, "a".repeat(320));
  const first = readLogSince(file, 0, { maxBytes: 320 });
  assert.match(first.generation, /^[a-f0-9]{16}$/);
  fs.writeFileSync(file, "b".repeat(320));
  const afterCompaction = readLogSince(file, first.nextOffset, {
    maxBytes: 16,
    generation: first.generation,
  });
  assert.equal(afterCompaction.compacted, true);
  assert.equal(afterCompaction.text, "b".repeat(16));
  assert.notEqual(afterCompaction.generation, first.generation);
});

test("cursor generation remains stable across ordinary appends", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-cursor-append-generation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "cursor.log");
  fs.writeFileSync(file, "a".repeat(300));
  const first = readLogSince(file, 0, { maxBytes: 1024 });
  fs.appendFileSync(file, "b".repeat(100));
  const second = readLogSince(file, first.nextOffset, {
    maxBytes: 1024,
    generation: first.generation,
  });
  assert.equal(second.compacted, false);
  assert.equal(second.text, "b".repeat(100));
  assert.equal(second.generation, first.generation);
});

test("full model-facing log reads remain capped", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-full-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "large.log");
  fs.writeFileSync(file, `prefix-${"z".repeat(MAX_MODEL_LOG_BYTES + 4096)}`);

  const contents = readLog(file, { full: true, maxBytes: Number.MAX_SAFE_INTEGER });
  assert.ok(Buffer.byteLength(contents) <= MAX_MODEL_LOG_BYTES);
  assert.match(contents, /^\[\.\.\. earlier output truncated \.\.\.\]\n/);
  assert.ok(contents.endsWith("z".repeat(4096)));
});

test("tracked log readers and writers refuse symlinks", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-log-symlink-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target.txt");
  const link = path.join(root, "job.log");
  fs.writeFileSync(target, "must remain unchanged");
  fs.symlinkSync(target, link);

  assert.throws(() => createBoundedLogWriter(link, 1024));
  assert.throws(() => readTail(link, 1024));
  assert.throws(() => readLog(link, { full: true, maxBytes: 1024 }));
  assert.throws(() => readLogSince(link, 0, { maxBytes: 1024 }));
  assert.equal(fs.readFileSync(target, "utf8"), "must remain unchanged");
});
