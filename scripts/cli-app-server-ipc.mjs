import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { readPreferences } from "./preferences.mjs";
import { resolveCodexHome } from "./state.mjs";

const MAX_HANDSHAKE_BYTES = 16 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);

function cliAppServerError(message, { accepted = false } = {}) {
  const error = new Error(message);
  error.cliAppServerUnavailable = !accepted;
  error.turnAccepted = accepted;
  return error;
}

function parseBooleanOverride(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return false;
}

export function cliLiveInjectionEnabled(env = process.env) {
  const override = parseBooleanOverride(env.CODEX_PROCESS_JOBS_CLI_LIVE_INJECTION);
  if (override != null) return override;
  try {
    return readPreferences(env).cliLiveInjection;
  } catch {
    return false;
  }
}

function validateOwnedPrivatePath(candidate, { socket = false } = {}) {
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || (socket ? !stat.isSocket() : !stat.isDirectory())) {
    throw cliAppServerError(
      `Shared Codex App Server ${socket ? "endpoint is not a socket" : "parent is not a real directory"}.`,
    );
  }
  const uid = process.getuid?.();
  if (uid != null && stat.uid !== uid) {
    throw cliAppServerError(
      `Shared Codex App Server ${socket ? "socket" : "directory"} is not owned by the current user.`,
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw cliAppServerError(
      `Shared Codex App Server ${socket ? "socket" : "directory"} is accessible by other users.`,
    );
  }
}

export function validateCliAppServerSocket(socketPath) {
  validateOwnedPrivatePath(path.dirname(socketPath));
  validateOwnedPrivatePath(socketPath, { socket: true });
  return socketPath;
}

export function inspectCliAppServerSocket(
  job,
  env = process.env,
  platform = process.platform,
) {
  if (job.ownerSurface !== "cli") {
    return {
      socketPath: null,
      reason: `CLI live injection does not support owner surface ${String(job.ownerSurface ?? "unknown")}.`,
    };
  }
  if (!cliLiveInjectionEnabled(env)) {
    return {
      socketPath: null,
      reason: "Experimental CLI live injection is not enabled.",
    };
  }
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    return {
      socketPath: null,
      reason: `CLI live injection is unavailable on platform ${platform}.`,
    };
  }
  const override = String(env.CODEX_PROCESS_JOBS_CLI_APP_SERVER_SOCKET ?? "").trim();
  const socketPath = override || path.join(
    resolveCodexHome(env),
    "app-server-control",
    "app-server-control.sock",
  );
  try {
    return { socketPath: validateCliAppServerSocket(socketPath), reason: null };
  } catch (error) {
    if (error?.cliAppServerUnavailable) throw error;
    if (["ENOENT", "ENOTDIR", "EACCES"].includes(error?.code)) {
      return {
        socketPath: null,
        reason: `Shared Codex App Server endpoint is unavailable (${error.code}).`,
      };
    }
    throw cliAppServerError(`Shared Codex App Server endpoint validation failed: ${error.message}`);
  }
}

function encodeClientFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > MAX_FRAME_BYTES) {
    throw cliAppServerError(`CLI App Server frame exceeds ${MAX_FRAME_BYTES} bytes.`);
  }
  const lengthBytes = body.length < 126 ? 0 : body.length <= 0xffff ? 2 : 8;
  const header = Buffer.allocUnsafe(2 + lengthBytes + 4);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | (lengthBytes === 0 ? body.length : lengthBytes === 2 ? 126 : 127);
  let offset = 2;
  if (lengthBytes === 2) {
    header.writeUInt16BE(body.length, offset);
    offset += 2;
  } else if (lengthBytes === 8) {
    header.writeBigUInt64BE(BigInt(body.length), offset);
    offset += 8;
  }
  const mask = crypto.randomBytes(4);
  mask.copy(header, offset);
  const masked = Buffer.allocUnsafe(body.length);
  for (let index = 0; index < body.length; index += 1) {
    masked[index] = body[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, masked]);
}

