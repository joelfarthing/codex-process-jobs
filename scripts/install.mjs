#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PLUGIN_NAME = "codex-process-jobs";
export const POLICY_BEGIN = "<!-- codex-process-jobs:begin -->";
export const POLICY_END = "<!-- codex-process-jobs:end -->";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_ENTRIES = [
  ".codex-plugin",
  "assets",
  "docs",
  "hooks",
  "skills",
  "scripts",
  "package.json",
  "README.md",
  "LICENSE",
  "NOTICE",
  "SECURITY.md",
];
const ACTIVE_STATUSES = new Set(["queued", "starting", "running", "cancelling"]);

function fail(message) {
  throw new Error(message);
}

function usage() {
  return [
    "Usage:",
    "  node scripts/install.mjs [--with-agent-policy]",
    "  node scripts/install.mjs --apply [--with-agent-policy] [--allow-active-jobs]",
    "",
    "The default is a read-only preview. --apply performs the displayed changes.",
    "--with-agent-policy installs an idempotent managed block in ~/.codex/AGENTS.md.",
    "--allow-active-jobs overrides the safety stop when tracked jobs are active.",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {
    apply: false,
    withAgentPolicy: false,
    allowActiveJobs: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === "--apply") options.apply = true;
    else if (arg === "--with-agent-policy") options.withAgentPolicy = true;
    else if (arg === "--allow-active-jobs") options.allowActiveJobs = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else fail(`Unknown installer option: ${arg}`);
  }
  return options;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Unable to read ${label} at ${file}: ${error.message}`);
  }
}

function validateManifest(manifest, file) {
  if (!manifest || typeof manifest !== "object") fail(`Missing plugin manifest: ${file}`);
  if (manifest.name !== PLUGIN_NAME) {
    fail(`Expected plugin name ${PLUGIN_NAME} in ${file}; found ${manifest.name ?? "(missing)"}.`);
  }
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    fail(`Plugin manifest has no version: ${file}`);
  }
  return manifest;
}

function resolveHome(env) {
  return path.resolve(env.CODEX_PROCESS_JOBS_INSTALL_HOME || env.HOME || os.homedir());
}

function cachebusterTimestamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-").replace("Z", "");
}

export function withCodexCachebuster(version, timestamp) {
  const base = String(version).split("+", 1)[0];
  return `${base}+codex.local-${timestamp}`;
}

function expectedMarketplaceEntry() {
  return {
    name: PLUGIN_NAME,
    source: {
      source: "local",
      path: `./plugins/${PLUGIN_NAME}`,
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Coding",
  };
}

export function mergeMarketplace(existing) {
  const marketplace = existing == null
    ? { name: "personal", interface: { displayName: "Personal" }, plugins: [] }
    : structuredClone(existing);

  if (!marketplace || typeof marketplace !== "object" || Array.isArray(marketplace)) {
    fail("Personal marketplace root must be a JSON object.");
  }
  if (typeof marketplace.name !== "string" || !marketplace.name.trim()) {
    fail("Personal marketplace must have a non-empty name.");
  }
  if (marketplace.interface == null) marketplace.interface = { displayName: "Personal" };
  if (!Array.isArray(marketplace.plugins)) fail("Personal marketplace plugins must be an array.");

  const matches = marketplace.plugins
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry?.name === PLUGIN_NAME);
  if (matches.length > 1) fail(`Personal marketplace has duplicate ${PLUGIN_NAME} entries.`);

  const expected = expectedMarketplaceEntry();
  if (matches.length === 0) {
    marketplace.plugins.push(expected);
  } else {
    const { entry, index } = matches[0];
    const currentPath = entry?.source?.path;
    const currentKind = entry?.source?.source;
    if (
      currentPath != null
      && (currentPath !== expected.source.path || currentKind !== expected.source.source)
    ) {
      fail(
        `Marketplace entry ${PLUGIN_NAME} already points to ${currentKind ?? "unknown"}:${currentPath}. `
        + "Refusing to replace a different source."
      );
    }
    marketplace.plugins[index] = {
      ...entry,
      ...expected,
      policy: { ...(entry.policy ?? {}), ...expected.policy },
    };
  }
  return marketplace;
}

function wrapPolicy(policyText) {
  const normalized = String(policyText).trim();
  if (!normalized) fail("Agent policy template is empty.");
  return `${POLICY_BEGIN}\n${normalized}\n${POLICY_END}`;
}

export function upsertAgentPolicy(existing, policyText) {
  const current = String(existing ?? "");
  const begin = current.indexOf(POLICY_BEGIN);
  const end = current.indexOf(POLICY_END);
  if ((begin >= 0) !== (end >= 0) || (begin >= 0 && end < begin)) {
    fail("Existing ~/.codex/AGENTS.md has an incomplete codex-process-jobs managed block.");
  }

  const block = wrapPolicy(policyText);
  if (begin >= 0) {
    const suffixStart = end + POLICY_END.length;
    return `${current.slice(0, begin)}${block}${current.slice(suffixStart)}`;
  }
  const prefix = current.trimEnd();
  return prefix ? `${prefix}\n\n${block}\n` : `${block}\n`;
}

function listActiveJobs(codexHome) {
  const jobsDir = path.join(codexHome, "process-jobs", "jobs");
  let entries;
  try {
    entries = fs.readdirSync(jobsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const active = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const job = JSON.parse(fs.readFileSync(path.join(jobsDir, entry.name), "utf8"));
      if (ACTIVE_STATUSES.has(job.status)) {
        active.push({ id: job.id ?? entry.name.replace(/\.json$/, ""), status: job.status, name: job.name ?? null });
      }
    } catch {}
  }
  return active;
}

function detectCodex(env) {
  const result = spawnSync("codex", ["--version"], {
    env,
    encoding: "utf8",
    shell: false,
  });
  if (result.error?.code === "ENOENT") return { available: false, version: null };
  if (result.error) throw result.error;
  return {
    available: result.status === 0,
    version: result.status === 0 ? result.stdout.trim() : null,
  };
}

export function resolveInstallPlan({ env = process.env, now = new Date(), sourceRoot = SOURCE_ROOT } = {}) {
  if (!(["darwin", "linux"].includes(process.platform))) {
    fail(`Unsupported platform: ${process.platform}. Use macOS or Linux.`);
  }
  const nodeMajor = Number.parseInt(process.versions.node.split(".", 1)[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 18) fail("Node.js 18 or newer is required.");

  const root = path.resolve(sourceRoot);
  const manifestFile = path.join(root, ".codex-plugin", "plugin.json");
  const manifest = validateManifest(readJson(manifestFile, "plugin manifest"), manifestFile);
  const home = resolveHome(env);
  const codexHome = path.resolve(env.CODEX_HOME || path.join(home, ".codex"));
  const timestamp = cachebusterTimestamp(now);
  return {
    sourceRoot: root,
    home,
    codexHome,
    destination: path.join(home, "plugins", PLUGIN_NAME),
    marketplaceFile: path.join(home, ".agents", "plugins", "marketplace.json"),
    agentFile: path.join(codexHome, "AGENTS.md"),
    agentPolicyFile: path.join(root, "assets", "agent-policy.md"),
    sourceVersion: manifest.version,
    installVersion: withCodexCachebuster(manifest.version, timestamp),
    timestamp,
    activeJobs: listActiveJobs(codexHome),
    codex: detectCodex(env),
  };
}

function planLines(plan, options) {
  const lines = [
    "Codex Process Jobs installation preview",
    `  source: ${plan.sourceRoot}`,
    `  plugin destination: ${plan.destination}`,
    `  plugin version: ${plan.installVersion}`,
    `  personal marketplace: ${plan.marketplaceFile}`,
    `  Codex CLI: ${plan.codex.available ? plan.codex.version : "not found"}`,
    "  completion hook: enable hooks, install plugin hook, and trust its current hash",
    `  global agent policy: ${options.withAgentPolicy ? `selected; update ${plan.agentFile}` : "not selected; ask the user whether to include the optional managed policy before apply"}`,
    `  active tracked jobs: ${plan.activeJobs.length}`,
  ];
  for (const job of plan.activeJobs) {
    lines.push(`    - ${job.id} [${job.status}]${job.name ? ` ${job.name}` : ""}`);
  }
  if (!options.apply) {
    lines.push(
      "",
      options.withAgentPolicy
        ? "Optional global agent policy selected for the apply step."
        : "Installing agent: ask the user whether they want the optional global AGENTS.md policy before applying.",
      "No changes made. Re-run with --apply after reviewing this plan."
    );
  }
  return lines;
}

function uniqueBackupPath(file, timestamp) {
  const base = `${file}.backup-${timestamp}`;
  return fs.existsSync(base) ? `${base}-${crypto.randomBytes(3).toString("hex")}` : base;
}

function atomicWrite(file, contents, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, contents, { encoding: "utf8", mode, flag: "wx" });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function restoreFile(file, original) {
  if (original == null) fs.rmSync(file, { force: true });
  else atomicWrite(file, original);
}

function copyPlugin(plan) {
  const parent = path.dirname(plan.destination);
  fs.mkdirSync(parent, { recursive: true });
  const stage = path.join(parent, `.${PLUGIN_NAME}.install-${process.pid}-${crypto.randomBytes(3).toString("hex")}`);
  fs.mkdirSync(stage, { mode: 0o700 });
  let destinationBackup = null;
  try {
    for (const entry of INSTALL_ENTRIES) {
      const source = path.join(plan.sourceRoot, entry);
      if (!fs.existsSync(source)) continue;
      fs.cpSync(source, path.join(stage, entry), { recursive: true, preserveTimestamps: true });
    }
    const stagedManifestFile = path.join(stage, ".codex-plugin", "plugin.json");
    const stagedManifest = validateManifest(readJson(stagedManifestFile, "staged plugin manifest"), stagedManifestFile);
    stagedManifest.version = plan.installVersion;
    atomicWrite(stagedManifestFile, `${JSON.stringify(stagedManifest, null, 2)}\n`);

    for (const script of ["job.mjs", "worker.mjs", "notifier.mjs", "install.mjs", "smoke.mjs"]) {
      const file = path.join(stage, "scripts", script);
      if (fs.existsSync(file)) fs.chmodSync(file, 0o755);
    }

    if (fs.existsSync(plan.destination)) {
      const currentManifestFile = path.join(plan.destination, ".codex-plugin", "plugin.json");
      validateManifest(readJson(currentManifestFile, "installed plugin manifest"), currentManifestFile);
      destinationBackup = uniqueBackupPath(plan.destination, plan.timestamp);
      fs.renameSync(plan.destination, destinationBackup);
    }
    fs.renameSync(stage, plan.destination);
    return destinationBackup;
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    if (!fs.existsSync(plan.destination) && destinationBackup && fs.existsSync(destinationBackup)) {
      fs.renameSync(destinationBackup, plan.destination);
    }
    throw error;
  }
}

function runCodexPluginAdd(marketplaceName, env) {
  const selector = `${PLUGIN_NAME}@${marketplaceName}`;
  const result = spawnSync("codex", ["plugin", "add", selector, "--json"], {
    env,
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`codex plugin add failed (${result.status}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return { selector, output: result.stdout.trim() };
}

function ensureHooksEnabled(env) {
  const result = spawnSync("codex", ["features", "enable", "hooks"], {
    env,
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`Unable to enable Codex hooks (${result.status}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

function callCodexAppServer({ cwd, env, method, params, timeoutMs = 15_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let settled = false;
    let stderr = "";
    const timeout = setTimeout(() => finish(reject, new Error(`Codex app-server timed out for ${method}.`)), timeoutMs);

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    function cleanup() {
      clearTimeout(timeout);
      lines.close();
      child.stdin.end();
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
    }
    function finish(handler, value) {
      if (settled) return;
      settled = true;
      cleanup();
      handler(value);
    }

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => finish(reject, error));
    child.on("exit", (code, signal) => {
      if (!settled) {
        finish(reject, new Error(
          `Codex app-server exited before ${method} responded (code=${code}, signal=${signal})${stderr.trim() ? `: ${stderr.trim()}` : ""}`
        ));
      }
    });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1) {
        if (message.error) {
          finish(reject, new Error(`Codex app-server initialize failed: ${JSON.stringify(message.error)}`));
          return;
        }
        send({ method: "initialized", params: {} });
        send({ id: 2, method, params });
      } else if (message.id === 2) {
        if (message.error) finish(reject, new Error(`${method} failed: ${JSON.stringify(message.error)}`));
        else finish(resolve, message.result);
      }
    });

    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex-process-jobs-installer",
          title: "Codex Process Jobs Installer",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

async function trustPluginHooks(plan, selector, env) {
  try {
    const listed = await callCodexAppServer({
      cwd: plan.destination,
      env,
      method: "hooks/list",
      params: { cwds: [plan.destination] },
    });
    const hooks = (Array.isArray(listed?.data) ? listed.data : [])
      .flatMap((entry) => Array.isArray(entry?.hooks) ? entry.hooks : [])
      .filter((hook) => hook?.source === "plugin" && hook?.pluginId === selector);
    if (hooks.length === 0) {
      return { ready: false, detail: "Codex did not report the installed plugin hook; open /hooks in a fresh task." };
    }
    const untrusted = hooks.filter((hook) =>
      ["untrusted", "modified"].includes(String(hook?.trustStatus ?? "").toLowerCase())
    );
    if (untrusted.length === 0) {
      return { ready: true, trusted: 0, detail: `${hooks.length} plugin hook(s) already trusted` };
    }
    if (untrusted.some((hook) => typeof hook.key !== "string" || !hook.currentHash)) {
      return { ready: false, detail: "Codex reported an untrusted hook without a writable trust key; open /hooks." };
    }

    const value = Object.fromEntries(untrusted.map((hook) => [
      hook.key,
      { trusted_hash: hook.currentHash },
    ]));
    await callCodexAppServer({
      cwd: plan.destination,
      env,
      method: "config/batchWrite",
      params: {
        edits: [{ keyPath: "hooks.state", value, mergeStrategy: "upsert" }],
        filePath: null,
        expectedVersion: null,
        reloadUserConfig: true,
      },
    });
    return { ready: true, trusted: untrusted.length, detail: `trusted ${untrusted.length} plugin hook(s)` };
  } catch (error) {
    return {
      ready: false,
      detail: `automatic hook trust failed: ${error instanceof Error ? error.message : String(error)}; open /hooks`,
    };
  }
}

export async function applyInstall(plan, options, env = process.env) {
  if (!plan.codex.available) fail("Codex CLI is not available on PATH.");
  if (plan.activeJobs.length > 0 && !options.allowActiveJobs) {
    fail("Tracked process jobs are active. Wait for them to finish, or review and pass --allow-active-jobs.");
  }

  const marketplaceOriginal = fs.existsSync(plan.marketplaceFile)
    ? fs.readFileSync(plan.marketplaceFile, "utf8")
    : null;
  const agentOriginal = fs.existsSync(plan.agentFile) ? fs.readFileSync(plan.agentFile, "utf8") : null;
  const configFile = path.join(plan.codexHome, "config.toml");
  const configOriginal = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : null;
  const marketplace = mergeMarketplace(marketplaceOriginal == null ? null : JSON.parse(marketplaceOriginal));
  const policyText = options.withAgentPolicy ? fs.readFileSync(plan.agentPolicyFile, "utf8") : null;
  const marketplaceBackup = marketplaceOriginal == null ? null : uniqueBackupPath(plan.marketplaceFile, plan.timestamp);
  const agentBackup = options.withAgentPolicy && agentOriginal != null
    ? uniqueBackupPath(plan.agentFile, plan.timestamp)
    : null;
  const configBackup = configOriginal != null ? uniqueBackupPath(configFile, plan.timestamp) : null;

  let destinationBackup = null;
  let marketplaceChanged = false;
  let agentChanged = false;
  let configMayHaveChanged = false;
  try {
    destinationBackup = copyPlugin(plan);
    if (marketplaceBackup) fs.copyFileSync(plan.marketplaceFile, marketplaceBackup);
    atomicWrite(plan.marketplaceFile, `${JSON.stringify(marketplace, null, 2)}\n`);
    marketplaceChanged = true;

    if (options.withAgentPolicy) {
      if (agentBackup) fs.copyFileSync(plan.agentFile, agentBackup);
      atomicWrite(plan.agentFile, upsertAgentPolicy(agentOriginal, policyText));
      agentChanged = true;
    }

    configMayHaveChanged = true;
    if (configBackup) fs.copyFileSync(configFile, configBackup);
    ensureHooksEnabled(env);
    const installed = runCodexPluginAdd(marketplace.name, env);
    const hookTrust = await trustPluginHooks(plan, installed.selector, env);
    return {
      selector: installed.selector,
      version: plan.installVersion,
      destination: plan.destination,
      destinationBackup,
      marketplaceFile: plan.marketplaceFile,
      marketplaceBackup,
      agentFile: options.withAgentPolicy ? plan.agentFile : null,
      agentBackup,
      configBackup,
      hookTrust,
    };
  } catch (error) {
    if (agentChanged) restoreFile(plan.agentFile, agentOriginal);
    if (marketplaceChanged) restoreFile(plan.marketplaceFile, marketplaceOriginal);
    if (configMayHaveChanged) restoreFile(configFile, configOriginal);
    if (fs.existsSync(plan.destination)) fs.rmSync(plan.destination, { recursive: true, force: true });
    if (destinationBackup && fs.existsSync(destinationBackup)) fs.renameSync(destinationBackup, plan.destination);
    throw error;
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const plan = resolveInstallPlan({ env });
  process.stdout.write(`${planLines(plan, options).join("\n")}\n`);
  if (!options.apply) return;
  const result = await applyInstall(plan, options, env);
  process.stdout.write([
    "",
    `Installed ${result.selector} (${result.version}).`,
    "Start a fresh Codex task before testing skill discovery.",
    result.destinationBackup ? `Previous plugin backup: ${result.destinationBackup}` : null,
    result.marketplaceBackup ? `Marketplace backup: ${result.marketplaceBackup}` : null,
    result.agentBackup ? `AGENTS.md backup: ${result.agentBackup}` : null,
    result.configBackup ? `Codex config backup: ${result.configBackup}` : null,
    `Completion hook: ${result.hookTrust.detail}`,
  ].filter(Boolean).join("\n") + "\n");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
