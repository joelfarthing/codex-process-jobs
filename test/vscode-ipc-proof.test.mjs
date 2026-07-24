import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildProbePrompt,
  parseArgs,
  validateExtensionContract,
} from "../tools/experimental/vscode-ipc-proof.mjs";

const CONFIRMATION = "I-understand-this-uses-private-VS-Code-IPC";

test("VS Code IPC proof requires explicit task, exact version, and private-IPC confirmation", () => {
  assert.throws(() => parseArgs([]), /--thread-id/);
  assert.throws(
    () => parseArgs([
      "--thread-id", "thread-proof-001",
      "--expected-extension-version", "26.721.41059",
      "--confirm", "yes",
    ]),
    /--confirm/,
  );
  assert.deepEqual(parseArgs([
    "--thread-id", "thread-proof-001",
    "--expected-extension-version", "26.721.41059",
    "--confirm", CONFIRMATION,
  ]), {
    threadId: "thread-proof-001",
    expectedExtensionVersion: "26.721.41059",
    extensionRoot: null,
    socketPath: null,
    confirmation: CONFIRMATION,
    timeoutMs: 30_000,
  });
});

test("VS Code IPC proof fails closed when the pinned private contract changes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpj-vscode-proof-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "out"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    publisher: "openai",
    name: "chatgpt",
    version: "26.721.41059",
  }));
  fs.writeFileSync(path.join(root, "out", "extension.js"), [
    'const methods = {"thread-follower-start-turn": 1};',
  ].join("\n"));
  assert.equal(validateExtensionContract(root, "26.721.41059").protocolVersion, 1);
  assert.throws(
    () => validateExtensionContract(root, "26.721.99999"),
    /version mismatch/,
  );
  fs.writeFileSync(path.join(root, "out", "extension.js"), [
    'const methods = {"thread-follower-start-turn": 2};',
  ].join("\n"));
  assert.throws(
    () => validateExtensionContract(root, "26.721.41059"),
    /does not expose/,
  );
});

test("VS Code IPC proof prompt is fixed, harmless, and carries an exact probe id", () => {
  const prompt = buildProbePrompt("vscode-ipc-proof-example");
  assert.match(prompt, /^Codex Process Jobs VS Code private IPC live-render test$/m);
  assert.match(prompt, /^Probe: vscode-ipc-proof-example$/m);
  assert.match(prompt, /not process output/);
  assert.match(prompt, /Do not call tools/);
});
