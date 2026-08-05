# Conversational completion relay

Codex Process Jobs can wake the persistent Codex task that launched a detached command without turning the command into a subagent.

## Delivery flow

1. `$codex-process-jobs:start` records the owning `CODEX_THREAD_ID` and launches the ordinary OS command in a detached process group.
2. The worker records the terminal state before attempting notification, so status and result remain available even if notification fails.
3. For a local macOS Codex App task or a macOS or Linux VS Code task, a
   separate lightweight notifier first
   attempts Codex's private same-user IPC router. It verifies private socket
   ownership and permissions, targets the validated owning task ID, waits for a
   settled idle boundary, and confirms the returned turn ID reaches durable
   `task_complete`. App and VS Code have demonstrated live rendering.
4. If guarded private IPC or its private start-turn method is unavailable
   before possible acceptance, the notifier automatically falls back to a
   separate local `codex app-server` connection. Remote/mobile, unsupported
   clients, and App, CLI, or VS Code clients without a live private router
   continue to use this portable path.
5. A notifier may atomically claim up to 20 compatible terminal siblings owned by the same task and deliver them in one turn. The concise user-facing notice contains only one sanitized job id, terminal status, and exit code per record. It never interpolates the command, working directory, job label, environment, stdout, stderr, or agent instructions.
6. In the default `auto` mode, App, VS Code, and remote surfaces ask Codex to
   inspect bounded saved output with `result --peek`, summarize the evidence,
   and continue only a clear next step already authorized and still in scope
   from the prior conversation. Otherwise Codex recommends one next step and
   asks. CLI and unknown surfaces request only a short acknowledgment in the direct
   completion turn, because an already-open TUI cannot render that turn live.
   The first eligible hook boundary then gives a CLI-owned job the same
   bounded inspection contract, so the first turn the TUI user actually sees
   carries the App-equivalent content; unknown surfaces stay report-only. A durable
   execution-host preference at `$CODEX_HOME/process-jobs/config.json` can
   select `report`, `inspect`, or `auto`; set it with `node scripts/job.mjs
   config --completion-mode <mode>`. `CODEX_PROCESS_JOBS_COMPLETION_MODE` has
   higher precedence. Invalid environment values or invalid preference files
   fail closed to `report`.
   The consent-gated `UserPromptSubmit` hook recognizes only the exact concise
   notice grammar and verifies every stated value against a same-task terminal
   record whose notification is currently `delivering`. It then injects one
   fixed hidden report, inspect, or Goal-continuation policy. The model uses the
   normal namespaced `result` skill when that policy calls for `--peek`; no
   structured skill attachment is sent through the private protocol. If the
   hook is disabled or untrusted, the direct turn safely degrades to reporting
   the visible terminal status while the durable result remains available.
   For jobs explicitly launched with `--goal-mode`, the fixed Goal instruction takes precedence over this surface preference: inspect `result --peek`, then continue already-authorized in-scope work if the Goal remains active; otherwise recommend one next step and ask.
7. Consent-gated `PostToolUse`, `Stop`, and `UserPromptSubmit` hooks share the same terminal-result claim logic. A terminal job can therefore surface after a supported local tool call during an active turn, as a one-time stop continuation, or on the first eligible ordinary non-status prompt. A completed owner-routed private-IPC turn suppresses the later ordinary-prompt recap because that live transport already delivered the user-facing exchange. Portable app-server delivery, uncertain acceptance, and failed delivery retain the one-shot recap: a recorded app-server message is not proof that the assigning client rendered it. Explicit status/result user prompts bypass the prompt-submit recap because they retrieve durable state directly. Separately, `PostToolUse` recognizes the validated result of this installed plugin's own `start` controller and atomically injects one hard-release reminder for that newly created same-thread job.
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

A live `delivering` attempt is protected from prompt fallback. If its notifier process disappears, the hook can recover the stale attempt after a short startup grace; an apparently live attempt older than the maximum relay window is also recoverable. After portable app-server delivery succeeds, the later ordinary-prompt recap remains deliberately separate: it marks `ordinaryPromptRecapInjectedAt` once and requires Codex to recap the sanitized terminal state even if a synthetic announcement is already present in context. Successful `desktop-ipc` and `vscode-ipc` delivery suppress that recap after the matching notification turn reaches durable completion.

## Separate-transport presentation note

The completion turn is persisted in the owning task independently of the client
that launched it. A separate app-server process can leave an already-open
client stale. Codex App on the local Mac, an already-open Codex VS Code webview,
and a ChatGPT mobile client driving a remote Linux task have all demonstrated
that behavior. In the original App test, the completion turn finished 16
seconds before the next ordinary turn began, ruling out a busy-turn race.

