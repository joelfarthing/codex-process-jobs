#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { isCliEntry } from "./cli-entry.mjs";

export const PLUGIN_NAME = "codex-process-jobs";
export const DEV_PLUGIN_NAME = `${PLUGIN_NAME}-dev`;
export const POLICY_BEGIN = "<!-- codex-process-jobs:begin -->";
export const POLICY_END = "<!-- codex-process-jobs:end -->";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_ALLOWLIST_FILE = path.join(SOURCE_ROOT, "scripts", "runtime-files.json");

function validateSafeRelativePath(value) {
  if (typeof value !== "string" || !value || path.isAbsolute(value)) {
    fail(`Unsafe runtime allowlist path: ${String(value)}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    fail(`Unsafe runtime allowlist path: ${value}`);
  }
  return parts.join(path.sep);
}

function readRuntimeAllowlist() {
  const value = JSON.parse(fs.readFileSync(RUNTIME_ALLOWLIST_FILE, "utf8"));
  if (!Array.isArray(value?.files) || value.files.length === 0) {
    fail("Runtime allowlist files must be a non-empty array.");
  }
  if (!Array.isArray(value?.executables)) {
    fail("Runtime allowlist executables must be an array.");
  }
  const files = value.files.map((relative) => validateSafeRelativePath(relative));
  const executables = value.executables.map((relative) => validateSafeRelativePath(relative));
  if (new Set(files).size !== files.length) fail("Runtime allowlist files must be unique.");
  if (new Set(executables).size !== executables.length) fail("Runtime allowlist executables must be unique.");
  if (executables.some((relative) => !files.includes(relative))) {
    fail("Every runtime executable must also be a runtime file.");
  }
  return { files, executables: new Set(executables) };
}

const RUNTIME_ALLOWLIST = readRuntimeAllowlist();
const ACTIVE_STATUSES = new Set(["queued", "starting", "running", "cancelling"]);
const AGENT_POLICY_MODES = new Set(["global", "project", "none"]);

function fail(message) {
  throw new Error(message);
}

function usage() {
  return [
    "Usage:",
    "  node scripts/install.mjs [--dev] [--agent-policy <global|project|none>] [--project-root <path>]",
    "  node scripts/install.mjs --apply [--dev] --agent-policy <global|project|none> [--project-root <path>] [--allow-active-jobs]",
    "",
    "The default is a read-only preview. --apply performs the displayed changes.",
    "--agent-policy global installs an idempotent managed block in ~/.codex/AGENTS.md.",
    "--agent-policy project installs it in <project-root>/AGENTS.md.",
    "--agent-policy none leaves every AGENTS.md unchanged.",
    "--dev installs an isolated codex-process-jobs-dev snapshot without changing production identity.",
    "--with-agent-policy remains a deprecated alias for --agent-policy global.",
    "--allow-active-jobs overrides the safety stop when tracked jobs are active.",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {
    apply: false,
    agentPolicyMode: null,
    projectRoot: null,
    allowActiveJobs: false,
    dev: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--dev") options.dev = true;
    else if (arg === "--agent-policy") {
      const value = String(argv[++index] ?? "").trim().toLowerCase();
      if (!AGENT_POLICY_MODES.has(value)) {
        fail("--agent-policy must be one of: global, project, none.");
      }
      if (options.agentPolicyMode && options.agentPolicyMode !== value) {
        fail("Choose exactly one --agent-policy mode.");
      }
      options.agentPolicyMode = value;
    }
    else if (arg === "--project-root") {
      const value = String(argv[++index] ?? "").trim();
      if (!value) fail("--project-root requires a path.");
      if (options.projectRoot && options.projectRoot !== value) {
        fail("Specify --project-root only once.");
      }
      options.projectRoot = value;
    }
    else if (arg === "--with-agent-policy") {
      if (options.agentPolicyMode && options.agentPolicyMode !== "global") {
        fail("--with-agent-policy conflicts with the selected --agent-policy mode.");
      }
      options.agentPolicyMode = "global";
    }
    else if (arg === "--allow-active-jobs") options.allowActiveJobs = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else fail(`Unknown installer option: ${arg}`);
  }
  if (options.agentPolicyMode === "project" && !options.projectRoot) {
    fail("--agent-policy project requires --project-root <path>.");
  }
  if (options.agentPolicyMode !== "project" && options.projectRoot) {
    fail("--project-root is valid only with --agent-policy project.");
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

function validateManifest(manifest, file, expectedName = PLUGIN_NAME) {
  if (!manifest || typeof manifest !== "object") fail(`Missing plugin manifest: ${file}`);
  if (manifest.name !== expectedName) {
    fail(`Expected plugin name ${expectedName} in ${file}; found ${manifest.name ?? "(missing)"}.`);
  }
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    fail(`Plugin manifest has no version: ${file}`);
  }
  return manifest;
}

function validatePathComponent(value, label) {
  const component = String(value ?? "");
  if (!component || component === "." || component === ".." || path.basename(component) !== component) {
    fail(`Invalid ${label}: ${component || "(empty)"}.`);
  }
  return component;
}

function validateOwnedNode(file, label, expectedType = null) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) fail(`Refusing symlinked ${label}: ${file}`);
  if (expectedType === "directory" && !stat.isDirectory()) {
    fail(`Expected ${label} to be a directory: ${file}`);
  }
  if (expectedType === "file" && !stat.isFile()) {
    fail(`Expected ${label} to be a regular file: ${file}`);
  }
  if (!stat.isDirectory() && !stat.isFile()) {
    fail(`Refusing non-file ${label}: ${file}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    fail(`Refusing ${label} not owned by the current user: ${file}`);
  }
  return stat;
}

function validateOwnedTree(root, label) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = validateOwnedNode(current, label);
    if (!stat.isDirectory()) continue;
    for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
  }
}

