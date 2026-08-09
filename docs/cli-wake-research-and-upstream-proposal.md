# Completion Wake: CLI/TUI Research and Upstream Proposal

- Status: draft for maintainer review; nothing has been filed upstream
- Research date: 2026-07-26
- Conclusion: no plugin-side mechanism can wake an idle Codex TUI agent under
  CPJ's constraints (no daemon, no special Codex invocation). The wake
  transport CPJ uses on App and VS Code terminates in those clients'
  JavaScript layers; the Rust TUI does not participate. Closing the gap
  requires an upstream change to `openai/codex`, drafted below.

## 2026-08-09 update: an official opt-in path now exists

The historical conclusion remains correct under its original **no daemon**
constraint, but Codex CLI 0.147.0 changed the practical boundary. An ordinary
`codex` TUI now silently discovers Codex's official shared local App Server at
its private default Unix socket when the server is already running before the
TUI starts. This does not require `codex --remote`, a wrapper, or a changed
everyday CLI invocation.

A controlled macOS proof started an isolated foreground `codex app-server
--listen unix://`, then launched an ordinary `codex` TUI. A dependency-free
same-user Unix-WebSocket client
initialized the shared App Server and sent `turn/start` for the TUI's loaded
thread. The open TUI rendered the injected prompt and assistant response live.
The matching rollout recorded one accepted and completed turn. Socket
inspection showed a mode-0700 parent directory and mode-0600 socket owned by
the current user.

