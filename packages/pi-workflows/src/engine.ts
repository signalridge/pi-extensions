/**
 * engine.ts — script-driven workflow engine.
 *
 * A workflow is a raw JavaScript module (see runtime.ts). This engine owns the
 * durable side: it journals the script (`run_created` with script text, hash,
 * and meta), dispatches each live `agent()` call through the spawn-managed
 * protocol with A4 generation-rotated spawn keys, persists every completed
 * call as a `call_result` fact (the resume journal source), and exposes
 * list/get/pause/resume/stop control plus branch-change quiescence and
 * session-tree restore.
 *
 * Resume semantics: the engine rebuilds the runtime's resume journal from
 * journaled call_result events, re-runs the script with the SAME runId, and
 * the runtime replays the longest unchanged prefix from cache while calls at
 * or after the first hash miss run live. Live dispatches of a previously
 * journaled call index rotate the spawnKey generation (A4), so an edited
 * script never collides with pi-subagents' fingerprint tombstone.
 */

import { createHash, randomUUID } from "node:crypto";
import type { ManagedSpawnResponse } from "@signalridge/pi-subagents-protocol";
import { isManagedAgentTier } from "@signalridge/pi-subagents-protocol";
import { WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js";
import {
  buildResumeJournal,
  type CallResult,
  type CallTierIdentity,
  deriveRecoveryId,
  JOURNAL_ENTRY_TYPE,
  JOURNAL_SCHEMA_VERSION,
  type JournalEvent,
  type JournalWriter,
  type RecoveryTerminalResult,
  replayJournal,
  type ScriptRun,
  type SessionEntryLike,
  snapshotRun,
  type TerminalRecoveryEvent,
  type WorkflowOwner,
} from "./journal.js";
import {
  createManagedSpawnClient,
  type DispatchTask,
  type ManagedProtocolCheck,
  type ManagedSpawnClient,
  type WorkflowEventBus,
} from "./rpc-client.js";
import {
  type AgentRunOptions,
  type AgentUsage,
  type JournalEntry,
  MAX_AGENTS_PER_RUN,
  normalizeAgentRetries,
  normalizeAgentTimeout,
  normalizeConcurrency,
  normalizeMaxAgents,
  normalizeTokenBudget,
  parseWorkflowScript,
  runWorkflow,
  type WorkflowAgentRunner,
  type WorkflowRunResult,
  type WorkflowRuntimeEvent,
} from "./runtime.js";

export const MAX_ATTEMPTS_PER_NODE = 3;

const BRANCH_QUIESCE_TIMEOUT_MS = 8_000;
const MAX_WAITERS = 256;
const JOURNAL_RETRY_INITIAL_DELAY_MS = 25;
const JOURNAL_RETRY_MAX_DELAY_MS = 2_000;
const JOURNAL_RETRY_MAX_ATTEMPTS = 8;
const PROVIDER_RETRY_DEFAULT_MS = 60_000;
const PROVIDER_RETRY_MAX_MS = 24 * 60 * 60 * 1_000;

class JournalAppendError extends Error {
  constructor(kind: string, cause: unknown) {
    super(`journal append failed for ${kind}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "JournalAppendError";
  }
}

export type WorkflowQuiesceResult = { settled: boolean; pending: string[]; diagnostic?: string };

export interface ScriptStartOptions {
  args?: unknown;
  background?: boolean;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  tokenBudget?: number | null;
  /** True for a script this package ships; see WorkflowRunOptions.shippedScript. */
  shippedScript?: boolean;
  agentTimeoutMs?: number | null;
  toolset?: string;
  excludeTools?: string[];
  signal?: AbortSignal;
  /** Foreground human confirmation for checkpoint() — absent in headless runs. */
  confirm?: (
    promptText: string,
    options: {
      default?: unknown;
      headless?: "default" | "abort";
      kind?: "confirm" | "input" | "select";
      choices?: string[];
      timeoutMs?: number;
    },
  ) => Promise<unknown>;
  /**
   * Resolve a nested `workflow(name)` reference. The result reports whether the
   * script it returned ships with this package, because that decides how the
   * child frame treats a tier name the host does not define — see
   * `WorkflowRunOptions.shippedScript`.
   */
  loadSavedWorkflow?: (name: string) => { script: string; shippedScript?: boolean } | undefined;
  mainModel?: string;
}

export interface ScriptStartResult {
  runId: string;
  status: string;
  background: boolean;
  result?: string;
  error?: string;
  waitAborted?: boolean;
}

interface AgentLifecycleWaiter {
  callIndex: string;
  generation: number;
  onUsage?: (usage: AgentUsage) => void;
  onHistory?: (history: unknown[]) => void;
  executionGeneration: number;
  resolve: (response: ManagedSpawnResponse) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

interface AgentTerminalDelivery {
  response: ManagedSpawnResponse;
  usage?: AgentUsage;
  history?: unknown[];
}

interface BufferedAgentTerminal extends AgentTerminalDelivery {
  owner: WorkflowOwner;
  executionGeneration: number;
}

export interface ScriptRunState {
  run: ScriptRun;
  /** Frozen run parameters — resume reuses the original values, ignoring new budget/toolset overrides. */
  frozenOptions: Pick<
    ScriptStartOptions,
    | "tokenBudget"
    | "maxAgents"
    | "concurrency"
    | "agentRetries"
    | "agentTimeoutMs"
    | "toolset"
    | "shippedScript"
    | "excludeTools"
  >;
  /** Abort controller for this run's script execution. */
  controller: AbortController;
  /** The in-flight runWorkflow promise, or undefined before start/after settle. */
  execution?: Promise<WorkflowRunResult<unknown>>;
  /** Monotonic execution generation; stale pause/resume continuations cannot mutate a newer run. */
  executionGeneration: number;
  /** The script's final return value, captured when the run settles. */
  result?: unknown;
  /** Per-call-index generation base for A4 spawnKey rotation (seeded from journal). */
  generations: Map<string, number>;
  /** Resolved tier identity for live calls, including stopped terminal results. */
  callTiers: Map<string, CallTierIdentity>;
  /** Live dispatch waiters keyed by agent id. */
  agentWaiters: Map<string, AgentLifecycleWaiter>;
  /** Owner-validated terminal events emitted before their spawn reply/waiter. */
  bufferedTerminals: Map<string, BufferedAgentTerminal>;
  /** Allocations whose managed-spawn reply has not arrived yet. */
  pendingSpawns: Map<string, { spawnKey: string; owner: WorkflowOwner; executionGeneration: number }>;
  /** Journal retry bookkeeping. */
  pendingJournal: Set<string>;
  /** Whether a lifecycle suspension is in effect (branch change). */
  lifecycleSuspended: boolean;
}

function isTerminalWorkflow(status: string): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

function managedTerminalStatus(snapshot: { status: string }): "completed" | "failed" | "stopped" {
  return snapshot.status === "completed" ? "completed" : snapshot.status === "failed" ? "failed" : "stopped";
}

function updateCallTierIdentity(state: ScriptRunState, nodeId: string, tier: unknown): boolean {
  if (!isManagedAgentTier(tier)) return false;
  if (state.callTiers.get(nodeId)?.tier === tier) return false;
  const identity: CallTierIdentity = { tier };
  state.callTiers.set(nodeId, identity);
  state.run.callTiers[nodeId] = identity;
  return true;
}

function callIndexFromOwnerNode(nodeId: string): string | undefined {
  return nodeId.startsWith("call-") ? nodeId.slice("call-".length) : undefined;
}

function renderWorkflowValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function cloneWorkflowValue(value: unknown, label: string): unknown {
  if (value === undefined) return undefined;
  try {
    const cloned = structuredClone(value);
    const serialized = JSON.stringify(cloned);
    if (serialized === undefined) throw new Error("value is not JSON-serializable");
    if (serialized.length > 200_000) {
      throw new Error("value exceeds the 200000-character workflow persistence limit");
    }
    return cloned;
  } catch (error: unknown) {
    throw new WorkflowError(
      `${label} must be structured-cloneable and JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false, details: error },
    );
  }
}

function cloneWorkflowArgs(value: unknown): unknown {
  return cloneWorkflowValue(value, "Workflow args");
}

function cloneWorkflowResult(value: unknown): unknown {
  return cloneWorkflowValue(value, "Workflow result");
}

function cloneRuntimeEvent(event: WorkflowRuntimeEvent): WorkflowRuntimeEvent {
  return structuredClone(event);
}

function resultFromLifecycle(
  status: "completed" | "failed" | "stopped",
  agentId: string | undefined,
  result: string | undefined,
  error: string | undefined,
  compactionCount: number,
  tokenCount?: number,
  tier?: string,
): CallResult {
  return {
    status,
    ...(agentId ? { agentId } : {}),
    ...(tier === undefined ? {} : { tier }),
    ...(result !== undefined && result.length > 0 ? { result } : {}),
    ...(error !== undefined && error.length > 0 ? { error } : {}),
    ...(tokenCount !== undefined ? { tokenCount } : {}),
    compactionCount,
    updatedAt: Date.now(),
  };
}

