# Agent adoption policy

Codex can select the plugin automatically from the installed skill descriptions, and users can always invoke `$codex-process-jobs:start` explicitly. The approved `PostToolUse` hook reinforces the hard release boundary immediately after a successful start. The plugin therefore remains useful without any `AGENTS.md` policy.

The optional managed policy adds a compact high-priority routing default. Detailed critical-job, Goal, progress, cancellation, completion, and untrusted-output rules stay in the selected skills and load only when relevant. This keeps always-loaded context small without weakening the operational contract.

Policy scope is a separate opt-in decision. After showing the read-only preview, an installing agent must ask the user to choose exactly one:

- `global`: manage the CPJ block in `~/.codex/AGENTS.md` for every task on that execution host;
- `project`: manage it in `<project-root>/AGENTS.md` for one repository or directory tree; or
- `none`: leave every `AGENTS.md` unchanged and rely on skill routing plus hook reinforcement.

Permission to install the plugin never implies one of these choices.

Hook consent is also separate and always manual. The installer never writes hook trust. After restarting the client, the user must review and approve the installed `PostToolUse`, `Stop`, and `UserPromptSubmit` definitions and shared source through `/hooks` before hook-boundary fallback can run.

Preview any choice without changing anything:

```bash
node scripts/install.mjs --agent-policy global
node scripts/install.mjs --agent-policy project --project-root /absolute/path/to/project
node scripts/install.mjs --agent-policy none
```

After reviewing the paths and active-job check, apply the same choice:

```bash
node scripts/install.mjs --apply --agent-policy global
```

The installer inserts the contents of [`assets/agent-policy.md`](../assets/agent-policy.md) between these markers:

```text
<!-- codex-process-jobs:begin -->
...
<!-- codex-process-jobs:end -->
```

Re-running the installer replaces that one managed block without duplicating it and preserves all unrelated instructions. An older verbose CPJ managed block is compacted in place. The block says when to route finite long-running commands to CPJ, excludes interactive and persistent server/watch workloads, makes successful start a hard launch-turn boundary, and points Codex to the selected skills for the full contract.

`--agent-policy none` never changes an `AGENTS.md`. The deprecated `--with-agent-policy` alias remains compatible with older automation and means `--agent-policy global`.

Repository-level or nested `AGENTS.md` files can override global guidance for their scope. If a project must never detach a particular command, state that exception close to the project. A project-scoped CPJ block is often preferable when only one repository has routinely long builds or evaluations.
