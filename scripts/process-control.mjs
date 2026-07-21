import fs from "node:fs";
import { spawnSync } from "node:child_process";

export function parseLinuxProcStat(contents) {
  const text = String(contents);
  const closeParen = text.lastIndexOf(")");
  if (closeParen < 0) throw new Error("Malformed /proc stat: missing process name terminator");
  const fieldsAfterName = text.slice(closeParen + 2).trim().split(/\s+/);
  const startTime = fieldsAfterName[19];
  if (!startTime) throw new Error("Malformed /proc stat: missing starttime field");
  return startTime;
}

export function getProcessIdentity(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid pid: ${pid}`);
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    const readFileSync = options.readFileSync ?? fs.readFileSync;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return `linux:${parseLinuxProcStat(stat)}`;
  }
  if (platform === "darwin") {
    const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
    const result = spawnSyncImpl("ps", ["-o", "lstart=,comm=", "-p", String(pid)], {
      encoding: "utf8",
      shell: false,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 || !result.stdout?.trim()) {
      throw new Error(`Unable to read identity for process ${pid}`);
    }
    return `darwin:${result.stdout.trim()}`;
  }
  throw new Error(`Unsupported platform: ${platform}. Use macOS or Linux.`);
}

export function validateProcessIdentity(pid, expectedIdentity, options = {}) {
  if (!expectedIdentity) return false;
  try {
    return getProcessIdentity(pid, options) === expectedIdentity;
  } catch {
    return false;
  }
}

export function isProcessAlive(pid, killImpl = process.kill.bind(process)) {
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    return false;
  }
}

function signalProcessGroup(pid, signal, killImpl) {
  try {
    killImpl(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function isProcessGroupAlive(pid, killImpl) {
  try {
    killImpl(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function isTrackedProcessGroupAlive(pid, expectedIdentity, options) {
  const { validateIdentity, killImpl, identityOptions } = options;
  if (validateIdentity(pid, expectedIdentity, identityOptions)) return true;

  // POSIX reserves a process-group leader's numeric PID for the entire group
  // lifetime. If that PID is occupied by a different process, the validated
  // group has ended and must not be signalled. If the PID is free but the PGID
  // still exists, leaderless descendants are keeping the original group alive.
  if (isProcessAlive(pid, killImpl)) return false;
  return isProcessGroupAlive(pid, killImpl);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function terminateTrackedProcess(pid, expectedIdentity, options = {}) {
  const validateIdentity = options.validateIdentity ?? validateProcessIdentity;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const graceMs = options.graceMs ?? 5_000;
  const pollMs = options.pollMs ?? 100;

  if (!validateIdentity(pid, expectedIdentity, options.identityOptions)) {
    return { terminated: false, reason: "process identity mismatch" };
  }

  const termDelivered = signalProcessGroup(pid, "SIGTERM", killImpl);
  if (!termDelivered) return { terminated: true, forced: false, alreadyExited: true };

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isTrackedProcessGroupAlive(pid, expectedIdentity, {
      validateIdentity,
      killImpl,
      identityOptions: options.identityOptions,
    })) {
      return { terminated: true, forced: false };
    }
    await delay(pollMs);
  }

  if (!isTrackedProcessGroupAlive(pid, expectedIdentity, {
    validateIdentity,
    killImpl,
    identityOptions: options.identityOptions,
  })) {
    return { terminated: true, forced: false };
  }

  const killDelivered = signalProcessGroup(pid, "SIGKILL", killImpl);
  const killDeadline = Date.now() + Math.min(2_000, Math.max(250, graceMs));
  while (Date.now() < killDeadline) {
    if (!isTrackedProcessGroupAlive(pid, expectedIdentity, {
      validateIdentity,
      killImpl,
      identityOptions: options.identityOptions,
    })) {
      return { terminated: true, forced: killDelivered };
    }
    await delay(pollMs);
  }
  return {
    terminated: false,
    forced: killDelivered,
    reason: killDelivered
      ? "process identity still exists after SIGKILL"
      : "process exited before SIGKILL",
  };
}

export function quoteArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

export function renderCommand(argv, shell = false) {
  if (shell) return argv[0] ?? "";
  return argv.map(quoteArg).join(" ");
}