/** Parse a journaled attemptId of the form `<runId>/<nodeId>/attempt-<generation>`. */
function generationFromAttemptId(attemptId: string | undefined): number {
  if (!attemptId) return 0;
  const match = /\/attempt-(\d+)$/u.exec(attemptId);
  return match ? Number(match[1]) : 0;
}

function sameWorkflowOwner(left: WorkflowOwner, right: WorkflowOwner): boolean {
  return (
    left.extension === right.extension &&
    left.runId === right.runId &&
    left.nodeId === right.nodeId &&
    left.attemptId === right.attemptId
  );
}

export class WorkflowEngine {
  private readonly runs = new Map<string, ScriptRunState>();
  /** Fired when a run settles terminal; wired by the UI surface for widget refresh. */
  onRunSettled: (() => void) | undefined;
  /** Optional in-process observer for phase/task/quality runtime events. */
  onRuntimeEvent: ((runId: string, event: WorkflowRuntimeEvent) => void) | undefined;
  private readonly waiters = new Map<
    string,
    Set<{ resolve: (run: ScriptRun) => void; reject: (e: unknown) => void; settled: boolean; cleanup: () => void }>
  >();
  private unsubscribeLifecycle: () => void;
  private readonly protocolGate: () => Promise<ManagedProtocolCheck>;
  private readonly disposeController = new AbortController();
  private disposed = false;
  private lifecyclePaused = false;
  private branchQuiescePromise: Promise<WorkflowQuiesceResult> | undefined;
  private recoveryBranchGeneration = 0;
  private readonly journalRetries = new Map<string, { timer?: ReturnType<typeof setTimeout>; attempt: number }>();
  private readonly journalBlockedRuns = new Set<string>();
  private readonly providerResumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private journalMutationKey: string | undefined;
  private readonly quarantinedRunIds = new Set<string>();

  constructor(
    readonly events: WorkflowEventBus,
    private readonly client: ManagedSpawnClient,
    private readonly journal: JournalWriter,
    private readonly readEntries: () => readonly SessionEntryLike[] = () => [],
    protocolGate?: () => Promise<ManagedProtocolCheck>,
  ) {
    this.protocolGate =
      protocolGate ??
      (() => this.client.checkProtocol?.() ?? Promise.reject(new Error("managed protocol check is unavailable")));
    this.unsubscribeLifecycle = this.attachLifecycle();
  }

  private async awaitProtocol(): Promise<ManagedProtocolCheck> {
    if (this.disposed) throw new WorkflowEngineDisposedError();
    let rejectDisposed: ((reason?: unknown) => void) | undefined;
    const disposed = new Promise<never>((_, reject) => {
      rejectDisposed = reject;
    });
    const onDisposed = () => rejectDisposed?.(new WorkflowEngineDisposedError());
    this.disposeController.signal.addEventListener("abort", onDisposed, { once: true });
    let result: ManagedProtocolCheck;
    try {
      result = await Promise.race([this.protocolGate(), disposed]);
    } finally {
      this.disposeController.signal.removeEventListener("abort", onDisposed);
    }
    if (this.disposed) throw new WorkflowEngineDisposedError();
    return result;
  }

  /** Whether this engine can still accept new workflow executions. */
  isDisposed(): boolean {
    return this.disposed;
  }

  private attachLifecycle(): () => void {
    const unsubs = [
      "subagents:created",
      "subagents:started",
      "subagents:completed",
      "subagents:failed",
      "subagents:compacted",
    ].map((eventName) =>
      this.events.on(eventName, (raw: unknown) => {
        this.onLifecycle(eventName, raw);
      }),
    );
    return () => {
      for (const unsubscribe of unsubs) unsubscribe();
    };
  }

  private onLifecycle(eventName: string, raw: unknown): void {
    if (
      eventName !== "subagents:created" &&
      eventName !== "subagents:started" &&
      eventName !== "subagents:completed" &&
      eventName !== "subagents:failed"
    )
      return;
    if (!raw || typeof raw !== "object") return;
    const data = raw as Record<string, unknown>;
    const agentId = typeof data.id === "string" ? data.id : typeof data.agentId === "string" ? data.agentId : undefined;
    if (!agentId) return;

    const rawOwner = data.owner;
    if (!rawOwner || typeof rawOwner !== "object" || Array.isArray(rawOwner)) return;
    const ownerRecord = rawOwner as Record<string, unknown>;
    if (
      ownerRecord.extension !== "pi-workflows" ||
      typeof ownerRecord.runId !== "string" ||
      typeof ownerRecord.nodeId !== "string" ||
      typeof ownerRecord.attemptId !== "string"
    )
      return;
    const owner: WorkflowOwner = {
      extension: "pi-workflows",
      runId: ownerRecord.runId,
      nodeId: ownerRecord.nodeId,
      attemptId: ownerRecord.attemptId,
    };
    const state = this.runs.get(owner.runId);
    if (state?.run.status !== "running" || state.lifecycleSuspended || state.controller.signal.aborted) return;
    const callNodeId = callIndexFromOwnerNode(owner.nodeId);
    if (callNodeId === undefined) return;

    // Validate ownership and the current attempt before accepting any identity
    // from the host. A delayed lifecycle fact from an older attempt must not
    // overwrite the tier identity of the current attempt.
    const spawnKey = `${owner.runId}/${owner.nodeId}/${owner.attemptId}`;
    const pending = state.pendingSpawns.get(spawnKey);
    const waiter = state.agentWaiters.get(agentId);
    const waiterMatches = Boolean(
      waiter &&
        !waiter.settled &&
        waiter.executionGeneration === state.executionGeneration &&
        owner.nodeId === `call-${waiter.callIndex}` &&
        owner.attemptId === `attempt-${waiter.generation}`,
    );
    const pendingMatches = Boolean(
      pending && pending.executionGeneration === state.executionGeneration && sameWorkflowOwner(pending.owner, owner),
    );
    if (!waiterMatches && !pendingMatches) return;
    // Top-level journal attempts carry the full run/node/attempt identity while
    // lifecycle owners carry the short attempt token. Nested calls have no
    // top-level attempt fact and are fenced by their pending/waiter owner.
    const currentAttemptId = state.run.attemptIds[callNodeId];
    if (currentAttemptId !== undefined && currentAttemptId !== `${owner.runId}/${callNodeId}/${owner.attemptId}`)
      return;

    if (updateCallTierIdentity(state, callNodeId, data.tier)) {
      this.persistCallTierIdentity(state, callNodeId);
    }
    // Created/started lifecycle facts carry managed identity before the RPC
    // reply is necessarily available. They are observation-only here; terminal
    // ownership is handled below once a completion/failure fact arrives.
    if (eventName !== "subagents:completed" && eventName !== "subagents:failed") return;

    const lifecycleStatus =
      eventName === "subagents:completed"
        ? "completed"
        : data.status === "stopped" || data.status === "interrupted"
          ? "stopped"
          : "failed";
    const tokenCount =
      typeof data.tokenCount === "number"
        ? data.tokenCount
        : data.tokens &&
            typeof data.tokens === "object" &&
            typeof (data.tokens as Record<string, unknown>).total === "number"
          ? ((data.tokens as Record<string, unknown>).total as number)
          : undefined;
    const delivery: AgentTerminalDelivery = {
      response: {
        id: agentId,
        terminal: {
          status: lifecycleStatus,
          ...(typeof data.result === "string" ? { result: data.result } : {}),
          ...(typeof data.error === "string" ? { error: data.error } : {}),
          ...(typeof data.outputFile === "string" ? { outputFile: data.outputFile } : {}),
          ...(tokenCount === undefined ? {} : { tokenCount }),
          compactionCount: typeof data.compactionCount === "number" ? data.compactionCount : 0,
          completedAt: typeof data.completedAt === "number" ? data.completedAt : Date.now(),
        },
      },
      ...(tokenCount === undefined
        ? {}
        : { usage: { input: 0, output: tokenCount, total: tokenCount, cost: 0, cacheRead: 0, cacheWrite: 0 } }),
      ...(Array.isArray(data.history) ? { history: [...data.history] } : {}),
    };

    if (waiterMatches && waiter) {
      this.resolveAgentWaiter(state, agentId, waiter, delivery);
      return;
    }

    // spawn-managed can emit a terminal lifecycle event synchronously before its
    // reply continuation registers the agent-id waiter. Buffer only an owner
    // that is currently awaiting that exact reply in this execution generation.
    if (!pendingMatches || state.bufferedTerminals.has(spawnKey) || state.bufferedTerminals.size >= MAX_AGENTS_PER_RUN)
      return;
    state.bufferedTerminals.set(spawnKey, { ...delivery, owner, executionGeneration: state.executionGeneration });
  }

