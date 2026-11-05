import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

// An unconfirmed process remains owned by its actual handle. Never signal a
// saved PID or allow an equivalent invocation to replace it while still alive.
const unconfirmed = new Map<string, Set<ChildProcessWithoutNullStreams>>();
const TERM_GRACE_MS = 250;
const CONFIRMATION_MS = 1_000;
const INVENTORY_MAX_BYTES = 8 * 1024 * 1024;

type SignalAttempt = { signal: NodeJS.Signals; accepted: boolean; error?: Error };

/** Captured diagnostics without inventing an exit code for an unconfirmed process. */
export class GitInputError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly reason: string;
  readonly terminationConfirmed: boolean;
  readonly signals: readonly SignalAttempt[];
  readonly truncated: boolean;

  constructor(
    message: string,
    stdout: string,
    stderr: string,
    reason: string,
    terminationConfirmed: boolean,
    signals: readonly SignalAttempt[],
    cause?: Error,
    truncated = false,
  ) {
    super(message, { cause });
    this.name = "GitInputError";
    this.stdout = stdout;
    this.stderr = stderr;
    this.reason = reason;
    this.terminationConfirmed = terminationConfirmed;
    this.signals = [...signals];
    this.truncated = truncated;
  }
}

function retainUntilExit(key: string, child: ChildProcessWithoutNullStreams): void {
  let owners = unconfirmed.get(key);
  if (!owners) {
    owners = new Set();
    unconfirmed.set(key, owners);
  }
  owners.add(child);
  const release = () => {
    owners.delete(child);
    if (owners.size === 0 && unconfirmed.get(key) === owners) unconfirmed.delete(key);
    child.removeListener("exit", release);
    child.removeListener("close", release);
  };
  child.once("exit", release);
  child.once("close", release);
  if (child.exitCode !== null || child.signalCode !== null) release();
}

export function runGitInput(
  args: string[],
  cwd: string,
  input: string,
  signal?: AbortSignal,
  timeout = 15_000,
  maxBuffer = INVENTORY_MAX_BYTES,
): Promise<ExecResult> {
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 0) {
    return Promise.reject(new RangeError("maxBuffer must be a nonnegative safe integer"));
  }
  const key = JSON.stringify([cwd, args]);
  const previous = unconfirmed.get(key);
  if (previous) {
    for (const child of previous) {
      if (child.exitCode === null && child.signalCode === null) {
        return Promise.reject(
          new Error("Previous Git termination is unconfirmed. Check the owned Git process and retry after it exits."),
        );
      }
    }
    unconfirmed.delete(key);
  }
  if (signal?.aborted) return Promise.resolve({ stdout: "", stderr: "", code: 1, killed: true, truncated: false });
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let truncated = false;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let settled = false;
    let stopping = false;
    let reason = "";
    let failure: Error | undefined;
    const signals: SignalAttempt[] = [];
    const capturedFailure = (message: string, confirmed: boolean, cause?: Error) =>
      new GitInputError(message, stdout, stderr, reason, confirmed, signals, cause, truncated);
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let confirmation: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(deadline);
      clearTimeout(escalation);
      clearTimeout(confirmation);
      signal?.removeEventListener("abort", abort);
      child.removeListener("error", error);
      child.removeListener("close", close);
      child.stdin.removeListener("error", inputError);
      child.stdout.removeListener("data", output);
      child.stderr.removeListener("data", diagnostics);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const finish = (result?: ExecResult, error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const sendSignal = (name: NodeJS.Signals) => {
      try {
        const accepted = child.kill(name);
        signals.push({ signal: name, accepted });
        if (!accepted) failure ??= new Error(`Git did not accept ${name}.`);
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        signals.push({ signal: name, accepted: false, error: cause });
        failure ??= cause;
      }
    };
    const stop = (why: string) => {
      if (settled || stopping) return;
      stopping = true;
      reason = why;
      clearTimeout(deadline);
      sendSignal("SIGTERM");
      escalation = setTimeout(() => {
        if (settled) return;
        sendSignal("SIGKILL");
        confirmation = setTimeout(() => {
          if (settled) return;
          retainUntilExit(key, child);
          finish(
            undefined,
            capturedFailure(
              `Git termination could not be confirmed after ${reason}. Check the owned Git process before retrying.${failure ? ` ${failure.message}` : ""}`,
              false,
              failure,
            ),
          );
        }, CONFIRMATION_MS);
      }, TERM_GRACE_MS);
    };
    const abort = () => stop("cancellation");
    const error = (value: Error) => {
      failure = value;
      if (child.pid === undefined) finish(undefined, capturedFailure(value.message, true, value));
      else stop("process failure");
    };
    const inputError = (value: NodeJS.ErrnoException) => {
      if (value.code !== "EPIPE") error(value);
    };
    // Count raw bytes across BOTH pipes, including fragmented UTF-8 code points.
    // Once full, keep draining without retaining output until the owned child closes.
    const capture = (chunk: Buffer, decoder: StringDecoder): string => {
      if (truncated) return "";
      const retained = chunk.subarray(0, Math.max(0, maxBuffer - capturedBytes));
      capturedBytes += retained.length;
      const text = decoder.write(retained);
      if (retained.length < chunk.length) {
        truncated = true;
        stop(`output overflow (${maxBuffer} bytes)`);
      }
      return text;
    };
    const output = (chunk: Buffer) => {
      stdout += capture(chunk, stdoutDecoder);
    };
    const diagnostics = (chunk: Buffer) => {
      stderr += capture(chunk, stderrDecoder);
    };
    const close = (code: number | null, closeSignal: NodeJS.Signals | null) => {
      // Do not synthesize a replacement character for a code point cut by the cap.
      if (!truncated) {
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
      }
      finish(
        {
          stdout,
          stderr,
          code: truncated ? code || 1 : (code ?? 1),
          killed: stopping || closeSignal !== null,
          truncated,
        },
        failure ? capturedFailure(failure.message, true, failure) : undefined,
      );
    };
    const deadline = setTimeout(() => stop(`${timeout}ms timeout`), timeout);
    child.stdout.on("data", output);
    child.stderr.on("data", diagnostics);
    child.stdin.on("error", inputError);
    child.once("error", error);
    child.once("close", close);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.end(input);
  });
}
