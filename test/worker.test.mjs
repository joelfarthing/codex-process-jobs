import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createJob, readJob, resolveJobLogs } from "../scripts/state.mjs";
import { launchUserNotification, recordNotificationRelaySpawn } from "../scripts/worker.mjs";

function createEnv(t) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-worker-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  return { ...process.env, CODEX_HOME: codexHome };
}

function terminalJob(id, notification, env) {
  return {
    id,
    name: id,
    status: "completed",
    cwd: process.cwd(),
    ownerThreadId: "thread-worker-test",
    notification,
    logs: resolveJobLogs(id, env),
  };
}

test("worker relay bookkeeping cannot overwrite a prompt fallback claim", async (t) => {
  const env = createEnv(t);
  createJob(terminalJob("job-worker-fallback", {
    status: "fallback_notified",
    hookNotifiedAt: "2026-07-10T12:00:00.000Z",
  }, env), env);

  await recordNotificationRelaySpawn("job-worker-fallback", 12345, env);
  const stored = readJob("job-worker-fallback", env);
  assert.equal(stored.notification.status, "fallback_notified");
  assert.equal(stored.notification.hookNotifiedAt, "2026-07-10T12:00:00.000Z");
  assert.equal(stored.notification.relayPid, undefined);
});

test("worker records relay metadata without overwriting notifier-owned delivering state", async (t) => {
  const env = createEnv(t);
  createJob(terminalJob("job-worker-delivering", {
    status: "delivering",
    attempts: 1,
  }, env), env);

  await recordNotificationRelaySpawn("job-worker-delivering", 23456, env);
  const stored = readJob("job-worker-delivering", env);
  assert.equal(stored.notification.status, "delivering");
  assert.equal(stored.notification.attempts, 1);
  assert.equal(stored.notification.relayPid, 23456);
  assert.match(stored.notification.relayStartedAt, /T/);
});

test("optional user notifications use argv-only platform commands and tolerate absence", () => {
  const calls = [];
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { on() {}, unref() {} };
  };
  const job = {
    id: "job-user-notify",
    name: "build $(touch /tmp/must-not-run)",
    nameExplicit: true,
    status: "completed",
    exitCode: 0,
    notifyUser: true,
    notifyUserExplicit: true,
  };
  launchUserNotification(job, {}, fakeSpawn, "darwin");
  launchUserNotification(job, {}, fakeSpawn, "linux");
  assert.equal(calls[0].command, "osascript");
  assert.equal(calls[0].options.shell, false);
  assert.match(calls[0].args.at(-1), /\$\(touch/);
  assert.equal(calls[1].command, "notify-send");
  assert.equal(calls[1].options.shell, false);
  assert.deepEqual(calls[1].args.slice(0, 4), ["--app-name", "Codex Process Jobs", "--", "Background job finished"]);
  assert.doesNotThrow(() => launchUserNotification(job, {}, () => { throw new Error("ENOENT"); }, "linux"));
  assert.equal(launchUserNotification({ ...job, notifyUser: false }, {}, fakeSpawn, "linux"), null);
});

test("surface-defaulted or unnamed notices never expose command-derived labels", () => {
  const calls = [];
  const fakeSpawn = (command, args) => {
    calls.push({ command, args });
    return { on() {}, unref() {} };
  };
  const base = {
    id: "job-user-notify-minimal",
    name: "cmake --build /Users/example/secret-project --target llama-cuda",
    status: "completed",
    exitCode: 0,
    notifyUser: true,
  };

  // Surface-defaulted notification: minimal notice even with an explicit name.
  launchUserNotification({ ...base, nameExplicit: true, notifyUserExplicit: false }, {}, fakeSpawn, "darwin");
  // Explicit opt-in but command-derived name: label suppressed.
  launchUserNotification({ ...base, nameExplicit: false, notifyUserExplicit: true }, {}, fakeSpawn, "darwin");
  // Legacy record without provenance fields: fails closed to minimal.
  launchUserNotification({ ...base }, {}, fakeSpawn, "darwin");

  assert.equal(calls.length, 3);
  for (const call of calls) {
    const message = call.args.at(-1);
    assert.equal(message, "job-user-notify-minimal finished completed; exit code 0.");
    assert.doesNotMatch(message, /cmake|secret-project|llama/);
  }
});

test("user notification labels remove controls and stay within 512 UTF-8 bytes", () => {
  const calls = [];
  const fakeSpawn = (command, args) => {
    calls.push({ command, args });
    return { on() {}, unref() {} };
  };
  launchUserNotification({
    id: "job-user-notify-bounded",
    name: `${"😀".repeat(200)}\nsecond line`,
    nameExplicit: true,
    status: "failed",
    exitCode: 2,
    notifyUser: true,
    notifyUserExplicit: true,
  }, {}, fakeSpawn, "linux");
  const message = calls[0].args.at(-1);
  const label = message.slice(0, message.indexOf(" (job-user-notify-bounded)"));
  assert.ok(Buffer.byteLength(label, "utf8") <= 512);
  assert.doesNotMatch(label, /[\n\r]/);
});