CPJ therefore implements an experimental **explicit opt-in** path: when the
active Codex distribution supports the official managed daemon, the user
starts it, enables CPJ's CLI preference, and restarts the TUI. The
npm-distributed CLI 0.147.0 tested here could not start that managed daemon
without a separate managed standalone installation; CPJ did not add one or
change `PATH`. CPJ never installs or starts the daemon automatically. It validates the
private same-user endpoint, sends only sanitized completion input, confirms
durable completion, and otherwise preserves the existing portable next-turn
fallback. See the official [Codex App Server documentation](https://developers.openai.com/codex/app-server).

## Goal and original constraints

Codex Process Jobs delivers a live conversational completion into an
already-open Codex App or VS Code task through Codex's private same-user IPC
router. The remaining surface is Codex CLI/TUI: a finished detached job should
wake the owning idle TUI session substantially the same way. The original
desired solution must not require a persistent daemon or a special invocation
of Codex CLI, and CLI behavior must remain substantially the same as App and VS
Code. Version 0.3.0 deliberately treats the shared App Server path as an opt-in
experiment rather than claiming that original zero-setup goal is solved.

## Executive finding

The boundary is structural, and it is now established at the binary level
rather than inferred from behavior:

- The `thread-follower-*` method family that CPJ's private wake path uses is
  implemented in the JavaScript client layers of Codex App (Electron) and the
  Codex VS Code extension (`out/extension.js`). It does not exist in the Rust
  `codex` binary at all — neither in the Homebrew CLI nor in the copy bundled
  inside ChatGPT.app.
- The TUI touches the IPC router only as a short-lived *client* for IDE
  context discovery. It never registers its loaded thread as followable and
  never listens for inbound requests.
- Every hook event in the installed CLI is activity-gated. Nothing fires while
  the TUI is idle.
- An idle TUI therefore has exactly one input surface: its terminal. External
  keystroke injection is not viable (`TIOCSTI` is blocked on modern macOS and
  restricted on current Linux), and writing to the TTY device reaches the
  terminal emulator's output stream, not Codex's input.

Consequently `PRIVATE_IPC_SURFACES = {app, vscode}` in both
`scripts/desktop-ipc.mjs` and `scripts/notifier.mjs` is the correct encoding of
a real boundary, not a missing feature in CPJ.

## Evidence

All inspection was read-only: `strings` over installed binaries, `rg` over
installed bundles, and `lsof` over the live router socket. No vendor file was
modified and no TUI session was driven.

### Inspected artifacts (2026-07-26)

| Artifact | Version / date |
|---|---|
| Homebrew Codex CLI (`codex --version`) | `codex-cli 0.145.0` |
| Native CLI binary (`@openai/codex-darwin-arm64` vendor payload) | 271 MB, built 2026-07-25 |
| ChatGPT.app bundled Rust `codex` (`Contents/Resources/codex`) | 267 MB, built 2026-07-24 |
| Codex VS Code extension | `openai.chatgpt-26.721.41059-darwin-arm64` |
| Live router | `~/.codex/ipc/ipc.sock`, held only by the ChatGPT.app process |

### CLI binary: IPC participation is client-side IDE discovery only

A full `strings` sweep of the native CLI binary finds the IPC socket names and
an IDE-context client, and nothing else:

- Present: `codex-ipc`, `ipc.sock`, `ipc-0.sock`, `sourceClientId`,
  `codex-tui`, `ide-context`, `client-discovery-response`, `canHandle`,
  `workspaceRoot`, plus same-user ownership and permission validation errors
  for the IDE context socket and the message
  `no IDE IPC socket paths were available`.
- Absent: any occurrence of `follower`, `thread-follower`, or `thread-stream`.

The same sweep over the ChatGPT.app bundled Rust binary finds `ipc.sock` and
likewise no `follower` occurrence. The follower handler for App threads
therefore lives in the App's Electron layer, not in its Rust core.

### VS Code extension: the full protocol lives in client JavaScript

`out/extension.js` in the installed extension contains the complete method and
event vocabulary, including `thread-follower-start-turn`,
`thread-follower-steer-turn`, `thread-follower-interrupt-turn`,
`thread-follower-submit-user-input`, `thread-follower-edit-last-user-turn`,
`thread-follower-load-complete-history`, `thread-follower-compact-thread`,
approval and elicitation responses, `thread-stream-following-changed`,
`thread-stream-following-status-requested`, `thread-stream-state-changed`,
`client-discovery-request`/`-response`, `client-status-changed`,
`client-disconnected`, and `ipc-connection-reset`.

### Hook events are all activity-gated

The CLI binary's hook vocabulary is `SessionStart`, `TurnStart`, `PreToolUse`,
`PostToolUse`, `UserPromptSubmit`, `SessionEnd`, with `Stop` documented as the
turn-completion decision hook. Every one requires a session, turn, tool call,
or prompt to be in progress. None can fire for an idle TUI.

### The TUI is becoming an event-stream client, but only by explicit opt-in

The 0.145.0 binary contains `--remote`, `ws://`, `wss://`, and extensive
WebSocket support: a TUI can attach to a remote app-server and render a
conversation whose events it merely observes. That is exactly the architecture
that makes App and VS Code wakeable. It currently requires a special
invocation and a separately managed persistent app-server, so it fails both
CPJ constraints as a default, but it shows upstream converging on the needed
shape.

### Reproduction

```bash
BIN=/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex
strings -a "$BIN" | rg -i "follower|thread-stream" | head
strings -a "$BIN" | rg -o "codex-ipc|ipc-0\.sock|ide-context|canHandle|--remote|wss?://" | sort | uniq -c
rg -o '"[a-z]+(-[a-z]+)+"' ~/.vscode/extensions/openai.chatgpt-*/out/extension.js | tr -d '"' \
  | rg "thread|follower|client|turn|discovery" | sort | uniq -c | sort -rn | head -40
lsof -U | rg "ipc.sock"
```

## Hazard: do not add `cli` to `PRIVATE_IPC_SURFACES` prematurely

With Codex App running, the router will accept a
`thread-follower-start-turn` for a TUI-owned conversation ID, and a client
able to load arbitrary persisted threads — the App — may service it. The turn
would then run and persist invisibly in another client while the open TUI
stays stale, which is worse than the current durable-plus-recap behavior.
CLI must remain excluded until a TUI can be verified as the servicing owner,
for example because the method fails when the thread is not loaded in a TUI
or because the router exposes the owner's client type.

## Interim plugin-side improvements

Until a supported wake path exists, CPJ narrows the CLI experience gap around
content rather than trigger. This is improved CLI completion pickup, not
complete parity. A CLI-owned job now defaults to one human-facing desktop
completion notice — the CLI substitute for live rendering — unless an explicit
launch flag or durable preference disables it; surface-defaulted notices carry
only the job ID, terminal status, and exit code so command-derived text cannot
reach a lock screen without explicit opt-in. In default `auto` mode, the first
eligible hook boundary then gives the CLI-owned job the same bounded
`result --peek` inspection, summary, recommended next step, and permission
question that App and VS Code receive in their direct completion turns; the
direct relay turn stays acknowledgment-only because the open TUI cannot render
it. The user therefore learns of completion immediately and receives the
App-equivalent turn at the first keypress.

The known cost of this shape: a CLI job still consumes an invisible app-server
completion turn before the useful inspection happens at the hook boundary, so
the CLI path spends one more turn than App or VS Code for the same outcome.
That hidden turn preserves durable fallback context, but eliminating it — for
example by skipping the direct relay for CLI-owned jobs and letting the hook
boundary own the whole completion — is worth investigating as a follow-up
once its interaction with resume-time visibility and batching is understood.

A `SessionStart` hook was considered for a resume-time recap and rejected:
SessionStart injects context but does not start a model turn, so nothing
renders before the first user prompt — at which point `UserPromptSubmit`
already provides the recap. Registering an additional hook definition would
expand the mandatory `/hooks` review surface without user-visible benefit.

## Related upstream issues

Verified 2026-07-26. None of these asks for a TUI-side wake path; the closest
was closed as a duplicate of an App-side refresh request.

- [openai/codex#11957](https://github.com/openai/codex/issues/11957) —
  programmatic TUI resync of externally updated thread state. Closed
  2026-02-17 as a duplicate of #11907, which is an App-side manual-refresh
  request rather than a TUI mechanism. The TUI ask was therefore never
  evaluated on its own merits.
- [openai/codex#11907](https://github.com/openai/codex/issues/11907) — App
  manual refresh or auto-sync for archived and cross-surface conversations.
  Open. App-side UI affordance, not a TUI wake path.
- [openai/codex#21974](https://github.com/openai/codex/issues/21974) — the App
  should live-refresh CLI-created local sessions. Open. The mirror image of
  this request: it asks the App to observe CLI activity, not for the TUI to
  receive anything.
- [openai/codex#21743](https://github.com/openai/codex/issues/21743) —
  external app-server turns do not live-refresh an already-open Desktop view.
  Open, no maintainer response.
- [openai/codex#25914](https://github.com/openai/codex/issues/25914) —
  no documented way for app-server clients to discover and attach to the
  active Desktop thread. Open, no maintainer response.
- [openai/codex#11166](https://github.com/openai/codex/issues/11166) —
  network transport for remote attach. **Closed as completed**; 0.145.0 ships
  `--remote` with WebSocket TUI attach. Useful precedent that a well-specified
  transport request in this area can land.
- [openai/codex#32466](https://github.com/openai/codex/issues/32466) — Desktop
  misses live turn updates until the same thread is opened in VS Code. Open.
  Adjacent cross-surface staleness evidence.

## Upstream contribution policy

Verified 2026-07-26 against
[docs/contributing.md](https://github.com/openai/codex/blob/main/docs/contributing.md).

**Code contributions are by invitation only, and uninvited pull requests are
closed without review.** What the team explicitly does want is issue-level
analysis: reproduction detail, root-cause hypotheses, and design feedback.

This inverts the original draft's approach. An offer to implement would signal
that the guidelines were not read and would waste the strongest asset this
research has, which is the analysis itself. The filed issue therefore leads
with evidence and offers further investigation and testing rather than code.

Note also that the repository runs an automated duplicate detector (Codex
Action) which flagged #11957. The filed issue must state up front how it
differs from the App-side refresh requests, or it risks the same
closed-as-duplicate outcome for the same wrong reason.

## Pre-filing checklist

1. **Done 2026-07-27 (UTC). Confirmed: the open TUI did not render the
   externally appended completion turn.** See the controlled run below.
2. Re-run the strings sweep against the then-current CLI release on filing
   day; releases move quickly. *(Done 2026-07-26 against `codex-cli 0.145.0`;
   binary unchanged since the original sweep, `follower`/`thread-stream` still
   absent, IDE-context client vocabulary still present.)*
3. Search `openai/codex` issues and pull requests for newer coverage of the
   same request. *(Done 2026-07-26; results recorded above. No duplicate of
   the TUI-side ask exists.)*
4. File the issue alone. Do not attach or offer a pull request, per the
   invitation-only policy above.

## Controlled TUI observation, 2026-07-27 (UTC)

Environment: `codex-cli 0.145.0` (macOS arm64, Homebrew), CPJ dev provider
`0.2.4+codex.dev-20260725-143432` as the only enabled CPJ provider, thread
`019fa1a1-ea83-7153-947c-1c2f38861e2b`.

Method: a detached 90-second job was launched from inside an open TUI session,
the launch turn was allowed to end, and the terminal was left untouched — no
keystrokes, so no `UserPromptSubmit` boundary could surface the result.

The owning rollout records both turns:

```text
03:32:56  task_started    019fa1a2-005f-78a0-9caa-178005453cf5   (launch turn)
03:33:14  agent_message   Started `wake-probe` as detached job job-ms2o9bco-7ceb64e2.
03:33:14  task_complete   019fa1a2-...                            (thread goes idle)
03:34:45  task_started    019fa1a3-a8e8-7992-a7b2-3f0658953384   (notifier-owned turn)
03:34:46  user_message    Background job `job-ms2o9bco-7ceb64e2` finished successfully with exit code 0.
03:34:48  agent_message   Joel, `job-ms2o9bco-7ceb64e2` finished successfully with exit code 0.
03:34:48  task_complete   019fa1a3-...
```

**Control:** a separate `codex app-server` process durably appended a complete
turn — synthetic notice, assistant reply, and matching `task_complete` — to the
thread of the open TUI. The launch turn had ended 90 seconds earlier, so no
busy-turn race can explain the outcome.

**Observation:** the open TUI displayed none of it. The screen still showed only
the launch-turn output. The completion became visible only through the hook
recap on a later prompt.

This is the behavioral claim the upstream issue makes, verified on the current
release under controlled conditions rather than carried from earlier notes.

### Incidental finding, corrected: the "missing" durable state was never missing

The first write-up of this run reported that a sandboxed launch had left
durable job state outside `CODEX_HOME`. That diagnosis was wrong, and the
correction matters more than the alarm did.

What actually happened, reconstructed from the rollout's exact tool calls:

1. The first controller invocation failed inside the sandbox with a bare
   `EPERM: operation not permitted, chmod '~/.codex/process-jobs-dev'`.
2. The agent retried the identical command with escalated sandbox
   permissions, and the launch succeeded.
3. The record was durable the whole time — at
   `~/.codex/process-jobs-dev/jobs/job-ms2o9bco-7ceb64e2.json`. The
   development provider intentionally uses the suffixed `process-jobs-dev`
   state root to isolate its state from the release provider. The forensic
   tooling searched only the release root, and a broad filesystem search had
   silently hit its timeout, so absence of output was misread as absence of
   the file.

Two real defects survive the correction, and both are fixed in this branch:

- **The sandbox failure was unactionable.** A bare errno invites an agent to
  improvise (for example, substituting a writable state root, which would
  genuinely break durability). `ensurePrivateDirectory` now wraps
  `EPERM`/`EACCES` with an instruction to re-run the exact same command with
  scoped or escalated permissions and to never substitute a different state
  directory.
- **The escalated retry lost the originator environment.** The job record
  shows `ownerSurface: unknown` because `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`
  did not survive the escalated execution path. On a build with CLI-surface
  defaults, that would silently disable them in exactly the sandboxed-TUI
  scenario this research targets. Surface classification now falls back to
  the owning rollout's exact session metadata pair `source: cli`,
  `originator: codex-tui` — the same conservative exact-pair rule already
  used for the remote classification — so an escalated TUI launch keeps its
  CLI-surface behavior. Any non-empty environment originator still takes
  precedence, and other pairs remain `unknown`.

`tools/experimental/verify-tui-wake.py` now scans every `process-jobs*` state
root under `CODEX_HOME` and labels which root each job came from, so the
false missing-state diagnosis cannot recur. None of this weakens the wake
observation above: the completion turn evidence comes from Codex's own
rollout, and the control passed.

## CPJ readiness once upstream lands

When a TUI can service follower turns or resync on notification, CPJ lights
up with minimal change: add `cli` to `PRIVATE_IPC_SURFACES` behind a
version-gated capability probe, reusing the existing validate-then-fallback
transport contract in `scripts/notifier.mjs` and `scripts/desktop-ipc.mjs`.
Durable state, hook recap, and status/result remain the compatibility
baseline exactly as on App and VS Code.

## Draft upstream issue

Everything below the rule is the proposed issue body, matching the repository's
🎁 Feature Request template (`5-feature-request.yml`), which asks for the
Codex variant, the requested feature, and additional information. It offers no
code, per the invitation-only policy. Suggested title:

> TUI cannot be woken by local same-user tooling: no thread-owner registration
> or external resync for an idle `codex` session

---

### What variant of Codex are you using?

CLI (TUI), compared against App and the VS Code extension. Observed on
`codex-cli 0.145.0` (macOS arm64, Homebrew) and Linux x86_64, ChatGPT.app
2026-07-24 build, VS Code extension `26.721.41059`.

### What feature would you like to see?

**How this differs from existing issues (please read before deduplicating):**
this asks for a mechanism *on the TUI side*. #11907 and #21974 ask the **App**
to refresh or observe other surfaces; #21743 and #32466 report **Desktop**
staleness; #25914 asks for an **app-server discovery contract**. #11957 asked
for TUI resync and was closed as a duplicate of #11907, an App-side refresh
request, so the TUI-side ask has not yet been evaluated on its own. None of
those changes anything about an idle TUI's ability to receive a local signal.

There is currently no supported way for a local same-user process to wake an
idle, already-open `codex` TUI session when its persisted thread is updated
externally.

Codex App and the VS Code extension both solve this for their own surfaces
through the same-user IPC router at `$CODEX_HOME/ipc/ipc.sock`: each registers
as the owner of its loaded thread and services follower requests such as
`thread-follower-start-turn`, so an externally initiated turn renders live in
the already-open task. The TUI does not participate. It links the router only
as a short-lived client for IDE context discovery. The TUI is therefore the
only major Codex surface whose open session cannot be reached by local
same-user tooling.

Any one of the following would close the gap. The first matches how App and
the extension already behave:

1. **TUI thread-owner registration.** On start or resume, the TUI registers its
   loaded thread ID as owner with the same-user IPC router it already links,
   and services `thread-follower-start-turn` — running an ordinary turn with
   normal rendering, approval handling, and interrupt behavior. This gives the
   TUI parity with App and the extension, and would additionally let the App
   follow a live TUI session, which is the capability #21974 asks for from the
   other direction.
2. **Minimal externally triggered resync.** A documented signal telling an idle
   TUI that its persisted thread changed, on which it re-reads the rollout and
   renders externally appended turns. This is #11957's ask with a concrete
   transport attached.
3. **A documented supported alternative**, if the team prefers a different
   surface — for example a discoverable per-session app-server endpoint with an
   explicit wake method.

Constraints that appear necessary regardless of shape, based on what was needed
to deliver this safely on App and VS Code: same-user socket ownership and
permission validation; idle-boundary gating (queue or return busy during an
active turn); idempotent, exactly-once turn creation; and preservation of
composer state.

### Additional information

**Why this matters.** Long-running local work — CUDA and CMake builds, large
test suites, data processing — should not hold an agent turn open while it
runs. I maintain [Codex Process Jobs](https://github.com/joelfarthing/codex-process-jobs),
a plugin in the Plugins Directory that runs such commands as detached OS
processes and delivers a sanitized completion back to the owning task. On App
and the VS Code extension, routing that completion through the router's owner
path renders it live in the open task. On the TUI it can only be persisted and
surfaced at the next hook boundary, because nothing can reach an idle TUI. The
same workflow is materially worse on the CLI than on every other surface.

**Evidence (all read-only inspection of shipped binaries; no vendor files
modified).**

- A `strings` sweep of the shipped `codex-cli 0.145.0` native binary contains
  the IPC client vocabulary for IDE context discovery — `codex-ipc`,
  `ipc-0.sock`, `ide-context`, `canHandle`, `codex-tui`, `sourceClientId`,
  `workspaceRoot`, and same-user ownership/permission validation errors — and
  **zero** occurrences of `follower` or `thread-stream`.
- The Rust `codex` binary bundled inside ChatGPT.app likewise contains no
  follower vocabulary. The follower handlers live in the App's Electron layer
  and in the extension's `out/extension.js`, which contains the full method and
  event set (`thread-follower-start-turn`, `-steer-turn`, `-interrupt-turn`,
  `-submit-user-input`, `-load-complete-history`, `thread-stream-*`,
  `client-discovery-*`). This is why the capability exists on two surfaces but
  not the third.
- Every hook event in the shipped CLI (`SessionStart`, `TurnStart`,
  `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionEnd`)
  requires user or agent activity, so hooks cannot substitute for a wake while
  the TUI is idle.
- A turn appended to the same thread by a separate `codex app-server` process
  persists correctly in the rollout, but the open TUI does not display it.
  Controlled run on 2026-07-27 against `0.145.0`: a detached job was launched
  from an open TUI, the launch turn ended, and the terminal was left untouched.
  The rollout records the notifier-owned turn in full — synthetic notice at
  `03:34:46`, assistant reply at `03:34:48`, and a matching `task_complete` —
  while the open TUI displayed none of it. The launch turn had ended 90 seconds
  earlier, ruling out a busy-turn race. The completion became visible only via
  a hook boundary on a later prompt.

Reproduction for the binary claims. Note that `codex` on the npm/Homebrew path
is a Node wrapper; the sweep must target the native vendor binary, or it will
report "no follower vocabulary" for the wrong reason:

```bash
ROOT="$(dirname "$(readlink -f "$(command -v codex)")")/.."
BIN="$(find "$ROOT/node_modules/@openai" -type f -name codex -perm -u+x -path '*vendor*' | head -1)"
file "$BIN"                                                    # expect a native executable
strings -a "$BIN" | grep -Ei "follower|thread-stream" | head    # expect no output
strings -a "$BIN" | grep -Eo "codex-ipc|ide-context|codex-tui" | sort -u   # positive control
```

**Alternatives considered and rejected.** Terminal keystroke injection —
`TIOCSTI` is blocked on modern macOS and restricted on Linux, and
terminal-emulator automation is emulator-specific and unsafe while a user is
composing. Holding a `Stop` hook open — recreates the blocked-turn problem that
detaching exists to solve. `--remote`/WebSocket attach to a shared app-server —
architecturally sound and clearly the direction of travel since #11166 landed,
but it requires a special invocation and a separately managed persistent
server, so it cannot be the default for ordinary local TUI usage.

I am not proposing a pull request, per the invitation-only contribution policy.
I am glad to supply further analysis, additional platform testing, or
verification against a proposed design if that would help.
