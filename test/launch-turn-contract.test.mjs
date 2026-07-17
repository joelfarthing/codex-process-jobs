import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("model-facing launch contracts require release without same-turn monitoring", () => {
  const startSkill = read("skills/start/SKILL.md");
  const statusSkill = read("skills/status/SKILL.md");
  const agentPolicy = read("assets/agent-policy.md");

  assert.match(startSkill, /hard launch-turn release boundary/i);
  assert.match(startSkill, /do not read the status skill or call status, tail, result, `--wait`, `write_stdin`, sleep, `ps`/i);
  assert.match(startSkill, /if the same user request includes independent work/i);
  assert.match(startSkill, /later automatic continuation of an explicitly active Goal/i);
  assert.match(startSkill, /Add `--goal-mode` only when this command belongs to an explicitly active Codex Goal/i);
  assert.match(startSkill, /only an explicit user request to keep this exact Codex turn open and wait/i);
  assert.match(startSkill, /if the job becomes terminal, bounded result inspection is allowed in the same turn/i);
  assert.match(statusSkill, /never use it to monitor a job from the same turn that launched it/i);
  assert.match(statusSkill, /use at most one `--wait` call in a Codex turn/i);
  assert.match(statusSkill, /later automatic continuation may make one new bounded wait/i);
  assert.match(statusSkill, /Do not check the job merely because a `Continue` turn arrived/i);
  assert.match(statusSkill, /make exactly one bounded `status <job-id> --wait` call/i);
  assert.match(statusSkill, /continue the next already-authorized in-scope Goal step/i);
  assert.match(statusSkill, /inspect the bounded result in the same turn only if the job becomes terminal/i);
  assert.match(agentPolicy, /successful detached start is a hard release boundary/i);
  assert.match(agentPolicy, /durable job state and the completion relay provide persistence/i);
  assert.match(agentPolicy, /never create a Goal merely because a job exists/i);
  assert.match(agentPolicy, /pass `--goal-mode`/i);
});

test("surface smoke prompt does not coach the release behavior it evaluates", () => {
  const smokeDocument = read("docs/surface-smoke-test.md");
  const prompt = /```text\n([\s\S]*?)\n```/.exec(smokeDocument)?.[1] ?? "";

  assert.match(prompt, /\$codex-process-jobs:start/);
  assert.doesNotMatch(prompt, /return immediately|end the turn|without calling status|do not (?:wait|monitor|poll)/i);
  assert.match(smokeDocument, /without the user prompt coaching this behavior/i);
});
