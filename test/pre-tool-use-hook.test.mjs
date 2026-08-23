import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { classifyCommand, evaluateHook, lexShell } from "../hooks/pre-tool-use-hook.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "hooks", "pre-tool-use-hook.mjs");

function input(command, overrides = {}) {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    cwd: ROOT,
    tool_input: { command },
    ...overrides,
  };
}

function launchedJob(overrides = {}) {
  return {
    id: "job-same-turn-001",
    ownerThreadId: "thread-same-turn-001",
    notification: { launchBoundaryTurnId: "turn-same-turn-001" },
    ...overrides,
  };
}

function runHook(payload, env = {}) {
  return spawnSync(process.execPath, [HOOK], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    input: JSON.stringify(payload),
  });
}

test("ignores unrelated hook events and malformed Bash payloads", () => {
  assert.equal(evaluateHook(input("python eval.py", { hook_event_name: "PostToolUse" })), null);
  assert.equal(evaluateHook(input("python eval.py", { tool_name: "Read" })), null);
  assert.equal(evaluateHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }), null);
});

test("allows explicit foreground escapes", () => {
  for (const command of [
    "# cpj:foreground\npython eval.py",
    "  # CPJ:FOREGROUND because the user requested it\ncurl -O https://example.test/model.gguf",
    "CPJ_FOREGROUND=1 python eval.py",
  ]) {
    assert.equal(classifyCommand(command).reason, "explicit-foreground", command);
  }
});

test("allows CPJ controller commands without recursion", () => {
  for (const action of ["start", "rerun", "status", "tail", "result", "cancel", "config"]) {
    const command = `node \"${path.join(ROOT, "scripts", "job.mjs")}\" ${action} --json`;
    assert.equal(classifyCommand(command).decision, "allow", action);
  }
});

test("spawned subagents cannot own CPJ launches or reruns", () => {
  const commands = [
    `node "${path.join(ROOT, "scripts", "job.mjs")}" start --name proof --cwd /tmp --json -- node /tmp/proof.mjs`,
    `node "${path.join(ROOT, "scripts", "job.mjs")}" rerun job-finished-001 --json`,
  ];
  for (const command of commands) {
    const decision = evaluateHook(input(command, { session_id: "thread-spawned-child-001" }), {
      list: () => [],
      isSubagent: () => true,
    });
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny", command);
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /does not let a spawned subagent own a process job/i);
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /blocked before it created or reran a job/i);
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /parent must launch it once through CPJ itself/i);
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /routing handoff, not as a workload failure/i);
  }
});

test("spawned subagents cannot foreground qualifying workloads even with an escape", () => {
  const commands = [
    "node /tmp/cpj-pretool-long-proof.mjs",
    "# cpj:foreground\nnode /tmp/cpj-pretool-long-proof.mjs",
    "CPJ_FOREGROUND=1 python eval.py --model qwen.gguf",
  ];
  for (const command of commands) {
    const decision = evaluateHook(input(command, { session_id: "thread-spawned-child-001" }), {
      list: () => [],
      isSubagent: () => true,
    });
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny", command);
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /spawned subagent/i);
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /blocked local process execution inside a spawned subagent/i);
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /Do not execute, launch, retry, wait for, or monitor/i);
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /user-visible parent/i);
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /parent must classify and launch it once through CPJ when eligible/i);
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /routing handoff, not as a workload failure/i);
  }
});

test("spawned subagents may use bounded CPJ inspection commands and ordinary short commands", () => {
  const commands = [
    `node "${path.join(ROOT, "scripts", "job.mjs")}" status job-finished-001 --json`,
    `node "${path.join(ROOT, "scripts", "job.mjs")}" result job-finished-001 --peek --json`,
    "git status --short",
  ];
  for (const command of commands) {
    assert.equal(evaluateHook(input(command, { session_id: "thread-spawned-child-001" }), {
      list: () => [],
      isSubagent: () => true,
    }), null, command);
  }
});

