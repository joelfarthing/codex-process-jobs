import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGER = path.join(ROOT, "scripts", "package-openai-directory.py");
const RELEASE_VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
).version;

function packageDirectory(output) {
  const result = spawnSync("python3", [PACKAGER, "--output", output], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("OpenAI directory package is deterministic and strictly allowlisted", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cpj-openai-package-"));
  try {
    const firstPath = path.join(temporary, "first.zip");
    const secondPath = path.join(temporary, "second.zip");
    const first = packageDirectory(firstPath);
    const second = packageDirectory(secondPath);

    assert.equal(first.version, RELEASE_VERSION);
    assert.equal(first.sha256, second.sha256);
    assert.deepEqual(fs.readFileSync(firstPath), fs.readFileSync(secondPath));
    assert.equal(
      first.sha256,
      crypto.createHash("sha256").update(fs.readFileSync(firstPath)).digest("hex"),
    );

    assert.ok(first.entries.length > 0);
    assert.ok(
      first.entries.every((entry) => entry.startsWith("codex-process-jobs/")),
    );
    assert.ok(
      first.entries.includes("codex-process-jobs/.codex-plugin/plugin.json"),
    );
    assert.ok(first.entries.includes("codex-process-jobs/PRIVACY.md"));
    assert.ok(first.entries.includes("codex-process-jobs/assets/icon.png"));
    assert.ok(
      first.entries.includes("codex-process-jobs/hooks/pre-tool-use-hook.mjs"),
    );
    assert.ok(first.entries.includes("codex-process-jobs/scripts/job.mjs"));
    assert.ok(
      first.entries.includes("codex-process-jobs/scripts/codex-queue.mjs"),
    );
    assert.ok(
      first.entries.includes(
        "codex-process-jobs/skills/result/references/options.md",
      ),
    );
    assert.ok(
      first.entries.includes("codex-process-jobs/skills/rerun/SKILL.md"),
    );
    assert.ok(
      first.entries.includes(
        "codex-process-jobs/skills/rerun/agents/openai.yaml",
      ),
    );
    assert.ok(
      first.entries.includes("codex-process-jobs/scripts/plugin-identity.mjs"),
    );
    assert.ok(
      first.entries.includes("codex-process-jobs/skills/start/SKILL.md"),
    );

    for (const excluded of [
      ".git/",
      ".github/",
      "AGENTS.md",
      "benchmarks/",
      "docs/",
      "package-lock.json",
      "package.json",
      "scripts/install.mjs",
      "scripts/npm-cli.mjs",
      "scripts/package-openai-directory.py",
      "scripts/smoke.mjs",
      "test/",
    ]) {
      assert.equal(
        first.entries.some((entry) =>
          entry.startsWith(`codex-process-jobs/${excluded}`),
        ),
        false,
        `${excluded} must not enter the Marketplace ZIP`,
      );
    }

    const extracted = path.join(temporary, "extracted");
    const extraction = spawnSync(
      "python3",
      ["-m", "zipfile", "-e", firstPath, extracted],
      { encoding: "utf8" },
    );
    assert.equal(extraction.status, 0, extraction.stderr || extraction.stdout);

    const packagedRoot = path.join(extracted, "codex-process-jobs");
    const packagedManifest = JSON.parse(
      fs.readFileSync(
        path.join(packagedRoot, ".codex-plugin", "plugin.json"),
        "utf8",
      ),
    );
    assert.equal(packagedManifest.name, "codex-process-jobs");
    assert.equal(packagedManifest.interface.displayName, "Codex Process Jobs");
    assert.equal(
      fs.existsSync(
        path.join(packagedRoot, ".codex-plugin", "dev-install.json"),
      ),
      false,
    );
    assert.equal(packagedManifest.interface.logo, "./assets/icon.png");
    assert.equal(
      packagedManifest.interface.websiteURL,
      "https://filamentlabs.io/CPJ/",
    );
    assert.equal(
      packagedManifest.interface.privacyPolicyURL,
      "https://filamentlabs.io/CPJ/privacy",
    );
    assert.equal(
      packagedManifest.interface.termsOfServiceURL,
      "https://filamentlabs.io/CPJ/terms",
    );

    const isolatedEnv = {
      ...process.env,
      CODEX_HOME: path.join(temporary, "codex-home"),
    };
    const status = spawnSync(
      process.execPath,
      [path.join(packagedRoot, "scripts", "job.mjs"), "status", "--all", "--json"],
      { encoding: "utf8", env: isolatedEnv },
    );
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.deepEqual(JSON.parse(status.stdout), { jobs: [] });

    const start = spawnSync(
      process.execPath,
      [
        path.join(packagedRoot, "scripts", "job.mjs"),
        "start",
        "--name", "extracted-package-runtime-proof",
        "--cwd", temporary,
        "--no-notify",
        "--json",
        "--",
        process.execPath,
        "-e",
        'process.stdout.write("extracted package runtime ok\\n")',
      ],
      { encoding: "utf8", env: isolatedEnv },
    );
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const startedJob = JSON.parse(start.stdout).job;
    assert.match(startedJob.id, /^job-/);

    const completion = spawnSync(
      process.execPath,
      [
        path.join(packagedRoot, "scripts", "job.mjs"),
        "status",
        startedJob.id,
        "--wait",
        "--timeout-ms", "5000",
        "--json",
      ],
      { encoding: "utf8", env: isolatedEnv },
    );
    assert.equal(completion.status, 0, completion.stderr || completion.stdout);
    const completedJob = JSON.parse(completion.stdout);
    assert.equal(completedJob.timedOut, false);
    assert.equal(completedJob.job.status, "completed");
    assert.equal(completedJob.job.exitCode, 0);

    const result = spawnSync(
      process.execPath,
      [
        path.join(packagedRoot, "scripts", "job.mjs"),
        "result",
        startedJob.id,
        "--peek",
        "--json",
      ],
      { encoding: "utf8", env: isolatedEnv },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const savedResult = JSON.parse(result.stdout);
    assert.equal(savedResult.job.status, "completed");
    assert.equal(savedResult.stdout, "extracted package runtime ok\n");
    assert.equal(savedResult.stderr, "");

    const hook = spawnSync(
      process.execPath,
      [path.join(packagedRoot, "hooks", "unread-result-hook.mjs")],
      { encoding: "utf8", env: isolatedEnv, input: "{}" },
    );
    assert.equal(hook.status, 0, hook.stderr || hook.stdout);

    const preToolUseHook = spawnSync(
      process.execPath,
      [path.join(packagedRoot, "hooks", "pre-tool-use-hook.mjs")],
      {
        encoding: "utf8",
        env: isolatedEnv,
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          cwd: packagedRoot,
          tool_input: { command: "custom-inference --model model.gguf" },
        }),
      },
    );
    assert.equal(preToolUseHook.status, 0, preToolUseHook.stderr || preToolUseHook.stdout);
    assert.equal(
      JSON.parse(preToolUseHook.stdout).hookSpecificOutput.permissionDecision,
      "deny",
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
