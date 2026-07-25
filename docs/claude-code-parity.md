# Claude Code parity: prioritized gaps and implementation notes

- Status: implementation record; all five proposed upgrades are implemented on `codex/claude-parity-upgrades`
- Baseline: review branch `review/publication-hardening` (post publication-hardening pass)
- Implemented against: `codex-cli 0.144.5`, 2026-07-20
- Audience: maintainers reviewing the Claude Code parity rationale and regression contract

## Reference model

Claude Code's harness owns background-task wake-up: a backgrounded command runs detached, and when it exits the harness re-invokes the agent with a task notification — mid-turn if a turn is active, otherwise at the next opportunity. Notification is free, guaranteed, and requires no model discipline, so the model never polls. Incremental output tools return only bytes produced since the previous read.

Codex exposes no equivalent single primitive. This plugin synthesizes one from a durable completion turn (costs a real Codex turn and requires the owning thread idle), consent-gated `PostToolUse`, `Stop`, and `UserPromptSubmit` hooks, and prompt-contract discipline against polling. The remaining differences are arbitrary-time wake guarantees, latency, and usage cost. The items below close what can be closed from a plugin.

## Constraints every item must preserve

These are load-bearing invariants from [SECURITY.md](../SECURITY.md) and the existing tests. Do not weaken them while implementing:

1. Automatic turns admit at most 20 compatible records. Visible prompt text contains only validated job IDs, terminal-status enums, and integer exit codes. The trusted prompt-submit hook must verify every value against a same-task in-flight delivery record before injecting fixed hidden completion policy. Never interpolate names, commands, paths, errors, process output, or agent instructions into the visible notice.
2. Notification presentation is claimed atomically under the per-job state lock; worker, notifier, and hook never overwrite a competitor's claim.
3. Hook execution requires explicit `/hooks` consent; nothing may depend on the hook being trusted.
4. All reads of process output are bounded; persisted records remain size-bounded and no-follow, with security-sensitive fields filename-bound and schema-validated.
5. Malformed or unexpected state fails closed.

## 1. Extend notifier patience with a cheap idle-watch — implemented

**Gap.** The retry schedule in [notifier.mjs](../scripts/notifier.mjs) (12 attempts, `5s × attempt` capped at 30s) exhausts in under five minutes. A job that finishes while the owning thread is inside a long turn — the primary use case — currently degrades to hook-on-next-prompt delivery. In Claude Code the notification simply waits for the agent.

**Sketch.** `waitForOwnerIdle` already fails fast by reading the rollout tail without spawning anything. After the existing attempt budget is exhausted (or in place of its later attempts), enter an idle-watch phase: poll `readLatestTaskLifecycle` every 5–10 seconds up to a configurable ceiling (suggest `CODEX_PROCESS_JOBS_NOTIFY_IDLE_WATCH_MS`, default on the order of an hour, existing `parsePositiveInteger` clamping pattern). On the first settled idle observation, make one final delivery attempt through the existing `deliverNotificationTurn` path.

**Critical design detail.** During the watch the job must remain in notification status `pending`, not `delivering`. The hook treats a `delivering` attempt older than `DELIVERY_STALE_MS` (11 minutes) as stale and recovers it; an hour-long `delivering` hold would be recovered out from under the watcher. Holding `pending` also preserves the existing rule that a next-prompt claim beats a queued direct delivery: re-read job state immediately before the final CAS to `delivering`, and stop silently if the notification is suppressed, claimed, or the job's result was viewed. All of that logic already exists in `runNotifier`'s loop; the watch is effectively a smarter, cheaper retry delay.

**Tests.** Extend [notifier.test.mjs](../test/notifier.test.mjs): (a) rollout stays busy past the normal attempt budget, then appends `task_complete`; delivery succeeds through the mock codex and records `delivered`; (b) hook claims `fallback_notified` mid-watch; watcher exits without delivering; (c) ceiling expiry records `failed` and leaves hook fallback eligible. Use the existing mock-codex and rollout fixtures; drive timings with the env knobs, not real minutes.