function pluginCacheRoot(codexHome, marketplaceName, pluginName = PLUGIN_NAME) {
  const marketplace = validatePathComponent(marketplaceName, "marketplace name");
  const plugin = validatePathComponent(pluginName, "plugin name");
  return path.join(codexHome, "plugins", "cache", marketplace, plugin);
}

function validateCacheGeneration(generation, expectedVersion, pluginName = PLUGIN_NAME) {
  validatePathComponent(expectedVersion, "cache generation version");
  validateOwnedTree(generation, "plugin cache content");
  const manifestFile = path.join(generation, ".codex-plugin", "plugin.json");
  validateOwnedNode(manifestFile, "plugin cache manifest", "file");
  const manifest = validateManifest(
    readJson(manifestFile, "plugin cache manifest"),
    manifestFile,
    pluginName
  );
  if (manifest.version !== expectedVersion) {
    fail(
      `Plugin cache directory ${generation} does not match manifest version ${manifest.version}.`
    );
  }
  return manifest;
}

export function inspectPluginCache(codexHome, marketplaceName, pluginName = PLUGIN_NAME) {
  const cacheRoot = pluginCacheRoot(codexHome, marketplaceName, pluginName);
  try {
    let current = path.resolve(codexHome);
    try {
      validateOwnedNode(current, "plugin cache boundary", "directory");
    } catch (error) {
      if (error?.code === "ENOENT") return { status: "absent", versions: [] };
      throw error;
    }
    for (const component of [
      "plugins",
      "cache",
      validatePathComponent(marketplaceName, "marketplace name"),
      validatePathComponent(pluginName, "plugin name"),
    ]) {
      current = path.join(current, component);
      try {
        validateOwnedNode(current, "plugin cache boundary", "directory");
      } catch (error) {
        if (error?.code === "ENOENT") return { status: "absent", versions: [] };
        throw error;
      }
    }
    const entries = fs.readdirSync(cacheRoot, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    const versions = [];
    for (const entry of entries) {
      const version = validatePathComponent(entry.name, "cache generation version");
      const generation = path.join(cacheRoot, version);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        fail(`Refusing unexpected plugin cache entry: ${generation}`);
      }
      validateCacheGeneration(generation, version, pluginName);
      versions.push(version);
    }
    return { status: versions.length > 0 ? "present" : "absent", versions };
  } catch {
    return { status: "invalid", versions: [] };
  }
}

