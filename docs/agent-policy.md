# Agent adoption policy

Codex can select the plugin automatically from the installed skill descriptions, and users can always invoke `$codex-process-jobs:start` explicitly. For a durable personal default across Codex App, the Codex VS Code extension, and Codex CLI on one machine, add the managed policy to the global `~/.codex/AGENTS.md` file.

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

Re-running the installer replaces that one managed block without duplicating it and preserves all unrelated personal instructions. It also tells the agent to promise conversational completion only when the controller reports notification as pending. The policy is opt-in; installation without `--with-agent-policy` never changes `AGENTS.md`.

Repository-level or nested `AGENTS.md` files can override global guidance for their scope. If a project must never detach a particular command, state that exception close to the project.
