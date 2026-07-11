# Agent adoption policy

Codex can select the plugin automatically from the installed skill descriptions, and users can always invoke `$codex-process-jobs:start` explicitly. For a durable personal default across Codex App, the Codex VS Code extension, Codex CLI, and mobile-driven remote tasks, add the managed policy to the global `~/.codex/AGENTS.md` file on each execution host.

This is a separate opt-in decision. An installing agent must ask whether the user wants the global policy after showing the read-only installation preview. It must not treat permission to install the plugin as permission to edit global agent instructions.

Hook consent is also separate and always manual. The installer never writes hook trust. After restarting the client, the user must review and approve the installed hook's exact hash through `/hooks` before next-prompt fallback can run.

Preview installation without changing anything:

```bash
node scripts/install.mjs --with-agent-policy
```

After reviewing the paths and active-job check, apply both the plugin installation and policy:

```bash
node scripts/install.mjs --apply --with-agent-policy
```

The installer inserts the contents of [`assets/agent-policy.md`](../assets/agent-policy.md) between these markers:

```text
<!-- codex-process-jobs:begin -->
...
<!-- codex-process-jobs:end -->
```

Re-running the installer replaces that one managed block without duplicating it and preserves all unrelated personal instructions. It tells the agent to use conversational but transport-honest launch wording: completion is recorded, live presentation is best-effort on every client, the next ordinary exchange recaps the outcome, and status is always available. It also discloses that this recap may repeat a live-rendered completion once because model context cannot prove client rendering. The policy is opt-in; installation without `--with-agent-policy` never changes `AGENTS.md`.

Repository-level or nested `AGENTS.md` files can override global guidance for their scope. If a project must never detach a particular command, state that exception close to the project.