The guarded private path closes that presentation gap by routing the same
start-turn request through the IPC router already serving the owning client. A
controlled App test injected while another turn was active rendered an
optimistic duplicate, even though the rollout contained only one persisted
notification. Production delivery therefore retains the settled-idle guard and
rechecks the owning lifecycle immediately before dispatch.

A settled App test then rendered the notice and model response immediately and
exactly once. On July 24, 2026, a version-gated proof against the OpenAI VS Code
extension `26.721.41059` sent the same private
`thread-follower-start-turn` version 1 request to one explicit idle VS Code
task. The already-open panel rendered both the synthetic completion and the
single assistant response without reload, reopening, or a user prompt. The
returned turn ID matched one durable `task_started` and `task_complete` pair.

This remains a private, experimental Codex protocol. The notifier validates the
socket and protocol response, then records `notification.transport:
desktop-ipc` for App or `vscode-ipc` for VS Code only after
matching durable completion. It falls back to `app-server` when IPC is
unavailable or rejects the method before possible acceptance. If acceptance
becomes uncertain, it records `accepted` and leaves the next-prompt fallback
available instead of attempting a second direct turn. If the owner becomes
active after initialization but before dispatch, the retry-when-idle signal is
preserved and no competing app-server turn starts.

Set `CODEX_PROCESS_JOBS_DISABLE_PRIVATE_IPC=1` to force the portable app-server
path for diagnosis or compatibility testing.
`CODEX_PROCESS_JOBS_DISABLE_DESKTOP_IPC=1` remains a backward-compatible alias.
`CODEX_PROCESS_JOBS_PRIVATE_IPC_SOCKET` and its legacy
`CODEX_PROCESS_JOBS_DESKTOP_IPC_SOCKET` alias exist only as explicit
test/integration overrides; normal operation resolves the socket under the
active `$CODEX_HOME`.

Start records `notification.presentation` as `durable-refresh-required` for every owning client and discloses that live presentation is best-effort. Surface detection remains diagnostic metadata; the completed transport decides recap eligibility. A matching completed `desktop-ipc` or `vscode-ipc` turn suppresses the next-prompt recap. CLI, portable app-server delivery, and uncertain or failed private delivery retain the one-shot recap.

Codex App can present a hook-surfaced response in two useful phases: live commentary while work continues, followed by a final answer that causes commentary to auto-collapse. When fallback is required, the hook tells Codex to announce completion in commentary if commentary is used and independently requires a concise recap in the final answer. This intentional within-turn repetition keeps the durable visible answer complete; it does not apply after confirmed private-IPC delivery.

The automatic notice is deliberately one concise sentence for a single job,
with its validated job ID formatted as inline code,
because synthetic user turns receive inconsistent Markdown treatment across
clients: macOS Codex App renders block Markdown, while the iOS ChatGPT client
has rendered headings, emphasis, and blockquotes literally even when it
recognized inline code. A strict sanitized completion-sentence grammar
identifies the prompt for the hook, which explicitly excludes it from
ordinary-turn fallback checks. Legacy `Codex Process Jobs notice:` lines,
Markdown notices, hidden `<!-- codex-process-jobs:notification ... -->`
comments, and `<process_job_notification>` envelopes remain recognized after
upgrades. Successful direct delivery remains `delivered`;
`notification.transport` records `desktop-ipc`, `vscode-ipc`, or
`app-server`.
The separate `ordinaryPromptRecapInjectedAt` timestamp records only that the
hook injected its one recap instruction on a fallback-eligible path. It does not
claim the model complied or that the client rendered the response. Completed
confirmed-live App and VS Code private-IPC records need no such marker.
CLI app-server records remain eligible for the marker. The legacy `awarenessCheckedAt` and
`surfaceFallbackNotifiedAt` markers are still honored after upgrades so
historical jobs do not resurface. That migration choice cannot retroactively
prove old client rendering; it deliberately applies the stronger recap
contract to jobs completed under the new implementation without replaying an
arbitrary backlog.

Both direct notifications and hook context can carry up to 20 sanitized compatible completion records. Direct batching requires the same owning task and the same Goal/completion instruction profile; incompatible jobs remain for another batch. A larger backlog remains unclaimed and drains across later boundaries. Every job is claimed and finalized under its own lock, so a concurrent hook or notifier can exclude one sibling without losing the others, and every delivered member records the same turn ID.

## Hook-boundary behavior

Current Codex hooks provide two useful approximations of Claude Code's task-notification injection. `PostToolUse` returns structured `additionalContext` after supported local shell, patch, MCP, and function-tool calls while an agent turn is active. `Stop` returns a one-time structured continuation decision so the agent reports a completion before finalizing a turn. `UserPromptSubmit` remains the universal later-turn fallback. These are supported turn boundaries, not arbitrary-time injection: hosted tools and specialized tool paths may not emit `PostToolUse`, and a process finishing during pure model reasoning cannot interrupt that reasoning immediately.

