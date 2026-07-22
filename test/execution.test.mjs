import assert from "node:assert/strict";
import test from "node:test";

import {
  assertExecutionAvailable,
  buildSpawnSpec,
  isExecutionDescriptor,
} from "../scripts/execution.mjs";

test("execution descriptors allow only fixed argv, Bash, and POSIX modes", () => {
  assert.equal(isExecutionDescriptor({ kind: "argv" }), true);
  assert.equal(isExecutionDescriptor({ kind: "shell", interpreter: "bash" }), true);
  assert.equal(isExecutionDescriptor({ kind: "shell", interpreter: "posix-sh" }), true);
  assert.equal(isExecutionDescriptor({ kind: "shell", interpreter: "/tmp/evil" }), false);
  assert.equal(isExecutionDescriptor({ kind: "argv", interpreter: "bash" }), false);
});

test("new Bash mode uses fixed non-login Bash and strips startup-file variables", () => {
  const spec = buildSpawnSpec({
    schemaVersion: 2,
    execution: { kind: "shell", interpreter: "bash" },
    argv: ["set -o pipefail; false | true"],
  }, { PATH: "/usr/bin:/bin", BASH_ENV: "/tmp/inject", ENV: "/tmp/inject-sh", SAFE: "yes" });
  assert.equal(spec.command, "/bin/bash");
  assert.deepEqual(spec.args, ["-c", "set -o pipefail; false | true"]);
  assert.equal(spec.env.BASH_ENV, undefined);
  assert.equal(spec.env.ENV, undefined);
  assert.equal(spec.env.SAFE, "yes");
});

test("new POSIX mode is explicit while legacy v1 shell jobs retain sh login semantics", () => {
  const posix = buildSpawnSpec({
    schemaVersion: 2,
    execution: { kind: "shell", interpreter: "posix-sh" },
    argv: ["printf portable"],
  });
  assert.equal(posix.command, "/bin/sh");
  assert.deepEqual(posix.args, ["-c", "printf portable"]);

  const legacy = buildSpawnSpec({ schemaVersion: 1, shell: true, argv: ["printf legacy"] });
  assert.equal(legacy.command, "/bin/sh");
  assert.deepEqual(legacy.args, ["-lc", "printf legacy"]);
});

test("shell availability checks fail before job creation with an actionable message", () => {
  assert.doesNotThrow(() => assertExecutionAvailable({ kind: "argv" }, () => {
    throw new Error("direct argv must not probe a shell");
  }));
  assert.throws(
    () => assertExecutionAvailable({ kind: "shell", interpreter: "bash" }, () => {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    }),
    /requires executable \/bin\/bash.*--posix-sh/i,
  );
});
