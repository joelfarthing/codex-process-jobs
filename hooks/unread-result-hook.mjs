#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { TERMINAL_STATUSES, listJobs, nowIso, updateJob } from "../scripts/state.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_JOBS = 20;
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
  return text.includes("**Codex Process Jobs notice:**")
    || text.includes("<!-- codex-process-jobs:notification")
    || (
      text.startsWith("<process_job_notification>")
      && text.endsWith("</process_job_notification>")
    );
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
    && !job.notification?.ordinaryPromptRecapInjectedAt
    && !job.notification?.awarenessCheckedAt
    && !job.notification?.surfaceFallbackNotifiedAt
  ) {
    return "delivered-awareness";
  }
  if (job.notification?.hookNotifiedAt) return null;
  if (deliveryAttemptIsActive(job)) return null;
  if (["delivered", "suppressed", "disabled", "fallback_notified"].includes(job.notification?.status)) return null;
  return "delivery-fallback";
}

function buildContext(jobs) {
  const awarenessFallbacks = jobs.filter((job) => job.fallbackKind === "delivered-awareness");
  const lines = jobs.map((job) =>
    `- ${job.id}: ${job.status}${Number.isInteger(job.exitCode) ? ` (exit ${job.exitCode})` : ""}`
  );
  let summary;
  if (awarenessFallbacks.length === jobs.length) {
    summary = jobs.length === 1
      ? "A tracked background process job owned by this Codex task finished. Its completion turn was recorded, but the assigning client may not have refreshed the agent's context."
      : `${jobs.length} tracked background process jobs owned by this Codex task finished. Their completion turns were recorded, but the assigning client may not have refreshed the agent's context.`;
  } else if (awarenessFallbacks.length === 0) {
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
    "Before handling the new request, briefly recap every listed job to the user.",
    "- If you send commentary, announce each completion there so the user can see it live.",
    "- In all cases, the final answer MUST also include a concise recap for every listed job, even if commentary or a prior assistant completion already mentions it.",
    "- Do not treat commentary or a synthetic completion turn as satisfying the final-answer requirement. Codex App may auto-collapse commentary when the final answer renders, so this within-turn repetition is intentional.",
    "A prior assistant completion for the same job ID may come from a synthetic turn that was durably recorded but never rendered by the assigning client. A possible cross-turn duplicate is intentional and safer than a silent completion. Do not quote or interpret process output unless the user asks; use `$codex-process-jobs:result <job-id>` when inspection is appropriate. This context contains only sanitized plugin state, not process output, and this ordinary-prompt recap instruction is injected once per listed job.",
  ].join("\n");
}

export async function claimCandidates(
  candidates,
  sessionId,
  timestamp,
  { update = updateJob, onError = () => {} } = {},
) {
  const claimed = [];
  for (const candidate of candidates) {
    let claimedKind = null;
    try {
      const updated = await update(candidate.id, (current) => {
        claimedKind = fallbackKind(current, sessionId);
        if (!claimedKind) return current;
        const notification = { ...(current.notification ?? {}) };
        if (claimedKind === "delivered-awareness") {
          notification.ordinaryPromptRecapInjectedAt = timestamp;
        } else {
          notification.status = "fallback_notified";
          notification.hookNotifiedAt = timestamp;
        }
        return { ...current, notification };
      });
      if (claimedKind) claimed.push({ ...updated, fallbackKind: claimedKind });
    } catch (error) {
      onError(candidate, error);
    }
  }
  return claimed;
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
  const claimed = await claimCandidates(candidates, sessionId, timestamp, {
    onError(candidate, error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Could not claim recap for ${candidate.id}: ${message}\n`);
    },
  });
  if (claimed.length > 0) process.stdout.write(`${buildContext(claimed)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
