# Changelog

Notable changes to Codex Process Jobs are documented here. The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) beginning with its first public beta.

## [Unreleased]

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

[Unreleased]: https://github.com/joelfarthing/codex-process-jobs/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/joelfarthing/codex-process-jobs/releases/tag/v0.1.0
