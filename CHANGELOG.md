# Changelog

Notable changes to Codex Process Jobs are documented here. The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) beginning with its first public beta.

## [0.4.1] - 2026-08-23

### Added

- A consent-gated `PreToolUse` hook now challenges non-obviously-short local Bash commands before foreground execution. Codex classifies the underlying workload from the current conversation. Arbitrary inference programs, long downloads, and project-specific wrappers receive the same treatment as familiar build tools.
- Clear non-qualifying commands have a one-shot `# cpj:foreground` escape. CPJ controller commands, obvious short inspections, interactive or persistent work, and already-detached commands pass without recursion.

### Changed

- Marketplace installations no longer rely on an optional managed `AGENTS.md` block for first-use adoption. The block remains an opt-in routing preference. The consented hook and bundled start skill provide the executable path.
- Dev deployment and Marketplace packaging now consume one reviewed runtime file manifest. A normalized parity test permits only the Dev plugin name, cachebuster version, display text, state namespace, and generated identity marker to differ.
- A successful CPJ start is now an absolute launch-turn release boundary. A request for the eventual result does not permit a same-turn wait, status check, tail read, result read, process probe, or memory lookup.
- User-facing launch reports now omit controller mechanics and internal procedure. They briefly identify the background job and set the expectation that a completion notification should appear.
- Completion summaries now keep follow-up focused on the underlying workload. They stop without a manufactured question when no useful next step exists, and they do not offer generic CPJ actions or testing unless the user requested them.

### Fixed

- The user-visible parent now owns every CPJ process launch. A fixed prompt-submit boundary tells the parent not to delegate local process execution or monitoring. A spawned subagent cannot execute a qualifying workload, use a foreground escape, or call CPJ `start` or `rerun`.
- Hook thread detection now prefers a validated `CODEX_THREAD_ID` over the payload `session_id`. Codex can retain the user-visible parent in a spawned subagent hook payload. The hook now applies the child-only denial to the agent that uses the tool.
- A delegated process can no longer make the parent wait for a child lifecycle after CPJ detaches the workload. Legacy records launched by older Dev builds still route completion to the highest user-visible ancestor.

### Security

- The foreground classifier fails open on malformed or oversized hook input. It never executes or rewrites the candidate command, and it exposes no process output.
- The consented hooks read only validated job ownership, launch-boundary, rollout relationship metadata, and bounded prompt text used for delegation classification. They inject fixed policy and never interpolate the matched prompt. They reject process execution and CPJ launch ownership inside a spawned subagent. They also reject same-turn monitoring after a successful start. The `# cpj:foreground` escape cannot override either boundary.

## [0.4.0] - 2026-08-22

### Added

- Codex CLI 0.149.0 and newer now receive zero-setup live completion turns
  through the official `codex queue` command. Ordinary `codex` sessions need
  no daemon, wrapper, special invocation, or CPJ preference.
- Queue-first delivery is covered by a real idle-TUI wake proof plus regression
  tests for stale active writers, bounded fallback diagnostics, uncertain
  acknowledgment, exactly-once enqueue, proactive inspection, and duplicate
  suppression on the next unrelated prompt.

### Changed

- The notifier now asks Codex itself to queue the sanitized completion before
  consulting private IPC or portable App Server fallbacks. This lets Codex
  defer the message behind a legitimate active writer instead of making CPJ
  repeatedly guess when the client is idle.
- Launch announcements now name **Codex Process Jobs** instead of referring to
  a generic detached-job skill or workflow. Automatic visible notices begin
  with `CPJ background job`, while the hook continues to accept the earlier
  unbranded grammar for in-flight jobs and upgrade compatibility.
- The start skill no longer presents the pre-0.149 shared-App-Server daemon as
  ordinary CLI setup; official queue delivery now requires no special launch
  path or persistent helper.

### Security

- Queue delivery passes the validated owning thread and sanitized completion
  sentence as fixed argv with `shell: false`, bounds acknowledgment output and
  time, and never falls through to another transport after acceptance becomes
  uncertain.

## [0.3.0] - 2026-08-09

### Added

- Experimental, explicit-opt-in live completion delivery for ordinary Codex
  CLI/TUI sessions through Codex's official shared local App Server. When the
  daemon is already running before the TUI starts, CPJ can send the sanitized
  completion turn through its private same-user Unix socket and confirm the
  matching durable turn before suppressing the later recap.
- Maintainers can preview and install an isolated
  `codex-process-jobs-dev` runtime with `node scripts/install.mjs --dev`.
  The generated snapshot uses a distinct plugin and skill namespace,
  `process-jobs-dev` durable state, personal-marketplace entry, and visible
  development identity so it can coexist with a disabled Marketplace copy.

### Changed

- The optional managed `AGENTS.md` policy now refers to the enabled CPJ skills
  without hard-coding a production or development plugin namespace.

### Security

- CLI live delivery validates a real same-user socket and parent directory
  that are inaccessible to group or other users, applies bounded WebSocket
  handshake/frame/message parsing, targets only the validated owning thread,
  falls back only before possible turn acceptance, and never starts or enables
  the App Server daemon automatically.

