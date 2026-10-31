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
import { describeWorkflowError, WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js";
import { type WorkflowInspection, type WorkflowInspectionHeader, WorkflowPresentation } from "./inspection.js";
import {
  applyRecoveryEvent,
  buildResumeJournal,
  type CallResult,
  type CallTierIdentity,
  deriveRecoveryId,
  JOURNAL_ENTRY_TYPE,
  JOURNAL_SCHEMA_VERSION,
  type JournalEvent,
  type JournalWriter,
  type RecoveryTerminalResult,
  type RunRecoveryEvent,
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
import type { WorkflowStrengthTable } from "./strengths.js";

export const MAX_ATTEMPTS_PER_NODE = 3;

const BRANCH_QUIESCE_TIMEOUT_MS = 8_000;
// Internal deadline, longer than exact-owner RPC cleanup. Scripts can await
// arbitrary promises, so cancellation cannot rely on cooperative JS unwinding.
export const EXECUTION_DRAIN_TIMEOUT_MS = 10_000;
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
  /**
   * The user's strength → Agent tier table; see WorkflowRunOptions.strengths.
   *
   * Deliberately absent from `frozenOptions`. The frozen set is the run's
   * inputs — budget, scale, toolset — which a resume must not silently
   * renegotiate. Routing is not an input: a resume already re-reads the host's
   * tier catalogue, and a table frozen against a catalogue that has since moved
   * would be the one thing in the run still pointing at the old world.
   *
   * Being unfrozen makes supplying it every resume's job, including the resumes
   * the engine starts itself — see {@link WorkflowEngine.strengths}.
   */
  strengths?: WorkflowStrengthTable;
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
    signal?: AbortSignal,
  ) => Promise<unknown>;
  /** Resolve a nested `workflow(name)` reference to the script it names. */
  loadSavedWorkflow?: (name: string) => string | undefined;
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
  /** Told once when the host reports this agent left the queue and started. */
  onRunning?: () => void;
  startedNotified: boolean;
  executionGeneration: number;
  resolve: (response: ManagedSpawnResponse) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

/**
 * Tell a waiter once that its agent started.
 *
 * Once, because the wall clock is restarted from this point: a repeated report
 * — a duplicate event, or a reply that raced its own lifecycle event — would
 * keep pushing the deadline out and quietly turn the timeout off.
 */
function notifyAgentRunning(waiter: AgentLifecycleWaiter): void {
  if (waiter.startedNotified || waiter.settled) return;
  waiter.startedNotified = true;
  try {
    waiter.onRunning?.();
  } catch {
    /* the clock is best effort; never fail a live agent over it */
  }
}

interface AgentTerminalDelivery {
  response: ManagedSpawnResponse;
  usage?: AgentUsage;
  history?: unknown[];
}

interface ManagedCallFacts {
  executionGeneration: number;
  attemptId: string;
  agentId: string;
  tokenCount?: number;
  outputFile?: string;
  compactionCount: number;
}

interface OwnedCleanup {
  agentId: string;
  spawnKey?: string;
  owner: WorkflowOwner;
  epoch: number;
  confirmed: Promise<void>;
  resolve: () => void;
  operation?: Promise<void>;
}

interface BufferedAgentTerminal extends AgentTerminalDelivery {
  owner: WorkflowOwner;
  executionGeneration: number;
}

export interface ScriptRunState {
  run: ScriptRun;
  /** Volatile, execution-fenced presentation; never journaled. */
  presentation: WorkflowPresentation;
  /** Exact-attempt metadata merged into the runtime's single schema-transformed result fact. */
  managedCallFacts: Map<string, ManagedCallFacts>;
  /** Ownership remains busy even after a cleanup deadline fences execution. */
  pendingCleanup: Set<Promise<void>>;
  activeExecutionGenerations: Set<number>;
  stopOperation?: Promise<void>;
  removeOperation?: Promise<void>;
  /** Frozen run parameters — resume reuses the original values, ignoring new budget/toolset overrides. */
  frozenOptions: Pick<
    ScriptStartOptions,
    "tokenBudget" | "maxAgents" | "concurrency" | "agentRetries" | "agentTimeoutMs" | "toolset" | "excludeTools"
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
  /** Local reservations and submitted allocations retained through terminal admission. */
  pendingSpawns: Map<
    string,
    {
      spawnKey: string;
      owner: WorkflowOwner;
      executionGeneration: number;
      phase: "reserved" | "submitted";
      startedAgentId?: string;
      agentId?: string;
    }
  >;
  /** Journal retry bookkeeping. */
  pendingJournal: Set<string>;
  /** Exact terminal append still awaiting its receipt; not a published run status. */
  pendingTerminal?: object;
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

/** Optional owned lifecycle usage is per-attempt; legacy `tokens` remains lifetime-scoped. */
function managedLifecycleUsage(raw: unknown): AgentUsage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { input, output, total } = raw as Record<string, unknown>;
  if (
    typeof input !== "number" ||
    typeof output !== "number" ||
    typeof total !== "number" ||
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    !Number.isSafeInteger(total) ||
    input < 0 ||
    output < 0 ||
    total < 0 ||
    !Number.isSafeInteger(input + output) ||
    total < input + output
  )
    return undefined;
  // The managed total includes cache writes, but excludes cache reads. The
  // additive lifecycle field has no cost/cache-read detail; do not invent it.
  return { input, output, total, cost: 0, cacheRead: 0, cacheWrite: total - input - output };
}

export class WorkflowEngine {
  private readonly runs = new Map<string, ScriptRunState>();
  /** Fired when a run settles terminal; wired by the UI surface for widget refresh. */
  onRunSettled: (() => void) | undefined;
  /** Every accepted background execution, including automatic and UI resumes. */
  onBackgroundExecution: ((runId: string) => void) | undefined;
  /** Optional in-process observer for phase/task/quality runtime events. */
  onRuntimeEvent: ((runId: string, event: WorkflowRuntimeEvent) => void) | undefined;
  /** Additive notification after accepted presentation mutations; consumers re-read getInspection(). */
  onInspectionChanged: ((runId: string) => void) | undefined;
  /** Fresh saved-workflow resolver for control and automatic resumes. */
  loadSavedWorkflow: ((name: string) => string | undefined) | undefined;
  /**
   * The user's current strength → Agent tier table, read fresh per execution.
   *
   * A callback rather than a value because the table is deliberately unfrozen:
   * "read fresh at each start and resume" has to hold for the resumes the
   * engine starts on its own — `control("resume")` and the provider-limit
   * retry — which have no caller to pass options for them. Without it those
   * resume with no table at all, and since a call's identity keys on the tier
   * it requested, every already-finished call would miss its journal entry and
   * re-run untabled: the exact re-spend this table exists to prevent.
   */
  strengths: (() => WorkflowStrengthTable | undefined) | undefined;
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
  private branchEpoch = 0;
  private admissionsClosed = false;
  private pendingAdmissions = 0;
  private recoveryBranchGeneration = 0;
  private readonly journalRetries = new Map<
    string,
    { timer?: ReturnType<typeof setTimeout>; attempt: number; done: Promise<void>; resolve: () => void }
  >();
  private readonly journalBlockedRuns = new Set<string>();
  private readonly providerResumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private journalMutationKey: string | undefined;
  private journalMutationSequence = 0;
  private readonly quarantinedRunIds = new Set<string>();
  private readonly cleanupObligations = new WeakMap<ScriptRunState, Map<string, OwnedCleanup>>();
  /** Retired states keep their exact leases; replacement states never inherit them. */
  private readonly retainedCleanupStates = new Set<ScriptRunState>();
  private readonly terminalNotified = new WeakSet<ScriptRunState>();

  constructor(
    readonly events: WorkflowEventBus,
    private readonly client: ManagedSpawnClient,
    private readonly journal: JournalWriter,
    private readonly readEntries: () => readonly SessionEntryLike[] = () => [],
    protocolGate?: () => Promise<ManagedProtocolCheck>,
    private readonly cwd: string = process.cwd(),
  ) {
    this.protocolGate =
      protocolGate ??
      (() => this.client.checkProtocol?.() ?? Promise.reject(new Error("managed protocol check is unavailable")));
    this.unsubscribeLifecycle = this.attachLifecycle();
  }

  private notifyInspection(state: ScriptRunState): void {
    state.presentation.changed();
    try {
      this.onInspectionChanged?.(state.run.runId);
    } catch {
      // Presentation observers must never change execution or durable control.
    }
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

  /** Pure exact-state cleanup uncertainty query for owner control surfaces. */
  hasPendingCleanup(runId: string): boolean {
    return (this.runs.get(runId)?.pendingCleanup.size ?? 0) > 0;
  }

  private isCurrentState(state: ScriptRunState, generation: number, epoch: number): boolean {
    return (
      this.runs.get(state.run.runId) === state &&
      state.executionGeneration === generation &&
      this.branchEpoch === epoch &&
      !state.lifecycleSuspended &&
      !this.lifecyclePaused &&
      !this.disposed
    );
  }

  private notifyTerminal(state: ScriptRunState): void {
    const generation = state.executionGeneration;
    const epoch = this.branchEpoch;
    if (
      !this.isCurrentState(state, generation, epoch) ||
      !isTerminalWorkflow(state.run.status) ||
      state.pendingTerminal !== undefined ||
      state.pendingCleanup.size > 0 ||
      this.terminalNotified.has(state)
    )
      return;
    this.terminalNotified.add(state);
    this.settleWaiters(state.run.runId, state.run);
    try {
      this.onRunSettled?.();
    } catch {
      /* terminal observers are presentation-only */
    }
  }

  /** A synchronous snapshot for cancellable navigation, not an admission lock. */
  hasUnsettledWork(): boolean {
    return (
      this.pendingAdmissions > 0 ||
      this.branchQuiescePromise !== undefined ||
      this.journalRetries.size > 0 ||
      this.providerResumeTimers.size > 0 ||
      this.retainedCleanupStates.size > 0 ||
      [...this.runs.values()].some(
        (state) =>
          state.run.status === "running" ||
          state.run.status === "pausing" ||
          state.run.status === "stopping" ||
          state.pendingSpawns.size > 0 ||
          state.agentWaiters.size > 0 ||
          state.pendingJournal.size > 0 ||
          state.pendingTerminal !== undefined ||
          state.pendingCleanup.size > 0 ||
          state.activeExecutionGenerations.size > 0 ||
          state.stopOperation !== undefined ||
          state.removeOperation !== undefined,
      )
    );
  }

  /** Pi has committed the new leaf: stop old callbacks without journaling there. */
  fenceCommittedBranch(): void {
    if (this.disposed || this.lifecyclePaused) return;
    this.branchEpoch++;
    this.admissionsClosed = true;
    this.suspendLifecycle();
    this.clearJournalRetries();
    for (const state of this.runs.values()) {
      state.lifecycleSuspended = true;
      state.presentation.reset(false);
      this.notifyInspection(state);
      state.controller.abort(new DOMException("Workflow branch replaced", "AbortError"));
    }
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
      eventName !== "subagents:failed" &&
      eventName !== "subagents:compacted"
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

    const acceptedGeneration = state.executionGeneration;
    const acceptedEpoch = this.branchEpoch;
    const current = () =>
      this.isCurrentState(state, acceptedGeneration, acceptedEpoch) && !state.controller.signal.aborted;
    const terminalEvent = eventName === "subagents:completed" || eventName === "subagents:failed";
    const hasManagedUsage = terminalEvent && "managedTokens" in data;
    const managedUsage = hasManagedUsage ? managedLifecycleUsage(data.managedTokens) : undefined;
    // A malformed present field cannot fall back to cumulative lifetime usage.
    // Reject before identity, presentation, buffering, or waiter mutations.
    if (hasManagedUsage && !managedUsage) return;

    if (eventName === "subagents:compacted") {
      this.recordManagedAdmission(state, callNodeId, agentId, state.executionGeneration);
      if (!current()) return;
      if (
        typeof data.compactionCount === "number" &&
        Number.isSafeInteger(data.compactionCount) &&
        data.compactionCount >= 0
      ) {
        const facts = state.managedCallFacts.get(callNodeId);
        if (facts) facts.compactionCount = Math.max(facts.compactionCount, data.compactionCount);
        if (state.run.attemptIds[callNodeId])
          state.run.compactions[callNodeId] = facts?.compactionCount ?? data.compactionCount;
        state.presentation.managed(callNodeId, { compactionCount: facts?.compactionCount ?? data.compactionCount });
        this.notifyInspection(state);
      }
      return;
    }
    if (updateCallTierIdentity(state, callNodeId, data.tier)) {
      this.persistCallTierIdentity(state, callNodeId);
    }
    if (!current()) return;
    this.recordManagedAdmission(state, callNodeId, agentId, state.executionGeneration);
    if (!current()) return;
    // A start is the moment the host admitted this agent from its queue. It is
    // the only signal that separates waiting for a slot from doing the work, so
    // the call's wall clock is restarted here rather than at dispatch.
    if (eventName === "subagents:started") {
      if (pendingMatches && pending) pending.startedAgentId = agentId;
      if (waiterMatches && waiter) notifyAgentRunning(waiter);
      if (!current()) return;
    }
    state.presentation.managed(callNodeId, {
      agentId,
      status: eventName === "subagents:started" ? "running" : undefined,
      ...(isManagedAgentTier(data.tier) ? { tier: data.tier } : {}),
    });
    this.notifyInspection(state);
    if (!current()) return;
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
      managedUsage !== undefined
        ? managedUsage.total
        : typeof data.tokenCount === "number"
          ? data.tokenCount
          : data.tokens &&
              typeof data.tokens === "object" &&
              typeof (data.tokens as Record<string, unknown>).total === "number"
            ? ((data.tokens as Record<string, unknown>).total as number)
            : undefined;
    state.presentation.managed(callNodeId, {
      agentId,
      status: lifecycleStatus,
      tokenCount,
      ...(typeof data.outputFile === "string" ? { outputFile: data.outputFile } : {}),
      compactionCount: Math.max(
        typeof data.compactionCount === "number" ? data.compactionCount : 0,
        state.managedCallFacts.get(callNodeId)?.compactionCount ?? 0,
      ),
    });
    this.notifyInspection(state);
    if (!current()) return;
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
      ...(managedUsage !== undefined
        ? { usage: managedUsage }
        : tokenCount === undefined
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

  private recordManagedAdmission(
    state: ScriptRunState,
    nodeId: string,
    agentId: string,
    executionGeneration: number,
  ): void {
    const attemptId = state.run.attemptIds[nodeId];
    if (!attemptId) return; // Nested facts remain volatile, owned by the parent boundary.
    const existing = state.managedCallFacts.get(nodeId);
    if (
      existing?.executionGeneration === executionGeneration &&
      existing.attemptId === attemptId &&
      existing.agentId === agentId
    )
      return;
    state.managedCallFacts.set(nodeId, { executionGeneration, attemptId, agentId, compactionCount: 0 });
    state.run.agentIds[nodeId] = agentId;
    state.run.compactions[nodeId] = 0;
    const event: JournalEvent = {
      kind: "call_transition",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: state.run.runId,
      nodeId,
      status: "running",
      agentId,
      ...(state.callTiers.get(nodeId)?.tier === undefined ? {} : { tier: state.callTiers.get(nodeId)?.tier }),
      attemptId,
      owner: { extension: "pi-workflows", runId: state.run.runId, nodeId, attemptId },
      timestamp: Date.now(),
    };
    this.persist(state.run.runId, `call-identity:${nodeId}`, () => this.write(event));
  }

  private recordManagedTerminal(
    state: ScriptRunState,
    nodeId: string,
    agentId: string,
    terminal: NonNullable<ManagedSpawnResponse["terminal"]>,
    executionGeneration: number,
  ): void {
    this.recordManagedAdmission(state, nodeId, agentId, executionGeneration);
    const facts = state.managedCallFacts.get(nodeId);
    if (
      !facts ||
      facts.executionGeneration !== executionGeneration ||
      facts.attemptId !== state.run.attemptIds[nodeId] ||
      facts.agentId !== agentId
    )
      return;
    facts.tokenCount = terminal.tokenCount;
    facts.outputFile = terminal.outputFile;
    facts.compactionCount = Math.max(facts.compactionCount, terminal.compactionCount);
  }

  /** Persist a host-normalized tier learned before the managed reply arrives. */
  private persistCallTierIdentity(state: ScriptRunState, nodeId: string): void {
    const attemptId = state.run.attemptIds[nodeId];
    const identity = state.callTiers.get(nodeId);
    // Nested workflow frames are in-memory only; only a top-level call has a
    // durable attempt owner and can safely receive a journal transition.
    if (!attemptId || identity?.tier === undefined) return;
    const event: JournalEvent = {
      kind: "call_transition",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: state.run.runId,
      nodeId,
      status: "running",
      tier: identity.tier,
      attemptId,
      owner: { extension: "pi-workflows", runId: state.run.runId, nodeId, attemptId },
      timestamp: Date.now(),
    };
    this.persist(state.run.runId, `call-tier:${nodeId}`, () => this.write(event));
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
    const epoch = this.branchEpoch;
    try {
      if (delivery.usage) waiter.onUsage?.(delivery.usage);
      if (!this.isCurrentState(state, waiter.executionGeneration, epoch) || state.controller.signal.aborted) {
        waiter.reject(new WorkflowWaitAbortedError());
        return;
      }
      if (delivery.history) waiter.onHistory?.(delivery.history);
      if (!this.isCurrentState(state, waiter.executionGeneration, epoch) || state.controller.signal.aborted) {
        waiter.reject(new WorkflowWaitAbortedError());
        return;
      }
      waiter.resolve(delivery.response);
    } catch (error) {
      // A throwing observer cannot strand a removed waiter and its child lease.
      waiter.reject(error);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeController.abort();
    this.unsubscribeLifecycle();
    this.quarantinedRunIds.clear();
    const retiredStates = [...this.runs.values()];
    for (const state of retiredStates) {
      this.cleanupAgents(state.run.runId);
      state.controller.abort(new DOMException("Workflow engine disposed", "AbortError"));
    }
    this.rejectWaiters(new WorkflowWaitAbortedError());
    this.runs.clear();
    for (const state of retiredStates) this.notifyInspection(state);
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
    if (this.branchQuiescePromise) return this.branchQuiescePromise;
    this.admissionsClosed = true;
    this.clearJournalRetries();

    // Snapshot exact states/owners, not run ids or status. Terminal and retired
    // states may still own cleanup, and observation must not donate those
    // leases to a same-id replacement on a newly committed branch.
    const states = [...new Set([...this.runs.values(), ...this.retainedCleanupStates])];
    const targets = states.flatMap((state) => {
      const owners = new Map<string, { agentId: string; owner: WorkflowOwner; generation: number }>();
      for (const pending of state.pendingSpawns.values()) {
        if (pending.phase !== "submitted") continue;
        owners.set(JSON.stringify(pending.owner), {
          agentId: pending.agentId ?? pending.startedAgentId ?? pending.spawnKey,
          owner: { ...pending.owner },
          generation: pending.executionGeneration,
        });
      }
      for (const [agentId, waiter] of state.agentWaiters) {
        const owner: WorkflowOwner = {
          extension: "pi-workflows",
          runId: state.run.runId,
          nodeId: `call-${waiter.callIndex}`,
          attemptId: `attempt-${waiter.generation}`,
        };
        owners.set(JSON.stringify(owner), { agentId, owner, generation: waiter.executionGeneration });
      }
      for (const cleanup of this.cleanupObligations.get(state)?.values() ?? []) {
        owners.set(JSON.stringify(cleanup.owner), {
          agentId: cleanup.agentId,
          owner: { ...cleanup.owner },
          generation: state.executionGeneration,
        });
      }
      return [...owners.values()].map((target) => ({ state, ...target }));
    });
    // Publish the handshake before RPC, abort or inspection can re-enter.
    let acceptOperations!: (operations: Promise<void>[]) => void;
    const operations = new Promise<Promise<void>[]>((resolve) => {
      acceptOperations = resolve;
    });
    const operation = operations.then(async (cleanup) => {
      await Promise.all(cleanup);
      const pending = [
        ...new Set(
          states.flatMap((state) =>
            [...(this.cleanupObligations.get(state)?.values() ?? [])].map((cleanup) => cleanup.agentId),
          ),
        ),
      ].slice(0, 256);
      return { settled: pending.length === 0, pending };
    });
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
    // Fence every captured state before the first notifying observer. Start
    // known-id owner checks synchronously for the bus-first shutdown handshake;
    // their positive result is consumed by the same stable cleanup obligation,
    // never treated as a status-only shortcut or a separate donated lease.
    for (const state of states) state.lifecycleSuspended = true;
    acceptOperations(
      targets.map(({ state, agentId, owner, generation }) => {
        const existing = [...(this.cleanupObligations.get(state)?.values() ?? [])].find((cleanup) =>
          sameWorkflowOwner(cleanup.owner, owner),
        );
        let quiescence: Promise<{ settled: boolean; pending: string[] }> | undefined;
        if (!existing?.operation && agentId !== `${owner.runId}/${owner.nodeId}/${owner.attemptId}`) {
          try {
            quiescence = this.client.quiesceOwned?.(owner.runId, [agentId], BRANCH_QUIESCE_TIMEOUT_MS, [owner]);
          } catch (error) {
            quiescence = Promise.reject(error);
          }
          void quiescence?.catch(() => {});
        }
        return this.stopAndQuiesce(state, agentId, owner, generation, undefined, quiescence);
      }),
    );
    for (const state of states) {
      state.bufferedTerminals.clear();
      state.controller.abort(new DOMException("Workflow branch change", "AbortError"));
      state.presentation.reset(false);
      this.notifyInspection(state);
    }
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
    if (this.lifecyclePaused || this.admissionsClosed) throw new Error("Workflow branch is not ready");
    const epoch = this.branchEpoch;
    this.pendingAdmissions++;
    let protocol: ManagedProtocolCheck;
    try {
      protocol = await this.awaitProtocol();
    } finally {
      this.pendingAdmissions--;
    }
    if (this.disposed) throw new WorkflowEngineDisposedError();
    if (epoch !== this.branchEpoch || this.lifecyclePaused || this.admissionsClosed)
      throw new Error("Workflow branch changed before admission");
    const { meta } = parseWorkflowScript(script);
    const now = Date.now();
    const runId = randomUUID();
    const scriptHash = hashScript(script);
    const toolset = options.toolset;
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
      ...(toolset ? { toolset } : {}),
      ...(frozenMaxAgents !== undefined ? { frozenMaxAgents } : {}),
      ...(frozenConcurrency !== undefined ? { frozenConcurrency } : {}),
      ...(frozenAgentRetries !== undefined ? { frozenAgentRetries } : {}),
      ...(frozenTokenBudget !== undefined ? { frozenTokenBudget } : {}),
      ...(frozenAgentTimeoutMs !== undefined ? { frozenAgentTimeoutMs } : {}),
      ...(options.excludeTools ? { frozenExcludeTools: [...options.excludeTools] } : {}),
      timestamp: now,
    });
    if (epoch !== this.branchEpoch || this.disposed || this.lifecyclePaused || this.admissionsClosed)
      throw new Error("Workflow branch changed before admission");
    const state: ScriptRunState = {
      run,
      presentation: new WorkflowPresentation(runId),
      managedCallFacts: new Map(),
      pendingCleanup: new Set(),
      activeExecutionGenerations: new Set(),
      frozenOptions: {
        ...(frozenTokenBudget !== undefined ? { tokenBudget: frozenTokenBudget } : {}),
        ...(frozenMaxAgents !== undefined ? { maxAgents: frozenMaxAgents } : {}),
        ...(frozenConcurrency !== undefined ? { concurrency: frozenConcurrency } : {}),
        ...(frozenAgentRetries !== undefined ? { agentRetries: frozenAgentRetries } : {}),
        ...(frozenAgentTimeoutMs !== undefined ? { agentTimeoutMs: frozenAgentTimeoutMs } : {}),
        ...(options.toolset ? { toolset: options.toolset } : {}),
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
    // Accept identity before any synchronous running/root observer can stop or
    // replace this state. Dispatch is deferred until its promise is published.
    const generation = ++state.executionGeneration;
    state.presentation.reset();
    state.execution = Promise.resolve().then(() =>
      this.execute(state, script, startOptions, undefined, generation, epoch, protocol),
    );
    const execution = state.execution;
    // A run-fatal abort/stop already journals its terminal state; never let a
    // leftover rejection become an unhandled promise rejection.
    void execution.catch(() => {});
    this.setWorkflowStatus(run, "running");
    if (this.isCurrentState(state, generation, epoch)) this.notifyInspection(state);
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
      // Foreground cancellation owns execution, not just this waiter. Do not
      // advertise resumability until runtime children and checkpoint UI unwind.
      // A failed receipt can outlive execution; retire it before aborting too.
      state.pendingTerminal = undefined;
      state.controller.abort();
      await this.drainExecution(state, execution);
      this.recoverInterruptedExecution(state, generation, epoch);
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
    if (this.lifecyclePaused || this.admissionsClosed) throw new Error("Workflow branch is not ready");
    const epoch = this.branchEpoch;
    this.pendingAdmissions++;
    let protocol: ManagedProtocolCheck;
    try {
      protocol = await this.awaitProtocol();
    } finally {
      this.pendingAdmissions--;
    }
    if (this.disposed) throw new WorkflowEngineDisposedError();
    if (epoch !== this.branchEpoch || this.lifecyclePaused || this.admissionsClosed)
      throw new Error("Workflow branch changed before admission");
    const state = this.runs.get(runId);
    if (!state) return undefined;
    if (state.lifecycleSuspended || state.removeOperation) return undefined;
    const run = state.run;
    if (run.status === "running" || run.status === "pausing" || run.status === "stopping") return undefined;
    const providerTimer = this.providerResumeTimers.get(runId);
    if (providerTimer) {
      clearTimeout(providerTimer);
      this.providerResumeTimers.delete(runId);
    }
    if (
      run.nonResumable ||
      run.terminalIntent === "stop" ||
      (isTerminalWorkflow(run.status) && run.status !== "failed" && run.status !== "stopped")
    )
      return undefined;
    if (isTerminalWorkflow(run.status)) {
      await this.drainExecution(state, state.execution);
      for (const [nodeId, agentId] of Object.entries(run.agentIds)) {
        if (run.callStatus[nodeId] !== "running") continue; // Completed/local calls own no live child.
        const attemptId = run.attemptIds[nodeId];
        if (!attemptId) continue;
        await this.stopAndQuiesce(
          state,
          agentId,
          {
            extension: "pi-workflows",
            runId,
            nodeId: `call-${nodeId}`,
            attemptId: `attempt-${generationFromAttemptId(attemptId)}`,
          },
          state.executionGeneration,
        );
      }
      if (run.nonResumable || this.runs.get(runId) !== state || epoch !== this.branchEpoch || this.lifecyclePaused)
        return undefined;
      if (
        this.journalBlockedRuns.has(runId) ||
        [...this.journalRetries.keys()].some((key) => key.startsWith(`${runId}\u0000`))
      )
        throw new Error("Workflow journal has not settled; retry resume after persistence recovers");
      const timestamp = Date.now();
      const recovery: RunRecoveryEvent = {
        kind: "run_recovery",
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        runId,
        status: "interrupted",
        branchGeneration: this.recoveryBranchGeneration,
        rotations: [],
        recoveryId: deriveRecoveryId({ runId, rotations: [], timestamp }),
        timestamp,
      };
      this.appendRequired(recovery);
      if (!this.isCurrentState(state, state.executionGeneration, epoch)) return undefined;
      applyRecoveryEvent(run, recovery);
      state.result = undefined;
    }
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
    if (!this.isCurrentState(state, state.executionGeneration, epoch)) return undefined;
    // Arguments are frozen in every schema-v4 run_created fact. Resume never accepts
    // replacement args and never backfills the pre-schema-v4 run_args contract.
    const resumeArgs = cloneWorkflowArgs(run.args);
    const resumeJournal = buildResumeJournal(entries);
    // Seed generation bases from journaled attemptIds so a live re-dispatch of a
    // previously-journaled call never reuses a spawnKey (A4).
    for (const [callIndex, attemptId] of Object.entries(run.attemptIds)) {
      state.generations.set(callIndex, generationFromAttemptId(attemptId));
    }
    // Freeze semantics: original run parameters and args win over new options.
    // Only signal/confirm/background/loadSavedWorkflow/mainModel/strengths are
    // per-resume context; input/budget/scale/toolset are frozen from the
    // original start.
    const frozen = state.frozenOptions;
    const resumeOptions: ScriptStartOptions = {
      ...options,
      // `??`, not an overwrite: a caller that passed a table meant it, and only
      // a caller that passed none is asking the engine to read the current one.
      strengths: options.strengths ?? this.strengths?.(),
      args: resumeArgs,
      loadSavedWorkflow: options.loadSavedWorkflow ?? this.loadSavedWorkflow,
      tokenBudget: frozen.tokenBudget,
      maxAgents: frozen.maxAgents,
      concurrency: frozen.concurrency,
      agentRetries: frozen.agentRetries,
      agentTimeoutMs: frozen.agentTimeoutMs,
      toolset: frozen.toolset,
      excludeTools: frozen.excludeTools ? [...frozen.excludeTools] : undefined,
    };
    if (!this.isCurrentState(state, state.executionGeneration, epoch) || run.nonResumable || state.stopOperation)
      return undefined;
    state.bufferedTerminals.clear();
    this.terminalNotified.delete(state);
    state.controller = new AbortController();
    const generation = ++state.executionGeneration;
    const acceptedScript = run.script;
    state.presentation.reset();
    state.execution = Promise.resolve().then(() =>
      this.execute(state, acceptedScript, resumeOptions, resumeJournal, generation, epoch, protocol),
    );
    const execution = state.execution;
    void execution.catch(() => {});
    this.setWorkflowStatus(run, "running");
    if (this.isCurrentState(state, generation, epoch)) this.notifyInspection(state);
    if (options.background) {
      this.onBackgroundExecution?.(runId);
      return { runId, status: run.status, background: true };
    }
    try {
      const settled = await this.waitFor(runId, options.signal);
      return { runId, status: settled.status, background: false };
    } catch (error: unknown) {
      if (!(error instanceof WorkflowWaitAbortedError)) throw error;
      state.pendingTerminal = undefined;
      state.controller.abort();
      await this.drainExecution(state, execution);
      this.recoverInterruptedExecution(state, generation, epoch);
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
        const generation = state.executionGeneration;
        const epoch = this.branchEpoch;
        this.setWorkflowStatus(run, "pausing");
        this.reconcilePendingSpawns(state);
        // Abort the script execution; the run settles as interrupted and can be
        // resumed from the journal. The script's in-flight agents are stopped by
        // the runtime's abort signal via the dispatch waiters.
        state.controller.abort();
        await this.drainExecution(state, state.execution);
        this.recoverInterruptedExecution(state, generation, epoch);
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
      await this.remove(state);
      return { action, run: this.summary(run) };
    }
    return { action, run: this.summary(run) };
  }

  async waitFor(runId: string, signal?: AbortSignal): Promise<ScriptRun> {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`workflow run not found: ${runId}`);
    if (isTerminalWorkflow(state.run.status) && state.pendingCleanup.size > 0) throw new WorkflowWaitAbortedError();
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
    const state = this.runs.get(runId);
    if (
      state?.run !== run ||
      !this.isCurrentState(state, state.executionGeneration, this.branchEpoch) ||
      state.pendingTerminal !== undefined ||
      this.hasPendingCleanup(runId) ||
      (!isTerminalWorkflow(run.status) && run.status !== "paused" && run.status !== "interrupted")
    )
      return;
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

  private recoverInterruptedExecution(state: ScriptRunState, generation: number, epoch: number): void {
    const run = state.run;
    const current = () =>
      this.runs.get(run.runId) === state &&
      state.executionGeneration === generation &&
      this.branchEpoch === epoch &&
      !this.disposed &&
      !state.stopOperation &&
      (run.status === "running" || run.status === "pausing");
    if (!current()) return;
    // Cancellation takes ownership before interruption is visible. An abandoned
    // completed/failed receipt must neither publish later nor block old waiters.
    state.pendingTerminal = undefined;
    const timestamp = Date.now();
    const recovery: RunRecoveryEvent = {
      kind: "run_recovery",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: run.runId,
      status: "interrupted",
      branchGeneration: this.recoveryBranchGeneration,
      rotations: [],
      recoveryId: deriveRecoveryId({ runId: run.runId, rotations: [], timestamp }),
      timestamp,
    };
    this.persist(run.runId, "abort-recovery", () => this.write(recovery));
    if (!current()) return;
    run.status = "interrupted";
    run.updatedAt = timestamp;
    // A pending failed receipt can outlive execute(). In that case there is no
    // finally left to publish interruption or settle pre-existing waiters.
    if (!state.activeExecutionGenerations.has(generation)) {
      state.presentation.settle(run.status);
      this.notifyInspection(state);
      this.settleWaiters(run.runId, run);
    }
  }

  private async execute(
    state: ScriptRunState,
    script: string,
    options: ScriptStartOptions,
    resumeJournal: Map<string, JournalEntry> | undefined,
    generation: number,
    epoch: number,
    protocol?: ManagedProtocolCheck,
  ): Promise<WorkflowRunResult<unknown>> {
    const runId = state.run.runId;
    state.activeExecutionGenerations.add(generation);
    const isSameBranch = () =>
      this.runs.get(runId) === state &&
      state.executionGeneration === generation &&
      this.branchEpoch === epoch &&
      !this.disposed;
    const isCurrent = () => isSameBranch() && !state.lifecycleSuspended && !this.lifecyclePaused;
    const isPresentationCurrent = () => isCurrent() && state.activeExecutionGenerations.has(generation);
    const explicitlyStopped = () => state.stopOperation !== undefined || state.run.terminalIntent === "stop";
    const executionSignal =
      !options.background && options.signal
        ? AbortSignal.any([state.controller.signal, options.signal])
        : state.controller.signal;

    const cleanupTasks = new Set<Promise<void>>();
    const runner: WorkflowAgentRunner = {
      run: async (prompt: string, runOptions: AgentRunOptions = {}) => {
        if (!isCurrent() || executionSignal.aborted || explicitlyStopped())
          throw new WorkflowError("stale workflow execution", WorkflowErrorCode.WORKFLOW_ABORTED);
        const dispatch = this.dispatchAgent(runId, prompt, runOptions);
        const settled = dispatch.then(
          () => {},
          () => {},
        );
        const trackCleanup = () => {
          cleanupTasks.add(settled);
          void settled.then(() => cleanupTasks.delete(settled));
        };
        runOptions.signal?.addEventListener("abort", trackCleanup, { once: true });
        if (runOptions.signal?.aborted) trackCleanup();
        try {
          return await dispatch;
        } catch (error: unknown) {
          if (isCurrent()) {
            const frameId = runOptions.runId ?? runId;
            const nodeId =
              frameId === runId ? String(runOptions.callIndex ?? 0) : `${frameId}:${runOptions.callIndex ?? 0}`;
            state.presentation.managed(nodeId, { status: runOptions.signal?.aborted ? "stopped" : "failed" });
            this.notifyInspection(state);
          }
          throw error;
        } finally {
          runOptions.signal?.removeEventListener("abort", trackCleanup);
        }
      },
      waitForCleanup: () => this.drainExecution(state, Promise.all([...cleanupTasks])),
    };

    try {
      if (!isCurrent() || executionSignal.aborted || explicitlyStopped())
        throw new WorkflowError("workflow execution aborted before dispatch", WorkflowErrorCode.WORKFLOW_ABORTED);
      const result = await runWorkflow(script, {
        cwd: this.cwd,
        args: options.args,
        agent: runner,
        mainModel: options.mainModel,
        ...(protocol === undefined
          ? {}
          : {
              routingPolicy: protocol.routingPolicy,
              routingPolicyFingerprint: protocol.routingPolicyFingerprint,
              // Read live at each start and resume, never frozen onto the run:
              // the pool is a host setting the user can change between them, and
              // a run that outlived a narrowing would dispatch into a queue.
              ...(protocol.maxConcurrent === undefined ? {} : { hostMaxConcurrent: protocol.maxConcurrent }),
            }),
        concurrency: options.concurrency,
        agentRetries: options.agentRetries,
        tokenBudget: options.tokenBudget,
        agentTimeoutMs: options.agentTimeoutMs,
        signal: executionSignal,
        maxAgents: options.maxAgents,
        runId,
        executionNonce: `${generation}-${randomUUID()}`,
        resumeJournal,
        resumeWorkflowGenerations: new Map(
          Object.entries(state.run.workflowResultGenerations).map(([index, generation]) => [Number(index), generation]),
        ),
        toolset: options.toolset,
        strengths: options.strengths,
        excludeTools: options.excludeTools,
        confirm:
          options.confirm &&
          (async (prompt, checkpointOptions, signal) => {
            if (!isCurrent() || executionSignal.aborted || signal?.aborted || state.stopOperation)
              throw new WorkflowError("stale workflow checkpoint", WorkflowErrorCode.WORKFLOW_ABORTED);
            const value = await options.confirm?.(prompt, checkpointOptions, signal);
            if (!isCurrent() || executionSignal.aborted || signal?.aborted)
              throw new WorkflowError("stale workflow checkpoint", WorkflowErrorCode.WORKFLOW_ABORTED);
            return value;
          }),
        loadSavedWorkflow: options.loadSavedWorkflow,
        onAgentStart: (event) => {
          if (!isPresentationCurrent()) return;
          state.presentation.agentStart(event);
          this.notifyInspection(state);
        },
        onAgentEnd: (event) => {
          if (!isPresentationCurrent()) return;
          const nodeId = event.id.startsWith(`${runId}:`) ? event.id.slice(runId.length + 1) : undefined;
          const persisted = nodeId === undefined ? undefined : state.run.callResults[nodeId];
          const persistedTokens =
            nodeId !== undefined && persisted?.attemptId === state.run.attemptIds[nodeId]
              ? persisted?.tokenCount
              : undefined;
          // Runtime replay reports zero new spend, not the historical call's
          // usage. Explicit managed zero is also authoritative over estimates.
          const tokenCount = event.tokenUsage?.total ?? persistedTokens ?? event.tokens;
          state.presentation.agentEnd({ ...event, tokens: tokenCount });
          this.notifyInspection(state);
        },
        onLog: (message, scope) => {
          if (!isPresentationCurrent()) return;
          state.presentation.log(message, scope?.frameId);
          this.notifyInspection(state);
        },
        onAgentJournal: (entry) => {
          if (!isCurrent()) return;
          // Persist the accepted owner before presentation observers can replace it.
          // Nested frames are owned by their parent's workflow_result boundary.
          if (entry.runId === undefined || entry.runId === runId) this.journalCallResult(runId, entry);
          if (!isCurrent()) return;
          state.presentation.journalResult(entry.runId ?? runId, entry.index, entry.result);
          this.notifyInspection(state);
        },
        onWorkflowJournal: (entry) => {
          if (!isCurrent()) return;
          this.journalWorkflowResult(runId, entry);
          if (!isCurrent()) return;
          state.presentation.journalResult(entry.runId ?? runId, entry.index, entry.result);
          this.notifyInspection(state);
        },
        onRuntimeEvent: (event) => {
          if (!isPresentationCurrent()) return;
          state.presentation.runtime(event);
          this.notifyInspection(state);
          if (!isPresentationCurrent()) return;
          try {
            this.events.emit("pi-workflows:runtime", { runId, event: cloneRuntimeEvent(event) });
          } catch {
            // Cross-extension observers cannot change workflow execution.
          }
          if (!isPresentationCurrent()) return;
          try {
            this.onRuntimeEvent?.(runId, cloneRuntimeEvent(event));
          } catch {
            // UI observers are diagnostic surfaces and are independently contained.
          }
        },
      });
      await runner.waitForCleanup?.();
      if (executionSignal.aborted) {
        throw new WorkflowError("workflow execution aborted", WorkflowErrorCode.WORKFLOW_ABORTED, {
          recoverable: true,
        });
      }
      // A terminal frame cannot overtake accepted journal facts. In particular,
      // a delayed call_attempt must precede its result, not reset it on replay.
      await this.drainJournal(runId);
      if (
        executionSignal.aborted ||
        !isCurrent() ||
        state.run.status === "stopping" ||
        state.stopOperation !== undefined ||
        state.run.terminalIntent === "stop"
      )
        throw new WorkflowError("workflow execution aborted", WorkflowErrorCode.WORKFLOW_ABORTED, {
          recoverable: true,
        });
      const live = this.runs.get(runId);
      const run = live?.run;
      if (run && isSameBranch() && !isTerminalWorkflow(run.status)) {
        this.setWorkflowStatus(run, "completed", undefined, undefined, result.result);
        // Keep execution ownership until this newly accepted terminal fact has
        // its receipt too. Pause/stop may invalidate it while retries drain.
        await this.drainJournal(runId);
        if (!isCurrent() || executionSignal.aborted || run.status !== "completed")
          throw new WorkflowError("workflow execution aborted", WorkflowErrorCode.WORKFLOW_ABORTED, {
            recoverable: true,
          });
      }
      return result;
    } catch (error: unknown) {
      await runner.waitForCleanup?.();
      const run = this.runs.get(runId)?.run;
      if (run && isSameBranch() && !isTerminalWorkflow(run.status) && run.status !== "stopping") {
        const message = describeWorkflowError(error);
        const workflowError = error instanceof WorkflowError ? error : wrapError(error);
        if (workflowError.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT) {
          this.setWorkflowStatus(run, "paused", message);
          this.cleanupAgents(runId);
          this.scheduleProviderResume(runId, workflowError.resetHint);
        } else if (workflowError.code === WorkflowErrorCode.WORKFLOW_ABORTED && executionSignal.aborted) {
          this.recoverInterruptedExecution(state, generation, epoch);
        } else {
          this.cleanupAgents(runId);
          this.setWorkflowStatus(run, "failed", message);
        }
      }
      throw error;
    } finally {
      state.activeExecutionGenerations.delete(generation);
      // Reject any waiters that never settled (agents left in flight).
      const run = this.runs.get(runId)?.run;
      if (run && isSameBranch()) {
        if (isCurrent()) {
          state.presentation.settle(run.status);
          this.notifyInspection(state);
        }
        if (isSameBranch() && run.status !== "stopping") this.settleWaiters(runId, run);
      }
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
    if (state.lifecycleSuspended || state.controller.signal.aborted || runOptions.signal?.aborted) {
      throw new WorkflowError("workflow branch is quiescing", WorkflowErrorCode.WORKFLOW_ABORTED, {
        recoverable: true,
      });
    }
    const run = state.run;
    const executionGeneration = state.executionGeneration;
    const dispatchEpoch = this.branchEpoch;
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
    state.managedCallFacts.delete(nodeId);
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
      // Match journal replay's call_attempt semantics: historical results stay
      // durable, but are not current facts for this accepted live rotation.
      run.callStatus[nodeId] = "running";
      run.attempts[nodeId] = generation;
      run.attemptIds[nodeId] = attemptId;
      delete run.agentIds[nodeId];
      delete run.callResults[nodeId];
      run.compactions[nodeId] = 0;
      run.updatedAt = Date.now();
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
      if (
        !this.isCurrentState(state, executionGeneration, dispatchEpoch) ||
        runOptions.signal?.aborted ||
        state.controller.signal.aborted
      )
        throw new WorkflowError("stale workflow attempt", WorkflowErrorCode.WORKFLOW_ABORTED);
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
    const pending = {
      spawnKey,
      owner,
      executionGeneration,
      phase: "reserved" as "reserved" | "submitted",
      startedAgentId: undefined as string | undefined,
      agentId: undefined as string | undefined,
    };
    // Keep this exact allocation lease through every publication callback and
    // terminal delivery. A waiter alone is insufficient: it is removed before
    // onUsage/onHistory, which may synchronously pause or replace the branch.
    state.pendingSpawns.set(spawnKey, pending);
    let responseId: string | undefined;
    let terminalAccepted = false;
    let ownedCleanup: Promise<void> | undefined;
    const cleanupResponse = () =>
      (ownedCleanup ??= this.stopAndQuiesce(
        state,
        responseId ?? pending.startedAgentId ?? spawnKey,
        owner,
        executionGeneration,
      ));
    try {
      state.presentation.dispatch(runOptions, attemptId);
      this.notifyInspection(state);
      if (!this.isCurrentState(state, executionGeneration, dispatchEpoch) || externalSignal.aborted)
        throw new WorkflowError("stale workflow dispatch", WorkflowErrorCode.WORKFLOW_ABORTED);
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
        // Reservation is local until this exact boundary. Observers above can
        // cancel without creating uncertainty for an RPC that was never sent.
        pending.phase = "submitted";
        response = await this.client.spawn(task, runId, spawnNodeId, spawnAttemptId, externalSignal);
      } catch (error: unknown) {
        // Transport failure is not evidence that the host never allocated. Keep
        // the exact spawn owner even without a reply or an aborted signal.
        await cleanupResponse();
        throw error;
      } finally {
        externalSignal.removeEventListener("abort", onPendingAbort);
      }
      responseId = typeof response === "string" ? response : response.id;
      pending.agentId = responseId;
      if (
        state.executionGeneration !== executionGeneration ||
        this.runs.get(runId) !== state ||
        this.branchEpoch !== dispatchEpoch ||
        state.lifecycleSuspended ||
        this.lifecyclePaused ||
        state.controller.signal.aborted ||
        externalSignal.aborted
      ) {
        state.bufferedTerminals.delete(spawnKey);
        await cleanupResponse();
        throw new WorkflowError(
          "workflow dispatch became stale during pause/resume",
          WorkflowErrorCode.WORKFLOW_ABORTED,
          { recoverable: true },
        );
      }
      if (typeof response !== "string" && updateCallTierIdentity(state, nodeId, response.tier)) {
        this.persistCallTierIdentity(state, nodeId);
      }
      if (!this.isCurrentState(state, executionGeneration, dispatchEpoch) || externalSignal.aborted)
        throw new WorkflowError("stale workflow identity", WorkflowErrorCode.WORKFLOW_ABORTED);
      this.recordManagedAdmission(state, nodeId, responseId, executionGeneration);
      if (!this.isCurrentState(state, executionGeneration, dispatchEpoch) || externalSignal.aborted)
        throw new WorkflowError("stale workflow admission", WorkflowErrorCode.WORKFLOW_ABORTED);
      if (typeof response !== "string" && response.terminal)
        this.recordManagedTerminal(state, nodeId, responseId, response.terminal, executionGeneration);
      const bufferedTerminal = state.bufferedTerminals.get(spawnKey);
      const observedTerminal =
        bufferedTerminal?.response.id === responseId &&
        bufferedTerminal.executionGeneration === executionGeneration &&
        sameWorkflowOwner(bufferedTerminal.owner, owner)
          ? bufferedTerminal.response.terminal
          : undefined;
      const observedRunning = pending.startedAgentId === responseId;
      state.presentation.managed(nodeId, {
        agentId: responseId,
        status: observedTerminal
          ? managedTerminalStatus(observedTerminal)
          : observedRunning
            ? "running"
            : typeof response === "string"
              ? "pending"
              : response.state === "queued"
                ? "queued"
                : "running",
        tier: state.callTiers.get(nodeId)?.tier,
        ...(typeof response !== "string" && response.terminal
          ? {
              status: managedTerminalStatus(response.terminal),
              tokenCount: response.terminal.tokenCount,
              outputFile: response.terminal.outputFile,
              compactionCount: Math.max(
                response.terminal.compactionCount,
                state.managedCallFacts.get(nodeId)?.compactionCount ?? 0,
              ),
            }
          : {}),
      });
      this.notifyInspection(state);
      if (!this.isCurrentState(state, executionGeneration, dispatchEpoch) || externalSignal.aborted)
        throw new WorkflowError("stale workflow dispatch", WorkflowErrorCode.WORKFLOW_ABORTED);
      // Report the tier the host actually selected back to the runtime, which
      // journals it: a call that named none still resolved to something, and the
      // run's own record of what ran should say what.
      const resolvedTierIdentity = state.callTiers.get(nodeId);
      if (resolvedTierIdentity?.tier !== undefined) runOptions.onTierResolved?.(resolvedTierIdentity.tier);
      if (!this.isCurrentState(state, executionGeneration, dispatchEpoch) || externalSignal.aborted)
        throw new WorkflowError("stale workflow dispatch", WorkflowErrorCode.WORKFLOW_ABORTED);
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
        if (!this.isCurrentState(state, executionGeneration, dispatchEpoch) || externalSignal.aborted)
          throw new WorkflowError("stale workflow terminal", WorkflowErrorCode.WORKFLOW_ABORTED);
        terminalAccepted = true;
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
        if (!this.isCurrentState(state, executionGeneration, dispatchEpoch) || externalSignal.aborted)
          throw new WorkflowError("stale workflow terminal", WorkflowErrorCode.WORKFLOW_ABORTED);
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
          // Stop acknowledges cancellation, not provider/tool finally completion.
          void cleanupResponse().then(async () => {
            if (
              !nested &&
              this.runs.get(runId) === state &&
              state.executionGeneration === executionGeneration &&
              !run.nonResumable
            ) {
              const result = resultFromLifecycle(
                "stopped",
                pendingId,
                undefined,
                "workflow call cancelled",
                run.compactions[nodeId] ?? 0,
                undefined,
                resolvedTierIdentity?.tier ?? tier,
              );
              result.attemptId = attemptId;
              try {
                await this.drainJournal(runId);
                if (!this.isCurrentState(state, executionGeneration, dispatchEpoch)) {
                  waiter.reject(new WorkflowWaitAbortedError());
                  return;
                }
                this.commitCallTerminal(runId, nodeId, result, true);
              } catch (error) {
                this.fenceExecution(
                  state,
                  executionGeneration,
                  "Could not persist cancelled call terminal fact; run is non-resumable",
                );
                waiter.reject(error);
                return;
              }
            }
            waiter.reject(
              new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true }),
            );
          });
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
          onRunning: runOptions.onRunning,
          startedNotified: false,
          settled: false,
          resolve,
          reject,
        };
        state.agentWaiters.set(pendingId, waiter);
        // A spawn that was admitted straight away is already running, and its
        // `subagents:started` event fired before this waiter existed. Only a
        // reply that says "queued" still has a start to wait for.
        if (observedRunning || (typeof response !== "string" && response.state !== "queued"))
          notifyAgentRunning(waiter);
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

      if (
        this.runs.get(runId) !== state ||
        this.branchEpoch !== dispatchEpoch ||
        state.lifecycleSuspended ||
        this.lifecyclePaused
      ) {
        throw new WorkflowError("stale workflow terminal", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
      }
      const snapshot = terminal.terminal;
      if (!snapshot)
        throw new WorkflowError(
          "subagent settled without a terminal snapshot",
          WorkflowErrorCode.AGENT_EXECUTION_ERROR,
          {
            recoverable: true,
          },
        );
      this.recordManagedTerminal(state, nodeId, terminal.id, snapshot, executionGeneration);
      state.presentation.managed(nodeId, {
        agentId: terminal.id,
        status: managedTerminalStatus(snapshot),
        tokenCount: snapshot.tokenCount,
        outputFile: snapshot.outputFile,
        compactionCount: Math.max(snapshot.compactionCount, state.managedCallFacts.get(nodeId)?.compactionCount ?? 0),
      });
      this.notifyInspection(state);
      if (!this.isCurrentState(state, executionGeneration, dispatchEpoch))
        throw new WorkflowError("stale workflow terminal", WorkflowErrorCode.WORKFLOW_ABORTED);
      if (externalSignal.aborted) throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED);
      terminalAccepted = true;
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
      if (!this.isCurrentState(state, executionGeneration, dispatchEpoch) || externalSignal.aborted)
        throw new WorkflowError("stale workflow terminal", WorkflowErrorCode.WORKFLOW_ABORTED);
      return snapshot.result ?? "";
    } finally {
      // Publication does not donate ownership to an observer or a replacement
      // state. Even a terminal reply must STOP + QUIESCE its captured owner
      // when observation retired this dispatch.
      if (
        pending.phase === "submitted" &&
        (!terminalAccepted || !this.isCurrentState(state, executionGeneration, dispatchEpoch) || externalSignal.aborted)
      )
        await cleanupResponse();
      state.pendingSpawns.delete(spawnKey);
      state.bufferedTerminals.delete(spawnKey);
    }
  }

  private journalCallResult(runId: string, entry: JournalEntry): void {
    entry = structuredClone(entry);
    const state = this.runs.get(runId);
    if (!state) return;
    const run = state.run;
    const executionGeneration = state.executionGeneration;
    const epoch = this.branchEpoch;
    const nodeId = String(entry.index);
    const result = entry.result;
    const callTierIdentity: CallTierIdentity =
      entry.tier === undefined ? (run.callTiers[nodeId] ?? {}) : { tier: entry.tier };
    const managed = state.managedCallFacts.get(nodeId);
    const currentManaged =
      managed?.executionGeneration === state.executionGeneration && managed.attemptId === run.attemptIds[nodeId]
        ? managed
        : undefined;
    const callResult: CallResult = {
      ...(currentManaged
        ? {
            agentId: currentManaged.agentId,
            ...(currentManaged.tokenCount === undefined ? {} : { tokenCount: currentManaged.tokenCount }),
            ...(currentManaged.outputFile === undefined ? {} : { outputFile: currentManaged.outputFile }),
          }
        : {}),
      status: "completed",
      ...(typeof result === "string" && result.length === 0 ? {} : { result }),
      ...callTierIdentity,
      compactionCount: currentManaged?.compactionCount ?? 0,
      updatedAt: Date.now(),
    };
    // Checkpoints are local calls, not managed children. Give their completed
    // result a journal identity without fabricating a manager record.
    if (!run.attemptIds[nodeId]) {
      const generation = (state.generations.get(nodeId) ?? 0) + 1;
      const attemptId = `${runId}/${nodeId}/attempt-${generation}`;
      this.appendRequired({
        kind: "call_attempt",
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        runId,
        nodeId,
        attemptId,
        generation,
        owner: { extension: "pi-workflows", runId, nodeId, attemptId },
        timestamp: Date.now(),
      });
      if (!this.isCurrentState(state, executionGeneration, epoch)) return;
      state.generations.set(nodeId, generation);
      run.attemptTracking = true;
      run.attempts[nodeId] = generation;
      run.attemptIds[nodeId] = attemptId;
      run.callStatus[nodeId] = "running";
    }
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
    const acceptedEvent = structuredClone(event);
    this.persist(runId, `call-result:${nodeId}`, () => this.write(acceptedEvent));
    if (!this.isCurrentState(state, executionGeneration, epoch)) return;
    run.callResults[nodeId] = callResult;
    run.callTiers[nodeId] = callResult.tier === undefined ? {} : { tier: callResult.tier };
    run.callStatus[nodeId] = "completed";
    run.compactions[nodeId] = callResult.compactionCount;
    state.managedCallFacts.delete(nodeId);
    run.updatedAt = Date.now();
  }

  private journalWorkflowResult(runId: string, entry: JournalEntry): void {
    entry = structuredClone(entry);
    const state = this.runs.get(runId);
    if (!state) return;
    const generation = state.executionGeneration;
    const epoch = this.branchEpoch;
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
    if (!this.isCurrentState(state, generation, epoch)) return;
    state.run.workflowResultGenerations[nodeId] = event.generation;
    state.run.callResults[nodeId] = result;
    state.run.callTiers[nodeId] = result.tier === undefined ? {} : { tier: result.tier };
    state.run.callStatus[nodeId] = "completed";
    state.run.updatedAt = Date.now();
  }

  private commitCallTerminal(runId: string, nodeId: string, result: CallResult, required = false): void {
    const state = this.runs.get(runId);
    if (!state) return;
    const run = state.run;
    const generation = state.executionGeneration;
    const epoch = this.branchEpoch;
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
    if (required) this.appendRequired(event);
    else this.persist(runId, `call-terminal:${nodeId}`, () => this.write(event));
    if (!this.isCurrentState(state, generation, epoch)) return;
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
      if (pending.phase !== "submitted" || pending.agentId) continue;
      const reconciliation = this.client.reconcileManaged?.(pending.spawnKey, pending.owner);
      void reconciliation?.catch(() => {});
    }
    // Reconciliation is not positive exact-owner quiescence. The allocation
    // lease remains with dispatch until terminal admission or owned cleanup.
    state.bufferedTerminals.clear();
  }

  private cleanupAgents(runId: string): void {
    const state = this.runs.get(runId);
    if (!state) return;
    // Retain captured allocations before reconciliation, abort, or branch replay
    // can notify observers. Dispatch's finally may not run until a later turn;
    // its cleanup and any waiter cleanup share this stable exact-owner lease.
    for (const pending of state.pendingSpawns.values()) {
      if (pending.phase !== "submitted") continue;
      const agentId = pending.agentId ?? pending.startedAgentId ?? pending.spawnKey;
      void this.stopAndQuiesce(state, agentId, pending.owner, pending.executionGeneration);
    }
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
      void this.stopAndQuiesce(
        state,
        agentId,
        {
          extension: "pi-workflows",
          runId,
          nodeId: `call-${waiter.callIndex}`,
          attemptId: `attempt-${waiter.generation}`,
        },
        state.executionGeneration,
      );
    }
  }

  private async stopAndQuiesce(
    state: ScriptRunState,
    agentId: string,
    owner: WorkflowOwner,
    executionGeneration: number,
    unconfirmed?: string,
    quiescence?: Promise<{ settled: boolean; pending: string[] }>,
  ): Promise<void> {
    const obligations = this.cleanupObligations.get(state) ?? new Map<string, OwnedCleanup>();
    this.cleanupObligations.set(state, obligations);
    const allocationKey = `${owner.runId}/${owner.nodeId}/${owner.attemptId}`;
    const existing = [...obligations.entries()].find(([, cleanup]) => sameWorkflowOwner(cleanup.owner, owner));
    const key = existing?.[0] ?? JSON.stringify([owner, agentId]);
    let obligation = existing?.[1];
    if (!obligation) {
      let resolve!: () => void;
      const confirmed = new Promise<void>((done) => {
        resolve = done;
      });
      obligation = {
        agentId,
        ...(agentId === allocationKey ? { spawnKey: allocationKey } : {}),
        owner: { ...owner },
        epoch: this.branchEpoch,
        confirmed,
        resolve,
      };
      obligations.set(key, obligation);
      this.retainedCleanupStates.add(state);
      state.pendingCleanup.add(confirmed);
    } else if (obligation.spawnKey && agentId !== allocationKey) {
      // A late reply refines the same allocation lease, not a new obligation.
      obligation.agentId = agentId;
      obligation.spawnKey = undefined;
    }
    if (obligation.operation) return obligation.operation;
    const accepted = obligation;
    const currentOwner = () => this.isCurrentState(state, state.executionGeneration, accepted.epoch);
    const operation = Promise.resolve().then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopError: unknown;
      try {
        if (unconfirmed) throw new Error(unconfirmed);
        const cleanup = (async () => {
          // An allocation without a confirmed id can only be retried by its exact spawn owner.
          if (accepted.spawnKey) {
            if (!this.client.reconcileManaged) throw new Error("owned allocation reconciliation unavailable");
            const reply = await this.client.reconcileManaged(accepted.spawnKey, accepted.owner);
            const id = typeof reply === "string" ? reply : reply?.id;
            if (!id) throw new Error("cancelled spawn allocation could not be confirmed");
            accepted.agentId = id;
            accepted.spawnKey = undefined;
          }
          try {
            if (!this.client.stopOwned) throw new Error("owned stop RPC unavailable");
            await this.client.stopOwned(accepted.agentId, accepted.owner);
          } catch (error: unknown) {
            stopError = error;
          }
          if (!this.client.quiesceOwned) throw new Error("owned cleanup RPC unavailable");
          const result = await (quiescence ??
            this.client.quiesceOwned(accepted.owner.runId, [accepted.agentId], BRANCH_QUIESCE_TIMEOUT_MS, [
              accepted.owner,
            ]));
          if (!result?.settled || result.pending.length !== 0) throw new Error("owned agents are not quiescent");
          // A bounded negative/error is not evidence that cleanup settled. Only
          // this positive owner check releases the stable obligation, even late.
          obligations.delete(key);
          if (obligations.size === 0) this.retainedCleanupStates.delete(state);
          state.pendingCleanup.delete(accepted.confirmed);
          accepted.resolve();
          if (currentOwner() && isTerminalWorkflow(state.run.status)) this.notifyTerminal(state);
        })();
        await Promise.race([
          cleanup,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("owned cleanup timed out")), BRANCH_QUIESCE_TIMEOUT_MS + 1_000);
          }),
        ]);
      } catch (error: unknown) {
        if (!currentOwner() || state.executionGeneration !== executionGeneration) return;
        const stopDiagnostic = stopError === undefined ? "" : `; stop failed: ${String(stopError)}`;
        const diagnostic = `Owned cleanup unconfirmed for ${agentId}: ${error instanceof Error ? error.message : String(error)}${stopDiagnostic}; run is non-resumable`;
        this.fenceExecution(state, executionGeneration, diagnostic);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    });
    accepted.operation = operation;
    try {
      await operation;
    } finally {
      if (accepted.operation === operation) accepted.operation = undefined;
    }
  }

  private async drainExecution(state: ScriptRunState, execution?: Promise<unknown>): Promise<void> {
    if (!execution) return;
    const generation = state.executionGeneration;
    const epoch = this.branchEpoch;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        execution.catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            if (this.isCurrentState(state, generation, epoch))
              this.fenceExecution(state, generation, "Workflow execution cleanup timed out; run is non-resumable");
            resolve();
          }, EXECUTION_DRAIN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private fenceExecution(state: ScriptRunState, generation: number, diagnostic: string): void {
    const run = state.run;
    const epoch = this.branchEpoch;
    if (!this.isCurrentState(state, generation, epoch)) return;
    if (run.nonResumable && run.status === "stopped") return;
    state.pendingTerminal = undefined;
    run.nonResumable = true;
    const blockedNodeIds = Object.keys(run.callStatus).filter((nodeId) => run.callStatus[nodeId] !== "completed");
    for (const nodeId of blockedNodeIds) run.callStatus[nodeId] = "stopped";
    run.status = "stopped";
    run.error = diagnostic;
    run.terminalIntent = "stop";
    run.updatedAt = Date.now();
    const event: TerminalRecoveryEvent = {
      kind: "terminal_recovery",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: run.runId,
      status: "stopped",
      terminalIntent: "stop",
      branchGeneration: this.recoveryBranchGeneration,
      terminalResults: [],
      blockedNodeIds,
      error: diagnostic,
      recoveryId: deriveRecoveryId({ runId: run.runId, rotations: [], timestamp: Date.now() }),
      timestamp: Date.now(),
    };
    this.persist(run.runId, "cleanup-unconfirmed", () => this.write(event));
    if (!this.isCurrentState(state, generation, epoch)) return;
    // Fence before aborting: synchronous abort handlers may re-enter cleanup.
    // Exact-owner cleanup continues, but no later result may revive this run.
    state.executionGeneration += 1;
    state.presentation.reset(false);
    this.notifyInspection(state);
    if (!this.isCurrentState(state, generation + 1, epoch)) return;
    state.controller.abort();
    if (!this.isCurrentState(state, generation + 1, epoch)) return;
    this.cleanupAgents(run.runId);
    // Uncertainty is an error, never a terminal result delivery. Foreground
    // callers can unwind, while owner UI retains an explicit cleanup recheck.
    if (state.pendingCleanup.size > 0) {
      const all = this.waiters.get(run.runId);
      this.waiters.delete(run.runId);
      for (const waiter of all ?? []) {
        if (waiter.settled) continue;
        waiter.settled = true;
        waiter.cleanup();
        waiter.reject(new WorkflowWaitAbortedError());
      }
    } else this.notifyTerminal(state);
  }

  private async remove(state: ScriptRunState): Promise<void> {
    if (state.removeOperation) return state.removeOperation;
    const isBusy = () =>
      state.activeExecutionGenerations.size > 0 ||
      state.pendingCleanup.size > 0 ||
      state.pendingSpawns.size > 0 ||
      state.agentWaiters.size > 0 ||
      state.stopOperation !== undefined;
    if (isBusy()) throw new Error("cannot remove a workflow while owned cleanup is pending");
    const epoch = this.branchEpoch;
    const operation = Promise.resolve().then(async () => {
      await this.drainJournal(state.run.runId);
      if (
        this.runs.get(state.run.runId) !== state ||
        this.branchEpoch !== epoch ||
        this.disposed ||
        this.lifecyclePaused ||
        state.lifecycleSuspended
      )
        throw new Error("workflow branch changed before removal");
      if (isBusy()) throw new Error("cannot remove a workflow while owned cleanup is pending");
      // No queued best-effort tombstone: memory survives failure so removal can be retried.
      this.appendRequired({
        kind: "run_removed",
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        runId: state.run.runId,
        timestamp: Date.now(),
      });
      this.runs.delete(state.run.runId);
      this.waiters.delete(state.run.runId);
      this.notifyInspection(state);
    });
    state.removeOperation = operation;
    try {
      await operation;
    } finally {
      if (state.removeOperation === operation) state.removeOperation = undefined;
    }
  }

  private async stop(state: ScriptRunState): Promise<void> {
    if (state.stopOperation) return state.stopOperation;
    if (isTerminalWorkflow(state.run.status) && state.pendingCleanup.size === 0) return;
    const generation = state.executionGeneration;
    const epoch = this.branchEpoch;
    const operation = Promise.resolve().then(async () => {
      if (!this.isCurrentState(state, generation, epoch)) return;
      const pending = [...(this.cleanupObligations.get(state)?.values() ?? [])];
      if (pending.length > 0) {
        await Promise.all(
          pending.map((cleanup) => this.stopAndQuiesce(state, cleanup.agentId, cleanup.owner, generation)),
        );
        if (!this.isCurrentState(state, generation, epoch) || state.pendingCleanup.size > 0) return;
        if (isTerminalWorkflow(state.run.status)) {
          this.notifyTerminal(state);
          return;
        }
      }
      await this.stopExecution(state, generation, epoch);
    });
    state.stopOperation = operation;
    try {
      await operation;
    } finally {
      if (state.stopOperation === operation) state.stopOperation = undefined;
    }
  }

  private async stopExecution(state: ScriptRunState, generation: number, epoch: number): Promise<void> {
    const run = state.run;
    const current = () => this.isCurrentState(state, generation, epoch);
    if (!current() || isTerminalWorkflow(run.status)) return;
    this.setWorkflowStatus(run, "stopping", "workflow stopped", "stop");
    if (!current()) return;
    run.nonResumable = true;
    // Runtime abort listeners own exact cleanup. Rejecting their waiters here would
    // falsely settle the dispatch before its stop-and-quiesce barrier completes.
    state.controller.abort();
    if (!current()) return;
    await this.drainExecution(state, state.execution);
    if (!current() || state.pendingCleanup.size > 0) return;
    try {
      await this.drainJournal(run.runId);
    } catch {
      if (current())
        this.fenceExecution(state, generation, "Could not drain workflow journal during stop; run is non-resumable");
      return;
    }
    if (!current()) return;
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
    try {
      this.appendRequired(event);
    } catch {
      this.fenceExecution(state, generation, "Could not persist workflow stop terminal; run is non-resumable");
      return;
    }
    if (!current()) return;
    for (const terminal of terminalResults) {
      run.callResults[terminal.nodeId] = terminal.result;
      run.callStatus[terminal.nodeId] = "stopped";
    }
    run.status = "stopped";
    // Publish the accepted event's identity, just like other terminal paths.
    // A slow append must not detach the live state from its durable receipt.
    run.updatedAt = event.timestamp;
    state.presentation.settle(run.status);
    this.notifyInspection(state);
    if (current()) this.notifyTerminal(state);
  }

  // ── journal writes ─────────────────────────────────────────────────────────

  /**
   * A Pi lifecycle event is delivered once. If its durable append is transiently
   * unavailable, retain the mutation in memory and retry the append with
   * backoff without requiring the peer to re-emit. Most in-memory facts can
   * lead the journal; terminal transitions instead publish inside their exact
   * append's receipt callback. Exhausted retries mark the journal blocked.
   */
  private scheduleJournalRetry(runId: string, key: string, mutation: () => void): void {
    // Every accepted fact has its own slot, including later retry generations
    // for the same call. Coalescing by node key would silently drop that fact.
    const retryKey = `${runId}\u0000${key}\u0000${++this.journalMutationSequence}`;
    const predecessors = [...this.journalRetries.entries()]
      .filter(([id]) => id.startsWith(`${runId}\u0000`))
      .map(([, pending]) => pending.done);
    let resolve!: () => void;
    const done = new Promise<void>((settled) => {
      resolve = settled;
    });
    const retry = { attempt: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined, done, resolve };
    const attempt = (): void => {
      const current = this.journalRetries.get(retryKey);
      if (!current) return;
      current.timer = undefined;
      if (this.lifecyclePaused || !this.runs.has(runId)) {
        this.journalRetries.delete(retryKey);
        current.resolve();
        return;
      }
      const previousKey = this.journalMutationKey;
      this.journalMutationKey = `${runId}:${key}`;
      try {
        mutation();
        this.journalRetries.delete(retryKey);
        current.resolve();
      } catch (error: unknown) {
        if (!(error instanceof JournalAppendError)) {
          this.journalRetries.delete(retryKey);
          current.resolve();
          this.journalBlockedRuns.add(runId);
          console.warn(
            `[pi-workflows] journal retry abandoned: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        current.attempt += 1;
        if (current.attempt >= JOURNAL_RETRY_MAX_ATTEMPTS) {
          this.journalRetries.delete(retryKey);
          current.resolve();
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
    void Promise.all(predecessors).then(attempt);
  }

  private async drainJournal(runId: string): Promise<void> {
    let pending = [...this.journalRetries.entries()].filter(([id]) => id.startsWith(`${runId}\u0000`));
    while (pending.length > 0) {
      await Promise.all(pending.map(([, retry]) => retry.done));
      pending = [...this.journalRetries.entries()].filter(([id]) => id.startsWith(`${runId}\u0000`));
    }
    if (this.journalBlockedRuns.has(runId))
      throw new WorkflowError("Workflow journal has not settled", WorkflowErrorCode.PERSISTENCE_ERROR, {
        recoverable: true,
      });
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
    // Only append here. persist turns rejection into a retry of this exact
    // fact; receipt-gated callers publish only after write returns successfully.
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
   * Persist one journal event with bounded retry. The caller owns in-memory
   * publication; terminal transitions do it inside mutation after write returns.
   * A transient failure schedules a retry of the exact same accepted append.
   */
  private persist(runId: string, key: string, mutation: () => void): void {
    const acceptedState = this.runs.get(runId);
    const epoch = this.branchEpoch;
    const append = mutation;
    mutation = () => {
      if (this.disposed || this.lifecyclePaused || this.runs.get(runId) !== acceptedState || this.branchEpoch !== epoch)
        return;
      append();
    };
    if ([...this.journalRetries.keys()].some((id) => id.startsWith(`${runId}\u0000`))) {
      this.scheduleJournalRetry(runId, key, mutation);
      return;
    }
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
    for (const { timer, resolve } of this.journalRetries.values()) {
      if (timer) clearTimeout(timer);
      resolve();
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
    const state = this.runs.get(run.runId);
    const generation = state?.executionGeneration ?? 0;
    const epoch = this.branchEpoch;
    if (!state || state.run !== run || !this.isCurrentState(state, generation, epoch)) return;
    // Capture once: retries must append the exact accepted transition, not a
    // newly timestamped status or a result still owned by the runtime.
    const durableFinalResult = finalResult === undefined ? undefined : cloneWorkflowResult(finalResult);
    const runFinalResult = finalResult === undefined ? undefined : cloneWorkflowResult(finalResult);
    const timestamp = Date.now();
    const event: JournalEvent = {
      kind: "workflow_transition",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: run.runId,
      status,
      ...(error !== undefined ? { error } : {}),
      ...(durableFinalResult !== undefined ? { finalResult: durableFinalResult } : {}),
      ...(terminalIntent !== undefined ? { terminalIntent } : {}),
      timestamp,
    };
    const terminal = isTerminalWorkflow(status);
    const intent = terminal ? {} : undefined;
    // Stop/pause takes ownership synchronously, invalidating any queued success.
    state.pendingTerminal = intent;
    const current = () =>
      this.isCurrentState(state, generation, epoch) &&
      (!terminal || (state.pendingTerminal === intent && (status !== "completed" || !state.controller.signal.aborted)));
    const publish = () => {
      if (!current()) return;
      state.pendingTerminal = undefined;
      run.status = status;
      if (status === "running") run.error = undefined;
      if (error !== undefined) run.error = error;
      if (runFinalResult !== undefined) run.finalResult = runFinalResult;
      if (status === "completed") state.result = runFinalResult;
      if (terminalIntent !== undefined) run.terminalIntent = terminalIntent;
      run.updatedAt = timestamp;
      this.notifyInspection(state);
      if (!this.isCurrentState(state, generation, epoch)) return;
      if (terminal) {
        state.bufferedTerminals.clear();
        this.notifyTerminal(state);
      }
    };
    this.persist(run.runId, `transition:${status}`, () => {
      if (!current()) return;
      this.write(event);
      // write throws on append rejection inside persist, including its retries.
      // Only a receipt from this exact append may publish terminal state/result.
      if (terminal) publish();
    });
    if (!terminal) publish();
  }

  // ── restore / summary ──────────────────────────────────────────────────────

  restore(entries: readonly SessionEntryLike[], branchGeneration = 0): void {
    if (this.disposed) return;
    const retiredStates = [...this.runs.values()];
    this.branchEpoch++;
    for (const state of retiredStates) state.lifecycleSuspended = true;
    // A branch replay is a replacement, not a merge. Runs absent from the new
    // branch must not remain controllable or append facts into it.
    this.clearJournalRetries();
    for (const state of this.runs.values()) {
      this.cleanupAgents(state.run.runId);
      state.controller.abort(new DOMException("Workflow branch replaced", "AbortError"));
    }
    this.rejectWaiters(new WorkflowWaitAbortedError());
    this.runs.clear();
    this.admissionsClosed = false;
    this.recoveryBranchGeneration = branchGeneration;
    const runs = replayJournal(entries, {
      onInvalid: (diagnostic) => console.warn(`[pi-workflows] ${diagnostic}`),
    });
    for (const run of runs.values()) {
      const state: ScriptRunState = {
        run,
        presentation: new WorkflowPresentation(run.runId, true),
        managedCallFacts: new Map(),
        pendingCleanup: new Set(),
        activeExecutionGenerations: new Set(),
        frozenOptions: {
          ...(run.frozenTokenBudget !== undefined ? { tokenBudget: run.frozenTokenBudget } : {}),
          ...(run.frozenMaxAgents !== undefined ? { maxAgents: run.frozenMaxAgents } : {}),
          ...(run.frozenConcurrency !== undefined ? { concurrency: run.frozenConcurrency } : {}),
          ...(run.frozenAgentRetries !== undefined ? { agentRetries: run.frozenAgentRetries } : {}),
          ...(run.frozenAgentTimeoutMs !== undefined ? { agentTimeoutMs: run.frozenAgentTimeoutMs } : {}),
          ...(run.toolset ? { toolset: run.toolset } : {}),
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
    for (const state of retiredStates) this.notifyInspection(state);
    for (const state of this.runs.values()) this.notifyInspection(state);
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

  /** Primitive-only Fleet metadata; avoids cloning full inspection arrays for every run. */
  getInspectionHeader(runId: string): WorkflowInspectionHeader | undefined {
    const state = this.runs.get(runId);
    return state?.presentation.header(state.executionGeneration);
  }

  /** Detached bounded facts for late-opening UI mounts; no event callback ownership required. */
  getInspection(runId: string): WorkflowInspection | undefined {
    const state = this.runs.get(runId);
    return state?.presentation.snapshot(state.run, state.executionGeneration);
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
          ...(result?.result !== undefined ? { resultPreview: renderWorkflowValue(result.result).slice(0, 300) } : {}),
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

export type { ScriptRun, WorkflowInspection, WorkflowInspectionHeader, WorkflowOwner };
export { createManagedSpawnClient, JOURNAL_ENTRY_TYPE, snapshotRun };
