#!/usr/bin/env node

import fs from "node:fs";

import { TERMINAL_STATUSES, listJobs, nowIso, updateJob } from "../scripts/state.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_JOBS = 3;
const DELIVERY_STARTUP_GRACE_MS = 5_000;
const DELIVERY_STALE_MS = 11 * 60_000;

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

function isSyntheticNotificationPrompt(prompt) {
  const text = String(prompt ?? "").trim();
  return text.startsWith("<process_job_notification>")
    && text.endsWith("</process_job_notification>");
}

function isVsCodeRefreshSurface(job) {
  const presentation = job.notification?.presentation;
  return presentation === "durable-refresh-required"
    || (presentation == null && job.ownerSurface === "vscode");
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function deliveryAttemptIsActive(job) {
  if (job.notification?.status !== "delivering") return false;
  const timestamp = Date.parse(
    job.notification?.lastAttemptAt
      ?? job.notification?.relayStartedAt
      ?? ""
  );
  const ageMs = Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : null;
  if (ageMs != null && ageMs < DELIVERY_STARTUP_GRACE_MS) return true;
  return ageMs != null
    && processIsAlive(job.notification?.relayPid)
    && ageMs < DELIVERY_STALE_MS;
}

function fallbackKind(job, sessionId) {
  if (!TERMINAL_STATUSES.has(job.status)) return null;
  if (!sessionId || job.ownerThreadId !== sessionId) return null;
  if (job.resultViewedAt) return null;
  if (
    job.notification?.status === "delivered"
    && isVsCodeRefreshSurface(job)
    && !job.notification?.surfaceFallbackNotifiedAt
  ) {
    return "vscode-surface";
  }
  if (job.notification?.hookNotifiedAt) return null;
  if (deliveryAttemptIsActive(job)) return null;
  if (["delivered", "suppressed", "disabled", "fallback_notified"].includes(job.notification?.status)) return null;
  return "delivery-fallback";
}

function buildContext(jobs) {
  const refreshFallbacks = jobs.filter((job) => job.fallbackKind === "vscode-surface");
  const lines = jobs.map((job) =>
    `- ${job.id}: ${job.status}${Number.isInteger(job.exitCode) ? ` (exit ${job.exitCode})` : ""}`
  );
  let summary;
  if (refreshFallbacks.length === jobs.length) {
    summary = jobs.length === 1
      ? "A tracked background process job owned by this Codex task finished. Its completion turn was recorded, but this VS Code panel may not have refreshed."
      : `${jobs.length} tracked background process jobs owned by this Codex task finished. Their completion turns were recorded, but this VS Code panel may not have refreshed.`;
  } else if (refreshFallbacks.length === 0) {
    summary = jobs.length === 1
      ? "A tracked background process job owned by this Codex task finished without a delivered completion turn."
      : `${jobs.length} tracked background process jobs owned by this Codex task finished without delivered completion turns.`;
  } else {
    summary = `${jobs.length} tracked background process jobs owned by this Codex task finished. Some completion turns may not be visible in this client.`;
  }
  return [
    summary,
    "",
    ...lines,
    "",
    "Before handling the new request, briefly notify the user conversationally. Do not quote or interpret process output unless the user asks; use `$codex-process-jobs:result <job-id>` when inspection is appropriate. This context contains only plugin state, not process output, and should be surfaced once.",
  ].join("\n");
}

async function main() {
  const input = readInput();
  const sessionId = String(input.session_id ?? process.env.CODEX_THREAD_ID ?? "").trim();
  if (
    !sessionId
    || process.env.CODEX_PROCESS_JOBS_NOTIFICATION_RELAY === "1"
    || isSyntheticNotificationPrompt(input.prompt)
    || isExplicitJobRequest(input.prompt)
  ) return;
  const candidates = listJobs()
    .filter((job) => fallbackKind(job, sessionId))
    .slice(0, MAX_JOBS);
  if (candidates.length === 0) return;

  const timestamp = nowIso();
  const claimed = [];
  for (const candidate of candidates) {
    let claimedKind = null;
    const updated = await updateJob(candidate.id, (current) => {
      claimedKind = fallbackKind(current, sessionId);
      if (!claimedKind) return current;
      const notification = { ...(current.notification ?? {}) };
      if (claimedKind === "vscode-surface") {
        notification.surfaceFallbackNotifiedAt = timestamp;
      } else {
        notification.status = "fallback_notified";
        notification.hookNotifiedAt = timestamp;
        if (isVsCodeRefreshSurface(current)) {
          notification.surfaceFallbackNotifiedAt = timestamp;
        }
      }
      return { ...current, notification };
    });
    if (claimedKind) claimed.push({ ...updated, fallbackKind: claimedKind });
  }
  if (claimed.length > 0) process.stdout.write(`${buildContext(claimed)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
