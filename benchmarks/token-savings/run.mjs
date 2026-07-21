#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assistantEvidence } from "./evidence.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SYNTHETIC_BUILD = path.join(ROOT, "benchmarks", "token-savings", "synthetic-build.mjs");
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled", "cancel_failed"]);
const ARMS = ["foreground", "cpj-report", "cpj-inspect"];
const METRIC_KEYS = [
  "totalTokens",
  "inputTokens",
  "cachedInputTokens",
  "uncachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "uncachedPlusOutputTokens",
  "modelInvocations",
  "taskCount",
  "toolCalls",
  "toolResultBytes",
];

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : argv[index + 1];
}

function positiveInteger(value, fallback, label) {
  if (value == null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function readJobRecords() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const directory = path.join(codexHome, "process-jobs", "jobs");
  try {
    return fs.readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        try {
          return [JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"))];
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
    const stack = [root];
    while (stack.length > 0) {
      const directory = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        if (["ENOENT", "EACCES"].includes(error?.code)) continue;
        throw error;
      }
      for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) stack.push(candidate);
        else if (entry.isFile() && entry.name.endsWith(suffix)) {
          matches.push({ file: candidate, modifiedMs: fs.statSync(candidate).mtimeMs });
        }
      }
    }
  }
  matches.sort((left, right) => right.modifiedMs - left.modifiedMs);
  if (!matches[0]) throw new Error(`No rollout found for Luna thread ${threadId}.`);
  return matches[0].file;
}

function rolloutMetrics(file) {
  let latest = null;
  const cumulativeTotals = new Set();
  const invocationUsage = [];
  let toolCalls = 0;
  const toolNames = {};
  let toolResultBytes = 0;
  let taskCount = 0;
  const assistantText = [];
  let startCommandCalls = 0;
  let resultCommandCalls = 0;
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
        if (!cumulativeTotals.has(usage.total_tokens)) {
          cumulativeTotals.add(usage.total_tokens);
          const invocation = event.payload?.info?.last_token_usage;
          if (invocation && Number.isFinite(invocation.total_tokens)) invocationUsage.push(invocation);
        }
      }
    }
    if (event?.type === "event_msg" && event.payload?.type === "task_started") taskCount += 1;
    if (event?.type === "response_item" && ["custom_tool_call", "function_call"].includes(event.payload?.type)) {
      toolCalls += 1;
      const name = String(event.payload?.name ?? "unknown");
      toolNames[name] = (toolNames[name] ?? 0) + 1;
      const rawArguments = event.payload?.input ?? event.payload?.arguments ?? "";
      const argumentsText = typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments);
      if (/job\.mjs[\s\S]{0,2000}\bstart\b/.test(argumentsText)) startCommandCalls += 1;
      if (/job\.mjs[\s\S]{0,2000}\bresult\b/.test(argumentsText)) resultCommandCalls += 1;
    }
    if (
      event?.type === "response_item"
      && ["custom_tool_call_output", "function_call_output"].includes(event.payload?.type)
    ) {
      const output = event.payload?.output ?? "";
      const serialized = typeof output === "string" ? output : JSON.stringify(output);
      toolResultBytes += Buffer.byteLength(serialized, "utf8");
    }
    if (event?.type === "response_item" && event.payload?.type === "message" && event.payload?.role === "assistant") {
      for (const content of event.payload?.content ?? []) {
        if (typeof content?.text === "string") assistantText.push(content.text);
      }
    }
  }
  if (!latest) throw new Error(`No token usage found in ${file}.`);
  const uncachedInputTokens = latest.input_tokens - (latest.cached_input_tokens ?? 0);
  const evidence = assistantEvidence(assistantText);
  return {
    totalTokens: latest.total_tokens,
    inputTokens: latest.input_tokens,
    cachedInputTokens: latest.cached_input_tokens ?? 0,
    uncachedInputTokens,
    outputTokens: latest.output_tokens,
    reasoningOutputTokens: latest.reasoning_output_tokens ?? 0,
    uncachedPlusOutputTokens: uncachedInputTokens + latest.output_tokens,
    modelInvocations: cumulativeTotals.size,
    invocationUsage,
    taskCount,
    toolCalls,
    toolNames,
    toolResultBytes,
    startCommandCalls,
    resultCommandCalls,
    ...evidence,
  };
}

