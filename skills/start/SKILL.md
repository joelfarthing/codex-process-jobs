---
name: start
description: Launch a long-running local command as a durable detached process job with persisted status and bounded logs. Use proactively when the user says background, detach, don't block, or keep working; when a command may take over 60 seconds or has uncertain duration; and for CMake builds, test suites, inference/model A/B runs, data processing, or device repair that should survive Codex App, VS Code, or CLI exit.
---

# Start Process Job

Resolve `<plugin-root>` as two directories above this `SKILL.md`. Run the job controller from that active plugin root:

```text
node "<plugin-root>/scripts/job.mjs" start [options] -- <command> [args...]
```

## When to route here

Use this skill instead of a blocking shell call when any of these is true:

- The user asks to background, detach, or keep working while a command runs.
- A local command is likely to take longer than about 60 seconds or its duration is uncertain.
- The user is likely to want lightweight progress checks while the command runs.
- A build, test, inference, evaluation, data-processing, or repair process should survive the current Codex client closing.

Do not route quick commands here merely because detachment is possible. Do not use it when the command requires interactive stdin, intentionally daemonizes, or only starts work in an external service and then exits.

## Launch workflow

1. Require a concrete command and working directory. Do not invent consequential arguments.
2. Preserve argv exactly and shell-quote every argument for the current POSIX shell. Do not use `eval`.
3. Use direct argv mode by default. Use `--shell -- '<single command string>'` only when the authorized command requires pipes, redirection, globbing, or other shell syntax.
4. Add `--name <label>` when a concise recognizable label is useful.
5. Add `--critical` for filesystem/device repair, firmware operations, database migrations, destructive conversions, or any command whose interruption could worsen state.
6. Run the controller once and return its job id, status, and log paths.

Supported options before `--`:

- `--name <label>`
- `--cwd <absolute-or-relative-directory>`
- `--critical`
- `--shell`
  - `--no-notify` to opt out of the owning-thread completion turn
  - `--json`

## Safety and lifecycle

- Detached jobs receive no interactive stdin. If `sudo`, Polkit, a password, a confirmation, or any other prompt may be required, resolve that requirement in the foreground first. Prefer explicitly non-interactive forms such as `sudo -n` when appropriate.
- The launched command must remain in the foreground until its work is complete. Do not append `&` or use a daemonizing mode. If a command merely asks an external service to begin work and then exits, track that service through its own blocking/status interface instead.
- A job is machine-scoped and survives Codex App, IDE, or CLI exit. Never add session-exit cleanup.
- When the controller reports that owning-thread notification is pending, reply conversationally: “I've started that <job label> in the background as <job-id>. Completion will be recorded; a live notification may appear. After it finishes, I'll recap the outcome as soon as our conversation can pick it up. We can check status any time.” The completion relay uses a separate transport, so do not promise an immediate live wake, imply that an exchange before completion can report the outcome, or guarantee the first post-terminal prompt while notification delivery is still in flight. When notification is `disabled` or `unavailable`, explain the status/result fallback instead.
- Do not place secrets in argv or redirect secrets into tracked logs. The controller stores argv and cwd, but never persists the inherited environment.
- Critical jobs refuse cancellation unless the user later gives explicit approval and `$cancel` is invoked with `--force`.
- The notification relay resumes the owning persistent Codex thread through local app-server and starts a minimal synthetic completion turn containing sanitized job metadata only. It never embeds process output. After delivery settles, the bundled hook requires one short recap for every delivered completion on the first eligible ordinary non-status turn before handling the new request. Give that recap even if the synthetic assistant announcement already appears in model context, because context does not prove the assigning client rendered it. A possible one-time duplicate is intentional. Explicit status/result requests retrieve durable state directly.

For storage repair specifically, preserve the exact target device, mounted/unmounted state, and repair flags supplied by the user or current diagnostic evidence. Never infer a device node from name alone.
