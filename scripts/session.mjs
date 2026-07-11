import fs from "node:fs";
import path from "node:path";

import { resolveCodexHome } from "./state.mjs";

const MAX_SESSION_META_BYTES = 256 * 1024;

export function sanitizeThreadId(value) {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(normalized)) {
    throw new Error("No valid owning Codex thread id was provided.");
  }
  return normalized;
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
