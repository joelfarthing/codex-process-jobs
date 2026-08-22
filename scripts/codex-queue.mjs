import process from "node:process";
import { spawn } from "node:child_process";

const MAX_QUEUE_OUTPUT_BYTES = 64 * 1024;
const MAX_QUEUE_TIMEOUT_MS = 30_000;

function queueError(message, { accepted = false, threadId = null } = {}) {
  const error = new Error(message);
  error.turnAccepted = accepted;
  error.transport = "codex-queue";
  error.threadId = threadId;
  return error;
}

function notificationMessage(input) {
  if (
    !Array.isArray(input)
    || input.length !== 1
    || input[0]?.type !== "text"
    || typeof input[0].text !== "string"
    || input[0].text.length === 0
  ) {
    throw queueError("Codex queue notification input must contain exactly one non-empty text item.");
  }
  return input[0].text;
}

function boundedOutput(buffer, length) {
  return buffer.subarray(0, length).toString("utf8").trim();
}

export async function enqueueCodexNotification(
  input,
  threadId,
  timeoutMs,
  env = process.env,
  { onUnavailable = () => {} } = {},
) {
  if (env.CODEX_PROCESS_JOBS_DISABLE_CODEX_QUEUE === "1") {
    return null;
  }

  const codex = env.CODEX_PROCESS_JOBS_CODEX_BIN || "codex";
  const message = notificationMessage(input);
  const boundedTimeoutMs = Math.min(timeoutMs, MAX_QUEUE_TIMEOUT_MS);

  return await new Promise((resolve, reject) => {
    const child = spawn(codex, [
      "queue",
      "--thread",
      threadId,
      "--message",
      message,
    ], {
      env: { ...env, CODEX_PROCESS_JOBS_NOTIFICATION_RELAY: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let settled = false;
    let stdoutLength = 0;
    let stderrLength = 0;
    const stdoutBuffer = Buffer.allocUnsafe(MAX_QUEUE_OUTPUT_BYTES);
    const stderrBuffer = Buffer.allocUnsafe(MAX_QUEUE_OUTPUT_BYTES);

    const timeout = setTimeout(() => {
      finish(reject, queueError(
        `Codex queue did not acknowledge the completion message within ${boundedTimeoutMs}ms.`,
        { accepted: true, threadId },
      ));
    }, boundedTimeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", onStdoutData);
      child.stderr.off("data", onStderrData);
      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGTERM");
        const forceKill = setTimeout(() => {
          if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
        }, 1_000);
        forceKill.unref();
        child.once("exit", () => clearTimeout(forceKill));
      }
    }

    function finish(handler, value) {
      if (settled) return;
      settled = true;
      cleanup();
      handler(value);
    }

    function capture(chunk, target, currentLength, label) {
      if (currentLength + chunk.length > MAX_QUEUE_OUTPUT_BYTES) {
        finish(reject, queueError(
          `Codex queue ${label} exceeded ${MAX_QUEUE_OUTPUT_BYTES} bytes before delivery was acknowledged.`,
          { accepted: true, threadId },
        ));
        return currentLength;
      }
      chunk.copy(target, currentLength);
      return currentLength + chunk.length;
    }

    function onStdoutData(chunk) {
      stdoutLength = capture(chunk, stdoutBuffer, stdoutLength, "stdout");
    }

    function onStderrData(chunk) {
      stderrLength = capture(chunk, stderrBuffer, stderrLength, "stderr");
    }

    child.stdout.on("data", onStdoutData);
    child.stderr.on("data", onStderrData);
    child.on("error", (error) => {
      if (settled) return;
      const reason = error?.code === "ENOENT"
        ? `Codex queue is unavailable because ${codex} was not found.`
        : `Unable to start Codex queue: ${error.message}`;
      settled = true;
      clearTimeout(timeout);
      onUnavailable(reason);
      resolve(null);
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      if (code === 0) {
        finish(resolve, {
          threadId,
          turnId: null,
          status: "accepted",
          transport: "codex-queue",
        });
        return;
      }
      if (signal) {
        finish(reject, queueError(
          `Codex queue exited by signal ${signal} before delivery could be confirmed.`,
          { accepted: true, threadId },
        ));
        return;
      }
      const stderr = boundedOutput(stderrBuffer, stderrLength);
      const stdout = boundedOutput(stdoutBuffer, stdoutLength);
      const detail = stderr || stdout;
      const reason = `Codex queue is unavailable (exit ${code})${detail ? `: ${detail}` : "."}`;
      settled = true;
      clearTimeout(timeout);
      onUnavailable(reason);
      resolve(null);
    });
  });
}
