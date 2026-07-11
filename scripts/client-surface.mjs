import { readSessionMeta, resolveOwnerRolloutFile } from "./session.mjs";

const SURFACE_OVERRIDE = "CODEX_PROCESS_JOBS_CLIENT_SURFACE";
const ORIGINATOR_OVERRIDE = "CODEX_INTERNAL_ORIGINATOR_OVERRIDE";
const KNOWN_SURFACES = new Set(["app", "cli", "vscode", "remote", "unknown"]);

function normalize(value) {
  return String(value ?? "").trim().toLowerCase();
}

function detectRemoteSession(threadId, env) {
  if (!threadId) return null;
  try {
    const rollout = resolveOwnerRolloutFile(threadId, env);
    if (!rollout) return null;
    const metadata = readSessionMeta(rollout);
    const source = normalize(metadata?.source);
    const originator = normalize(metadata?.originator);
    if (source === "vscode" && originator === "codex desktop") {
      return { surface: "remote", detectedBy: "rollout-session-meta" };
    }
  } catch {}
  return null;
}

export function detectClientSurface(env = process.env, { threadId = env.CODEX_THREAD_ID } = {}) {
  const explicit = normalize(env[SURFACE_OVERRIDE]);
  if (KNOWN_SURFACES.has(explicit)) {
    return { surface: explicit, detectedBy: "process-jobs-override" };
  }

  const originator = normalize(env[ORIGINATOR_OVERRIDE]);
  if (originator === "codex_vscode") {
    return { surface: "vscode", detectedBy: "codex-originator" };
  }
  if (originator === "codex desktop") {
    return { surface: "app", detectedBy: "codex-originator" };
  }
  if (originator === "codex_cli" || originator === "codex cli") {
    return { surface: "cli", detectedBy: "codex-originator" };
  }
  if (originator) return { surface: "unknown", detectedBy: null };

  const remote = detectRemoteSession(threadId, env);
  if (remote) return remote;

  return { surface: "unknown", detectedBy: null };
}

export function notificationPresentation(surface, notificationStatus) {
  if (notificationStatus === "disabled") return "disabled";
  if (notificationStatus === "unavailable") return "status-only";
  return surface === "vscode" || surface === "remote"
    ? "durable-refresh-required"
    : "conversational";
}