**Implementation.** After the normal attempt budget ends on an idle-retryable error, `waitForOwnerIdleWatch` leaves every claimed record `pending` and reads only the owning task lifecycle. The defaults are one hour and a five-second poll; both are bounded environment overrides. Hook claim, result consumption, suppression, or another delivery claim ends the watch without delivery. Ceiling expiry marks only still-pending batch members `failed`. All three proposed race tests are present.

## 2. Incremental output reads — implemented with compaction generations

**Gap.** `tail` and `status` re-send the same trailing bytes on every call. Claude Code's `BashOutput`/`TaskOutput` return only bytes since the previous read, which is the main token saver for repeated progress checks across turns.

**Sketch.** Stateless cursor, no persisted read state (two readers must not fight over a shared cursor). Add `--since-byte <n>` to `tail` (and the JSON forms of `status`/`result` if cheap): read from offset `n` to EOF, bounded by the existing per-read caps, and include `nextOffset` (current file size) plus the existing byte counts in JSON output. The model passes `nextOffset` back on its next call.

**Compaction interaction.** The bounded writer in [logs.mjs](../scripts/logs.mjs) compacts by truncating to zero and rewriting marker + tail, so offsets can shrink. If `--since-byte` exceeds the current file size, the log was compacted: return the bounded tail as today and set `"compacted": true` so the reader knows the byte stream is discontinuous. Never fail the read for a stale offset.

**Tests.** Extend [logs.test.mjs](../test/logs.test.mjs) and the CLI tests: sequential reads return disjoint byte ranges; a stale offset after forced compaction returns the tail with `compacted: true`; `nextOffset` round-trips; all reads stay within the model-facing caps.

**Implementation.** `tail`, `status`, and `result` expose stateless JSON cursors independently for stdout and stderr. Alongside `nextOffset`, each cursor carries a 16-hex-character generation fingerprint of the bounded log prefix. This is stricter than the original offset-only sketch: a capped log can compact and rewrite while retaining the same byte length, which an offset comparison alone cannot detect. A generation mismatch sets `compacted: true` and returns bounded replacement evidence. Generic `--since-byte` remains convenient for a single selected `tail` stream; two-stream reads require explicit `--stdout-since-*` and `--stderr-since-*` arguments so one stream's offset can never skip bytes in the other.

## 3. Batch sibling completions into one turn — implemented

**Gap.** Five jobs finishing together currently produce five synthetic turns and five recap obligations. The hook already batches up to 20 records per prompt; the notifier does not batch at all.

**Sketch.** When a notifier claims one job for delivery, also attempt to claim every other terminal job with a `pending` notification and the same `ownerThreadId` (each under its own job lock; a failed claim just excludes that job). Extend `buildNotificationPrompt` to accept the claimed set and emit one line per job — validated ID, status enum, exit code only — with a single mode-selected instruction. On turn completion, mark every claimed job `delivered` with the shared `turnId`; on failure, release every claim exactly as the single-job failure path does today. Goal-mode and non-Goal jobs have different instructions; either deliver them as separate batches or emit both instruction blocks — separate batches are simpler and preserve the existing prompt tests.

**Tests.** Multi-job batch delivers exactly one `turn/start` on the mock codex; the prompt contains all claimed IDs and no names/output; every claimed record ends `delivered` with the same `turnId`; a concurrent hook claim on one sibling excludes only that sibling; failure releases all claims.

**Implementation.** A notifier seed claims up to 19 additional terminal `pending` siblings with the same owner and the same Goal/completion instruction key. Each record has its own lock and records a shared ephemeral batch ID only while delivering. Successful members receive the same durable turn ID; failure or retry returns only still-owned members to the appropriate state. A hook-won sibling is excluded without invalidating the rest of the batch.

## 4. Codex hook events beyond `UserPromptSubmit` — investigated and implemented

