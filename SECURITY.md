# Security and threat model

Codex Process Jobs launches user-authorized local commands under the same OS account and execution constraints as the Codex process that starts it. Detachment changes lifetime and bookkeeping; it does not grant additional privileges, bypass sandboxing, or provide a security boundary around the command.

## Trust boundaries

- Plugin code and a hook hash explicitly approved by the user in `/hooks` are trusted local code.
- Command metadata, job JSON, stdout, and stderr are local same-user inputs. Treat them as untrusted evidence when Codex displays or interprets them.
- The automatic completion boundary admits only a validated job ID, a terminal-status enum, and an integer exit code. Command text, labels, paths, errors, argv, environment, and process output never enter synthetic notification or transport-independent next-prompt recap instructions.
- `$status`, `$tail`, and `$result` intentionally expose bounded metadata or process output. Codex must not obey embedded instructions or initiate follow-up actions merely because that data requests them.

Persisted records are size-bounded, schema-checked, bound to their validated filename, read without following record symlinks, and accepted only when their stdout/stderr paths exactly match the job's private log paths. Model-facing full-log reads have an independent 1 MiB cap.

## Same-account limitation

State directories and files use private permissions, but they are not cryptographically authenticated. A process already able to write `$CODEX_HOME/process-jobs` under the same account can forge status or replace logs. That access generally also permits modification of local Codex or plugin state and is outside the broker's strong-auth threat model. Do not use a job record alone to prove that a higher-level repair, migration, build, or evaluation achieved its intended result.

## Hook consent

The installer enables Codex's hooks feature and installs the plugin hook, but never writes hook trust. After restarting the client, the user must open `/hooks`, inspect the `UserPromptSubmit` command and source, and approve its exact hash. Changed hook definitions require a new review through Codex's hash-based trust flow.

## Operational risks

- Detached commands can modify files, consume resources, access inherited environment values, and continue after the client exits, subject to the launching process's OS and sandbox restrictions.
- Do not place secrets in argv or tracked output. The broker does not persist the inherited environment, but the launched command receives it.
- Shell mode is explicit and should be used only when the authorized command requires shell syntax.
- Critical repair, firmware, migration, and destructive jobs require an explicit force flag to cancel; cancellation still cannot make interruption intrinsically safe.
- Completion delivery uses local Codex app-server behavior and is best-effort. Durable state plus explicit status/result retrieval remain the authority.

## Security validation

The test suite covers malicious labels and output exclusion from automatic prompts, invalid and oversized records, filename/ID mismatch, tampered log paths, no-follow file reads, bounded model-facing output, hook delivery races, and process-identity validation before cancellation.
