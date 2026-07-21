#!/usr/bin/env node

import crypto from "node:crypto";

function positiveInteger(value, fallback, label) {
  if (value == null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? null : argv[index + 1];
}

const durationMs = positiveInteger(option(process.argv, "--duration-ms"), 75_000, "--duration-ms");
const intervalMs = positiveInteger(option(process.argv, "--interval-ms"), 1_000, "--interval-ms");
const outputMode = option(process.argv, "--output-mode") ?? "compact";
if (!["compact", "verbose"].includes(outputMode)) {
  throw new Error("--output-mode must be compact or verbose.");
}
const steps = Math.max(1, Math.ceil(durationMs / intervalMs));
const digest = crypto.createHash("sha256");

for (let step = 1; step <= steps; step += 1) {
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
  const unit = `synthetic_unit_${String(step).padStart(3, "0")}.cpp`;
  digest.update(`${step}:${unit}\n`);
  const compactMilestone = step === 1 || step === Math.ceil(steps / 2);
  if (outputMode === "verbose" || compactMilestone) {
    process.stdout.write(
      `[${String(step).padStart(3, "0")}/${steps}] Building CXX object benchmark/${unit}.o `
      + `progress=${((step / steps) * 100).toFixed(1)}%\n`,
    );
  }
}

process.stdout.write(`CPJ_BENCHMARK_RESULT steps=${steps} checksum=${digest.digest("hex")}\n`);
