#!/usr/bin/env node

import { basename, dirname, resolve } from "node:path";
import { readSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isCliEntry } from "../scripts/cli-entry.mjs";
import { lexShell, parseShellCommand } from "../scripts/cpj-command.mjs";
import { isSpawnedSubagentThread, resolveHookThreadId } from "../scripts/session.mjs";
import { listJobs } from "../scripts/state.mjs";

export { lexShell } from "../scripts/cpj-command.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JOB_CONTROLLER = resolve(PLUGIN_ROOT, "scripts", "job.mjs");
const FOREGROUND_MARKER = /^\s*#\s*cpj:foreground(?:\s|$)/i;
const HELP_OR_VERSION = new Set(["-h", "--help", "-V", "--version", "version"]);

// These commands are ordinarily bounded inspections or tiny shell operations.
// Everything unfamiliar is challenged so arbitrary inference programs, downloads,
// model converters, and project-specific wrappers do not need to be named here.
const OBVIOUSLY_SHORT = new Set([
  ":", "[", "awk", "basename", "cd", "cksum", "cmp", "comm", "cut", "date",
  "disown",
  "df", "dirname", "echo", "expr", "false", "file",
  "getconf", "grep", "groups", "head", "hostname", "id", "jq", "ls", "md5",
  "md5sum", "paste", "pathchk", "printenv", "printf", "pwd", "readlink",
  "realpath", "rg", "sed", "shasum", "sha256sum", "sort", "stat", "test",
  "tr", "true", "type", "uname", "uniq", "wc", "which", "whoami",
  "yq",
]);

const SIMPLE_FILE_OPERATIONS = new Set(["chmod", "chown", "cp", "install", "ln", "mkdir", "mv", "rm", "rmdir", "touch"]);
const RECURSIVE_OR_BULK_FLAGS = /^(?:-[^-]*[Rr][^-]*|-a|--archive|--recursive|--parents|--remove-destination)$/;
const INTERACTIVE_OR_PERSISTENT = new Set([
  "bash", "btop", "dash", "emacs", "fish", "htop", "less", "more", "nano",
  "nvim", "sh", "ssh", "top", "vi", "vim", "watch", "zsh",
]);

function isHelpOrVersion(words) {
  return words.slice(1).some((word) => HELP_OR_VERSION.has(word));
}

function isReadOnlyGit(words) {
  if (basename(words[0] ?? "") !== "git") return false;
  let index = 1;
  while (/^-(?:C|c)$/.test(words[index] ?? "") && words[index + 1]) index += 2;
  while (/^--(?:git-dir|work-tree|namespace)=/.test(words[index] ?? "")) index += 1;
  return new Set(["branch", "config", "diff", "grep", "log", "ls-files", "remote", "rev-parse", "show", "status", "tag", "worktree"])
    .has(words[index] ?? "");
}

function isQuickSleep(words) {
  if (basename(words[0] ?? "") !== "sleep" || words.length !== 2) return false;
  const seconds = Number.parseFloat(words[1]);
  return Number.isFinite(seconds) && seconds <= 5;
}

function isClearlyPersistent(words) {
  const executable = basename(words[0] ?? "");
  if (["bash", "dash", "fish", "sh", "zsh"].includes(executable)) {
    return words.length === 1 || words.includes("-i") || words.includes("--interactive");
  }
  if (INTERACTIVE_OR_PERSISTENT.has(executable)) return true;
  if (executable === "tail" && words.slice(1).some((word) => word === "-f" || word === "--follow" || /^-[^-]*f/.test(word))) return true;
  if (executable === "journalctl" && words.slice(1).some((word) => word === "-f" || word === "--follow")) return true;
  if (["npm", "pnpm", "yarn", "bun"].includes(executable) && words.slice(1).some((word) => /^(?:dev|serve|start|watch)$/.test(word))) return true;
  if (executable === "docker" && words[1] === "compose" && words[2] === "up" && !words.includes("-d") && !words.includes("--detach")) return true;
  if (executable === "kubectl" && (words.includes("port-forward") || words.includes("-f") || words.includes("--follow"))) return true;
  return false;
}

function isObviouslyShort(words) {
  const executable = basename(words[0] ?? "");
  if (!executable) return true;
  if (isHelpOrVersion(words) || isReadOnlyGit(words) || isQuickSleep(words)) return true;
  if (OBVIOUSLY_SHORT.has(executable)) return true;
  if (SIMPLE_FILE_OPERATIONS.has(executable)) {
    return !words.slice(1).some((word) => RECURSIVE_OR_BULK_FLAGS.test(word));
  }
  return false;
}

function alreadyDetached(tokens) {
  return tokens.some((token, index) => {
    if (token.type !== "operator" || token.value !== "&") return false;
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    return previous?.type !== "redirect" && next?.type !== "redirect";
  });
}

export function classifyCommand(command, {
  allowForegroundEscape = true,
  cwd = process.cwd(),
  parsed = null,
} = {}) {
  if (allowForegroundEscape && (FOREGROUND_MARKER.test(command) || /^\s*CPJ_FOREGROUND=1(?:\s|$)/.test(command))) {
    return { decision: "allow", reason: "explicit-foreground" };
  }
  const parsedCommand = parsed ?? parseShellCommand(command, { controllerPath: JOB_CONTROLLER, cwd });
  const { tokens } = parsedCommand;
  if (!tokens.length || !parsedCommand.complete) return { decision: "allow", reason: "unparseable" };
  if (alreadyDetached(tokens)) return { decision: "allow", reason: "already-detached" };
  const segments = parsedCommand.segments;
  if (!segments.length) return { decision: "allow", reason: "empty" };

  let sawPersistent = false;
  for (const segment of segments) {
    const words = segment.commandWords;
    if (!words.length || segment.controller) continue;
    if (isClearlyPersistent(words)) {
      sawPersistent = true;
      continue;
    }
    if (!isObviouslyShort(words)) return { decision: "challenge", reason: "duration-uncertain" };
  }
  return { decision: "allow", reason: sawPersistent ? "interactive-or-persistent" : "obviously-short" };
}

