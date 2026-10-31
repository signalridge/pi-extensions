import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type CompactionFailureCode, compactionFailure } from "./failure.js";

export const DIAGNOSTICS_COMMAND = "/codex-compact diagnostics";
export const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
const MAGIC = '{"format":"pi-codex-compact-diagnostics-v1"}\n';
const PHASES = [
  "auth",
  "payload",
  "fetch",
  "headers",
  "first_body",
  "wire_terminal",
  "provider_done",
  "completion_wait",
  "fold_done",
  "outcome",
] as const;
const SCOPES = ["none", "stage", "operation"] as const;
const TRIGGERS = ["manual", "threshold", "overflow", "recovery", "unknown"] as const;
const recent = new Map<string, DiagnosticEvent[]>();
const traces = new WeakSet<object>();
export function trustedDiagnosticTrace(value: DiagnosticTrace | undefined): DiagnosticTrace | undefined {
  return value && traces.has(value) ? value : undefined;
}
const OUTCOMES = ["running", "prepared", "exported", "failure", "cancelled"] as const;
export type DiagnosticPhase = (typeof PHASES)[number];
export type TimeoutScope = (typeof SCOPES)[number];
export interface DiagnosticEvent {
  readonly operation: string;
  readonly session: string;
  readonly trigger: (typeof TRIGGERS)[number];
  readonly phase: DiagnosticPhase;
  readonly lastPhase: DiagnosticPhase;
  readonly timestamp: number;
  readonly elapsedMs: number;
  readonly folds: number;
  readonly completed: number;
  readonly attempts: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly operationTimeoutMs: number;
  readonly stageTimeoutMs: number;
  readonly outcome: (typeof OUTCOMES)[number];
  readonly timeoutScope: TimeoutScope;
  readonly error: CompactionFailureCode | "none";
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly inputCost: number;
  readonly outputCost: number;
  readonly cacheReadCost: number;
  readonly cacheWriteCost: number;
  readonly totalCost: number;
}
const NUMBERS = [
  "timestamp",
  "elapsedMs",
  "folds",
  "completed",
  "attempts",
  "requestBytes",
  "responseBytes",
  "operationTimeoutMs",
  "stageTimeoutMs",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "totalTokens",
  "inputCost",
  "outputCost",
  "cacheReadCost",
  "cacheWriteCost",
  "totalCost",
] as const;
const KEYS = new Set<string>([
  "operation",
  "session",
  "trigger",
  "phase",
  "lastPhase",
  "outcome",
  "timeoutScope",
  "error",
  ...NUMBERS,
]);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export function validDiagnostic(value: unknown): value is DiagnosticEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === KEYS.size &&
    Object.keys(row).every((key) => KEYS.has(key)) &&
    typeof row.operation === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.operation) &&
    typeof row.session === "string" &&
    /^[a-f0-9]{64}$/.test(row.session) &&
    TRIGGERS.includes(row.trigger as DiagnosticEvent["trigger"]) &&
    PHASES.includes(row.phase as DiagnosticPhase) &&
    PHASES.includes(row.lastPhase as DiagnosticPhase) &&
    SCOPES.includes(row.timeoutScope as TimeoutScope) &&
    OUTCOMES.includes(row.outcome as DiagnosticEvent["outcome"]) &&
    (row.error === "none" ||
      (typeof row.error === "string" && compactionFailure(row.error as CompactionFailureCode).code === row.error)) &&
    NUMBERS.every((key) => finite(row[key]))
  );
}
export function sessionCorrelation(session: string): string {
  return createHash("sha256").update("pi-codex-compact-v1\0").update(session).digest("hex");
}
export function diagnosticsPath(): string {
  return join(getAgentDir(), "pi-codex-compact-diagnostics.jsonl");
}

