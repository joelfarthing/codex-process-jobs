import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  DEV_PLUGIN_NAME,
  POLICY_BEGIN,
  POLICY_END,
  applyInstall,
  inspectPluginProviders,
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
  assert.equal(packageMetadata.name, "codex-process-jobs");
  assert.equal(pluginManifest.name, "codex-process-jobs");
  assert.equal(pluginManifest.interface.displayName, "Codex Process Jobs");
  assert.equal(fs.existsSync(path.join(ROOT, ".codex-plugin", "dev-install.json")), false);
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
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "fs.appendFileSync(process.env.MOCK_CODEX_CALLS, JSON.stringify(args) + '\\n');",
    "if (args[0] === '--version') { console.log('codex-cli test'); process.exit(0); }",
    "if (args[0] === 'plugin' && args[1] === 'add' && process.env.MOCK_CODEX_REPLACE_CACHE === '1') {",
    "  const pluginName = String(args[2]).split('@', 1)[0];",
    "  const source = path.join(process.env.HOME, 'plugins', pluginName);",
    "  const manifest = JSON.parse(fs.readFileSync(path.join(source, '.codex-plugin', 'plugin.json'), 'utf8'));",
    "  const cacheRoot = path.join(process.env.CODEX_HOME, 'plugins', 'cache', 'personal', pluginName);",
    "  fs.rmSync(cacheRoot, { recursive: true, force: true });",
    "  fs.mkdirSync(cacheRoot, { recursive: true });",
    "  fs.cpSync(source, path.join(cacheRoot, manifest.version), { recursive: true });",
    "  if (process.env.MOCK_CODEX_FAIL_PLUGIN_ADD === '1') {",
    "    process.stderr.write('simulated plugin add failure\\n');",
    "    process.exit(9);",
    "  }",
    "}",
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

function cacheRoot(home, pluginName = "codex-process-jobs") {
  return path.join(home, ".codex", "plugins", "cache", "personal", pluginName);
}