export function inspectPluginProviders(codexHome, pluginName = PLUGIN_NAME) {
  const cacheRoot = path.join(path.resolve(codexHome), "plugins", "cache");
  try {
    const rootStat = fs.lstatSync(cacheRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { status: "invalid", providers: [] };
    }

    const providers = [];
    for (const marketplaceEntry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
      let marketplaceName;
      try {
        marketplaceName = validatePathComponent(marketplaceEntry.name, "marketplace cache name");
      } catch {
        return { status: "invalid", providers: [] };
      }
      if (!marketplaceEntry.isDirectory() || marketplaceEntry.isSymbolicLink()) continue;

      const providerRoot = path.join(
        cacheRoot,
        marketplaceName,
        validatePathComponent(pluginName, "plugin name")
      );
      let providerStat;
      try {
        providerStat = fs.lstatSync(providerRoot);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        return { status: "invalid", providers: [] };
      }
      if (providerStat.isSymbolicLink() || !providerStat.isDirectory()) {
        return { status: "invalid", providers: [] };
      }

      let validGeneration = false;
      for (const generationEntry of fs.readdirSync(providerRoot, { withFileTypes: true })) {
        if (!generationEntry.isDirectory() || generationEntry.isSymbolicLink()) continue;
        const manifestFile = path.join(
          providerRoot,
          generationEntry.name,
          ".codex-plugin",
          "plugin.json"
        );
        try {
          const manifestStat = fs.lstatSync(manifestFile);
          if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) continue;
          const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
          if (
            manifest?.name === pluginName
            && typeof manifest.version === "string"
            && manifest.version === generationEntry.name
          ) {
            validGeneration = true;
            break;
          }
        } catch {}
      }
      if (validGeneration) providers.push(marketplaceName);
    }

    providers.sort((left, right) => left.localeCompare(right));
    return {
      status: providers.length > 0 ? "present" : "absent",
      providers,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "absent", providers: [] };
    return { status: "invalid", providers: [] };
  }
}

