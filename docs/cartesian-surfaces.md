# Cartesian client and execution surfaces

Codex Process Jobs can run on a different machine from the device and client that assign the work. Completion behavior therefore lives on two independent axes:

```text
assigning client context × execution host
```

Examples include Codex App controlling the local Mac, VS Code controlling a local or remote extension host, and the ChatGPT mobile app controlling Codex on a remote Linux host. A completion can be durable on the execution host and visible in an exported transcript while still being absent from the assigning agent's next live context.

## Observed mobile-to-remote result

A controlled 75-second heartbeat job ran on a Linux execution host while the entire conversation was driven from the ChatGPT iPad app. The process completed successfully, and a separate app-server relay durably appended the synthetic completion turn and conversational response. More than a minute later, the assigning agent handled an unrelated storage question without seeing that completion and subsequently said it had not received it.

The persisted job state showed:

```text
ownerSurface: unknown
ownerSurfaceDetectedBy: null
notification.status: delivered
notification.presentation: conversational
surfaceFallbackNotifiedAt: absent
```

The owning rollout showed scalar session metadata:

```text
source: vscode
originator: Codex Desktop
```

The launcher environment did not contain `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`. Durable notification delivery succeeded; active-context synchronization did not. This is the same transport boundary previously observed in an already-open VS Code webview, reached through a different Cartesian combination.

## Classification precedence

The launcher classifies the assigning surface in this order:

1. An explicit `CODEX_PROCESS_JOBS_CLIENT_SURFACE` override.
2. A recognized non-empty `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` for App, CLI, or VS Code.
3. Only when the environment originator is absent, the latest owning rollout's first `session_meta` record.
4. Otherwise, `unknown`.

The exact observed scalar pair `source: vscode` plus `originator: Codex Desktop` becomes:

```text
ownerSurface: remote
ownerSurfaceDetectedBy: rollout-session-meta
notification.presentation: durable-refresh-required
```

`remote` means **refresh-uncertain**, not proof that the client is physically remote. Generic `source: vscode` metadata is ambiguous, and object-valued sources such as subagent records never qualify. Any non-empty environment originator blocks rollout inference, including an unrecognized custom originator.

## Completion contract

For `vscode` and `remote` surfaces, successful direct delivery remains `delivered`, but the next ordinary non-status prompt receives sanitized completion state once unless `surfaceFallbackNotifiedAt` is already present. Explicit status/result requests read durable state directly. The hook never injects process output.

User-facing wording is intentionally client-neutral: completion will be recorded, the current client may not refresh the assigning agent's context immediately, the agent will learn the outcome on the next exchange, and status remains available at any time.

## Mobile-to-remote verification

1. Install the current plugin on the execution host and start a fresh mobile-driven Codex task.
2. Launch a harmless job lasting at least 60 seconds and end the launch turn immediately.
3. Allow the job to finish, then submit an unrelated ordinary request without asking for status.
4. The assigning agent should briefly announce the completed job before answering the unrelated request.
5. Submit a second unrelated request; completion must not be repeated.
6. Confirm stored state remains `notification.status: delivered` and now has one `surfaceFallbackNotifiedAt` timestamp.
7. Confirm `ownerSurface: remote`, `ownerSurfaceDetectedBy: rollout-session-meta`, and `notification.presentation: durable-refresh-required`.

This test distinguishes durable transcript delivery from assigning-agent context refresh without relying on whether a particular client visibly repaints in real time.
