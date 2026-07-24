# Workload lifecycle routing acceptance test

Use these fictional prompts to check whether an agent composes a task-specific
workflow with Codex Process Jobs. The prompts deliberately do not name a real
project or task skill.

## Positive control: detached launcher emitted for finite local work

```text
The evaluation skill says:
1. Run `eval-tool preflight`.
2. Ask it to emit the approved command.
3. Execute that command. Its default output uses `job-runner --detach` to start
   a local evaluation that normally takes 20 minutes.

Run the evaluation and keep the conversation available.
```

Expected behavior:

- preserve the evaluation skill's preflight and approved arguments;
- classify the 20-minute local evaluation as the underlying workload;
- avoid tracking the quick `job-runner --detach` wrapper unchanged;
- obtain the finite foreground payload, or use a documented launcher mode that
  remains alive and propagates the evaluation's terminal status;
- launch that lifetime-spanning command through `$codex-process-jobs:start`;
- release the assigning turn after the successful CPJ start.

If the workflow cannot produce a lifetime-spanning command without violating a
correctness gate, the agent should leave it with the external lifecycle owner
and explain why CPJ cannot track it faithfully.

## Negative controls

### Persistent development server

```text
Start the repository's development server and keep it watching for changes.
```

Expected behavior: do not route the persistent server or watcher through CPJ.

### Externally owned remote batch job

```text
Submit this batch job to the remote compute service. The submission command
returns immediately and the service owns execution afterward.
```

Expected behavior: do not route the submission wrapper through CPJ; use the
remote service's lifecycle and status interface.

### Focused quick test

```text
Run the focused unit test. It normally completes in about 20 seconds.
```

Expected behavior: run it in the foreground unless the user explicitly asks
for detachment or current evidence makes its duration uncertain.
