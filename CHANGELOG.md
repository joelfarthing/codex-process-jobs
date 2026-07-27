# Changelog

Notable changes to Codex Process Jobs are documented here. The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) beginning with its first public beta.

## [Unreleased]

### Added

- Completion-wake research for Codex CLI/TUI with binary-level evidence that
  the private thread-follower wake transport terminates in the App and VS Code
  client layers, plus a draft upstream feature request for a supported TUI
  wake path. See
  [docs/cli-wake-research-and-upstream-proposal.md](docs/cli-wake-research-and-upstream-proposal.md).

### Changed

- CLI-owned jobs now default to one human-facing desktop completion notice,
  because an already-open Codex TUI cannot render the completion turn live. An
  explicit `--notify-user`/`--no-notify-user` launch flag or the durable
  `config --notify-user true|false` preference still wins; an absent durable
  preference is now stored as unset instead of an implicit opt-out, and
  `config --notify-user default` clears a stored preference so the surface
  default applies again. Preference files written by earlier versions may
  contain `notifyUser: false` from the old implicit default; that value still
  reads as an opt-out until cleared.
- Desktop notices now include a label only when notification was explicitly
  enabled and the job name was explicitly supplied with `--name`.
  Surface-defaulted notices contain only the job ID, terminal status, and exit
  code, and a command-derived fallback name is never displayed, so command
  text, paths, and arguments cannot reach a lock screen without explicit
  opt-in.
- Improved CLI completion pickup: in default `auto` completion mode, the first
  eligible hook boundary now gives a CLI-owned job the same bounded
  `result --peek` inspection, summary, recommended next step, and permission
  question that App, VS Code, and remote surfaces receive in their direct
  completion turns. The CLI direct completion turn remains
  acknowledgment-only because the open TUI cannot render it; the CLI path
  therefore still spends one extra hidden turn, documented as a known
  limitation.

## [0.2.4] - 2026-07-25

### Added

- Pre-acceptance private IPC fallback now records one bounded internal
  `privateIpcFallbackReason` in the durable job notification metadata so
  compatibility failures can be diagnosed without exposing process output.

### Fixed

- Completed private-IPC delivery in Codex App or VS Code now suppresses the
  later ordinary-turn fallback recap. Portable app-server delivery and
  uncertain or failed private delivery retain the one-shot recap.
- Direct completion turns now show only concise sanitized terminal metadata to
  the user. The trusted `UserPromptSubmit` hook validates that exact notice
  against the same task's in-flight delivery record before injecting fixed
  hidden report, inspection, Goal-continuation, and untrusted-output policy.
  Disabled or untrusted hooks degrade safely to a status-only completion turn.
- Visible completion notices format each validated job ID as inline code for
  clearer App and VS Code rendering while retaining compatibility with
  already-generated unquoted notices.

## [0.2.3] - 2026-07-24

### Added

- A guarded same-user private IPC path can now deliver completion turns through
  the owning Codex VS Code extension transport on macOS and Linux, allowing the
  already-open task to render the sanitized completion and Codex response live.

### Changed

- The OpenAI Plugins Directory is now the supported installation and update
  path. Homebrew distribution is deprecated and frozen at CPJ 0.2.2; the
  personal provider remains only for local development, and users should run
  exactly one active CPJ provider.
- All five model-facing skills are substantially shorter while retaining their
  routing, safety, hard-turn, progress, result, and cancellation contracts.
  Canonical launch examples also put every controller option before `--`.
- Default `auto` completion mode now gives VS Code the same bounded proactive
  result inspection, summary, recommended next step, and permission question as
  Codex App.

### Fixed

- Private IPC delivery now preserves the settled-idle retry signal when the
  owning task becomes active between initialization and start-turn dispatch,
  instead of falling through to a competing app-server turn.
- A private-protocol rejection falls back only before possible acceptance;
  connection loss or timeout after start-turn dispatch remains accepted-but-
  unconfirmed and never retries another transport.
- Skill guidance now directs the first controller call through the required
  scoped permission context when the durable state directory is outside the
  active sandbox, avoiding a predictable failed probe and retry.

## [0.2.2] - 2026-07-24

### Added

- Installer preview and `doctor` now report distinct CPJ provider caches and warn when duplicate skill providers may make routing nondeterministic.
- A task-agnostic routing acceptance matrix covers emitted detached launchers, persistent servers, externally owned remote jobs, and quick foreground tests.
- A deterministic, allowlisted OpenAI Plugins Directory packager, repository privacy policy, and extracted-runtime package test make Marketplace updates reproducible from the exact release commit.

### Changed

- Model-facing policy now classifies the underlying workload instead of wrapper latency and explicitly composes task-specific correctness workflows with CPJ lifecycle ownership.
- The source manifest now uses the portal-accepted `Developer Tools` category, and installation guidance requires choosing one CPJ provider instead of installing directory and personal copies side by side.

