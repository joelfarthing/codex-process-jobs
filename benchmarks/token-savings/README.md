# Token-savings benchmark

This benchmark compares three matched GPT-5.6 Luna arms after Codex Process Jobs is installed:

- **Foreground:** runs a harmless 75-second CMake-style process through ordinary foreground command execution and keeps the agent turn open until it exits.
- **CPJ report:** launches the identical process through Codex Process Jobs, releases the launch turn, and has the automatic completion turn only report terminal status and saved-result availability.
- **CPJ inspect:** launches identically, then has the automatic completion turn inspect the bounded saved result and interpret the final marker.

All arms receive the same plugin and agent-policy context. The harness rotates their order across repeated matched trials, reports each arm separately, and decomposes total cost into detachment overhead (`CPJ report - foreground`) and proactive-inspection overhead (`CPJ inspect - CPJ report`). It does not hide the plugin's initial context cost.

The runner uses `codex exec`, then forces the report or inspect instruction for its corresponding CPJ arm. This is a controlled CLI-harness token benchmark, not native App/remote execution. In normal `auto` mode, App and remote tasks default to inspect while CLI and VS Code default to report; both paths need broader validation before making a public claim that CPJ's default behavior is token-neutral.

The harness reports total tokens, cached and uncached input, output tokens, model invocations, tool calls, and end-to-end wall time from Codex rollout records. Raw JSONL stays in a private temporary directory because it can contain full task context. Only reviewed aggregate results should be committed or published.

```bash
node benchmarks/token-savings/run.mjs \
  --model gpt-5.6-luna \
  --effort medium \
  --pairs 3 \
  --duration-ms 75000 \
  --interval-ms 1000 \
  --output-mode compact
```

If an arm is interrupted by capacity, transport failure, or a benchmark-validator false negative, rerun with the identical arguments plus `--resume <previous-output-directory>`. The harness revalidates and reuses completed arm rollouts, then runs only missing arms; it refuses configuration, label, argv, or behavioral mismatches.

`compact` emits only two progress records plus the final marker and is the primary fairness run. `verbose` emits every synthetic compilation step and measures how proactive inspection behaves with realistic build output.

Multiple pairs are still a benchmark sample rather than a population estimate. The generated neutrality booleans are explicitly screening observations for that sample. The honest publication claim should distinguish total tokens, uncached input plus output, and the larger quality-of-life result: CPJ releases the conversation while the ordinary process is still running.
