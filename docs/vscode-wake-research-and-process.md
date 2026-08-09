# Completion Wake: VS Code and Cartesian Surface Research

- Status: guarded private-IPC live rendering verified in an already-open local
  VS Code task; transport-independent post-tool, stop, and next-prompt pickup
  remains the compatibility fallback
- Research dates: 2026-07-10 through 2026-07-24

## Goal

Codex Process Jobs runs long local commands such as CMake builds, test suites, inference comparisons, and device repairs without holding an agent turn open. A finished process should wake the owning Codex task conversationally when the active Codex client supports it. The behavior and wording must remain honest across Codex App, Codex CLI, the Codex VS Code extension, and mobile-driven remote execution on macOS and Linux.

This document records the research process, evidence, current product contract, implementation decision, and safe paths for future work.

## Executive finding

The detached process and durable completion turn work. The remaining limitation on stale-capable clients is presentation and next-turn context refresh, not job tracking or persistence.

- Codex App and Codex CLI can sometimes display the synthetic completion turn live, but that presentation is not guaranteed.
- A separate `codex app-server` process can append the same completion turn to
  a task opened in the Codex VS Code extension, but the already-open panel does
  not receive that other process's event stream.
- The extension also participates in Codex's private same-user IPC router. A
  guarded `thread-follower-start-turn` request routed through that owner
  rendered the completion and assistant response immediately in the exact
  already-open task.
- Consent-gated hooks can supply sanitized completion state after a supported local tool call, at the turn's stop boundary, or on the assigning agent's next eligible ordinary non-status turn. Explicit status/result requests retrieve durable state directly instead.
- The same stale-context behavior was observed when ChatGPT mobile drove Codex on a remote Linux host: the durable transcript contained the completion, but the agent handling the next request did not.
- Local Codex App exposed both failure variants. In one test, a synthetic completion turn finished 16 seconds before the next unrelated turn yet was absent from assigning-agent context. In a later test, the hidden completion was present in model context but absent from the rendered and exported conversation, proving that context presence is not evidence of user-visible presentation.
- No documented Codex extension command or API currently asks the open panel to refresh an externally updated task.

The supported behavior is therefore transport-aware rather than
surface-dependent. App and VS Code may use guarded private IPC for a proven
live owner-routed turn. CLI, remote, unsupported clients, and any private-path
failure retain the separate
app-server relay. Every surface still receives durable completion,
opportunistic pickup at supported agent-loop boundaries, one mandatory
later-turn recap fallback when live rendering is not confirmed, and direct
status/result retrieval.
When owner-routed private delivery is not confirmed, a recorded app-server turn
may be recapped once because durable transcript state does not prove that the
assigning client rendered it.

## 2026-07-20 supported hook-boundary upgrade

The official Codex hook system in `codex-cli 0.144.5` exposes turn-scoped `PostToolUse` and `Stop` events in addition to `UserPromptSubmit`. CPJ now registers the same sanitized, compare-and-set hook for all three. `PostToolUse` approximates Claude Code's mid-turn task notification after supported local tool calls, and `Stop` can continue a stopping turn once so the completion reaches the final response. These events do not repair the VS Code renderer's separate-transport refresh gap, but they often let the assigning agent see completion before another user message. They remain explicit-consent hooks and are not an arbitrary-time interrupt during pure reasoning or hosted-tool work.

## 2026-07-14 launch-turn hostage incident

A live GPT-5.6 Sol task in the Codex VS Code extension on Linux exposed a separate assigning-agent failure. Sol registered a detached evaluation job and gave the correct background/notification explanation, but seven seconds later loaded the status skill. It then repeatedly invoked `status --wait --timeout-ms 55000`, waited on the yielded tool sessions, and added independent process probes. The owning lifecycle remained active, so the notifier could not acquire the idle boundary required for completion delivery. Detachment worked; the model recreated blocking behavior above it.

The root cause was an instruction and acceptance-test gap. The start skill and optional global policy required the four conversational launch facts but did not explicitly end the launch turn or prohibit same-turn monitoring. The surface smoke-test prompt itself supplied “return immediately” and “end the turn without calling status, wait, or result,” masking the missing installed behavior.

