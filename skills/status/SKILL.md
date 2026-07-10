---
name: status
description: Inspect active and recent detached process jobs, retrieve a lightweight activity preview, or wait briefly for one job to finish. Use for natural-language questions such as "how's the build going?", when checking test, inference, data-processing, or repair progress, when a Goal should continue monitoring, or when diagnosing a disappeared worker or process.
---

# Process Job Status

Resolve `<plugin-root>` as two directories above this `SKILL.md` and run:

```text
node "<plugin-root>/scripts/job.mjs" status $ARGUMENTS
```

Supported arguments:

- `[job-id]` for one job; omit it to list up to 20 recent jobs.
- `--name <text>` to select the newest active job whose name or command contains that text. Do not combine it with a job id.
- `--all` to list all stored jobs.
- `--wait` to wait for a selected job to become terminal.
- `--timeout-ms <1..55000>`; defaults to 55 seconds.
- `--poll-interval-ms <50..10000>`.
- `--json` for structured output.

For a question such as "how's the build going?", run `status --name build` when the label is clear. If it is unclear, list recent jobs first. A specific-job response reads only the state record, log metadata, and at most 8 KiB per stream to show the last four non-empty lines. Do not attach to the process or load full logs for a routine status check.

Use one `--wait` call instead of busy polling. If it times out, report that the detached process remains active. In an explicitly active Codex Goal, a later automatic continuation may call `--wait` again. Do not create a Goal merely because a job exists.

When a job is terminal, use `$result <job-id>` to inspect its bounded output. A stale active record is reconciled only after its tracked worker and process identities disappear; PID identity validation prevents treating an unrelated reused PID as the job.
