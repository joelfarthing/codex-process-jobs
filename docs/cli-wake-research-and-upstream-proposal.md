# Completion Wake: CLI/TUI Research and Upstream Proposal

- Status: draft for maintainer review; nothing has been filed upstream
- Research date: 2026-07-26
- Conclusion: no plugin-side mechanism can wake an idle Codex TUI agent under
  CPJ's constraints (no daemon, no special Codex invocation). The wake
  transport CPJ uses on App and VS Code terminates in those clients'
  JavaScript layers; the Rust TUI does not participate. Closing the gap
  requires an upstream change to `openai/codex`, drafted below.

## Goal and constraints

Codex Process Jobs delivers a live conversational completion into an
already-open Codex App or VS Code task through Codex's private same-user IPC
router. The remaining surface is Codex CLI/TUI: a finished detached job should
wake the owning idle TUI session substantially the same way. The solution must
not require a persistent daemon or a special invocation of Codex CLI, and CLI
behavior must remain substantially the same as App and VS Code.

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

Consequently `PRIVATE_IPC_SURFACES = {app, vscode}` in
`scripts/desktop-ipc.mjs` is the correct encoding of a real boundary, not a
missing feature in CPJ.

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

## Interim plugin-side parity

Until a supported wake path exists, CPJ narrows the CLI experience gap around
content rather than trigger. A CLI-owned job now defaults to one human-facing
desktop completion notice — the CLI substitute for live rendering — unless an
explicit launch flag or durable preference disables it. In default `auto`
mode, the first eligible hook boundary then gives the CLI-owned job the same
bounded `result --peek` inspection, summary, recommended next step, and
permission question that App and VS Code receive in their direct completion
turns; the direct relay turn stays acknowledgment-only because the open TUI
cannot render it. The user therefore learns of completion immediately and
receives the App-equivalent turn at the first keypress, which is the closest
honest approximation the current TUI permits.

A `SessionStart` hook was considered for a resume-time recap and rejected:
SessionStart injects context but does not start a model turn, so nothing
renders before the first user prompt — at which point `UserPromptSubmit`
already provides the recap. Registering an additional hook definition would
expand the mandatory `/hooks` review surface without user-visible benefit.

## Related upstream issues

