#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assistantEvidence } from "./evidence.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SYNTHETIC_BUILD = path.join(ROOT, "benchmarks", "token-savings", "synthetic-build.mjs");
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "cancel_failed"]);
const VARIANTS = ["curated", "dev"];
const METRICS = [
  "totalTokens",
  "uncachedPlusOutputTokens",
  "modelInvocations",
  "toolCalls",
  "toolResultBytes",
  "startSkillReadCalls",
  "resultSkillReadCalls",
  "resultSkillReadBeforeCompletion",
  "resultSkillReadAfterCompletion",
  "combinedResultReadCalls",
];

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function positiveInteger(value, fallback, label) {
  if (value == null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value) {
  return Number(value.toFixed(2));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percent(delta, baseline) {
  return baseline === 0 ? null : round((delta / baseline) * 100);
}

function normalizedToolInput(text) {
  return text.replaceAll('\\"', '"').replaceAll("\\'", "'");
}

function jobCommandMatches(text, verb) {
  return new RegExp(`scripts[\\\\/]job\\.mjs["']?\\s+${verb}\\b`).test(
    normalizedToolInput(text),
  );
}

function pluginMetadata(root, expectedName) {
  const manifestFile = path.join(root, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (manifest.name !== expectedName) {
    throw new Error(`Expected ${expectedName} at ${root}; found ${manifest.name ?? "(missing)"}.`);
  }
  const resultSkill = path.join(root, "skills", "result", "SKILL.md");
  return {
    root,
    name: manifest.name,
    version: manifest.version,
    resultSkill,
    resultSkillBytes: fs.statSync(resultSkill).size,
    resultSkillWords: fs.readFileSync(resultSkill, "utf8").split(/\s+/).filter(Boolean).length,
  };
}

function readJobs(stateDirectory) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const jobsDirectory = path.join(codexHome, stateDirectory, "jobs");
  try {
    return fs.readdirSync(jobsDirectory)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        try {
          return [JSON.parse(fs.readFileSync(path.join(jobsDirectory, name), "utf8"))];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function findRollout(threadId) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const roots = [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
  const suffix = `${threadId}.jsonl`;
  const matches = [];
  for (const root of roots) {
    const pending = [root];
    while (pending.length > 0) {
      const directory = pending.pop();
      let entries;
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        if (["ENOENT", "EACCES"].includes(error?.code)) continue;
        throw error;
      }
      for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(candidate);
        else if (entry.isFile() && entry.name.endsWith(suffix)) {
          matches.push({ file: candidate, modifiedMs: fs.statSync(candidate).mtimeMs });
        }
      }
    }
  }
  matches.sort((left, right) => right.modifiedMs - left.modifiedMs);
  if (!matches[0]) throw new Error(`No rollout found for ${threadId}.`);
  return matches[0].file;
}

function rolloutMetrics(file) {
  let latest = null;
  const cumulativeTotals = new Set();
  const assistantText = [];
  let toolCalls = 0;
  let toolResultBytes = 0;
  let startCommandCalls = 0;
  let resultCommandCalls = 0;
  let startSkillReadCalls = 0;
  let resultSkillReadCalls = 0;
  let resultSkillReadBeforeCompletion = 0;
  let resultSkillReadAfterCompletion = 0;
  let combinedResultReadCalls = 0;
  let completionSeen = false;

  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "event_msg" && event.payload?.type === "token_count") {
      const usage = event.payload?.info?.total_token_usage;
      if (usage && Number.isFinite(usage.total_tokens)) {
        latest = usage;
        cumulativeTotals.add(usage.total_tokens);
      }
    }
    if (
      event?.type === "response_item"
      && ["custom_tool_call", "function_call"].includes(event.payload?.type)
    ) {
      toolCalls += 1;
      const raw = event.payload?.input ?? event.payload?.arguments ?? "";
      const text = typeof raw === "string" ? raw : JSON.stringify(raw);
      const starts = jobCommandMatches(text, "start");
      const results = jobCommandMatches(text, "result");
      const readsStartSkill = /skills[\\/]start[\\/]SKILL\.md/.test(text);
      const readsResultSkill = /skills[\\/]result[\\/]SKILL\.md/.test(text);
      if (starts) startCommandCalls += 1;
      if (results) resultCommandCalls += 1;
      if (readsStartSkill) startSkillReadCalls += 1;
      if (readsResultSkill) {
        resultSkillReadCalls += 1;
        if (completionSeen) resultSkillReadAfterCompletion += 1;
        else resultSkillReadBeforeCompletion += 1;
      }
      if (results && readsResultSkill) combinedResultReadCalls += 1;
    }
    if (
      event?.type === "response_item"
      && ["custom_tool_call_output", "function_call_output"].includes(event.payload?.type)
    ) {
      const output = event.payload?.output ?? "";
      toolResultBytes += Buffer.byteLength(
        typeof output === "string" ? output : JSON.stringify(output),
        "utf8",
      );
    }
    if (
      event?.type === "response_item"
      && event.payload?.type === "message"
      && event.payload?.role === "user"
    ) {
      const message = (event.payload?.content ?? [])
        .map((content) => content?.text ?? "")
        .join("\n");
      if (/^Background job `[^`]+` finished/m.test(message)) completionSeen = true;
    }
    if (
      event?.type === "response_item"
      && event.payload?.type === "message"
      && event.payload?.role === "assistant"
    ) {
      for (const content of event.payload?.content ?? []) {
        if (typeof content?.text === "string") assistantText.push(content.text);
      }
    }
  }
  if (!latest) throw new Error(`No token usage found in ${file}.`);
  const uncachedInputTokens = latest.input_tokens - (latest.cached_input_tokens ?? 0);
  return {
    totalTokens: latest.total_tokens,
    inputTokens: latest.input_tokens,
    cachedInputTokens: latest.cached_input_tokens ?? 0,
    uncachedInputTokens,
    outputTokens: latest.output_tokens,
    uncachedPlusOutputTokens: uncachedInputTokens + latest.output_tokens,
    modelInvocations: cumulativeTotals.size,
    toolCalls,
    toolResultBytes,
    startCommandCalls,
    resultCommandCalls,
    startSkillReadCalls,
    resultSkillReadCalls,
    resultSkillReadBeforeCompletion,
    resultSkillReadAfterCompletion,
    combinedResultReadCalls,
    ...assistantEvidence(assistantText),
  };
}

function providerUseMetrics(file, expectedRoot) {
  const expectedSkill = path.join(expectedRoot, "skills", "result", "SKILL.md");
  const expectedController = path.join(expectedRoot, "scripts", "job.mjs");
  let expectedResultSkillReadCalls = 0;
  let expectedResultSkillReadsBeforeCompletion = 0;
  let expectedResultSkillReadsAfterCompletion = 0;
  let expectedResultCommandCalls = 0;
  let completionSeen = false;

  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      event?.type === "response_item"
      && event.payload?.type === "message"
      && event.payload?.role === "user"
    ) {
      const message = (event.payload?.content ?? [])
        .map((content) => content?.text ?? "")
        .join("\n");
      if (/^Background job `[^`]+` finished/m.test(message)) completionSeen = true;
      continue;
    }
    if (
      event?.type !== "response_item"
      || !["custom_tool_call", "function_call"].includes(event.payload?.type)
    ) {
      continue;
    }
    const raw = event.payload?.input ?? event.payload?.arguments ?? "";
    const text = normalizedToolInput(
      typeof raw === "string" ? raw : JSON.stringify(raw),
    );
    if (text.includes(expectedSkill)) {
      expectedResultSkillReadCalls += 1;
      if (completionSeen) expectedResultSkillReadsAfterCompletion += 1;
      else expectedResultSkillReadsBeforeCompletion += 1;
    }
    if (text.includes(expectedController) && jobCommandMatches(text, "result")) {
      expectedResultCommandCalls += 1;
    }
  }
  return {
    expectedResultSkillReadCalls,
    expectedResultSkillReadsBeforeCompletion,
    expectedResultSkillReadsAfterCompletion,
    expectedResultCommandCalls,
  };
}

async function runCodex({ name, prompt, model, effort, directory, config, env }) {
  const outputFile = path.join(directory, `${name}.jsonl`);
  const errorFile = path.join(directory, `${name}.stderr.log`);
  const output = fs.createWriteStream(outputFile, { flags: "wx", mode: 0o600 });
  const errors = fs.createWriteStream(errorFile, { flags: "wx", mode: 0o600 });
  const childEnv = { ...process.env, ...env };
  for (const key of [
    "CODEX_THREAD_ID",
    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    "CODEX_PROCESS_JOBS_NOTIFICATION_RELAY",
  ]) {
    delete childEnv[key];
  }
  const args = [
    "exec",
    "--json",
    "--color", "never",
    "--model", model,
    "-c", `model_reasoning_effort="${effort}"`,
  ];
  for (const override of config) args.push("-c", override);
  args.push("--sandbox", "danger-full-access", "--cd", ROOT, prompt);

  let threadId = null;
  let pending = "";
  const startedAt = Date.now();
  const child = spawn("codex", args, {
    cwd: ROOT,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(errors, { end: false });
  child.stdout.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        const event = JSON.parse(line);
        if (event.type === "thread.started" && typeof event.thread_id === "string") {
          threadId = event.thread_id;
        }
      } catch {}
    }
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 6 * 60_000);
  timeout.unref();
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  clearTimeout(timeout);
  await Promise.all([
    new Promise((resolve) => output.end(resolve)),
    new Promise((resolve) => errors.end(resolve)),
  ]);
  if (code !== 0) {
    const detail = fs.readFileSync(errorFile, "utf8").slice(-8192);
    throw new Error(`${name} failed (code=${code}, signal=${signal}): ${detail}`);
  }
  if (!threadId) throw new Error(`${name} returned no thread ID.`);
  return { threadId, wallMs: Date.now() - startedAt };
}

