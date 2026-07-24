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
  assert.match(startSkill, /yielded-session rule/i);
  assert.match(startSkill, /inspect a result only after an explicit terminal CPJ state/i);
  assert.match(statusSkill, /never use it to monitor a job from the same turn that launched it/i);
  assert.match(statusSkill, /use at most one `--wait` call in a Codex turn/i);
  assert.match(statusSkill, /cell or session ID.*not blank output/i);
  assert.match(statusSkill, /resume only that exact yielded execution at most once/i);
  assert.match(statusSkill, /never launch a replacement status command/i);
  assert.match(statusSkill, /only an explicit terminal CPJ state/i);
  assert.match(statusSkill, /Do not check the job merely because a `Continue` turn arrived/i);
  assert.match(statusSkill, /automatic continuation is not a status request/i);
  assert.match(statusSkill, /do not invoke this skill, wait, sleep, or probe the process/i);
  assert.match(statusSkill, /Apply the host Goal blocked audit/i);
  assert.match(statusSkill, /Count the immediately preceding launch turn when it ended with this same job as the sole blocker/i);
  assert.match(statusSkill, /continue the next already-authorized in-scope Goal step/i);
  assert.match(statusSkill, /inspect the bounded result in the same turn only if the job becomes terminal/i);
  assert.match(agentPolicy, /successful start is a hard turn boundary/i);
  assert.match(agentPolicy, /without status, tail, result, wait, sleep, `ps`, or other monitoring/i);
  assert.match(agentPolicy, /only an explicit request to keep that exact turn open permits one bounded wait/i);
  assert.match(agentPolicy, /follow the selected Codex Process Jobs skills/i);
  assert.match(agentPolicy, /servers\/watchers/i);
  assert.match(agentPolicy, /Classify workload, not wrapper latency/i);
  assert.match(agentPolicy, /Task skills own preflight\/correctness; CPJ owns lifecycle/i);
  assert.match(agentPolicy, /detached launchers, route foreground payload through CPJ/i);
  assert.ok(agentPolicy.split(/\s+/).filter(Boolean).length <= 140);
});

test("model-facing routing contract composes task workflows without tracking quick wrappers", () => {
  const startSkill = read("skills/start/SKILL.md");
  const routingTest = read("docs/routing-acceptance-test.md");

  assert.match(startSkill, /Task-specific skills own command construction, preflight checks, arguments, and correctness gates/i);
  assert.match(startSkill, /CPJ owns execution lifecycle for qualifying finite local workloads/i);
  assert.match(startSkill, /do not pass that launcher through CPJ unchanged/i);
  assert.match(startSkill, /remains alive until the workload finishes and propagates its terminal status/i);
  assert.match(startSkill, /never use `eval`/i);

  assert.match(routingTest, /job-runner --detach/);
  assert.match(routingTest, /avoid tracking the quick `job-runner --detach` wrapper unchanged/i);
  assert.match(routingTest, /release the assigning turn after the successful CPJ start/i);
  assert.match(routingTest, /Persistent development server/i);
  assert.match(routingTest, /Externally owned remote batch job/i);
  assert.match(routingTest, /Focused quick test/i);
});

test("surface smoke prompt does not coach the release behavior it evaluates", () => {
  const smokeDocument = read("docs/surface-smoke-test.md");
  const prompt = /```text\n([\s\S]*?)\n```/.exec(smokeDocument)?.[1] ?? "";

  assert.match(prompt, /\$codex-process-jobs:start/);
  assert.doesNotMatch(prompt, /return immediately|end the turn|without calling status|do not (?:wait|monitor|poll)/i);
  assert.match(smokeDocument, /without the user prompt coaching this behavior/i);
});
