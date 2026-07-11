# Codex Process Jobs

Codex Process Jobs is a dependency-free Codex plugin for launching ordinary macOS or Linux commands as durable detached process jobs. It is intended for work such as CMake builds, long test suites, inference A/B runs, data processing, and repair utilities that should not monopolize an active Codex turn.

The runtime tracks process identity, status, bounded stdout/stderr, exit status, and safe cancellation metadata under `$CODEX_HOME/process-jobs` (normally `~/.codex/process-jobs`). Jobs are machine-scoped and survive Codex App, IDE, or CLI exit.

## Status

The process broker and personal-plugin installation flow are functional and tested on macOS. Fresh Codex App, Codex CLI, and Codex VS Code extension tasks have discovered the installed skills and completed detached launches. In all three surfaces, an external process resumed its owning thread through app-server and produced a separate conversational completion turn without polling or a subagent.

Codex App and CLI expose the appended completion turn directly. Already-open VS Code webviews and mobile ChatGPT clients driving a remote execution host can retain a stale assigning-agent context even after a separate app-server process durably appends the completion turn. The job state and completion turn remain durable, and a one-shot next-prompt hook informs refresh-required or refresh-uncertain surfaces on the next ordinary non-status turn. Explicit status/result requests retrieve durable state directly.

The repository includes a repeatable surface test for every client. The app-server relay is best-effort because app-server is currently experimental. A one-shot next-prompt hook plus explicit status/result retrieval are the durable fallbacks.

Conversation can continue normally while a job runs. When it finishes, the notifier and next-prompt hook atomically claim one presentation path: a live direct delivery blocks prompt fallback, while a prompt fallback that wins first suppresses later direct delivery. Stale notifier attempts remain recoverable.

The client and execution host are independent Cartesian axes. See [Cartesian client and execution surfaces](docs/cartesian-surfaces.md), [Conversational completion relay](docs/notification-relay.md), and [VS Code completion wake research](docs/vscode-wake-research-and-process.md).

## Requirements

- macOS or Linux
- Node.js 18 or newer
- A Codex client with local plugin support

No runtime npm packages are required.

## Installation

Clone or copy the repository to any local directory. The installer is deliberately two-phase: its default mode only shows the source, destination, marketplace, optional agent policy, Codex CLI, and active-job check.

When Codex performs the installation, it must show and describe this preview, then explicitly ask whether the user wants the optional managed policy in global `~/.codex/AGENTS.md`. A request to install the plugin does not imply consent to change global agent instructions.

```bash
node scripts/install.mjs
```

After reviewing that plan, apply it:

```bash
node scripts/install.mjs --apply
```

This copies a runtime-only snapshot to `~/plugins/codex-process-jobs`, creates or updates only the matching entry in `~/.agents/plugins/marketplace.json`, enables Codex hooks, and runs `codex plugin add codex-process-jobs@<personal-marketplace-name>`. It then asks local app-server to trust only this installed plugin's current hook hash. Existing plugin and configuration files are backed up, and a pre-install failure rolls the local source snapshot and configuration back.

If automatic hook trust is unavailable, the installer reports that clearly and leaves `/hooks` as the manual review path. Direct app-server completion delivery does not depend on the fallback hook being trusted.

The installer refuses to replace the plugin while tracked jobs are active. `--allow-active-jobs` is an explicit escape hatch after inspecting those jobs.

Start a fresh Codex task after installation so the client picks up the skills.

### Encourage automatic use

Skill descriptions make Codex route explicit requests such as “background this build” or “keep working while this runs” to the plugin. For a stronger personal default across Codex App, VS Code, CLI, and mobile-driven remote tasks, preview the optional global agent policy on each execution host:

```bash
node scripts/install.mjs --with-agent-policy
```

Then apply it only after reviewing the target `~/.codex/AGENTS.md` path:

```bash
node scripts/install.mjs --apply --with-agent-policy
```

The managed block is idempotent and preserves unrelated instructions. See [Agent adoption policy](docs/agent-policy.md).

### Host and surface scope

