# Conversational completion relay

Codex Process Jobs can wake the persistent Codex task that launched a detached command without turning the command into a subagent.

## Delivery flow

1. `$codex-process-jobs:start` records the owning `CODEX_THREAD_ID` and launches the ordinary OS command in a detached process group.
2. The worker records the terminal state before attempting notification, so status and result remain available even if notification fails.
3. For a local macOS Codex App task, a separate lightweight notifier first attempts the App's private same-user IPC router so the already-open renderer receives the turn live. It verifies private socket ownership and permissions, waits for a settled idle boundary, and confirms the returned turn ID reaches durable `task_complete`.
4. If guarded Desktop IPC is unavailable before acceptance, the notifier automatically falls back to a separate local `codex app-server` connection. Linux, CLI, VS Code, remote, and unsupported App versions continue to use this portable path.
5. A notifier may atomically claim up to 20 compatible terminal siblings owned by the same task and deliver them in one turn. The automatic user-facing notice contains one sanitized job id, terminal status, and exit code per record plus a single fixed instruction selected from a finite completion mode. It never interpolates the command, working directory, job label, environment, stdout, or stderr.
6. In the default `auto` mode, App and remote surfaces ask Codex to inspect bounded saved output with `result --peek`, summarize the evidence, recommend one next step, and ask permission without executing it. VS Code, CLI, and unknown surfaces request only a short acknowledgment because their synthetic turn may remain hidden. A durable execution-host preference at `$CODEX_HOME/process-jobs/config.json` can select `report`, `inspect`, or `auto`; set it with `node scripts/job.mjs config --completion-mode <mode>`. `CODEX_PROCESS_JOBS_COMPLETION_MODE` has higher precedence. Invalid environment values or invalid preference files fail closed to `report`.
   Direct proactive relays include the plugin-owned `result` skill as a structured `turn/start` input. Codex therefore receives the already-selected skill in the first completion-model invocation instead of discovering and reading `SKILL.md` in a separate invocation. The skill path is fixed inside the installed plugin, is never derived from job state or process output, and falls back to ordinary skill discovery if that regular file is unavailable.
   For jobs explicitly launched with `--goal-mode`, the fixed Goal instruction takes precedence over this surface preference: inspect `result --peek`, then continue already-authorized in-scope work if the Goal remains active; otherwise recommend one next step and ask.
7. Consent-gated `PostToolUse`, `Stop`, and `UserPromptSubmit` hooks share the same terminal-result claim logic. A terminal job can therefore surface after a supported local tool call during an active turn, as a one-time stop continuation, or on the first eligible ordinary non-status prompt. After successful direct delivery settles, the hooks also inject one transport-independent mandatory recap at the next eligible boundary. Codex gives that recap even when the synthetic assistant completion is already present in model context, because a recorded message is not proof that the assigning client rendered it. Explicit status/result user prompts bypass the prompt-submit recap because they retrieve durable state directly. Separately, `PostToolUse` recognizes the validated result of this installed plugin's own `start` controller and atomically injects one hard-release reminder for that newly created same-thread job.
8. `$codex-process-jobs:status` and `$codex-process-jobs:result` remain the durable fallback.

Successful start is a hard boundary for the assigning launch turn. Codex reports the launch and ends that turn after any already-requested independent work; it does not load status, wait, poll, or probe the process. This idle boundary is also what allows the notifier to resume the owning task after completion. Work that depends on the result is deferred to completion delivery, a later user-initiated turn, or a later automatic continuation of an explicitly active Goal. If the user explicitly requested that the exact launch turn remain open and wait, Codex may make one bounded wait and inspect the bounded result only if the job becomes terminal; a timeout ends the turn with an active-status report.

This relay uses an ordinary Codex turn and therefore consumes normal Codex usage. Pass `--no-notify` for jobs that should remain polling-only.

## Active Goal behavior

CPJ does not control Goal's automatic `Continue` cadence and cannot make those turns disappear. `--goal-mode` instead records that the command belongs to an explicitly active Goal and changes the model-facing state machine. A continuation does independent authorized work without checking the job merely because it arrived. If no independent work remains and the job is the critical path, it makes no status, wait, tail, sleep, or process probe; it ends without a progress sample and follows the host Goal blocked audit across repeated result-gated turns. This lets the thread become idle instead of turning Goal continuations into a polling loop. A terminal job is surfaced by the completion relay or a later hook boundary, consumed with `result --peek`, summarized, and followed by the next already-authorized Goal action. New authority, a consequential choice, or expanded scope still stops for the user.

Goal-mode detection is agent-level and uses visible supported Goal context, with `get_goal` as an optional supported confirmation. The plugin stores only a boolean marker and never reads or depends on Codex's private Goal database schema.

After installing or updating the plugin, restart every open Codex client before testing this flow. In VS Code, run **Developer: Reload Window**. Opening a new task in the same pre-install client process can leave its plugin or hook registry stale.

