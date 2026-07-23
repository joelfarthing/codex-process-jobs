# Release checklist

Use this gate for every public Codex Process Jobs release. Preparing a release does not authorize changing repository visibility, creating a public GitHub Release, updating the public Homebrew tap, or submitting to a marketplace.

Codex Process Jobs intentionally uses immutable GitHub Releases plus `joelfarthing/homebrew-tap` for versioned distribution. Do not introduce npm registry publication unless the maintainer explicitly reverses [the accepted distribution decision](decisions/0001-homebrew-distribution.md).

This public runbook documents maintainer verification and sequencing; it grants no repository or tap write authority and contains no authentication material. Outside users should follow the README's installation and update paths, while contributors should use ordinary forks and pull requests.

## Canonical release runway

Treat these as separate, ordered states. Do not describe a merge as a release or a Homebrew formula upgrade as a plugin update.

| State | Authority | What users receive |
|---|---|---|
| Reviewed change | Feature branch or pull request | Nothing |
| Merged, unreleased | Exact commit on `origin/main` | Nothing through Homebrew |
| GitHub release published | Immutable `vX.Y.Z` tag and `.tgz` asset | Release bytes exist, but Homebrew still serves its pinned formula version |
| Tap formula published | `joelfarthing/homebrew-tap` points to the release URL and SHA-256 | `brew update` and `brew upgrade` can install the new management command |
| Plugin update applied | User runs the previewed `codex-process-jobs update --apply ...` | New Codex plugin snapshot is installed on that execution host |
| Client refreshed | Codex is restarted, `/hooks` is reviewed, and a fresh task is opened | New tasks use the refreshed plugin generation |

A release is complete only after every applicable state above is verified. If publication fails after a tag or GitHub Release exists, preserve the immutable artifact and fix forward with a new patch version; never replace published release bytes in place.

## 1. Develop, review, and merge the change

1. Start the change from current `origin/main`, whether it originates in a local checkout or an outside pull request.
2. Keep unrelated working-tree changes out of the branch.
3. Run `git diff --check`, `npm run check`, and `npm run smoke`; add focused tests for changed behavior.
4. Open a draft pull request, inspect the complete patch, and wait for every required GitHub Actions and security check.
5. Resolve actionable review comments and review threads.
6. Mark the pull request ready and merge it using the repository's intended strategy.
7. Fetch `origin/main` and record the exact merged commit. A local feature branch, even one whose pull request was merged, is not the release authority.

At this point the change is public source code but remains unavailable through Homebrew.

## 2. Prepare the release on a separate branch

1. Choose the next SemVer version according to the actual compatibility impact.
2. Create a release-preparation branch from the latest `origin/main`.
3. Set the same version in `package.json`, `package-lock.json`, and `.codex-plugin/plugin.json`.
4. Move the accumulated `[Unreleased]` entries into a dated version section and update comparison links.
5. Prepare release notes describing user-visible behavior, compatibility, security implications, and upgrade requirements.
6. Run the complete gates below.
7. Review and merge the release-preparation pull request.
8. Fetch `origin/main` again. The resulting exact commit—not the pre-merge release branch—is the only commit that may be tagged and packaged.

Create a clean detached worktree from that commit for final packaging so stale branches and unrelated files cannot enter the artifact:

```bash
git fetch origin main --tags
git worktree add /tmp/codex-process-jobs-release-X.Y.Z --detach origin/main
```

Inside the release worktree, confirm that `HEAD` is the expected `origin/main` commit and that the worktree is clean before building.

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

## 3. Publication boundary

- Merge the reviewed release candidate into the default branch.
- Verify CI on the exact default-branch commit.
- Prepare the changelog entry and GitHub release notes without publishing them.
- Obtain explicit approval immediately before any public version tag, GitHub Release, or Homebrew tap update.
- Create the matching signed or annotated version tag and GitHub Release only after the release artifact and exact default-branch commit are verified.
- Update the tap formula only after the final release-asset URL and SHA-256 are known.
- Confirm the public clone URL, screenshots, issue tracker, security-reporting route, and installation instructions work while signed out.

Preparation and local validation do not authorize a public write. Obtain explicit maintainer approval immediately before pushing the version tag, creating the GitHub Release, or pushing the Homebrew tap update.

## 4. Build and publish the immutable GitHub release

From the clean release worktree:

1. Confirm `package.json`, `package-lock.json`, and `.codex-plugin/plugin.json` contain the same strict SemVer version.
2. Run `npm ci --ignore-scripts`, `npm run check`, `npm run smoke`, and `npm pack --dry-run`.
3. Run `npm pack`, inspect the complete tarball, and test it from an isolated home. `npm` is the local archive builder only; do not publish to the npm registry.
4. Calculate and record the tarball's SHA-256.
5. Confirm the exact `HEAD` commit and all required CI checks one final time.
6. After the publication approval checkpoint, create an annotated `vX.Y.Z` tag on that exact commit, push the tag, and create the matching GitHub Release with `codex-process-jobs-X.Y.Z.tgz` attached.
7. Download or otherwise re-read the published asset and confirm its SHA-256 matches the inspected local artifact.

The GitHub Release must be complete before the Homebrew formula is changed because the formula pins the final immutable asset URL and checksum.

## 5. Update and verify the Homebrew tap

In a clean checkout of `joelfarthing/homebrew-tap`:

1. Fetch current `origin/main` and create a dedicated formula-update branch.
2. Change only `Formula/codex-process-jobs.rb`, preserving the dependency, install, and non-mutating test structure.
3. Set the release URL to the final `vX.Y.Z` asset and set its exact SHA-256.
4. Run Homebrew style, strict audit, formula installation, version, doctor, preview-only install, preview-only update, and formula tests on macOS.
5. Verify Linuxbrew in CI or on a Linux host.
6. Review the formula diff and ensure unrelated editor, cache, or filesystem artifacts are not staged.
7. After the publication approval checkpoint, open and merge the tap update pull request.
8. Run `brew update` from a consumer installation and confirm `brew outdated codex-process-jobs` discovers the intended version.
9. Verify the public installation path while signed out:

```bash
brew install joelfarthing/tap/codex-process-jobs
codex-process-jobs version
codex-process-jobs doctor
codex-process-jobs install --agent-policy none
```

The final command is preview-only and must remain non-mutating.

## 6. Update an existing execution host

Homebrew and the Codex plugin are deliberately separate layers. On every macOS or Linux execution host:

```bash
brew update
brew outdated codex-process-jobs
brew upgrade codex-process-jobs
codex-process-jobs update --agent-policy none
```

Replace `none` with the host's previously selected `global` policy, or with `project --project-root /absolute/path`, when applicable. Review the preview, then apply the identical choice:

```bash
codex-process-jobs update --apply --agent-policy none
```

After every applied update:

1. Restart Codex App and Codex CLI; reload VS Code windows.
2. Review every CPJ definition and referenced shared source through `/hooks`.
3. Approve only definitions Codex marks new or changed, and verify retained trust otherwise.
4. Start a fresh task and run a harmless detached smoke test.

An existing task may continue using a preserved older cache generation. That compatibility behavior does not mean the host update failed.

## Claims

- Describe automatic wake and conversational delivery as best-effort and experimental.
- Lead with the durable lifecycle and the quality-of-life benefit: the assigning Codex turn is released instead of polling.
- Do not claim general token savings until repeated matched benchmark evidence supports the exact wording.
- Distinguish a public GitHub release from acceptance into an official or curated plugin marketplace.
