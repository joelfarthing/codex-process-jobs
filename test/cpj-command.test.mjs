import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { controllerInvocations } from "../scripts/cpj-command.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const CONTROLLER = path.join(ROOT, "scripts", "job.mjs");
const parse = (command) => controllerInvocations(command, { controllerPath: CONTROLLER, cwd: ROOT });

test("shared parser recognizes quoted controller paths with start and rerun", () => {
  assert.deepEqual(
    parse(`node "${CONTROLLER}" start --json -- printf ready`),
    [{ action: "start", args: ["--json", "--", "printf", "ready"], controllerIndex: 1, command: ["node", CONTROLLER] }],
  );
  assert.deepEqual(
    parse(`node '${CONTROLLER}' rerun job-finished-001 --json`),
    [{ action: "rerun", args: ["job-finished-001", "--json"], controllerIndex: 1, command: ["node", CONTROLLER] }],
  );
});

test("shared parser handles shell prefixes and assignments", () => {
  assert.deepEqual(parse(`CPJ_MODE=1 command node "${CONTROLLER}" start --json`).map(({ action }) => action), ["start"]);
  assert.deepEqual(parse(`env CPJ_MODE=1 node "${CONTROLLER}" rerun job-finished-001 --json`).map(({ action }) => action), ["rerun"]);
  assert.deepEqual(parse(`time node "${CONTROLLER}" status --wait job-running-001`).map(({ action }) => action), ["status"]);
});

test("controller paths in inert text do not become invocations", () => {
  assert.deepEqual(parse(`printf '%s\\n' '${CONTROLLER} start --json'`), []);
  assert.deepEqual(parse(`echo "${CONTROLLER} status --wait job-running-001"`), []);
});

