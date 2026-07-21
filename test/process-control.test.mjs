import assert from "node:assert/strict";
import test from "node:test";

import {
  getProcessIdentity,
  parseLinuxProcStat,
  quoteArg,
  renderCommand,
  terminateTrackedProcess,
} from "../scripts/process-control.mjs";

test("parses Linux /proc stat when the process name contains spaces and parentheses", () => {
  const fields = Array.from({ length: 40 }, (_, index) => String(index + 3));
  fields[19] = "987654321";
  const stat = `4321 (model worker (A)) ${fields.join(" ")}`;
  assert.equal(parseLinuxProcStat(stat), "987654321");
});

test("builds a Linux process identity from immutable starttime", () => {
  const fields = Array.from({ length: 40 }, (_, index) => String(index + 3));
  fields[19] = "555";
  const identity = getProcessIdentity(99, {
    platform: "linux",
    readFileSync: () => `99 (node) ${fields.join(" ")}`,
  });
  assert.equal(identity, "linux:555");
});

test("builds a Darwin process identity from ps start time and command", () => {
  const identity = getProcessIdentity(88, {
    platform: "darwin",
    spawnSyncImpl: () => ({
      status: 0,
      stdout: "Fri Jul 10 12:34:56 2026 /usr/bin/node\n",
      stderr: "",
      error: null,
    }),
  });
  assert.equal(identity, "darwin:Fri Jul 10 12:34:56 2026 /usr/bin/node");
});

test("renders direct argv without allowing shell metacharacters to escape", () => {
  assert.equal(quoteArg("plain/path"), "plain/path");
  assert.equal(quoteArg("a b"), "'a b'");
  assert.equal(quoteArg("it's"), "'it'\"'\"'s'");
  assert.equal(renderCommand(["printf", "%s", "a b"]), "printf %s 'a b'");
  assert.equal(renderCommand(["echo hi | tee out"], true), "echo hi | tee out");
});

test("escalates from SIGTERM to SIGKILL and confirms identity disappearance", async () => {
  let alive = true;
  const signals = [];
  const result = await terminateTrackedProcess(123, "identity", {
    graceMs: 5,
    pollMs: 1,
    validateIdentity: () => alive,
    killImpl: (pid, signal) => {
      if (signal === 0) {
        if (alive) return;
        const error = new Error("gone");
        error.code = "ESRCH";
        throw error;
      }
      assert.equal(pid, -123);
      signals.push(signal);
      if (signal === "SIGKILL") alive = false;
    },
  });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(result, { terminated: true, forced: true });
});

test("escalates against the validated process group after its leader exits", async () => {
  let leaderAlive = true;
  let groupAlive = true;
  const signals = [];
  const result = await terminateTrackedProcess(123, "identity", {
    graceMs: 5,
    pollMs: 1,
    validateIdentity: () => leaderAlive,
    killImpl: (pid, signal) => {
      if (pid === 123 && signal === 0) {
        if (leaderAlive) return;
        const error = new Error("leader exited");
        error.code = "ESRCH";
        throw error;
      }
      assert.equal(pid, -123);
      if (signal === 0) {
        if (groupAlive) return;
        const error = new Error("group exited");
        error.code = "ESRCH";
        throw error;
      }
      signals.push(signal);
      if (signal === "SIGTERM") leaderAlive = false;
      if (signal === "SIGKILL") groupAlive = false;
    },
  });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(result, { terminated: true, forced: true });
});

test("does not signal the group after a different process reuses the leader PID", async () => {
  let leaderMatches = true;
  let replacementAlive = false;
  const signals = [];
  const result = await terminateTrackedProcess(123, "identity", {
    graceMs: 5,
    pollMs: 1,
    validateIdentity: () => leaderMatches,
    killImpl: (pid, signal) => {
      if (pid === 123 && signal === 0) {
        if (replacementAlive) return;
        const error = new Error("pid is free");
        error.code = "ESRCH";
        throw error;
      }
      assert.equal(pid, -123);
      if (signal === 0) return;
      signals.push(signal);
      if (signal === "SIGTERM") {
        leaderMatches = false;
        replacementAlive = true;
      }
    },
  });
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.deepEqual(result, { terminated: true, forced: false });
});

test("refuses to signal a PID whose identity changed", async () => {
  let signalled = false;
  const result = await terminateTrackedProcess(123, "old-identity", {
    validateIdentity: () => false,
    killImpl: () => {
      signalled = true;
    },
  });
  assert.equal(signalled, false);
  assert.deepEqual(result, { terminated: false, reason: "process identity mismatch" });
});
