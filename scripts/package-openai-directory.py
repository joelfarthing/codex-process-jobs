#!/usr/bin/env python3
"""Build a deterministic, allowlisted OpenAI Plugins Directory ZIP."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = "codex-process-jobs"
FIXED_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
STRICT_SEMVER = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
)

RUNTIME_FILES = (
    ".codex-plugin/plugin.json",
    ".codexignore",
    "assets/icon.png",
    "hooks/hooks.json",
    "hooks/unread-result-hook.mjs",
    "LICENSE",
    "PRIVACY.md",
    "README.md",
    "SECURITY.md",
    "scripts/cli-entry.mjs",
    "scripts/client-surface.mjs",
    "scripts/desktop-ipc.mjs",
    "scripts/execution.mjs",
    "scripts/job.mjs",
    "scripts/logs.mjs",
    "scripts/notifier.mjs",
    "scripts/preferences.mjs",
    "scripts/process-control.mjs",
    "scripts/session.mjs",
    "scripts/state.mjs",
    "scripts/worker.mjs",
    "skills/cancel/SKILL.md",
    "skills/cancel/agents/openai.yaml",
    "skills/result/SKILL.md",
    "skills/result/agents/openai.yaml",
    "skills/result/references/options.md",
    "skills/start/SKILL.md",
    "skills/start/agents/openai.yaml",
    "skills/status/SKILL.md",
    "skills/status/agents/openai.yaml",
    "skills/tail/SKILL.md",
    "skills/tail/agents/openai.yaml",
)

EXECUTABLE_FILES = frozenset(
    {
        "hooks/unread-result-hook.mjs",
        "scripts/job.mjs",
        "scripts/notifier.mjs",
        "scripts/worker.mjs",
    }
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build the deterministic OpenAI Plugins Directory ZIP."
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Output ZIP path. Defaults to dist/<name>-openai-directory-<version>.zip.",
    )
    return parser.parse_args()


def read_json(relative_path: str) -> dict:
    path = ROOT / relative_path
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"{relative_path} must contain a JSON object")
    return value


def validate_metadata() -> str:
    plugin = read_json(".codex-plugin/plugin.json")
    package = read_json("package.json")
    lock = read_json("package-lock.json")

    if plugin.get("name") != PACKAGE_ROOT or package.get("name") != PACKAGE_ROOT:
        raise ValueError(f"plugin and package names must be {PACKAGE_ROOT!r}")

    versions = {
        plugin.get("version"),
        package.get("version"),
        lock.get("version"),
        lock.get("packages", {}).get("", {}).get("version"),
    }
    if len(versions) != 1:
        raise ValueError("plugin, package, and lockfile versions must match")
    version = versions.pop()
    if not isinstance(version, str) or not STRICT_SEMVER.fullmatch(version):
        raise ValueError(f"release version is not strict SemVer: {version!r}")

    interface = plugin.get("interface")
    if not isinstance(interface, dict):
        raise ValueError("plugin manifest must contain interface metadata")
    if interface.get("category") != "Developer Tools":
        raise ValueError("Marketplace category must be 'Developer Tools'")
    if interface.get("logo") != "./assets/icon.png":
        raise ValueError("Marketplace logo must reference './assets/icon.png'")
    expected_urls = {
        "websiteURL": "https://filamentlabs.io/CPJ/",
        "privacyPolicyURL": "https://filamentlabs.io/CPJ/privacy",
        "termsOfServiceURL": "https://filamentlabs.io/CPJ/terms",
    }
    for field, expected in expected_urls.items():
        if interface.get(field) != expected:
            raise ValueError(f"Marketplace {field} must be {expected!r}")

    display_name = interface.get("displayName")
    short_description = interface.get("shortDescription")
    prompts = interface.get("defaultPrompt")
    if not isinstance(display_name, str) or not display_name.strip():
        raise ValueError("Marketplace displayName must be a non-empty string")
    if (
        not isinstance(short_description, str)
        or not short_description.strip()
        or "\n" in short_description
    ):
        raise ValueError("Marketplace shortDescription must be one non-empty line")
    if not isinstance(prompts, list) or not 1 <= len(prompts) <= 3:
        raise ValueError("Marketplace defaultPrompt must contain one to three prompts")
    if any(
        not isinstance(prompt, str) or not prompt.strip() or "\n" in prompt
        for prompt in prompts
    ):
        raise ValueError("Marketplace prompts must be non-empty one-line strings")
    if len(set(prompts)) != len(prompts):
        raise ValueError("Marketplace prompts must be unique")

    return version


def source_file(relative_path: str) -> Path:
    relative = Path(relative_path)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError(f"unsafe allowlist path: {relative_path}")

    current = ROOT
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError(f"symlinks are not allowed: {relative_path}")

    metadata = os.lstat(current)
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"only regular files are allowed: {relative_path}")
    return current


def zip_info(archive_name: str, relative_path: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(archive_name, FIXED_TIMESTAMP)
    info.create_system = 3
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = (
        stat.S_IFREG | (0o755 if relative_path in EXECUTABLE_FILES else 0o644)
    ) << 16
    info.extra = b""
    info.comment = b""
    return info


def expected_entries() -> list[str]:
    return [f"{PACKAGE_ROOT}/{relative}" for relative in sorted(RUNTIME_FILES)]


def verify_archive(path: Path, source_bytes: dict[str, bytes]) -> None:
    expected = expected_entries()
    with zipfile.ZipFile(path, "r") as archive:
        if archive.namelist() != expected:
            raise ValueError("archive entries do not match the reviewed allowlist")
        if archive.testzip() is not None:
            raise ValueError("archive contains a corrupt member")

        for info in archive.infolist():
            if info.is_dir() or info.date_time != FIXED_TIMESTAMP:
                raise ValueError(f"archive metadata is not normalized: {info.filename}")
            relative = info.filename.removeprefix(f"{PACKAGE_ROOT}/")
            if archive.read(info) != source_bytes[relative]:
                raise ValueError(f"archive content mismatch: {info.filename}")


def build_archive(output: Path) -> dict:
    version = validate_metadata()
    source_bytes = {
        relative: source_file(relative).read_bytes()
        for relative in sorted(RUNTIME_FILES)
    }

    output = output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_name = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f".{output.name}.",
            suffix=".tmp",
            dir=output.parent,
            delete=False,
        ) as temporary:
            temporary_name = Path(temporary.name)

        with zipfile.ZipFile(
            temporary_name,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
            strict_timestamps=True,
        ) as archive:
            for relative, payload in source_bytes.items():
                archive.writestr(
                    zip_info(f"{PACKAGE_ROOT}/{relative}", relative),
                    payload,
                    compress_type=zipfile.ZIP_DEFLATED,
                    compresslevel=9,
                )

        verify_archive(temporary_name, source_bytes)
        os.replace(temporary_name, output)
        temporary_name = None
    finally:
        if temporary_name is not None:
            temporary_name.unlink(missing_ok=True)

    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    return {
        "output": str(output),
        "version": version,
        "sha256": digest,
        "size": output.stat().st_size,
        "entries": expected_entries(),
    }


def main() -> None:
    args = parse_args()
    version = validate_metadata()
    output = args.output or (
        ROOT / "dist" / f"{PACKAGE_ROOT}-openai-directory-{version}.zip"
    )
    print(json.dumps(build_archive(output), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
