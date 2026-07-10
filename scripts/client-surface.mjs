const SURFACE_OVERRIDE = "CODEX_PROCESS_JOBS_CLIENT_SURFACE";
const ORIGINATOR_OVERRIDE = "CODEX_INTERNAL_ORIGINATOR_OVERRIDE";
const KNOWN_SURFACES = new Set(["app", "cli", "vscode", "unknown"]);

function normalize(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function detectClientSurface(env = process.env) {
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

  return { surface: "unknown", detectedBy: null };
}

export function notificationPresentation(surface, notificationStatus) {
  if (notificationStatus === "disabled") return "disabled";
  if (notificationStatus === "unavailable") return "status-only";
  return surface === "vscode" ? "durable-refresh-required" : "conversational";
}
