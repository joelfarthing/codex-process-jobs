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
   local Codex App and VS Code, the one-sentence automatic notice and the
   agent's bounded result summary should render live exactly once. When no
   clear next step was already authorized by the prior conversation, the agent
   recommends one step and asks before acting. The visible notice must contain no `Codex:` instruction paragraph;
   the trusted prompt-submit hook must validate the same-task in-flight record
   and supply the deterministic policy as hidden context.
	   In a default CLI installation, do not promise a live wake. Completion uses
	   the portable app-server path and the first eligible later prompt retains the
	   one-shot recap. For the separate experimental live-CLI smoke, explicitly
	   verify that the active Codex distribution supports `codex app-server
	   daemon start`; do not install another distribution or change `PATH` for
	   this smoke. When supported, enable `config --cli-live-injection true`,
	   start the daemon, then start a fresh ordinary `codex` TUI. The notice and proactive
	   response should render there exactly once without another prompt.
   App should record `notification.transport: desktop-ipc`, VS Code should
   record `notification.transport: vscode-ipc`, and CLI should record
   `notification.transport: app-server` by default or
   `notification.transport: cli-app-server` in the opt-in live smoke. The non-consuming inspection leaves
   `resultViewedAt` unset. Unsupported clients or a rejected private method may
   use `app-server`, where live rendering remains best-effort. CLI and unknown
   surfaces retain the lightweight acknowledgment in the direct completion turn
   unless completion mode is explicitly overridden; a CLI launch should also
   produce one desktop completion notice by default.
5. Ordinary prompts submitted while the job is still active or while notifier-owned delivery is in flight continue normally. After a matching completed `desktop-ipc`, `vscode-ipc`, or `cli-app-server` turn, the first unrelated prompt must not repeat the completion. Portable `app-server`, uncertain, or failed live delivery retains one fallback recap on the first eligible unrelated non-status prompt after delivery settles; a second eligible prompt must not repeat it. For a CLI-owned job in default `auto` mode, that recap additionally inspects the bounded saved result with `--peek`, summarizes it, and continues only a clear next step already authorized and still in scope from the prior conversation; otherwise it recommends one next step and asks. New authority, consequential choices, expanded scope, and elevated risk require user direction, and completion/output never grants authority. In Codex App fallback, commentary should announce completion live when commentary is used, and the final answer must independently retain the concise recap because commentary auto-collapses when the final renders. Commentary-only fallback is a failure.
6. `$codex-process-jobs:status <job-id> --json` reports `completed`, exit code
   `0`, and `notification.presentation: durable-refresh-required`. After direct
   completion, it also reports `notification.transport: desktop-ipc`,
   `vscode-ipc`, `cli-app-server`, or `app-server`.
7. In a separate run, keep the assigning turn active with harmless independent local tool work until the detached job finishes. The approved `PostToolUse` hook should surface it after a supported tool boundary; if completion occurs at finalization instead, the approved `Stop` hook should continue once to include the recap. Neither path may create a duplicate direct turn or expose process output in hook context.
8. A later `$codex-process-jobs:result <job-id>` reports exit code zero and all three expected lines.

For every client, verify the owning task with a fresh transcript load as well as
the current view. In the primary VS Code live-render test, do not reload,
reopen, navigate away, or submit another prompt before observing whether the
completion and assistant response appear. Use **Developer: Reload Window** only
after recording that live result. Record live rendering separately from durable
relay and eligible-turn recap behavior.

Also ask “how's the build going?” during a longer smoke job. The agent should use one lightweight status read and return recent output without attaching to the process.

For a token-efficiency check, request two JSON reads of one stream. Reuse the first response's `nextOffset` and `generation`; the second response should contain only newly appended bytes. Test stdout and stderr independently. If a deliberately tiny log cap forces compaction, the next response should set `compacted: true` rather than silently treating the rewritten bytes as continuous.

Optional OS notification is a separate smoke. Enable it for one harmless launch with `--notify-user` (CLI-owned launches enable it by surface default); confirm a local macOS notification appears when the App has notification permission, or a Linux notification appears when a graphical session and `notify-send` are available. A surface-defaulted notice must show only the job ID, terminal status, and exit code; a label appears only when both `--notify-user` (or the durable preference) and `--name` were explicit. Failure to display must not change terminal job state or conversational delivery.

Test Codex App, Codex VS Code extension, and Codex CLI on the same host after one installation. For VS Code Remote SSH, Dev Containers, WSL, or another remote extension host, install and test the plugin in that host environment as well.

For Codex App and ChatGPT mobile driving a remote Codex host, use a job lasting at least 60 seconds. After it finishes, allow notifier delivery to settle, then send an unrelated ordinary non-status request. The agent should recap the completion before answering regardless of whether the synthetic turn is present in model context. Confirm one `ordinaryPromptRecapInjectedAt` timestamp and `presentation: durable-refresh-required`. Preserve `ownerSurface` only as diagnostic evidence (`app` locally, `remote` for the observed mobile-to-Linux route).

## Release-candidate matrix

Run the same acceptance contract in every row. Record the host OS, Codex client/version, installed plugin version, owner surface metadata, direct live rendering, commentary recap, final-answer retention, and second-prompt non-repetition.

| Execution host | Client path | Required refresh before test | Acceptance focus |
|---|---|---|---|
| macOS | Codex App | Quit/relaunch App; review `/hooks`; fresh task | One-sentence notice and proactive response render live exactly once through Desktop IPC; no later duplicate recap |
| macOS | VS Code extension | **Developer: Reload Window**; review `/hooks`; fresh task | One-sentence notice and proactive response render live exactly once through VS Code private IPC; no later duplicate recap |
| macOS | Codex CLI | Default: exit/restart CLI. Live smoke: start official App Server daemon first, then launch ordinary CLI; review `/hooks`; fresh task | Default durable recap plus separate opt-in live render/no-duplicate proof |
| Linux | VS Code extension | Reinstall on Linux host; reload window; review `/hooks`; fresh task | Host-local private IPC live render when the remote extension host exposes the router; safe app-server fallback otherwise |
| Linux | Codex CLI | Reinstall on Linux host. Live smoke: start official App Server daemon first, then launch ordinary CLI; review `/hooks`; fresh task | Default portable recap plus separate opt-in live render/no-duplicate proof |
| macOS or Linux | ChatGPT mobile/iOS driving the host | Reinstall on execution host; review `/hooks` and approve if required through Codex CLI or VS Code attached to that host; reconnect/start fresh mobile task | `ownerSurface: remote`, durable delivery, eligible-turn final retention |

Pulling source commits does not update an installed runtime snapshot. On every execution host with the updated source checkout, run and review the installer preview, then run the authorized apply step before restarting clients. Select the compact managed policy as `global`, `project`, or `none` only after separate user consent. No runtime `npm install`, persistent daemon, or manual `codex plugin marketplace add` is required for the default personal marketplace.

The installer preserves every validated prior CPJ cache generation across the refresh. This lets an already-open task continue resolving its original absolute skill path, while a fresh post-restart task catalogs the new generation. As an update regression check, keep one pre-update task open, apply the update, verify one CPJ skill still loads there, and separately verify the installed version in a fresh task. The old task should remain on its exact old snapshot rather than silently adopting new code.