async function runCodex({ name, prompt, model, effort, directory, env = {} }) {
  const outputFile = path.join(directory, `${name}.jsonl`);
  const errorFile = path.join(directory, `${name}.stderr.log`);
  const output = fs.createWriteStream(outputFile, { flags: "wx", mode: 0o600 });
  const errors = fs.createWriteStream(errorFile, { flags: "wx", mode: 0o600 });
  const childEnv = { ...process.env, ...env };
  for (const key of ["CODEX_THREAD_ID", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "CODEX_PROCESS_JOBS_NOTIFICATION_RELAY"]) {
    delete childEnv[key];
  }
  const startedAt = Date.now();
  let threadId = null;
  let pending = "";
  const child = spawn("codex", [
    "exec",
    "--json",
    "--color", "never",
    "--model", model,
    "-c", `model_reasoning_effort=\"${effort}\"`,
    "--sandbox", "danger-full-access",
    "--cd", ROOT,
    prompt,
  ], { cwd: ROOT, env: childEnv, stdio: ["ignore", "pipe", "pipe"], shell: false });
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
        if (event.type === "thread.started" && typeof event.thread_id === "string") threadId = event.thread_id;
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
    throw new Error(`${name} Luna run failed (code=${code}, signal=${signal}): ${detail}`);
  }
  if (!threadId) throw new Error(`${name} Luna run returned no thread id.`);
  return { threadId, outputFile, errorFile, wallMs: Date.now() - startedAt };
}

function readCompletedExecThread(file) {
  let threadId = null;
  let completed = false;
  let failure = null;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string") threadId = event.thread_id;
    if (event.type === "turn.completed") completed = true;
    if (event.type === "turn.failed") failure = event.error ?? event;
  }
  if (!threadId || !completed || failure) {
    throw new Error(`Cannot resume incomplete Codex exec artifact ${file}: ${JSON.stringify(failure)}`);
  }
  return threadId;
}

async function waitForTreatmentJob(
  threadId,
  earliestMs,
  { expectedName, expectedArgv },
  timeoutMs = 3 * 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  let selected = null;
  while (Date.now() < deadline) {
    selected = readJobRecords()
      .filter((job) => job.ownerThreadId === threadId)
      .filter((job) => Date.parse(job.createdAt ?? "") >= earliestMs - 5_000)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0] ?? null;
    if (selected && (selected.name !== expectedName || JSON.stringify(selected.argv) !== JSON.stringify(expectedArgv))) {
      throw new Error(
        `Treatment launched an unexpected job: expected ${expectedName} ${JSON.stringify(expectedArgv)}, `
        + `received ${selected.name} ${JSON.stringify(selected.argv)}.`,
      );
    }
    if (selected && TERMINAL_JOB_STATUSES.has(selected.status) && selected.notification?.status === "delivered") {
      return selected;
    }
    await delay(250);
  }
  throw new Error(
    `Treatment job did not reach terminal delivered state; last state=${selected?.status ?? "missing"}/`
    + `${selected?.notification?.status ?? "missing"}.`,
  );
}

