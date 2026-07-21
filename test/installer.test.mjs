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
  applyInstall,
  mergeMarketplace,
  sourceConflictsWithDestination,
  upsertAgentPolicy,
  withCodexCachebuster,
} from "../scripts/install.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(ROOT, "scripts", "install.mjs");

test("package and source plugin versions match before install cachebusting", () => {
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const pluginManifest = JSON.parse(fs.readFileSync(path.join(ROOT, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(pluginManifest.version, packageMetadata.version);
});

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
    "fs.appendFileSync(process.env.MOCK_CODEX_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');",
    "if (process.argv[2] === '--version') { console.log('codex-cli test'); process.exit(0); }",
    "console.log(JSON.stringify({ ok: true }));",
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

test("detects when the source checkout is also the runtime destination", async () => {
  const source = path.join(os.tmpdir(), "codex-process-jobs-source-conflict");
  assert.equal(sourceConflictsWithDestination(source, source), true);
  assert.equal(sourceConflictsWithDestination(source, `${source}-installed`), false);

  await assert.rejects(
    applyInstall({
      sourceRoot: source,
      destination: source,
      sourceDestinationConflict: true,
    }, {}),
    /Refusing to replace the source checkout/
  );
});

test("global-policy preview is read-only and apply installs into an isolated home", (t) => {
  const home = temporaryHome(t);
  const env = installEnv(t, home);
  const marketplaceFile = path.join(home, ".agents", "plugins", "marketplace.json");
  const destination = path.join(home, "plugins", "codex-process-jobs");
  const agentFile = path.join(home, ".codex", "AGENTS.md");

  const preview = runInstaller(["--agent-policy", "global"], env);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /No changes made/);
  assert.match(preview.stdout, /source checkout is separate from the runtime destination/);
  assert.match(preview.stdout, /VS Code requires Developer: Reload Window/);
  assert.match(preview.stdout, /PostToolUse, Stop, and UserPromptSubmit/);
  assert.match(preview.stdout, /requires explicit approval in \/hooks after restart/);
  assert.equal(fs.existsSync(marketplaceFile), false);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.existsSync(agentFile), false);

  const applied = runInstaller(["--apply", "--agent-policy", "global"], env);
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, ".codex-plugin", "plugin.json"), "utf8")).name, "codex-process-jobs");
  assert.equal(JSON.parse(fs.readFileSync(marketplaceFile, "utf8")).plugins.length, 1);
  const agentPolicy = fs.readFileSync(agentFile, "utf8");
  assert.match(agentPolicy, /\$codex-process-jobs:start/);
  assert.match(agentPolicy, /persistent servers or watchers/i);
  assert.match(agentPolicy, /successful start is a hard turn boundary/i);
  assert.match(agentPolicy, /without status, tail, result, wait, sleep, `ps`, or other monitoring/i);
  assert.match(agentPolicy, /only an explicit request to keep that exact turn open permits one bounded wait/i);
  assert.match(agentPolicy, /follow the selected Codex Process Jobs skills/i);
  assert.ok(agentPolicy.split(/\s+/).filter(Boolean).length <= 140, "managed policy should stay compact");
  assert.match(applied.stdout, /installer never trusts hooks automatically/i);
  assert.match(applied.stdout, /PostToolUse, Stop, and UserPromptSubmit/);
  assert.match(applied.stdout, /explicit user approval in \/hooks/i);
  assert.match(applied.stdout, /Restart every open Codex client/);
  assert.match(applied.stdout, /Developer: Reload Window/);
  assert.match(applied.stdout, /After the restart, start a fresh Codex task/);

  const calls = fs.readFileSync(env.MOCK_CODEX_CALLS, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(calls.some((args) => args[0] === "plugin" && args[1] === "add" && args[2] === "codex-process-jobs@personal"));
  assert.ok(calls.some((args) => args[0] === "features" && args[1] === "enable" && args[2] === "hooks"));
  assert.equal(calls.filter((args) => args[0] === "app-server").length, 0);
  assert.equal(calls.some((args) => args.includes("config/batchWrite")), false);
});