- [openai/codex#11957](https://github.com/openai/codex/issues/11957) —
  programmatic TUI resync of externally updated thread state. Closed without a
  documented maintainer response.
- [openai/codex#21743](https://github.com/openai/codex/issues/21743) —
  external app-server turns do not live-refresh an already-open Desktop view.
  Open, no maintainer response.
- [openai/codex#25914](https://github.com/openai/codex/issues/25914) —
  no documented way for app-server clients to discover and attach to the
  active Desktop thread. Open, no maintainer response.
- [openai/codex#11166](https://github.com/openai/codex/issues/11166) —
  network transport for remote attach; the shipped `--remote` WebSocket TUI
  attach matches this direction.

## Pre-filing checklist

1. Freshly verify on the then-current release that a completion turn appended
   by a separate app-server process does not render in an already-open TUI
   session, so the filed issue reports current behavior from a same-day test
   rather than from prior notes.
2. Re-run the strings sweep against the then-current CLI release on filing
   day; releases move quickly.
3. Search `openai/codex` issues and pull requests for newer coverage of the
   same request (`follower`, `resync`, `refresh`, `invalidation`, `wake`).
4. Decide whether to file the issue alone or alongside a draft PR. The issue
   below offers a contributed implementation in either case.

## CPJ readiness once upstream lands

When a TUI can service follower turns or resync on notification, CPJ lights
up with minimal change: add `cli` to `PRIVATE_IPC_SURFACES` behind a
version-gated capability probe, reusing the existing validate-then-fallback
transport contract in `scripts/notifier.mjs` and `scripts/desktop-ipc.mjs`.
Durable state, hook recap, and status/result remain the compatibility
baseline exactly as on App and VS Code.

## Draft upstream issue

Everything below the rule is the proposed issue body, ready to paste after the
pre-filing checklist passes. Suggested title:

> Feature request: same-user local wake path for an idle TUI session
> (thread-owner registration on the IPC router, or an externally triggered
> rollout resync)

---

### Summary

There is currently no supported way for a local same-user process to wake an
idle, already-open `codex` TUI session when its persisted thread is updated
externally. Codex App and the Codex VS Code extension both solve this for
their own surfaces through the same-user IPC router (`$CODEX_HOME/ipc/ipc.sock`):
each registers as the owner of its loaded thread and services follower
requests such as `thread-follower-start-turn`, so an externally initiated
completion renders live in the open task. The TUI does not participate: it
uses the router only as a short-lived client for IDE context discovery, and
inspection of the shipped `codex-cli 0.145.0` binary finds no follower or
thread-stream vocabulary at all. The result is that the TUI is the only major
Codex surface whose open session cannot be woken by local same-user tooling.

### Motivation

Long-running local work — CUDA and CMake builds, large test suites, data
processing — should not hold an agent turn open while it runs. I maintain
[Codex Process Jobs](https://github.com/joelfarthing/codex-process-jobs), a
plugin in the Plugins Directory that launches such commands as detached OS
processes, records durable bounded results, and delivers a sanitized
completion turn back to the owning task. On Codex App and the VS Code
extension, routing that completion through the IPC router's owner path renders
it live in the already-open task, and the agent immediately inspects the
bounded result and summarizes it. On the TUI, the completion can only be
persisted to the rollout and surfaced at the next hook boundary
(`UserPromptSubmit`), because nothing can reach an idle TUI. Users therefore
get a materially worse experience on the CLI than on every other surface for
the same workflow.

This is the same underlying gap reported from other directions in #11957
(programmatic TUI resync; closed without resolution), #21743 (Desktop view
not refreshed by external app-server turns), and #25914 (no documented
attach/discovery contract for the active Desktop thread).

### Current behavior

Observed on `codex-cli 0.145.0` (macOS arm64, Homebrew), ChatGPT.app of
2026-07-24, and VS Code extension `26.721.41059`:

- A `strings` sweep of the CLI binary contains the IPC client vocabulary for
  IDE context discovery (`codex-ipc`, `ipc-0.sock`, `ide-context`,
  `canHandle`, `codex-tui`, `sourceClientId`, `workspaceRoot`) and zero
  occurrences of `follower` or `thread-stream`. The Rust binary bundled in
  ChatGPT.app likewise contains no follower vocabulary; the follower handlers
  live in the App's Electron layer and the extension's `extension.js`.
- Hook events (`SessionStart`, `TurnStart`, `PreToolUse`, `PostToolUse`,
  `UserPromptSubmit`, `Stop`, `SessionEnd`) all require user or agent
  activity, so they cannot substitute for a wake while the TUI is idle.
- A turn appended to the same thread by a separate `codex app-server` process
  persists correctly in the rollout but the open TUI does not display it;
  it appears only after the session is resumed.

### Requested capability

Any one of the following would close the gap; the first matches how App and
the VS Code extension already behave:

1. **TUI thread-owner registration.** On start or resume, the TUI initializes
   with the same-user IPC router (whose client code it already links for IDE
   discovery), registers its loaded thread ID as owner, and services
   `thread-follower-start-turn` — running an ordinary turn with normal
   rendering, permission handling, and interrupt behavior. This gives the TUI
   exact parity with App and the extension and would also let the App follow
   live TUI sessions.
2. **Minimal externally triggered resync.** A router notification (or other
   documented signal) that tells an idle TUI its persisted thread changed, on
   which the TUI re-reads the rollout and renders externally appended turns.
   This is #11957's ask with a concrete transport.
3. **A documented supported alternative** if the team prefers a different
   surface (for example, a discoverable per-session app-server endpoint with
   an explicit wake method).

Requirements that seem necessary regardless of shape, based on delivering
this behavior safely on App and VS Code: same-user socket ownership and
permissions; idle-boundary gating (queue or return busy during an active
turn); idempotent, exactly-once turn creation; and preservation of composer
state.

### Alternatives considered and rejected

- Terminal keystroke injection: `TIOCSTI` is blocked on modern macOS and
  restricted on Linux; terminal-emulator automation is emulator-specific and
  unsafe while a user is composing.
- Hook-based waiting: holding a `Stop` hook open recreates the blocked-turn
  problem that detaching exists to solve.
- `--remote`/WebSocket attach to a shared app-server: works architecturally
  but requires a special invocation and a persistent server, which cannot be
  a default for ordinary local TUI usage.

### Offer

I am happy to contribute the implementation under maintainer guidance —
option 1 or 2 — and can test across App, VS Code, and CLI on macOS and Linux.
Codex Process Jobs already implements the guarded client side (same-user
socket validation, pre-acceptance fallback, exactly-once acceptance
accounting) and would adopt the supported mechanism as soon as it exists.

### Environment

- `codex-cli 0.145.0`, macOS arm64 (Homebrew) and Linux x86_64
- ChatGPT.app (Codex App) 2026-07-24 build, VS Code extension `26.721.41059`
