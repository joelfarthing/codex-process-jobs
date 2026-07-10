import fs from "node:fs";
import path from "node:path";

export const DEFAULT_MAX_LOG_BYTES = 16 * 1024 * 1024;
export const DEFAULT_READ_BYTES = 64 * 1024;
const TRUNCATION_MARKER = Buffer.from("[... earlier output truncated ...]\n", "utf8");

export function resolveMaxLogBytes(env = process.env) {
  const parsed = Number.parseInt(env.CODEX_PROCESS_JOBS_MAX_LOG_BYTES ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_LOG_BYTES;
  return Math.max(1_024, Math.min(parsed, 1024 * 1024 * 1024));
}

function compactAndAppend(fd, currentSize, chunk, limit) {
  const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (currentSize + payload.length <= limit) {
    fs.writeSync(fd, payload);
    return currentSize + payload.length;
  }

  const available = Math.max(0, limit - TRUNCATION_MARKER.length);
  const payloadTail = payload.subarray(Math.max(0, payload.length - available));
  const existingBudget = Math.max(0, available - payloadTail.length);
  const existingBytes = Math.min(currentSize, existingBudget);
  const existingTail = Buffer.alloc(existingBytes);
  if (existingBytes > 0) {
    fs.readSync(fd, existingTail, 0, existingBytes, Math.max(0, currentSize - existingBytes));
  }

  fs.ftruncateSync(fd, 0);
  fs.writeSync(fd, TRUNCATION_MARKER);
  if (existingTail.length > 0) fs.writeSync(fd, existingTail);
  if (payloadTail.length > 0) fs.writeSync(fd, payloadTail);
  return TRUNCATION_MARKER.length + existingTail.length + payloadTail.length;
}

export function createBoundedLogWriter(file, limit = DEFAULT_MAX_LOG_BYTES) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, "a+", 0o600);
  let size = fs.fstatSync(fd).size;
  if (size > limit) {
    const tail = readTail(file, Math.max(0, limit - TRUNCATION_MARKER.length));
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, TRUNCATION_MARKER);
    fs.writeSync(fd, tail);
    size = TRUNCATION_MARKER.length + tail.length;
  }
  return {
    append(chunk) {
      size = compactAndAppend(fd, size, chunk, limit);
    },
    close() {
      fs.closeSync(fd);
    },
    get size() {
      return size;
    },
  };
}

export function readTail(file, maxBytes = DEFAULT_READ_BYTES) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.max(0, Math.min(size, maxBytes));
      const buffer = Buffer.alloc(length);
      if (length > 0) fs.readSync(fd, buffer, 0, length, size - length);
      return buffer;
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error?.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
}

export function readLog(file, { full = false, maxBytes = DEFAULT_READ_BYTES } = {}) {
  if (!full) return readTail(file, maxBytes).toString("utf8");
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}