function sameTurnLaunchBoundary(input, parsed, list = listJobs, env = process.env) {
  const sessionId = resolveHookThreadId(input, env) ?? "";
  const turnId = typeof input?.turn_id === "string" ? input.turn_id : "";
  if (!sessionId || !turnId) return null;

  let jobs;
  try {
    jobs = list().filter((job) =>
      (job.launchThreadId ?? job.ownerThreadId) === sessionId
      && job.notification?.launchBoundaryTurnId === turnId
    );
  } catch {
    return null;
  }
  if (!jobs.length) return null;

  const launchedIds = new Set(jobs.map((job) => job.id));
  const { tokens } = parsed;
  if (!tokens.length || !parsed.complete) return null;

  for (const segment of parsed.segments) {
    const invocation = segment.controller;
    if (!invocation || !new Set(["status", "tail", "result"]).has(invocation.action)) continue;
    const referencedIds = invocation.args.filter((arg) => /^job-[a-z0-9][a-z0-9-]{2,76}$/.test(arg));
    if (referencedIds.length === 0 || referencedIds.some((id) => launchedIds.has(id))) {
      return { jobs, reason: `same-turn-${invocation.action}` };
    }
  }

  if (/(?:^|[\/])MEMORY\.md(?:\s|$)|[\/]memories[\/]/i.test(input.tool_input.command)) {
    return { jobs, reason: "same-turn-memory" };
  }
  return null;
}

export function evaluateHook(input, {
  list = listJobs,
  isSubagent = isSpawnedSubagentThread,
  env = process.env,
} = {}) {
  if (input?.hook_event_name !== "PreToolUse" || input?.tool_name !== "Bash") return null;
  const command = input?.tool_input?.command;
  if (typeof command !== "string") return null;
  const cwd = input?.cwd ?? process.cwd();
  const parsed = parseShellCommand(command, { controllerPath: JOB_CONTROLLER, cwd });
  const boundary = sameTurnLaunchBoundary(input, parsed, list, env);
  if (boundary) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Codex Process Jobs blocked ${boundary.reason === "same-turn-memory" ? "a CPJ memory search" : "same-turn monitoring"} after launching ${boundary.jobs.map((job) => job.id).join(", ")}. `
          + "A successful CPJ start is an absolute launch-turn release boundary, including when the user requested an eventual completion summary. "
          + "Report the launch and end this turn. Completion delivery or a later user-initiated turn will inspect and summarize the saved result. "
          + "The `# cpj:foreground` marker cannot override this boundary.",
      },
    };
  }
  let spawnedSubagent = false;
  try {
    spawnedSubagent = isSubagent(resolveHookThreadId(input, env), env);
  } catch {}
  if (spawnedSubagent) {
    const { tokens } = parsed;
    const childControllerLaunch = tokens.length > 0
      && parsed.complete
      && parsed.segments.some((segment) => {
        const invocation = segment.controller;
        return invocation && new Set(["start", "rerun"]).has(invocation.action);
      });
    if (childControllerLaunch) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Codex Process Jobs does not let a spawned subagent own a process job. "
            + "This controller launch was blocked before it created or reran a job. Do not execute, launch, retry, wait for, or monitor the workload in this subagent. "
            + "Return the exact intended workload to the user-visible parent and state that the parent must launch it once through CPJ itself, report the job ID, and end the parent turn. "
            + "Report this as a routing handoff, not as a workload failure.",
        },
      };
    }
  }
  const unescapedClassification = classifyCommand(command, {
    allowForegroundEscape: false,
    cwd,
    parsed,
  });
  if (unescapedClassification.decision === "challenge" && spawnedSubagent) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "Codex Process Jobs blocked local process execution inside a spawned subagent. "
          + "Do not execute, launch, retry, wait for, or monitor this workload in the subagent, and do not add `# cpj:foreground` or `CPJ_FOREGROUND=1`. "
          + "Return the exact intended workload to the user-visible parent and state that the parent must classify and launch it once through CPJ when eligible, report the job ID, and end the parent turn. "
          + "Report this as a routing handoff, not as a workload failure.",
      },
    };
  }
  const classification = classifyCommand(command, { cwd, parsed });
  if (classification.decision !== "challenge") return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "Codex Process Jobs paused this nontrivial local command before foreground execution. "
        + "Use the enabled CPJ start skill to classify the underlying workload. If it is finite and may exceed 60 seconds or has uncertain duration, launch it through CPJ and release the turn. "
        + "If it is clearly quick or excluded, retry with `# cpj:foreground` on its own first line. Do not escape merely because the command is unfamiliar.",
    },
  };
}

function readStdin() {
  const chunks = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.alloc(64 * 1024);
    const bytesRead = readSync(0, chunk, 0, chunk.length);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > MAX_INPUT_BYTES) return null;
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function main() {
  try {
    const raw = readStdin();
    if (raw === null) return;
    const decision = evaluateHook(JSON.parse(raw));
    if (decision) process.stdout.write(`${JSON.stringify(decision)}\n`);
  } catch {
    // This adoption guard fails open on malformed or unexpected input.
  }
}

if (isCliEntry(import.meta.url)) main();
