# Distribution decision: GitHub Releases and Homebrew

- Status: Accepted
- Date: 2026-07-22

## Context

Codex Process Jobs needs an immutable, versioned, portable distribution and update path for macOS and Linux. The project prepared an npm-compatible command package, but npm's first-package bootstrap failed across all documented authentication paths tested for `codex-process-jobs`:

- WebAuthn account 2FA was enabled in `auth-and-writes` mode.
- npm web-authentication callbacks returned `Not Found` after accepting an emailed verification code.
- A short-lived granular token with package write permission and `bypass_2fa: true` authenticated `npm whoami`, but the immediately following publication received the registry's 2FA E403.
- npm 10, npm 11.17.0, and npm 12.0.1 produced the same publication failure.
- Staged publishing and `npm trust` cannot bootstrap a new name because npm requires the package to exist first.

This behavior matches [npm/cli#9268](https://github.com/npm/cli/issues/9268). No package version was created, and every temporary credential was revoked.

## Decision

Codex Process Jobs will not use the npm registry. Its versioned public distribution is:

1. an immutable tarball attached to the matching GitHub Release and tag; and
2. a formula in `joelfarthing/homebrew-tap` that pins the release URL and SHA-256.

Homebrew provides the `codex-process-jobs` command on macOS and Linux. The command continues to use CPJ's existing preview-first transactional installer; Homebrew does not write Codex configuration or agent policy itself.

The repository may continue to use `npm` locally for lockfile-based development, tests, and deterministic tarball creation. That tooling role does not authorize npm registry publication.

## Consequences

- Users get versioned installs and ordinary `brew update` / `brew upgrade` behavior.
- Release bytes remain auditable against GitHub tags and checksums.
- The same release path works through Homebrew on macOS and Linuxbrew.
- Users without Homebrew can continue to clone a tag and run the source installer directly.
- Release automation must update and test both the main repository and the tap formula.
- npm registry publication must not be reintroduced without an explicit maintainer decision that supersedes this record.
