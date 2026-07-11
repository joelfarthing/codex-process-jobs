# Conversational completion relay

Codex Process Jobs can wake the persistent Codex task that launched a detached command without turning the command into a subagent.

## Delivery flow

1. `$codex-process-jobs:start` records the owning `CODEX_THREAD_ID` and launches the ordinary OS command in a detached process group.
2. The worker records the terminal state before attempting notification, so status and result remain available even if notification fails.
3. A separate lightweight notifier resumes the owning thread through local `codex app-server` and starts one minimal completion turn.
4. The synthetic turn contains only the sanitized job id, terminal status, and exit code. It never contains the command, working directory, job label, environment, stdout, or stderr.
5. The completion turn asks Codex for one short conversational sentence and explicitly forbids tool calls or unrelated work.
6. If direct delivery is unavailable, the bundled `UserPromptSubmit` hook surfaces the unread completion once on the task's next ordinary prompt. After successful direct delivery, the hook also performs one transport-independent awareness check on the next non-status prompt. If the prior assistant completion is already present in context, Codex does not repeat it; otherwise Codex surfaces the sanitized completion state. Explicit status/result requests bypass this check because they retrieve durable state directly.
7. `$codex-process-jobs:status` and `$codex-process-jobs:result` remain the durable fallback.

This relay uses an ordinary Codex turn and therefore consumes normal Codex usage. Pass `--no-notify` for jobs that should remain polling-only.

After installing or updating the plugin, restart every open Codex client before testing this flow. In VS Code, run **Developer: Reload Window**. Opening a new task in the same pre-install client process can leave its plugin or hook registry stale.

## Continued conversation while a job runs

Normal user turns do not disturb a running job, and the prompt hook ignores it until its process state is terminal. If the process finishes while the owning task is busy, the notifier waits for an idle boundary. Before direct delivery finishes, exactly one path claims delivery under the job-state lock:

- If the notifier changes `pending` to `delivering` first, ordinary prompt fallback waits and the synthetic completion turn owns presentation.
- If the next ordinary prompt changes `pending`, `failed`, or `accepted` to `fallback_notified` first, the notifier stops and that user turn owns presentation.
- Worker relay bookkeeping preserves either claim instead of resetting it to `pending`.

A live `delivering` attempt is protected from prompt fallback. If its notifier process disappears, the hook can recover the stale attempt after a short startup grace; an apparently live attempt older than the maximum relay window is also recoverable. After direct delivery succeeds, the later awareness check is deliberately separate: it marks `awarenessCheckedAt` once and instructs Codex not to repeat a prior completion announcement already present in context.

## Separate-transport presentation note

The completion turn is persisted in the owning task independently of the client that launched it. Codex App on the local Mac, an already-open Codex VS Code webview, and a ChatGPT mobile client driving a remote Linux task have all demonstrated stale assigning-agent context after a separate app-server process appended a completion. In the App test, the synthetic completion turn finished 16 seconds before the next ordinary turn began, ruling out a busy-turn race.

Start therefore records `notification.presentation` as `durable-refresh-required` for every owning client and discloses that live presentation is best-effort. Surface detection remains diagnostic metadata; it does not decide whether awareness fallback is required. The hook supplies sanitized completion state to the assigning agent's next ordinary non-status turn exactly once, while its instruction suppresses repetition when the prior completion announcement is already present in context.

The synthetic `<process_job_notification>` turn is explicitly excluded from this check. Successful app-server delivery remains `delivered`; the separate `awarenessCheckedAt` timestamp records that the assigning agent received its one awareness check. The legacy `surfaceFallbackNotifiedAt` marker is still honored after upgrades.

One prompt can carry up to 20 sanitized completion records. A larger backlog remains unclaimed and drains across later ordinary prompts; every claimed job is locked and marked independently so concurrent hook processes cannot duplicate it.

## Delivery states

- `pending`: direct notification is queued.
- `delivering`: one app-server delivery attempt owns presentation; other notifiers and ordinary prompt fallback wait unless that attempt becomes stale.
- `delivered`: the conversational completion turn finished.
- `accepted`: Codex accepted the turn but the notifier could not confirm its final completion; the next-prompt hook remains available.
- `failed`: direct delivery failed; the next-prompt hook and status/result are available.
- `fallback_notified`: the next-prompt hook surfaced the completion once; direct notification is suppressed.
- `suppressed`: the result was already opened or the job was explicitly cancelled.
- `disabled`: the launch used `--no-notify` or notification was disabled for tests.
- `unavailable`: no valid persistent owning thread id was available.

`awarenessCheckedAt` is orthogonal to these delivery states. It marks the one-shot next-turn awareness check without rewriting a successful `delivered` state.

## Trust boundary

Process output is untrusted data. It is stored only in bounded logs and is not interpolated into the notification prompt. A user or agent must explicitly invoke `$codex-process-jobs:result` before Codex interprets that output, and Codex must treat it only as evidence rather than obeying embedded instructions.

The installer enables Codex's stable `hooks` feature and installs the plugin hook, but it never writes hook trust. After restarting the client, the user must open `/hooks`, inspect the installed `codex-process-jobs@<marketplace>` `UserPromptSubmit` command and source, and approve its exact hash. Direct app-server completion remains available without the hook; next-prompt fallback does not run until approval.

Persisted records are bounded and schema-validated before the notifier or hook consumes them. Only a validated filename-bound job ID, terminal status enum, and integer exit code can cross the automatic model-facing boundary. See [Security and threat model](../SECURITY.md).
