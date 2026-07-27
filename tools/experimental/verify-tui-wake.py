#!/usr/bin/env python3
"""Verify whether an external completion turn reached an open Codex TUI.

Supports the CLI/TUI wake research checklist in
docs/cli-wake-research-and-upstream-proposal.md.

Usage:
  verify-tui-wake.py                 # newest CLI-owned job (refuses stale)
  verify-tui-wake.py <job-id>        # a specific job, any age

This establishes the CONTROL for the test: proof that a separate process
really did append a completion turn to the TUI's thread. Whether the open TUI
*rendered* it is the part only a human observer can report.

Read-only. Touches no Codex state and starts no process.
"""
import glob
import json
import os
import sys

HOME = os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex"))
JOBS = os.path.join(HOME, "process-jobs", "jobs")
MAX_AGE_MIN = 30


def load_jobs():
    out = []
    for f in glob.glob(os.path.join(JOBS, "*.json")):
        try:
            out.append((os.path.getmtime(f), json.load(open(f))))
        except Exception:
            pass
    return [j for _, j in sorted(out, key=lambda t: t[0])]


def age_minutes(job):
    ts = job.get("createdAt") or ""
    try:
        import datetime
        t = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
        now = datetime.datetime.now(datetime.timezone.utc)
        return (now - t).total_seconds() / 60.0
    except Exception:
        return None


def pick(argv):
    jobs = load_jobs()
    if not jobs:
        sys.exit("No job records found under %s" % JOBS)
    if len(argv) > 1:
        for j in jobs:
            if j.get("id") == argv[1]:
                return j
        sys.exit("Job %s not found." % argv[1])

    cli = [j for j in jobs if j.get("ownerSurface") == "cli"]
    if not cli:
        print("!! No CLI-owned job found at all. Newest job is surface %r."
              % jobs[-1].get("ownerSurface"))
        print("   A TUI-launched job should be 'cli'. Did the launch actually happen?")
        return jobs[-1]

    chosen = cli[-1]
    age = age_minutes(chosen)
    if age is not None and age > MAX_AGE_MIN:
        print("!" * 72)
        print("STALE SELECTION - REFUSING TO REPORT A RESULT")
        print("!" * 72)
        print("  Newest CLI-owned job is %s" % chosen.get("id"))
        print("  created %s (%.0f minutes ago)" % (chosen.get("createdAt"), age))
        print()
        print("  That is far older than a test you just ran, which means NO NEW JOB")
        print("  WAS CREATED. Whatever you observed on the TUI is meaningless: nothing")
        print("  was appended during your observation window.")
        print()
        print("  Likely causes: the agent ran the command itself instead of routing to")
        print("  codex-process-jobs, a command approval is still pending, or the")
        print("  plugin's skills are not loaded in that session.")
        print()
        print("  Re-run the launch, confirm a NEW job id appears, then re-run this.")
        sys.exit(2)
    return chosen


def rollout_for(thread_id):
    """Search live and archived session stores."""
    if not thread_id:
        return None
    patterns = [
        os.path.join(HOME, "sessions", "*", "*", "*", "*%s*.jsonl" % thread_id),
        os.path.join(HOME, "archived_sessions", "*%s*.jsonl" % thread_id),
        os.path.join(HOME, "**", "*%s*.jsonl" % thread_id),
    ]
    for pat in patterns:
        hits = glob.glob(pat, recursive=True)
        if hits:
            return hits[0]
    return None


def main():
    job = pick(sys.argv)
    jid = job.get("id")
    note = job.get("notification") or {}
    age = age_minutes(job)

    print("=" * 72)
    print("JOB RECORD")
    print("=" * 72)
    for k in ("id", "ownerSurface", "ownerSurfaceDetectedBy", "ownerThreadId",
              "status", "exitCode", "notifyUser", "createdAt", "completedAt"):
        print("  %-24s %s" % (k, job.get(k)))
    if age is not None:
        print("  %-24s %.1f minutes" % ("age", age))
    for k in ("status", "transport", "deliveredAt", "turnId", "presentation",
              "errorMessage", "privateIpcFallbackReason",
              "ordinaryPromptRecapInjectedAt"):
        if k in note:
            print("  notification.%-11s %s" % (k, note.get(k)))

    path = rollout_for(job.get("ownerThreadId"))
    print()
    print("=" * 72)
    print("ROLLOUT TIMELINE")
    print("=" * 72)
    if not path:
        print("  !! No rollout file found for thread %s" % job.get("ownerThreadId"))
        print("     Cannot confirm the append. Test is INCONCLUSIVE.")
        return
    print("  file: %s" % os.path.basename(path))

    notice = turn_started = turn_done = agent_reply = None
    delivered_turn = note.get("turnId")
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        ts = e.get("timestamp")
        p = e.get("payload") if isinstance(e.get("payload"), dict) else {}
        pt = p.get("type")
        blob = json.dumps(e)
        if pt == "user_message" and (jid in blob or "Background job" in blob):
            notice = notice or (ts, (p.get("message") or "")[:200])
        if pt == "task_started" and delivered_turn and p.get("turn_id") == delivered_turn:
            turn_started = turn_started or (ts, p.get("turn_id"))
        if pt == "task_complete" and delivered_turn and p.get("turn_id") == delivered_turn:
            turn_done = turn_done or (ts, p.get("turn_id"))
        if pt == "agent_message" and turn_started and not agent_reply:
            if notice and ts and notice[0] and ts >= notice[0]:
                agent_reply = (ts, (p.get("message") or "")[:200])

    def show(label, v):
        print("  %-18s %s" % (label, ("%s  %s" % (v[0], v[1])) if v else "NOT FOUND"))

    show("synthetic notice", notice)
    show("task_started", turn_started)
    show("task_complete", turn_done)
    show("agent reply", agent_reply)

    print()
    print("=" * 72)
    print("VERDICT")
    print("=" * 72)
    if notice and turn_done:
        print("  CONTROL PASSED: a separate process durably appended the completion")
        print("  turn to this thread (notice + matching task_complete present).")
        print()
        print("  The remaining question is what YOU saw on screen:")
        print("    - TUI showed nothing new while idle  -> confirms the gap; file it.")
        print("    - TUI rendered it live               -> STOP. Premise is wrong;")
        print("                                            investigate before filing.")
    else:
        print("  CONTROL FAILED: no complete appended turn found.")
        print("  'The TUI did not render it' proves nothing here, because the append")
        print("  itself did not demonstrably succeed. Check notification.status above")
        print("  (pending / failed / unavailable) and re-run the test.")


if __name__ == "__main__":
    main()