## Continued conversation while a job runs

Normal user turns do not disturb a running job, and hooks ignore it until its process state is terminal. If the process finishes while the owning task is busy, the notifier uses its bounded retries and then leaves the job `pending` during a cheap lifecycle watch. The watch polls only the owning rollout's latest task boundary, by default every five seconds for up to one hour; `CODEX_PROCESS_JOBS_NOTIFY_IDLE_WATCH_MS` and `CODEX_PROCESS_JOBS_NOTIFY_IDLE_WATCH_POLL_MS` can tune those bounded values. It makes one final direct attempt after a settled idle observation. Before direct delivery finishes, exactly one path claims delivery under the job-state lock:

- If the notifier changes `pending` to `delivering` first, ordinary prompt fallback waits and the synthetic completion turn owns presentation.
- If a hook boundary changes `pending`, `failed`, or `accepted` to `fallback_notified` first, the notifier or idle watcher stops and that agent turn owns presentation.
- Worker relay bookkeeping preserves either claim instead of resetting it to `pending`.

A live `delivering` attempt is protected from prompt fallback. If its notifier process disappears, the hook can recover the stale attempt after a short startup grace; an apparently live attempt older than the maximum relay window is also recoverable. After direct delivery succeeds, the later ordinary-prompt recap is deliberately separate: it marks `ordinaryPromptRecapInjectedAt` once and requires Codex to recap the sanitized terminal state even if a synthetic announcement is already present in context.

## Separate-transport presentation note

The completion turn is persisted in the owning task independently of the client that launched it. A separate app-server process can leave an already-open client stale. Codex App on the local Mac, an already-open Codex VS Code webview, and a ChatGPT mobile client driving a remote Linux task have all demonstrated that behavior. In the original App test, the completion turn finished 16 seconds before the next ordinary turn began, ruling out a busy-turn race.

The guarded macOS Desktop path closes that presentation gap by routing the same start-turn request through the App-owned IPC client. A controlled test injected while another turn was active rendered an optimistic duplicate, even though the rollout contained only one persisted notification. Production delivery therefore retains the existing settled-idle guard. A second controlled test waited until `task_complete`, held the 1.5-second settle window, then injected through Desktop IPC; the notice and model response rendered immediately and exactly once. The IPC-returned turn ID matched the rollout's `task_started` and `task_complete` IDs.

This is a private, experimental App protocol. The notifier validates the socket and protocol response, records `notification.transport: desktop-ipc` only after matching durable completion, and falls back to `app-server` when IPC is unavailable before acceptance. If acceptance becomes uncertain, it records `accepted` and leaves the next-prompt fallback available instead of attempting a second direct turn.

Set `CODEX_PROCESS_JOBS_DISABLE_DESKTOP_IPC=1` to force the portable app-server path for diagnosis or compatibility testing. `CODEX_PROCESS_JOBS_DESKTOP_IPC_SOCKET` exists only as an explicit test/integration override; normal operation resolves the socket under the active `$CODEX_HOME`.

Start therefore records `notification.presentation` as `durable-refresh-required` for every owning client and discloses that live presentation is best-effort. Surface detection remains diagnostic metadata; it does not decide whether recap fallback is required. After delivery settles, the hook injects sanitized completion state into the assigning agent's first eligible ordinary non-status turn once per job and requires a user-facing recap. That recap may duplicate a separately rendered synthetic completion once because the plugin has no trustworthy rendered-visibility signal.

Codex App can present a tool-using response in two useful phases: live commentary while work continues, followed by a final answer that causes commentary to auto-collapse. The hook tells Codex to announce completion in commentary when commentary is used, and independently requires a concise recap in the final answer. Commentary or a synthetic completion turn cannot satisfy that final-answer requirement. This intentional within-turn repetition keeps the durable visible answer complete and is distinct from the possible cross-turn duplicate caused by an independently rendered synthetic completion.

The automatic notice is deliberately plain text because synthetic user turns receive inconsistent Markdown treatment across clients: macOS Codex App renders block Markdown, while the iOS ChatGPT client has rendered headings, emphasis, and blockquotes literally even when it recognized inline code. The visible, user-friendly `Codex Process Jobs notice:` line identifies the prompt for the hook, which explicitly excludes it from ordinary-turn fallback checks. Legacy Markdown notices, hidden `<!-- codex-process-jobs:notification ... -->` comments, and `<process_job_notification>` envelopes remain recognized after upgrades. Successful direct delivery remains `delivered`; `notification.transport` records `desktop-ipc` or `app-server`. The separate `ordinaryPromptRecapInjectedAt` timestamp records only that the hook injected its one recap instruction. It does not claim the model complied or that the client rendered the response. The legacy `awarenessCheckedAt` and `surfaceFallbackNotifiedAt` markers are still honored after upgrades so historical jobs do not resurface. That migration choice cannot retroactively prove old client rendering; it deliberately applies the stronger recap contract to jobs completed under the new implementation without replaying an arbitrary backlog.