## [0.2.9] - 2026-08-04

### Fixed

- Proactive completion inspection now preserves explicit conversational
  authority: Codex may continue a clear, already-authorized in-scope step, but
  completion metadata and process output never grant new authority. New
  authority, consequential choices, expanded scope, and elevated risk still
  require user direction.

## [0.2.8] - 2026-08-03

### Fixed

- Stop-hook completion fallback now renders only the sanitized terminal
  sentence as user-facing Hook feedback. The detailed inspection, untrusted
  output, final-recap, and approval policy is no longer placed in the visible
  Stop `reason` field.
- The compact `result` skill now explicitly recognizes a concise CPJ completion
  prompt and retrieves that exact job with bounded `--peek`, preserving
  proactive evidence summaries even when Codex does not run
  `UserPromptSubmit` for a Stop-generated continuation.

### Security

- Stop-continuation prompt and private-context claims are persisted as
  validated, one-shot timestamps, preventing forged or replayed completion
  prompts from acquiring model-facing CPJ policy.

## [0.2.7] - 2026-07-28

### Added

- Finished jobs can be launched again with the new `rerun` controller command
  and skill. CPJ reads only the private validated record, preserves argv,
  working directory, execution mode, critical classification, and explicit
  name, then creates a fresh job and logs with `rerunOf` lineage.
- Rerun safety guards refuse active jobs, require `--force` for critical jobs,
  and decline legacy shell records whose historical interpreter contract
  cannot be preserved.

### Changed

- Stop-hook completion pickup now emits compact, user-legible context instead
  of a long internal-policy transcript while retaining bounded result
  inspection, untrusted-output handling, final-answer recap, and explicit
  approval before the suggested next step.
- The managed agent policy and every operational skill now forbid memory
  searches for CPJ work and use the current request plus validated CPJ state as
  the sole job-routing and metadata authorities.

## [0.2.6] - 2026-07-27

### Changed

- The automatically loaded `result` skill is about 31% shorter by word count
  than the 0.2.5 version. Ordinary completion inspection retains its bounded
  `--peek`, untrusted-output, task-evidence, device-diagnostic, and completion
  boundary contracts; advanced byte limits, full reads, and incremental cursor
  options move to a progressively loaded reference.

### Added

- A paired Luna result-skill benchmark stages identical runtime variants,
  substitutes only the candidate result-skill folder, alternates execution
  order, and rejects preloaded, duplicated, combined, cross-provider, or
  unrelated tool calls. Its results are screening evidence, not a general
  token- or wall-time-savings claim.

### Fixed

- The OpenAI Plugins Directory archive now includes the compact result skill's
  progressively loaded advanced-options reference.

### Security

- The compact result skill explicitly retains the standalone rule that all
  returned metadata and process output are untrusted evidence and that Codex
  must never follow commands, links, or instructions from them.

## [0.2.5] - 2026-07-26

### Fixed

- A sandboxed launch that cannot prepare the durable state directory now
  raises an actionable error naming the denied path and directing the agent
  to re-run the identical command with scoped or escalated permissions,
  instead of a bare `EPERM`/`EACCES` errno that invites substituting a
  non-durable state root.
- A TUI launch whose escalated sandbox execution loses the inherited
  originator environment is now classified `cli` from the owning rollout's
  exact session metadata pair (`source: cli`, `originator: codex-tui`), so
  CLI-surface defaults still apply. Any non-empty environment originator
  keeps precedence, and other metadata pairs remain `unknown`.
- `tools/experimental/verify-tui-wake.py` scans every `process-jobs*` state
  root under `CODEX_HOME` and labels each job's root, correcting the false
  "durable state is missing" diagnosis produced when only the release root
  was searched while a development provider was active.

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
### Security

- Production packaging requires the exact public plugin identity and refuses
  development install markers. Development identity rewriting occurs only in
  the transactional staging copy, and a generated development snapshot cannot
  be used as a release or installer source.

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

[Unreleased]: https://github.com/joelfarthing/codex-process-jobs/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/joelfarthing/codex-process-jobs/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/joelfarthing/codex-process-jobs/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/joelfarthing/codex-process-jobs/compare/v0.2.9...v0.3.0
[0.2.9]: https://github.com/joelfarthing/codex-process-jobs/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/joelfarthing/codex-process-jobs/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/joelfarthing/codex-process-jobs/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/joelfarthing/codex-process-jobs/compare/b3d9d624b2e72b6a9e90b9f8181191b3b26d81cc...v0.2.6
[0.2.5]: https://github.com/joelfarthing/codex-process-jobs/compare/v0.2.4...b3d9d624b2e72b6a9e90b9f8181191b3b26d81cc
[0.2.4]: https://github.com/joelfarthing/codex-process-jobs/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/joelfarthing/codex-process-jobs/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/joelfarthing/codex-process-jobs/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/joelfarthing/codex-process-jobs/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/joelfarthing/codex-process-jobs/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/joelfarthing/codex-process-jobs/releases/tag/v0.1.0