  /** Persist a host-normalized tier learned before the managed reply arrives. */
  private persistCallTierIdentity(state: ScriptRunState, nodeId: string): void {
    const attemptId = state.run.attemptIds[nodeId];
    const identity = state.callTiers.get(nodeId);
    // Nested workflow frames are in-memory only; only a top-level call has a
    // durable attempt owner and can safely receive a journal transition.
    if (!attemptId || identity?.tier === undefined) return;
    this.persist(state.run.runId, `call-tier:${nodeId}`, () =>
      this.write({
        kind: "call_transition",
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        runId: state.run.runId,
        nodeId,
        status: "running",
        tier: identity.tier,
        attemptId,
        owner: { extension: "pi-workflows", runId: state.run.runId, nodeId, attemptId },
        timestamp: Date.now(),
      }),
    );
  }

  private resolveAgentWaiter(
    state: ScriptRunState,
    agentId: string,
    waiter: AgentLifecycleWaiter,
    delivery: AgentTerminalDelivery,
  ): void {
    if (waiter.settled) return;
    waiter.settled = true;
    state.agentWaiters.delete(agentId);
    if (delivery.usage) waiter.onUsage?.(delivery.usage);
    if (delivery.history) waiter.onHistory?.(delivery.history);
    waiter.resolve(delivery.response);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeController.abort();
    this.unsubscribeLifecycle();
    this.quarantinedRunIds.clear();
    for (const state of this.runs.values()) {
      this.cleanupAgents(state.run.runId);
      state.controller.abort(new DOMException("Workflow engine disposed", "AbortError"));
    }
    this.rejectWaiters(new WorkflowWaitAbortedError());
    this.runs.clear();
    this.clearJournalRetries();
    this.branchQuiescePromise = undefined;
  }

  suspendLifecycle(): void {
    if (this.disposed || this.lifecyclePaused) return;
    this.lifecyclePaused = true;
    this.unsubscribeLifecycle();
  }

  resumeLifecycle(): void {
    if (this.disposed || !this.lifecyclePaused) return;
    this.lifecyclePaused = false;
    this.unsubscribeLifecycle = this.attachLifecycle();
  }

  /** Stop owned agents while Pi replaces the active session-tree branch. */
  async quiesceForBranchChange(): Promise<WorkflowQuiesceResult> {
    if (this.disposed) return { settled: true, pending: [] };
    if (this.branchQuiescePromise) return this.branchQuiescePromise;
    this.clearJournalRetries();

    // Suspend and abort synchronously, before any await can let a stale runtime
    // dispatch another call or let a provider-limit continuation recreate an old
    // branch agent. `restore()` creates fresh states with suspension cleared.
    const targets = new Map<string, { agentIds: string[]; owners: WorkflowOwner[] }>();
    for (const state of this.runs.values()) {
      if (isTerminalWorkflow(state.run.status)) continue;
      const agentIds = [...state.agentWaiters.keys()];
      const owners = agentIds.map((agentId) => {
        const waiter = state.agentWaiters.get(agentId);
        return {
          extension: "pi-workflows" as const,
          runId: state.run.runId,
          nodeId: waiter ? `call-${waiter.callIndex}` : "",
          attemptId: `attempt-${waiter?.generation ?? 1}`,
        };
      });
      targets.set(state.run.runId, { agentIds, owners });
      state.lifecycleSuspended = true;
      state.bufferedTerminals.clear();
      state.controller.abort(new DOMException("Workflow branch change", "AbortError"));
    }

    const operation = (async () => {
      const operations: Array<Promise<WorkflowQuiesceResult>> = [];
      for (const state of this.runs.values()) {
        const run = state.run;
        const target = targets.get(run.runId);
        if (isTerminalWorkflow(run.status)) {
          this.reconcilePendingSpawns(state);
          continue;
        }
        if (state.pendingSpawns.size > 0) operations.push(this.quiescePendingSpawns(state));
        const activeAgentIds = target?.agentIds ?? [];
        if (activeAgentIds.length === 0) continue;
        operations.push(
          this.client
            .quiesceOwned?.(run.runId, activeAgentIds, BRANCH_QUIESCE_TIMEOUT_MS, target?.owners)
            .then((result) => ({
              settled: result.settled && result.pending.length === 0,
              pending: [...new Set(result.pending)].slice(0, 256),
            }))
            .catch((error: unknown) => ({
              settled: false,
              pending: activeAgentIds.slice(0, 256),
              diagnostic: error instanceof Error ? error.message : String(error),
            })) ?? Promise.resolve({ settled: false, pending: activeAgentIds.slice(0, 256) }),
        );
      }
      const results = await Promise.all(operations);
      const pending = [...new Set(results.flatMap((r) => r.pending))].slice(0, 256);
      const diagnostics = results.map((r) => r.diagnostic).filter((d): d is string => Boolean(d));
      return {
        settled: results.every((r) => r.settled) && pending.length === 0,
        pending,
        ...(diagnostics.length > 0 ? { diagnostic: diagnostics.join("; ") } : {}),
      };
    })();
    const tracked = operation.then(
      (result) => {
        if (this.branchQuiescePromise === tracked) this.branchQuiescePromise = undefined;
        return result;
      },
      (error: unknown) => {
        if (this.branchQuiescePromise === tracked) this.branchQuiescePromise = undefined;
        throw error;
      },
    );
    this.branchQuiescePromise = tracked;
    return tracked;
  }

  // ── start / control ────────────────────────────────────────────────────────

  /**
   * Start a script run. The script is parsed once here for the journal's meta;
   * the runtime re-parses it inside the sandbox (single source of truth for
   * the body it executes).
   */
  async start(script: string, options: ScriptStartOptions = {}): Promise<ScriptStartResult> {
    if (this.disposed) throw new WorkflowEngineDisposedError();
    const protocol = await this.awaitProtocol();
    if (this.disposed) throw new WorkflowEngineDisposedError();
    const { meta } = parseWorkflowScript(script);
    const now = Date.now();
    const runId = randomUUID();
    const scriptHash = hashScript(script);
    const toolset = options.toolset;
    const shippedScript = options.shippedScript === true ? true : undefined;
    const durableArgs = cloneWorkflowArgs(options.args);
    const runtimeArgs = cloneWorkflowArgs(durableArgs);
    const journalArgs = cloneWorkflowArgs(durableArgs);
    const frozenArgsPresent = durableArgs !== undefined;
    const frozenMaxAgents = options.maxAgents === undefined ? undefined : normalizeMaxAgents(options.maxAgents);
    const frozenConcurrency = options.concurrency === undefined ? undefined : normalizeConcurrency(options.concurrency);
    const frozenAgentRetries =
      options.agentRetries === undefined ? undefined : normalizeAgentRetries(options.agentRetries);
    const frozenTokenBudget = options.tokenBudget === undefined ? undefined : normalizeTokenBudget(options.tokenBudget);
    const frozenAgentTimeoutMs =
      options.agentTimeoutMs === undefined ? undefined : normalizeAgentTimeout(options.agentTimeoutMs);
    const startOptions: ScriptStartOptions = {
      ...options,
      ...(runtimeArgs === undefined ? {} : { args: runtimeArgs }),
      ...(frozenMaxAgents === undefined ? {} : { maxAgents: frozenMaxAgents }),
      ...(frozenConcurrency === undefined ? {} : { concurrency: frozenConcurrency }),
      ...(frozenAgentRetries === undefined ? {} : { agentRetries: frozenAgentRetries }),
      ...(frozenTokenBudget === undefined ? {} : { tokenBudget: frozenTokenBudget }),
      ...(frozenAgentTimeoutMs === undefined ? {} : { agentTimeoutMs: frozenAgentTimeoutMs }),
    };
    const run: ScriptRun = {
      runId,
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      script,
      scriptHash,
      meta,
      ...(durableArgs === undefined ? {} : { args: durableArgs }),
      frozenArgsPresent,
      ...(shippedScript === undefined ? {} : { shippedScript }),
      ...(toolset ? { toolset } : {}),
      ...(frozenMaxAgents !== undefined ? { frozenMaxAgents } : {}),
      ...(frozenConcurrency !== undefined ? { frozenConcurrency } : {}),
      ...(frozenAgentRetries !== undefined ? { frozenAgentRetries } : {}),
      ...(frozenTokenBudget !== undefined ? { frozenTokenBudget } : {}),
      ...(frozenAgentTimeoutMs !== undefined ? { frozenAgentTimeoutMs } : {}),
      ...(options.excludeTools ? { frozenExcludeTools: [...options.excludeTools] } : {}),
      status: "pending",
      callStatus: {},
      agentIds: {},
      attempts: {},
      attemptIds: {},
      callResults: {},
      callTiers: {},
      workflowResultGenerations: {},
      compactions: {},
      startedAt: now,
      updatedAt: now,
    };
    this.appendRequired({
      kind: "run_created",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId,
      script,
      scriptHash,
      meta,
      ...(journalArgs === undefined ? {} : { args: journalArgs }),
      frozenArgsPresent,
      ...(shippedScript === undefined ? {} : { shippedScript }),
      ...(toolset ? { toolset } : {}),
      ...(frozenMaxAgents !== undefined ? { frozenMaxAgents } : {}),
      ...(frozenConcurrency !== undefined ? { frozenConcurrency } : {}),
      ...(frozenAgentRetries !== undefined ? { frozenAgentRetries } : {}),
      ...(frozenTokenBudget !== undefined ? { frozenTokenBudget } : {}),
      ...(frozenAgentTimeoutMs !== undefined ? { frozenAgentTimeoutMs } : {}),
      ...(options.excludeTools ? { frozenExcludeTools: [...options.excludeTools] } : {}),
      timestamp: now,
    });
    const state: ScriptRunState = {
      run,
      frozenOptions: {
        ...(frozenTokenBudget !== undefined ? { tokenBudget: frozenTokenBudget } : {}),
        ...(frozenMaxAgents !== undefined ? { maxAgents: frozenMaxAgents } : {}),
        ...(frozenConcurrency !== undefined ? { concurrency: frozenConcurrency } : {}),
        ...(frozenAgentRetries !== undefined ? { agentRetries: frozenAgentRetries } : {}),
        ...(frozenAgentTimeoutMs !== undefined ? { agentTimeoutMs: frozenAgentTimeoutMs } : {}),
        ...(options.toolset ? { toolset: options.toolset } : {}),
        ...(shippedScript === undefined ? {} : { shippedScript }),
        ...(options.excludeTools ? { excludeTools: [...options.excludeTools] } : {}),
      },
      controller: new AbortController(),
      generations: new Map(),
      callTiers: new Map(Object.entries(run.callTiers ?? {})),
      agentWaiters: new Map(),
      bufferedTerminals: new Map(),
      pendingSpawns: new Map(),
      pendingJournal: new Set(),
      lifecycleSuspended: false,
      executionGeneration: 0,
    };
    this.runs.set(runId, state);
    this.setWorkflowStatus(run, "running");
    state.executionGeneration += 1;
    state.execution = this.execute(runId, script, startOptions, undefined, state.executionGeneration, protocol);
    // A run-fatal abort/stop already journals its terminal state; never let a
    // leftover rejection become an unhandled promise rejection.
    void state.execution.catch(() => {});
    if (options.background) return { runId, status: run.status, background: true };
    try {
      const settled = await this.waitFor(runId, options.signal);
      const state = this.runs.get(runId);
      const scriptResult = state?.result;
      return {
        runId,
        status: settled.status,
        background: false,
        ...(scriptResult !== undefined ? { result: renderWorkflowValue(scriptResult) } : {}),
        ...(settled.error ? { error: settled.error } : {}),
      };
    } catch (error: unknown) {
      if (!(error instanceof WorkflowWaitAbortedError)) throw error;
      const current = this.runs.get(runId)?.run ?? run;
      return { runId: current.runId, status: current.status, background: false, waitAborted: true };
    }
  }

