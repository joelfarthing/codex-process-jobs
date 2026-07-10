# VS Code Completion Wake: Research and Decision Record

- Status: next-turn agent awareness implemented; true live refresh remains an upstream integration gap
- Research date: 2026-07-10

## Goal

Codex Process Jobs runs long local commands such as CMake builds, test suites, inference comparisons, and device repairs without holding an agent turn open. A finished process should wake the owning Codex task conversationally when the active Codex client supports it. The behavior and wording must remain honest across Codex App, Codex CLI, and the Codex VS Code extension on macOS and Linux.

This document records the research process, evidence, current product contract, implementation decision, and safe paths for future work.

## Executive finding

The detached process and durable completion turn work. The remaining VS Code limitation is presentation, not job tracking or persistence.

- Codex App and Codex CLI can display the synthetic completion turn live in the owning task.
- A separate `codex app-server` process can append the same completion turn to a task opened in the Codex VS Code extension.
- The VS Code extension's already-open panel does not receive that other app-server process's event stream. The turn is durable and becomes visible after a full window reload and task reopen.
- The bundled prompt hook now supplies sanitized completion state to the assigning agent on its next ordinary non-status turn, even when the separate completion turn was successfully delivered but the open VS Code webview stayed stale. Explicit status/result requests retrieve that state directly instead.
- No documented Codex extension command or API currently asks the open panel to refresh an externally updated task.

The supported behavior is therefore surface-aware. In VS Code, the plugin promises durable completion, automatic awareness on the assigning agent's next ordinary turn, and direct retrieval for status/result requests—not a live repaint at the instant the process exits.

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

The investigation did not modify either vendor extension, write to a private IPC socket, restart the extension host, or install a persistent daemon.

## Installed VS Code verification

After installing the surface-aware build, a fresh task in the real Codex VS Code extension was given a harmless five-second direct-argv job. The extension discovered `$codex-process-jobs:start` without a filesystem path, launched the job, recorded `ownerSurface: "vscode"` and `notification.presentation: "durable-refresh-required"`, and responded with the required warning that the open panel might not visibly wake.

The job completed with exit code zero, all expected output was preserved, and the separate app-server relay recorded its completion turn as delivered. The already-open VS Code panel showed no change after ten seconds. Navigating Back and reopening the task within the same extension webview also remained stale. After running **Developer: Reload Window** and reopening the task, the transcript contained both the synthetic completion event and Codex's conversational completion sentence.

This confirms the current boundary precisely: durable delivery succeeds, task navigation alone does not invalidate the open extension cache, and a full VS Code window reload rehydrates the externally appended turn.

### Next-turn context verification

A second real-extension test launched a five-second job whose randomized exit code was not knowable from the launch turn. The job exited `7`, and the notifier recorded `status: delivered` plus `presentation: durable-refresh-required`. Without reloading or reopening the task, the user then asked the same assigning agent to report the exit code from the most recent `<process_job_notification>` in its context and prohibited tool use or inference. The agent answered `NONE`.

Inspection found that the synthetic completion turn itself had triggered the `UserPromptSubmit` hook while notification status was `delivering`. That consumed the old `hookNotifiedAt` marker; successful delivery then preserved the marker while changing status to `delivered`, so the next real prompt was skipped.

The corrected design separates the two facts. Synthetic notification prompts never consume fallback state. A terminal VS Code job with `presentation: durable-refresh-required` and `status: delivered` remains eligible until a real prompt receives its sanitized id, status, and exit code. That prompt writes `surfaceFallbackNotifiedAt` while preserving `status: delivered`, making agent awareness one-shot and auditable without claiming that the webview visibly woke.

After installing the corrected hook, a fresh real-extension task launched `job-mrfj6cze-68619cd8`, which exited `7`. Its durable completion turn reached `status: delivered` while the open panel remained unchanged. On an unrelated “what is 2 + 2?” follow-up with tool use prohibited, the assigning agent first reported the job and exit code, then answered `4`. A second unrelated “what is 3 + 3?” turn answered only `6`. The stored job retained `status: delivered` and gained one `surfaceFallbackNotifiedAt` timestamp. This verifies automatic next-turn awareness and exactly-once presentation in the tested VS Code extension build.

## Surface detection

The Codex VS Code extension launches its child process with:

```text
CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex_vscode
```

Codex Desktop uses a different originator value. This makes the exact inherited originator marker a practical way for the launcher to identify the VS Code surface before it detaches.

The rollout's generic `source` field is not sufficient. Custom app-server clients can also be recorded as `source: "vscode"`; that ambiguity is documented in [openai/codex issue #16614](https://github.com/openai/codex/issues/16614).

The implementation stores normalized metadata only:

```text
ownerSurface: vscode | app | cli | unknown
ownerSurfaceDetectedBy: codex-originator | process-jobs-override | null
notification.presentation: conversational | durable-refresh-required | status-only | disabled
```