The corrected contract makes successful registration a hard launch-turn release boundary. The assigning agent does not read status or call status, tail, result, `--wait`, `write_stdin`, sleep, `ps`, or another monitor/probe after start returns. It may finish already-requested independent work, but defers result-dependent work to completion delivery, a later user-initiated turn, or a later automatic continuation of an explicitly active Goal. Only an explicit request to keep that exact turn open and wait overrides the boundary; that narrow exception permits one bounded wait and same-turn result inspection only if terminal. The smoke prompt no longer coaches this behavior, so future surface tests exercise the installed skill and policy honestly.

## Why the open VS Code panel stays stale

Codex app-server events are transport-scoped. The official protocol tells a client to start or resume a thread and then keep reading notifications such as `turn/completed` and `thread/status/changed` on that active transport. A subscription can also be removed per connection with `thread/unsubscribe`. See the [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).

The installed Codex VS Code extension version inspected during this research starts its own `codex app-server` child over stdio. It reads events from that child and forwards them to its own webviews. Codex Process Jobs starts a different app-server process to append the sanitized completion turn. That second process sees its own events and persists the turn, but the extension's first process has no cross-process invalidation event to forward.

This behavior matches two public upstream reports:

- [External app-server turns do not live-refresh an already-open Codex view](https://github.com/openai/codex/issues/21743).
- [There is no supported way to force a live TUI to resync an externally updated thread](https://github.com/openai/codex/issues/11957).

Those reports are examples rather than a formal compatibility guarantee, but they describe the same process-local event-stream boundary observed here.

## Research process

The investigation used multiple independent paths:

1. Ran controlled detached jobs that finished after the initiating agent turn ended.
2. Verified that the completion relay created a sanitized synthetic turn in the original task through app-server.
3. Compared live behavior in Codex App, Codex CLI, and the Codex VS Code extension.
4. Confirmed in VS Code that the completion turn existed after reload even though the already-open panel did not update.
5. Inspected job state and the owning rollout to distinguish failed delivery from failed presentation.
6. Inspected the installed Codex VS Code extension manifest and bundle to identify its private stdio app-server child and webview event route.
7. Inspected current Codex app-server documentation and related upstream issues for supported transport and refresh semantics.
8. Compared the installed Claude Code VS Code extension and asked Claude for an independent architectural explanation.
9. Tested the stable client-origin marker used by the Codex VS Code extension and added automated surface-detection coverage.
10. Repeated the workflow from ChatGPT mobile against a remote Linux execution host and compared durable transcript order with the assigning agent's later context.
11. Repeated a 75-second heartbeat entirely in local Codex App and verified that the durable completion finished before, but was absent from, the next assigning-agent context.
12. Repeated the App heartbeat after adding universal next-turn awareness and found the complementary case: the hidden synthetic assistant completion was loaded into model context, the App did not render or export it, and context-based duplicate suppression incorrectly omitted the recap from the next visible response.
13. Repeated the App heartbeat after requiring the recap regardless of model-context history and verified visible success: the first unrelated post-terminal turn reported completion in live commentary, continued unrelated work, and preserved the recap in its final answer.
14. Repeated the same App flow and observed a presentation split: Codex reported completion in live commentary but omitted it from the final answer, so App auto-collapse removed the outcome from the durable rendered answer. This established final-answer retention as a separate requirement.
15. Repeated the App flow after enforcing final-answer retention and passed the full acceptance contract: completion appeared in commentary, unrelated local inspection continued, and the rendered final answer retained both the requested result and the successful detached-job outcome.

The initial investigation did not modify either vendor extension, restart an
extension host, or install a persistent daemon. The later July 24 proof wrote
one deterministic harmless completion request to Codex's same-user private IPC
socket after verifying ownership, permissions, the exact active extension
version, and the method-version literal in its bundle. No vendor files or
settings were changed.

## Installed VS Code verification

After installing the surface-aware build, a fresh task in the real Codex VS Code extension was given a harmless five-second direct-argv job. The extension discovered `$codex-process-jobs:start` without a filesystem path, launched the job, recorded `ownerSurface: "vscode"` and `notification.presentation: "durable-refresh-required"`, and responded with the required warning that the open panel might not visibly wake.

The job completed with exit code zero, all expected output was preserved, and the separate app-server relay recorded its completion turn as delivered. The already-open VS Code panel showed no change after ten seconds. Navigating Back and reopening the task within the same extension webview also remained stale. After running **Developer: Reload Window** and reopening the task, the transcript contained both the synthetic completion event and Codex's conversational completion sentence.

This confirms the current boundary precisely: durable delivery succeeds, task navigation alone does not invalidate the open extension cache, and a full VS Code window reload rehydrates the externally appended turn.

### Historical next-turn context verification

The following VS Code test records the pre-recap contract and its historical field names. It is evidence for the transport boundary, not the current duplicate policy.

A second real-extension test launched a five-second job whose randomized exit code was not knowable from the launch turn. The job exited `7`, and the notifier recorded `status: delivered` plus `presentation: durable-refresh-required`. Without reloading or reopening the task, the user then asked the same assigning agent to report the exit code from the most recent `<process_job_notification>` in its context and prohibited tool use or inference. The agent answered `NONE`.

Inspection found that the synthetic completion turn itself had triggered the `UserPromptSubmit` hook while notification status was `delivering`. That consumed the old `hookNotifiedAt` marker; successful delivery then preserved the marker while changing status to `delivered`, so the next real prompt was skipped.

The corrected design separates the two facts. Synthetic notification prompts never consume fallback state. A terminal VS Code job with `presentation: durable-refresh-required` and `status: delivered` remains eligible until a real prompt receives its sanitized id, status, and exit code. That prompt writes `surfaceFallbackNotifiedAt` while preserving `status: delivered`, making agent awareness one-shot and auditable without claiming that the webview visibly woke.

After installing that historical hook, a fresh real-extension task launched `job-mrfj6cze-68619cd8`, which exited `7`. Its durable completion turn reached `status: delivered` while the open panel remained unchanged. On an unrelated “what is 2 + 2?” follow-up with tool use prohibited, the assigning agent first reported the job and exit code, then answered `4`. A second unrelated “what is 3 + 3?” turn answered only `6`. The stored job retained `status: delivered` and gained one `surfaceFallbackNotifiedAt` timestamp. This verified the older next-turn behavior in that VS Code build; later App evidence disproved its assumption that an assistant message present in context was necessarily rendered.

That paragraph preserves the historical field name. A later transport-independent implementation wrote `awarenessCheckedAt`. The current implementation writes `ordinaryPromptRecapInjectedAt`, which records only that the hook injected a recap instruction; it continues to honor both older markers so an upgrade cannot resurface historical jobs.

### Continued-turn race hardening

A later state review identified a second interleaving: a process could finish while ordinary user turns continued, allowing prompt fallback to claim `pending` just as the worker or notifier tried to start direct delivery. Without guarded state transitions, the later writer could reset `fallback_notified` to `pending` and eventually append a duplicate synthetic completion.

The relay now treats presentation as an atomic claim. Worker bookkeeping never overwrites `fallback_notified`; the notifier re-checks suppression under the job lock before changing `pending` to `delivering`; a live `delivering` attempt blocks prompt fallback and additional notifiers; and notifier success/failure finalizers preserve a fallback that won concurrently. A dead or over-age delivering attempt remains recoverable so duplicate prevention cannot strand completion permanently. Automated coverage exercises worker bookkeeping, notifier start/finalization, active and stale delivering attempts, accepted fallback, and concurrent prompt claims.

### Hot reinstall and stale hook state

A later VS Code-only test exposed a separate installation boundary. The extension's app-server process was already running when a new plugin snapshot and trusted hook hash were installed. A subsequent task could use the updated skill and launch a job, and the external relay durably completed its synthetic turn, but the next ordinary prompt did not receive the hook fallback. The job remained without `surfaceFallbackNotifiedAt`. An earlier job from a client process that had loaded the hook correctly did record that marker.

The evidence points to stale plugin or hook state in the already-running VS Code app-server after a hot reinstall. Reading the result later set `resultViewedAt` and correctly suppressed future fallback, but that happened after the missed prompt and was not the cause.

The supported update procedure now requires a client restart before testing. In VS Code, run **Developer: Reload Window** after every install or update. Quit and restart Codex App or CLI. Then review the hook in `/hooks` and start a fresh task; opening a new task in a pre-install client is not a sufficient refresh boundary.

### Rendered visibility is not model-context visibility

A later local Codex App test completed a 75-second heartbeat with exit code zero. The separate app-server relay durably recorded the synthetic user event, Codex's one-sentence assistant completion, and a successful terminal turn. The open App conversation and its exported transcript did not show that completion sentence.

Twenty seconds later, an unrelated ordinary prompt triggered the transport-independent hook. The assigning model's context contained the hidden synthetic completion, so the previous hook instruction—"do not repeat when a prior assistant completion is present"—caused Codex to answer only the unrelated question. A later user question confirmed that the agent had received the completion before that response.

This established a stricter boundary than stale context alone: a message can exist in durable rollout state and model context while remaining absent from the rendered conversation. At that stage the plugin had no trustworthy client-rendered visibility signal, so the hook required one short recap on the first eligible ordinary non-status prompt even when the synthetic assistant message was already in context. The later owner-routed private IPC transport supplied a stronger signal and now suppresses this recap only after its matching turn completes; portable app-server delivery retains it. The state field `ordinaryPromptRecapInjectedAt` records fallback injection only; it does not claim model compliance or rendered presentation.

### Successful local App recap verification

After installing the mandatory-recap hook and restarting Codex App, another 75-second heartbeat completed with exit code zero. The synthetic completion turn finished successfully and remained absent from the rendered/exported conversation. About eight seconds later, the user submitted an unrelated Mars question. The hook injected the sanitized completed state and wrote `ordinaryPromptRecapInjectedAt`; Codex immediately reported the successful heartbeat in live commentary, continued the unrelated research, and preserved the completion again in the final answer.

This is the first verified end-to-end rendered success for the transport-independent fallback on local Codex App. It proves that a detached ordinary process can finish, record a hidden durable completion, and then regain visible conversational continuity on an eligible ordinary exchange after terminal state without polling or a subagent. In this test, that happened on the first post-terminal prompt because notifier delivery had already settled. The commentary-plus-final presentation is desired on App: commentary is readable live but auto-collapses when the final answer renders, so the final repetition keeps the completion visible in the durable chat.

The test also exposed a wording precision issue. “The next ordinary exchange will recap the outcome” is false when an exchange occurs before the process finishes. A review then found a narrower post-terminal race: an ordinary prompt can arrive while notifier-owned delivery is still in flight and correctly decline to race it. Launch wording now says: “After it finishes, I'll recap the outcome as soon as our conversation can pick it up.” The technical contract is the first eligible non-status prompt after delivery settles.

### Commentary-only recap is not durable App presentation

A subsequent local App heartbeat reached the same successful process and relay states. After delivery settled, an unrelated technical question triggered the hook and wrote `ordinaryPromptRecapInjectedAt`. Codex immediately announced the successful completion in live commentary, performed unrelated research, and then omitted the completion from its final answer. The exported conversation retained the commentary only inside collapsed prior-message details.

This result confirms that “recap before handling the new request” is insufficient on App: commentary satisfies that instruction but auto-collapses when the final answer renders. The hook now states two independent requirements. If commentary is used, announce completion there for live visibility. In all cases, the final answer must also retain a concise completion recap; neither commentary nor a synthetic completion turn satisfies that final-answer requirement. The within-turn repetition is intentional.

### Local App acceptance baseline

The next local App run passed both presentation phases. After the 75-second heartbeat finished and delivery settled, an unrelated disk-capacity request triggered the hook. Codex reported the successful exit in live commentary, completed the local disk inspection, and retained a concise successful-job recap in the rendered final answer alongside the requested capacity result. The second channel therefore survived App's commentary auto-collapse exactly as intended.

This redacted sequence is the macOS App acceptance baseline for release-candidate testing. Equivalent runs should now be recorded for local VS Code and CLI, Linux VS Code and CLI, and mobile/iOS driving each execution host. See [Codex surface smoke test](surface-smoke-test.md) for the matrix and required reinstall/restart boundaries.

## Surface detection

The Codex VS Code extension launches its child process with:

```text
CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex_vscode
```

Codex Desktop uses a different originator value. This makes the exact inherited environment marker a practical way for the launcher to identify known local App, CLI, and VS Code surfaces before it detaches.

The rollout's generic `source` field is not sufficient to identify VS Code. Custom app-server clients can also be recorded as `source: "vscode"`; that ambiguity is documented in [openai/codex issue #16614](https://github.com/openai/codex/issues/16614).

Mobile-to-remote execution exposed a second path: the launcher environment had no originator marker, while the owning rollout recorded scalar `source: "vscode"` plus `originator: "Codex Desktop"`. Only when the environment originator is absent, that exact pair is classified as `remote`, meaning refresh-uncertain rather than proven physical remoteness. Explicit overrides and any non-empty environment originator take precedence. Object-valued rollout sources such as subagent records never qualify.

The implementation stores normalized metadata only:

```text
ownerSurface: vscode | app | cli | remote | unknown
ownerSurfaceDetectedBy: codex-originator | process-jobs-override | rollout-session-meta | null
notification.presentation: durable-refresh-required | status-only | disabled
```

It does not persist the inherited environment or raw rollout metadata. `CODEX_PROCESS_JOBS_CLIENT_SURFACE` is an explicit escape hatch for wrappers and testing. See [Cartesian client and execution surfaces](cartesian-surfaces.md) for the evidence, ambiguity boundary, and mobile retest.

## User-facing contract

| Surface | Completion behavior | Launch wording |
|---|---|---|
| Codex App | Guarded private IPC can render the completion live; a matching completed private turn suppresses the later recap, while portable or uncertain delivery retains it | Completion will be recorded; a live notification may appear. If live delivery cannot be confirmed, I'll recap the outcome as soon as our conversation can pick it up. |
| Codex CLI | Default completion uses the portable app-server path and the first eligible non-status prompt receives one recap. Explicitly opted-in sessions can render live through a pre-existing official shared App Server and suppress the recap after matching durable completion. | Same transport-honest wording as App. |
| Codex VS Code | Guarded private IPC can render the completion and response in the already-open task; a matching completed private turn suppresses the later recap, while unsupported clients retain it | Same transport-honest wording, with status available any time. |
| Mobile/remote | Completion turn is recorded; live presentation is best-effort; the first eligible non-status prompt after delivery settles requires one recap | Same transport-honest wording, with status available any time. |
| Unknown surface with an owning thread | Completion turn is attempted and recorded when possible; live presentation is best-effort; the same eligible recap applies | Same transport-honest wording, with status available any time. |
| No owning thread | No conversational relay | Use status/result to check completion. |

The distinction is deliberately between a backend wake, visible transcript
presentation, and the context loaded into the next assigning agent. These have
diverged in VS Code, mobile-driven remote tasks, and local Codex App. The
private owner-routed VS Code proof closed the first presentation gap for one
verified build without erasing those independent fallback layers.

## Why Claude's extension behaves differently

The inspected Claude Code VS Code extension owns a live Claude CLI subprocess for each active chat channel. It launches the CLI with a structured streaming protocol, consumes the process's event stream, and forwards each event through VS Code webview messaging. Completion therefore arrives on the same live transport that owns the open UI. The extension can also set an unseen-completion badge and invoke native VS Code notifications. Anthropic documents the integrated extension behavior in [Use Claude Code in VS Code](https://code.claude.com/docs/en/vs-code).

Claude hooks are not the webview's core wake path. They are user-defined commands, HTTP endpoints, or prompts fired at lifecycle events, as described in the [Claude Code hooks reference](https://code.claude.com/docs/en/hooks). They are useful outward adapters, but the extension repaints because it owns the active worker event stream.

The transferable lesson is straightforward: durable state and a live subscription solve different problems. A UI can repaint immediately only when it observes completion through its own active transport or a supported cross-client invalidation bridge.

## Options considered

### 1. Transport-independent durable completion

This remains the compatibility foundation. It is portable, preserves job state
across client exit, and injects one mandatory recap on the first eligible
ordinary non-status prompt when live owner-routed delivery was not confirmed.
The proven private App/VS Code path is a presentation enhancement above it:
after its matching turn reaches durable completion, CPJ suppresses the later
recap rather than repeating an exchange that the owning client already
received. CLI retains that portable default; an explicitly opted-in session
can use the separate guarded shared-App-Server path when its active Codex
distribution already supports the managed daemon.

### 2. Companion VS Code extension

A small extension could watch the broker's durable job events and show `vscode.window.showInformationMessage`, a badge, or a status item. That would provide reliable human notification and could reveal the Codex panel when clicked.

It would not, by itself, inject a turn into or force-refresh OpenAI's Codex webview. VS Code extensions cannot directly post into another extension's webview unless that extension exposes a command or API for the operation. This remains a potentially useful optional notification layer, not a complete conversational-wake solution.

### 3. Shared app-server transport

This is the clean architectural solution: the Codex extension and completion relay would use the same long-lived app-server, so both would observe the same turn events. Codex now documents remote app-server/TUI transport, but the inspected VS Code extension still starts a private stdio server and exposes no supported setting for attaching to an existing shared server.

The extension's development-only CLI executable override might be used to prototype a proxy, but it is not an acceptable default. Such an experiment would require explicit approval because it changes how the extension starts Codex and may require a persistent daemon.

### 4. Private Codex IPC

The installed extension contains an undocumented local IPC router with internal
thread-follower methods. Both inspected builds (`26.721.30844` and the active
`26.721.41059`) advertised `thread-follower-start-turn` protocol version 1 and
used the same length-prefixed JSON handshake.

A one-shot proof targeted one explicit idle VS Code task through the standard
private `$CODEX_HOME/ipc/ipc.sock`. The router returned one turn ID; the rollout
contained one matching synthetic user notice, one `task_started`, one assistant
response, and one `task_complete`; and the already-open panel rendered the
notice and response without reload, reopening, navigation, or another user
prompt.

The current notice renders only concise sanitized terminal metadata. The
trusted prompt-submit hook validates that exact notice against the same task's
in-flight delivery record, then supplies the fixed report,
proactive-inspection, or Goal-continuation contract as hidden context. The model
uses the normal result skill when that contract calls for bounded inspection,
so implementation instructions no longer fill the user-facing synthetic
bubble.

The production path therefore uses the same guarded transport already proven
for local Codex App, extended to VS Code on macOS and Linux. It validates a
same-user private socket, sends only the sanitized task-bound completion input,
checks the returned turn ID, and confirms matching durable completion.
Unsupported or changed private methods fall back to app-server only before
possible acceptance. Connection loss or timeout after dispatch fails closed as
accepted-but-unconfirmed rather than risking a duplicate.

This remains experimental rather than an OpenAI compatibility guarantee.
Method names, payloads, ownership rules, and socket behavior may change without
notice. Durable state, status/result, consent-gated hooks, and the ordinary-turn
recap remain authoritative fallbacks.

### 5. Upstream refresh API

The ideal fix is an official command, exported extension API, or app-server cross-client invalidation event that asks the owner of an open task to re-read it. The plugin should adopt that mechanism when OpenAI documents one.

## Portability notes

- Surface detection prefers inherited environment metadata and uses bounded rollout metadata only for the exact refresh-uncertain remote fallback; it requires no macOS-specific process inspection.
- The process broker remains limited to macOS and Linux because process-group management and shell behavior are POSIX-specific.
- The same VS Code origin marker is set in the inspected native and WSL launch paths, but each future extension version should remain covered by smoke testing.
- No companion extension, daemon, socket service, vendor-extension patch, or
  VS Code setting override is required. CPJ uses a router already created by the
  active Codex client and starts no persistent IPC service.

## Verification requirements

The production implementation retains these release checks:

1. Completion appears without reload in the exact owning task.
2. Multiple VS Code windows and multiple Codex tasks cannot receive each other's completion.
3. The extension can restart during a job and replay the final state exactly once.
4. Concurrent job completions do not duplicate or reorder conversational turns.
5. No process output is injected into the synthetic prompt; only sanitized job metadata crosses the boundary.
6. macOS and Linux/WSL behavior is covered.
7. The private mechanism is explicitly labeled experimental and has an
   automatic safe fallback before possible acceptance.

The local macOS proof establishes requirements 1 and 5 directly. Unit coverage
binds the request to the owning task ID, preserves settled-idle races, validates
batch/exactly-once state claims, accepts macOS and Linux socket locations,
falls back on a rejected private method, and forbids a second transport after
uncertain acceptance. The release smoke matrix still requires a real VS Code
Remote SSH run on Linux and representative restart/multi-task checks.

`durable-refresh-required` plus one-shot recap injection on the first eligible
ordinary non-status prompt remains the compatibility contract when private IPC
is unavailable, fails, or cannot confirm acceptance. A matching completed
owner-routed private-IPC turn suppresses that later recap because the current
App and VS Code transports have demonstrated live delivery of the same turn.