  /**
   * Resume an interrupted/paused run: rebuild the resume journal from journaled
   * call_result events and re-run the same script under the same runId. The
   * runtime replays the longest unchanged prefix; every live dispatch of a
   * previously-journaled call index rotates the spawnKey generation.
   */
  async resume(
    runId: string,
    entries: readonly SessionEntryLike[],
    options: ScriptStartOptions = {},
    replacementScript?: string,
  ): Promise<ScriptStartResult | undefined> {
    if (this.disposed) throw new WorkflowEngineDisposedError();
    const protocol = await this.awaitProtocol();
    if (this.disposed) throw new WorkflowEngineDisposedError();
    const state = this.runs.get(runId);
    if (!state) return undefined;
    if (state.lifecycleSuspended) return undefined;
    const run = state.run;
    const providerTimer = this.providerResumeTimers.get(runId);
    if (providerTimer) {
      clearTimeout(providerTimer);
      this.providerResumeTimers.delete(runId);
    }
    if (run.nonResumable || (isTerminalWorkflow(run.status) && run.status !== "failed" && run.status !== "stopped"))
      return undefined;
    if (replacementScript !== undefined) {
      const parsed = parseWorkflowScript(replacementScript);
      const revision = (run.revision ?? 0) + 1;
      run.script = replacementScript;
      run.scriptHash = hashScript(replacementScript);
      run.meta = parsed.meta;
      run.revision = revision;
      this.persist(runId, `revision:${revision}`, () =>
        this.write({
          kind: "run_revision",
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          runId,
          revision,
          script: replacementScript,
          scriptHash: run.scriptHash,
          meta: parsed.meta,
          timestamp: Date.now(),
        }),
      );
    }
    // Arguments are frozen in every schema-v4 run_created fact. Resume never accepts
    // replacement args and never backfills the pre-schema-v4 run_args contract.
    const resumeArgs = cloneWorkflowArgs(run.args);
    const resumeJournal = buildResumeJournal(entries);
    // Seed generation bases from journaled attemptIds so a live re-dispatch of a
    // previously-journaled call never reuses a spawnKey (A4).
    for (const [callIndex, attemptId] of Object.entries(run.attemptIds)) {
      state.generations.set(callIndex, generationFromAttemptId(attemptId));
    }
    this.setWorkflowStatus(run, "running");
    state.controller = new AbortController();
    // Freeze semantics: original run parameters and args win over new options.
    // Only signal/confirm/background/loadSavedWorkflow/mainModel are per-resume context;
    // input/budget/scale/toolset are frozen from the original start.
    const frozen = state.frozenOptions;
    const resumeOptions: ScriptStartOptions = {
      ...options,
      args: resumeArgs,
      tokenBudget: frozen.tokenBudget,
      maxAgents: frozen.maxAgents,
      concurrency: frozen.concurrency,
      agentRetries: frozen.agentRetries,
      agentTimeoutMs: frozen.agentTimeoutMs,
      toolset: frozen.toolset,
      shippedScript: frozen.shippedScript,
      excludeTools: frozen.excludeTools ? [...frozen.excludeTools] : undefined,
    };
    state.bufferedTerminals.clear();
    state.executionGeneration += 1;
    state.execution = this.execute(
      runId,
      run.script,
      resumeOptions,
      resumeJournal,
      state.executionGeneration,
      protocol,
    );
    void state.execution.catch(() => {});
    if (options.background) return { runId, status: run.status, background: true };
    try {
      const settled = await this.waitFor(runId, options.signal);
      return { runId, status: settled.status, background: false };
    } catch (error: unknown) {
      if (!(error instanceof WorkflowWaitAbortedError)) throw error;
      return { runId, status: run.status, background: false, waitAborted: true };
    }
  }

  async control(
    action: "list" | "get" | "pause" | "resume" | "stop" | "rm",
    runId?: string,
    entries?: readonly SessionEntryLike[],
  ): Promise<{ action: string; runs?: unknown[]; run?: unknown }> {
    if (this.disposed) {
      if (action === "list") return { action, runs: [] };
      throw new WorkflowEngineDisposedError();
    }
    if (action === "list") return { action, runs: this.list() };
    if (!runId) throw new Error(`${action} requires runId`);
    const state = this.runs.get(runId);
    if (!state) throw new Error(`workflow run not found: ${runId}`);
    const run = state.run;
    if (action === "get") return { action, run: this.summary(run, true) };
    if (action === "pause") {
      if (run.status === "running") {
        this.setWorkflowStatus(run, "pausing");
        this.reconcilePendingSpawns(state);
        // Abort the script execution; the run settles as interrupted and can be
        // resumed from the journal. The script's in-flight agents are stopped by
        // the runtime's abort signal via the dispatch waiters.
        state.controller.abort();
        this.persist(runId, "pause-recovery", () =>
          this.write({
            kind: "run_recovery",
            schemaVersion: JOURNAL_SCHEMA_VERSION,
            runId,
            status: "interrupted",
            branchGeneration: this.recoveryBranchGeneration,
            rotations: [],
            recoveryId: deriveRecoveryId({ runId, rotations: [], timestamp: Date.now() }),
            timestamp: Date.now(),
          }),
        );
        run.status = "interrupted";
        run.updatedAt = Date.now();
        this.settleWaiters(runId, run);
      } else if (run.status !== "paused" && run.status !== "interrupted") {
        throw new Error(`cannot pause workflow in state ${run.status}`);
      }
    } else if (action === "resume") {
      if (run.nonResumable || run.status === "stopped") throw new Error("workflow run is non-resumable after stop");
      if (run.status !== "paused" && run.status !== "interrupted") {
        throw new Error(`cannot resume workflow in state ${run.status}`);
      }
      const sessionEntries = entries ?? this.readEntries();
      const resumed = await this.resume(runId, sessionEntries, {
        background: true,
        mainModel: undefined,
      });
      if (!resumed) throw new Error(`cannot resume workflow run: ${runId}`);
      return { action, run: this.summary(this.runs.get(runId)?.run ?? run) };
    } else if (action === "stop") {
      await this.stop(state);
    } else if (action === "rm") {
      if (!isTerminalWorkflow(run.status)) throw new Error("cannot remove a running workflow");
      this.persist(runId, "run-removed", () =>
        this.write({ kind: "run_removed", schemaVersion: JOURNAL_SCHEMA_VERSION, runId, timestamp: Date.now() }),
      );
      this.runs.delete(runId);
      this.waiters.delete(runId);
      return { action, run: this.summary(run) };
    }
    return { action, run: this.summary(run) };
  }