Codex App, the local VS Code extension, and Codex CLI share the installation on one host. If VS Code or ChatGPT mobile drives Codex on another execution host through Remote SSH, remote tasks, a Dev Container, WSL, or another bridge, install the plugin in that execution environment too. On Linux, run the same preview/apply flow under the account that runs Codex.

## Commands

The bundled skills expose the controller through the plugin namespace after installation:

```text
$codex-process-jobs:start --name build -- cmake --build build
$codex-process-jobs:start --no-notify --name quiet-build -- cmake --build build
$codex-process-jobs:status
$codex-process-jobs:status --name build
$codex-process-jobs:status <job-id> --wait
$codex-process-jobs:tail <job-id> --stderr
$codex-process-jobs:result <job-id>
$codex-process-jobs:cancel <job-id>
```

The controller can also be exercised directly from the repository:

```bash
node scripts/job.mjs start --name build -- cmake --build build
node scripts/job.mjs start --no-notify --name quiet-build -- cmake --build build
node scripts/job.mjs status
node scripts/job.mjs status --name build
node scripts/job.mjs status JOB_ID --wait
node scripts/job.mjs tail JOB_ID --both
node scripts/job.mjs result JOB_ID
node scripts/job.mjs cancel JOB_ID
```

Use explicit shell mode only when pipes, redirection, globbing, or other shell syntax is required:

```bash
node scripts/job.mjs start --shell -- 'cmake --build build 2>&1 | tee build.log'
```

## Critical jobs

Use `--critical` when interruption could worsen state, including filesystem or device repair, firmware operations, database migrations, and destructive conversions:

```bash
node scripts/job.mjs start --critical --name usb-repair -- repair-command --exact --arguments
```

Critical jobs refuse cancellation unless `--force` is explicitly supplied. `--force` bypasses the guard but still sends SIGTERM first, waits five seconds, and uses SIGKILL only if required.

Detached jobs receive no interactive stdin. Resolve password, `sudo`, Polkit, confirmation, and other prompt requirements before launch. Commands must remain in the foreground until their work is complete; daemonized work or a request handed off to an external service requires that service's own status mechanism.

Specific-job status checks are deliberately lightweight. They read the job record, stat the two bounded logs, and inspect at most 8 KiB per stream for four recent lines. This supports quick follow-up questions such as “how's the build going?” without attaching to or disturbing the running process.

When the owning persistent task is available, start reports notification as `pending`. In a known live Codex App or CLI surface, the agent can say naturally: “I've started that build in the background. The process will notify me here when it finishes.” On VS Code or a refresh-uncertain remote surface, it explains that completion will be recorded, the client may not refresh its context immediately, the assigning agent will learn the outcome on the next exchange, and status is available any time. See [Conversational completion relay](docs/notification-relay.md).

## Safety model

- The runtime stores argv, cwd, timestamps, job state, and log paths. It does not persist the inherited environment.
- Do not put credentials or other secrets in argv or tracked output.
- Process cancellation validates a stable process identity before signaling the detached process group, reducing PID-reuse risk.
- Jobs are never cancelled merely because a Codex task or client exits.
- Completion delivery uses a normal Codex turn and consumes normal Codex usage. Use `--no-notify` for polling-only jobs.
- Synthetic completion turns contain only job id, terminal status, and exit code. Command text, labels, paths, environment, and process output are excluded.
- Logs are private and capped per stream. Set `CODEX_PROCESS_JOBS_MAX_LOG_BYTES` to change the default 16 MiB cap.
- Exit code zero proves only that the command succeeded; higher-level results still require domain-specific verification.

## Development

```bash
npm run check
npm run smoke
```

The test suite covers real detached launches, app-server completion relay, prompt-data isolation, next-prompt hook fallback, result persistence, bounded output, critical cancellation, shell mode, atomic concurrent state updates, Darwin/Linux process-identity parsing, installer rollback boundaries, marketplace preservation, hook trust, and idempotent agent-policy insertion. GitHub Actions runs on macOS and Ubuntu with Node.js 18 and 22 once this repository is published.

Use [the surface smoke test](docs/surface-smoke-test.md) after installation to verify skill discovery independently in Codex App, VS Code, CLI, and mobile-to-remote tasks.

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Joel Farthing.
