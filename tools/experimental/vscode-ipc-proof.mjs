#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isCliEntry } from "../../scripts/cli-entry.mjs";
import { startPrivateIpcNotificationTurn } from "../../scripts/desktop-ipc.mjs";
import { resolveCodexHome } from "../../scripts/state.mjs";

const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{8,160}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const CONFIRMATION = "I-understand-this-uses-private-VS-Code-IPC";
const START_TURN_CONTRACT = /["']thread-follower-start-turn["']\s*:\s*1\b/;

function usage() {
  return [
    "Usage:",
    "  node tools/experimental/vscode-ipc-proof.mjs \\",
    "    --thread-id <VS Code task id> \\",
    "    --expected-extension-version <exact version> \\",
    `    --confirm ${CONFIRMATION}`,
    "",
    "This is a harmless, version-gated experiment. It injects one synthetic",
    "completion turn into the explicitly named task through Codex private IPC.",
  ].join("\n");
}

export function parseArgs(argv) {
  const parsed = {
    threadId: null,
    expectedExtensionVersion: null,
    extensionRoot: null,
    socketPath: null,
    confirmation: null,
    timeoutMs: 30_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--thread-id") parsed.threadId = argv[++index] ?? null;
    else if (arg === "--expected-extension-version") parsed.expectedExtensionVersion = argv[++index] ?? null;
    else if (arg === "--extension-root") parsed.extensionRoot = argv[++index] ?? null;
    else if (arg === "--socket") parsed.socketPath = argv[++index] ?? null;
    else if (arg === "--timeout-ms") parsed.timeoutMs = Number.parseInt(argv[++index] ?? "", 10);
    else if (arg === "--confirm") parsed.confirmation = argv[++index] ?? null;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!THREAD_ID_PATTERN.test(parsed.threadId ?? "")) {
    throw new Error("--thread-id must be an explicit valid Codex task id.");
  }
  if (!VERSION_PATTERN.test(parsed.expectedExtensionVersion ?? "")) {
    throw new Error("--expected-extension-version must be an exact numeric version.");
  }
  if (parsed.confirmation !== CONFIRMATION) {
    throw new Error(`--confirm must equal ${CONFIRMATION}.`);
  }
  if (!Number.isInteger(parsed.timeoutMs) || parsed.timeoutMs < 1_000 || parsed.timeoutMs > 60_000) {
    throw new Error("--timeout-ms must be an integer from 1000 through 60000.");
  }
  return parsed;
}

function activeExtensionRoot(homeDirectory = os.homedir()) {
  const extensionsFile = path.join(homeDirectory, ".vscode", "extensions", "extensions.json");
  const entries = JSON.parse(fs.readFileSync(extensionsFile, "utf8"));
  const matches = entries.filter((entry) => entry?.identifier?.id === "openai.chatgpt");
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one active OpenAI VS Code extension entry; found ${matches.length}.`);
  }
  const root = matches[0]?.location?.fsPath;
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("The active OpenAI VS Code extension entry has no absolute filesystem path.");
  }
  return root;
}

export function validateExtensionContract(extensionRoot, expectedVersion) {
  const manifestPath = path.join(extensionRoot, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.publisher !== "openai" || manifest.name !== "chatgpt") {
    throw new Error("The selected extension is not the OpenAI ChatGPT/Codex VS Code extension.");
  }
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `VS Code extension version mismatch: expected ${expectedVersion}, found ${manifest.version}.`,
    );
  }
  const bundlePath = path.join(extensionRoot, "out", "extension.js");
  const bundle = fs.readFileSync(bundlePath, "utf8");
  if (!START_TURN_CONTRACT.test(bundle)) {
    throw new Error(
      "The pinned extension bundle does not expose thread-follower-start-turn protocol version 1.",
    );
  }
  return {
    extensionRoot,
    extensionVersion: manifest.version,
    protocolMethod: "thread-follower-start-turn",
    protocolVersion: 1,
  };
}

export function buildProbePrompt(probeId) {
  return [
    "Codex Process Jobs VS Code private IPC live-render test",
    "",
    `Probe: ${probeId}`,
    "",
    "This is a harmless synthetic completion probe, not a user request and not process output.",
    "Respond conversationally in one short sentence: tell Joel that the VS Code private IPC live-render proof appeared.",
    "Do not call tools or continue unrelated work in this notification turn.",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const extensionRoot = path.resolve(parsed.extensionRoot ?? activeExtensionRoot());
  const contract = validateExtensionContract(extensionRoot, parsed.expectedExtensionVersion);
  const socketPath = path.resolve(
    parsed.socketPath ?? path.join(resolveCodexHome(env), "ipc", "ipc.sock"),
  );
  const probeId = `vscode-ipc-proof-${crypto.randomUUID()}`;
  const result = await startPrivateIpcNotificationTurn(
    [{ type: "text", text: buildProbePrompt(probeId) }],
    parsed.threadId,
    parsed.timeoutMs,
    socketPath,
    {
      clientType: "codex-process-jobs-vscode-proof",
      transport: "vscode-private-ipc-proof",
    },
  );
  process.stdout.write(`${JSON.stringify({ ...contract, probeId, ...result })}\n`);
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`VS Code IPC proof failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
