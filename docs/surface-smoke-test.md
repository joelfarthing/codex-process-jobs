# Codex surface smoke test

Run `npm run smoke` first to verify the process runtime in isolated temporary state. Then start a fresh persistent task in each installed Codex surface and paste this prompt:

```text
Use $codex-process-jobs:start to launch a harmless direct-argv Node job named surface-smoke. It should print "configure 25%", "compile 63%", and "link 100%" over about five seconds, then exit 0. Return immediately after launch and report the job id and launch time. If start reports ordinary conversational notification, tell me naturally that the process will notify this task when it finishes. If start identifies VS Code or reports durable-refresh-required, tell me instead that completion will be recorded but this open panel may not visibly wake until reload, and that status is available any time. End the turn without calling status, wait, or result. Do not edit plugin or marketplace state.
```

Pass criteria:

1. The fresh task discovers the namespaced skills without being given a filesystem path.
2. Start returns a job id in under two seconds.
3. The launch turn ends while the ordinary OS process remains active.
4. In Codex App and CLI, without another user prompt or a subagent, the task receives a second synthetic turn and tells the user that the job finished successfully. In VS Code, the completion turn is at minimum durable and visible after reload/reopen; live rendering remains a separate client capability.
5. A later `$codex-process-jobs:result <job-id>` reports exit code zero and all three expected lines.

For the Codex VS Code extension, verify the owning task with a fresh transcript load as well as the currently open webview. If the open webview does not live-render the externally appended turn, run **Developer: Reload Window**, reopen the task, and confirm that both turns are present. Record this as a client synchronization limitation, not a relay pass, until the open webview displays the completion without a refresh.

Also ask “how's the build going?” during a longer smoke job. The agent should use one lightweight status read and return recent output without attaching to the process.

Test Codex App, Codex VS Code extension, and Codex CLI on the same host after one installation. For VS Code Remote SSH, Dev Containers, WSL, or another remote extension host, install and test the plugin in that host environment as well.