function attachWebSocketReader(socket, onText, onError) {
  let pending = Buffer.alloc(0);
  let fragmentedOpcode = null;
  let fragments = [];
  let fragmentBytes = 0;
  let failed = false;

  function fail(error) {
    if (failed) return;
    failed = true;
    onError(error instanceof Error ? error : new Error(String(error)));
  }

  function emitMessage(opcode, payload) {
    if (opcode !== 0x1) throw new Error(`Unsupported CLI App Server WebSocket opcode ${opcode}.`);
    if (payload.length > MAX_MESSAGE_BYTES) {
      throw new Error(`CLI App Server message exceeds ${MAX_MESSAGE_BYTES} bytes.`);
    }
    onText(payload.toString("utf8"));
  }

  function onData(chunk) {
    if (failed) return;
    try {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const first = pending[0];
        const second = pending[1];
        const fin = Boolean(first & 0x80);
        const opcode = first & 0x0f;
        const rsv = first & 0x70;
        const masked = Boolean(second & 0x80);
        if (rsv !== 0) throw new Error("Compressed or reserved CLI App Server WebSocket frames are unsupported.");
        if (masked) throw new Error("CLI App Server sent an invalid masked server frame.");
        let length = second & 0x7f;
        let headerLength = 2;
        if (length === 126) {
          if (pending.length < 4) return;
          length = pending.readUInt16BE(2);
          headerLength = 4;
        } else if (length === 127) {
          if (pending.length < 10) return;
          const extended = pending.readBigUInt64BE(2);
          if (extended > BigInt(MAX_FRAME_BYTES)) {
            throw new Error(`CLI App Server frame exceeds ${MAX_FRAME_BYTES} bytes.`);
          }
          length = Number(extended);
          headerLength = 10;
        }
        if (length > MAX_FRAME_BYTES) {
          throw new Error(`CLI App Server frame exceeds ${MAX_FRAME_BYTES} bytes.`);
        }
        if (pending.length < headerLength + length) return;
        const payload = pending.subarray(headerLength, headerLength + length);
        pending = pending.subarray(headerLength + length);

        if (opcode >= 0x8) {
          if (!fin || length > 125) throw new Error("Invalid CLI App Server WebSocket control frame.");
          if (opcode === 0x8) throw new Error("Shared Codex App Server closed the WebSocket connection.");
          if (opcode === 0x9) socket.write(encodeClientFrame(0xA, payload));
          else if (opcode !== 0xA) throw new Error(`Unsupported WebSocket control opcode ${opcode}.`);
          continue;
        }

        if (opcode === 0x0) {
          if (fragmentedOpcode == null) throw new Error("Unexpected WebSocket continuation frame.");
          fragments.push(payload);
          fragmentBytes += payload.length;
          if (fragmentBytes > MAX_MESSAGE_BYTES) {
            throw new Error(`CLI App Server message exceeds ${MAX_MESSAGE_BYTES} bytes.`);
          }
          if (fin) {
            emitMessage(fragmentedOpcode, Buffer.concat(fragments, fragmentBytes));
            fragmentedOpcode = null;
            fragments = [];
            fragmentBytes = 0;
          }
          continue;
        }

        if (fragmentedOpcode != null) throw new Error("Interleaved WebSocket data messages are unsupported.");
        if (fin) {
          emitMessage(opcode, payload);
        } else {
          fragmentedOpcode = opcode;
          fragments = [payload];
          fragmentBytes = payload.length;
        }
      }
    } catch (error) {
      fail(error);
    }
  }

  socket.on("data", onData);
  return {
    feed: onData,
    detach: () => socket.off("data", onData),
  };
}