async function waitForJob({ threadId, stateDirectory, earliestMs, expectedName, expectedArgv }) {
  const deadline = Date.now() + 3 * 60_000;
  let selected = null;
  while (Date.now() < deadline) {
    selected = readJobs(stateDirectory)
      .filter((job) => job.ownerThreadId === threadId)
      .filter((job) => Date.parse(job.createdAt ?? "") >= earliestMs - 5_000)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0] ?? null;
    if (
      selected
      && (
        selected.name !== expectedName
        || JSON.stringify(selected.argv) !== JSON.stringify(expectedArgv)
      )
    ) {
      throw new Error(`Unexpected job for ${threadId}: ${selected.name} ${JSON.stringify(selected.argv)}.`);
    }
    if (
      selected
      && TERMINAL_STATUSES.has(selected.status)
      && selected.notification?.status === "delivered"
    ) {
      return selected;
    }
    await delay(250);
  }
  throw new Error(
    `${expectedName} did not reach delivered terminal state; last=`
    + `${selected?.status ?? "missing"}/${selected?.notification?.status ?? "missing"}.`,
  );
}

function aggregate(runs) {
  return Object.fromEntries(METRICS.map((key) => {
    const values = runs.map((run) => run[key]);
    return [key, {
      mean: round(mean(values)),
      median: round(median(values)),
      min: Math.min(...values),
      max: Math.max(...values),
    }];
  }));
}

