import { basename, resolve } from "node:path";

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_PREFIXES = new Set(["builtin", "command", "exec", "time"]);
const CONTROLLER_ACTIONS = new Set(["cancel", "config", "result", "rerun", "start", "status", "tail"]);
const NODE_LAUNCHER = "node";

function isOperatorStart(character) {
  return "&|;()<>\n".includes(character);
}

/**
 * Tokenize enough POSIX shell syntax for hook policy decisions.
 *
 * This is not a shell evaluator. It preserves command boundaries, quoted word
 * values, and incomplete words while treating all other input as inert data.
 */
export function lexShell(command) {
  const text = String(command ?? "");
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\" && text[index + 1] === "\n") {
      index += 2;
      continue;
    }
    if (character === "\n") {
      tokens.push({ type: "operator", value: "\n" });
      index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "#") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (isOperatorStart(character)) {
      const pair = text.slice(index, index + 2);
      if (["&&", "||", "<<", ">>"].includes(pair)) {
        tokens.push({ type: pair.includes("<") || pair.includes(">") ? "redirect" : "operator", value: pair });
        index += 2;
      } else if (character === "<" || character === ">") {
        tokens.push({ type: "redirect", value: character });
        index += 1;
      } else {
        tokens.push({ type: "operator", value: character });
        index += 1;
      }
      continue;
    }

    let value = "";
    let quoted = false;
    let complete = true;
    while (index < text.length) {
      const current = text[index];
      if (current === "\n" || /\s/.test(current) || isOperatorStart(current)) break;
      if (current === "\\") {
        if (index + 1 >= text.length) {
          complete = false;
          index += 1;
          break;
        }
        value += text[index + 1];
        index += 2;
        continue;
      }
      if (current === "'" || current === '"') {
        const quote = current;
        quoted = true;
        index += 1;
        let closed = false;
        while (index < text.length) {
          const inner = text[index];
          if (inner === quote) {
            closed = true;
            index += 1;
            break;
          }
          if (quote === '"' && inner === "\\" && index + 1 < text.length) {
            value += text[index + 1];
            index += 2;
          } else {
            value += inner;
            index += 1;
          }
        }
        if (!closed) complete = false;
        continue;
      }
      value += current;
      index += 1;
    }
    tokens.push({ type: "word", value, quoted, complete });
  }
  return tokens;
}

export function commandSegments(tokens) {
  const segments = [];
  let words = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.type === "operator" && token.value === "(") depth += 1;
    if (token.type === "operator" && token.value === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && token.type === "operator" && ["&&", "||", ";", "\n", "|", "&"].includes(token.value)) {
      if (words.length) segments.push({ words, separator: token.value });
      words = [];
      continue;
    }
    if (token.type === "word") words.push(token);
  }
  if (words.length) segments.push({ words, separator: null });
  return segments;
}

/**
 * Return the words that form a shell command after assignments and harmless
 * shell prefixes. The returned values are decoded shell words, not source text.
 */
export function commandWords(segment) {
  const words = segment.words.map((token) => token.value);
  let index = 0;
  for (;;) {
    while (ASSIGNMENT.test(words[index] ?? "")) index += 1;
    if (SHELL_PREFIXES.has(basename(words[index] ?? ""))) {
      index += 1;
      continue;
    }
    if (basename(words[index] ?? "") === "env") {
      index += 1;
      continue;
    }
    break;
  }
  return words.slice(index);
}

function controllerPathMatches(candidate, controllerPath, cwd) {
  if (!controllerPath || !candidate) return false;
  try {
    const base = cwd ?? process.cwd();
    return resolve(base, candidate) === resolve(base, controllerPath);
  } catch {
    return false;
  }
}

function parseControllerInvocation(words, { controllerPath, cwd } = {}) {
  if (!words.length) return null;
  const executable = basename(words[0] ?? "");
  let scriptIndex = null;
  if (controllerPathMatches(words[0], controllerPath, cwd)) {
    scriptIndex = 0;
  } else if (executable === NODE_LAUNCHER && controllerPathMatches(words[1], controllerPath, cwd)) {
    scriptIndex = 1;
  } else {
    return null;
  }

  const action = words[scriptIndex + 1] ?? "";
  if (!CONTROLLER_ACTIONS.has(action)) return null;
  return {
    action,
    args: words.slice(scriptIndex + 2),
    controllerIndex: scriptIndex,
    command: words.slice(0, scriptIndex + 1),
  };
}

/**
 * Parse shell command boundaries and identify invocations of the exact CPJ
 * controller path. A controller path in an argument to printf, echo, or an
 * unrelated script is not a controller invocation.
 */
export function parseShellCommand(command, { controllerPath = null, cwd = process.cwd() } = {}) {
  const tokens = lexShell(command);
  const complete = tokens.every((token) => token.complete !== false);
  const segments = commandSegments(tokens).map((segment) => {
    const words = segment.words.map((token) => token.value);
    const normalizedWords = commandWords(segment);
    return {
      ...segment,
      words,
      commandWords: normalizedWords,
      controller: complete ? parseControllerInvocation(normalizedWords, { controllerPath, cwd }) : null,
    };
  });
  return { tokens, segments, complete };
}

export function controllerInvocations(command, options = {}) {
  return parseShellCommand(command, options).segments
    .map((segment) => segment.controller)
    .filter(Boolean);
}
