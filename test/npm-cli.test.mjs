import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "npm-cli.mjs");

function temporaryHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-jobs-npm-cli-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "codex"), [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') { console.log('codex-cli test'); process.exit(0); }",
    "console.log(JSON.stringify({ ok: true }));",
  ].join("\n") + "\n", { mode: 0o755 });
  return {
    home,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      CODEX_PROCESS_JOBS_INSTALL_HOME: home,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    },
  };
}

function run(args, env = process.env) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
}

test("version reports the release version", () => {
  const result = run(["version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "0.2.0");
});

test("install and update retain the preview-only installer boundary", (t) => {
  for (const command of ["install", "update"]) {
    const { home, env } = temporaryHome(t);
    const result = run([command, "--agent-policy", "none"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /installation preview/i);
    assert.match(result.stdout, /No changes made/i);
    assert.equal(fs.existsSync(path.join(home, "plugins", "codex-process-jobs")), false);
    assert.equal(fs.existsSync(path.join(home, ".agents", "plugins", "marketplace.json")), false);
  }
});

test("doctor reports package and installation state without changing the host", (t) => {
  const { home, env } = temporaryHome(t);
  const result = run(["doctor"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release version: 0\.2\.0/);
  assert.match(result.stdout, /installed version: not installed/);
  assert.match(result.stdout, /Doctor is read-only and made no changes/);
  assert.equal(fs.existsSync(path.join(home, "plugins", "codex-process-jobs")), false);
});

test("unknown commands fail closed with usage", () => {
  const result = run(["surprise"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: surprise/);
  assert.match(result.stderr, /codex-process-jobs install/);
});
