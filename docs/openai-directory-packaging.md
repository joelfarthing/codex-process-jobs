# OpenAI Plugins Directory packaging

The OpenAI Plugins Directory copy is a versioned snapshot. It does not track
GitHub Releases, Homebrew, or a source checkout automatically.

## Build

Run the deterministic standard-library packager from the repository root:

```bash
npm run package:openai-directory
```

The command validates aligned strict-SemVer versions, portal metadata
(including the square logo and manifest-backed website, privacy, and terms
URLs), the exact production plugin name and display name, absence of a generated
development-install marker, regular files, and the reviewed runtime allowlist.
It writes:

```text
dist/codex-process-jobs-openai-directory-X.Y.Z.zip
```

The command prints the archive's SHA-256, byte size, version, and complete
member list. Every member is placed under one `codex-process-jobs/` root with a
fixed timestamp and normalized mode. Building twice from identical source must
produce identical bytes.

Use `--output` for an isolated verification build:

```bash
python3 scripts/package-openai-directory.py \
  --output /tmp/codex-process-jobs-openai-directory-X.Y.Z.zip
```

## Allowlist

The packager contains the authoritative allowlist. It includes only:

- the plugin manifest and `.codexignore`;
- the composer icon;
- hook definitions and their implementation;
- the five skill definitions and OpenAI skill metadata;
- the runtime modules required by those skills and hooks;
- `LICENSE`, `PRIVACY.md`, `README.md`, and `SECURITY.md`.

It excludes Git metadata, Actions workflows, tests, benchmarks, maintainer
documentation, package-manager files, installers, generated output, caches,
credentials, and machine-specific data. Symlinks and special files fail closed.

## Release use

Build the upload ZIP only from the exact clean commit used for the matching
GitHub Release. Run the official plugin validator, the repository test suite,
the portable smoke test, and the HOL scanner before submission. Record the
source commit and ZIP SHA-256.

Uploading a ZIP, submitting it for review, and publishing an approved version
are separate public actions. Follow `docs/releasing.md` and obtain the
maintainer's explicit authorization at each boundary.

The portal's support URL is submission metadata rather than a supported
`plugin.json` interface field. Re-enter `https://filamentlabs.io/CPJ/support`
when the portal does not retain it across version uploads.
