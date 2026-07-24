# Codex surface smoke test

Run `npm run smoke` first to verify the process runtime in isolated temporary state. After every install or update, restart the Codex client before testing. In VS Code, run **Developer: Reload Window**. Quit and restart Codex App or Codex CLI. After restart, open `/hooks` and inspect the installed `codex-process-jobs` `PostToolUse`, `Stop`, and `UserPromptSubmit` definitions and referenced shared source. Approve any definition Codex marks new or changed; if trust persists, verify that status. A new task inside a client that was already running during installation can retain stale plugin or hook state.

After that restart, start a fresh persistent task in each installed Codex surface and paste this prompt:

```text
Use $codex-process-jobs:start to launch a harmless direct-argv Node job named surface-smoke. It should print "configure 25%", "compile 63%", and "link 100%" over about five seconds, then exit 0. Do not edit plugin or marketplace state.
```

Pass criteria:

1. The client was restarted after the latest plugin install or update, every hook and its referenced source was explicitly reviewed in `/hooks`, every definition Codex marked new or changed was approved, retained trust was verified, and the fresh task discovers the namespaced skills without being given a filesystem path.
2. Start returns a job id in under two seconds.
3. Without the user prompt coaching this behavior, the launch turn ends while the ordinary OS process remains active. It does not read the status skill or call status, tail, result, `--wait`, `write_stdin`, sleep, `ps`, or another monitor/probe after start returns.
4. The separate completion turn is durably recorded. In default `auto` mode on
   local Codex App and VS Code, the user-friendly automatic notice and the
   agent's bounded result summary, single recommended next step, and permission
   question should render live exactly once; the agent must not execute that
   step. App should record `notification.transport: desktop-ipc`, while VS Code
   should record `notification.transport: vscode-ipc`. The non-consuming
   inspection leaves `resultViewedAt` unset. Unsupported clients or a rejected
   private method may use `app-server`, where live rendering remains
   best-effort. CLI and unknown surfaces retain the lightweight acknowledgment
   unless completion mode is explicitly overridden.
5. Ordinary prompts submitted while the job is still active or while notifier-owned delivery is in flight continue normally. On the first eligible unrelated non-status prompt after delivery settles, the assigning agent briefly recaps the completion before answering, even if a synthetic completion is already present in model context. A live-rendered synthetic message may therefore be repeated once. In Codex App, commentary should announce completion live when commentary is used, and the final answer must independently retain the concise recap because commentary auto-collapses when the final renders. Commentary-only completion is a failure. A second eligible unrelated prompt must not repeat the job.
6. `$codex-process-jobs:status <job-id> --json` reports `completed`, exit code
   `0`, and `notification.presentation: durable-refresh-required`. After direct
   completion, it also reports `notification.transport: desktop-ipc`,
   `vscode-ipc`, or `app-server`.
7. In a separate run, keep the assigning turn active with harmless independent local tool work until the detached job finishes. The approved `PostToolUse` hook should surface it after a supported tool boundary; if completion occurs at finalization instead, the approved `Stop` hook should continue once to include the recap. Neither path may create a duplicate direct turn or expose process output in hook context.
7. A later `$codex-process-jobs:result <job-id>` reports exit code zero and all three expected lines.

For every client, verify the owning task with a fresh transcript load as well as
the current view. In the primary VS Code live-render test, do not reload,
reopen, navigate away, or submit another prompt before observing whether the
completion and assistant response appear. Use **Developer: Reload Window** only
after recording that live result. Record live rendering separately from durable
relay and eligible-turn recap behavior.

Also ask “how's the build going?” during a longer smoke job. The agent should use one lightweight status read and return recent output without attaching to the process.

For a token-efficiency check, request two JSON reads of one stream. Reuse the first response's `nextOffset` and `generation`; the second response should contain only newly appended bytes. Test stdout and stderr independently. If a deliberately tiny log cap forces compaction, the next response should set `compacted: true` rather than silently treating the rewritten bytes as continuous.

Optional OS notification is a separate smoke. Enable it for one harmless launch with `--notify-user`; confirm a local macOS notification appears when the App has notification permission, or a Linux notification appears when a graphical session and `notify-send` are available. Failure to display must not change terminal job state or conversational delivery.

Test Codex App, Codex VS Code extension, and Codex CLI on the same host after one installation. For VS Code Remote SSH, Dev Containers, WSL, or another remote extension host, install and test the plugin in that host environment as well.

For Codex App and ChatGPT mobile driving a remote Codex host, use a job lasting at least 60 seconds. After it finishes, allow notifier delivery to settle, then send an unrelated ordinary non-status request. The agent should recap the completion before answering regardless of whether the synthetic turn is present in model context. Confirm one `ordinaryPromptRecapInjectedAt` timestamp and `presentation: durable-refresh-required`. Preserve `ownerSurface` only as diagnostic evidence (`app` locally, `remote` for the observed mobile-to-Linux route).

## Release-candidate matrix

Run the same acceptance contract in every row. Record the host OS, Codex client/version, installed plugin version, owner surface metadata, direct live rendering, commentary recap, final-answer retention, and second-prompt non-repetition.

| Execution host | Client path | Required refresh before test | Acceptance focus |
|---|---|---|---|
| macOS | Codex App | Quit/relaunch App; review `/hooks`; fresh task | Friendly notice and one-sentence response render live exactly once through Desktop IPC; later recap contract remains intact |
| macOS | VS Code extension | **Developer: Reload Window**; review `/hooks`; fresh task | Friendly notice and proactive response render live exactly once through VS Code private IPC; later recap contract remains intact |
| macOS | Codex CLI | Exit/restart CLI; review `/hooks`; fresh task | Terminal presentation plus durable final recap |
| Linux | VS Code extension | Reinstall on Linux host; reload window; review `/hooks`; fresh task | Host-local private IPC live render when the remote extension host exposes the router; safe app-server fallback otherwise |
| Linux | Codex CLI | Reinstall on Linux host; restart CLI; review `/hooks`; fresh task | Portable detached lifecycle and recap |
| macOS or Linux | ChatGPT mobile/iOS driving the host | Reinstall on execution host; review `/hooks` and approve if required through Codex CLI or VS Code attached to that host; reconnect/start fresh mobile task | `ownerSurface: remote`, durable delivery, eligible-turn final retention |

Pulling source commits does not update an installed runtime snapshot. On every execution host with the updated source checkout, run and review the installer preview, then run the authorized apply step before restarting clients. Select the compact managed policy as `global`, `project`, or `none` only after separate user consent. No runtime `npm install`, persistent daemon, or manual `codex plugin marketplace add` is required for the default personal marketplace.

The installer preserves every validated prior CPJ cache generation across the refresh. This lets an already-open task continue resolving its original absolute skill path, while a fresh post-restart task catalogs the new generation. As an update regression check, keep one pre-update task open, apply the update, verify one CPJ skill still loads there, and separately verify the installed version in a fresh task. The old task should remain on its exact old snapshot rather than silently adopting new code.
