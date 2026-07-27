import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensureStateDirs, resolveStateRoot } from "./state.mjs";

export const PREFERENCES_SCHEMA_VERSION = 1;
export const COMPLETION_MODES = new Set(["auto", "report", "inspect"]);
const MAX_PREFERENCES_BYTES = 16 * 1024;
const PREFERENCE_KEYS = new Set(["schemaVersion", "completionMode", "notifyUser"]);

export function resolvePreferencesFile(env = process.env) {
  return path.join(resolveStateRoot(env), "config.json");
}

function defaultPreferences() {
  return {
    schemaVersion: PREFERENCES_SCHEMA_VERSION,
    completionMode: "auto",
    notifyUser: null,
  };
}

function validatePreferences(value, file) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Process-jobs preferences must be a JSON object: ${file}`);
  }
  for (const key of Object.keys(value)) {
    if (!PREFERENCE_KEYS.has(key)) {
      throw new Error(`Unknown process-jobs preference key ${key} in ${file}.`);
    }
  }
  if (value.schemaVersion !== PREFERENCES_SCHEMA_VERSION) {
    throw new Error(`Unsupported process-jobs preferences schema in ${file}.`);
  }
  if (!COMPLETION_MODES.has(value.completionMode)) {
    throw new Error(`Invalid completionMode in ${file}.`);
  }
  if (value.notifyUser != null && typeof value.notifyUser !== "boolean") {
    throw new Error(`Invalid notifyUser in ${file}.`);
  }
  return {
    schemaVersion: PREFERENCES_SCHEMA_VERSION,
    completionMode: value.completionMode,
    // null means "no durable preference": launch resolution may then apply a
    // surface default instead of treating the absence as an explicit opt-out.
    notifyUser: value.notifyUser ?? null,
  };
}

function validatePrivateFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Process-jobs preferences path is not a regular file: ${file}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Process-jobs preferences are not owned by the current user: ${file}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`Process-jobs preferences are accessible by group or other users: ${file}`);
  }
  if (stat.size > MAX_PREFERENCES_BYTES) {
    throw new Error(`Process-jobs preferences exceed ${MAX_PREFERENCES_BYTES} bytes: ${file}`);
  }
}

export function readPreferences(env = process.env) {
  const file = resolvePreferencesFile(env);
  try {
    validatePrivateFile(file);
  } catch (error) {
    if (error?.code === "ENOENT") return defaultPreferences();
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Unable to parse process-jobs preferences at ${file}: ${error.message}`);
  }
  return validatePreferences(parsed, file);
}

export function writePreferences({ completionMode = null, notifyUser = null }, env = process.env) {
  ensureStateDirs(env);
  const file = resolvePreferencesFile(env);
  const current = fs.existsSync(file) ? readPreferences(env) : defaultPreferences();
  const nextCompletionMode = completionMode ?? current.completionMode;
  const nextNotifyUser = notifyUser ?? current.notifyUser;
  if (!COMPLETION_MODES.has(nextCompletionMode)) {
    throw new Error(`completion mode must be one of: ${[...COMPLETION_MODES].join(", ")}`);
  }
  if (nextNotifyUser != null && typeof nextNotifyUser !== "boolean") {
    throw new Error("notifyUser must be a boolean.");
  }
  const preferences = {
    schemaVersion: PREFERENCES_SCHEMA_VERSION,
    completionMode: nextCompletionMode,
    notifyUser: nextNotifyUser,
  };
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
  }
  return preferences;
}
