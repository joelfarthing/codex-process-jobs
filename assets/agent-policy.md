## Detached local process jobs

- Use `$codex-process-jobs:start` for local commands likely to exceed about 60 seconds, have uncertain duration, or explicitly need detachment. Do not use it for interactive commands, persistent servers or watchers, daemonized processes, or fire-and-exit service launchers.
- A successful start is a hard turn boundary: report the job using the start skill's launch contract, then end the turn without status, tail, result, wait, sleep, `ps`, or other monitoring. Only an explicit request to keep that exact turn open permits one bounded wait. Resume dependent work through completion delivery, a later user turn, or an active Goal continuation.
- Follow the selected Codex Process Jobs skills for detailed safety, critical-job, Goal, progress, cancellation, and untrusted-output rules.
