# Codex surface smoke test

Run `npm run smoke` first to verify the process runtime in isolated temporary state. After every install or update, restart the Codex client before testing. In VS Code, run **Developer: Reload Window**. Quit and restart Codex App or Codex CLI. After restart, open `/hooks`, inspect the installed `codex-process-jobs` `UserPromptSubmit` command and source, and approve its exact hash. A new task inside a client that was already running during installation can retain stale plugin or hook state.

After that restart, start a fresh persistent task in each installed Codex surface and paste this prompt:

```text
Use $codex-process-jobs:start to launch a harmless direct-argv Node job named surface-smoke. It should print "configure 25%", "compile 63%", and "link 100%" over about five seconds, then exit 0. Return immediately after launch and report the job id and launch time. If start reports ordinary conversational notification, tell me naturally that the process will notify this task when it finishes. If start identifies VS Code, remote, or reports durable-refresh-required, tell me instead that completion will be recorded, this client may not refresh the assigning agent's context immediately, the agent will learn the outcome on the next exchange, and status is available any time. End the turn without calling status, wait, or result. Do not edit plugin or marketplace state.
```

Pass criteria:

1. The client was restarted after the latest plugin install or update, the hook was explicitly reviewed and approved in `/hooks`, and the fresh task discovers the namespaced skills without being given a filesystem path.
2. Start returns a job id in under two seconds.
3. The launch turn ends while the ordinary OS process remains active.
4. In a known live Codex App or CLI surface, without another user prompt or a subagent, the task receives a second synthetic turn and tells the user that the job finished successfully. In VS Code and refresh-uncertain remote surfaces, the completion turn is at minimum durable; live rendering and assigning-agent context refresh remain separate client capabilities.
5. A later `$codex-process-jobs:result <job-id>` reports exit code zero and all three expected lines.

For the Codex VS Code extension, verify the owning task with a fresh transcript load as well as the currently open webview. If the open webview does not live-render the externally appended turn, run **Developer: Reload Window**, reopen the task, and confirm that both turns are present. Record this as a client synchronization limitation, not a relay pass, until the open webview displays the completion without a refresh.

Also ask “how's the build going?” during a longer smoke job. The agent should use one lightweight status read and return recent output without attaching to the process.

Test Codex App, Codex VS Code extension, and Codex CLI on the same host after one installation. For VS Code Remote SSH, Dev Containers, WSL, or another remote extension host, install and test the plugin in that host environment as well.

For ChatGPT mobile driving a remote Codex host, use a job lasting at least 60 seconds. After it finishes, send an unrelated ordinary request. The agent should announce completion before answering that request exactly once. Confirm the stored job reports `ownerSurface: remote`, `ownerSurfaceDetectedBy: rollout-session-meta`, `presentation: durable-refresh-required`, and one `surfaceFallbackNotifiedAt` timestamp.
