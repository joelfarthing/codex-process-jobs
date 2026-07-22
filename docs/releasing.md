# Release checklist

Use this gate for every public Codex Process Jobs release. Preparing a release does not authorize changing repository visibility, publishing an npm package, creating a public release, or submitting to a marketplace.

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
- Confirm hook trust remains an explicit `/hooks` action and no development or automation flag bypasses it.
- Review screenshots and examples for information the author does not intend to publish.

## Packaging and onboarding

- Keep `package.json` and `.codex-plugin/plugin.json` versions aligned.
- Confirm the manifest, skill metadata, license, notice, repository URLs, and supported-platform claims are current.
- Test the README's npm and source preview, policy-selection, apply, restart, and `/hooks` instructions from a clean account or isolated home.
- Verify one local Codex App task and one Linux execution host can start, report, inspect, and cancel harmless jobs.
- Run `npm pack --dry-run` and inspect the complete file list, sizes, executable entry point, package metadata, and absence of development-only or private material.
- Install the packed tarball in an isolated npm prefix, then exercise `version`, `doctor`, preview-only `install`, and preview-only `update`.
- Keep npm and plugin versions identical. The immutable npm version, Git tag, and GitHub Release title must all match.

## Publication boundary

- Merge the reviewed release candidate into the default branch.
- Verify CI on the exact default-branch commit.
- Prepare the changelog entry and GitHub release notes without publishing them.
- Obtain explicit approval immediately before any public npm publish, version tag, or GitHub Release.
- Publish npm with public access and provenance. For the first package-name reservation, use an authenticated one-time bootstrap publication; then configure npm Trusted Publishing for the exact repository and workflow and remove any temporary publication token.
- Create the matching signed or annotated version tag and GitHub Release only after the package artifact and exact default-branch commit are verified.
- Confirm the public clone URL, screenshots, issue tracker, security-reporting route, and installation instructions work while signed out.

## npm release procedure

1. Confirm `package.json`, `package-lock.json`, and `.codex-plugin/plugin.json` contain the same strict SemVer version.
2. Run `npm ci --ignore-scripts`, `npm run check`, and `npm pack --dry-run`.
3. Run `npm pack`, inspect the tarball, and test it from an isolated home and npm prefix.
4. Confirm the intended version does not already exist on npm. Published npm versions are immutable.
5. Publish with `npm publish --access public --provenance` from an approved provenance-capable workflow. A separately authorized local bootstrap publish may omit provenance only when required to establish the package before Trusted Publishing can be configured.
6. Configure npm Trusted Publishing for `joelfarthing/codex-process-jobs` and the exact publication workflow. Grant only `contents: read` and `id-token: write` to that job.
7. Tag the verified commit `v<version>`, push the tag, and create the matching GitHub Release with the inspected npm tarball attached.
8. Verify `npx --yes codex-process-jobs@<version> version`, preview installation, npm metadata, release assets, and public documentation while signed out.

## Claims

- Describe automatic wake and conversational delivery as best-effort and experimental.
- Lead with the durable lifecycle and the quality-of-life benefit: the assigning Codex turn is released instead of polling.
- Do not claim general token savings until repeated matched benchmark evidence supports the exact wording.
- Distinguish a public GitHub release from acceptance into an official or curated plugin marketplace.