Both direct notifications and hook context can carry up to 20 sanitized compatible completion records. Direct batching requires the same owning task and the same Goal/completion instruction profile; incompatible jobs remain for another batch. A larger backlog remains unclaimed and drains across later boundaries. Every job is claimed and finalized under its own lock, so a concurrent hook or notifier can exclude one sibling without losing the others, and every delivered member records the same turn ID.

## Hook-boundary behavior

Current Codex hooks provide two useful approximations of Claude Code's task-notification injection. `PostToolUse` returns structured `additionalContext` after supported local shell, patch, MCP, and function-tool calls while an agent turn is active. `Stop` returns a one-time structured continuation decision so the agent reports a completion before finalizing a turn. `UserPromptSubmit` remains the universal later-turn fallback. These are supported turn boundaries, not arbitrary-time injection: hosted tools and specialized tool paths may not emit `PostToolUse`, and a process finishing during pure model reasoning cannot interrupt that reasoning immediately.

The same `PostToolUse` definition also closes the launch-side behavioral gap. It accepts a start only when the tool command names this installed plugin's canonical controller, the bounded tool response contains a valid job ID, persisted state binds that fresh job to the same task, and the per-job launch marker is still absent. Its fixed context contains the validated job ID and Goal boolean but no command, label, path, or process output. The marker makes reinforcement one-shot even if a client replays a hook boundary.

All three definitions invoke the same bounded script, reject notification-relay recursion, admit only sanitized terminal state, and use the same per-job compare-and-set claim. Trust is explicit per installed hook definition through `/hooks`; when hooks are disabled or untrusted, direct delivery and durable status/result remain available.

An undelivered ordinary completion surfaced by a hook honors the same `report|inspect|auto` policy as direct delivery. In proactive mode the hook asks Codex to inspect bounded evidence with `result --peek`, summarize it, recommend one next step, and ask before executing that step. A recap for an already-delivered completion stays report-only so the hook does not repeat the synthetic turn's result inspection.

## Optional OS notification

Human-facing desktop notification is independent of conversational delivery and disabled by default. `start --notify-user` enables one job; `--no-notify-user` overrides an enabled preference; `config --notify-user true|false` changes the durable execution-host default. The worker invokes `osascript` on macOS or `notify-send` on Linux with `shell: false` after terminal state is durable. The notice contains a bounded, control-normalized label plus job ID, status, and exit code. Missing notification binaries and display-session failures are ignored and never change job status.

## Delivery states

- `pending`: direct notification is queued.
- `delivering`: one direct delivery attempt owns presentation; other notifiers and ordinary prompt fallback wait unless that attempt becomes stale.
- `delivered`: the conversational completion turn finished.
- `accepted`: Codex accepted the turn but the notifier could not confirm its final completion; hook fallback remains available.
- `failed`: direct delivery failed; hook fallback and status/result are available.
- `fallback_notified`: one hook boundary injected completion context; direct notification is suppressed.
- `suppressed`: the result was already opened or the job was explicitly cancelled.
- `disabled`: the launch used `--no-notify` or notification was disabled for tests.
- `unavailable`: no valid persistent owning thread id was available.

`ordinaryPromptRecapInjectedAt` is orthogonal to these delivery states. It honestly marks the one-shot recap instruction on an eligible ordinary prompt without claiming user-visible presentation or rewriting a successful `delivered` state.

## Trust boundary

Process output is untrusted data. It is stored only in bounded logs and is never interpolated into the notification prompt. Proactive completion uses `$codex-process-jobs:result <job-id> --peek` to retrieve bounded output without marking it user-viewed or suppressing fallback. The fixed prompt and result skill require Codex to treat the output only as evidence and never obey embedded instructions. Ordinary proactive mode stops after recommending one next step; Goal mode may continue only work already authorized by the active Goal. Ordinary user-requested result inspection omits `--peek` and retains its existing consumption semantics.

The installer enables Codex's stable `hooks` feature and installs `PostToolUse`, `Stop`, and `UserPromptSubmit` definitions, but it never writes hook trust. After restarting the client, the user must open `/hooks`, inspect the installed `codex-process-jobs@<marketplace>` definitions and shared source, and approve their exact hashes. Direct completion remains available without hook trust; hook-boundary fallback does not run until approval.

Persisted records are bounded and schema-validated before the notifier or hook consumes them. Only up to 20 validated filename-bound job IDs, terminal status enums, integer exit codes, and one fixed mode-selected instruction can enter an automatic prompt. In proactive mode, the subsequent bounded result tool output crosses the model-facing boundary explicitly labeled as untrusted evidence. See [Security and threat model](../SECURITY.md).