function seedProviderCache(home, provider, version, pluginName = "codex-process-jobs") {
  const generation = path.join(
    home,
    ".codex",
    "plugins",
    "cache",
    provider,
    pluginName,
    version
  );
  fs.mkdirSync(path.join(generation, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(path.join(generation, ".codex-plugin", "plugin.json"), `${JSON.stringify({
    name: pluginName,
    version,
  }, null, 2)}\n`);
  return generation;
}

function seedCacheGeneration(
  home,
  version,
  marker = version,
  pluginName = "codex-process-jobs"
) {
  const generation = path.join(cacheRoot(home, pluginName), version);
  fs.mkdirSync(path.join(generation, ".codex-plugin"), { recursive: true });
  fs.mkdirSync(path.join(generation, "skills", "start"), { recursive: true });
  fs.writeFileSync(path.join(generation, ".codex-plugin", "plugin.json"), `${JSON.stringify({
    name: pluginName,
    version,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(generation, "skills", "start", "SKILL.md"), `${marker}\n`);
  return generation;
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

test("detects distinct provider caches without treating historical generations as providers", (t) => {
  const home = temporaryHome(t);
  seedProviderCache(home, "personal", "0.2.0+codex.local-old");
  seedProviderCache(home, "personal", "0.2.1+codex.local-current");
  seedProviderCache(home, "openai-curated-remote", "0.2.1");

  assert.deepEqual(inspectPluginProviders(path.join(home, ".codex")), {
    status: "present",
    providers: ["openai-curated-remote", "personal"],
  });
});

test("preview warns when apply would create a second CPJ provider cache", (t) => {
  const home = temporaryHome(t);
  const env = installEnv(t, home);
  seedProviderCache(home, "openai-curated-remote", "0.2.1");

  const result = runInstaller(["--agent-policy", "none"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /multiple CPJ provider caches \(openai-curated-remote, personal\)/i);
  assert.match(result.stdout, /duplicate skill IDs can make routing nondeterministic/i);
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
  assert.match(preview.stdout, /review definitions and referenced source in \/hooks after every install or update/i);
  assert.match(preview.stdout, /approve any definition Codex marks new or changed/i);
  assert.equal(fs.existsSync(marketplaceFile), false);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.existsSync(agentFile), false);

  const applied = runInstaller(["--apply", "--agent-policy", "global"], env);
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, ".codex-plugin", "plugin.json"), "utf8")).name, "codex-process-jobs");
  assert.equal(JSON.parse(fs.readFileSync(marketplaceFile, "utf8")).plugins.length, 1);
  const agentPolicy = fs.readFileSync(agentFile, "utf8");
  assert.match(agentPolicy, /enabled CPJ start skill/i);
  assert.doesNotMatch(agentPolicy, /\$codex-process-jobs(?:-dev)?:start/);
  assert.match(agentPolicy, /servers\/watchers/i);
  assert.match(agentPolicy, /Classify workload, not wrapper latency/i);
  assert.match(agentPolicy, /Task skills own preflight\/correctness; CPJ owns lifecycle/i);
  assert.match(agentPolicy, /successful start is a hard turn boundary/i);
  assert.match(agentPolicy, /without status, tail, result, wait, sleep, `ps`, or other monitoring/i);
  assert.match(agentPolicy, /only an explicit request to keep that exact turn open permits one bounded wait/i);
  assert.match(agentPolicy, /follow selected CPJ skills/i);
  assert.ok(agentPolicy.split(/\s+/).filter(Boolean).length <= 140, "managed policy should stay compact");
  assert.match(applied.stdout, /installer never writes hook trust/i);
  assert.match(applied.stdout, /PostToolUse, Stop, and UserPromptSubmit/);
  assert.match(applied.stdout, /If Codex marks a definition new or changed, approve its exact hash/i);
  assert.match(applied.stdout, /if trust persists, verify that status/i);
  assert.match(applied.stdout, /review them in \/hooks after every install or update/i);
  assert.match(applied.stdout, /Restart every open Codex client/);
  assert.match(applied.stdout, /Developer: Reload Window/);
  assert.match(applied.stdout, /After the restart, start a fresh Codex task/);

  const calls = fs.readFileSync(env.MOCK_CODEX_CALLS, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(calls.some((args) => args[0] === "plugin" && args[1] === "add" && args[2] === "codex-process-jobs@personal"));
  assert.ok(calls.some((args) => args[0] === "features" && args[1] === "enable" && args[2] === "hooks"));
  assert.equal(calls.filter((args) => args[0] === "app-server").length, 0);
  assert.equal(calls.some((args) => args.includes("config/batchWrite")), false);
});

test("dev preview is read-only and names every isolated install surface", (t) => {
  const home = temporaryHome(t);
  const env = installEnv(t, home);
  const preview = runInstaller(["--dev", "--agent-policy", "none"], env);

  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Codex Process Jobs \(Dev\) installation preview/);
  assert.match(preview.stdout, /install identity: codex-process-jobs-dev \(isolated development\)/);
  assert.match(preview.stdout, /plugins\/codex-process-jobs-dev/);
  assert.match(preview.stdout, /\+codex\.dev-/);
  assert.match(preview.stdout, /\.codex\/process-jobs-dev/);
  assert.match(preview.stdout, /every production CPJ provider's skills and hooks disabled/i);
  assert.equal(fs.existsSync(path.join(home, "plugins", DEV_PLUGIN_NAME)), false);
  assert.equal(fs.existsSync(path.join(home, ".agents", "plugins", "marketplace.json")), false);
});

test("dev apply creates a distinct plugin, namespace, cache, and durable state root", (t) => {
  const home = temporaryHome(t);
  const env = {
    ...installEnv(t, home),
    MOCK_CODEX_REPLACE_CACHE: "1",
  };
  const marketplaceFile = path.join(home, ".agents", "plugins", "marketplace.json");
  fs.mkdirSync(path.dirname(marketplaceFile), { recursive: true });
  fs.writeFileSync(marketplaceFile, `${JSON.stringify(mergeMarketplace(null), null, 2)}\n`);

  const productionState = path.join(home, ".codex", "process-jobs");
  fs.mkdirSync(productionState, { recursive: true });
  fs.writeFileSync(path.join(productionState, "sentinel"), "production state\n");

  const result = runInstaller(["--dev", "--apply", "--agent-policy", "none"], env);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const destination = path.join(home, "plugins", DEV_PLUGIN_NAME);
  const manifest = JSON.parse(fs.readFileSync(
    path.join(destination, ".codex-plugin", "plugin.json"),
    "utf8"
  ));
  assert.equal(manifest.name, DEV_PLUGIN_NAME);
  assert.equal(manifest.interface.displayName, "Codex Process Jobs (Dev)");
  assert.equal(manifest.interface.shortDescription, "Local development build of durable process jobs");
  assert.match(manifest.version, /\+codex\.dev-/);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(
      path.join(destination, ".codex-plugin", "dev-install.json"),
      "utf8"
    )),
    {
      generated: true,
      sourcePlugin: "codex-process-jobs",
      installedPlugin: DEV_PLUGIN_NAME,
      stateDirectory: "process-jobs-dev",
    }
  );

  const marketplace = JSON.parse(fs.readFileSync(marketplaceFile, "utf8"));
  assert.deepEqual(
    marketplace.plugins.map((entry) => entry.name),
    ["codex-process-jobs", DEV_PLUGIN_NAME]
  );
  assert.equal(
    marketplace.plugins.find((entry) => entry.name === DEV_PLUGIN_NAME).source.path,
    "./plugins/codex-process-jobs-dev"
  );

  const calls = fs.readFileSync(env.MOCK_CODEX_CALLS, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(calls.some((args) =>
    args[0] === "plugin"
      && args[1] === "add"
      && args[2] === "codex-process-jobs-dev@personal"
  ));
  assert.equal(
    fs.existsSync(path.join(cacheRoot(home, DEV_PLUGIN_NAME), manifest.version)),
    true
  );

  const identity = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        `import { RUNTIME_PLUGIN_NAME, STATE_DIRECTORY_NAME, skillReference } from ${JSON.stringify(
          pathToFileURL(path.join(destination, "scripts", "plugin-identity.mjs")).href
        )};`,
        "console.log(JSON.stringify({",
        "  name: RUNTIME_PLUGIN_NAME,",
        "  state: STATE_DIRECTORY_NAME,",
        "  result: skillReference('result'),",
        "}));",
      ].join("\n"),
    ],
    { encoding: "utf8", env }
  );
  assert.equal(identity.status, 0, identity.stderr);
  assert.deepEqual(JSON.parse(identity.stdout), {
    name: DEV_PLUGIN_NAME,
    state: "process-jobs-dev",
    result: "$codex-process-jobs-dev:result",
  });

  const configure = spawnSync(
    process.execPath,
    [
      path.join(destination, "scripts", "job.mjs"),
      "config",
      "--notify-user",
      "true",
      "--json",
    ],
    { encoding: "utf8", env }
  );
  assert.equal(configure.status, 0, configure.stderr || configure.stdout);
  assert.equal(
    fs.existsSync(path.join(home, ".codex", "process-jobs-dev", "config.json")),
    true
  );
  assert.equal(
    fs.readFileSync(path.join(productionState, "sentinel"), "utf8"),
    "production state\n"
  );
  assert.equal(fs.existsSync(path.join(productionState, "config.json")), false);

  const devSnapshotInstall = spawnSync(
    process.execPath,
    [
      path.join(destination, "scripts", "install.mjs"),
      "--dev",
      "--agent-policy",
      "none",
    ],
    { cwd: destination, encoding: "utf8", env }
  );
  assert.equal(devSnapshotInstall.status, 1);
  assert.match(
    devSnapshotInstall.stderr,
    /Expected plugin name codex-process-jobs/,
    "a generated dev snapshot must never become an installer or release source"
  );
});

test("passes a shell-like marketplace name as one literal Codex argument", (t) => {
  const home = temporaryHome(t);
  const env = installEnv(t, home);
  const marketplaceFile = path.join(home, ".agents", "plugins", "marketplace.json");
  fs.mkdirSync(path.dirname(marketplaceFile), { recursive: true });
  fs.writeFileSync(marketplaceFile, `${JSON.stringify({
    name: "personal;printf-not-executed",
    interface: { displayName: "Test marketplace" },
    plugins: [],
  }, null, 2)}\n`);

  const result = runInstaller(["--apply", "--agent-policy", "none"], env);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const calls = fs.readFileSync(env.MOCK_CODEX_CALLS, "utf8").trim().split("\n").map(JSON.parse);
  const pluginAdd = calls.find((args) => args[0] === "plugin" && args[1] === "add");
  assert.deepEqual(pluginAdd, [
    "plugin",
    "add",
    "codex-process-jobs@personal;printf-not-executed",
    "--json",
  ]);
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

test("preserves every validated prior cache generation when Codex refreshes its cache", (t) => {
  const home = temporaryHome(t);
  const env = {
    ...installEnv(t, home),
    MOCK_CODEX_REPLACE_CACHE: "1",
  };
  const firstVersion = "0.1.0+codex.local-20260720-010101";
  const secondVersion = "0.1.0+codex.local-20260720-020202";
  const first = seedCacheGeneration(home, firstVersion, "first historical skill");
  const second = seedCacheGeneration(home, secondVersion, "second historical skill");

  const result = runInstaller(["--apply", "--agent-policy", "none"], env);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const installedManifest = JSON.parse(fs.readFileSync(
    path.join(home, "plugins", "codex-process-jobs", ".codex-plugin", "plugin.json"),
    "utf8"
  ));
  assert.equal(
    fs.readFileSync(path.join(first, "skills", "start", "SKILL.md"), "utf8"),
    "first historical skill\n"
  );
  assert.equal(
    fs.readFileSync(path.join(second, "skills", "start", "SKILL.md"), "utf8"),
    "second historical skill\n"
  );
  assert.equal(
    fs.existsSync(path.join(cacheRoot(home), installedManifest.version, "skills", "start", "SKILL.md")),
    true
  );
  assert.ok(result.stdout.includes(`Prior cache generations retained for open tasks: ${firstVersion}, ${secondVersion}`));
  assert.ok(result.stdout.includes(`Cache generations restored after refresh: ${firstVersion}, ${secondVersion}`));
});

test("restores prior cache generations and removes the failed new generation on rollback", (t) => {
  const home = temporaryHome(t);
  const env = {
    ...installEnv(t, home),
    MOCK_CODEX_REPLACE_CACHE: "1",
    MOCK_CODEX_FAIL_PLUGIN_ADD: "1",
  };
  const oldVersion = "0.1.0+codex.local-20260719-030303";
  const oldGeneration = seedCacheGeneration(home, oldVersion, "rollback survivor");

  const result = runInstaller(["--apply", "--agent-policy", "none"], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /simulated plugin add failure/);
  assert.equal(
    fs.readFileSync(path.join(oldGeneration, "skills", "start", "SKILL.md"), "utf8"),
    "rollback survivor\n"
  );
  assert.deepEqual(fs.readdirSync(cacheRoot(home)), [oldVersion]);
});

test("refuses malformed cache generations before making install changes", (t) => {
  const home = temporaryHome(t);
  const env = installEnv(t, home);
  const directoryVersion = "0.1.0+codex.local-20260718-040404";
  const generation = seedCacheGeneration(home, directoryVersion);
  fs.writeFileSync(path.join(generation, ".codex-plugin", "plugin.json"), `${JSON.stringify({
    name: "codex-process-jobs",
    version: "0.1.0+codex.local-wrong",
  })}\n`);

  const result = runInstaller(["--apply", "--agent-policy", "none"], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match manifest version/);
  assert.equal(fs.existsSync(path.join(home, "plugins", "codex-process-jobs")), false);
  assert.equal(fs.existsSync(generation), true);
});

test("refuses symlinks anywhere inside a cache generation", (t) => {
  const home = temporaryHome(t);
  const env = installEnv(t, home);
  const version = "0.1.0+codex.local-20260718-050505";
  const generation = seedCacheGeneration(home, version);
  fs.symlinkSync(path.join(generation, "skills", "start", "SKILL.md"), path.join(generation, "linked-skill"));

  const result = runInstaller(["--apply", "--agent-policy", "none"], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing symlinked plugin cache content/);
  assert.equal(fs.existsSync(path.join(home, "plugins", "codex-process-jobs")), false);
  assert.equal(fs.lstatSync(path.join(generation, "linked-skill")).isSymbolicLink(), true);
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