function snapshotPluginCache(codexHome, marketplaceName, pluginName = PLUGIN_NAME) {
  const cacheRoot = pluginCacheRoot(codexHome, marketplaceName, pluginName);
  if (!fs.existsSync(cacheRoot)) {
    return { cacheRoot, pluginName, temporaryRoot: null, versions: [] };
  }
  validateOwnedNode(cacheRoot, "plugin cache root", "directory");

  const entries = fs.readdirSync(cacheRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${pluginName}-cache-`));
  fs.chmodSync(temporaryRoot, 0o700);
  const versions = [];
  try {
    for (const entry of entries) {
      const version = validatePathComponent(entry.name, "cache generation version");
      const generation = path.join(cacheRoot, version);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        fail(`Refusing unexpected plugin cache entry: ${generation}`);
      }
      validateCacheGeneration(generation, version, pluginName);
      fs.cpSync(generation, path.join(temporaryRoot, version), {
        recursive: true,
        preserveTimestamps: true,
        dereference: false,
        verbatimSymlinks: true,
      });
      versions.push(version);
    }
    return { cacheRoot, pluginName, temporaryRoot, versions };
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function restorePluginCache(snapshot) {
  if (!snapshot || snapshot.versions.length === 0) return [];
  if (fs.existsSync(snapshot.cacheRoot)) {
    validateOwnedNode(snapshot.cacheRoot, "plugin cache root", "directory");
  } else {
    fs.mkdirSync(snapshot.cacheRoot, { recursive: true, mode: 0o700 });
  }

  const restored = [];
  for (const version of snapshot.versions) {
    const target = path.join(snapshot.cacheRoot, version);
    if (fs.existsSync(target)) {
      validateCacheGeneration(target, version, snapshot.pluginName);
      continue;
    }
    const source = path.join(snapshot.temporaryRoot, version);
    validateCacheGeneration(source, version, snapshot.pluginName);
    const stage = path.join(
      snapshot.cacheRoot,
      `.restore-${process.pid}-${crypto.randomBytes(3).toString("hex")}`
    );
    try {
      fs.cpSync(source, stage, {
        recursive: true,
        preserveTimestamps: true,
        dereference: false,
        verbatimSymlinks: true,
      });
      fs.renameSync(stage, target);
      restored.push(version);
    } catch (error) {
      fs.rmSync(stage, { recursive: true, force: true });
      throw error;
    }
  }
  return restored;
}

function removeNewCacheGeneration(snapshot, version) {
  if (!snapshot || snapshot.versions.includes(version)) return;
  const target = path.join(snapshot.cacheRoot, validatePathComponent(version, "plugin version"));
  if (!fs.existsSync(target)) return;
  validateCacheGeneration(target, version, snapshot.pluginName);
  fs.rmSync(target, { recursive: true, force: true });
}

function cleanupPluginCacheSnapshot(snapshot) {
  if (snapshot?.temporaryRoot) {
    fs.rmSync(snapshot.temporaryRoot, { recursive: true, force: true });
  }
}

function resolveHome(env) {
  return path.resolve(env.CODEX_PROCESS_JOBS_INSTALL_HOME || env.HOME || os.homedir());
}

function cachebusterTimestamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-").replace("Z", "");
}

export function withCodexCachebuster(version, timestamp, channel = "local") {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(channel)) fail(`Invalid cachebuster channel: ${channel}.`);
  const base = String(version).split("+", 1)[0];
  return `${base}+codex.${channel}-${timestamp}`;
}

export function resolveInstallIdentity(dev = false) {
  return dev
    ? {
        development: true,
        pluginName: DEV_PLUGIN_NAME,
        displayName: "Codex Process Jobs (Dev)",
        stateDirectory: "process-jobs-dev",
        cachebusterChannel: "dev",
      }
    : {
        development: false,
        pluginName: PLUGIN_NAME,
        displayName: "Codex Process Jobs",
        stateDirectory: "process-jobs",
        cachebusterChannel: "local",
      };
}

function canonicalPath(file) {
  const resolved = path.resolve(file);
  try {
    return fs.realpathSync.native(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") return resolved;
    throw error;
  }
}

export function sourceConflictsWithDestination(sourceRoot, destination) {
  return canonicalPath(sourceRoot) === canonicalPath(destination);
}

function expectedMarketplaceEntry(pluginName = PLUGIN_NAME) {
  const name = validatePathComponent(pluginName, "plugin name");
  return {
    name,
    source: {
      source: "local",
      path: `./plugins/${name}`,
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Coding",
  };
}

export function mergeMarketplace(existing, pluginName = PLUGIN_NAME) {
  const name = validatePathComponent(pluginName, "plugin name");
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
    .filter(({ entry }) => entry?.name === name);
  if (matches.length > 1) fail(`Personal marketplace has duplicate ${name} entries.`);

  const expected = expectedMarketplaceEntry(name);
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
        `Marketplace entry ${name} already points to ${currentKind ?? "unknown"}:${currentPath}. `
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
    fail("Existing AGENTS.md has an incomplete codex-process-jobs managed block.");
  }

  const block = wrapPolicy(policyText);
  if (begin >= 0) {
    const suffixStart = end + POLICY_END.length;
    return `${current.slice(0, begin)}${block}${current.slice(suffixStart)}`;
  }
  const prefix = current.trimEnd();
  return prefix ? `${prefix}\n\n${block}\n` : `${block}\n`;
}

function listActiveJobs(codexHome, stateDirectory = "process-jobs") {
  const jobsDir = path.join(
    codexHome,
    validatePathComponent(stateDirectory, "state directory"),
    "jobs"
  );
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

export function resolveInstallPaths({
  env = process.env,
  sourceRoot = SOURCE_ROOT,
  dev = false,
} = {}) {
  if (!(["darwin", "linux"].includes(process.platform))) {
    fail(`Unsupported platform: ${process.platform}. Use macOS or Linux.`);
  }
  const nodeMajor = Number.parseInt(process.versions.node.split(".", 1)[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 18) fail("Node.js 18 or newer is required.");

  const root = path.resolve(sourceRoot);
  const manifestFile = path.join(root, ".codex-plugin", "plugin.json");
  const manifest = validateManifest(readJson(manifestFile, "plugin manifest"), manifestFile);
  const identity = resolveInstallIdentity(dev);
  const home = resolveHome(env);
  const codexHome = path.resolve(env.CODEX_HOME || path.join(home, ".codex"));
  const destination = path.join(home, "plugins", identity.pluginName);
  return {
    ...identity,
    sourceRoot: root,
    home,
    codexHome,
    destination,
    sourceDestinationConflict: sourceConflictsWithDestination(root, destination),
    marketplaceFile: path.join(home, ".agents", "plugins", "marketplace.json"),
    agentFile: path.join(codexHome, "AGENTS.md"),
    globalAgentFile: path.join(codexHome, "AGENTS.md"),
    agentPolicyFile: path.join(root, "assets", "agent-policy.md"),
    sourceVersion: manifest.version,
  };
}

export function resolveInstallPlan({
  env = process.env,
  now = new Date(),
  sourceRoot = SOURCE_ROOT,
  dev = false,
} = {}) {
  const paths = resolveInstallPaths({ env, sourceRoot, dev });
  const timestamp = cachebusterTimestamp(now);
  return {
    ...paths,
    installVersion: withCodexCachebuster(
      paths.sourceVersion,
      timestamp,
      paths.cachebusterChannel
    ),
    timestamp,
    activeJobs: listActiveJobs(paths.codexHome, paths.stateDirectory),
    codex: detectCodex(env),
    pluginProviders: inspectPluginProviders(paths.codexHome, paths.pluginName),
    counterpartProviders: inspectPluginProviders(
      paths.codexHome,
      paths.development ? PLUGIN_NAME : DEV_PLUGIN_NAME
    ),
  };
}

function resolveProjectRoot(projectRoot) {
  const requested = path.resolve(projectRoot);
  let resolved;
  try {
    resolved = fs.realpathSync.native(requested);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`Project root does not exist: ${requested}`);
    throw error;
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`Project root is not a real directory: ${requested}`);
  }
  return resolved;
}

export function resolveAgentPolicySelection(plan, options) {
  const mode = options.agentPolicyMode ?? null;
  if (mode == null) return { mode: null, target: null, projectRoot: null };
  if (!AGENT_POLICY_MODES.has(mode)) fail(`Invalid agent-policy mode: ${String(mode)}.`);
  if (mode === "none") return { mode, target: null, projectRoot: null };
  if (mode === "global") {
    return { mode, target: plan.globalAgentFile ?? plan.agentFile, projectRoot: null };
  }
  if (!options.projectRoot) fail("--agent-policy project requires --project-root <path>.");
  const projectRoot = resolveProjectRoot(options.projectRoot);
  return { mode, target: path.join(projectRoot, "AGENTS.md"), projectRoot };
}

function planLines(plan, options) {
  const policy = resolveAgentPolicySelection(plan, options);
  let plannedMarketplaceName = "personal";
  try {
    const existingMarketplace = readJson(plan.marketplaceFile, "personal marketplace");
    if (existingMarketplace != null) {
      plannedMarketplaceName = validatePathComponent(
        existingMarketplace.name,
        "personal marketplace name"
      );
    }
  } catch {
    plannedMarketplaceName = null;
  }
  const currentProviders = plan.pluginProviders?.providers ?? [];
  const postInstallProviders = plannedMarketplaceName == null
    ? currentProviders
    : [...new Set([...currentProviders, plannedMarketplaceName])]
      .sort((left, right) => left.localeCompare(right));
  let policyLine;
  if (policy.mode === "global") policyLine = `global; update ${policy.target}`;
  else if (policy.mode === "project") policyLine = `project; update ${policy.target}`;
  else if (policy.mode === "none") policyLine = "none; leave every AGENTS.md unchanged";
  else policyLine = "not selected; choose global, project, or none before apply";
  const lines = [
    `${plan.displayName} installation preview`,
    `  install identity: ${plan.pluginName} (${plan.development ? "isolated development" : "production"})`,
    `  source: ${plan.sourceRoot}`,
    `  plugin destination: ${plan.destination}`,
    `  plugin version: ${plan.installVersion}`,
    `  durable state: ${path.join(plan.codexHome, plan.stateDirectory)}`,
    `  personal marketplace: ${plan.marketplaceFile}`,
    `  current ${plan.pluginName} provider caches: ${
      plan.pluginProviders?.status === "invalid"
        ? "invalid"
        : currentProviders.join(", ") || "none"
    }`,
    `  Codex CLI: ${plan.codex.available ? plan.codex.version : "not found"}`,
    "  lifecycle hooks: enable hooks and install PreToolUse, PostToolUse, Stop, and UserPromptSubmit definitions; review definitions and referenced source in /hooks after every install or update, and approve any definition Codex marks new or changed",
    "  open-task compatibility: preserve validated prior CPJ cache generations across plugin refresh",
    plan.sourceDestinationConflict
      ? "  source safety: BLOCKED - source checkout is the runtime destination"
      : "  source safety: source checkout is separate from the runtime destination",
    "  client refresh: restart open Codex clients after apply; VS Code requires Developer: Reload Window",
    `  agent policy: ${policyLine}`,
    `  active tracked jobs: ${plan.activeJobs.length}`,
  ];
  if (plan.development) {
    const productionProviders = plan.counterpartProviders?.providers ?? [];
    lines.push(
      `  production CPJ remains separate: ${
        plan.counterpartProviders?.status === "invalid"
          ? "provider caches could not be validated"
          : productionProviders.join(", ") || "no cached provider found"
      }`,
      "  coexistence rule: keep every production CPJ provider's skills and hooks disabled while behavioral tests use the Dev skills and hooks"
    );
  }
  if (postInstallProviders.length > 1) {
    lines.push(
      `  routing warning: applying this install would leave multiple CPJ provider caches (${postInstallProviders.join(", ")}); verify that only one provider is enabled because duplicate skill IDs can make routing nondeterministic`
    );
  } else if (plan.pluginProviders?.status === "invalid") {
    lines.push(
      "  routing warning: CPJ provider caches could not be validated; inspect plugin state before applying"
    );
  }
  for (const job of plan.activeJobs) {
    lines.push(`    - ${job.id} [${job.status}]${job.name ? ` ${job.name}` : ""}`);
  }
  if (!options.apply) {
    lines.push(
      "",
      policy.mode
        ? `Agent-policy choice selected for the apply step: ${policy.mode}.`
        : "Installing agent: ask the user to choose global AGENTS.md, one project AGENTS.md, or no AGENTS.md policy.",
      "No changes made. Re-run with --apply after reviewing this plan."
    );
  } else if (!policy.mode) {
    lines.push("", "Apply is blocked until --agent-policy global, project, or none is explicit.");
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

function restoreFile(file, original, mode = 0o600) {
  if (original == null) fs.rmSync(file, { force: true });
  else atomicWrite(file, original, mode);
}

function existingFileMode(file, fallback) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function validateMutableFile(file, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(`Refusing to modify ${label} because it is not a regular file: ${file}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    fail(`Refusing to modify ${label} because it is not owned by the current user: ${file}`);
  }
}