function percent(delta, baseline) {
  return baseline === 0 ? null : Number(((delta / baseline) * 100).toFixed(2));
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

function round(value) {
  return Number(value.toFixed(2));
}

function aggregateRuns(runs) {
  return Object.fromEntries(METRIC_KEYS.map((key) => {
    const values = runs.map((run) => run[key]);
    return [key, {
      mean: round(mean(values)),
      median: round(median(values)),
      min: Math.min(...values),
      max: Math.max(...values),
    }];
  }));
}

function compareRuns(candidate, baseline) {
  const totalTokens = candidate.totalTokens - baseline.totalTokens;
  const uncachedPlusOutputTokens = candidate.uncachedPlusOutputTokens - baseline.uncachedPlusOutputTokens;
  return {
    totalTokenCost: totalTokens,
    totalTokenCostPercent: percent(totalTokens, baseline.totalTokens),
    uncachedPlusOutputCost: uncachedPlusOutputTokens,
    uncachedPlusOutputCostPercent: percent(uncachedPlusOutputTokens, baseline.uncachedPlusOutputTokens),
    modelInvocationCost: candidate.modelInvocations - baseline.modelInvocations,
    toolCallCost: candidate.toolCalls - baseline.toolCalls,
  };
}

function aggregateComparisons(comparisons) {
  const keys = [
    "totalTokenCost",
    "totalTokenCostPercent",
    "uncachedPlusOutputCost",
    "uncachedPlusOutputCostPercent",
    "modelInvocationCost",
    "toolCallCost",
  ];
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

const model = option(process.argv, "--model", "gpt-5.6-luna");
const effort = option(process.argv, "--effort", "medium");
const durationMs = positiveInteger(option(process.argv, "--duration-ms"), 75_000, "--duration-ms");
const intervalMs = positiveInteger(option(process.argv, "--interval-ms"), 1_000, "--interval-ms");
const pairs = positiveInteger(option(process.argv, "--pairs"), 3, "--pairs");
const outputMode = option(process.argv, "--output-mode", "compact");
if (!["compact", "verbose"].includes(outputMode)) throw new Error("--output-mode must be compact or verbose.");
const resumeDirectory = option(process.argv, "--resume");
const outputDirectory = option(process.argv, "--output");
if (resumeDirectory && outputDirectory) throw new Error("Use either --resume or --output, not both.");
const directory = path.resolve(
  resumeDirectory
    ?? outputDirectory
    ?? path.join(os.tmpdir(), `codex-process-jobs-token-benchmark-${safeTimestamp()}`),
);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

const commandArgv = [
  "node",
  SYNTHETIC_BUILD,
  "--duration-ms", String(durationMs),
  "--interval-ms", String(intervalMs),
  "--output-mode", outputMode,
];
const command = commandArgv.map((argument, index) => index === 1 ? JSON.stringify(argument) : argument).join(" ");

function treatmentLabel(arm, pair) {
  const mode = arm === "cpj-report" ? "report" : "inspect";
  return `luna-token-${mode}-p${String(pair).padStart(2, "0")}`;
}

function buildPrompt(arm, pair) {
  const common = [
    "This is a controlled Codex Process Jobs token benchmark. Do not edit files or perform unrelated work.",
    `Run exactly this harmless synthetic build command: ${command}`,
  ];
  if (arm === "foreground") {
    return [
      ...common,
      "FOREGROUND ARM: Do not use Codex Process Jobs, shell backgrounding, nohup, tmux, screen, or any detached mechanism.",
      "Keep this agent turn open and use ordinary local command execution until the process exits.",
      "Then report its exit status and the final CPJ_BENCHMARK_RESULT marker.",
    ].join("\n");
  }
  const mode = arm === "cpj-report" ? "report" : "inspect";
  return [
    ...common,
    `${arm.toUpperCase()} ARM: Use the installed codex-process-jobs start skill with the label ${treatmentLabel(arm, pair)}.`,
    "Release the launch turn immediately without monitoring and let the automatic completion turn follow its supplied instruction.",
    mode === "report"
      ? "In the automatic completion turn, only acknowledge the supplied numeric exit status and saved-result availability; do not inspect the saved output or report its marker."
      : "In the automatic completion turn, inspect the bounded saved result and report its exit status and final CPJ_BENCHMARK_RESULT marker.",
  ].join("\n");
}

function validateArm(arm, metrics, job = null) {
  const expectedStartCalls = arm === "foreground" ? 0 : 1;
  if (metrics.startCommandCalls !== expectedStartCalls) {
    throw new Error(`${arm} called the process-jobs start command ${metrics.startCommandCalls} times.`);
  }
  if (arm === "foreground") {
    if (!metrics.reportedMarker || !metrics.reportedExitZero) {
      throw new Error("Foreground arm did not report the required terminal evidence.");
    }
    return;
  }
  const completionMode = arm === "cpj-report" ? "report" : "inspect";
  if (completionMode === "report" && metrics.resultCommandCalls !== 0) {
    throw new Error("CPJ report arm inspected the saved result; trial is invalid.");
  }
  if (completionMode === "report" && metrics.reportedMarker) {
    throw new Error("CPJ report arm unexpectedly reported process output; trial is invalid.");
  }
  if (completionMode === "report" && !metrics.reportedExitZero) {
    throw new Error("CPJ report arm did not acknowledge the terminal exit status.");
  }
  if (completionMode === "report" && !metrics.acknowledgedSavedResult) {
    throw new Error("CPJ report arm did not acknowledge saved-result availability.");
  }
  if (completionMode === "inspect" && metrics.resultCommandCalls !== 1) {
    throw new Error(`CPJ inspect arm called result ${metrics.resultCommandCalls} times.`);
  }
  if (completionMode === "inspect" && (!metrics.reportedMarker || !metrics.reportedExitZero)) {
    throw new Error("CPJ inspect arm did not report the required terminal evidence.");
  }
  if (!job || job.status !== "completed" || job.exitCode !== 0 || job.notification?.status !== "delivered") {
    throw new Error(`${arm} synthetic build ended as ${job.status} with exit code ${job.exitCode}.`);
  }
}

function findCompletedTreatmentJob(threadId, arm, pair) {
  const matches = readJobRecords().filter((job) => job.ownerThreadId === threadId);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one resumed ${arm} job for ${threadId}; found ${matches.length}.`);
  }
  const [job] = matches;
  if (job.name !== treatmentLabel(arm, pair) || JSON.stringify(job.argv) !== JSON.stringify(commandArgv)) {
    throw new Error(`Resumed ${arm} job does not match the expected label and argv.`);
  }
  return job;
}

function loadResumableArm(arm, pair, position, name) {
  const execName = arm === "foreground" ? name : `${name}-launch`;
  const outputFile = path.join(directory, `${execName}.jsonl`);
  if (!fs.existsSync(outputFile)) return null;
  const threadId = readCompletedExecThread(outputFile);
  const rollout = findRollout(threadId);
  const metrics = rolloutMetrics(rollout);
  if (arm === "foreground") {
    const unexpectedJobs = readJobRecords().filter((job) => job.ownerThreadId === threadId);
    if (unexpectedJobs.length > 0) {
      throw new Error(`Resumed foreground arm detached ${unexpectedJobs.length} process job(s).`);
    }
    validateArm(arm, metrics);
    return { arm, pair, position: position + 1, resumed: true, threadId, wallMs: null, rollout, ...metrics };
  }
  const job = findCompletedTreatmentJob(threadId, arm, pair);
  validateArm(arm, metrics, job);
  return {
    arm,
    pair,
    position: position + 1,
    resumed: true,
    threadId,
    launchWallMs: null,
    wallMs: null,
    jobId: job.id,
    jobStatus: job.status,
    jobExitCode: job.exitCode,
    jobOwnerSurface: job.ownerSurface,
    notificationStatus: job.notification?.status ?? null,
    rollout,
    ...metrics,
  };
}

async function runArm(arm, pair, position) {
  const name = `pair-${String(pair).padStart(2, "0")}-${String(position + 1).padStart(2, "0")}-${arm}`;
  const prompt = buildPrompt(arm, pair);
  const promptFile = path.join(directory, `${name}.prompt.txt`);
  const expectedPrompt = `${prompt}\n`;
  if (fs.existsSync(promptFile)) {
    if (!resumeDirectory || fs.readFileSync(promptFile, "utf8") !== expectedPrompt) {
      throw new Error(`Existing prompt does not match this benchmark configuration: ${promptFile}`);
    }
  } else {
    fs.writeFileSync(promptFile, expectedPrompt, { mode: 0o600, flag: "wx" });
  }
  if (resumeDirectory) {
    const resumed = loadResumableArm(arm, pair, position, name);
    if (resumed) return resumed;
  }

  if (arm === "foreground") {
    const jobsBefore = new Set(readJobRecords().map((job) => job.id));
    const run = await runCodex({ name, prompt, model, effort, directory });
    const unexpectedJobs = readJobRecords().filter(
      (job) => !jobsBefore.has(job.id) && job.ownerThreadId === run.threadId,
    );
    if (unexpectedJobs.length > 0) {
      throw new Error(`Foreground arm detached ${unexpectedJobs.length} process job(s); trial is invalid.`);
    }
    const rollout = findRollout(run.threadId);
    const metrics = rolloutMetrics(rollout);
    validateArm(arm, metrics);
    return {
      arm,
      pair,
      position: position + 1,
      resumed: false,
      threadId: run.threadId,
      wallMs: run.wallMs,
      rollout,
      ...metrics,
    };
  }

  const completionMode = arm === "cpj-report" ? "report" : "inspect";
  const startedAt = Date.now();
  const launch = await runCodex({
    name: `${name}-launch`,
    prompt,
    model,
    effort,
    directory,
    env: { CODEX_PROCESS_JOBS_COMPLETION_MODE: completionMode },
  });
  const job = await waitForTreatmentJob(launch.threadId, startedAt, {
    expectedName: treatmentLabel(arm, pair),
    expectedArgv: commandArgv,
  });
  const wallMs = Date.now() - startedAt;
  await delay(1_000);
  const rollout = findRollout(launch.threadId);
  const metrics = rolloutMetrics(rollout);
  validateArm(arm, metrics, job);
  return {
    arm,
    pair,
    position: position + 1,
    resumed: false,
    threadId: launch.threadId,
    launchWallMs: launch.wallMs,
    wallMs,
    jobId: job.id,
    jobStatus: job.status,
    jobExitCode: job.exitCode,
    jobOwnerSurface: job.ownerSurface,
    notificationStatus: job.notification?.status ?? null,
    rollout,
    ...metrics,
  };
}

const runs = [];
for (let pair = 1; pair <= pairs; pair += 1) {
  const rotation = (pair - 1) % ARMS.length;
  const order = [...ARMS.slice(rotation), ...ARMS.slice(0, rotation)];
  for (let position = 0; position < order.length; position += 1) {
    runs.push(await runArm(order[position], pair, position));
  }
}

const trials = Array.from({ length: pairs }, (_, index) => {
  const pair = index + 1;
  const pairRuns = Object.fromEntries(runs.filter((run) => run.pair === pair).map((run) => [run.arm, run]));
  return {
    pair,
    order: runs.filter((run) => run.pair === pair).sort((a, b) => a.position - b.position).map((run) => run.arm),
    arms: pairRuns,
    comparisons: {
      detachmentCost: compareRuns(pairRuns["cpj-report"], pairRuns.foreground),
      proactivityCost: compareRuns(pairRuns["cpj-inspect"], pairRuns["cpj-report"]),
      fullInspectCost: compareRuns(pairRuns["cpj-inspect"], pairRuns.foreground),
    },
  };
});

const byArm = Object.fromEntries(ARMS.map((arm) => [arm, aggregateRuns(runs.filter((run) => run.arm === arm))]));
const comparisonNames = ["detachmentCost", "proactivityCost", "fullInspectCost"];
const comparisons = Object.fromEntries(comparisonNames.map((name) => [
  name,
  aggregateComparisons(trials.map((trial) => trial.comparisons[name])),
]));
comparisons.neutralityScreening = {
  sampleSize: pairs,
  cliAndVscodeDefaultReport: {
    observedMeanTotalAtOrBelowForeground: comparisons.detachmentCost.totalTokenCost.mean <= 0,
    observedEveryPairTotalAtOrBelowForeground: comparisons.detachmentCost.totalTokenCost.max <= 0,
  },
  appAndRemoteDefaultInspect: {
    observedMeanTotalAtOrBelowForeground: comparisons.fullInspectCost.totalTokenCost.mean <= 0,
    observedEveryPairTotalAtOrBelowForeground: comparisons.fullInspectCost.totalTokenCost.max <= 0,
  },
  qualification: "These booleans describe only this sample; they are not a population-level token-neutrality claim.",
};
const summary = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  model,
  effort,
  executionSurface: "codex exec CLI harness with completion mode forced per CPJ arm",
  resumedFrom: resumeDirectory ? directory : null,
  syntheticBuild: { command, durationMs, intervalMs, outputMode },
  pairs,
  armOrder: ARMS,
  trials,
  aggregate: { byArm, comparisons },
  caveats: [
    "This is a repeated synthetic benchmark, not a population estimate.",
    "Report-only measures minimal detachment cost but intentionally does not provide equivalent result interpretation.",
    "The forced report and inspect modes represent the two completion instructions, not native App or remote surface execution.",
    "Auto defaults to inspect on App/remote and report on CLI/VS Code, so public default neutrality requires both paths to pass broader validation.",
    "Foreground execution remains conversationally unavailable while the process runs even when it is token-cheaper.",
    "Raw rollout files can contain full task context and must remain private.",
  ],
  rawDirectory: directory,
};
fs.writeFileSync(path.join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600, flag: "wx" });
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