**Gap.** The plugin has no mid-turn awareness: a job that finishes while the launch turn is still doing independent work cannot surface until the turn ends. Claude Code's equivalent of a post-tool-use injection is how its task notifications reach the model mid-turn.

**Action.** Investigation first, not implementation. Determine whether the installed Codex hook system supports additional events (post-tool-use, turn-end, or task-lifecycle events). If yes: register the existing hook script for that event in [hooks.json](../hooks/hooks.json) behind the same consent flow, reusing the relay-environment guard (`CODEX_PROCESS_JOBS_NOTIFICATION_RELAY`) and the existing claim CAS so a mid-turn injection and a next-prompt injection can never both fire for one job. If no: record the finding here with the Codex version inspected, as the designated upgrade path. Do not emulate mid-turn delivery through the app-server; the optimistic-duplicate result in [notification-relay.md](notification-relay.md) already ruled that out.

**Finding and implementation.** The current [official Codex hooks documentation](https://learn.chatgpt.com/docs/hooks.md) and installed `codex-cli 0.144.5` expose turn-scoped `PostToolUse` and `Stop` events. `PostToolUse` can return model feedback after supported local tool calls; `Stop` can return a continuation prompt. The plugin registers its existing bounded hook script for both events and retains `UserPromptSubmit` as the later-turn fallback. All three use the notification-relay environment guard and the same per-job claim CAS. An undelivered fallback honors the configured finite completion mode, while an already-delivered awareness recap remains report-only to avoid a second result inspection. Hook trust remains explicit through `/hooks`, and no behavior depends on consent being granted. This closes tool-boundary and turn-end latency, not arbitrary-time injection during pure reasoning or unsupported hosted-tool execution.

## 5. Optional OS-level user notification — implemented

**Gap.** Claude Code shows a desktop notification when background work finishes. The human currently learns of completion only through the conversation.

**Sketch.** Opt-in per launch (`--notify-user`) or durable preference (additive `notifyUser` key in [preferences.mjs](../scripts/preferences.mjs) — extend `PREFERENCE_KEYS`, default `false`, keep unknown-key strictness). On the terminal transition, the worker spawns `osascript -e 'display notification …'` (macOS) or `notify-send` (Linux) with `shell: false`, passing only the job ID, terminal status, exit code, and the ≤512-byte validated name as argv. This is human-facing output, not a model boundary, but keep it argv-only (no shell interpolation) and fail silently if the notifier binary is absent. Never block the terminal-state write on it.

**Tests.** Preference round-trip including rejection of non-boolean values; worker invokes the platform notifier with expected argv (injectable spawn, mirroring the process-control test style); absence of the binary does not affect job state or exit status.

**Implementation.** `start --notify-user` and `--no-notify-user` override the strict, private `notifyUser` preference managed by `config --notify-user true|false`; the default is false and older version-1 preference files remain compatible. Terminal state is persisted before the worker launches an unref'd notification command with `shell: false`. The human-facing label has control characters normalized and is capped at 512 UTF-8 bytes. `osascript` and `notify-send` failure is silent and cannot alter process or relay state.

## Structurally unfillable — do not attempt

- **A free, guaranteed arbitrary-time wake.** Direct delivery costs a Codex turn and requires an idle owning thread. Hook pickup occurs only at supported boundaries and requires explicit trust. Only an upstream task-notification primitive fully closes this gap; see [vscode-wake-research-and-process.md](vscode-wake-research-and-process.md).
- **Arbitrary mid-turn injection via app-server or private IPC.** Controlled
  testing produced optimistic duplicates; the settled-idle guard stays.
  `PostToolUse` is the supported boundary-based approximation.
- **Polling resistance as a tool contract.** Codex must be instructed not to poll; the launch-turn contract test pins the wording that earned passing acceptance runs. Keep guarding it.
- **The 55-second wait ceiling.** Codex tool-timeout bound; one bounded wait per continuation remains the right approximation of event-driven waiting.