async function openUnixWebSocket(socketPath, timeoutMs) {
  validateCliAppServerSocket(socketPath);
  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(cliAppServerError(`Shared Codex App Server connection timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(cliAppServerError(`Unable to connect to shared Codex App Server: ${error.message}`));
    };
    function cleanup() {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    }
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });

  const key = crypto.randomBytes(16).toString("base64");
  const request = [
    "GET / HTTP/1.1",
    "Host: localhost",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n");
  socket.write(request);

  return await new Promise((resolve, reject) => {
    let handshake = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(cliAppServerError(`Shared Codex App Server handshake timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    const onError = (error) => {
      cleanup();
      reject(cliAppServerError(`Shared Codex App Server handshake failed: ${error.message}`));
    };
    const onClose = () => {
      cleanup();
      reject(cliAppServerError("Shared Codex App Server closed during the WebSocket handshake."));
    };
    const onData = (chunk) => {
      handshake = Buffer.concat([handshake, chunk]);
      if (handshake.length > MAX_HANDSHAKE_BYTES) {
        cleanup();
        socket.destroy();
        reject(cliAppServerError(`Shared Codex App Server handshake exceeds ${MAX_HANDSHAKE_BYTES} bytes.`));
        return;
      }
      const boundary = handshake.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      cleanup();
      const headerText = handshake.subarray(0, boundary).toString("ascii");
      const lines = headerText.split("\r\n");
      if (!/^HTTP\/1\.[01] 101\b/.test(lines[0] ?? "")) {
        reject(cliAppServerError(`Shared Codex App Server rejected the WebSocket upgrade: ${lines[0] ?? "empty response"}.`));
        return;
      }
      const headers = new Map();
      for (const line of lines.slice(1)) {
        const separator = line.indexOf(":");
        if (separator <= 0) continue;
        headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
      }
      const expected = crypto.createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
      if (headers.get("sec-websocket-accept") !== expected) {
        reject(cliAppServerError("Shared Codex App Server returned an invalid WebSocket acceptance key."));
        return;
      }
      const upgrade = String(headers.get("upgrade") ?? "").toLowerCase();
      const connection = String(headers.get("connection") ?? "").toLowerCase();
      if (upgrade !== "websocket" || !connection.split(",").map((item) => item.trim()).includes("upgrade")) {
        reject(cliAppServerError("Shared Codex App Server returned invalid WebSocket upgrade headers."));
        return;
      }
      resolve({ socket, remainder: handshake.subarray(boundary + 4) });
    };
    function cleanup() {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    }
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function sendJson(socket, value) {
  socket.write(encodeClientFrame(0x1, Buffer.from(JSON.stringify(value), "utf8")));
}

export async function startCliAppServerNotificationTurn(
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
  const inspected = inspectCliAppServerSocket(job, env);
  if (!inspected.socketPath) {
    onUnavailable(inspected.reason);
    return null;
  }
  const handshakeTimeout = Math.min(timeoutMs, 15_000);
  const { socket, remainder } = await openUnixWebSocket(inspected.socketPath, handshakeTimeout);
  let accepted = false;
  let settled = false;
  let phase = "initializing";
  let reader;
  let timeout;

  return await new Promise((resolve, reject) => {
    function cleanup() {
      clearTimeout(timeout);
      reader?.detach();
      socket.off("error", onSocketError);
      socket.off("close", onSocketClose);
      if (!socket.destroyed) socket.end();
    }
    function finish(handler, value) {
      if (settled) return;
      settled = true;
      cleanup();
      handler(value);
    }
    function rejectProtocol(message) {
      finish(reject, cliAppServerError(message, { accepted }));
    }
    function onSocketError(error) {
      rejectProtocol(`Shared Codex App Server connection failed: ${error.message}`);
    }
    function onSocketClose() {
      rejectProtocol("Shared Codex App Server connection closed before turn acceptance was confirmed.");
    }
    async function onMessage(text) {
      if (settled) return;
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        rejectProtocol("Shared Codex App Server returned invalid JSON.");
        return;
      }
      if (message.id === 1) {
        if (phase !== "initializing") {
          rejectProtocol("Shared Codex App Server returned a duplicate initialize response.");
          return;
        }
        if (message.error) {
          rejectProtocol(`Shared Codex App Server initialize failed: ${JSON.stringify(message.error)}`);
          return;
        }
        phase = "starting";
        try {
          sendJson(socket, { method: "initialized", params: {} });
          await beforeStart();
          if (settled) return;
          accepted = true;
          phase = "awaiting-turn";
          sendJson(socket, {
            id: 2,
            method: "turn/start",
            params: { threadId, input },
          });
        } catch (error) {
          finish(reject, cliAppServerError(
            error instanceof Error ? error.message : String(error),
            { accepted },
          ));
        }
        return;
      }
      if (message.id === 2) {
        if (phase !== "awaiting-turn") {
          rejectProtocol("Shared Codex App Server returned a turn response before turn/start.");
          return;
        }
        if (message.error) {
          accepted = false;
          rejectProtocol(`Shared Codex App Server rejected the notification turn: ${JSON.stringify(message.error)}`);
          return;
        }
        const turnId = message.result?.turn?.id;
        if (typeof turnId !== "string" || !/^[A-Za-z0-9_-]{8,160}$/.test(turnId)) {
          rejectProtocol("Shared Codex App Server returned no valid turn ID.");
          return;
        }
        finish(resolve, {
          threadId,
          turnId,
          status: "accepted",
          transport: "cli-app-server",
        });
      }
    }

    timeout = setTimeout(() => {
      rejectProtocol(`Shared Codex App Server request timed out after ${timeoutMs}ms.`);
    }, timeoutMs);
    socket.once("error", onSocketError);
    socket.once("close", onSocketClose);
    reader = attachWebSocketReader(socket, onMessage, (error) => {
      rejectProtocol(`Shared Codex App Server protocol failed: ${error.message}`);
    });
    if (remainder.length > 0) reader.feed(remainder);
    sendJson(socket, {
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex-process-jobs",
          title: "Codex Process Jobs",
          version: "0.3.0",
        },
        capabilities: { experimentalApi: true },
      },
    });
  });
}
