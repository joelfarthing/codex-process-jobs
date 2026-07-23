#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isCliEntry } from "./cli-entry.mjs";
import {
  inspectPluginCache,
  main as runInstaller,
  resolveInstallPaths,
  resolveInstallPlan,
} from "./install.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_FILE = path.join(ROOT, "package.json");
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;

function readPackage() {
  return JSON.parse(fs.readFileSync(PACKAGE_FILE, "utf8"));
}

function usage() {
  return [
    "Usage:",
    "  codex-process-jobs install [installer options]",
    "  codex-process-jobs update [installer options]",
    "  codex-process-jobs doctor [--provenance]",
    "  codex-process-jobs version",
    "",
    "Install and update are preview-only unless --apply is supplied.",
    "Applying requires --agent-policy global, project, or none.",
    "Homebrew supplies the immutable release version used for both preview and apply.",
  ].join("\n");
}

function readInstalledVersion(destination) {
  const manifestFile = path.join(destination, ".codex-plugin", "plugin.json");
  try {
    const stat = fs.lstatSync(manifestFile);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Installed manifest is not a regular file: ${manifestFile}`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (manifest.name !== "codex-process-jobs" || typeof manifest.version !== "string") {
      throw new Error(`Installed manifest is invalid: ${manifestFile}`);
    }
    return manifest.version;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function baseVersion(version) {
  return String(version).split("+", 1)[0];
}

function repositorySlug(repository) {
  const value = typeof repository === "string" ? repository : repository?.url;
  const match = String(value ?? "").match(
    /^(?:git\+)?(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/
  );
  return match ? match[1] : null;
}

function commandSourceKind(plan) {
  if (plan.sourceDestinationConflict) return "runtime snapshot";
  try {
    const gitMetadata = path.join(ROOT, ".git");
    const stat = fs.lstatSync(gitMetadata);
    if (stat.isSymbolicLink()) return "release package";
    let gitDirectory = gitMetadata;
    if (stat.isFile()) {
      if (stat.size > 4096) return "release package";
      const match = fs.readFileSync(gitMetadata, "utf8").trim().match(/^gitdir:\s*(.+)$/);
      if (!match) return "release package";
      gitDirectory = path.resolve(ROOT, match[1]);
      const gitDirectoryStat = fs.lstatSync(gitDirectory);
      if (gitDirectoryStat.isSymbolicLink() || !gitDirectoryStat.isDirectory()) {
        return "release package";
      }
    } else if (!stat.isDirectory()) {
      return "release package";
    }
    const head = fs.lstatSync(path.join(gitDirectory, "HEAD"));
    if (!head.isSymbolicLink() && head.isFile()) {
      return "development checkout";
    }
  } catch {}
  return "release package";
}

function marketplaceIdentity(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return { status: "invalid", name: null };
    const marketplace = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      typeof marketplace?.name !== "string"
      || !marketplace.name
      || marketplace.name === "."
      || marketplace.name === ".."
      || path.basename(marketplace.name) !== marketplace.name
      || !Array.isArray(marketplace.plugins)
    ) {
      return { status: "invalid", name: null };
    }
    const matches = marketplace.plugins.filter(
      (candidate) => candidate?.name === "codex-process-jobs"
    );
    if (matches.length > 1) {
      return { status: "invalid", name: null };
    }
    if (matches.length === 0) return { status: "absent", name: null };
    const [candidate] = matches;
    if (
      candidate?.source?.source !== "local"
      || candidate?.source?.path !== "./plugins/codex-process-jobs"
    ) {
      return { status: "invalid", name: null };
    }
    return { status: "present", name: marketplace.name };
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "absent", name: null };
    return { status: "invalid", name: null };
  }
}

function inspectCache(plan) {
  const marketplace = marketplaceIdentity(plan.marketplaceFile);
  if (marketplace.status === "invalid") return { status: "invalid", generations: [] };
  if (marketplace.status === "absent") return { status: "absent", generations: [] };
  const cache = inspectPluginCache(plan.codexHome, marketplace.name);
  if (
    cache.status === "present"
    && cache.versions.some((version) => !SAFE_VERSION_PATTERN.test(version))
  ) {
    return { status: "invalid", generations: [] };
  }
  return { status: cache.status, generations: cache.versions };
}

function inspectRuntime(destination) {
  try {
    const stat = fs.lstatSync(destination);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return { status: "invalid", version: null };
    }
    const version = readInstalledVersion(destination);
    if (version == null) return { status: "absent", version: null };
    if (!SAFE_VERSION_PATTERN.test(version)) {
      return { status: "invalid", version: null };
    }
    return { status: "present", version };
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "absent", version: null };
    return { status: "invalid", version: null };
  }
}

function runProvenanceDoctor(metadata, plan, runtimeSnapshot) {
  const sourceKind = commandSourceKind(plan);
  const cache = inspectCache(plan);
  const repository = repositorySlug(metadata.repository);
  const runtime = runtimeSnapshot.status === "present"
    ? `present (${runtimeSnapshot.version})`
    : runtimeSnapshot.status;
  const cacheSummary = cache.status === "present"
    ? `present (${cache.generations.length} validated generation${cache.generations.length === 1 ? "" : "s"})`
    : cache.status;
  const displayedGenerations = cache.generations.length <= 20
    ? cache.generations.join(", ")
    : `${cache.generations.slice(0, 20).join(", ")} (${cache.generations.length - 20} more omitted)`;
  const lines = [
    "Codex Process Jobs provenance",
    `  command source: ${sourceKind}`,
    `  release version: ${metadata.version}`,
    `  runtime snapshot: ${runtime}`,
    `  plugin cache: ${cacheSummary}`,
    `  cache generations: ${displayedGenerations || "none"}`,
    `  upstream repository: ${repository ?? "not declared"}`,
    `  editable checkout: ${
      sourceKind === "development checkout"
        ? "current command source"
        : "current command source is not an editable checkout; other checkouts were not searched"
    }`,
    "  local paths: redacted",
    "",
    "Provenance is read-only and made no changes.",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function runDoctor(env, { provenance = false } = {}) {
  if (provenance) {
    let metadata;
    let plan;
    try {
      metadata = readPackage();
      if (!SAFE_VERSION_PATTERN.test(metadata?.version)) {
        throw new Error("Invalid release version.");
      }
      plan = resolveInstallPaths({ env });
    } catch {
      throw new Error("Unable to inspect provenance: command source is invalid.");
    }
    runProvenanceDoctor(metadata, plan, inspectRuntime(plan.destination));
    return;
  }
  const metadata = readPackage();
  const plan = resolveInstallPlan({ env });
  const installedVersion = readInstalledVersion(plan.destination);
  const status = installedVersion == null
    ? "not installed"
    : baseVersion(installedVersion) === metadata.version
      ? "current"
      : `update available (${baseVersion(installedVersion)} -> ${metadata.version})`;
  const lines = [
    "Codex Process Jobs doctor",
    `  release version: ${metadata.version}`,
    `  installed version: ${installedVersion ?? "not installed"}`,
    `  installation status: ${status}`,
    `  plugin destination: ${plan.destination}`,
    `  personal marketplace: ${fs.existsSync(plan.marketplaceFile) ? "present" : "not present"}`,
    `  Codex CLI: ${plan.codex.available ? plan.codex.version : "not found"}`,
    `  active tracked jobs: ${plan.activeJobs.length}`,
    "  supported platform: yes",
    "",
    "Doctor is read-only and made no changes.",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

export async function runNpmCli(argv = process.argv.slice(2), env = process.env) {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${readPackage().version}\n`);
    return;
  }
  if (command === "doctor") {
    if (args.some((arg) => arg !== "--provenance") || args.length > 1) {
      throw new Error("doctor accepts only --provenance.");
    }
    runDoctor(env, { provenance: args[0] === "--provenance" });
    return;
  }
  if (command === "install" || command === "update") {
    await runInstaller(args, env);
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

if (isCliEntry(import.meta.url)) {
  runNpmCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
