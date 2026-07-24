# Release checklist

Use this gate for every public Codex Process Jobs release. Preparing a release
does not authorize changing repository visibility, creating a public GitHub
Release, or submitting to or publishing in the OpenAI Plugins Directory.

The OpenAI Plugins Directory is the supported installation surface. Immutable
GitHub Releases remain the source and provenance artifacts. The Homebrew formula
is deprecated and frozen at CPJ 0.2.2; do not update it for later releases. Do
not introduce npm registry publication unless the maintainer explicitly reverses
[the accepted distribution decision](decisions/0002-marketplace-primary-distribution.md).

This public runbook documents maintainer verification and sequencing; it grants no repository or tap write authority and contains no authentication material. Outside users should follow the README's installation and update paths, while contributors should use ordinary forks and pull requests.

## Canonical release runway

Treat these as separate, ordered states. Do not describe a merge as a release
or a GitHub Release as a Marketplace update.

| State | Authority | What users receive |
|---|---|---|
| Reviewed change | Feature branch or pull request | Nothing |
| Merged, unreleased | Exact commit on `origin/main` | No public installation surface changes |
| GitHub release published | Immutable `vX.Y.Z` tag and `.tgz` asset | Auditable release bytes and provenance exist |
| Directory archive verified | Deterministic ZIP built from the exact release commit | Marketplace upload bytes are ready but unpublished |
| Directory version published | Approved version is explicitly published in the OpenAI portal | The primary provider can serve the new snapshot |
| Client refreshed | Codex is restarted or reloaded, `/hooks` is reviewed, and a fresh task is opened | New tasks can be checked for the refreshed provider generation |

A release is complete only after the GitHub and Marketplace states above are
verified. If publication fails after a tag or GitHub Release exists, preserve
the immutable artifact and fix forward with a new patch version; never replace
published release bytes in place.

## 1. Develop, review, and merge the change

1. Start the change from current `origin/main`, whether it originates in a local checkout or an outside pull request.
2. Keep unrelated working-tree changes out of the branch.
3. Run `git diff --check`, `npm run check`, and `npm run smoke`; add focused tests for changed behavior.
4. Open a draft pull request, inspect the complete patch, and wait for every required GitHub Actions and security check.
5. Resolve actionable review comments and review threads.
6. Mark the pull request ready and merge it using the repository's intended strategy.
7. Fetch `origin/main` and record the exact merged commit. A local feature branch, even one whose pull request was merged, is not the release authority.

At this point the change is public source code but remains unavailable through
the Plugins Directory.

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
- Test the README's primary Plugins Directory installation, restart, `/hooks`,
  and fresh-task instructions from a clean account or isolated home.
- Verify one local Codex App task and one Linux execution host can start, report, inspect, and cancel harmless jobs.
- Run `npm pack --dry-run` and inspect the complete file list, sizes, executable entry point, package metadata, and absence of development-only or private material.
- Exercise the packed tarball in an isolated Node environment.
- Build the deterministic OpenAI-directory ZIP, inspect its allowlist and
  SHA-256, and validate its extracted runtime.
- Keep package metadata, plugin manifest, Marketplace archive, Git tag, and
  GitHub Release versions identical.

## 3. Publication boundary

- Merge the reviewed release candidate into the default branch.
- Verify CI on the exact default-branch commit.
- Prepare the changelog entry and GitHub release notes without publishing them.
- Obtain explicit approval immediately before any public version tag, GitHub
  Release, Marketplace upload, submission, or publication.
- Create the matching signed or annotated version tag and GitHub Release only after the release artifact and exact default-branch commit are verified.
- Build and verify the Marketplace archive only from the exact release commit.
- Confirm the public clone URL, screenshots, issue tracker, security-reporting route, and installation instructions work while signed out.

Preparation and local validation do not authorize a public write. Obtain
explicit maintainer approval immediately before pushing the version tag,
creating the GitHub Release, uploading, submitting, or publishing the
Marketplace version.

## 4. Build and publish the immutable GitHub release

