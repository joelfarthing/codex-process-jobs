# Repository instructions

When installing Codex Process Jobs for a user:

1. Run `node scripts/install.mjs` first. It is a read-only preview.
2. Describe the displayed local changes before applying them.
3. Explicitly ask the user to choose one agent-policy scope: `global` in `~/.codex/AGENTS.md`, `project` in a specified project root's `AGENTS.md`, or `none`. Do not infer this choice from the request to install the plugin.
4. Pass the reviewed choice with `--agent-policy global`, `--agent-policy project --project-root <path>`, or `--agent-policy none`. The installer must leave every `AGENTS.md` unchanged when `none` is selected.
5. Run `--apply` only after the user has reviewed the plan and authorized installation.

Do not publish this repository or change its visibility without the user's explicit approval.
