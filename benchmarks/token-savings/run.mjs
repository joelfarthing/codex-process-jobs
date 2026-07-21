#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SYNTHETIC_BUILD = path.join(ROOT, "benchmarks", "token-savings", "synthetic-build.mjs");
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled", "cancel_failed"]);

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
  let toolCalls = 0;
  const toolNames = {};
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
    if (event?.type === "response_item" && ["custom_tool_call", "function_call"].includes(event.payload?.type)) {
      toolCalls += 1;
      const name = String(event.payload?.name ?? "unknown");
      toolNames[name] = (toolNames[name] ?? 0) + 1;
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
    reasoningOutputTokens: latest.reasoning_output_tokens ?? 0,
    uncachedPlusOutputTokens: uncachedInputTokens + latest.output_tokens,
    modelInvocations: cumulativeTotals.size,
    toolCalls,
    toolNames,
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

async function waitForTreatmentJob(threadId, earliestMs, timeoutMs = 3 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  let selected = null;
  while (Date.now() < deadline) {
    selected = readJobRecords()
      .filter((job) => job.ownerThreadId === threadId)
      .filter((job) => Date.parse(job.createdAt ?? "") >= earliestMs - 5_000)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0] ?? null;
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

const model = option(process.argv, "--model", "gpt-5.6-luna");
const effort = option(process.argv, "--effort", "medium");
const durationMs = positiveInteger(option(process.argv, "--duration-ms"), 75_000, "--duration-ms");
const intervalMs = positiveInteger(option(process.argv, "--interval-ms"), 1_000, "--interval-ms");
const directory = path.resolve(option(
  process.argv,
  "--output",
  path.join(os.tmpdir(), `codex-process-jobs-token-benchmark-${safeTimestamp()}`),
));
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

const command = `node ${JSON.stringify(SYNTHETIC_BUILD)} --duration-ms ${durationMs} --interval-ms ${intervalMs}`;
const common = [
  "This is a controlled Codex Process Jobs token benchmark. Do not edit files or perform unrelated work.",
  `Run exactly this harmless synthetic build command: ${command}`,
  "After the command finishes, report its exit status and the final CPJ_BENCHMARK_RESULT marker.",
].join("\n");
const controlPrompt = [
  common,
  "CONTROL ARM: Do not use Codex Process Jobs, shell backgrounding, nohup, tmux, screen, or any detached mechanism.",
  "Keep this agent turn open and use ordinary local command execution until the process exits.",
].join("\n");
const treatmentPrompt = [
  common,
  "TREATMENT ARM: Use the installed codex-process-jobs start skill with the label luna-token-treatment.",
  "Release the launch turn immediately without monitoring. Let the automatic completion turn inspect the bounded saved result and report the marker.",
].join("\n");
fs.writeFileSync(path.join(directory, "control.prompt.txt"), `${controlPrompt}\n`, { mode: 0o600, flag: "wx" });
fs.writeFileSync(path.join(directory, "treatment.prompt.txt"), `${treatmentPrompt}\n`, { mode: 0o600, flag: "wx" });

const jobsBeforeControl = new Set(readJobRecords().map((job) => job.id));
const controlRun = await runCodex({ name: "control", prompt: controlPrompt, model, effort, directory });
const controlJobs = readJobRecords().filter(
  (job) => !jobsBeforeControl.has(job.id) && job.ownerThreadId === controlRun.threadId,
);
if (controlJobs.length > 0) throw new Error(`Control arm detached ${controlJobs.length} process job(s); trial is invalid.`);

const treatmentStartedAt = Date.now();
const treatmentLaunch = await runCodex({
  name: "treatment-launch",
  prompt: treatmentPrompt,
  model,
  effort,
  directory,
  env: { CODEX_PROCESS_JOBS_COMPLETION_MODE: "inspect" },
});
const treatmentJob = await waitForTreatmentJob(treatmentLaunch.threadId, treatmentStartedAt);
const treatmentWallMs = Date.now() - treatmentStartedAt;
await delay(1_000);

const controlRollout = findRollout(controlRun.threadId);
const treatmentRollout = findRollout(treatmentLaunch.threadId);
const control = {
  threadId: controlRun.threadId,
  wallMs: controlRun.wallMs,
  rollout: controlRollout,
  ...rolloutMetrics(controlRollout),
};
const treatment = {
  threadId: treatmentLaunch.threadId,
  launchWallMs: treatmentLaunch.wallMs,
  wallMs: treatmentWallMs,
  jobId: treatmentJob.id,
  jobStatus: treatmentJob.status,
  notificationStatus: treatmentJob.notification?.status ?? null,
  rollout: treatmentRollout,
  ...rolloutMetrics(treatmentRollout),
};
const comparison = {
  totalTokenSavings: control.totalTokens - treatment.totalTokens,
  totalTokenSavingsPercent: percent(control.totalTokens - treatment.totalTokens, control.totalTokens),
  uncachedPlusOutputSavings: control.uncachedPlusOutputTokens - treatment.uncachedPlusOutputTokens,
  uncachedPlusOutputSavingsPercent: percent(
    control.uncachedPlusOutputTokens - treatment.uncachedPlusOutputTokens,
    control.uncachedPlusOutputTokens,
  ),
  modelInvocationReduction: control.modelInvocations - treatment.modelInvocations,
  toolCallReduction: control.toolCalls - treatment.toolCalls,
};
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  model,
  effort,
  syntheticBuild: { command, durationMs, intervalMs },
  control,
  treatment,
  comparison,
  caveat: "One matched synthetic pair is a pilot, not a population estimate. Repeat pairs before claiming a stable percentage.",
  rawDirectory: directory,
};
fs.writeFileSync(path.join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600, flag: "wx" });
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