  async waitFor(runId: string, signal?: AbortSignal): Promise<ScriptRun> {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`workflow run not found: ${runId}`);
    if (isTerminalWorkflow(state.run.status) || state.run.status === "paused" || state.run.status === "interrupted")
      return state.run;
    if (signal?.aborted) throw new WorkflowWaitAbortedError();
    const all =
      this.waiters.get(runId) ??
      new Set<{
        resolve: (run: ScriptRun) => void;
        reject: (e: unknown) => void;
        settled: boolean;
        cleanup: () => void;
      }>();
    if (all.size >= MAX_WAITERS) throw new Error("too many workflow waiters");
    this.waiters.set(runId, all);
    return new Promise<ScriptRun>((resolve, reject) => {
      let abort = () => {};
      const waiter = {
        resolve,
        reject,
        settled: false,
        cleanup: () => signal?.removeEventListener("abort", abort),
      };
      abort = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        all.delete(waiter);
        if (all.size === 0) this.waiters.delete(runId);
        waiter.cleanup();
        reject(new WorkflowWaitAbortedError());
      };
      all.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private rejectWaiters(error: Error): void {
    for (const all of this.waiters.values()) {
      for (const waiter of [...all]) {
        if (waiter.settled) continue;
        waiter.settled = true;
        all.delete(waiter);
        waiter.cleanup();
        waiter.reject(error);
      }
    }
    this.waiters.clear();
  }

  private settleWaiters(runId: string, run: ScriptRun): void {
    const all = this.waiters.get(runId);
    if (!all) return;
    for (const waiter of [...all]) {
      if (waiter.settled) continue;
      waiter.settled = true;
      all.delete(waiter);
      waiter.cleanup();
      waiter.resolve(run);
    }
    if (all.size === 0) this.waiters.delete(runId);
  }

  // ── execution ──────────────────────────────────────────────────────────────

  private async execute(
    runId: string,
    script: string,
    options: ScriptStartOptions,
    resumeJournal?: Map<string, JournalEntry>,
    executionGeneration?: number,
    protocol?: ManagedProtocolCheck,
  ): Promise<WorkflowRunResult<unknown>> {
    if (this.disposed) throw new WorkflowEngineDisposedError();
    const state = this.runs.get(runId);
    if (!state) throw new Error(`workflow run not found: ${runId}`);
    const generation = executionGeneration ?? state.executionGeneration;

    const runner: WorkflowAgentRunner = {
      run: async (prompt: string, runOptions: AgentRunOptions = {}) => {
        return this.dispatchAgent(runId, prompt, runOptions);
      },
    };

    try {
      const result = await runWorkflow(script, {
        args: options.args,
        agent: runner,
        mainModel: options.mainModel,
        ...(protocol === undefined
          ? {}
          : {
              routingPolicy: protocol.routingPolicy,
              routingPolicyFingerprint: protocol.routingPolicyFingerprint,
            }),
        concurrency: options.concurrency,
        agentRetries: options.agentRetries,
        tokenBudget: options.tokenBudget,
        agentTimeoutMs: options.agentTimeoutMs,
        signal: state.controller.signal,
        maxAgents: options.maxAgents,
        runId,
        executionNonce: `${generation}-${randomUUID()}`,
        resumeJournal,
        toolset: options.toolset,
        shippedScript: options.shippedScript,
        excludeTools: options.excludeTools,
        confirm: options.confirm,
        loadSavedWorkflow: options.loadSavedWorkflow,
        onAgentJournal: (entry) => {
          if (state.executionGeneration !== generation) return;
          // Nested workflow frames keep their own lifecycle visibility, but their
          // individual call facts are not top-level replay keys. The parent
          // workflow_result fact below owns the nested replay boundary.
          if (entry.runId === undefined || entry.runId === runId) this.journalCallResult(runId, entry);
        },
        onWorkflowJournal: (entry) => {
          if (state.executionGeneration !== generation) return;
          this.journalWorkflowResult(runId, entry);
        },
        onRuntimeEvent: (event) => {
          if (state.executionGeneration !== generation) return;
          try {
            this.events.emit("pi-workflows:runtime", { runId, event: cloneRuntimeEvent(event) });
          } catch {
            // Cross-extension observers cannot change workflow execution.
          }
          try {
            this.onRuntimeEvent?.(runId, cloneRuntimeEvent(event));
          } catch {
            // UI observers are diagnostic surfaces and are independently contained.
          }
        },
      });
      const live = this.runs.get(runId);
      const run = live?.run;
      if (run && state.executionGeneration === generation && !isTerminalWorkflow(run.status)) {
        this.setWorkflowStatus(run, "completed", undefined, undefined, result.result);
        live.result = result.result;
      }
      return result;
    } catch (error: unknown) {
      const run = this.runs.get(runId)?.run;
      if (run && state.executionGeneration === generation && !isTerminalWorkflow(run.status)) {
        const message = error instanceof Error ? error.message : String(error);
        const workflowError = error instanceof WorkflowError ? error : wrapError(error);
        if (workflowError.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT) {
          this.setWorkflowStatus(run, "paused", message);
          this.cleanupAgents(runId);
          this.scheduleProviderResume(runId, workflowError.resetHint);
        } else if (workflowError.code === WorkflowErrorCode.WORKFLOW_ABORTED && state.controller.signal.aborted) {
          this.setWorkflowStatus(run, "interrupted");
        } else {
          this.setWorkflowStatus(run, "failed", message);
          this.cleanupAgents(runId);
        }
      }
      throw error;
    } finally {
      // Reject any waiters that never settled (agents left in flight).
      const run = this.runs.get(runId)?.run;
      if (run && state.executionGeneration === generation) this.settleWaiters(runId, run);
    }
  }

  /**
   * Dispatch one live agent() call through spawn-managed with an A4-rotated
   * spawnKey: `${runId}/call-${callIndex}/attempt-${generation}`. Top-level calls
   * use numeric call indexes; nested workflow frames use a generation/nonce
   * namespace so a changed child cannot reuse a stale managed identity.
   */
  private async dispatchAgent(runId: string, prompt: string, runOptions: AgentRunOptions): Promise<unknown> {
    if (this.disposed) throw new WorkflowEngineDisposedError();
    const state = this.runs.get(runId);
    if (!state) throw new Error(`workflow run not found: ${runId}`);
    if (state.lifecycleSuspended || state.controller.signal.aborted) {
      throw new WorkflowError("workflow branch is quiescing", WorkflowErrorCode.WORKFLOW_ABORTED, {
        recoverable: true,
      });
    }
    const run = state.run;
    const executionGeneration = state.executionGeneration;
    const callIndex = runOptions.callIndex ?? state.generations.size;
    const frameRunId = runOptions.runId ?? runId;
    const nested = frameRunId !== runId;
    // Top-level calls use their numeric lexical index. Nested frames use a
    // run-local namespace so child call 0 can never collide with the parent's
    // call 0 or with a sibling nested workflow. The managed owner remains the
    // top-level run: nested workflow results are journaled as one parent fact.
    const nodeId = nested ? `${frameRunId}:${callIndex}` : String(callIndex);
    // The spawnKey identity carries the `call-` prefix (A4):
    //   spawnKey = `${runId}/call-${nodeId}/attempt-${generation}`
    // The journal node identity is the bare call index for top-level calls;
    // nested identities are in-memory only and are never persisted as agent
    // facts.
    const spawnNodeId = `call-${nodeId}`;
    const base = state.generations.get(nodeId) ?? 0;
    const generation = base + (runOptions.attempt ?? 1);
    state.generations.set(nodeId, generation);
    const spawnAttemptId = `attempt-${generation}`;
    const attemptId = `${runId}/${nodeId}/attempt-${generation}`;

    const type = runOptions.agentType ?? "general-purpose";
    const tier = runOptions.tier;
    if (tier !== undefined && !isManagedAgentTier(tier)) {
      throw new WorkflowError(
        `agent tier must be a non-empty, whitespace-free key (received ${String(tier)})`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    // This dispatch is authoritative for the current script revision. Do not
    // carry an identity from the previous script: deleting `tier` must clear
    // the recorded one instead of silently preserving the old route.
    const tierIdentity: CallTierIdentity = tier === undefined ? {} : { tier };
    state.callTiers.set(nodeId, tierIdentity);
    run.callTiers[nodeId] = tierIdentity;
    const task: DispatchTask = {
      subagent_type: type,
      prompt,
      description: runOptions.label ?? `workflow call ${callIndex}`,
      ...(tier === undefined ? {} : { tier }),
      ...(runOptions.thread === undefined ? {} : { thread: runOptions.thread }),
      ...(runOptions.toolset === undefined ? {} : { toolset: runOptions.toolset }),
      ...(runOptions.excludeTools === undefined ? {} : { excludeTools: runOptions.excludeTools }),
      ...(runOptions.isolation === undefined ? {} : { isolation: runOptions.isolation }),
    };

    // Journal the attempt rotation only for top-level calls. A nested frame is
    // represented by its parent workflow_result replay boundary instead of
    // leaking child call facts into the parent's numeric call namespace.
    if (!nested) {
      this.persist(runId, `call-attempt:${nodeId}`, () =>
        this.write({
          kind: "call_attempt",
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          runId,
          nodeId,
          attemptId,
          generation,
          ...(tierIdentity.tier === undefined ? {} : { tier: tierIdentity.tier }),
          owner: { extension: "pi-workflows", runId, nodeId, attemptId },
          timestamp: Date.now(),
        }),
      );
      run.callStatus[nodeId] = "running";
      run.attempts[nodeId] = generation;
      run.attemptIds[nodeId] = attemptId;
      run.updatedAt = Date.now();
    }

    // Abort linkage: an external signal (pause/stop/Esc) cancels the wait and
    // stops the owned agent. Track the spawn key before the RPC reply arrives so
    // a lost reply can still be reconciled during shutdown or branch replacement.
    const externalSignal = runOptions.signal ?? state.controller.signal;
    const spawnKey = `${runId}/${spawnNodeId}/${spawnAttemptId}`;
    const owner: WorkflowOwner = {
      extension: "pi-workflows",
      runId,
      nodeId: spawnNodeId,
      attemptId: spawnAttemptId,
    };
    state.pendingSpawns.set(spawnKey, { spawnKey, owner, executionGeneration });
    const reconcilePending = () => {
      state.bufferedTerminals.delete(spawnKey);
      const reconciliation = this.client.reconcileManaged?.(spawnKey, owner);
      void reconciliation?.catch(() => {});
    };
    const onPendingAbort = () => reconcilePending();
    externalSignal.addEventListener("abort", onPendingAbort, { once: true });
    if (externalSignal.aborted) onPendingAbort();

    let pendingId = "";
    let response: ManagedSpawnResponse | string;
    try {
      response = await this.client.spawn(task, runId, spawnNodeId, spawnAttemptId, externalSignal);
    } finally {
      externalSignal.removeEventListener("abort", onPendingAbort);
      state.pendingSpawns.delete(spawnKey);
    }
    const responseId = typeof response === "string" ? response : response.id;
    if (
      state.executionGeneration !== executionGeneration ||
      state.controller.signal.aborted ||
      externalSignal.aborted
    ) {
      state.bufferedTerminals.delete(spawnKey);
      await this.client
        .stopOwned?.(responseId, { extension: "pi-workflows", runId, nodeId: spawnNodeId, attemptId: spawnAttemptId })
        .catch(() => {});
      throw new WorkflowError(
        "workflow dispatch became stale during pause/resume",
        WorkflowErrorCode.WORKFLOW_ABORTED,
        { recoverable: true },
      );
    }
    if (typeof response !== "string" && updateCallTierIdentity(state, nodeId, response.tier)) {
      this.persistCallTierIdentity(state, nodeId);
    }
    // Report the tier the host actually selected back to the runtime, which
    // journals it: a call that named none still resolved to something, and the
    // run's own record of what ran should say what.
    const resolvedTierIdentity = state.callTiers.get(nodeId);
    if (resolvedTierIdentity?.tier !== undefined) runOptions.onTierResolved?.(resolvedTierIdentity.tier);
    if (typeof response === "string") {
      pendingId = response;
    } else if (response.terminal) {
      state.bufferedTerminals.delete(spawnKey);
      // The spawn response already carries a terminal snapshot (fast completion
      // or interrupted replay). The runtime journals successful calls itself
      // (onAgentJournal); a terminal snapshot that is NOT a success is
      // journaled here so the resume journal reflects the failure.
      const terminal = response.terminal;
      if (typeof terminal.tokenCount === "number")
        runOptions.onUsage?.({
          input: 0,
          output: terminal.tokenCount,
          total: terminal.tokenCount,
          cost: 0,
          cacheRead: 0,
          cacheWrite: 0,
        });
      const status = managedTerminalStatus(terminal);
      if (status !== "completed") {
        const result = resultFromLifecycle(
          status,
          response.id,
          terminal.result,
          terminal.error,
          terminal.compactionCount,
          terminal.tokenCount,
          resolvedTierIdentity?.tier ?? tier,
        );
        result.attemptId = attemptId;
        if (!nested) this.commitCallTerminal(runId, nodeId, result);
        if (status === "failed" && terminal.error) {
          throw wrapError(new Error(terminal.error), { agentLabel: runOptions.label });
        }
      }
      return terminal.result ?? "";
    } else {
      pendingId = response.id;
    }

    const waitAbort = () => {
      const waiter = state.agentWaiters.get(pendingId);
      if (waiter && !waiter.settled) {
        waiter.settled = true;
        state.agentWaiters.delete(pendingId);
        state.bufferedTerminals.delete(spawnKey);
        void this.client
          .stopOwned?.(pendingId, {
            extension: "pi-workflows",
            runId,
            nodeId: spawnNodeId,
            attemptId: spawnAttemptId,
          })
          .catch(() => {});
        waiter.reject(new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true }));
      }
    };

    // Wait for the terminal lifecycle event, consuming a matching terminal that
    // arrived while the managed-spawn reply was still pending.
    const terminal = await new Promise<ManagedSpawnResponse>((resolve, reject) => {
      const waiter: AgentLifecycleWaiter = {
        callIndex: nodeId,
        generation,
        executionGeneration,
        onUsage: runOptions.onUsage,
        onHistory: runOptions.onHistory,
        settled: false,
        resolve,
        reject,
      };
      state.agentWaiters.set(pendingId, waiter);
      externalSignal.addEventListener("abort", waitAbort, { once: true });
      if (externalSignal.aborted) {
        waitAbort();
        return;
      }

      const buffered = state.bufferedTerminals.get(spawnKey);
      if (!buffered) return;
      state.bufferedTerminals.delete(spawnKey);
      if (
        buffered.executionGeneration !== executionGeneration ||
        state.executionGeneration !== executionGeneration ||
        state.lifecycleSuspended ||
        state.controller.signal.aborted ||
        buffered.response.id !== pendingId ||
        !sameWorkflowOwner(buffered.owner, owner)
      )
        return;
      this.resolveAgentWaiter(state, pendingId, waiter, buffered);
    }).finally(() => {
      externalSignal.removeEventListener("abort", waitAbort);
    });

    const snapshot = terminal.terminal;
    if (!snapshot)
      throw new WorkflowError("subagent settled without a terminal snapshot", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
        recoverable: true,
      });
    const status = managedTerminalStatus(snapshot);
    // Successful calls are journaled by the runtime's onAgentJournal (the
    // single writer for completed results); only failures settle here so the
    // resume journal reflects them.
    if (status !== "completed") {
      const result = resultFromLifecycle(
        status,
        terminal.id,
        snapshot.result,
        snapshot.error,
        snapshot.compactionCount,
        snapshot.tokenCount,
        state.callTiers.get(nodeId)?.tier ?? tier,
      );
      result.attemptId = attemptId;
      if (!nested) this.commitCallTerminal(runId, nodeId, result);
      if (status === "failed" && snapshot.error) {
        throw wrapError(new Error(snapshot.error), { agentLabel: runOptions.label });
      }
    }
    const completedTierIdentity = state.callTiers.get(nodeId);
    if (completedTierIdentity?.tier !== undefined) runOptions.onTierResolved?.(completedTierIdentity.tier);
    return snapshot.result ?? "";
  }

