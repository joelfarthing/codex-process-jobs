import fs from "node:fs";
import path from "node:path";

import { resolveCodexHome } from "./state.mjs";

const MAX_SESSION_META_BYTES = 256 * 1024;
const MAX_SUBAGENT_PARENT_DEPTH = 16;

export function sanitizeThreadId(value) {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(normalized)) {
    throw new Error("No valid owning Codex thread id was provided.");
  }
  return normalized;
}

// Codex hook payloads can retain the user-visible parent as `session_id`
// while a spawned subagent executes with its own CODEX_THREAD_ID. Prefer the
// runtime identity so hook decisions and launch boundaries apply to the agent
// that is actually using the tool.
export function resolveHookThreadId(input, env = process.env) {
  let payloadThreadId = null;
  for (const candidate of [input?.thread_id, input?.session_id]) {
    if (candidate == null || String(candidate).trim() === "") continue;
    try {
      payloadThreadId = sanitizeThreadId(candidate);
      break;
    } catch {}
  }

  try {
    const runtimeThreadId = sanitizeThreadId(env.CODEX_THREAD_ID);
    if (!payloadThreadId || runtimeThreadId === payloadThreadId) return runtimeThreadId;
    const rollout = resolveOwnerRolloutFile(runtimeThreadId, env);
    const metadata = rollout ? readSessionMeta(rollout) : null;
    const recordedId = metadata?.id ?? null;
    if (recordedId != null && sanitizeThreadId(recordedId) === runtimeThreadId) {
      return runtimeThreadId;
    }
  } catch {}

  if (payloadThreadId) return payloadThreadId;
  try {
    return sanitizeThreadId(env.CODEX_THREAD_ID);
  } catch {
    return null;
  }
}

export function resolveOwnerRolloutFile(threadId, env = process.env) {
  const safeThreadId = sanitizeThreadId(threadId);
  const sessionsRoot = path.join(resolveCodexHome(env), "sessions");
  const suffix = `${safeThreadId}.jsonl`;
  const stack = [sessionsRoot];
  const matches = [];
  while (stack.length > 0) {
    const directory = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "EACCES") continue;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(candidate);
      else if (entry.isFile() && entry.name.endsWith(suffix)) {
        matches.push({ file: candidate, modifiedMs: fs.statSync(candidate).mtimeMs });
      }
    }
  }
  matches.sort((left, right) => right.modifiedMs - left.modifiedMs);
  return matches[0]?.file ?? null;
}

export function readSessionMeta(file) {
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, MAX_SESSION_META_BYTES);
  if (length === 0) return null;
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(file, "r");
  try {
    fs.readSync(descriptor, buffer, 0, length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  const lines = buffer.toString("utf8").split("\n");
  if (stat.size > length) lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === "session_meta" && event.payload && typeof event.payload === "object") {
        return event.payload;
      }
    } catch {}
  }
  return null;
}

function spawnedSubagentParentThreadId(metadata, current) {
  if (!metadata || typeof metadata !== "object") return null;

  // The rollout file name is not enough to establish ownership. Require the
  // metadata identity to match the current thread before using any parent.
  const recordedId = metadata.id ?? metadata.thread_id ?? metadata.session_id ?? null;
  if (recordedId == null) return null;
  try {
    if (sanitizeThreadId(recordedId) !== current) return null;
  } catch {
    return null;
  }

  const sourceSubagent = metadata.source?.subagent;
  const nestedDeclaration = sourceSubagent?.thread_spawn;
  const explicitlySpawned = metadata.thread_source === "subagent"
    || (nestedDeclaration && typeof nestedDeclaration === "object");
  if (!explicitlySpawned) return null;

  const candidates = [];
  for (const candidate of [nestedDeclaration?.parent_thread_id, metadata.parent_thread_id]) {
    if (candidate == null) continue;
    try {
      candidates.push(sanitizeThreadId(candidate));
    } catch {
      return null;
    }
  }
  if (candidates.length === 0 || new Set(candidates).size !== 1) return null;
  const parent = candidates[0];
  return parent === current ? null : parent;
}

export function isSpawnedSubagentThread(threadId, env = process.env) {
  try {
    const current = sanitizeThreadId(threadId);
    const rollout = resolveOwnerRolloutFile(current, env);
    if (!rollout) return false;
    return spawnedSubagentParentThreadId(readSessionMeta(rollout), current) != null;
  } catch {
    return false;
  }
}

// A spawned subagent can launch a valid detached job, but it has no durable UI
// client after its turn drains. Route completion to the highest user-visible
// ancestor while preserving the actual launch thread separately for hook turn
// boundaries.
export function resolveNotificationOwnerThreadId(threadId, env = process.env) {
  let current = sanitizeThreadId(threadId);
  const origin = current;
  const visited = new Set();
  for (let depth = 0; depth < MAX_SUBAGENT_PARENT_DEPTH; depth += 1) {
    if (visited.has(current)) return origin;
    visited.add(current);
    const rollout = resolveOwnerRolloutFile(current, env);
    if (!rollout) return current;
    const parent = spawnedSubagentParentThreadId(readSessionMeta(rollout), current);
    if (!parent) return current;
    if (visited.has(parent)) return origin;
    current = parent;
  }
  return origin;
}
