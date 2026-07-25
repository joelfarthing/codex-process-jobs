import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { resolveCodexHome } from "./state.mjs";

const MAX_FRAME_BYTES = 1024 * 1024;
const INITIALIZE_VERSION = 0;
const START_TURN_VERSION = 1;
const PRIVATE_IPC_SURFACES = new Set(["app", "vscode"]);
const PRIVATE_IPC_PLATFORMS = new Set(["darwin", "linux"]);

function privateIpcTransport(ownerSurface) {
  if (ownerSurface === "app") return "desktop-ipc";
  if (ownerSurface === "vscode") return "vscode-ipc";
  return null;
}

function desktopIpcError(message, { accepted = false } = {}) {
  const error = new Error(message);
  error.desktopIpcUnavailable = !accepted;
  error.turnAccepted = accepted;
  return error;
}

function encodeFrame(message) {
  const json = JSON.stringify(message);
  const length = Buffer.byteLength(json, "utf8");
  const output = Buffer.allocUnsafe(4 + length);
  output.writeUInt32LE(length, 0);
  output.write(json, 4, "utf8");
  return output;
}

function attachFrameReader(socket, onMessage, onError) {
  const header = Buffer.allocUnsafe(4);
  let headerLength = 0;
  let body = null;
  let bodyLength = 0;
  let failed = false;
  const onData = (chunk) => {
    if (failed) return;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (body == null) {
          const headerBytes = Math.min(4 - headerLength, chunk.length - offset);
          chunk.copy(header, headerLength, offset, offset + headerBytes);
          headerLength += headerBytes;
          offset += headerBytes;
          if (headerLength < 4) continue;
          const length = header.readUInt32LE(0);
          if (length < 1 || length > MAX_FRAME_BYTES) {
            throw new Error(`Invalid private Codex IPC frame length: ${length}.`);
          }
          body = Buffer.allocUnsafe(length);
          bodyLength = 0;
        }
        const bodyBytes = Math.min(body.length - bodyLength, chunk.length - offset);
        chunk.copy(body, bodyLength, offset, offset + bodyBytes);
        bodyLength += bodyBytes;
        offset += bodyBytes;
        if (bodyLength < body.length) continue;
        const message = JSON.parse(body.toString("utf8"));
        body = null;
        bodyLength = 0;
        headerLength = 0;
        onMessage(message);
      }
    } catch (error) {
      failed = true;
      onError(error);
    }
  };
  socket.on("data", onData);
  return () => socket.off("data", onData);
}

function validateOwnedPrivatePath(candidate, { socket = false } = {}) {
  const stat = fs.lstatSync(candidate);
  if (socket ? !stat.isSocket() : !stat.isDirectory()) {
    throw desktopIpcError(`Private Codex IPC ${socket ? "endpoint is not a socket" : "parent is not a directory"}.`);
  }
  const uid = process.getuid?.();
  if (uid != null && stat.uid !== uid) {
    throw desktopIpcError(`Private Codex IPC ${socket ? "socket" : "directory"} is not owned by the current user.`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw desktopIpcError(`Private Codex IPC ${socket ? "socket" : "directory"} is accessible by other users.`);
  }
}

export function validatePrivateIpcSocket(socketPath) {
  validateOwnedPrivatePath(path.dirname(socketPath));
  validateOwnedPrivatePath(socketPath, { socket: true });
  return socketPath;
}

export function inspectPrivateIpcSocket(job, env = process.env, platform = process.platform) {
  if (
    env.CODEX_PROCESS_JOBS_DISABLE_PRIVATE_IPC === "1"
    || env.CODEX_PROCESS_JOBS_DISABLE_DESKTOP_IPC === "1"
  ) {
    return {
      socketPath: null,
      reason: "Private Codex IPC is disabled by configuration.",
    };
  }
  if (!PRIVATE_IPC_SURFACES.has(job.ownerSurface)) {
    return {
      socketPath: null,
      reason: `Private Codex IPC does not support owner surface ${String(job.ownerSurface ?? "unknown")}.`,
    };
  }
  const override = String(
    env.CODEX_PROCESS_JOBS_PRIVATE_IPC_SOCKET
    ?? env.CODEX_PROCESS_JOBS_DESKTOP_IPC_SOCKET
    ?? "",
  ).trim();
  if (!override && !PRIVATE_IPC_PLATFORMS.has(platform)) {
    return {
      socketPath: null,
      reason: `Private Codex IPC is unavailable on platform ${platform}.`,
    };
  }
  const socketPath = override || path.join(resolveCodexHome(env), "ipc", "ipc.sock");
  try {
    return {
      socketPath: validatePrivateIpcSocket(socketPath),
      reason: null,
    };
  } catch (error) {
    if (error?.desktopIpcUnavailable) throw error;
    if (["ENOENT", "ENOTDIR", "EACCES"].includes(error?.code)) {
      return {
        socketPath: null,
        reason: `Private Codex IPC endpoint is unavailable (${error.code}).`,
      };
    }
    throw desktopIpcError(`Private Codex IPC endpoint validation failed: ${error.message}`);
  }
}

export function resolveDesktopIpcSocket(job, env = process.env, platform = process.platform) {
  return inspectPrivateIpcSocket(job, env, platform).socketPath;
}

function sendRequest(socket, clientId, method, params, version, timeoutMs) {
  const requestId = crypto.randomUUID();
  const acceptanceUncertain = method === "thread-follower-start-turn";
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(desktopIpcError(
        `Private Codex IPC ${method} timed out after ${timeoutMs}ms.`,
        { accepted: acceptanceUncertain },
      ));
    }, timeoutMs);
    const onMessage = (message) => {
      if (message?.type !== "response" || message.requestId !== requestId) return;
      cleanup();
      if (message.resultType === "error") {
        reject(desktopIpcError(`Private Codex IPC ${method} failed: ${message.error ?? "unknown error"}.`));
      } else {
        resolve(message);
      }
    };
    const onSocketError = (error) => {
      cleanup();
      reject(desktopIpcError(
        `Private Codex IPC ${method} connection failed: ${error.message}`,
        { accepted: acceptanceUncertain },
      ));
    };
    const onSocketClose = () => {
      cleanup();
      reject(desktopIpcError(
        `Private Codex IPC ${method} connection closed before a response.`,
        { accepted: acceptanceUncertain },
      ));
    };
    function cleanup() {
      clearTimeout(timeout);
      socket.off("desktop-ipc-message", onMessage);
      socket.off("error", onSocketError);
      socket.off("close", onSocketClose);
    }
    socket.on("desktop-ipc-message", onMessage);
    socket.once("error", onSocketError);
    socket.once("close", onSocketClose);
    socket.write(encodeFrame({
      type: "request",
      requestId,
      sourceClientId: clientId,
      version,
      method,
      params,
      timeoutMs,
    }));
  });
}