  private journalCallResult(runId: string, entry: JournalEntry): void {
    const state = this.runs.get(runId);
    if (!state) return;
    const run = state.run;
    const nodeId = String(entry.index);
    const result = entry.result;
    const callTierIdentity: CallTierIdentity =
      entry.tier === undefined ? (run.callTiers[nodeId] ?? {}) : { tier: entry.tier };
    const callResult: CallResult = {
      status: "completed",
      ...(typeof result === "string" && result.length === 0 ? {} : { result }),
      ...callTierIdentity,
      compactionCount: 0,
      updatedAt: Date.now(),
    };
    const attemptId = run.attemptIds[nodeId];
    if (attemptId) callResult.attemptId = attemptId;
    const event: JournalEvent = {
      kind: "call_result",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId,
      nodeId,
      result: callResult,
      callHash: entry.hash,
      ...(entry.storeDelta !== undefined && Object.keys(entry.storeDelta).length > 0
        ? { storeDelta: entry.storeDelta }
        : {}),
      ...(attemptId ? { attemptId } : {}),
      ...(attemptId ? { owner: { extension: "pi-workflows", runId, nodeId, attemptId } } : {}),
      timestamp: Date.now(),
    };
    this.persist(runId, `call-result:${nodeId}`, () => this.write(event));
    run.callResults[nodeId] = callResult;
    run.callTiers[nodeId] = callResult.tier === undefined ? {} : { tier: callResult.tier };
    run.callStatus[nodeId] = "completed";
    run.updatedAt = Date.now();
  }

