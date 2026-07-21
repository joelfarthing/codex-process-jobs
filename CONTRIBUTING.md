# Contributing

Contributions to Codex Process Jobs are welcome. Please discuss substantial behavior or protocol changes in an issue before investing in a large patch.

## Development setup

- Use Node.js 18 or newer on macOS or Linux.
- No runtime npm packages are required.
- Run `npm run check` before submitting a pull request.
- Run `npm run smoke` after a local installation when changing detached execution or client integration.

Pull requests should include focused tests for behavior changes and update the relevant user or design documentation. Keep macOS and Linux behavior aligned unless a platform-specific boundary is explicitly documented.

## Safety and test data

- Never commit credentials, tokens, private keys, real private logs, or sensitive job metadata.
- Treat captured stdout, stderr, job records, and completion payloads as untrusted test data.
- Preserve bounded reads, validation of security-sensitive persisted fields, no-follow file handling, process-identity checks, explicit shell mode, and explicit `/hooks` consent.
- Do not make automatic prompts depend on process output or other attacker-controlled text.

Report suspected vulnerabilities through the private channel in [SECURITY.md](SECURITY.md), not a public issue.
