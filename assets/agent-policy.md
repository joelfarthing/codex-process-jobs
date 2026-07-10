## Detached local process jobs

- When a local command is likely to run longer than about 60 seconds, has uncertain duration, or the user asks to keep working while it runs, use `$codex-process-jobs:start` instead of holding the Codex task in a blocking shell call.
- This applies especially to CMake builds, long test suites, inference or evaluation runs, data processing, and device or filesystem repair.
- Use direct argv mode by default. Resolve all passwords, confirmations, `sudo`, Polkit, and other interactive input before detaching.
- Mark repair, firmware, migration, or destructive work `--critical`. Never force-cancel a critical job without the user's explicit risk-aware approval.
- Answer lightweight progress questions with `$codex-process-jobs:status`; use `$codex-process-jobs:tail` only when more output is needed and `$codex-process-jobs:result` after completion.
- When start reports owning-thread notification as pending, respond conversationally. In Codex App or CLI, say that the process will notify this task when it finishes. When start identifies VS Code or reports `durable-refresh-required`, say that completion will be recorded but the open panel may not visibly wake until reload, and that status is available any time. Never promise live notification when notification is disabled, unavailable, or subject to the VS Code refresh limitation.
- Do not use the plugin for commands that require interactive stdin, intentionally daemonize, or merely ask an external service to begin work and then exit.
