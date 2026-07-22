#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isCliEntry } from "./cli-entry.mjs";
import { main as runInstaller, resolveInstallPlan } from "./install.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_FILE = path.join(ROOT, "package.json");

function readPackage() {
  return JSON.parse(fs.readFileSync(PACKAGE_FILE, "utf8"));
}

function usage() {
  return [
    "Usage:",
    "  codex-process-jobs install [installer options]",
    "  codex-process-jobs update [installer options]",
    "  codex-process-jobs doctor",
    "  codex-process-jobs version",
    "",
    "Install and update are preview-only unless --apply is supplied.",
    "Applying requires --agent-policy global, project, or none.",
    "Use an exact npm version for the apply step after reviewing a @latest preview.",
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

function runDoctor(env) {
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
    `  package version: ${metadata.version}`,
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
    if (args.length > 0) throw new Error("doctor does not accept options.");
    runDoctor(env);
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