The same `PostToolUse` definition also closes the launch-side behavioral gap. It accepts a start only when the tool command names this installed plugin's canonical controller, the bounded tool response contains a valid job ID, persisted state binds that fresh job to the same task, and the per-job launch marker is still absent. Its fixed context contains the validated job ID and Goal boolean but no command, label, path, or process output. The marker makes reinforcement one-shot even if a client replays a hook boundary.

All three definitions invoke the same bounded script, reject notification-relay recursion, admit only sanitized terminal state, and use the same per-job compare-and-set claim. Trust is explicit per installed hook definition through `/hooks`; when hooks are disabled or untrusted, direct delivery and durable status/result remain available.

An undelivered ordinary completion surfaced by a hook honors the same `report|inspect|auto` policy as direct delivery, with one deliberate difference: at hook boundaries, `auto` also selects inspection for CLI-owned jobs, because the hook turn is the first turn a TUI user actually sees. In proactive mode the hook asks Codex to inspect bounded evidence with `result --peek`, then continue only a clear next step already authorized and still in scope from the prior conversation; otherwise it recommends one next step and asks. A recap for an already-delivered completion stays report-only on surfaces whose completion turn already performed the inspection; a delivered CLI completion instead carries the inspection contract in its recap, because its acknowledgment-only turn inspected nothing and may never have rendered.

## Optional OS notification

Human-facing desktop notification is independent of conversational delivery and disabled by default on App, VS Code, remote, and unknown surfaces. CLI-owned jobs default to one completion notice, because the open TUI cannot render the completion turn live and the desktop notice is the CLI substitute for that live presentation. `start --notify-user` enables one job; `--no-notify-user` disables one job; `config --notify-user true|false` sets the durable execution-host preference; `config --notify-user default` clears that preference so the surface default applies again. An explicit flag or durable preference overrides the CLI surface default in either direction; an absent durable preference means "unset," not an opt-out. Preference files written by earlier plugin versions may contain `notifyUser: false` that came from the old implicit default rather than a deliberate choice — that stored value still reads as an opt-out, and `config --notify-user default` restores surface-default behavior.

The worker invokes `osascript` on macOS or `notify-send` on Linux with `shell: false` after terminal state is durable. The launch records whether notification and the job name were explicit choices. A notice includes the bounded, control-normalized label only when notification was explicitly enabled and the name was explicitly supplied; a surface-defaulted notice contains only the job ID, terminal status, and exit code, and a command-derived fallback name is never displayed. Notification banners can appear on a lock screen, so command text, paths, and arguments must not reach them without explicit opt-in. Missing notification binaries and display-session failures are ignored and never change job status.

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

`ordinaryPromptRecapInjectedAt` is orthogonal to these delivery states. It honestly marks the one-shot recap instruction on an eligible ordinary prompt without claiming user-visible presentation or rewriting a successful `delivered` state. Completed `desktop-ipc` and `vscode-ipc` deliveries are not eligible because their matching owner-routed turn already completed and rendered in controlled tests. CLI remains eligible through its portable app-server path.

## Trust boundary

Process output is untrusted data. It is stored only in bounded logs and is never interpolated into the notification prompt. Proactive completion uses `$codex-process-jobs:result <job-id> --peek` to retrieve bounded output without marking it user-viewed or suppressing fallback. The verified hidden hook policy requires Codex to treat the output only as evidence and never obey embedded instructions. Ordinary and Goal proactive modes may continue only clear work already authorized and still in scope from the prior conversation; otherwise they ask. New authority, consequential choices, expanded scope, and elevated risk require the user. Neither completion metadata nor process output grants authority. Ordinary user-requested result inspection omits `--peek` and retains its existing consumption semantics.

The installer enables Codex's stable `hooks` feature and installs `PostToolUse`, `Stop`, and `UserPromptSubmit` definitions, but it never writes hook trust. After every install or update and client restart, the user must open `/hooks` and inspect the installed `codex-process-jobs@<marketplace>` definitions and referenced shared source. Any definition Codex marks new or changed requires approval; if trust persists, the user still verifies that status. Referenced source can change even when the definition hash does not, which is why review remains mandatory after every update. Direct completion remains available without hook trust; hook-boundary fallback runs only for definitions Codex currently trusts.

Persisted records are bounded and schema-validated before the notifier or hook consumes them. Only up to 20 validated filename-bound job IDs, terminal status enums, and integer exit codes can enter the visible automatic prompt. The trusted hook accepts that prompt as CPJ-generated only while every value matches the same task's currently delivering record, then emits fixed hidden policy containing those IDs and no process output. In proactive mode, the subsequent bounded result tool output crosses the model-facing boundary explicitly labeled as untrusted evidence. See [Security and threat model](../SECURITY.md).