test("default preview requires an explicit global, project, or none policy choice", (t) => {
  const home = temporaryHome(t);
  const env = installEnv(t, home);
  const preview = runInstaller([], env);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /agent policy: not selected; choose global, project, or none/i);
  assert.match(preview.stdout, /ask the user to choose global AGENTS\.md, one project AGENTS\.md, or no AGENTS\.md policy/i);
  assert.equal(fs.existsSync(path.join(home, ".codex", "AGENTS.md")), false);
});

test("apply refuses to infer an AGENTS.md policy choice", (t) => {
  const home = temporaryHome(t);
  const env = installEnv(t, home);
  const result = runInstaller(["--apply"], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires an explicit --agent-policy global, project, or none choice/i);
  assert.equal(fs.existsSync(path.join(home, "plugins", "codex-process-jobs")), false);
});

test("project policy modifies only the selected project AGENTS.md", (t) => {
  const home = temporaryHome(t);
  const env = installEnv(t, home);
  const projectRoot = path.join(home, "project");
  const projectAgentFile = path.join(projectRoot, "AGENTS.md");
  const globalAgentFile = path.join(home, ".codex", "AGENTS.md");
  fs.mkdirSync(projectRoot);
  fs.writeFileSync(projectAgentFile, "# Project rules\n");

  const preview = runInstaller(["--agent-policy", "project", "--project-root", projectRoot], env);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /agent policy: project; update .*\/project\/AGENTS\.md/);
  assert.equal(fs.readFileSync(projectAgentFile, "utf8"), "# Project rules\n");

  const applied = runInstaller([
    "--apply", "--agent-policy", "project", "--project-root", projectRoot,
  ], env);
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  assert.match(fs.readFileSync(projectAgentFile, "utf8"), /^# Project rules[\s\S]*codex-process-jobs:begin/);
  assert.equal(fs.statSync(projectAgentFile).mode & 0o777, 0o644);
  assert.equal(fs.existsSync(globalAgentFile), false);
});

test("none policy installs without changing any AGENTS.md", (t) => {
  const home = temporaryHome(t);
  const env = installEnv(t, home);
  const globalAgentFile = path.join(home, ".codex", "AGENTS.md");
  fs.mkdirSync(path.dirname(globalAgentFile), { recursive: true });
  fs.writeFileSync(globalAgentFile, "# Keep me unchanged\n");

  const result = runInstaller(["--apply", "--agent-policy", "none"], env);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.readFileSync(globalAgentFile, "utf8"), "# Keep me unchanged\n");
  assert.match(result.stdout, /no AGENTS\.md was changed/i);
});

test("deprecated --with-agent-policy alias still selects global policy", (t) => {
  const home = temporaryHome(t);
  const env = installEnv(t, home);
  const preview = runInstaller(["--with-agent-policy"], env);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /agent policy: global; update/i);
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

  const result = runInstaller(["--apply", "--agent-policy", "none"], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Tracked process jobs are active/);
  assert.equal(fs.existsSync(path.join(home, "plugins", "codex-process-jobs")), false);
});

test("apply refuses symlinked configuration targets without replacing or changing them", (t) => {
  const home = temporaryHome(t);
  const env = installEnv(t, home);
  const target = path.join(home, "marketplace-target.json");
  const marketplaceFile = path.join(home, ".agents", "plugins", "marketplace.json");
  fs.mkdirSync(path.dirname(marketplaceFile), { recursive: true });
  fs.writeFileSync(target, '{"name":"personal","plugins":[]}\n');
  fs.symlinkSync(target, marketplaceFile);

  const result = runInstaller(["--apply", "--agent-policy", "none"], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a regular file/i);
  assert.equal(fs.lstatSync(marketplaceFile).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, "utf8"), '{"name":"personal","plugins":[]}\n');
  assert.equal(fs.existsSync(path.join(home, "plugins", "codex-process-jobs")), false);
});
