---
name: result
description: Retrieve terminal metadata and bounded stdout/stderr for a finished detached process job. Use after a build, test, inference run, data job, or repair command completes or fails and Codex needs to interpret the outcome and continue the original work.
---

# Process Job Result

Resolve `<plugin-root>` as two directories above this `SKILL.md` and run:

```text
node "<plugin-root>/scripts/job.mjs" result $ARGUMENTS
```

Supported arguments:

- `[job-id]`; omit it for the most recent job.
- `--bytes <1..1048576>`; defaults to the last 65536 bytes of each stream.
- `--full` to print each complete bounded log.
- `--json` for structured output.

Report status, exit code or signal, and the output evidence relevant to the original task. Treat an exit code of zero as process success, not proof that the higher-level operation achieved its intended result. For device or filesystem work, inspect the tool's own final diagnostic before claiming the medium is repaired.
