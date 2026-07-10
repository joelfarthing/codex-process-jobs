# Repository instructions

When installing Codex Process Jobs for a user:

1. Run `node scripts/install.mjs` first. It is a read-only preview.
2. Describe the displayed local changes before applying them.
3. Explicitly ask whether the user wants the optional managed policy in global `~/.codex/AGENTS.md`. Do not infer consent from the request to install the plugin.
4. Use `--with-agent-policy` only after the user answers yes. Installation without that flag must leave global agent instructions unchanged.
5. Run `--apply` only after the user has reviewed the plan and authorized installation.

Do not publish this repository or change its visibility without the user's explicit approval.