function privateTurnInput(input) {
  const items = typeof input === "string" ? [{ type: "text", text: input }] : input;
  if (!Array.isArray(items) || items.length === 0) {
    throw desktopIpcError("Private Codex IPC notification input must be a non-empty array.");
  }
  return items.map((item) => {
    if (item?.type === "text" && typeof item.text === "string") {
      return { type: "text", text: item.text, text_elements: [] };
    }
    if (
      item?.type === "skill"
      && typeof item.name === "string"
      && typeof item.path === "string"
    ) {
      return { type: "skill", name: item.name, path: item.path };
    }
    throw desktopIpcError("Private Codex IPC notification input contains an unsupported item.");
  });
}

export async function startDesktopNotificationTurn(
  job,
  input,
  threadId,
  timeoutMs,
  env = process.env,
  {
    beforeStart = async () => {},
    onUnavailable = () => {},
  } = {},
) {
  const inspected = inspectPrivateIpcSocket(job, env);
  if (!inspected.socketPath) {
    onUnavailable(inspected.reason);
    return null;
  }
  return await startPrivateIpcNotificationTurn(input, threadId, timeoutMs, inspected.socketPath, {
    beforeStart,
    transport: privateIpcTransport(job.ownerSurface),
  });
}

export async function startPrivateIpcNotificationTurn(
  input,
  threadId,
  timeoutMs,
  socketPath,
  {
    beforeStart = async () => {},
    clientType = "codex-process-jobs",
    transport = "private-ipc",
  } = {},
) {
  validatePrivateIpcSocket(socketPath);
  const socket = net.createConnection(socketPath);
  let readerError = null;
  const detachReader = attachFrameReader(
    socket,
    (message) => socket.emit("desktop-ipc-message", message),
    (error) => {
      readerError = error;
      socket.destroy(error);
    },
  );
  await new Promise((resolve, reject) => {
    const onConnect = () => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (error) => {
      socket.off("connect", onConnect);
      reject(desktopIpcError(`Unable to connect to private Codex IPC: ${error.message}`));
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });

  try {
    const initialized = await sendRequest(
      socket,
      "initializing-client",
      "initialize",
      { clientType },
      INITIALIZE_VERSION,
      Math.min(timeoutMs, 15_000),
    );
    const clientId = initialized.result?.clientId;
    if (!clientId) throw desktopIpcError("Private Codex IPC initialize returned no client ID.");
    await beforeStart();

    const started = await sendRequest(
      socket,
      clientId,
      "thread-follower-start-turn",
      {
        conversationId: threadId,
        turnStartParams: {
          input: privateTurnInput(input),
        },
      },
      START_TURN_VERSION,
      Math.min(timeoutMs, 30_000),
    );
    if (readerError) throw readerError;
    const turnId = started.result?.result?.turn?.id;
    if (typeof turnId !== "string" || !/^[A-Za-z0-9_-]{8,160}$/.test(turnId)) {
      throw desktopIpcError("Private Codex IPC returned no valid turn ID.", { accepted: true });
    }
    return { threadId, turnId, status: "accepted", transport };
  } catch (error) {
    if (error?.desktopIpcUnavailable || error?.turnAccepted || error?.retryWhenIdle) throw error;
    throw desktopIpcError(error instanceof Error ? error.message : String(error));
  } finally {
    detachReader();
    socket.end();
  }
}