test("blocks same-turn monitoring of a newly launched job even with the foreground escape", () => {
  const context = {
    session_id: "thread-same-turn-001",
    turn_id: "turn-same-turn-001",
  };
  const commands = [
    `node "${path.join(ROOT, "scripts", "job.mjs")}" status job-same-turn-001 --wait --json`,
    `# cpj:foreground\nnode "${path.join(ROOT, "scripts", "job.mjs")}" tail job-same-turn-001 --json`,
    `CPJ_FOREGROUND=1 node "${path.join(ROOT, "scripts", "job.mjs")}" result job-same-turn-001 --peek --json`,
    `node "${path.join(ROOT, "scripts", "job.mjs")}" status --json`,
  ];
  for (const command of commands) {
    const decision = evaluateHook(input(command, context), {
      list: () => [launchedJob()],
      env: { CODEX_THREAD_ID: context.session_id },
    });
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny", command);
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /absolute launch-turn release boundary/i);
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /eventual completion summary/i);
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /cannot override/i);
  }
});

test("same-turn monitoring guard follows the actual subagent launch thread", () => {
  const decision = evaluateHook(input(
    `node "${path.join(ROOT, "scripts", "job.mjs")}" result job-same-turn-001 --peek --json`,
    {
      session_id: "thread-spawned-launch-001",
      turn_id: "turn-same-turn-001",
    },
  ), {
    list: () => [launchedJob({
      ownerThreadId: "thread-user-visible-parent-001",
      launchThreadId: "thread-spawned-launch-001",
    })],
    env: { CODEX_THREAD_ID: "thread-spawned-launch-001" },
  });
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /absolute launch-turn release boundary/i);
});

test("same-turn guard permits unrelated CPJ records and later turns", () => {
  const command = `node "${path.join(ROOT, "scripts", "job.mjs")}" result job-older-record-001 --peek --json`;
  assert.equal(evaluateHook(input(command, {
    session_id: "thread-same-turn-001",
    turn_id: "turn-same-turn-001",
  }), { list: () => [launchedJob()] }), null);
  assert.equal(evaluateHook(input(command.replace("job-older-record-001", "job-same-turn-001"), {
    session_id: "thread-same-turn-001",
    turn_id: "turn-later-002",
  }), { list: () => [launchedJob()] }), null);
});

test("blocks CPJ memory searches after a launch boundary in the same turn", () => {
  const decision = evaluateHook(input("# cpj:foreground\nsed -n '1,20p' /tmp/.codex/memories/MEMORY.md", {
    session_id: "thread-same-turn-001",
    turn_id: "turn-same-turn-001",
  }), {
    list: () => [launchedJob()],
    env: { CODEX_THREAD_ID: "thread-same-turn-001" },
  });
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /memory search/i);
});

test("allows obvious bounded inspections and compounds", () => {
  const commands = [
    "pwd",
    "rg -n 'needle' src | head -20",
    "git status --short && git diff --stat",
    "test -f package.json && sed -n '1,40p' package.json",
    "printf '%s\\n' 'curl https://example.test/large-file'",
    "mkdir -p /tmp/cpj-test && touch /tmp/cpj-test/marker",
    "sleep 1",
  ];
  for (const command of commands) assert.equal(classifyCommand(command).decision, "allow", command);
});

test("challenges arbitrary inference, download, conversion, and project commands", () => {
  const commands = [
    "python eval.py --model qwen.gguf",
    "./run-inference --profile ab-test",
    "opaque-project-wrapper --do-the-thing",
    "curl -L https://example.test/model.gguf -o model.gguf",
    "wget https://example.test/archive.tar.zst",
    "hf download org/model model.gguf",
    "node convert-model.mjs input output",
    "cmake --build build -j8",
    "ninja -C build",
    "pytest -q",
    "git clone https://example.test/repo.git",
    "find / -name '*.gguf'",
    "du -sh /Users/joelfarthing",
  ];
  for (const command of commands) assert.equal(classifyCommand(command).decision, "challenge", command);
});