From the clean release worktree:

1. Confirm `package.json`, `package-lock.json`, and `.codex-plugin/plugin.json` contain the same strict SemVer version.
2. Run `npm ci --ignore-scripts`, `npm run check`, `npm run smoke`, and `npm pack --dry-run`.
3. Run `npm pack`, inspect the complete tarball, and test it from an isolated home. `npm` is the local archive builder only; do not publish to the npm registry.
4. Calculate and record the tarball's SHA-256.
5. Confirm the exact `HEAD` commit and all required CI checks one final time.
6. After the publication approval checkpoint, create an annotated `vX.Y.Z` tag on that exact commit, push the tag, and create the matching GitHub Release with `codex-process-jobs-X.Y.Z.tgz` attached.
7. Download or otherwise re-read the published asset and confirm its SHA-256 matches the inspected local artifact.

The GitHub Release must be complete before downstream publication. The
Marketplace ZIP must be built from that exact clean release commit.

## 5. Publish and verify the OpenAI Plugins Directory version

Follow [OpenAI Plugins Directory packaging](openai-directory-packaging.md):

1. Build the deterministic allowlisted ZIP from the exact clean release commit.
2. Record its source commit, version, SHA-256, byte size, and complete member
   list.
3. Run the official plugin validator, repository suite, portable smoke test,
   extracted-runtime test, and HOL scanner.
4. Obtain explicit approval immediately before uploading the ZIP.
5. Upload the archive and re-enter portal-only metadata that the version form
   does not retain.
6. Inspect every scan result and the complete submission preview.
7. Obtain explicit approval immediately before submitting the version.
8. After approval, obtain explicit approval immediately before publishing it.
9. Confirm the public directory page presents the intended version and
   metadata.
10. Restart or reload representative clients and verify the version in a fresh
    Codex App, CLI, and VS Code task on macOS and Linux where available.

Record whether the new version appeared automatically, required a client
restart, exposed an update action, or required uninstall/reinstall.

## 6. Preserve the deprecated Homebrew migration path

The public Homebrew formula is frozen at CPJ 0.2.2 and does not participate in
later release versioning. Keep its `deprecate!` warning and README migration
guidance intact. Change the tap only to correct a security, installation, or
migration defect in that frozen version, and obtain explicit approval before
the public tap write.

## 7. Update an existing execution host

For the primary OpenAI-directory provider, use the update action presented by
the Plugins Directory or uninstall and reinstall that provider if the client
leaves an older version active. Restart Codex App and CLI, reload VS Code,
review `/hooks`, and verify the provider and version in a fresh task on every
representative execution host. Migrate a Homebrew/personal installation using
the README; never add it beside an existing directory installation.

After every Marketplace update:

1. Restart Codex App and Codex CLI; reload VS Code windows.
2. Review every CPJ definition and referenced shared source through `/hooks`.
3. Approve only definitions Codex marks new or changed, and verify retained
   trust otherwise.
4. Check the Plugins page for the intended provider, version, and skill state.
5. Start a fresh task, verify that it catalogs exactly one active CPJ skill
   provider, and run a harmless detached smoke test.

In the maintainer-only side-by-side development setup, the local provider is the
sole active implementation: all five directory skills and all three directory
hooks are disabled. After every directory update, explicitly re-confirm those
eight toggles before opening the fresh test task. Do not assume a Marketplace
update preserved disabled state, even though current clients do not ordinarily
enable a hook without consent. During one observed Codex App update, all five
disabled directory skills were re-enabled while the three directory hooks
remained disabled. Treat the two toggle groups as independent.

An existing task may continue using a preserved older cache generation. That
compatibility behavior does not mean the host update failed.

## Claims

- Describe automatic wake and conversational delivery as best-effort and experimental.
- Lead with the durable lifecycle and the quality-of-life benefit: the assigning Codex turn is released instead of polling.
- Do not claim general token savings until repeated matched benchmark evidence supports the exact wording.
- Distinguish a public GitHub release from acceptance into an official or curated plugin marketplace.