### Fixed

- Task workflows that emit a quick detached launcher no longer make the underlying finite local workload appear ineligible for CPJ. Agents must route the foreground payload or a launcher mode that waits for completion, rather than tracking a fire-and-exit wrapper.

## [0.2.1] - 2026-07-23

### Added

- `codex-process-jobs doctor --provenance` reports path-redacted release, runtime snapshot, cache-generation, upstream, and editable-checkout provenance without scanning or changing the host.

### Changed

- Installer and documentation now require a `/hooks` review after every install or update while distinguishing mandatory review from conditional reapproval when Codex marks a definition new or changed.

## [0.2.0] - 2026-07-22

### Added

- Versioned GitHub Release and Homebrew distribution with preview-first `install` and `update` commands, a read-only `doctor`, and exact release-version reporting.
- An explicit release allowlist so distribution artifacts contain only the plugin runtime, installer, user documentation, license, and security policy.
- A reproducible macOS and Linux update path through `brew update`, `brew upgrade`, and the transactional CPJ plugin updater.

### Fixed

- `--shell` now executes deterministic non-login `/bin/bash -c`, so agent-authored commands using `set -o pipefail` work consistently on macOS and Linux. New `--posix-sh` preserves an explicit `/bin/sh -c` option, while schema-v1 shell records retain their historical `/bin/sh -lc` execution semantics.
- Automatic Goal continuations no longer treat a result-gated detached job as permission to wait or poll. They perform independent work or follow Codex's blocked-Goal audit until the completion relay or hook surfaces terminal state.
- A yielded `status --wait` tool execution is now explicitly treated as an in-flight waiter rather than blank output. Codex may resume only that same waiter once; after it finishes or times out, hook guidance forbids replacement sleeps or status probes.

## [0.1.0] - 2026-07-21

Initial public beta.

### Added

- Durable detached command execution on macOS and Linux with tracked process identity, bounded stdout and stderr, terminal status, and process-group cancellation.
- Namespaced skills for starting, checking, tailing, retrieving, and cancelling jobs without holding the assigning Codex turn open.
- Critical-job cancellation safeguards for repair, firmware, migration, and other interruption-sensitive work.
- Durable completion state plus best-effort conversational delivery across Codex App, Codex CLI, the VS Code extension, and remote/mobile-driven execution hosts.
- Consent-gated `PostToolUse`, `Stop`, and `UserPromptSubmit` hooks with one-shot launch-boundary reinforcement and terminal-result fallback.
- Sanitized completion batching, bounded idle-thread watching, proactive result inspection, and preloaded result-skill context for lower completion overhead.
- Explicit Codex Goal integration without reading private Goal storage or creating Goals implicitly.
- Two-phase installer with global, project, or no `AGENTS.md` adoption policy; active-job protection; rollback; client-restart guidance; and explicit `/hooks` approval.
- Preservation of validated prior plugin cache generations so open tasks retain the exact skill paths and code they originally catalogued.
- Repeatable macOS/Linux smoke tests, a four-cell GitHub Actions matrix, Cartesian surface acceptance guidance, and a controlled three-arm token-cost benchmark harness.

### Security

- Automatic model-facing notices contain only validated job IDs, terminal status, exit codes, and fixed plugin-owned instructions—never command output, argv, labels, paths, or environment data.
- Persisted records and log paths are schema-checked, size-bounded, same-user, private, and read without following symlinks.
- Desktop IPC is restricted to a private same-user socket and falls back before acceptance rather than risking duplicate delivery after an uncertain send.
- Hook trust remains an explicit user decision through Codex's hash-based `/hooks` consent flow.

### Known limitations

- Automatic conversational wake and delivery are best-effort. Durable status and result retrieval remain authoritative when a client does not render a live completion.
- Desktop IPC and the app-server relay depend on experimental local Codex behavior that may change between client releases.
- Detached commands receive no interactive stdin and must remain finite foreground processes; servers, watchers, daemonized commands, and external fire-and-exit launchers need another lifecycle mechanism.
- The runtime supports macOS and Linux with Node.js 18 or newer. Windows is not currently supported.
- Completion turns consume ordinary Codex usage. The included benchmark is a measurement harness, not a blanket claim that every workload saves tokens.

[Unreleased]: https://github.com/joelfarthing/codex-process-jobs/compare/v0.2.4...HEAD
[0.2.4]: https://github.com/joelfarthing/codex-process-jobs/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/joelfarthing/codex-process-jobs/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/joelfarthing/codex-process-jobs/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/joelfarthing/codex-process-jobs/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/joelfarthing/codex-process-jobs/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/joelfarthing/codex-process-jobs/releases/tag/v0.1.0
