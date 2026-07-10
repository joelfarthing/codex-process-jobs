import assert from "node:assert/strict";
import test from "node:test";

import { detectClientSurface, notificationPresentation } from "../scripts/client-surface.mjs";

test("detects the Codex VS Code extension from its exact originator marker", () => {
  assert.deepEqual(
    detectClientSurface({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_vscode" }),
    { surface: "vscode", detectedBy: "codex-originator" }
  );
  assert.equal(notificationPresentation("vscode", "pending"), "durable-refresh-required");
});

test("does not mistake Codex Desktop for the VS Code extension", () => {
  assert.deepEqual(
    detectClientSurface({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" }),
    { surface: "app", detectedBy: "codex-originator" }
  );
  assert.equal(notificationPresentation("app", "pending"), "conversational");
});

test("supports an explicit normalized surface override for wrappers and tests", () => {
  assert.deepEqual(
    detectClientSurface({
      CODEX_PROCESS_JOBS_CLIENT_SURFACE: "CLI",
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_vscode",
    }),
    { surface: "cli", detectedBy: "process-jobs-override" }
  );
  assert.deepEqual(
    detectClientSurface({ CODEX_PROCESS_JOBS_CLIENT_SURFACE: "unknown" }),
    { surface: "unknown", detectedBy: "process-jobs-override" }
  );
});

test("uses status-only wording when no owning thread is available", () => {
  assert.equal(notificationPresentation("vscode", "unavailable"), "status-only");
  assert.equal(notificationPresentation("vscode", "disabled"), "disabled");
});
