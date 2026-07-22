import fs from "node:fs";

const tag = String(process.env.RELEASE_TAG ?? "").trim();
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error(`RELEASE_TAG must be a SemVer tag beginning with v; received ${tag || "(empty)"}.`);
}

const packageMetadata = JSON.parse(fs.readFileSync("package.json", "utf8"));
const packageLock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const pluginManifest = JSON.parse(fs.readFileSync(".codex-plugin/plugin.json", "utf8"));
const expected = tag.slice(1);
const versions = new Map([
  ["package.json", packageMetadata.version],
  ["package-lock.json", packageLock.version],
  ["package-lock root", packageLock.packages?.[""]?.version],
  ["plugin manifest", pluginManifest.version],
]);

for (const [label, version] of versions) {
  if (version !== expected) {
    throw new Error(`${label} version ${version ?? "(missing)"} does not match ${tag}.`);
  }
}

if (packageMetadata.name !== "codex-process-jobs" || packageMetadata.private === true) {
  throw new Error("package.json is not configured as the public codex-process-jobs package.");
}

process.stdout.write(`Verified codex-process-jobs ${expected} for ${tag}.\n`);
