# Distribution decision: Marketplace-only distribution

- Status: Accepted
- Date: 2026-07-24
- Supersedes:
  [0001: GitHub Releases and Homebrew](0001-homebrew-distribution.md)

## Context

The original public distribution used immutable GitHub Releases and a Homebrew
tap because CPJ needed a versioned macOS and Linux installation path and npm
publication could not be bootstrapped reliably.

CPJ is now published in the OpenAI Plugins Directory. Installing that provider
is substantially simpler for ordinary users: it is managed through the Codex
product, requires no separate package manager or personal marketplace, and can
become available to eligible clients and hosts through the same signed-in
account.

Running the directory and Homebrew/personal providers together is unsafe as a
normal configuration. Both expose the same skill IDs, and side-by-side copies
can make routing nondeterministic. Maintaining two co-equal public onboarding
paths also adds user confusion and release overhead.

The first Marketplace update has now been packaged, approved, published, and
verified on representative Codex clients and macOS and Linux execution hosts.
The directory provider has also proven simpler to install and remove than the
two-layer Homebrew management-command plus personal-marketplace flow.

## Decision

The OpenAI Plugins Directory is the supported installation and update surface
for Codex Process Jobs.

Immutable GitHub Releases remain the source and provenance artifacts for each
public version. The Homebrew formula is deprecated effective July 24, 2026 and
frozen at CPJ 0.2.2. It may remain installable during Homebrew's warning-stage
deprecation so existing users can migrate, but later CPJ releases will not
update it.

The source installer and personal marketplace remain available for contributor
and maintainer development, not as a supported end-user distribution path.
Ordinary users must use one directory provider. A maintainer who deliberately
tests a local provider beside the directory copy must disable the directory
copy's skills and hooks and re-confirm those toggles after every directory
update.

The npm registry remains out of scope unless the maintainer explicitly reverses
that decision.

## Consequences

- Ordinary onboarding and updates use one Codex-managed path.
- A single-provider rule prevents duplicate CPJ skill and hook providers.
- Marketplace publication and verification are the release completion path.
- GitHub Releases preserve auditable, immutable source artifacts.
- Existing Homebrew users receive a migration warning rather than an abrupt
  break, but `brew upgrade` will not deliver future CPJ versions.
- The tap no longer participates in ordinary release publication.
- Maintainer release verification explicitly checks that a Marketplace update
  did not reactivate intentionally disabled directory skills or hooks.