function compare(candidate, baseline) {
  const total = candidate.totalTokens - baseline.totalTokens;
  const uncached = candidate.uncachedPlusOutputTokens - baseline.uncachedPlusOutputTokens;
  return {
    totalTokenDelta: total,
    totalTokenDeltaPercent: percent(total, baseline.totalTokens),
    uncachedPlusOutputDelta: uncached,
    uncachedPlusOutputDeltaPercent: percent(uncached, baseline.uncachedPlusOutputTokens),
    modelInvocationDelta: candidate.modelInvocations - baseline.modelInvocations,
    toolCallDelta: candidate.toolCalls - baseline.toolCalls,
    toolResultByteDelta: candidate.toolResultBytes - baseline.toolResultBytes,
  };
}

function aggregateComparisons(comparisons) {
  const keys = Object.keys(comparisons[0]);
  return Object.fromEntries(keys.map((key) => {
    const values = comparisons.map((comparison) => comparison[key]).filter(Number.isFinite);
    return [key, {
      mean: round(mean(values)),
      median: round(median(values)),
      min: Math.min(...values),
      max: Math.max(...values),
    }];
  }));
}

const model = option("--model", "gpt-5.6-luna");
const effort = option("--effort", "low");
const pairs = positiveInteger(option("--pairs"), 5, "--pairs");
const durationMs = positiveInteger(option("--duration-ms"), 75_000, "--duration-ms");
const intervalMs = positiveInteger(option("--interval-ms"), 1_000, "--interval-ms");
const directory = path.resolve(option(
  "--output",
  path.join(os.tmpdir(), `cpj-result-skill-paired-${Date.now()}`),
));
const curatedRoot = path.resolve(option(
  "--curated-root",
  path.join(
    os.homedir(),
    ".codex",
    "plugins",
    "cache",
    "openai-curated-remote",
    "codex-process-jobs",
    "0.2.5",
  ),
));
const devRootOption = option("--dev-root");
if (!devRootOption) throw new Error("--dev-root is required.");
const devRoot = path.resolve(devRootOption);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

