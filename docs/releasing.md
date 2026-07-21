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
- Test the README's clone, preview, policy-selection, apply, restart, and `/hooks` instructions from a clean account or isolated home.
- Verify one local Codex App task and one Linux execution host can start, report, inspect, and cancel harmless jobs.
- Keep the npm package private unless npm distribution is separately designed, tested, and authorized.

## Publication boundary

- Merge the reviewed release candidate into the private default branch.
- Verify CI on the exact default-branch commit.
- Prepare the changelog entry and GitHub release notes without publishing them.
- Obtain explicit approval immediately before changing repository visibility.
- After visibility changes, create the version tag and GitHub release only under the separately approved release scope.
- Confirm the public clone URL, screenshots, issue tracker, security-reporting route, and installation instructions work while signed out.

## Claims

- Describe automatic wake and conversational delivery as best-effort and experimental.
- Lead with the durable lifecycle and the quality-of-life benefit: the assigning Codex turn is released instead of polling.
- Do not claim general token savings until repeated matched benchmark evidence supports the exact wording.
- Distinguish a public GitHub release from acceptance into an official or curated plugin marketplace.
