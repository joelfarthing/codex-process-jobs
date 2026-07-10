#!/usr/bin/env node

import fs from "node:fs";

import { TERMINAL_STATUSES, listJobs, nowIso, updateJob } from "../scripts/state.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_JOBS = 3;

function readInput() {
  const raw = fs.readFileSync(0);
  if (raw.length > MAX_INPUT_BYTES) throw new Error("Hook input is too large.");
  const text = raw.toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

function isExplicitJobRequest(prompt) {
  const text = String(prompt ?? "").toLowerCase();
  return text.includes("$codex-process-jobs:status")
    || text.includes("$codex-process-jobs:result")
    || text.includes("how's the build")
    || text.includes("hows the build");
}

function isUnreadForSession(job, sessionId) {
  if (!TERMINAL_STATUSES.has(job.status)) return false;
  if (!sessionId || job.ownerThreadId !== sessionId) return false;
  if (job.resultViewedAt || job.notification?.hookNotifiedAt) return false;
  return !["delivered", "suppressed", "disabled", "fallback_notified"].includes(job.notification?.status);
}

function buildContext(jobs) {
  const lines = jobs.map((job) =>
    `- ${job.id}: ${job.status}${Number.isInteger(job.exitCode) ? ` (exit ${job.exitCode})` : ""}`
  );
  return [
    jobs.length === 1
      ? "A tracked background process job owned by this Codex task finished without a delivered completion turn."
      : `${jobs.length} tracked background process jobs owned by this Codex task finished without delivered completion turns.`,
    "",
    ...lines,
    "",
    "Before handling the new request, briefly notify the user conversationally. Do not quote or interpret process output unless the user asks; use `$codex-process-jobs:result <job-id>` when inspection is appropriate. This context contains only plugin state, not process output, and should be surfaced once.",
  ].join("\n");
}

async function main() {
  const input = readInput();
  const sessionId = String(input.session_id ?? process.env.CODEX_THREAD_ID ?? "").trim();
  if (!sessionId || isExplicitJobRequest(input.prompt)) return;
  const jobs = listJobs()
    .filter((job) => isUnreadForSession(job, sessionId))
    .slice(0, MAX_JOBS);
  if (jobs.length === 0) return;

  const timestamp = nowIso();
  for (const job of jobs) {
    await updateJob(job.id, (current) => ({
      ...current,
      notification: {
        ...(current.notification ?? {}),
        status: "fallback_notified",
        hookNotifiedAt: timestamp,
      },
    }));
  }
  process.stdout.write(`${buildContext(jobs)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
