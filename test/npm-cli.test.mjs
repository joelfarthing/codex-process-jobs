import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "npm-cli.mjs");
const RELEASE_VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
).version;

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
  return runFrom(CLI, args, env);
}

function runFrom(cli, args, env = process.env) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: path.resolve(path.dirname(cli), ".."),
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
}

function copyMinimalCommandSource(destination, { includeManifest = true } = {}) {
  const scripts = path.join(destination, "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  for (const file of ["npm-cli.mjs", "install.mjs", "cli-entry.mjs"]) {
    fs.copyFileSync(path.join(ROOT, "scripts", file), path.join(scripts, file));
  }
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(destination, "package.json"));
  if (includeManifest) {
    const manifestDirectory = path.join(destination, ".codex-plugin");
    fs.mkdirSync(manifestDirectory);
    fs.copyFileSync(
      path.join(ROOT, ".codex-plugin", "plugin.json"),
      path.join(manifestDirectory, "plugin.json")
    );
  }
  return path.join(scripts, "npm-cli.mjs");
}

test("version reports the release version", () => {
  const result = run(["version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), RELEASE_VERSION);
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
  assert.ok(result.stdout.includes(`release version: ${RELEASE_VERSION}`));
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

test("provenance doctor describes a release package without implying a checkout registry", (t) => {
  const { home, env } = temporaryHome(t);
  const releaseRoot = path.join(home, "release-package");
  const releaseCli = copyMinimalCommandSource(releaseRoot);

  const result = runFrom(releaseCli, ["doctor", "--provenance"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /command source: release package/);
  assert.match(
    result.stdout,
    /current command source is not an editable checkout; other checkouts were not searched/
  );
  assert.doesNotMatch(result.stdout, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("provenance doctor reports a conflicting marketplace source as invalid", (t) => {
  const { home, env } = temporaryHome(t);
  const marketplaceFile = path.join(home, ".agents", "plugins", "marketplace.json");
  fs.mkdirSync(path.dirname(marketplaceFile), { recursive: true });
  fs.writeFileSync(marketplaceFile, `${JSON.stringify({
    name: "personal",
    plugins: [{
      name: "codex-process-jobs",
      source: { source: "local", path: "./plugins/something-else" },
    }],
  })}\n`);

  const result = run(["doctor", "--provenance"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /plugin cache: invalid/);
  assert.match(result.stdout, /cache generations: none/);
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

test("provenance doctor fails closed on a symlinked CODEX_HOME root", (t) => {
  const { home, env } = temporaryHome(t);
  const realCodexHome = path.join(home, "real-codex-home");
  fs.mkdirSync(realCodexHome);
  fs.symlinkSync(realCodexHome, env.CODEX_HOME);
  const marketplaceFile = path.join(home, ".agents", "plugins", "marketplace.json");
  fs.mkdirSync(path.dirname(marketplaceFile), { recursive: true });
  fs.writeFileSync(marketplaceFile, `${JSON.stringify({
    name: "personal",
    plugins: [{
      name: "codex-process-jobs",
      source: { source: "local", path: "./plugins/codex-process-jobs" },
    }],
  })}\n`);
  const version = "0.2.0+codex.local-20260723-010203";
  const manifest = path.join(
    realCodexHome,
    "plugins",
    "cache",
    "personal",
    "codex-process-jobs",
    version,
    ".codex-plugin",
    "plugin.json"
  );
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, `${JSON.stringify({ name: "codex-process-jobs", version })}\n`);

  const result = run(["doctor", "--provenance"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /plugin cache: invalid/);
  assert.match(result.stdout, /cache generations: none/);
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

test("provenance doctor redacts source paths when command metadata is damaged", (t) => {
  const { home, env } = temporaryHome(t);
  const damagedRoot = path.join(home, "private-source-location");
  const damagedCli = copyMinimalCommandSource(damagedRoot, { includeManifest: false });

  const result = runFrom(damagedCli, ["doctor", "--provenance"], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unable to inspect provenance: command source is invalid/);
  assert.doesNotMatch(
    result.stderr,
    new RegExp(damagedRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
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
