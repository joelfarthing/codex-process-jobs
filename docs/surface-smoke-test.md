# Codex surface smoke test

Run `npm run smoke` first to verify the process runtime in isolated temporary state. After every install or update, restart the Codex client before testing. In VS Code, run **Developer: Reload Window**. Quit and restart Codex App or Codex CLI. After restart, open `/hooks`, inspect the installed `codex-process-jobs` `UserPromptSubmit` command and source, and approve its exact hash. A new task inside a client that was already running during installation can retain stale plugin or hook state.

After that restart, start a fresh persistent task in each installed Codex surface and paste this prompt:

```text
Use $codex-process-jobs:start to launch a harmless direct-argv Node job named surface-smoke. It should print "configure 25%", "compile 63%", and "link 100%" over about five seconds, then exit 0. Return immediately after launch and report the job id and launch time. Tell me naturally that completion will be recorded, a live notification may appear, and after it finishes you'll recap the outcome as soon as the conversation can pick it up; status is available any time. End the turn without calling status, wait, or result. Do not edit plugin or marketplace state.
```

Pass criteria:

1. The client was restarted after the latest plugin install or update, the hook was explicitly reviewed and approved in `/hooks`, and the fresh task discovers the namespaced skills without being given a filesystem path.
2. Start returns a job id in under two seconds.
3. The launch turn ends while the ordinary OS process remains active.
4. The separate synthetic completion turn is durably recorded. Live rendering is best-effort on every client.
5. Ordinary prompts submitted while the job is still active or while notifier-owned delivery is in flight continue normally. On the first eligible unrelated non-status prompt after delivery settles, the assigning agent briefly recaps the completion before answering, even if a synthetic completion is already present in model context. A live-rendered synthetic message may therefore be repeated once. In Codex App, commentary should announce completion live when commentary is used, and the final answer must independently retain the concise recap because commentary auto-collapses when the final renders. Commentary-only completion is a failure. A second eligible unrelated prompt must not repeat the job.
6. `$codex-process-jobs:status <job-id> --json` reports `completed`, exit code `0`, and `notification.presentation: durable-refresh-required`.
7. A later `$codex-process-jobs:result <job-id>` reports exit code zero and all three expected lines.

For every client, verify the owning task with a fresh transcript load as well as the current view. For the Codex VS Code extension, run **Developer: Reload Window** when necessary before comparing. Record live rendering separately from durable relay and eligible-turn recap behavior.

Also ask “how's the build going?” during a longer smoke job. The agent should use one lightweight status read and return recent output without attaching to the process.

Test Codex App, Codex VS Code extension, and Codex CLI on the same host after one installation. For VS Code Remote SSH, Dev Containers, WSL, or another remote extension host, install and test the plugin in that host environment as well.

For Codex App and ChatGPT mobile driving a remote Codex host, use a job lasting at least 60 seconds. After it finishes, allow notifier delivery to settle, then send an unrelated ordinary non-status request. The agent should recap the completion before answering regardless of whether the synthetic turn is present in model context. Confirm one `ordinaryPromptRecapInjectedAt` timestamp and `presentation: durable-refresh-required`. Preserve `ownerSurface` only as diagnostic evidence (`app` locally, `remote` for the observed mobile-to-Linux route).