test("does not exempt an unrelated script merely because its suffix resembles CPJ", () => {
  assert.equal(
    classifyCommand("node /tmp/unrelated/scripts/job.mjs start --json").decision,
    "challenge",
  );
});

test("challenges an uncertain member of a compound command", () => {
  for (const command of [
    "cd /tmp && python inference.py",
    "env CUDA_VISIBLE_DEVICES=0 ./benchmark --all",
    "time custom-downloader artifact",
    "bash -lc 'curl -O https://example.test/model.gguf'",
    "printf ready && sleep 75 && printf done",
  ]) {
    assert.equal(classifyCommand(command).decision, "challenge", command);
  }
});

test("allows interactive, persistent, and already-detached commands", () => {
  const commands = [
    "ssh halfeagle",
    "vim README.md",
    "bash",
    "tail -f service.log",
    "journalctl --follow -u service",
    "npm run dev",
    "docker compose up",
    "unknown-worker --forever &",
    "nohup unknown-worker >worker.log 2>&1 &",
  ];
  for (const command of commands) assert.equal(classifyCommand(command).decision, "allow", command);
});

test("requires a real background operator for nohup and setsid", () => {
  for (const command of [
    "nohup python eval.py",
    "setsid python eval.py",
  ]) {
    assert.equal(classifyCommand(command).decision, "challenge", command);
  }
  assert.equal(classifyCommand("disown").decision, "allow");
});

test("does not mistake ordinary stderr redirection for detachment", () => {
  assert.equal(classifyCommand("python eval.py >run.log 2>&1").decision, "challenge");
  assert.equal(classifyCommand("python eval.py &>run.log").decision, "challenge");
});

test("lexer does not interpret quoted command names as executable commands", () => {
  const tokens = lexShell("printf '%s\\n' 'python eval.py && curl URL'");
  assert.equal(tokens.filter((token) => token.type === "operator").length, 0);
  assert.equal(classifyCommand("printf '%s\\n' 'python eval.py && curl URL'").decision, "allow");
});

test("PreToolUse denial is concise, branded, and contains the foreground escape", () => {
  const decision = evaluateHook(input("custom-inference --model foo"), {
    isSubagent: () => false,
    env: {},
  });
  assert.equal(decision.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /Codex Process Jobs/);
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /finite and may exceed 60 seconds or has uncertain duration/);
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /# cpj:foreground/);
  assert.doesNotMatch(decision.hookSpecificOutput.permissionDecisionReason, /cmake|ninja|download|inference/i);
});

test("executable hook emits a denial and otherwise stays silent", () => {
  const denied = runHook(input("curl -O https://example.test/model.gguf"));
  assert.equal(denied.status, 0);
  assert.equal(denied.stderr, "");
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");

  const allowed = runHook(input("git status --short"));
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout, "");
  assert.equal(allowed.stderr, "");

  const malformed = runHook("not-json");
  assert.equal(malformed.status, 0);
  assert.equal(malformed.stdout, "");
  assert.equal(malformed.stderr, "");
});

test("executable hook detects a spawned subagent from validated rollout metadata", (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-pretool-subagent-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const parent = "thread-user-visible-parent-001";
  const child = "thread-spawned-child-001";
  const directory = path.join(codexHome, "sessions", "2026", "08", "23");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `rollout-test-${child}.jsonl`), `${JSON.stringify({
    type: "session_meta",
    payload: {
      id: child,
      session_id: parent,
      thread_source: "subagent",
      parent_thread_id: parent,
      source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } },
    },
  })}\n`);

  const result = runHook(input(
    "# cpj:foreground\nnode /tmp/cpj-pretool-long-proof.mjs",
    { session_id: parent },
  ), { CODEX_HOME: codexHome, CODEX_THREAD_ID: child });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /spawned subagent/i);
});
