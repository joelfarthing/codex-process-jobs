export function assistantEvidence(assistantText) {
  return {
    reportedMarker: assistantText.some(
      (text) => /CPJ_BENCHMARK_RESULT[\s\S]{0,80}steps=\d+ checksum=[a-f0-9]{64}/.test(text),
    ),
    reportedExitZero: assistantText.some(
      (text) => /(?:exit (?:status|code)|exited with (?:status|code))[^0-9-]{0,16}0\b/i.test(text),
    ),
    acknowledgedSavedResult: assistantText.some(
      (text) => /saved[- ]result|result (?:is )?(?:ready|available)/i.test(text),
    ),
  };
}
