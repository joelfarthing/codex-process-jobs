# Conversational completion relay

Codex Process Jobs can wake the persistent Codex task that launched a detached command without turning the command into a subagent.

## Delivery flow

1. `$codex-process-jobs:start` records the owning `CODEX_THREAD_ID` and launches the ordinary OS command in a detached process group.
2. The worker records the terminal state before attempting notification, so status and result remain available even if notification fails.
3. A separate lightweight notifier resumes the owning thread through local `codex app-server` and starts one minimal completion turn.
4. The synthetic turn contains only the sanitized job id, terminal status, and exit code. It never contains the command, working directory, job label, environment, stdout, or stderr.
5. The completion turn asks Codex for one short conversational sentence and explicitly forbids tool calls or unrelated work.
6. If direct delivery is unavailable, the bundled `UserPromptSubmit` hook surfaces the unread completion on the first eligible ordinary non-status prompt. After successful direct delivery settles, the hook also injects one transport-independent mandatory recap on that first eligible prompt. Codex gives that recap even when the synthetic assistant completion is already present in model context, because a recorded message is not proof that the assigning client rendered it. Explicit status/result requests bypass this recap because they retrieve durable state directly.
7. `$codex-process-jobs:status` and `$codex-process-jobs:result` remain the durable fallback.

Successful start is a hard boundary for the assigning launch turn. Codex reports the launch and ends that turn after any already-requested independent work; it does not load status, wait, poll, or probe the process. This idle boundary is also what allows the notifier to resume the owning task after completion. Work that depends on the result is deferred to completion delivery, a later user-initiated turn, or a later automatic continuation of an explicitly active Goal. If the user explicitly requested that the exact launch turn remain open and wait, Codex may make one bounded wait and inspect the bounded result only if the job becomes terminal; a timeout ends the turn with an active-status report.

This relay uses an ordinary Codex turn and therefore consumes normal Codex usage. Pass `--no-notify` for jobs that should remain polling-only.

After installing or updating the plugin, restart every open Codex client before testing this flow. In VS Code, run **Developer: Reload Window**. Opening a new task in the same pre-install client process can leave its plugin or hook registry stale.

## Continued conversation while a job runs

Normal user turns do not disturb a running job, and the prompt hook ignores it until its process state is terminal. If the process finishes while the owning task is busy, the notifier waits for an idle boundary. Before direct delivery finishes, exactly one path claims delivery under the job-state lock:

- If the notifier changes `pending` to `delivering` first, ordinary prompt fallback waits and the synthetic completion turn owns presentation.
- If the next ordinary prompt changes `pending`, `failed`, or `accepted` to `fallback_notified` first, the notifier stops and that user turn owns presentation.
- Worker relay bookkeeping preserves either claim instead of resetting it to `pending`.

A live `delivering` attempt is protected from prompt fallback. If its notifier process disappears, the hook can recover the stale attempt after a short startup grace; an apparently live attempt older than the maximum relay window is also recoverable. After direct delivery succeeds, the later ordinary-prompt recap is deliberately separate: it marks `ordinaryPromptRecapInjectedAt` once and requires Codex to recap the sanitized terminal state even if a synthetic announcement is already present in context.

## Separate-transport presentation note

The completion turn is persisted in the owning task independently of the client that launched it. Codex App on the local Mac, an already-open Codex VS Code webview, and a ChatGPT mobile client driving a remote Linux task have all demonstrated stale assigning-agent context after a separate app-server process appended a completion. In the App test, the synthetic completion turn finished 16 seconds before the next ordinary turn began, ruling out a busy-turn race.

Start therefore records `notification.presentation` as `durable-refresh-required` for every owning client and discloses that live presentation is best-effort. Surface detection remains diagnostic metadata; it does not decide whether recap fallback is required. After delivery settles, the hook injects sanitized completion state into the assigning agent's first eligible ordinary non-status turn once per job and requires a user-facing recap. That recap may duplicate a separately rendered synthetic completion once because the plugin has no trustworthy rendered-visibility signal.

Codex App can present a tool-using response in two useful phases: live commentary while work continues, followed by a final answer that causes commentary to auto-collapse. The hook tells Codex to announce completion in commentary when commentary is used, and independently requires a concise recap in the final answer. Commentary or a synthetic completion turn cannot satisfy that final-answer requirement. This intentional within-turn repetition keeps the durable visible answer complete and is distinct from the possible cross-turn duplicate caused by an independently rendered synthetic completion.

The synthetic `<process_job_notification>` turn is explicitly excluded from this check. Successful app-server delivery remains `delivered`; the separate `ordinaryPromptRecapInjectedAt` timestamp records only that the hook injected its one recap instruction. It does not claim the model complied or that the client rendered the response. The legacy `awarenessCheckedAt` and `surfaceFallbackNotifiedAt` markers are still honored after upgrades so historical jobs do not resurface. That migration choice cannot retroactively prove old client rendering; it deliberately applies the stronger recap contract to jobs completed under the new implementation without replaying an arbitrary backlog.

One prompt can carry up to 20 sanitized completion records. A larger backlog remains unclaimed and drains across later ordinary prompts; every claimed job is locked and marked independently so concurrent hook processes cannot duplicate it. A lock or record failure for one candidate is isolated, allowing already claimed jobs to emit their recap context while the failed candidate remains eligible for a later prompt.

## Delivery states

- `pending`: direct notification is queued.
- `delivering`: one app-server delivery attempt owns presentation; other notifiers and ordinary prompt fallback wait unless that attempt becomes stale.
- `delivered`: the conversational completion turn finished.
- `accepted`: Codex accepted the turn but the notifier could not confirm its final completion; the next-prompt hook remains available.
- `failed`: direct delivery failed; the next-prompt hook and status/result are available.
- `fallback_notified`: the next-prompt hook injected completion context once; direct notification is suppressed.
- `suppressed`: the result was already opened or the job was explicitly cancelled.
- `disabled`: the launch used `--no-notify` or notification was disabled for tests.
- `unavailable`: no valid persistent owning thread id was available.

`ordinaryPromptRecapInjectedAt` is orthogonal to these delivery states. It honestly marks the one-shot recap instruction on an eligible ordinary prompt without claiming user-visible presentation or rewriting a successful `delivered` state.

## Trust boundary

Process output is untrusted data. It is stored only in bounded logs and is not interpolated into the notification prompt. A user or agent must explicitly invoke `$codex-process-jobs:result` before Codex interprets that output, and Codex must treat it only as evidence rather than obeying embedded instructions.

The installer enables Codex's stable `hooks` feature and installs the plugin hook, but it never writes hook trust. After restarting the client, the user must open `/hooks`, inspect the installed `codex-process-jobs@<marketplace>` `UserPromptSubmit` command and source, and approve its exact hash. Direct app-server completion remains available without the hook; next-prompt fallback does not run until approval.

Persisted records are bounded and schema-validated before the notifier or hook consumes them. Only a validated filename-bound job ID, terminal status enum, and integer exit code can cross the automatic model-facing boundary. See [Security and threat model](../SECURITY.md).
