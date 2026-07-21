# Token-savings benchmark

This benchmark compares two matched GPT-5.6 Luna tasks after Codex Process Jobs is installed:

- **Control:** runs a harmless 75-second CMake-style process through ordinary foreground command execution and keeps the agent turn open until it exits.
- **Treatment:** launches the identical process through Codex Process Jobs, releases the launch turn, and includes the automatic completion turn that inspects the bounded saved result.

Both arms receive the same plugin and agent-policy context. This measures the runtime effect of detachment; it does not hide the plugin's initial context cost.

The harness reports total tokens, cached and uncached input, output tokens, model invocations, tool calls, and end-to-end wall time from Codex rollout records. Raw JSONL stays in a private temporary directory because it can contain full task context. Only reviewed aggregate results should be committed or published.

```bash
node benchmarks/token-savings/run.mjs \
  --model gpt-5.6-luna \
  --effort medium \
  --duration-ms 75000 \
  --interval-ms 1000
```

One control/treatment pair is a pilot. Run multiple pairs in alternating order before presenting a percentage as a stable estimate. The honest publication claim should distinguish token consumption from the larger quality-of-life result: CPJ releases the conversation while the ordinary process is still running.