async function readOwned(handle: Awaited<ReturnType<typeof open>>): Promise<DiagnosticEvent[] | undefined> {
  const stat = await handle.stat();
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > MAX_DIAGNOSTIC_BYTES
  )
    return;
  const buffer = Buffer.alloc(MAX_DIAGNOSTIC_BYTES + 1);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  if (bytesRead > MAX_DIAGNOSTIC_BYTES) return;
  const text = buffer.subarray(0, bytesRead).toString("utf8");
  if (!text.startsWith(MAGIC) || !text.endsWith("\n")) return;
  const rows: DiagnosticEvent[] = [];
  for (const line of text.slice(MAGIC.length).split("\n").filter(Boolean)) {
    const row: unknown = JSON.parse(line);
    if (!validDiagnostic(row)) return;
    rows.push(Object.freeze(row));
  }
  return rows;
}
// One bounded queue per runtime, never on the network/commit critical path.
let queue = Promise.resolve();
let queued = 0;
function append(row: DiagnosticEvent, path: string): void {
  if (queued >= 256) return;
  queued++;
  queue = queue
    .then(async () => {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let lock: Awaited<ReturnType<typeof open>> | undefined;
      let lockIdentity: { dev: number; ino: number } | undefined;
      const lockPath = `${path}.lock`;
      try {
        // Cross-process, non-waiting try-lock. Existing/stale/foreign locks
        // simply drop this diagnostic; never recover them by deleting them.
        lock = await open(
          lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          0o600,
        );
        lockIdentity = await lock.stat();
        try {
          handle = await open(
            path,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            0o600,
          );
          await handle.write(MAGIC);
          await handle.close();
          handle = undefined;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") return;
        }
        handle = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        if (!(await readOwned(handle))) return;
        const line = `${JSON.stringify(row)}\n`;
        if ((await handle.stat()).size + Buffer.byteLength(line) > MAX_DIAGNOSTIC_BYTES) return;
        await handle.write(line);
      } catch {
        /* Diagnostics never alter the operation outcome. */
      } finally {
        await handle?.close().catch(() => undefined);
        // No awaited/user callback seam between the ownership check and unlink.
        // A replaced path (including a symlink) is never ours to remove.
        if (lockIdentity) {
          try {
            const current = lstatSync(lockPath);
            if (
              current.isFile() &&
              current.nlink === 1 &&
              current.dev === lockIdentity.dev &&
              current.ino === lockIdentity.ino
            )
              unlinkSync(lockPath);
          } catch {
            /* Stale locks are safe: future writers skip persistence. */
          }
        }
        await lock?.close().catch(() => undefined);
      }
    })
    .catch(() => undefined)
    .finally(() => {
      queued--;
    });
}
export async function flushDiagnostics(): Promise<void> {
  await queue;
}
export async function readLastDiagnostic(session: string, path?: string): Promise<readonly DiagnosticEvent[]> {
  const cached = recent.get(sessionCorrelation(session));
  if (cached && path === undefined) return Object.freeze(cached.map((row) => Object.freeze({ ...row })));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readPersisted(session, path),
      new Promise<readonly DiagnosticEvent[]>((resolve) => {
        timer = setTimeout(() => resolve(Object.freeze([])), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function readPersisted(session: string, path?: string): Promise<readonly DiagnosticEvent[]> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path ?? diagnosticsPath(), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const rows = (await readOwned(handle))?.filter((row) => row.session === sessionCorrelation(session));
    const operation = rows?.at(-1)?.operation;
    return Object.freeze(rows?.filter((row) => row.operation === operation).slice(-128) ?? []);
  } catch {
    return Object.freeze([]);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
export interface DiagnosticTrace {
  phase(phase: DiagnosticPhase): void;
  fold(): void;
  attempt(): void;
  bytes(direction: "request" | "response", count: number): void;
  usage(usage: Usage): void;
  finish(
    outcome: Exclude<DiagnosticEvent["outcome"], "running">,
    error?: CompactionFailureCode,
    scope?: TimeoutScope,
  ): void;
  snapshot(): DiagnosticEvent;
}
export function createDiagnosticTrace(
  session: string,
  trigger: DiagnosticEvent["trigger"],
  options: {
    path?: string;
    observe?: (row: DiagnosticEvent) => void;
    signal?: AbortSignal;
    operationTimeoutMs?: number;
    stageTimeoutMs?: number;
  } = {},
): DiagnosticTrace {
  const start = performance.now();
  let path: string | undefined;
  try {
    path = options.path ?? diagnosticsPath();
  } catch {
    /* Persistence unavailable. */
  }
  const limits = { operationTimeoutMs: 900_000, stageTimeoutMs: 300_000 };
  for (const key of ["operationTimeoutMs", "stageTimeoutMs"] as const) {
    try {
      const value: unknown = options[key];
      if (finite(value)) limits[key] = value;
    } catch {
      /* Optional diagnostics metadata cannot break the operation. */
    }
  }
  let rows = 0;
  let finished = false;
  let finishing = false;
  let state: DiagnosticEvent = {
    operation: randomUUID(),
    session: sessionCorrelation(session),
    trigger: TRIGGERS.includes(trigger) ? trigger : "unknown",
    phase: "auth",
    lastPhase: "auth",
    timestamp: Date.now(),
    elapsedMs: 0,
    folds: 0,
    completed: 0,
    attempts: 0,
    requestBytes: 0,
    responseBytes: 0,
    ...limits,
    outcome: "running",
    timeoutScope: "none",
    error: "none",
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    totalCost: 0,
  };
  const emit = (phase: DiagnosticPhase) => {
    if (finished || (finishing && phase !== "outcome") || !PHASES.includes(phase)) return;
    state = {
      ...state,
      phase,
      lastPhase: phase === "outcome" ? state.lastPhase : phase,
      timestamp: Date.now(),
      elapsedMs: Math.max(0, performance.now() - start),
    };
    if (rows >= (phase === "outcome" ? 128 : 127)) return;
    const row = Object.freeze({ ...state });
    if (!validDiagnostic(row)) return;
    rows++;
    const previous = recent.get(row.session);
    if (!previous || previous.at(-1)?.operation !== row.operation) recent.set(row.session, []);
    recent.get(row.session)?.push(row);
    if (recent.size > 32) recent.delete(recent.keys().next().value as string);
    if (path) append(row, path);
    try {
      options.observe?.(Object.freeze({ ...row }));
    } catch {
      /* Disposable observer only. */
    }
  };
  const onAbort = () => trace.finish("cancelled");
  const trace: DiagnosticTrace = {
    phase: emit,
    fold: () => {
      if (!finished && !finishing) state = { ...state, folds: state.folds + 1 };
    },
    attempt: () => {
      if (!finished && !finishing) state = { ...state, attempts: state.attempts + 1 };
    },
    bytes: (direction, count) => {
      const key = direction === "request" ? "requestBytes" : "responseBytes";
      if (!finished && !finishing && finite(count) && finite(state[key] + count))
        state = { ...state, [key]: state[key] + count };
    },
    usage: (usage) => {
      if (finished || finishing) return;
      try {
        const next = { ...state, completed: state.completed + 1 };
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
          const value: unknown = usage[key];
          if (finite(value) && finite(next[key] + value)) next[key] += value;
        }
        const cost = usage.cost;
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
          const field = `${key}Cost` as "inputCost" | "outputCost" | "cacheReadCost" | "cacheWriteCost" | "totalCost";
          const value: unknown = cost[key];
          if (finite(value) && finite(next[field] + value)) next[field] += value;
        }
        if (!finished && !finishing) state = next;
      } catch {
        /* Never inspect provider exceptions. */
      }
    },
    finish: (outcome, error, timeoutScope = "none") => {
      if (finished || finishing) return;
      finishing = true;
      state = {
        ...state,
        outcome: OUTCOMES.includes(outcome) ? outcome : "failure",
        error: error === undefined ? "none" : compactionFailure(error).code,
        timeoutScope: SCOPES.includes(timeoutScope) ? timeoutScope : "none",
      };
      emit("outcome");
      finished = true;
      options.signal?.removeEventListener("abort", onAbort);
    },
    snapshot: () => Object.freeze({ ...state }),
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  traces.add(trace);
  return Object.freeze(trace);
}
export function diagnosticSummary(row: DiagnosticEvent): string {
  return `Last stage: ${row.lastPhase}; ${row.completed}/${row.folds} folds, ${row.attempts} HTTP attempts, ${Math.round(row.elapsedMs)} ms; timeout=${row.timeoutScope}, stage/total=${row.stageTimeoutMs}/${row.operationTimeoutMs} ms. See ${DIAGNOSTICS_COMMAND}.`;
}
