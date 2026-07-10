import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBoundedLogWriter, readTail } from "../scripts/logs.mjs";

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
