import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cliLiveInjectionEnabled,
  inspectCliAppServerSocket,
  startCliAppServerNotificationTurn,
  validateCliAppServerSocket,
} from "../scripts/cli-app-server-ipc.mjs";
import { deliverNotificationTurn } from "../scripts/notifier.mjs";
import { writePreferences } from "../scripts/preferences.mjs";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeServerText(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  assert.ok(payload.length < 126);
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function decodeClientFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const second = buffer[offset + 1];
    assert.ok(second & 0x80, "client WebSocket frames must be masked");
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }
    if (buffer.length - offset < headerLength + 4 + length) break;
    const maskOffset = offset + headerLength;
    const bodyOffset = maskOffset + 4;
    const payload = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index += 1) {
      payload[index] = buffer[bodyOffset + index] ^ buffer[maskOffset + (index % 4)];
    }
    messages.push(JSON.parse(payload.toString("utf8")));
    offset = bodyOffset + length;
  }
  return { messages, remainder: buffer.subarray(offset) };
}

async function createMockAppServer(
  t,
  {
    rejectTurn = false,
    closeAfterTurnStart = false,
    rollout = null,
    onMessage = () => {},
  } = {},
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cpj-cli-app-server-"));
  fs.chmodSync(directory, 0o700);
  const socketPath = path.join(directory, "app-server-control.sock");
  const server = net.createServer((socket) => {
    let upgraded = false;
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (!upgraded) {
        const boundary = pending.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        const headers = pending.subarray(0, boundary).toString("ascii");
        const key = headers.match(/^Sec-WebSocket-Key:\s*(.+)$/mi)?.[1]?.trim();
        assert.ok(key);
        const accept = crypto.createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
        socket.write([
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "",
          "",
        ].join("\r\n"));
        pending = pending.subarray(boundary + 4);
        upgraded = true;
      }
      const decoded = decodeClientFrames(pending);
      pending = decoded.remainder;
      for (const message of decoded.messages) {
        onMessage(message);
        if (message.id === 1) {
          socket.write(encodeServerText({ id: 1, result: { userAgent: "mock" } }));
        } else if (message.id === 2) {
          if (closeAfterTurnStart) {
            socket.end();
          } else if (rejectTurn) {
            socket.write(encodeServerText({ id: 2, error: { code: -32600, message: "thread active" } }));
          } else {
            if (rollout) {
              fs.appendFileSync(rollout, `${JSON.stringify({
                type: "event_msg",
                payload: { type: "task_started", turn_id: "turn-cli-live-001" },
              })}\n`);
            }
            socket.write(encodeServerText({
              id: 2,
              result: { turn: { id: "turn-cli-live-001", status: "inProgress" } },
            }));
            if (rollout) {
              setTimeout(() => fs.appendFileSync(rollout, `${JSON.stringify({
                type: "event_msg",
                payload: { type: "task_complete", turn_id: "turn-cli-live-001" },
              })}\n`), 20);
            }
          }
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  fs.chmodSync(socketPath, 0o600);
  t.after(() => {
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { socketPath, directory };
}

test("CLI live injection is opt-in and an environment override wins", (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "cpj-cli-pref-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const env = { CODEX_HOME: codexHome };
  assert.equal(cliLiveInjectionEnabled(env), false);
  writePreferences({ cliLiveInjection: true }, env);
  assert.equal(cliLiveInjectionEnabled(env), true);
  assert.equal(cliLiveInjectionEnabled({ ...env, CODEX_PROCESS_JOBS_CLI_LIVE_INJECTION: "0" }), false);
  assert.equal(cliLiveInjectionEnabled({ ...env, CODEX_PROCESS_JOBS_CLI_LIVE_INJECTION: "1" }), true);
  assert.equal(cliLiveInjectionEnabled({ ...env, CODEX_PROCESS_JOBS_CLI_LIVE_INJECTION: "invalid" }), false);
});

test("CLI App Server endpoint requires CLI ownership and a private same-user socket", async (t) => {
  const { socketPath, directory } = await createMockAppServer(t);
  const enabled = {
    CODEX_PROCESS_JOBS_CLI_LIVE_INJECTION: "1",
    CODEX_PROCESS_JOBS_CLI_APP_SERVER_SOCKET: socketPath,
  };
  assert.equal(inspectCliAppServerSocket({ ownerSurface: "app" }, enabled).socketPath, null);
  assert.equal(inspectCliAppServerSocket({ ownerSurface: "cli" }, {
    ...enabled,
    CODEX_PROCESS_JOBS_CLI_LIVE_INJECTION: "0",
  }).socketPath, null);
  assert.equal(validateCliAppServerSocket(socketPath), socketPath);
  fs.chmodSync(socketPath, 0o666);
  assert.throws(() => validateCliAppServerSocket(socketPath), /accessible by other users/i);
  fs.chmodSync(socketPath, 0o600);
  fs.chmodSync(directory, 0o755);
  assert.throws(() => validateCliAppServerSocket(socketPath), /accessible by other users/i);
});

test("CLI App Server injection initializes and starts the exact owning turn", async (t) => {
  const messages = [];
  const { socketPath } = await createMockAppServer(t, {
    onMessage: (message) => messages.push(message),
  });
  let beforeStart = 0;
  const input = [{ type: "text", text: "CPJ background job `job-cli-live` finished successfully with exit code 0." }];
  const result = await startCliAppServerNotificationTurn(
    { ownerSurface: "cli" },
    input,
    "thread-cli-live-001",
    2_000,
    {
      CODEX_PROCESS_JOBS_CLI_LIVE_INJECTION: "1",
      CODEX_PROCESS_JOBS_CLI_APP_SERVER_SOCKET: socketPath,
    },
    { beforeStart: async () => { beforeStart += 1; } },
  );
  assert.deepEqual(result, {
    threadId: "thread-cli-live-001",
    turnId: "turn-cli-live-001",
    status: "accepted",
    transport: "cli-app-server",
  });
  assert.equal(beforeStart, 1);
  assert.equal(messages[0].method, "initialize");
  assert.deepEqual(messages[1], { method: "initialized", params: {} });
  assert.equal(messages[2].method, "turn/start");
  assert.equal(messages[2].params.threadId, "thread-cli-live-001");
  assert.deepEqual(messages[2].params.input, input);
});

test("a rejected turn is safe to fall back while an uncertain close is not", async (t) => {
  const rejected = await createMockAppServer(t, { rejectTurn: true });
  const baseEnv = {
    CODEX_PROCESS_JOBS_CLI_LIVE_INJECTION: "1",
  };
  await assert.rejects(
    startCliAppServerNotificationTurn(
      { ownerSurface: "cli" },
      [{ type: "text", text: "completion" }],
      "thread-cli-rejected",
      2_000,
      { ...baseEnv, CODEX_PROCESS_JOBS_CLI_APP_SERVER_SOCKET: rejected.socketPath },
    ),
    (error) => error?.turnAccepted === false && /rejected/.test(error.message),
  );

  const uncertain = await createMockAppServer(t, { closeAfterTurnStart: true });
  await assert.rejects(
    startCliAppServerNotificationTurn(
      { ownerSurface: "cli" },
      [{ type: "text", text: "completion" }],
      "thread-cli-uncertain",
      2_000,
      { ...baseEnv, CODEX_PROCESS_JOBS_CLI_APP_SERVER_SOCKET: uncertain.socketPath },
    ),
    (error) => error?.turnAccepted === true && /closed/.test(error.message),
  );
});

test("notifier prefers confirmed CLI live injection over the invisible portable relay", async (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "cpj-cli-notifier-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const threadId = "thread-cli-notifier-001";
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "08", "09");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const rollout = path.join(sessionDirectory, `rollout-cli-${threadId}.jsonl`);
  fs.writeFileSync(rollout, `${JSON.stringify({
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "turn-before-cli-live" },
  })}\n`);
  const messages = [];
  const { socketPath } = await createMockAppServer(t, {
    rollout,
    onMessage: (message) => messages.push(message),
  });
  const result = await deliverNotificationTurn({
    id: "job-cli-notifier-001",
    status: "completed",
    exitCode: 0,
    cwd: process.cwd(),
    ownerThreadId: threadId,
    ownerSurface: "cli",
  }, {
    ...process.env,
    CODEX_HOME: codexHome,
    CODEX_PROCESS_JOBS_CLI_LIVE_INJECTION: "1",
    CODEX_PROCESS_JOBS_CLI_APP_SERVER_SOCKET: socketPath,
    CODEX_PROCESS_JOBS_CODEX_BIN: path.join(codexHome, "portable-relay-must-not-start"),
    CODEX_PROCESS_JOBS_NOTIFY_IDLE_SETTLE_MS: "5",
    CODEX_PROCESS_JOBS_NOTIFY_TURN_TIMEOUT_MS: "2000",
  });
  assert.deepEqual(result, {
    threadId,
    turnId: "turn-cli-live-001",
    status: "completed",
    transport: "cli-app-server",
  });
  const started = messages.find((message) => message.method === "turn/start");
  assert.equal(
    started.params.input[0].text,
    "CPJ background job `job-cli-notifier-001` finished successfully with exit code 0.",
  );
});