const stagedDirectory = path.join(directory, "staged");
const controlRoot = path.join(stagedDirectory, "control");
const candidateRoot = path.join(stagedDirectory, "variant");
fs.mkdirSync(stagedDirectory, { recursive: true, mode: 0o700 });
fs.cpSync(curatedRoot, controlRoot, { recursive: true });
fs.cpSync(curatedRoot, candidateRoot, { recursive: true });
const candidateResultSkill = path.join(candidateRoot, "skills", "result");
fs.rmSync(candidateResultSkill, { recursive: true, force: true });
fs.cpSync(path.join(devRoot, "skills", "result"), candidateResultSkill, { recursive: true });

const productionOnlyConfig = [
  'plugins."codex-process-jobs@openai-curated-remote".enabled=true',
  'plugins."codex-process-jobs-dev@personal".enabled=false',
];
const plugins = {
  curated: {
    ...pluginMetadata(controlRoot, "codex-process-jobs"),
    sourceRoot: curatedRoot,
    stateDirectory: "process-jobs",
    config: productionOnlyConfig,
  },
  dev: {
    ...pluginMetadata(candidateRoot, "codex-process-jobs"),
    sourceRoot: devRoot,
    stateDirectory: "process-jobs",
    config: productionOnlyConfig,
  },
};
const commandArgv = [
  "node",
  SYNTHETIC_BUILD,
  "--duration-ms", String(durationMs),
  "--interval-ms", String(intervalMs),
  "--output-mode", "compact",
];
const command = commandArgv
  .map((argument, index) => index === 1 ? JSON.stringify(argument) : argument)
  .join(" ");

