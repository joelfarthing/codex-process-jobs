---
name: tail
description: Read the latest bounded stdout or stderr from a tracked detached process job. Use to inspect live build progress, benchmark output, test failures, repair diagnostics, or other command output without loading the entire persisted log.
---

# Tail Process Job

Resolve `<plugin-root>` as two directories above this `SKILL.md` and run:

```text
node "<plugin-root>/scripts/job.mjs" tail $ARGUMENTS
```

Supported arguments:

- `[job-id]`; omit it for the most recent job.
- `--stdout`, `--stderr`, or `--both`; the default is both.
- `--bytes <1..1048576>`; the default is 65536 bytes per selected stream.

Return the controller output without silently removing warnings or truncation markers. Logs are capped by the worker, so a marker means earlier bytes were intentionally discarded while the process continued draining output.
