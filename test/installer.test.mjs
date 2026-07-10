import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  POLICY_BEGIN,
  POLICY_END,
  mergeMarketplace,
  upsertAgentPolicy,
  withCodexCachebuster,
} from "../scripts/install.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(ROOT, "scripts", "install.mjs");

function temporaryHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-install-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function installEnv(t, home) {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const calls = path.join(home, "codex-calls.jsonl");
  const mock = path.join(bin, "codex");
  fs.writeFileSync(mock, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const readline = require('node:readline');",
    "fs.appendFileSync(process.env.MOCK_CODEX_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');",
    "if (process.argv[2] === '--version') { console.log('codex-cli test'); process.exit(0); }",
    "if (process.argv[2] !== 'app-server') { console.log(JSON.stringify({ ok: true })); process.exit(0); }",
    "const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
    "lines.on('line', (line) => {",
    "  const message = JSON.parse(line);",
    "  if (message.id === 1) send({ id: 1, result: {} });",
    "  else if (message.id === 2 && message.method === 'hooks/list') send({ id: 2, result: { data: [{ hooks: [{ source: 'plugin', pluginId: 'codex-process-jobs@personal', key: 'hook-key-1', currentHash: 'sha256:test', trustStatus: 'untrusted' }] }] } });",
    "  else if (message.id === 2 && message.method === 'config/batchWrite') send({ id: 2, result: { status: 'ok' } });",
    "});",
  ].join("\n") + "\n", { mode: 0o755 });
  return {
    ...process.env,
    HOME: home,
    CODEX_HOME: path.join(home, ".codex"),
    CODEX_PROCESS_JOBS_INSTALL_HOME: home,
    MOCK_CODEX_CALLS: calls,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
}

function runInstaller(args, env) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
}

test("adds or refreshes only the expected personal marketplace entry", () => {
  const existing = {
    name: "personal",
    interface: { displayName: "My plugins" },
    plugins: [{ name: "other", source: { source: "local", path: "./plugins/other" } }],
  };
  const merged = mergeMarketplace(existing);
  assert.equal(merged.interface.displayName, "My plugins");
  assert.equal(merged.plugins[0].name, "other");
  assert.deepEqual(merged.plugins[1], {
    name: "codex-process-jobs",
    source: { source: "local", path: "./plugins/codex-process-jobs" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Coding",
  });
  assert.equal(existing.plugins.length, 1, "input should not be mutated");
});

test("refuses to hijack a marketplace entry with another source", () => {
  assert.throws(() => mergeMarketplace({
    name: "personal",
    plugins: [{
      name: "codex-process-jobs",
      source: { source: "git", path: "someone/else" },
    }],
  }), /Refusing to replace a different source/);
});

test("agent policy insertion is idempotent and preserves unrelated instructions", () => {
  const first = upsertAgentPolicy("# Personal rules\n", "## Detached jobs\n\nUse the plugin.");
  const second = upsertAgentPolicy(first, "## Detached jobs\n\nUse the updated plugin.");
  assert.match(second, /^# Personal rules/);
  assert.equal(second.split(POLICY_BEGIN).length - 1, 1);
  assert.equal(second.split(POLICY_END).length - 1, 1);
  assert.match(second, /Use the updated plugin/);
  assert.doesNotMatch(second, /Use the plugin\./);
});

test("cachebuster replaces existing build metadata", () => {
  assert.equal(
    withCodexCachebuster("1.2.3-beta.1+codex.old", "20260710-120000"),
    "1.2.3-beta.1+codex.local-20260710-120000"
  );
});

test("preview is read-only and apply installs into an isolated home", (t) => {
  const home = temporaryHome(t);
  const env = installEnv(t, home);
  const marketplaceFile = path.join(home, ".agents", "plugins", "marketplace.json");
  const destination = path.join(home, "plugins", "codex-process-jobs");
  const agentFile = path.join(home, ".codex", "AGENTS.md");

  const preview = runInstaller(["--with-agent-policy"], env);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /No changes made/);
  assert.equal(fs.existsSync(marketplaceFile), false);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.existsSync(agentFile), false);

  const applied = runInstaller(["--apply", "--with-agent-policy"], env);
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, ".codex-plugin", "plugin.json"), "utf8")).name, "codex-process-jobs");
  assert.equal(JSON.parse(fs.readFileSync(marketplaceFile, "utf8")).plugins.length, 1);
  assert.match(fs.readFileSync(agentFile, "utf8"), /\$codex-process-jobs:start/);
  assert.match(applied.stdout, /Completion hook: trusted 1 plugin hook/);

  const calls = fs.readFileSync(env.MOCK_CODEX_CALLS, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(calls.some((args) => args[0] === "plugin" && args[1] === "add" && args[2] === "codex-process-jobs@personal"));
  assert.ok(calls.some((args) => args[0] === "features" && args[1] === "enable" && args[2] === "hooks"));
  assert.equal(calls.filter((args) => args[0] === "app-server").length, 2);
});

test("apply refuses to replace the plugin while a tracked job is active", (t) => {
  const home = temporaryHome(t);
  const env = installEnv(t, home);
  const jobs = path.join(env.CODEX_HOME, "process-jobs", "jobs");
  fs.mkdirSync(jobs, { recursive: true });
  fs.writeFileSync(path.join(jobs, "job-active-001.json"), JSON.stringify({
    id: "job-active-001",
    name: "important build",
    status: "running",
  }));

  const result = runInstaller(["--apply"], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Tracked process jobs are active/);
  assert.equal(fs.existsSync(path.join(home, "plugins", "codex-process-jobs")), false);
});
