import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_MODEL_LOG_BYTES,
  createBoundedLogWriter,
  readLog,
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
  assert.equal(fs.readFileSync(target, "utf8"), "must remain unchanged");
});