async function runVariant(variant, pair, position) {
  const plugin = plugins[variant];
  const name = `pair-${String(pair).padStart(2, "0")}-${position + 1}-${variant}`;
  const label = `luna-result-skill-p${String(pair).padStart(2, "0")}-${position + 1}`;
  const resultSkill = path.join(plugin.root, "skills", "result", "SKILL.md");
  const prompt = [
    "This is a controlled CPJ result-skill benchmark. Do not edit files or perform unrelated work.",
    `Run exactly this harmless synthetic command: ${command}`,
    `Use only the benchmark CPJ start skill at ${path.join(plugin.root, "skills", "start", "SKILL.md")}.`,
    `Launch it with the exact label ${label}, release the launch turn immediately, and do not monitor it.`,
    "Do not read or preload the result skill before the automatic completion turn.",
    `In the automatic completion turn, use only the matching result skill at ${resultSkill} and its sibling controller.`,
    "Inspect the bounded saved result and report its exit status and final CPJ_BENCHMARK_RESULT marker.",
  ].join("\n");
  fs.writeFileSync(path.join(directory, `${name}.prompt.txt`), `${prompt}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  const startedAt = Date.now();
  const launch = await runCodex({
    name,
    prompt,
    model,
    effort,
    directory,
    config: plugin.config,
    env: { CODEX_PROCESS_JOBS_COMPLETION_MODE: "inspect" },
  });
  const job = await waitForJob({
    threadId: launch.threadId,
    stateDirectory: plugin.stateDirectory,
    earliestMs: startedAt,
    expectedName: label,
    expectedArgv: commandArgv,
  });
  await delay(1_000);
  const rollout = findRollout(launch.threadId);
  const metrics = rolloutMetrics(rollout);
  const providerMetrics = providerUseMetrics(rollout, plugin.root);
  if (metrics.startCommandCalls !== 1) {
    throw new Error(`${name} used ${metrics.startCommandCalls} CPJ start calls.`);
  }
  if (metrics.startSkillReadCalls !== 1) {
    throw new Error(`${name} used ${metrics.startSkillReadCalls} start-skill reads.`);
  }
  if (metrics.resultSkillReadBeforeCompletion !== 0) {
    throw new Error(`${name} preloaded the result skill before completion.`);
  }
  if (
    providerMetrics.expectedResultSkillReadsAfterCompletion !== 1
    || metrics.resultSkillReadAfterCompletion !== 1
  ) {
    throw new Error(`${name} did not perform exactly one matching completion-time result-skill read.`);
  }
  if (providerMetrics.expectedResultSkillReadCalls !== metrics.resultSkillReadCalls) {
    throw new Error(
      `${name} used ${metrics.resultSkillReadCalls - providerMetrics.expectedResultSkillReadCalls}`
      + " result-skill read(s) from another provider.",
    );
  }
  if (providerMetrics.expectedResultCommandCalls < 1) {
    throw new Error(`${name} did not use the matching result controller.`);
  }
  if (providerMetrics.expectedResultCommandCalls !== metrics.resultCommandCalls) {
    throw new Error(
      `${name} used ${metrics.resultCommandCalls - providerMetrics.expectedResultCommandCalls}`
      + " result-controller call(s) from another provider.",
    );
  }
  if (metrics.combinedResultReadCalls !== 0) {
    throw new Error(`${name} combined the result-skill read with result retrieval.`);
  }
  if (metrics.toolCalls !== 4) {
    throw new Error(`${name} used ${metrics.toolCalls} tool calls instead of the four isolated calls.`);
  }
  if (metrics.resultCommandCalls < 1 || !metrics.reportedMarker || !metrics.reportedExitZero) {
    throw new Error(`${name} did not retrieve and report the required result evidence.`);
  }
  if (job.status !== "completed" || job.exitCode !== 0) {
    throw new Error(`${name} job ended as ${job.status} with exit ${job.exitCode}.`);
  }
  return {
    pair,
    position: position + 1,
    variant,
    threadId: launch.threadId,
    rollout,
    jobId: job.id,
    jobStatus: job.status,
    jobExitCode: job.exitCode,
    notificationStatus: job.notification?.status ?? null,
    wallMs: Date.now() - startedAt,
    ...metrics,
    ...providerMetrics,
  };
}

const runs = [];
for (let pair = 1; pair <= pairs; pair += 1) {
  const order = pair % 2 === 1 ? VARIANTS : [...VARIANTS].reverse();
  for (let position = 0; position < order.length; position += 1) {
    runs.push(await runVariant(order[position], pair, position));
  }
}

const trials = Array.from({ length: pairs }, (_, index) => {
  const pair = index + 1;
  const pairRuns = Object.fromEntries(
    runs.filter((run) => run.pair === pair).map((run) => [run.variant, run]),
  );
  return {
    pair,
    order: runs
      .filter((run) => run.pair === pair)
      .sort((left, right) => left.position - right.position)
      .map((run) => run.variant),
    variants: pairRuns,
    devVsCurated: compare(pairRuns.dev, pairRuns.curated),
  };
});
const comparisons = trials.map((trial) => trial.devVsCurated);
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  experiment: "result-skill-compaction",
  model,
  effort,
  pairs,
  syntheticBuild: { command, durationMs, intervalMs, outputMode: "compact" },
  plugins,
  trials,
  aggregate: {
    curated: aggregate(runs.filter((run) => run.variant === "curated")),
    dev: aggregate(runs.filter((run) => run.variant === "dev")),
    devVsCurated: aggregateComparisons(comparisons),
  },
  caveats: [
    "This is a paired synthetic screening benchmark, not a population estimate.",
    "Both variants retain the mandatory result-skill read and identical result-inspection behavior.",
    "The experiment measures skill compaction, not elimination of the required skill-loading boundary.",
    "Both staged variants use identical production runtime code, identity, state, and equal-length roots; only the result skill folder differs.",
    "Preloaded, duplicated, combined, cross-provider, or unrelated tool calls are rejected as contaminated.",
    "Raw rollout files can contain full task context and must remain private.",
  ],
  rawDirectory: directory,
};
fs.writeFileSync(path.join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, {
  mode: 0o600,
  flag: "wx",
});
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
