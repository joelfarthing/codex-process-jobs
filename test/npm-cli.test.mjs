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
    "if (process.env.FAKE_CODEX_MARKER) require('node:fs').writeFileSync(process.env.FAKE_CODEX_MARKER, 'invoked');",
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

test("provenance doctor reports source layers without exposing local paths", (t) => {
  const { home, env } = temporaryHome(t);
  const runtimeVersion = "0.2.0+codex.local-20260723-010203";
  const runtimeManifest = path.join(
    home,
    "plugins",
    "codex-process-jobs",
    ".codex-plugin",
    "plugin.json"
  );
  fs.mkdirSync(path.dirname(runtimeManifest), { recursive: true });
  fs.writeFileSync(runtimeManifest, `${JSON.stringify({
    name: "codex-process-jobs",
    version: runtimeVersion,
  })}\n`);

  const marketplaceFile = path.join(home, ".agents", "plugins", "marketplace.json");
  fs.mkdirSync(path.dirname(marketplaceFile), { recursive: true });
  fs.writeFileSync(marketplaceFile, `${JSON.stringify({
    name: "personal",
    plugins: [{
      name: "codex-process-jobs",
      source: { source: "local", path: "./plugins/codex-process-jobs" },
    }],
  })}\n`);

  for (const version of [
    "0.1.0+codex.local-20260722-010101",
    runtimeVersion,
  ]) {
    const manifest = path.join(
      env.CODEX_HOME,
      "plugins",
      "cache",
      "personal",
      "codex-process-jobs",
      version,
      ".codex-plugin",
      "plugin.json"
    );
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, `${JSON.stringify({
      name: "codex-process-jobs",
      version,
    })}\n`);
  }

  const result = run(["doctor", "--provenance"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Codex Process Jobs provenance/);
  assert.match(result.stdout, /command source: development checkout/);
  assert.match(result.stdout, new RegExp(`runtime snapshot: present \\(${runtimeVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
  assert.match(result.stdout, /plugin cache: present \(2 validated generations\)/);
  assert.match(result.stdout, /upstream repository: joelfarthing\/codex-process-jobs/);
  assert.match(result.stdout, /editable checkout: current command source/);
  assert.match(result.stdout, /local paths: redacted/);
  assert.doesNotMatch(result.stdout, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.stdout, /Provenance is read-only and made no changes/);
});

test("provenance doctor reports absent layers without creating state", (t) => {
  const { home, env } = temporaryHome(t);
  const codexMarker = path.join(home, "codex-invoked");
  env.FAKE_CODEX_MARKER = codexMarker;
  const before = fs.readdirSync(home, { recursive: true }).sort();
  const result = run(["doctor", "--provenance"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /runtime snapshot: absent/);
  assert.match(result.stdout, /plugin cache: absent/);
  assert.match(result.stdout, /cache generations: none/);
  assert.match(result.stdout, /upstream repository: joelfarthing\/codex-process-jobs/);
  assert.deepEqual(fs.readdirSync(home, { recursive: true }).sort(), before);
  assert.equal(fs.existsSync(codexMarker), false);
});

test("provenance doctor fails closed on a symlinked cache generation", (t) => {
  const { home, env } = temporaryHome(t);
  const marketplaceFile = path.join(home, ".agents", "plugins", "marketplace.json");
  fs.mkdirSync(path.dirname(marketplaceFile), { recursive: true });
  fs.writeFileSync(marketplaceFile, `${JSON.stringify({
    name: "personal",
    plugins: [{
      name: "codex-process-jobs",
      source: { source: "local", path: "./plugins/codex-process-jobs" },
    }],
  })}\n`);
  const cacheRoot = path.join(
    env.CODEX_HOME,
    "plugins",
    "cache",
    "personal",
    "codex-process-jobs"
  );
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.symlinkSync(home, path.join(cacheRoot, "0.2.0+codex.local-linked"));

  const result = run(["doctor", "--provenance"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /plugin cache: invalid/);
  assert.match(result.stdout, /cache generations: none/);
  assert.doesNotMatch(result.stdout, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("provenance doctor fails closed on symlinked cache boundaries", (t) => {
  for (const dangling of [false, true]) {
    const { home, env } = temporaryHome(t);
    const marketplaceFile = path.join(home, ".agents", "plugins", "marketplace.json");
    fs.mkdirSync(path.dirname(marketplaceFile), { recursive: true });
    fs.writeFileSync(marketplaceFile, `${JSON.stringify({
      name: "personal",
      plugins: [{
        name: "codex-process-jobs",
        source: { source: "local", path: "./plugins/codex-process-jobs" },
      }],
    })}\n`);
    const cacheParent = path.join(env.CODEX_HOME, "plugins", "cache");
    fs.mkdirSync(cacheParent, { recursive: true });
    const target = path.join(home, dangling ? "missing-cache-target" : "external-cache");
    if (!dangling) fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(cacheParent, "personal"));

    const result = run(["doctor", "--provenance"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /plugin cache: invalid/);
    assert.match(result.stdout, /cache generations: none/);
  }
});

test("doctor rejects unknown or repeated provenance options", () => {
  for (const args of [
    ["doctor", "--json"],
    ["doctor", "--provenance", "--provenance"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /doctor accepts only --provenance/);
  }
});

test("unknown commands fail closed with usage", () => {
  const result = run(["surprise"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: surprise/);
  assert.match(result.stderr, /codex-process-jobs install/);
});
