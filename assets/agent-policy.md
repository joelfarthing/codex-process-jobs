## Detached local process jobs

- Use the enabled CPJ start skill for finite workloads exceeding 60s or uncertain duration. Classify workload, not wrapper latency. Task skills own preflight/correctness; CPJ owns lifecycle. For detached launchers, route foreground payload through CPJ or use a waiting mode. Exclude interactive commands, servers/watchers, daemonized work, remote jobs, and external services.
- A successful start is a hard turn boundary: report it per the start skill, then end the turn without status, tail, result, wait, sleep, `ps`, or other monitoring. Only an explicit request to keep that exact turn open permits one bounded wait. Resume dependent work through completion delivery, a user turn, or an active Goal continuation.
- Follow selected CPJ skills. Never search memory for CPJ work; use the current request and validated CPJ state.
