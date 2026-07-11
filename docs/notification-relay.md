# Conversational completion relay

Codex Process Jobs can wake the persistent Codex task that launched a detached command without turning the command into a subagent.

## Delivery flow

1. `$codex-process-jobs:start` records the owning `CODEX_THREAD_ID` and launches the ordinary OS command in a detached process group.
2. The worker records the terminal state before attempting notification, so status and result remain available even if notification fails.
3. A separate lightweight notifier resumes the owning thread through local `codex app-server` and starts one minimal completion turn.
4. The synthetic turn contains only the sanitized job id, terminal status, and exit code. It never contains the command, working directory, job label, environment, stdout, or stderr.
5. The completion turn asks Codex for one short conversational sentence and explicitly forbids tool calls or unrelated work.
6. If direct delivery is unavailable, the bundled `UserPromptSubmit` hook surfaces the unread completion once on the task's next ordinary prompt. For a VS Code task whose durable completion turn was delivered but not repainted in the open webview, the same hook surfaces sanitized completion state on the next non-status prompt. Explicit status/result requests bypass injection because they retrieve the durable state directly.
7. `$codex-process-jobs:status` and `$codex-process-jobs:result` remain the durable fallback.

This relay uses an ordinary Codex turn and therefore consumes normal Codex usage. Pass `--no-notify` for jobs that should remain polling-only.

## Continued conversation while a job runs

Normal user turns do not disturb a running job, and the prompt hook ignores it until its process state is terminal. If the process finishes while the owning task is busy, the notifier waits for an idle boundary. At the next boundary, exactly one path claims presentation under the job-state lock:

- If the notifier changes `pending` to `delivering` first, ordinary prompt fallback waits and the synthetic completion turn owns presentation.
- If the next ordinary prompt changes `pending`, `failed`, or `accepted` to `fallback_notified` first, the notifier stops and that user turn owns presentation.
- Worker relay bookkeeping preserves either claim instead of resetting it to `pending`.

A live `delivering` attempt is protected from prompt fallback. If its notifier process disappears, the hook can recover the stale attempt after a short startup grace; an apparently live attempt older than the maximum relay window is also recoverable. This prevents both duplicate announcements and a permanently stuck delivery state.

## VS Code presentation note

The completion turn is persisted in the owning task independently of the client that launched it. In the tested Codex VS Code extension build, an already-open Codex webview cached the transcript and did not live-render a completion turn appended by a separate app-server process. Reloading the VS Code window and reopening the task displayed both the launch turn and the conversational completion turn. Until the extension observes externally appended turns live, start records `notification.presentation` as `durable-refresh-required` and the agent discloses the limitation. The hook then injects sanitized completion state into the assigning agent's next ordinary non-status turn exactly once; an explicit status/result request retrieves the same durable state directly.

The synthetic `<process_job_notification>` turn is explicitly excluded from this fallback. Successful app-server delivery remains `delivered`; the separate `surfaceFallbackNotifiedAt` timestamp records that the stale VS Code surface's assigning agent has also been informed.

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

`surfaceFallbackNotifiedAt` is orthogonal to these delivery states. It marks the one-shot VS Code next-turn fallback without rewriting a successful `delivered` state.

## Trust boundary

Process output is untrusted data. It is stored only in bounded logs and is not interpolated into the notification prompt. A user or agent must explicitly invoke `$codex-process-jobs:result` before Codex interprets that output.

The installer enables Codex's stable `hooks` feature and attempts to trust only the installed `codex-process-jobs@<marketplace>` hook hashes reported by `hooks/list`. If automatic trust cannot be completed, installation succeeds with a warning and `/hooks` is the manual review path.
