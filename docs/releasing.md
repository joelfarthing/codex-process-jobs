# Release checklist

Use this gate for every public Codex Process Jobs release. Preparing a release does not authorize changing repository visibility, creating a public GitHub Release, updating the public Homebrew tap, or submitting to a marketplace.

Codex Process Jobs intentionally uses immutable GitHub Releases plus `joelfarthing/homebrew-tap` for versioned distribution. Do not introduce npm registry publication unless the maintainer explicitly reverses [the accepted distribution decision](decisions/0001-homebrew-distribution.md).

## Code and evidence

- Confirm the release branch contains only intended changes and is based on the current default branch.
- Run `npm run check` locally.
- Run `npm run smoke` from the source tree and from the installed runtime on both macOS and Linux when runtime behavior changed.
- Run the official plugin validator against the repository root.
- Confirm GitHub Actions passes on macOS and Ubuntu with every supported Node.js version.
- Review any benchmark aggregates before publishing them; never commit raw rollout JSONL or private task context.

## Security and privacy

- Search tracked files and history for credentials, tokens, private keys, private logs, absolute user paths, hostnames, and unintended project names.
- Re-read `SECURITY.md`, hook definitions, fixed synthetic prompts, and every place process output can cross into model context.
- Confirm the installer previews all persistent changes and still requires explicit `global`, `project`, or `none` agent-policy consent.
- Confirm every update still requires an explicit `/hooks` review, new or changed definitions require approval, retained trust is verified, and no development or automation flag bypasses the consent flow.
- Review screenshots and examples for information the author does not intend to publish.

## Packaging and onboarding

- Keep `package.json` and `.codex-plugin/plugin.json` versions aligned.
- Confirm the manifest, skill metadata, license, notice, repository URLs, and supported-platform claims are current.
- Test the README's Homebrew and source preview, policy-selection, apply, restart, and `/hooks` instructions from a clean account or isolated home.
- Verify one local Codex App task and one Linux execution host can start, report, inspect, and cancel harmless jobs.
- Run `npm pack --dry-run` and inspect the complete file list, sizes, executable entry point, package metadata, and absence of development-only or private material.
- Exercise the packed tarball in an isolated Node environment, then test `version`, `doctor`, preview-only `install`, and preview-only `update` through the proposed Homebrew formula.
- Keep package metadata, plugin manifest, Homebrew formula, Git tag, and GitHub Release versions identical.

## Publication boundary

- Merge the reviewed release candidate into the default branch.
- Verify CI on the exact default-branch commit.
- Prepare the changelog entry and GitHub release notes without publishing them.
- Obtain explicit approval immediately before any public version tag, GitHub Release, or Homebrew tap update.
- Create the matching signed or annotated version tag and GitHub Release only after the release artifact and exact default-branch commit are verified.
- Update the tap formula only after the final release-asset URL and SHA-256 are known.
- Confirm the public clone URL, screenshots, issue tracker, security-reporting route, and installation instructions work while signed out.

## GitHub Release and Homebrew procedure

1. Confirm `package.json`, `package-lock.json`, and `.codex-plugin/plugin.json` contain the same strict SemVer version.
2. Run `npm ci --ignore-scripts`, `npm run check`, and `npm pack --dry-run`.
3. Run `npm pack`, inspect the tarball, and test it from an isolated home. `npm` is the local archive builder only; do not publish to the npm registry.
4. Tag the verified commit `v<version>`, push the tag, and create the matching GitHub Release with the inspected tarball attached.
5. Calculate the final release asset's SHA-256 and update `Formula/codex-process-jobs.rb` in `joelfarthing/homebrew-tap` with the exact version, asset URL, and checksum.
6. Confirm the formula depends on Node 18 or newer, installs the release beneath `libexec`, exposes only the `codex-process-jobs` executable, and has a non-mutating `test do` block.
7. Run Homebrew style, audit, install, version, doctor, preview-only install, preview-only update, and formula tests on macOS. Verify Linuxbrew in CI or on a Linux host.
8. Verify `brew install joelfarthing/tap/codex-process-jobs`, the release asset, source tag, update path, and public documentation while signed out.

## Claims

- Describe automatic wake and conversational delivery as best-effort and experimental.
- Lead with the durable lifecycle and the quality-of-life benefit: the assigning Codex turn is released instead of polling.
- Do not claim general token savings until repeated matched benchmark evidence supports the exact wording.
- Distinguish a public GitHub release from acceptance into an official or curated plugin marketplace.
