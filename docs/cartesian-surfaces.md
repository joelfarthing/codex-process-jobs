# Cartesian client and execution surfaces

Codex Process Jobs can run on a different machine from the device and client that assign the work. Completion behavior therefore lives on two independent axes:

```text
assigning client context × execution host
```

Examples include Codex App controlling the local Mac, VS Code controlling a local or remote extension host, and the ChatGPT mobile app controlling Codex on a remote Linux host. A completion can be durable on the execution host and visible in an exported transcript while still being absent from the assigning agent's next live context.

Client identity and execution host are useful diagnostic axes, but refresh reliability is governed by another boundary: the notifier appends through a separate app-server transport from the assigning client. No detected client is assumed to observe that external append immediately.

## Observed mobile-to-remote result

A controlled 75-second heartbeat job ran on a Linux execution host while the entire conversation was driven from the ChatGPT iPad app. The process completed successfully, and a separate app-server relay durably appended the synthetic completion turn and conversational response. More than a minute later, the assigning agent handled an unrelated storage question without seeing that completion and subsequently said it had not received it.

The persisted job state in that pre-generalization build showed this legacy snapshot:

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

## Observed App-to-local result

A second controlled 75-second heartbeat ran entirely in Codex App on the local Mac. The job was classified `ownerSurface: app`, completed at `2026-07-11T04:06:55.088Z`, and the separate notifier durably completed its synthetic turn at `2026-07-11T04:07:01.173Z`. The next unrelated App turn began at `2026-07-11T04:07:17.281Z`, 16 seconds later, but its assigning-agent context omitted the completion. A subsequent status check found `notification.status: delivered` while the user-visible exported transcript contained no completion announcement.

This rules out a busy-turn race and disproves the earlier assumption that local Codex App could safely use a stronger live-notification promise. Durable append and assigning-client awareness are separate on the local App surface too.

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

All owning surfaces now receive `notification.presentation: durable-refresh-required`; classification remains useful for diagnostics and Cartesian testing, not for deciding whether an eligible-turn recap is necessary.

## Completion contract

For every owning surface, successful direct delivery remains `delivered`, but the first eligible ordinary non-status prompt after delivery settles receives one sanitized mandatory recap instruction unless `ordinaryPromptRecapInjectedAt` or a legacy marker is already present. Codex gives the recap even if a synthetic assistant completion appears in model context, because that message may not have rendered in the assigning client. A possible one-time duplicate is intentional. Explicit status/result requests read durable state directly. The hook never injects process output.

User-facing wording is intentionally client-neutral and temporally precise: completion will be recorded, a live notification may appear, after the process finishes the agent will recap the outcome as soon as an ordinary exchange can pick it up, and status remains available at any time. Ordinary exchanges before terminal state continue normally and do not promise an outcome that does not yet exist. An ordinary prompt submitted during an active notifier-owned delivery attempt also continues without racing it; the first eligible non-status prompt after delivery settles receives the recap.

## Mobile-to-remote verification

1. Install the current plugin on the execution host and start a fresh mobile-driven Codex task.
2. Launch a harmless job lasting at least 60 seconds and end the launch turn immediately.
3. Allow the job to finish, then submit an unrelated ordinary request without asking for status.
4. The assigning agent should briefly announce the completed job before answering the unrelated request.
5. Submit a second unrelated request; completion must not be repeated.
6. Confirm stored state remains `notification.status: delivered` and now has one `ordinaryPromptRecapInjectedAt` timestamp.
7. Confirm `ownerSurface: remote`, `ownerSurfaceDetectedBy: rollout-session-meta`, and `notification.presentation: durable-refresh-required`.

This test distinguishes durable transcript delivery from assigning-agent context refresh without relying on whether a particular client visibly repaints in real time.

Repeat the same test in local Codex App and CLI. Their stored `ownerSurface` values should remain `app` and `cli`, while `notification.presentation` remains `durable-refresh-required` and the same one-shot recap-injection contract applies.
