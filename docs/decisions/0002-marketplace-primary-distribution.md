# Distribution decision: Marketplace primary

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

The project has not yet observed a Marketplace version update after initial
publication. Homebrew remains a useful recovery and independently managed
fallback until that update path is verified.

## Decision

The OpenAI Plugins Directory is the recommended installation and update surface
for Codex Process Jobs.

Immutable GitHub Releases remain the source and provenance artifacts for each
public version. The Homebrew formula and personal-marketplace installer remain
maintained as an advanced fallback during the Marketplace transition, not as a
second layer or co-equal default.

Users must choose exactly one provider in a Codex home. Documentation must lead
with the Plugins Directory and place Homebrew under advanced fallback,
development, recovery, offline, or directory-unavailable use cases.

The project will consider formally deprecating the Homebrew formula after at
least one Marketplace update is verified across fresh Codex App, CLI, and VS
Code tasks and on representative macOS and Linux execution hosts. Formal
deprecation requires a separate maintainer decision.

The npm registry remains out of scope unless the maintainer explicitly reverses
that decision.

## Consequences

- Ordinary onboarding uses the shortest Codex-managed installation path.
- A single-provider rule prevents duplicate CPJ skill and hook providers.
- Marketplace publication and verification become the primary release
  completion path.
- GitHub Releases preserve auditable, immutable source artifacts.
- Homebrew remains available temporarily for fallback and recovery without
  implying that users should install both providers.
- Release documentation must distinguish mandatory Marketplace steps from
  transitional Homebrew steps.
- The first post-Marketplace release must record observed update behavior before
  Homebrew is formally deprecated.
