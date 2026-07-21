import assert from "node:assert/strict";
import test from "node:test";

import { assistantEvidence } from "../benchmarks/token-savings/evidence.mjs";

const marker = "CPJ_BENCHMARK_RESULT steps=75 checksum=6b0179050ae6da23f2f338621efed508e187047df7869bff0c7c480235a694cd";

test("token benchmark accepts equivalent explicit exit-zero phrasing", () => {
  for (const text of [
    `Exit status: \`0\`. ${marker}`,
    `The process finished with exit code 0. ${marker}`,
    `The command exited with status \`0\`. ${marker}`,
  ]) {
    assert.equal(assistantEvidence([text]).reportedExitZero, true, text);
    assert.equal(assistantEvidence([text]).reportedMarker, true, text);
  }
});

test("token benchmark evidence rejects nonzero or missing terminal evidence", () => {
  assert.equal(assistantEvidence([`Exit status: 1. ${marker}`]).reportedExitZero, false);
  assert.equal(assistantEvidence(["The command completed successfully."]).reportedExitZero, false);
  assert.equal(assistantEvidence(["Exit status: 0."]).reportedMarker, false);
});

test("token benchmark recognizes report-only saved-result acknowledgements", () => {
  assert.equal(assistantEvidence(["Exit status: 0. The saved result is available."]).acknowledgedSavedResult, true);
  assert.equal(assistantEvidence(["Exit status: 0. Results were not inspected."]).acknowledgedSavedResult, false);
});