  private journalWorkflowResult(runId: string, entry: JournalEntry): void {
    const state = this.runs.get(runId);
    if (!state) return;
    const nodeId = String(entry.index);
    const result: CallResult = {
      status: "completed",
      ...(entry.result === undefined ? {} : { result: entry.result }),
      ...(entry.tier === undefined ? {} : { tier: entry.tier }),
      compactionCount: 0,
      updatedAt: Date.now(),
    };
    const event: JournalEvent = {
      kind: "workflow_result",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId,
      nodeId,
      result,
      generation: entry.generation ?? 1,
      ...(entry.agentCount === undefined ? {} : { agentCount: entry.agentCount }),
      callHash: entry.hash,
      ...(entry.storeDelta !== undefined && Object.keys(entry.storeDelta).length > 0
        ? { storeDelta: entry.storeDelta }
        : {}),
      timestamp: Date.now(),
    };
    // The parent cannot become completed until this replay boundary is durable;
    // otherwise a transient append retry would arrive after the terminal
    // transition and be discarded as stale during restore.
    this.appendRequired(event);
    state.run.workflowResultGenerations[nodeId] = event.generation;
    state.run.callResults[nodeId] = result;
    state.run.callTiers[nodeId] = result.tier === undefined ? {} : { tier: result.tier };
    state.run.callStatus[nodeId] = "completed";
    state.run.updatedAt = Date.now();
  }

  private commitCallTerminal(runId: string, nodeId: string, result: CallResult): void {
    const state = this.runs.get(runId);
    if (!state) return;
    const run = state.run;
    const attemptId = result.attemptId ?? run.attemptIds[nodeId];
    const event: JournalEvent = {
      kind: "call_result",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId,
      nodeId,
      result,
      ...(attemptId ? { attemptId } : {}),
      ...(attemptId ? { owner: { extension: "pi-workflows", runId, nodeId, attemptId } } : {}),
      timestamp: Date.now(),
    };
    this.persist(runId, `call-terminal:${nodeId}`, () => this.write(event));
    run.callResults[nodeId] = result;
    run.callTiers[nodeId] = result.tier === undefined ? {} : { tier: result.tier };
    run.callStatus[nodeId] = result.status;
    if (result.agentId) run.agentIds[nodeId] = result.agentId;
    run.compactions[nodeId] = Math.max(run.compactions[nodeId] ?? 0, result.compactionCount);
    run.updatedAt = Date.now();
    // A recoverable child failure is a value for runtime retry/handling. The
    // script, not this lifecycle callback, decides whether the whole run fails.
  }

  private reconcilePendingSpawns(state: ScriptRunState): void {
    for (const pending of state.pendingSpawns.values()) {
      const reconciliation = this.client.reconcileManaged?.(pending.spawnKey, pending.owner);
      void reconciliation?.catch(() => {});
    }
    state.pendingSpawns.clear();
    state.bufferedTerminals.clear();
  }

  private async quiescePendingSpawns(state: ScriptRunState): Promise<WorkflowQuiesceResult> {
    const pending = [...state.pendingSpawns.values()];
    if (pending.length === 0) return { settled: true, pending: [] };
    if (!this.client.reconcileManaged) {
      return { settled: false, pending: pending.map(({ spawnKey }) => spawnKey).slice(0, 256) };
    }
    const failed: string[] = [];
    await Promise.all(
      pending.map(async ({ spawnKey, owner }) => {
        try {
          const result = await this.client.reconcileManaged?.(spawnKey, owner);
          if (result === undefined) failed.push(spawnKey);
        } catch {
          failed.push(spawnKey);
        }
      }),
    );
    return { settled: failed.length === 0, pending: failed.slice(0, 256) };
  }

  private cleanupAgents(runId: string): void {
    const state = this.runs.get(runId);
    if (!state) return;
    this.reconcilePendingSpawns(state);
    for (const [agentId, waiter] of [...state.agentWaiters]) {
      if (waiter.settled) continue;
      waiter.settled = true;
      state.agentWaiters.delete(agentId);
      waiter.reject(
        new WorkflowError("workflow failed while agent in flight", WorkflowErrorCode.WORKFLOW_ABORTED, {
          recoverable: true,
        }),
      );
      void this.client
        .stopOwned?.(agentId, {
          extension: "pi-workflows",
          runId,
          nodeId: `call-${waiter.callIndex}`,
          attemptId: `attempt-${waiter.generation}`,
        })
        .catch(() => {});
    }
  }

  private async stop(state: ScriptRunState): Promise<void> {
    const run = state.run;
    if (isTerminalWorkflow(run.status)) return;
    this.setWorkflowStatus(run, "stopping", "workflow stopped", "stop");
    run.nonResumable = true;
    state.controller.abort();
    this.cleanupAgents(run.runId);
    const terminalResults: RecoveryTerminalResult[] = [];
    for (const [nodeId, status] of Object.entries(run.callStatus)) {
      if (status !== "completed") {
        const result = resultFromLifecycle(
          "stopped",
          run.agentIds[nodeId],
          undefined,
          "workflow stopped",
          run.compactions[nodeId] ?? 0,
          undefined,
          state.callTiers.get(nodeId)?.tier,
        );
        result.attemptId = run.attemptIds[nodeId];
        terminalResults.push({
          nodeId,
          attemptId: run.attemptIds[nodeId] ?? "",
          result,
          owner: { extension: "pi-workflows", runId: run.runId, nodeId, attemptId: run.attemptIds[nodeId] ?? "" },
        });
        run.callResults[nodeId] = result;
        run.callStatus[nodeId] = "stopped";
      }
    }
    const event: TerminalRecoveryEvent = {
      kind: "terminal_recovery",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: run.runId,
      status: "stopped",
      terminalIntent: "stop",
      branchGeneration: this.recoveryBranchGeneration,
      terminalResults,
      blockedNodeIds: [],
      error: "workflow stopped",
      recoveryId: deriveRecoveryId({ runId: run.runId, rotations: [], timestamp: Date.now() }),
      timestamp: Date.now(),
    };
    this.persist(run.runId, "stop-terminal", () => this.write(event));
    run.status = "stopped";
    run.updatedAt = Date.now();
    this.settleWaiters(run.runId, run);
  }

  // ── journal writes ─────────────────────────────────────────────────────────

