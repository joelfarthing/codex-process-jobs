## Detached local process jobs

- Use the enabled CPJ start skill for finite workloads exceeding 60s or uncertain duration. Classify workload, not wrapper latency. Task skills own preflight/correctness; CPJ owns lifecycle. For detached launchers, route foreground payload through CPJ or use a waiting mode. Exclude interactive commands, servers/watchers, daemonized work, remote jobs, and external services.
- A successful start is an absolute turn boundary. Report it per the start skill. End the turn without status, tail, result, wait, sleep, `ps`, or other monitoring. A request for an eventual final report does not permit same-turn waiting. Resume dependent work through completion delivery, a user turn, or an active Goal continuation.
- Follow selected CPJ skills. Never search memory for CPJ work; use the current request and validated CPJ state.