function copyPlugin(plan) {
  const parent = path.dirname(plan.destination);
  fs.mkdirSync(parent, { recursive: true });
  const stage = path.join(
    parent,
    `.${plan.pluginName}.install-${process.pid}-${crypto.randomBytes(3).toString("hex")}`
  );
  fs.mkdirSync(stage, { mode: 0o700 });
  let destinationBackup = null;
  try {
    for (const relative of RUNTIME_ALLOWLIST.files) {
      const source = path.join(plan.sourceRoot, relative);
      const sourceStat = fs.lstatSync(source);
      if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
        fail(`Runtime source must be a regular non-symlink file: ${source}`);
      }
      const destination = path.join(stage, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, RUNTIME_ALLOWLIST.executables.has(relative) ? 0o755 : 0o644);
    }
    const stagedManifestFile = path.join(stage, ".codex-plugin", "plugin.json");
    const devMarkerFile = path.join(stage, ".codex-plugin", "dev-install.json");
    const stagedManifest = validateManifest(readJson(stagedManifestFile, "staged plugin manifest"), stagedManifestFile);
    stagedManifest.name = plan.pluginName;
    stagedManifest.version = plan.installVersion;
    if (plan.development) {
      stagedManifest.description = "LOCAL DEVELOPMENT BUILD of Codex Process Jobs.";
      stagedManifest.interface = {
        ...(stagedManifest.interface ?? {}),
        displayName: plan.displayName,
        shortDescription: "Local development build of durable process jobs",
      };
      atomicWrite(
        devMarkerFile,
        `${JSON.stringify({
          generated: true,
          sourcePlugin: PLUGIN_NAME,
          installedPlugin: plan.pluginName,
          stateDirectory: plan.stateDirectory,
        }, null, 2)}\n`
      );
    } else if (fs.existsSync(devMarkerFile)) {
      fail("Refusing a production install from a transformed development snapshot.");
    }
    atomicWrite(stagedManifestFile, `${JSON.stringify(stagedManifest, null, 2)}\n`);

    if (fs.existsSync(plan.destination)) {
      const currentManifestFile = path.join(plan.destination, ".codex-plugin", "plugin.json");
      validateManifest(
        readJson(currentManifestFile, "installed plugin manifest"),
        currentManifestFile,
        plan.pluginName
      );
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

function runCodexPluginAdd(pluginName, marketplaceName, env) {
  const plugin = validatePathComponent(pluginName, "plugin name");
  const marketplace = validatePathComponent(marketplaceName, "marketplace name");
  const selector = [plugin, marketplace].join("@");
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

export async function applyInstall(plan, options, env = process.env) {
  if (plan.sourceDestinationConflict) {
    fail(
      `Refusing to replace the source checkout at ${plan.sourceRoot}. `
      + `Move or clone the repository outside ${plan.destination}, then run the installer from that checkout.`
    );
  }
  if (!plan.codex.available) fail("Codex CLI is not available on PATH.");
  const policy = resolveAgentPolicySelection(plan, options);
  if (!policy.mode) {
    fail("Apply requires an explicit --agent-policy global, project, or none choice.");
  }
  if (plan.activeJobs.length > 0 && !options.allowActiveJobs) {
    fail("Tracked process jobs are active. Wait for them to finish, or review and pass --allow-active-jobs.");
  }

  const configFile = path.join(plan.codexHome, "config.toml");
  validateMutableFile(plan.marketplaceFile, "personal marketplace");
  validateMutableFile(configFile, "Codex configuration");
  if (policy.target) validateMutableFile(policy.target, `${policy.mode} agent policy`);

  const marketplaceOriginal = fs.existsSync(plan.marketplaceFile)
    ? fs.readFileSync(plan.marketplaceFile, "utf8")
    : null;
  const agentOriginal = policy.target && fs.existsSync(policy.target)
    ? fs.readFileSync(policy.target, "utf8")
    : null;
  const agentMode = policy.target
    ? existingFileMode(policy.target, policy.mode === "project" ? 0o644 : 0o600)
    : null;
  const configOriginal = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : null;
  const marketplace = mergeMarketplace(
    marketplaceOriginal == null ? null : JSON.parse(marketplaceOriginal),
    plan.pluginName
  );
  const policyText = policy.target ? fs.readFileSync(plan.agentPolicyFile, "utf8") : null;
  const marketplaceBackup = marketplaceOriginal == null ? null : uniqueBackupPath(plan.marketplaceFile, plan.timestamp);
  const agentBackup = policy.target && agentOriginal != null
    ? uniqueBackupPath(policy.target, plan.timestamp)
    : null;
  const configBackup = configOriginal != null ? uniqueBackupPath(configFile, plan.timestamp) : null;
  const cacheSnapshot = snapshotPluginCache(
    plan.codexHome,
    marketplace.name,
    plan.pluginName
  );

  let destinationBackup = null;
  let marketplaceChanged = false;
  let agentChanged = false;
  let configMayHaveChanged = false;
  let pluginAddAttempted = false;
  try {
    destinationBackup = copyPlugin(plan);
    if (marketplaceBackup) fs.copyFileSync(plan.marketplaceFile, marketplaceBackup);
    atomicWrite(plan.marketplaceFile, `${JSON.stringify(marketplace, null, 2)}\n`);
    marketplaceChanged = true;

    if (policy.target) {
      if (agentBackup) fs.copyFileSync(policy.target, agentBackup);
      atomicWrite(policy.target, upsertAgentPolicy(agentOriginal, policyText), agentMode);
      agentChanged = true;
    }

    configMayHaveChanged = true;
    if (configBackup) fs.copyFileSync(configFile, configBackup);
    ensureHooksEnabled(env);
    pluginAddAttempted = true;
    const installed = runCodexPluginAdd(plan.pluginName, marketplace.name, env);
    const restoredCacheVersions = restorePluginCache(cacheSnapshot);
    return {
      selector: installed.selector,
      version: plan.installVersion,
      destination: plan.destination,
      destinationBackup,
      marketplaceFile: plan.marketplaceFile,
      marketplaceBackup,
      agentPolicyMode: policy.mode,
      agentFile: policy.target,
      agentBackup,
      configBackup,
      preservedCacheVersions: cacheSnapshot.versions,
      restoredCacheVersions,
    };
  } catch (error) {
    let cacheRollbackError = null;
    try {
      if (pluginAddAttempted) removeNewCacheGeneration(cacheSnapshot, plan.installVersion);
      restorePluginCache(cacheSnapshot);
    } catch (rollbackError) {
      cacheRollbackError = rollbackError;
    }
    if (agentChanged) restoreFile(policy.target, agentOriginal, agentMode);
    if (marketplaceChanged) restoreFile(plan.marketplaceFile, marketplaceOriginal);
    if (configMayHaveChanged) restoreFile(configFile, configOriginal);
    if (fs.existsSync(plan.destination)) fs.rmSync(plan.destination, { recursive: true, force: true });
    if (destinationBackup && fs.existsSync(destinationBackup)) fs.renameSync(destinationBackup, plan.destination);
    if (cacheRollbackError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} `
        + `Plugin cache rollback also failed: ${cacheRollbackError.message}`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    cleanupPluginCacheSnapshot(cacheSnapshot);
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const plan = resolveInstallPlan({ env, dev: options.dev });
  process.stdout.write(`${planLines(plan, options).join("\n")}\n`);
  if (!options.apply) return;
  const result = await applyInstall(plan, options, env);
  process.stdout.write([
    "",
    `Installed ${result.selector} (${result.version}).`,
    "Restart every open Codex client before testing this install.",
    "VS Code: run Developer: Reload Window. Codex App and CLI: quit and restart the client.",
    `After restart, open /hooks and review the ${result.selector} PreToolUse, PostToolUse, Stop, and UserPromptSubmit definitions and referenced shared source. If Codex marks a definition new or changed, approve its exact hash; if trust persists, verify that status. The installer never writes hook trust.`,
    "After the restart, start a fresh Codex task before testing skill discovery or completion hooks.",
    result.destinationBackup ? `Previous plugin backup: ${result.destinationBackup}` : null,
    result.marketplaceBackup ? `Marketplace backup: ${result.marketplaceBackup}` : null,
    result.agentBackup ? `AGENTS.md backup: ${result.agentBackup}` : null,
    result.configBackup ? `Codex config backup: ${result.configBackup}` : null,
    result.preservedCacheVersions.length > 0
      ? `Prior cache generations retained for open tasks: ${result.preservedCacheVersions.join(", ")}`
      : "Prior cache generations retained for open tasks: none found.",
    result.restoredCacheVersions.length > 0
      ? `Cache generations restored after refresh: ${result.restoredCacheVersions.join(", ")}`
      : null,
    result.agentPolicyMode === "none" ? "AGENTS.md policy: none selected; no AGENTS.md was changed." : null,
    "Completion hooks: installed; review them in /hooks after every install or update and approve any definition Codex marks new or changed.",
  ].filter(Boolean).join("\n") + "\n");
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