It does not persist the inherited environment or the raw originator value. `CODEX_PROCESS_JOBS_CLIENT_SURFACE` is an explicit escape hatch for wrappers and testing.

## User-facing contract

| Surface | Completion behavior | Launch wording |
|---|---|---|
| Codex App | Conversational completion turn, with durable status/result fallback | The process will notify this task when it finishes. |
| Codex CLI | Conversational completion turn, with durable status/result fallback | The process will notify this task when it finishes. |
| Codex VS Code | Completion turn is recorded; the assigning agent receives it on the next ordinary prompt or retrieves it directly for a status/result request; the open panel may require reload to display the separate completion turn | Completion will be recorded; this panel may not visibly wake immediately, but the agent will learn the outcome on the next exchange and status is available any time. |
| Unknown surface with an owning thread | Conversational relay is attempted, with durable fallback | The owning task will receive a completion notification. |
| No owning thread | No conversational relay | Use status/result to check completion. |

The distinction is deliberately between a backend wake and a visible wake. In VS Code, the backend agent turn can run and be persisted while the open renderer remains stale.

## Why Claude's extension behaves differently

The inspected Claude Code VS Code extension owns a live Claude CLI subprocess for each active chat channel. It launches the CLI with a structured streaming protocol, consumes the process's event stream, and forwards each event through VS Code webview messaging. Completion therefore arrives on the same live transport that owns the open UI. The extension can also set an unseen-completion badge and invoke native VS Code notifications. Anthropic documents the integrated extension behavior in [Use Claude Code in VS Code](https://code.claude.com/docs/en/vs-code).

Claude hooks are not the webview's core wake path. They are user-defined commands, HTTP endpoints, or prompts fired at lifecycle events, as described in the [Claude Code hooks reference](https://code.claude.com/docs/en/hooks). They are useful outward adapters, but the extension repaints because it owns the active worker event stream.

The transferable lesson is straightforward: durable state and a live subscription solve different problems. A UI can repaint immediately only when it observes completion through its own active transport or a supported cross-client invalidation bridge.

## Options considered

### 1. Surface-aware durable completion

This is the current supported default. It is portable, requires no vendor-private protocol, preserves job state across client exit, informs a stale VS Code task on its next ordinary prompt, and tells the user exactly what to expect.

### 2. Companion VS Code extension

A small extension could watch the broker's durable job events and show `vscode.window.showInformationMessage`, a badge, or a status item. That would provide reliable human notification and could reveal the Codex panel when clicked.

It would not, by itself, inject a turn into or force-refresh OpenAI's Codex webview. VS Code extensions cannot directly post into another extension's webview unless that extension exposes a command or API for the operation. This remains a potentially useful optional notification layer, not a complete conversational-wake solution.

### 3. Shared app-server transport

This is the clean architectural solution: the Codex extension and completion relay would use the same long-lived app-server, so both would observe the same turn events. Codex now documents remote app-server/TUI transport, but the inspected VS Code extension still starts a private stdio server and exposes no supported setting for attaching to an existing shared server.

The extension's development-only CLI executable override might be used to prototype a proxy, but it is not an acceptable default. Such an experiment would require explicit approval because it changes how the extension starts Codex and may require a persistent daemon.

### 4. Private Codex IPC

The installed extension contains an undocumented local IPC router with internal thread-follower and cache-invalidation methods. A version-gated experiment might be able to route a turn through the extension owner or invalidate its query cache.

This is not suitable for a publishable default. Method names, payloads, ownership rules, socket paths, and security expectations are private and may change without notice. Sending a malformed private message could target the wrong window or corrupt UI state.

### 5. Upstream refresh API

The ideal fix is an official command, exported extension API, or app-server cross-client invalidation event that asks the owner of an open task to re-read it. The plugin should adopt that mechanism when OpenAI documents one.

## Portability notes

- Surface detection is based on inherited environment metadata and Node.js, not macOS-specific process inspection.
- The process broker remains limited to macOS and Linux because process-group management and shell behavior are POSIX-specific.
- The same VS Code origin marker is set in the inspected native and WSL launch paths, but each future extension version should remain covered by smoke testing.
- No companion extension, daemon, socket service, or vendor-extension patch is required for the supported default.

## Verification requirements

Before claiming true VS Code live wake, an implementation must pass all of these:

1. Completion appears without reload in the exact owning task.
2. Multiple VS Code windows and multiple Codex tasks cannot receive each other's completion.
3. The extension can restart during a job and replay the final state exactly once.
4. Concurrent job completions do not duplicate or reorder conversational turns.
5. No process output is injected into the synthetic prompt; only sanitized job metadata crosses the boundary.
6. macOS and Linux/WSL behavior is covered.
7. The mechanism uses a documented API, or is clearly labeled as an opt-in, version-pinned experiment with an automatic safe fallback.

Until then, `durable-refresh-required` plus one-shot next-prompt agent awareness is the supported contract for Codex VS Code.
