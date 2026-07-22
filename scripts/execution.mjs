import fs from "node:fs";

const SHELL_PROGRAMS = Object.freeze({
  bash: "/bin/bash",
  "posix-sh": "/bin/sh",
});

export function isExecutionDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (value.kind === "argv") return keys.length === 1 && keys[0] === "kind";
  return value.kind === "shell"
    && ["bash", "posix-sh"].includes(value.interpreter)
    && keys.length === 2
    && keys[0] === "interpreter"
    && keys[1] === "kind";
}

export function assertExecutionAvailable(execution, accessSync = fs.accessSync) {
  if (execution.kind !== "shell") return;
  const program = SHELL_PROGRAMS[execution.interpreter];
  try {
    accessSync(program, fs.constants.X_OK);
  } catch {
    if (execution.interpreter === "bash") {
      throw new Error("Bash command mode requires executable /bin/bash. Install Bash or use --posix-sh for POSIX-compatible syntax.");
    }
    throw new Error("POSIX shell mode requires executable /bin/sh.");
  }
}

export function executionSummary(job) {
  if (job.schemaVersion === 1) {
    return job.shell
      ? { kind: "shell", interpreter: "legacy-posix-sh", program: "/bin/sh", arguments: ["-lc"] }
      : { kind: "argv" };
  }
  if (job.execution?.kind === "shell") {
    return {
      ...job.execution,
      program: SHELL_PROGRAMS[job.execution.interpreter],
      arguments: ["-c"],
    };
  }
  return { kind: "argv" };
}

export function buildSpawnSpec(job, env = process.env) {
  const execution = executionSummary(job);
  if (execution.kind === "argv") {
    return { command: job.argv[0], args: job.argv.slice(1), env };
  }
  if (execution.interpreter === "legacy-posix-sh") {
    return { command: execution.program, args: ["-lc", job.argv[0]], env };
  }
  const childEnv = { ...env };
  delete childEnv.BASH_ENV;
  delete childEnv.ENV;
  return { command: execution.program, args: ["-c", job.argv[0]], env: childEnv };
}

export function renderExecution(job) {
  const execution = executionSummary(job);
  if (execution.kind === "argv") return "direct argv";
  if (execution.interpreter === "legacy-posix-sh") return "legacy POSIX /bin/sh -lc";
  if (execution.interpreter === "bash") return "Bash /bin/bash -c";
  return "POSIX /bin/sh -c";
}