  /**
   * A Pi lifecycle event is delivered once. If its durable append is transiently
   * unavailable, retain the mutation in memory and retry the append with
   * backoff without requiring the peer to re-emit. The in-memory run state is
   * authoritative; the journal is best-effort with bounded retries, and a run
   * whose appends keep failing is marked blocked (reported once, not spammed).
   */
  private scheduleJournalRetry(runId: string, key: string, mutation: () => void): void {
    const retryKey = `${runId}\u0000${key}`;
    if (this.journalRetries.has(retryKey)) return;
    const retry = { attempt: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    const attempt = (): void => {
      const current = this.journalRetries.get(retryKey);
      if (!current) return;
      current.timer = undefined;
      if (this.lifecyclePaused || !this.runs.has(runId)) {
        this.journalRetries.delete(retryKey);
        return;
      }
      const previousKey = this.journalMutationKey;
      this.journalMutationKey = `${runId}:${key}`;
      try {
        mutation();
        this.journalRetries.delete(retryKey);
      } catch (error: unknown) {
        if (!(error instanceof JournalAppendError)) {
          this.journalRetries.delete(retryKey);
          console.warn(
            `[pi-workflows] journal retry abandoned: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        current.attempt += 1;
        if (current.attempt >= JOURNAL_RETRY_MAX_ATTEMPTS) {
          this.journalRetries.delete(retryKey);
          this.journalBlockedRuns.add(runId);
          console.warn(`[pi-workflows] journal retry exhausted for ${runId}: ${error.message}`);
          return;
        }
        const delay = Math.min(
          JOURNAL_RETRY_MAX_DELAY_MS,
          JOURNAL_RETRY_INITIAL_DELAY_MS * 2 ** Math.min(current.attempt - 1, 6),
        );
        current.timer = setTimeout(attempt, delay);
      } finally {
        this.journalMutationKey = previousKey;
      }
    };
    this.journalRetries.set(retryKey, retry);
    queueMicrotask(attempt);
  }

  private appendRequired(event: JournalEvent): void {
    try {
      this.journal.append(event);
    } catch (error: unknown) {
      throw new WorkflowError(
        `Could not persist workflow ${event.kind}: ${error instanceof Error ? error.message : String(error)}`,
        WorkflowErrorCode.PERSISTENCE_ERROR,
        { recoverable: true, details: error },
      );
    }
  }

  private write(event: JournalEvent): void {
    // The in-memory mutation is applied by the caller BEFORE calling write;
    // here we only persist. A transient failure schedules a retry of this exact
    // append. Terminal bookkeeping already happened, so a retry that never
    // succeeds degrades to a warning rather than corrupting run state.
    try {
      this.journal.append(event);
    } catch (error: unknown) {
      if (this.journalMutationKey) {
        throw new JournalAppendError(event.kind, error);
      }
      console.warn(`[pi-workflows] journal append failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Persist one journal event with bounded retry. The caller applies the
   * in-memory mutation itself; `persist` only makes the append durable and, on
   * a transient failure, schedules a retry of the exact same append.
   */
  private persist(runId: string, key: string, mutation: () => void): void {
    const previousKey = this.journalMutationKey;
    this.journalMutationKey = `${runId}:${key}`;
    try {
      mutation();
    } catch (error: unknown) {
      if (error instanceof JournalAppendError) {
        this.scheduleJournalRetry(runId, key, mutation);
        return;
      }
      console.warn(`[pi-workflows] journal append failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.journalMutationKey = previousKey;
    }
  }

  private scheduleProviderResume(runId: string, hint?: string): void {
    if (this.providerResumeTimers.has(runId)) return;
    const match = hint ? /(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?|days?)/i.exec(hint) : undefined;
    const unit = match?.[2]?.toLowerCase();
    const multiplier = unit?.startsWith("second")
      ? 1_000
      : unit?.startsWith("minute")
        ? 60_000
        : unit?.startsWith("hour")
          ? 3_600_000
          : unit?.startsWith("day")
            ? 86_400_000
            : undefined;
    const delay = Math.min(
      PROVIDER_RETRY_MAX_MS,
      match && multiplier ? Math.max(1_000, Number(match[1]) * multiplier) : PROVIDER_RETRY_DEFAULT_MS,
    );
    const timer = setTimeout(() => {
      this.providerResumeTimers.delete(runId);
      const state = this.runs.get(runId);
      if (state?.run.status !== "paused") return;
      void Promise.resolve()
        .then(() => {
          const current = this.runs.get(runId);
          if (current?.run.status !== "paused") return;
          // resume() is the single authorization gate and captures the fresh
          // routing-policy fingerprint for this execution.
          return this.resume(runId, this.readEntries(), { background: true });
        })
        .catch((error: unknown) => {
          console.warn(
            `[pi-workflows] automatic provider-limit resume failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }, delay);
    timer.unref?.();
    this.providerResumeTimers.set(runId, timer);
  }
  private clearJournalRetries(): void {
    for (const { timer } of this.journalRetries.values()) {
      if (timer) clearTimeout(timer);
    }
    this.journalRetries.clear();
    this.journalBlockedRuns.clear();
    for (const timer of this.providerResumeTimers.values()) clearTimeout(timer);
    this.providerResumeTimers.clear();
  }

  private setWorkflowStatus(
    run: ScriptRun,
    status: ScriptRun["status"],
    error?: string,
    terminalIntent?: "stop" | "failure",
    finalResult?: unknown,
  ): void {
    if (isTerminalWorkflow(run.status) && !isTerminalWorkflow(status)) return;
    // Validate and isolate terminal values before best-effort persistence or any
    // status mutation. A bad result must still be able to transition the run to failed.
    const durableFinalResult = finalResult === undefined ? undefined : cloneWorkflowResult(finalResult);
    const runFinalResult = finalResult === undefined ? undefined : cloneWorkflowResult(finalResult);
    const timestamp = Date.now();
    this.persist(run.runId, `transition:${status}`, () =>
      this.write({
        kind: "workflow_transition",
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        runId: run.runId,
        status,
        ...(error !== undefined ? { error } : {}),
        ...(durableFinalResult !== undefined ? { finalResult: durableFinalResult } : {}),
        ...(terminalIntent !== undefined ? { terminalIntent } : {}),
        timestamp,
      }),
    );
    run.status = status;
    if (error !== undefined) run.error = error;
    if (runFinalResult !== undefined) run.finalResult = runFinalResult;
    if (terminalIntent !== undefined) run.terminalIntent = terminalIntent;
    run.updatedAt = timestamp;
    if (isTerminalWorkflow(status)) {
      this.runs.get(run.runId)?.bufferedTerminals.clear();
      this.settleWaiters(run.runId, run);
      this.onRunSettled?.();
    }
  }

  // ── restore / summary ──────────────────────────────────────────────────────

  restore(entries: readonly SessionEntryLike[], branchGeneration = 0): void {
    if (this.disposed) return;
    // A branch replay is a replacement, not a merge. Runs absent from the new
    // branch must not remain controllable or append facts into it.
    this.clearJournalRetries();
    for (const state of this.runs.values()) {
      this.cleanupAgents(state.run.runId);
      state.controller.abort(new DOMException("Workflow branch replaced", "AbortError"));
    }
    this.rejectWaiters(new WorkflowWaitAbortedError());
    this.runs.clear();
    this.recoveryBranchGeneration = branchGeneration;
    const runs = replayJournal(entries, {
      onInvalid: (diagnostic) => console.warn(`[pi-workflows] ${diagnostic}`),
    });
    for (const run of runs.values()) {
      const state: ScriptRunState = {
        run,
        frozenOptions: {
          ...(run.frozenTokenBudget !== undefined ? { tokenBudget: run.frozenTokenBudget } : {}),
          ...(run.frozenMaxAgents !== undefined ? { maxAgents: run.frozenMaxAgents } : {}),
          ...(run.frozenConcurrency !== undefined ? { concurrency: run.frozenConcurrency } : {}),
          ...(run.frozenAgentRetries !== undefined ? { agentRetries: run.frozenAgentRetries } : {}),
          ...(run.frozenAgentTimeoutMs !== undefined ? { agentTimeoutMs: run.frozenAgentTimeoutMs } : {}),
          ...(run.toolset ? { toolset: run.toolset } : {}),
          ...(run.shippedScript === undefined ? {} : { shippedScript: run.shippedScript }),
          ...(run.frozenExcludeTools ? { excludeTools: [...run.frozenExcludeTools] } : {}),
        },
        controller: new AbortController(),
        generations: new Map(),
        callTiers: new Map(Object.entries(run.callTiers ?? {})),
        agentWaiters: new Map(),
        bufferedTerminals: new Map(),
        pendingSpawns: new Map(),
        pendingJournal: new Set(),
        lifecycleSuspended: false,
        executionGeneration: 0,
      };
      for (const [callIndex, attemptId] of Object.entries(run.attemptIds)) {
        state.generations.set(callIndex, generationFromAttemptId(attemptId));
      }
      // Only non-terminal runs can be resumed; terminal runs are inert history.
      if (isTerminalWorkflow(run.status)) {
        this.runs.set(run.runId, state);
        continue;
      }
      // A restored run that never settled was cut off mid-execution (branch
      // change, reload, or crash). Mark it interrupted so it is visibly
      // resumable rather than looking live-but-frozen.
      run.status = "interrupted";
      run.updatedAt = Date.now();
      this.runs.set(run.runId, state);
    }
  }

  list(): Array<Record<string, unknown>> {
    return [...this.runs.values()]
      .sort((a, b) => b.run.startedAt - a.run.startedAt)
      .map((state) => this.summary(state.run));
  }

  /** Raw run list for the navigator (keeps live ScriptRun state). */
  getState(runId: string): ScriptRunState | undefined {
    return this.runs.get(runId);
  }

  getRun(runId: string): ScriptRun | undefined {
    return this.runs.get(runId)?.run;
  }

  summary(run: ScriptRun, detailed = false): Record<string, unknown> {
    const base: Record<string, unknown> = {
      runId: run.runId,
      status: run.status,
      name: run.meta.name,
      description: run.meta.description.slice(0, 500),
      agentCount: Object.keys(run.callResults).length,
      phases: run.meta.phases?.map((p) => p.title) ?? [],
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      ...(run.error ? { error: run.error.slice(0, 2_000) } : {}),
      ...(run.finalResult !== undefined ? { resultPreview: renderWorkflowValue(run.finalResult).slice(0, 8_000) } : {}),
    };
    if (!detailed) return base;
    const calls = Object.entries(run.callStatus)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([nodeId, status]) => {
        const result = run.callResults[nodeId];
        return {
          index: Number(nodeId),
          status,
          ...(result?.result !== undefined ? { resultPreview: String(result.result).slice(0, 300) } : {}),
          ...(result?.error ? { error: result.error.slice(0, 300) } : {}),
          ...(result?.tokenCount !== undefined ? { tokenCount: result.tokenCount } : {}),
          ...(run.agentIds[nodeId] ? { agentId: run.agentIds[nodeId] } : {}),
          attemptId: run.attemptIds[nodeId],
        };
      });
    return { ...base, calls };
  }
}

function hashScript(script: string): string {
  return createHash("sha256").update(script).digest("hex");
}

export class WorkflowEngineDisposedError extends Error {
  constructor() {
    super("Workflow engine is disposed");
    this.name = "WorkflowEngineDisposedError";
  }
}

export class WorkflowWaitAbortedError extends Error {
  constructor() {
    super("workflow wait aborted");
    this.name = "WorkflowWaitAbortedError";
  }
}

export type { ScriptRun, WorkflowOwner };
export { createManagedSpawnClient, JOURNAL_ENTRY_TYPE, snapshotRun };
