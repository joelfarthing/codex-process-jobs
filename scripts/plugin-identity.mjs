import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCTION_PLUGIN_NAME = "codex-process-jobs";
export const DEVELOPMENT_SUFFIX = "-dev";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_FILE = path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json");

function readRuntimeManifest() {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read runtime plugin manifest at ${MANIFEST_FILE}: ${error.message}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Runtime plugin manifest must be a JSON object: ${MANIFEST_FILE}`);
  }
  return manifest;
}

export function validateRuntimePluginName(name) {
  const developmentName = `${PRODUCTION_PLUGIN_NAME}${DEVELOPMENT_SUFFIX}`;
  if (name !== PRODUCTION_PLUGIN_NAME && name !== developmentName) {
    throw new Error(`Unsupported Codex Process Jobs runtime identity: ${String(name)}`);
  }
  return name;
}

const runtimeManifest = readRuntimeManifest();

export const RUNTIME_PLUGIN_NAME = validateRuntimePluginName(runtimeManifest.name);
export const RUNTIME_DISPLAY_NAME = typeof runtimeManifest.interface?.displayName === "string"
  && runtimeManifest.interface.displayName.trim()
  ? runtimeManifest.interface.displayName.trim()
  : "Codex Process Jobs";
export const STATE_DIRECTORY_NAME = RUNTIME_PLUGIN_NAME === PRODUCTION_PLUGIN_NAME
  ? "process-jobs"
  : "process-jobs-dev";

export function skillReference(skillName) {
  const normalized = String(skillName ?? "");
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(normalized)) {
    throw new Error(`Invalid skill name: ${normalized || "(empty)"}`);
  }
  return `$${RUNTIME_PLUGIN_NAME}:${normalized}`;
}
