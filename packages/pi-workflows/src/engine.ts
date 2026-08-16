import { randomUUID } from "node:crypto";
import {
  type AttemptRecoveryEvent,
  applyRecoveryEvent,
  applyTerminalRecoveryEvent,
  boundedError,
  deriveRecoveryId,
  JOURNAL_SCHEMA_VERSION,
  type JournalEvent,
  type JournalWriter,
  type RecoveryRotation,
  type RecoverySourceStatus,
  type RecoveryTerminalResult,
  type RunRecoveryEvent,
  replayJournal,
  type SessionEntryLike,
  snapshotRun,
  type TerminalRecoveryEvent,
  type WorkflowOwner,
  type WorkflowRun,
} from "./journal.js";
import type {
  ManagedSpawnClient,
  ManagedSpawnResponse,
  ManagedTerminalSnapshot,
  WorkflowEventBus,
} from "./rpc-client.js";
import { registerLifecycleListener } from "./rpc-client.js";
import { readyTaskIds, type WorkflowDefinition, type WorkflowTask } from "./schema.js";
import {
  canTransitionTask,
  isTerminalTask,
  isTerminalWorkflow,
  type TaskStatus,
  transitionTask,
  transitionWorkflow,
  type WorkflowStatus,
} from "./state-machine.js";
import {
  buildBoundedResultSection,
  buildSynthesisPrompt,
  cap,
  MAX_DISPATCH_PROMPT_CHARS,
  MAX_TASK_INPUT_CHARS,
  MAX_TASK_RESULT_CHARS,
  MIN_TASK_INPUT_CHARS,
  type ResultEntry,
  resultFromLifecycle,
  TASK_INPUT_HEADER,
} from "./synthesis.js";

const SYNTHESIS_NODE_ID = "__synthesis__";
const MAX_WAITERS = 256;
const MAX_ATTEMPTS_PER_NODE = 3;
const BRANCH_QUIESCE_TIMEOUT_MS = 5_000;
const MAX_QUARANTINED_AGENT_IDS = 4_096;
const MAX_RECOVERY_MEMO_ENTRIES = 4_096;

export interface WorkflowQuiesceResult {
  settled: boolean;
  pending: string[];
  diagnostic?: string;
}

export interface WorkflowSummary {
  runId: string;
  name: string;
  description?: string;
  status: WorkflowStatus;
  startedAt: number;
  updatedAt: number;
  elapsedMs: number;
  taskCount: number;
  phaseCount: number;
  completedPhases: number;
  completedTasks: number;
  failedTasks: number;
  activeTasks: number;
  tokenCount?: number;
  synthesisPreview?: string;
  error?: string;
  nonResumable?: boolean;
  tasks?: WorkflowTaskDetail[];
  synthesis?: WorkflowSynthesisDetail;
}

export interface WorkflowTaskDetail {
  id: string;
  status: TaskStatus;
  agentId?: string;
  compactions: number;
  resultPreview?: string;
  errorPreview?: string;
}

export interface WorkflowSynthesisDetail {
  status: "completed" | "failed" | "stopped";
  agentId?: string;
  compactions: number;
  resultPreview?: string;
  errorPreview?: string;
}

export interface WorkflowControlResult {
  action: "list" | "get" | "pause" | "resume" | "stop";
  run?: WorkflowSummary;
  runs?: WorkflowSummary[];
}

export interface WorkflowStartResult {
  runId: string;
  status: WorkflowStatus;
  background: boolean;
  result?: string;
  error?: string;
  waitAborted?: boolean;
}

interface Waiter {
  resolve: (run: WorkflowRun) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  settled: boolean;
}

type RecoveryEvent = RunRecoveryEvent | AttemptRecoveryEvent;

interface RecoveryMemo {
  branchGeneration: number;
  runId: string;
  key: string;
  event: RecoveryEvent;
}

interface TerminalRecoveryMemo {
  branchGeneration: number;
  runId: string;
  key: string;
  event: TerminalRecoveryEvent;
}

interface RecoveryPlanItem {
  nodeId: string;
  sourceAttemptId: string;
  sourceGeneration: number;
  sourceStatus: RecoverySourceStatus;
  oldAgentId: string;
}

interface DeferredInterruptedRecord {
  kind: "interrupted";
  runId: string;
  nodeId: string;
  oldAgentId: string;
}

interface DeferredTerminalRecord extends RecoveryTerminalResult {
  kind: "terminal";
  runId: string;
}

interface TerminalCleanupTarget {
  agentId: string;
  owner: WorkflowOwner;
  fallbackStopRequested: boolean;
}

interface EngineRestoreSnapshot {
  runs: Map<string, WorkflowRun>;
  recoveryMemo: Map<string, RecoveryMemo>;
  terminalRecoveryMemo: Map<string, TerminalRecoveryMemo>;
  recoveryBranchGeneration: number;
  branchEpoch: number;
  branchChanging: boolean;
  branchEventsClosed: boolean;
  lifecycleSuspended: boolean;
  quarantinedAgentIds: Set<string>;
}
export class WorkflowWaitAbortedError extends Error {
  constructor() {
    super("foreground workflow wait aborted; the workflow run continues");
    this.name = "WorkflowWaitAbortedError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const WORKFLOW_TIER_VALUES = new Set(["small", "medium", "large"]);
const WORKFLOW_THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const WORKFLOW_CONFIGURED_THINKING = new Set([...WORKFLOW_THINKING_LEVELS, "inherit"]);
const TIER_SNAPSHOT_KEYS = new Set([
  "tier",
  "model",
  "thinking",
  "configuredModel",
  "configuredThinking",
  "requestedThinking",
  "modelSource",
  "thinkingSource",
  "clamped",
  "diagnostic",
]);

function isValidTierSnapshot(value: unknown, tier: string): boolean {
  if (!isRecord(value) || value.tier !== tier || !WORKFLOW_TIER_VALUES.has(tier)) return false;
  if (Object.keys(value).some((key) => !TIER_SNAPSHOT_KEYS.has(key))) return false;
  for (const key of ["model", "configuredModel"] as const) {
    const field = value[key];
    if (field !== undefined && (typeof field !== "string" || !field.trim() || field.length > 2_000)) return false;
    if (key === "model" && typeof field === "string" && !field.includes("/")) return false;
  }
  for (const key of ["thinking", "requestedThinking"] as const) {
    const field = value[key];
    if (field !== undefined && (typeof field !== "string" || !WORKFLOW_THINKING_LEVELS.has(field))) return false;
  }
  const configuredThinking = value.configuredThinking;
  if (
    configuredThinking !== undefined &&
    (typeof configuredThinking !== "string" || !WORKFLOW_CONFIGURED_THINKING.has(configuredThinking))
  )
    return false;
  if (value.modelSource !== "frontmatter" && value.modelSource !== "tier" && value.modelSource !== "parent")
    return false;
  if (value.thinkingSource !== "frontmatter" && value.thinkingSource !== "tier" && value.thinkingSource !== "parent")
    return false;
  if (value.clamped !== undefined && typeof value.clamped !== "boolean") return false;
  if (value.diagnostic !== undefined && (typeof value.diagnostic !== "string" || value.diagnostic.length > 2_000))
    return false;
  return true;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    isRecord(value) &&
    typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function"
  );
}

function ownerFor(data: Record<string, unknown>): { runId: string; nodeId: string; attemptId?: string } | undefined {
  const owner = data.owner;
  if (!isRecord(owner) || owner.extension !== "pi-workflows") return undefined;
  const validId = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 256;
  if (!validId(owner.runId) || !validId(owner.nodeId)) return undefined;
  if (owner.attemptId !== undefined && !validId(owner.attemptId)) return undefined;
  return {
    runId: owner.runId,
    nodeId: owner.nodeId,
    ...(typeof owner.attemptId === "string" ? { attemptId: owner.attemptId } : {}),
  };
}

function statusFromLifecycle(eventName: string, data: Record<string, unknown>): "completed" | "failed" | "stopped" {
  if (eventName === "subagents:completed") return "completed";
  const status = data.status;
  return status === "stopped" ? "stopped" : "failed";
}

function activeStatus(status: TaskStatus): boolean {
  return status === "dispatching" || status === "queued" || status === "running";
}

function resultPreview(result: { text?: string; error?: string } | undefined): {
  resultPreview?: string;
  errorPreview?: string;
} {
  return {
    ...(result?.text ? { resultPreview: result.text.slice(0, 2_000) } : {}),
    ...(result?.error ? { errorPreview: result.error.slice(0, 2_000) } : {}),
  };
}

function tokenCountFrom(value: unknown): number | undefined {
  if (!isRecord(value) || typeof value.total !== "number" || !Number.isFinite(value.total) || value.total <= 0) {
    return undefined;
  }
  return Math.floor(value.total);
}

function normalizeManagedSpawnResponse(response: ManagedSpawnResponse | string): ManagedSpawnResponse {
  return typeof response === "string"
    ? { id: response, state: "running", created: true }
    : { ...response, created: response.created ?? true };
}

function managedTerminalStatus(snapshot: ManagedTerminalSnapshot): "completed" | "failed" | "stopped" {
  if (snapshot.status === "completed") return "completed";
  if (snapshot.status === "stopped") return "stopped";
  return "failed";
}

class JournalAppendError extends Error {
  constructor(eventKind: JournalEvent["kind"], cause: unknown) {
    super(`${eventKind} append failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "JournalAppendError";
  }
}

const JOURNAL_RETRY_INITIAL_DELAY_MS = 25;
const JOURNAL_RETRY_MAX_DELAY_MS = 2_000;

function spawnManaged(
  client: ManagedSpawnClient,
  task: WorkflowTask,
  runId: string,
  nodeId: string,
  attemptId: string | undefined,
): Promise<ManagedSpawnResponse | string> {
  // Protocol-v3 clients receive the attempt as the fourth argument. Keep the
  // old in-process fixture shape working without passing an ExtensionContext
  // back into the engine.
  if (client.spawn.length >= 5) {
    return client.spawn(task, runId, nodeId, undefined, attemptId);
  }
  return client.spawn(task, runId, nodeId, attemptId);
}

export class WorkflowEngine {
  private readonly runs = new Map<string, WorkflowRun>();
  /** Managed RPC calls that have not settled yet, including dispatching tasks. */
  private readonly dispatches = new Map<string, Set<Promise<void>>>();
  /** Late managed spawn responses discovered while terminal cleanup waits. */
  private readonly lateDispatchTargets = new Map<string, TerminalCleanupTarget[]>();
  /** Late branch-replacement spawns whose owner-scoped quiescence did not settle. */
  private readonly lateDispatchQuiescence = new Map<string, string[]>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly pumping = new Set<string>();
  private readonly settling = new Map<string, Promise<void>>();
  private unsubscribeLifecycle: () => void;
  private lifecycleSuspended = false;
  private branchChanging = false;
  private branchEpoch = 0;
  private branchEventsClosed = false;
  private branchQuiescePromise: Promise<WorkflowQuiesceResult> | undefined;
  /** Agent ids quarantined across a branch replacement; never accept late events. */
  private readonly quarantinedAgentIds = new Set<string>();
  private recoveryBranchGeneration = 0;
  /**
   * Durable recovery rotations already emitted for this engine/branch. The
   * key is semantic (branch, run, node, source attempt), never a journal
   * payload hash. A bounded map prevents repeated reloads from retaining
   * unbounded history.
   */
  private readonly recoveryMemo = new Map<string, RecoveryMemo>();
  /** Terminal cleanup facts already emitted for a stale branch snapshot. */
  private readonly terminalRecoveryMemo = new Map<string, TerminalRecoveryMemo>();
  /** Candidate replay state used to roll back a failed recovery append. */
  private restoreFailureSnapshot: EngineRestoreSnapshot | undefined;
  /** Lifecycle journal writes that failed transiently and are waiting to retry. */
  private readonly journalRetries = new Map<string, { timer?: ReturnType<typeof setTimeout>; attempt: number }>();
  /** Prefixes durably written before a lifecycle batch append failed. */
  private readonly journalBatchProgress = new Map<string, { serialized: string; nextIndex: number }>();
  /** Runs whose lifecycle journal cannot be made durable after bounded retries. */
  private readonly journalBlockedRuns = new Set<string>();
  private journalMutationKey: string | undefined;

  constructor(
    readonly events: WorkflowEventBus,
    private readonly client: ManagedSpawnClient,
    private readonly journal: JournalWriter,
  ) {
    this.unsubscribeLifecycle = registerLifecycleListener(events, (eventName, data) => {
      this.onLifecycle(eventName, data);
    });
  }

  dispose(): void {
    this.branchEpoch += 1;
    this.clearJournalRetries();
    this.unsubscribeLifecycle();
    this.quarantinedAgentIds.clear();
    this.recoveryMemo.clear();
    this.terminalRecoveryMemo.clear();
    this.lateDispatchTargets.clear();
    this.lateDispatchQuiescence.clear();
    this.recoveryBranchGeneration = 0;
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        if (waiter.settled) continue;
        waiter.settled = true;
        waiter.cleanup();
        waiter.reject(new Error("workflow engine disposed"));
      }
    }
    this.waiters.clear();
  }

  suspendLifecycle(): void {
    if (this.lifecycleSuspended) return;
    this.lifecycleSuspended = true;
    this.unsubscribeLifecycle();
  }

  resumeLifecycle(): void {
    if (!this.lifecycleSuspended) return;
    this.lifecycleSuspended = false;
    this.unsubscribeLifecycle = registerLifecycleListener(this.events, (eventName, data) => {
      this.onLifecycle(eventName, data);
    });
  }

  /** Stop owned agents while Pi replaces the active session-tree branch. */
  async quiesceForBranchChange(): Promise<WorkflowQuiesceResult> {
    if (this.branchQuiescePromise) return this.branchQuiescePromise;
    this.branchChanging = true;
    this.clearJournalRetries();
    this.lateDispatchTargets.clear();
    this.lateDispatchQuiescence.clear();
    this.branchEpoch += 1;
    this.branchEventsClosed = false;
    this.branchQuiescePromise = (async () => {
      const operations: Array<Promise<{ runId: string; result: WorkflowQuiesceResult }>> = [];
      for (const run of this.runs.values()) {
        if (isTerminalWorkflow(run.status)) continue;
        const activeNodes = Object.entries(run.taskStatus)
          .filter(([, status]) => activeStatus(status))
          .map(([nodeId]) => ({ nodeId, agentId: run.agentIds[nodeId] }))
          .filter((item): item is { nodeId: string; agentId: string } => Boolean(item.agentId));
        const agentIds = activeNodes.map(({ agentId }) => agentId);
        const owners = activeNodes.map(({ nodeId }) => this.ownerForNode(run, nodeId));
        const hasDispatches = (this.dispatches.get(run.runId)?.size ?? 0) > 0;
        if (run.synthesisAgentId && !run.synthesisResult) {
          agentIds.push(run.synthesisAgentId);
          owners.push(this.ownerForNode(run, SYNTHESIS_NODE_ID));
        }
        if (agentIds.length === 0 && !hasDispatches) continue;
        for (const agentId of agentIds) this.quarantineAgent(agentId);
        const includeDispatches = (
          result: WorkflowQuiesceResult,
          waitForDispatches: boolean,
        ): Promise<{ runId: string; result: WorkflowQuiesceResult }> => {
          const settled = waitForDispatches
            ? this.waitForDispatches(run.runId, BRANCH_QUIESCE_TIMEOUT_MS)
            : Promise.resolve(true);
          return settled.then((dispatchSettled) => {
            const latePending = dispatchSettled ? this.takeLateDispatchQuiescence(run.runId) : [];
            const diagnostic = [
              result.diagnostic,
              latePending.length > 0 ? `late spawn quiescence incomplete: ${latePending.join(", ")}` : undefined,
            ]
              .filter((value): value is string => Boolean(value))
              .join("; ");
            return {
              runId: run.runId,
              result: {
                settled: result.settled && dispatchSettled && latePending.length === 0,
                pending: [
                  ...new Set([
                    ...result.pending,
                    ...latePending,
                    ...(dispatchSettled ? [] : [`${run.runId}:dispatch`]),
                  ]),
                ].slice(0, 256),
                ...(diagnostic ? { diagnostic } : {}),
              },
            };
          });
        };
        if (this.client.quiesceOwned && (agentIds.length > 0 || hasDispatches)) {
          operations.push(
            this.client
              .quiesceOwned(run.runId, agentIds, BRANCH_QUIESCE_TIMEOUT_MS, owners)
              .then((result) =>
                includeDispatches(
                  {
                    settled: result.settled && result.pending.length === 0,
                    pending: [...new Set(result.pending)].slice(0, 256),
                  },
                  true,
                ),
              )
              .catch((error: unknown) =>
                includeDispatches(
                  {
                    settled: false,
                    pending: agentIds.slice(0, 256),
                    diagnostic: `owned quiescence RPC failed: ${boundedError(error) ?? "unknown error"}`,
                  },
                  true,
                ),
              ),
          );
        } else {
          const stopOperations = activeNodes.map(({ nodeId, agentId }) => this.stopOwned(run, nodeId, agentId));
          if (run.synthesisAgentId && !run.synthesisResult) {
            stopOperations.push(this.stopOwned(run, SYNTHESIS_NODE_ID, run.synthesisAgentId));
          }
          operations.push(
            Promise.allSettled(stopOperations).then(() =>
              includeDispatches(
                {
                  settled: agentIds.length === 0 && !hasDispatches,
                  pending: [...agentIds, ...(hasDispatches ? [`${run.runId}:dispatch`] : [])].slice(0, 256),
                  diagnostic: hasDispatches
                    ? "dispatch quiescence is unavailable; pending spawn calls were quarantined conservatively"
                    : agentIds.length > 0
                      ? "owned quiescence is unavailable; stopped agents were quarantined conservatively"
                      : undefined,
                },
                true,
              ),
            ),
          );
        }
      }

      const observations = await Promise.all(operations);
      const pending = [...new Set(observations.flatMap(({ result }) => result.pending))].slice(0, 256);
      const diagnostics: string[] = [];
      for (const { runId, result } of observations) {
        if (result.diagnostic) diagnostics.push(result.diagnostic);
        if (result.settled) continue;
        const run = this.runs.get(runId);
        if (!run || isTerminalWorkflow(run.status)) continue;
        const diagnostic = `branch quiescence incomplete for workflow ${runId}: ${
          result.pending.length > 0 ? `pending agents ${result.pending.join(", ")}` : "terminal state was not confirmed"
        }${result.diagnostic ? ` (${result.diagnostic})` : ""}`;
        diagnostics.push(diagnostic);
        try {
          this.setWorkflowStatus(run, run.status, boundedError(diagnostic) ?? diagnostic);
        } catch (error: unknown) {
          diagnostics.push(
            `workflow quiescence diagnostic was not journaled: ${boundedError(error) ?? "unknown error"}`,
          );
        }
      }
      const diagnostic = boundedError(diagnostics.join("; ")) ?? undefined;
      const result: WorkflowQuiesceResult = {
        settled: pending.length === 0 && observations.every(({ result: item }) => item.settled),
        pending,
        ...(diagnostic ? { diagnostic } : {}),
      };
      // After this point no lifecycle event from the old branch is accepted.
      // Events are already ignored while branchChanging; the subagents manager
      // detaches timed-out records before returning, and the generation gate
      // below also protects fixtures and legacy RPC peers without quiescence.
      this.branchEventsClosed = true;
      this.suspendLifecycle();
      return result;
    })();
    return this.branchQuiescePromise;
  }

  /**
   * Restore a session-tree branch. Reusing the same branch generation is
   * intentionally idempotent: a stale snapshot may be replayed while Pi is
   * still delivering tree events. Callers that replace the branch must pass a
   * new generation (the no-argument path also advances after quiescence).
   */
  restore(entries: readonly SessionEntryLike[], branchGeneration?: number): void {
    const snapshot = this.captureRestoreSnapshot();
    try {
      this.restoreInternal(entries, branchGeneration);
      this.restoreFailureSnapshot = undefined;
    } catch (error: unknown) {
      // Recovery is a transaction from the engine's point of view. In
      // particular, an append failure must not leave a half-rotated run in
      // memory or advance the branch namespace without its durable event.
      const rollback = this.restoreFailureSnapshot ?? snapshot;
      this.restoreFailureSnapshot = undefined;
      this.restoreAfterFailure(rollback);
      throw error;
    }
  }

  private captureRestoreSnapshot(): EngineRestoreSnapshot {
    return {
      runs: new Map([...this.runs].map(([runId, run]) => [runId, snapshotRun(run)])),
      recoveryMemo: new Map(
        [...this.recoveryMemo].map(([key, memo]) => [
          key,
          {
            ...memo,
            event: structuredClone(memo.event),
          },
        ]),
      ),
      terminalRecoveryMemo: new Map(
        [...this.terminalRecoveryMemo].map(([key, memo]) => [
          key,
          {
            ...memo,
            event: structuredClone(memo.event),
          },
        ]),
      ),
      recoveryBranchGeneration: this.recoveryBranchGeneration,
      branchEpoch: this.branchEpoch,
      branchChanging: this.branchChanging,
      branchEventsClosed: this.branchEventsClosed,
      lifecycleSuspended: this.lifecycleSuspended,
      quarantinedAgentIds: new Set(this.quarantinedAgentIds),
    };
  }

  private restoreAfterFailure(snapshot: EngineRestoreSnapshot): void {
    const invalidationEpoch = this.branchEpoch + 1;
    const lifecycleWasSuspended = this.lifecycleSuspended;
    this.dispatches.clear();
    this.lateDispatchTargets.clear();
    this.pumping.clear();
    this.settling.clear();
    this.runs.clear();
    for (const [runId, run] of snapshot.runs) this.runs.set(runId, run);
    this.recoveryMemo.clear();
    for (const [key, memo] of snapshot.recoveryMemo) this.recoveryMemo.set(key, memo);
    this.terminalRecoveryMemo.clear();
    for (const [key, memo] of snapshot.terminalRecoveryMemo) this.terminalRecoveryMemo.set(key, memo);
    this.recoveryBranchGeneration = snapshot.recoveryBranchGeneration;
    this.branchEpoch = Math.max(invalidationEpoch, snapshot.branchEpoch + 1);
    this.branchChanging = snapshot.branchChanging;
    this.branchEventsClosed = snapshot.branchEventsClosed;
    if (snapshot.lifecycleSuspended && !lifecycleWasSuspended) this.suspendLifecycle();
    else if (!snapshot.lifecycleSuspended && lifecycleWasSuspended) this.resumeLifecycle();
    this.quarantinedAgentIds.clear();
    for (const agentId of snapshot.quarantinedAgentIds) this.quarantinedAgentIds.add(agentId);
    this.branchQuiescePromise = undefined;
  }

  private restoreInternal(entries: readonly SessionEntryLike[], branchGeneration?: number): void {
    const branchReplacing = this.branchChanging;
    this.prepareRecoveryNamespace(branchGeneration, branchReplacing);

    // Invalidate dispatch promises from the replaced branch before clearing the
    // run map. A managed RPC reply arriving after this point must be stopped,
    // never journaled into the new branch.
    this.branchEpoch += 1;
    this.branchChanging = false;
    this.branchEventsClosed = false;
    this.branchQuiescePromise = undefined;
    this.dispatches.clear();
    this.lateDispatchTargets.clear();
    this.pumping.clear();
    this.settling.clear();
    this.runs.clear();
    for (const [runId, run] of replayJournal(entries, {
      onInvalid: (diagnostic) => console.warn(`[pi-workflows] ${diagnostic}`),
    }))
      this.runs.set(runId, run);
    this.restoreFailureSnapshot = this.captureRestoreSnapshot();

    // Persisted subagent records are the terminal source of truth when a
    // session was interrupted between lifecycle delivery and workflow
    // journaling. Interrupted records are deferred: recovery must append one
    // complete event before changing the in-memory attempt generation.
    const recoveredNodes = new Map<string, DeferredInterruptedRecord>();
    const terminalRecords = new Map<string, DeferredTerminalRecord>();
    const recoveryKey = (runId: string, nodeId: string): string => `${runId}\u0000${nodeId}`;
    for (const entry of entries) {
      const candidates = [this.reconcileSubagentRecord(entry), this.reconcileManagedSpawnTombstone(entry)];
      for (const reconciled of candidates) {
        if (!reconciled) continue;
        const key = recoveryKey(reconciled.runId, reconciled.nodeId);
        if (reconciled.kind === "interrupted") recoveredNodes.set(key, reconciled);
        else if (!terminalRecords.has(key)) terminalRecords.set(key, reconciled);
      }
    }

    for (const run of this.runs.values()) {
      const wasActive =
        run.status === "running" ||
        run.status === "pausing" ||
        run.status === "synthesizing" ||
        run.status === "stopping";
      const runTerminalRecords = [...terminalRecords.values()].filter((record) => record.runId === run.runId);
      if (!wasActive && runTerminalRecords.length > 0) {
        // Non-active legacy/paused runs retain the existing reconciliation
        // behavior. Active terminal-intent runs are handled below so each
        // recovered terminal fact is journaled before the final transition.
        this.commitDeferredTerminals(run, runTerminalRecords);
      }
      if (wasActive) {
        if (run.terminalIntent === "stop" || run.terminalIntent === "failure") {
          // A user stop/failure is an immutable terminal fact, never an
          // interrupted run that can be resumed after reload. Finish every
          // active node first; otherwise replay can leave a terminal workflow
          // with live task statuses and a later restore can resurrect them.
          this.recoverTerminalIntent(run, runTerminalRecords);
        } else {
          // A run-level event owns the workflow interruption and every active
          // task/synthesis rotation. append() happens before any mutation, so
          // an injected failure leaves this replayed run untouched and an
          // exact retry can safely emit the same generation once.
          this.recoverInterruptedRun(run, this.recoveryPlan(run, recoveredNodes, terminalRecords), runTerminalRecords);
        }
      } else if (run.status === "interrupted") {
        // A legacy sequence could have persisted workflow_transition before
        // its task_attempt. Migrate each still-active node independently;
        // every attempt_recovery event is valid on its own prefix.
        for (const item of this.recoveryPlan(run, recoveredNodes, terminalRecords)) {
          this.recoverInterruptedNode(run, item.nodeId, item.oldAgentId, false, true);
        }
      }

      if (isTerminalWorkflow(run.status)) continue;

      // A terminal record can arrive without its lifecycle result having been
      // journaled. Preserve the existing reconciliation behavior for that
      // record; it is not part of the generation rotation itself.
      for (const task of run.definition.tasks) {
        const status = run.taskStatus[task.id];
        if (run.taskResults[task.id] && !isTerminalTask(status)) {
          this.setTaskStatus(run, task.id, run.taskResults[task.id].status, run.agentIds[task.id]);
        }
      }
    }
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        if (waiter.settled) continue;
        waiter.settled = true;
        waiter.cleanup();
        waiter.reject(new Error("workflow session branch changed; the old run is no longer active"));
      }
    }
    this.waiters.clear();
  }

  private prepareRecoveryNamespace(branchGeneration: number | undefined, branchReplacing: boolean): void {
    if (branchGeneration !== undefined && (!Number.isSafeInteger(branchGeneration) || branchGeneration < 0)) {
      throw new Error("workflow branch generation must be a non-negative safe integer");
    }
    const nextGeneration =
      branchGeneration === undefined
        ? branchReplacing
          ? this.recoveryBranchGeneration + 1
          : this.recoveryBranchGeneration
        : branchGeneration;
    if (nextGeneration === this.recoveryBranchGeneration) {
      if (branchReplacing) {
        this.recoveryMemo.clear();
        this.terminalRecoveryMemo.clear();
      }
      return;
    }
    this.recoveryMemo.clear();
    this.terminalRecoveryMemo.clear();
    this.recoveryBranchGeneration = nextGeneration;
  }

  private recoveryMemoKey(runId: string, kind: RecoveryEvent["kind"], sourceKey: string): string {
    return JSON.stringify([this.recoveryBranchGeneration, runId, kind, sourceKey]);
  }

  private sourceAttemptId(run: WorkflowRun, nodeId: string): string {
    return run.attemptIds[nodeId] ?? `${run.runId}/${nodeId}/attempt-${run.attempts[nodeId] ?? 1}`;
  }

  private recoveryPlan(
    run: WorkflowRun,
    deferred: ReadonlyMap<string, DeferredInterruptedRecord>,
    terminalRecords: ReadonlyMap<string, DeferredTerminalRecord> = new Map(),
  ): RecoveryPlanItem[] {
    const activeWorkflow =
      run.status === "running" ||
      run.status === "pausing" ||
      run.status === "synthesizing" ||
      run.status === "stopping";
    const legacyInterrupted = run.status === "interrupted";
    if ((!activeWorkflow && !legacyInterrupted) || run.terminalIntent) return [];
    const plan: RecoveryPlanItem[] = [];
    for (const task of run.definition.tasks) {
      const status = run.taskStatus[task.id];
      const key = `${run.runId}\u0000${task.id}`;
      const deferredRecord = deferred.get(key);
      if (run.taskResults[task.id] || isTerminalTask(status) || terminalRecords.has(key)) continue;
      if (!activeStatus(status) && deferredRecord === undefined) continue;
      plan.push({
        nodeId: task.id,
        sourceAttemptId: this.sourceAttemptId(run, task.id),
        sourceGeneration: run.attempts[task.id],
        sourceStatus: status,
        oldAgentId: deferredRecord?.oldAgentId ?? run.agentIds[task.id] ?? "",
      });
    }
    if ((run.status === "synthesizing" || (legacyInterrupted && run.synthesisAgentId)) && !run.synthesisResult) {
      const synthesisKey = `${run.runId}\u0000${SYNTHESIS_NODE_ID}`;
      const deferredRecord = deferred.get(synthesisKey);
      if (terminalRecords.has(synthesisKey)) return plan;
      plan.push({
        nodeId: SYNTHESIS_NODE_ID,
        sourceAttemptId: this.sourceAttemptId(run, SYNTHESIS_NODE_ID),
        sourceGeneration: run.attempts[SYNTHESIS_NODE_ID],
        sourceStatus: "synthesizing",
        oldAgentId: deferredRecord?.oldAgentId ?? run.synthesisAgentId ?? "",
      });
    }
    return plan;
  }

  private recoverySourceKey(
    run: WorkflowRun,
    plan: readonly RecoveryPlanItem[],
    terminalResults: readonly DeferredTerminalRecord[] = [],
  ): string {
    return JSON.stringify({
      status: run.status,
      terminalIntent: run.terminalIntent,
      rotations: plan.map((item) => [
        item.nodeId,
        item.sourceAttemptId,
        item.sourceGeneration,
        item.sourceStatus,
        item.oldAgentId,
      ]),
      terminalResults: terminalResults.map((item) => [
        item.nodeId,
        item.attemptId,
        item.result.status,
        item.result.agentId,
        item.result.text,
        item.result.error,
        item.result.outputFile,
        item.result.tokenCount,
        item.result.compactionCount,
        item.result.truncated,
      ]),
    });
  }

  private rememberRecovery(memo: RecoveryMemo): void {
    const key = this.recoveryMemoKey(memo.runId, memo.event.kind, memo.key);
    this.recoveryMemo.delete(key);
    this.recoveryMemo.set(key, memo);
    while (this.recoveryMemo.size > MAX_RECOVERY_MEMO_ENTRIES) {
      const oldest = this.recoveryMemo.keys().next().value;
      if (typeof oldest !== "string") break;
      this.recoveryMemo.delete(oldest);
    }
  }

  private memoizedRecovery(runId: string, kind: RecoveryEvent["kind"], sourceKey: string): RecoveryEvent | undefined {
    return this.recoveryMemo.get(this.recoveryMemoKey(runId, kind, sourceKey))?.event;
  }

  list(): WorkflowSummary[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt).map((run) => this.summary(run));
  }

  get(runId: string): WorkflowSummary | undefined {
    const run = this.runs.get(runId);
    return run ? this.summary(run) : undefined;
  }

  getRun(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId);
  }

  async start(definition: WorkflowDefinition, signal?: AbortSignal): Promise<WorkflowStartResult>;
  /** @deprecated The context argument is ignored; pass the foreground signal as the second argument. */
  async start(
    definition: WorkflowDefinition,
    _legacyContext: unknown,
    signal?: AbortSignal,
  ): Promise<WorkflowStartResult>;
  async start(
    definition: WorkflowDefinition,
    signalOrLegacyContext?: AbortSignal | unknown,
    legacySignal?: AbortSignal,
  ): Promise<WorkflowStartResult> {
    const signal = legacySignal ?? (isAbortSignal(signalOrLegacyContext) ? signalOrLegacyContext : undefined);
    const now = Date.now();
    const runId = randomUUID();
    const run: WorkflowRun = {
      runId,
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      definition,
      status: "pending",
      taskStatus: Object.fromEntries(definition.tasks.map((task) => [task.id, "pending" as const])),
      agentIds: {},
      attempts: Object.fromEntries([
        ...definition.tasks.map((task) => [task.id, 1] as const),
        [SYNTHESIS_NODE_ID, 1] as const,
      ]),
      attemptIds: Object.fromEntries([
        ...definition.tasks.map((task) => [task.id, `${runId}/${task.id}/attempt-1`] as const),
        [SYNTHESIS_NODE_ID, `${runId}/${SYNTHESIS_NODE_ID}/attempt-1`] as const,
      ]),
      attemptTracking: true,
      taskResults: {},
      compactions: {},
      startedAt: now,
      updatedAt: now,
    };
    this.write({
      kind: "run_created",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: run.runId,
      definition,
      attempts: run.attempts,
      attemptIds: run.attemptIds,
      timestamp: now,
    });
    this.setWorkflowStatus(run, "running");
    this.runs.set(run.runId, run);
    void this.pump(run);
    if (definition.background) return { runId: run.runId, status: run.status, background: true };
    try {
      const settled = await this.waitFor(run.runId, signal);
      return {
        runId: run.runId,
        status: settled.status,
        background: false,
        ...(settled.synthesisResult?.text ? { result: settled.synthesisResult.text } : {}),
        ...(settled.error ? { error: settled.error } : {}),
      };
    } catch (error: unknown) {
      if (!(error instanceof WorkflowWaitAbortedError)) throw error;
      const current = this.runs.get(run.runId) ?? run;
      return {
        runId: current.runId,
        status: current.status,
        background: false,
        waitAborted: true,
        error: error.message,
      };
    }
  }

  async control(action: "list" | "get" | "pause" | "resume" | "stop", runId?: string): Promise<WorkflowControlResult> {
    if (action === "list") return { action, runs: this.list() };
    if (!runId) throw new Error(`${action} requires runId`);
    const run = this.runs.get(runId);
    if (!run) throw new Error(`workflow run not found: ${runId}`);
    if (action === "get") return { action, run: this.summary(run, true) };
    if (action === "pause") {
      if (run.status === "running") {
        this.setWorkflowStatus(run, "pausing");
        this.maybePause(run);
      } else if (run.status !== "paused") {
        throw new Error(`cannot pause workflow in state ${run.status}`);
      }
    } else if (action === "resume") {
      if (run.nonResumable || run.status === "stopped") throw new Error("workflow run is non-resumable after stop");
      if (run.status !== "paused" && run.status !== "interrupted") {
        throw new Error(`cannot resume workflow in state ${run.status}`);
      }
      this.setWorkflowStatus(run, "running");
      void this.pump(run);
    } else if (action === "stop") {
      await this.stop(run);
    }
    return { action, run: this.summary(run) };
  }

  async waitFor(runId: string, signal?: AbortSignal): Promise<WorkflowRun> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`workflow run not found: ${runId}`);
    if (isTerminalWorkflow(run.status)) return run;
    const all = this.waiters.get(runId) ?? new Set<Waiter>();
    if (all.size >= MAX_WAITERS) throw new Error("too many workflow waiters");
    this.waiters.set(runId, all);
    return new Promise<WorkflowRun>((resolve, reject) => {
      let abort = () => {};
      const waiter: Waiter = {
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
      if (signal) {
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
      }
      if (isTerminalWorkflow(run.status)) {
        all.delete(waiter);
        if (all.size === 0) this.waiters.delete(runId);
        waiter.settled = true;
        waiter.cleanup();
        resolve(run);
      }
    });
  }

  private trackDispatch(runId: string, dispatch: Promise<void>): void {
    const pending = this.dispatches.get(runId) ?? new Set<Promise<void>>();
    pending.add(dispatch);
    this.dispatches.set(runId, pending);
    // Use both settlement branches so a rejected dispatch never creates an
    // unhandled rejection while its bookkeeping is removed.
    void dispatch.then(
      () => this.untrackDispatch(runId, dispatch),
      () => this.untrackDispatch(runId, dispatch),
    );
  }

  private untrackDispatch(runId: string, dispatch: Promise<void>): void {
    const pending = this.dispatches.get(runId);
    if (!pending) return;
    pending.delete(dispatch);
    if (pending.size === 0) this.dispatches.delete(runId);
  }

  private async waitForDispatches(runId: string, timeoutMs: number): Promise<boolean> {
    const pending = this.dispatches.get(runId);
    if (!pending || pending.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const allSettled = Promise.allSettled([...pending]).then(() => true);
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const settled = await Promise.race([allSettled, timedOut]);
    if (timer) clearTimeout(timer);
    return settled;
  }

  private quarantineAgent(agentId: string): void {
    this.quarantinedAgentIds.add(agentId);
    if (this.quarantinedAgentIds.size > MAX_QUARANTINED_AGENT_IDS) {
      const oldest = this.quarantinedAgentIds.values().next().value;
      if (typeof oldest === "string") this.quarantinedAgentIds.delete(oldest);
    }
  }

  private stopOwned(run: WorkflowRun, nodeId: string, agentId: string, attemptId?: string): Promise<void> {
    const owner = {
      ...this.ownerForNode(run, nodeId),
      ...(attemptId === undefined ? {} : { attemptId }),
    };
    if (!this.client.stopOwned) {
      return Promise.reject(new Error("workflow owner-scoped stop is unavailable; refusing unowned stop fallback"));
    }
    return this.client.stopOwned(agentId, owner);
  }

  private rememberLateDispatchTarget(
    run: WorkflowRun,
    nodeId: string,
    agentId: string,
    attemptId: string | undefined,
  ): void {
    const owner: WorkflowOwner = {
      ...this.ownerForNode(run, nodeId),
      ...(attemptId === undefined ? {} : { attemptId }),
    };
    const targets = this.lateDispatchTargets.get(run.runId) ?? [];
    if (
      !targets.some(
        (target) =>
          target.agentId === agentId &&
          target.owner.nodeId === owner.nodeId &&
          target.owner.attemptId === owner.attemptId,
      )
    ) {
      targets.push({ agentId, owner, fallbackStopRequested: false });
    }
    this.lateDispatchTargets.set(run.runId, targets);
  }

  private takeLateDispatchTargets(run: WorkflowRun): TerminalCleanupTarget[] {
    const targets = this.lateDispatchTargets.get(run.runId);
    if (!targets) return [];
    this.lateDispatchTargets.delete(run.runId);
    return targets;
  }

  private rememberLateDispatchQuiescence(runId: string, agentId: string): void {
    const pending = this.lateDispatchQuiescence.get(runId) ?? [];
    if (!pending.includes(agentId)) pending.push(agentId);
    this.lateDispatchQuiescence.set(runId, pending.slice(0, 256));
  }

  private takeLateDispatchQuiescence(runId: string): string[] {
    const pending = this.lateDispatchQuiescence.get(runId) ?? [];
    this.lateDispatchQuiescence.delete(runId);
    return pending;
  }

  private initialTerminalCleanupTargets(run: WorkflowRun): TerminalCleanupTarget[] {
    const targets: TerminalCleanupTarget[] = [];
    for (const [nodeId, status] of Object.entries(run.taskStatus)) {
      if (!activeStatus(status)) continue;
      const agentId = run.agentIds[nodeId];
      if (!agentId) continue;
      targets.push({ agentId, owner: this.ownerForNode(run, nodeId), fallbackStopRequested: false });
    }
    if (run.synthesisAgentId && !run.synthesisResult) {
      targets.push({
        agentId: run.synthesisAgentId,
        owner: this.ownerForNode(run, SYNTHESIS_NODE_ID),
        fallbackStopRequested: false,
      });
    }
    return targets;
  }

  private async stopAndQuiesceOwned(
    run: WorkflowRun,
    nodeId: string,
    agentId: string,
    attemptId: string | undefined,
    branchEpoch: number,
    quiesce = true,
    allowStaleBranch = false,
  ): Promise<boolean> {
    const isCurrent = (): boolean => {
      if (this.runs.get(run.runId) !== run) return false;
      return allowStaleBranch || (!this.branchChanging && branchEpoch === this.branchEpoch);
    };
    await this.stopOwned(run, nodeId, agentId, attemptId).catch(() => {});
    if (!quiesce) return true;
    if (!this.client.quiesceOwned) return false;
    const owner = {
      ...this.ownerForNode(run, nodeId),
      ...(attemptId === undefined ? {} : { attemptId }),
    };
    while (isCurrent()) {
      const result = await this.client
        .quiesceOwned(run.runId, [agentId], BRANCH_QUIESCE_TIMEOUT_MS, [owner])
        .catch((): WorkflowQuiesceResult => ({ settled: false, pending: [agentId] }));
      if (result.settled && result.pending.length === 0) return true;
      if (allowStaleBranch) return false;
      if (!isCurrent()) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  private clearJournalRetries(): void {
    for (const retry of this.journalRetries.values()) {
      if (retry.timer) clearTimeout(retry.timer);
    }
    this.journalRetries.clear();
    this.journalBatchProgress.clear();
    this.journalBlockedRuns.clear();
  }

  private hasPendingJournalWork(runId: string): boolean {
    if (this.journalBlockedRuns.has(runId)) return true;
    const retryMarker = `\\u0000${runId}\\u0000`;
    if ([...this.journalRetries.keys()].some((key) => key.includes(retryMarker))) return true;
    const batchMarker = `${runId}:`;
    return [...this.journalBatchProgress.keys()].some((key) => key.startsWith(batchMarker));
  }

  /**
   * A Pi lifecycle event is delivered once. If its durable append is transiently
   * unavailable, retain the immutable mutation and retry it without requiring
   * the subagents peer to emit a second terminal callback.
   */
  private scheduleJournalRetry(run: WorkflowRun, key: string, mutation: () => void): void {
    const epoch = this.branchEpoch;
    const retryKey = `${epoch}\\u0000${run.runId}\\u0000${key}`;
    if (this.journalRetries.has(retryKey)) return;
    const retry = { attempt: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    const attempt = (): void => {
      const current = this.journalRetries.get(retryKey);
      if (!current) return;
      current.timer = undefined;
      if (
        this.branchEpoch !== epoch ||
        this.branchChanging ||
        this.lifecycleSuspended ||
        this.runs.get(run.runId) !== run
      ) {
        this.journalRetries.delete(retryKey);
        return;
      }
      const previousKey = this.journalMutationKey;
      this.journalMutationKey = `${run.runId}:${key}`;
      try {
        mutation();
        this.journalRetries.delete(retryKey);
      } catch (error: unknown) {
        if (!(error instanceof JournalAppendError)) {
          this.journalRetries.delete(retryKey);
          console.warn(`[pi-workflows] lifecycle retry abandoned: ${boundedError(error) ?? "unknown error"}`);
          return;
        }
        current.attempt += 1;
        if (current.attempt >= 8) {
          this.journalRetries.delete(retryKey);
          this.journalBlockedRuns.add(run.runId);
          console.warn(`[pi-workflows] lifecycle journal retry exhausted: ${error.message}`);
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

  private tryLifecycleMutation(run: WorkflowRun, key: string, mutation: () => void): boolean {
    const previousKey = this.journalMutationKey;
    this.journalMutationKey = `${run.runId}:${key}`;
    try {
      mutation();
      return true;
    } catch (error: unknown) {
      if (!(error instanceof JournalAppendError)) throw error;
      this.scheduleJournalRetry(run, key, mutation);
      return false;
    } finally {
      this.journalMutationKey = previousKey;
    }
  }

  private write(event: JournalEvent): void {
    try {
      this.journal.append(event);
    } catch (error: unknown) {
      throw new JournalAppendError(event.kind, error);
    }
  }

  private appendEvents(events: readonly JournalEvent[]): void {
    const key = this.journalMutationKey;
    const serialized = key ? JSON.stringify(events) : undefined;
    let start = 0;
    if (key && serialized !== undefined) {
      const prior = this.journalBatchProgress.get(key);
      if (prior && prior.serialized === serialized) {
        start = prior.nextIndex;
      } else {
        this.journalBatchProgress.set(key, { serialized, nextIndex: 0 });
      }
    }
    for (let index = start; index < events.length; index += 1) {
      const event = events[index];
      if (!event) continue;
      this.write(event);
      if (key) {
        const progress = this.journalBatchProgress.get(key);
        if (progress) progress.nextIndex = index + 1;
      }
    }
    if (key) this.journalBatchProgress.delete(key);
  }

  private ownerForNode(run: WorkflowRun, nodeId: string): WorkflowOwner {
    return {
      extension: "pi-workflows",
      runId: run.runId,
      nodeId,
      ...(run.attemptIds[nodeId] ? { attemptId: run.attemptIds[nodeId] } : {}),
    };
  }

  private setWorkflowStatus(
    run: WorkflowRun,
    status: WorkflowStatus,
    error?: string,
    terminalIntent: WorkflowRun["terminalIntent"] = run.terminalIntent,
  ): void {
    const nextStatus = transitionWorkflow(run.status, status);
    const timestamp = Date.now();
    const event: JournalEvent = {
      kind: "workflow_transition",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: run.runId,
      status: nextStatus,
      timestamp,
      ...(error === undefined ? {} : { error }),
      ...(terminalIntent === undefined ? {} : { terminalIntent }),
    };
    // Do not advance the aggregate before the durable prefix accepts this
    // event. A caller can retry the same transition after append() throws.
    this.write(event);
    run.status = nextStatus;
    run.updatedAt = timestamp;
    if (error !== undefined) run.error = error;
    if (terminalIntent !== undefined) run.terminalIntent = terminalIntent;
    if (isTerminalWorkflow(nextStatus)) this.resolveWaiters(run);
  }

  private setTaskStatus(run: WorkflowRun, nodeId: string, status: TaskStatus, agentId?: string): void {
    const previous = run.taskStatus[nodeId];
    if (!previous) return;
    if (!canTransitionTask(previous, status)) {
      if (isTerminalTask(previous)) return;
      throw new Error(`invalid task transition: ${previous} -> ${status}`);
    }
    const nextStatus = transitionTask(previous, status);
    const timestamp = Date.now();
    const event: JournalEvent = {
      kind: "task_transition",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: run.runId,
      nodeId,
      status: nextStatus,
      ...(agentId ? { agentId } : {}),
      ...(run.attemptIds[nodeId] ? { attemptId: run.attemptIds[nodeId] } : {}),
      owner: this.ownerForNode(run, nodeId),
      timestamp,
    };
    this.write(event);
    run.taskStatus[nodeId] = nextStatus;
    run.updatedAt = timestamp;
    if (agentId) run.agentIds[nodeId] = agentId;
  }

  private blockedDependentIds(run: WorkflowRun, failedNodeId: string): string[] {
    const queue = [failedNodeId];
    const blocked = new Set<string>();
    while (queue.length > 0) {
      const dependency = queue.shift();
      if (!dependency) continue;
      for (const task of run.definition.tasks) {
        if (!task.depends_on.includes(dependency) || blocked.has(task.id)) continue;
        const status = run.taskStatus[task.id];
        if (status !== "pending" && status !== "ready") continue;
        blocked.add(task.id);
        queue.push(task.id);
      }
    }
    return [...blocked];
  }

  private commitTaskTerminal(
    run: WorkflowRun,
    nodeId: string,
    result: WorkflowRun["taskResults"][string],
    status: "completed" | "failed" | "stopped",
    failureMessage?: string,
    blockDependents = true,
  ): void {
    const previous = run.taskStatus[nodeId];
    if (!previous || run.taskResults[nodeId] || isTerminalTask(previous)) return;
    if (!canTransitionTask(previous, status)) {
      throw new Error(`invalid task transition: ${previous} -> ${status}`);
    }
    const timestamp = result.updatedAt;
    const resultEvent: JournalEvent = {
      kind: "task_result",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: run.runId,
      nodeId,
      result,
      attemptId: run.attemptIds[nodeId],
      owner: this.ownerForNode(run, nodeId),
      timestamp,
    };
    const transitionEvent: JournalEvent = {
      kind: "task_transition",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: run.runId,
      nodeId,
      status,
      ...(result.agentId ? { agentId: result.agentId } : {}),
      ...(run.attemptIds[nodeId] ? { attemptId: run.attemptIds[nodeId] } : {}),
      owner: this.ownerForNode(run, nodeId),
      timestamp,
    };
    const blockedIds = blockDependents && status !== "completed" ? this.blockedDependentIds(run, nodeId) : [];
    const blockedEvents: JournalEvent[] = blockedIds.map((blockedNodeId) => ({
      kind: "task_transition",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: run.runId,
      nodeId: blockedNodeId,
      status: "blocked",
      ...(run.attemptIds[blockedNodeId] ? { attemptId: run.attemptIds[blockedNodeId] } : {}),
      owner: this.ownerForNode(run, blockedNodeId),
      timestamp,
    }));
    const message = failureMessage ?? result.error ?? `workflow task ${nodeId} ${status}`;
    const needsFailureCleanup =
      status !== "completed" &&
      run.terminalIntent !== "stop" &&
      (run.status !== "stopping" || run.terminalIntent !== "failure" || run.error !== message);
    const workflowEvent: JournalEvent | undefined = needsFailureCleanup
      ? {
          kind: "workflow_transition",
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          runId: run.runId,
          status: "stopping",
          terminalIntent: "failure",
          error: message,
          timestamp,
        }
      : undefined;
    this.appendEvents([resultEvent, transitionEvent, ...blockedEvents, ...(workflowEvent ? [workflowEvent] : [])]);

    run.taskResults[nodeId] = result;
    run.taskStatus[nodeId] = status;
    if (result.agentId) run.agentIds[nodeId] = result.agentId;
    run.compactions[nodeId] = Math.max(run.compactions[nodeId] ?? 0, result.compactionCount);
    run.updatedAt = timestamp;
    for (const blockedNodeId of blockedIds) {
      run.taskStatus[blockedNodeId] = "blocked";
      run.updatedAt = timestamp;
    }
    if (workflowEvent) {
      run.status = "stopping";
      run.terminalIntent = "failure";
      run.error = message;
      run.updatedAt = timestamp;
      this.startFailureCleanup(run, message);
    }
  }

  private commitSynthesisTerminal(
    run: WorkflowRun,
    result: WorkflowRun["synthesisResult"],
    finalStatus: "completed" | "failed" | "stopped",
  ): void {
    if (run.synthesisResult || !result) return;
    const timestamp = result.updatedAt;
    const resultEvent: JournalEvent = {
      kind: "synthesis_result",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: run.runId,
      result,
      attemptId: run.attemptIds[SYNTHESIS_NODE_ID],
      owner: this.ownerForNode(run, SYNTHESIS_NODE_ID),
      timestamp,
    };
    const settling = run.status === "stopping" || this.settling.has(run.runId);
    const workflowEvent: JournalEvent | undefined = settling
      ? undefined
      : {
          kind: "workflow_transition",
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          runId: run.runId,
          status: finalStatus,
          ...(result.error ? { error: result.error } : {}),
          ...(run.terminalIntent ? { terminalIntent: run.terminalIntent } : {}),
          timestamp,
        };
    this.appendEvents([resultEvent, ...(workflowEvent ? [workflowEvent] : [])]);

    run.synthesisResult = result;
    if (result.agentId) run.synthesisAgentId = result.agentId;
    run.compactions[SYNTHESIS_NODE_ID] = Math.max(run.compactions[SYNTHESIS_NODE_ID] ?? 0, result.compactionCount);
    run.updatedAt = timestamp;
    if (workflowEvent) {
      run.status = finalStatus;
      run.updatedAt = timestamp;
      if (result.error) run.error = result.error;
      if (isTerminalWorkflow(finalStatus)) this.resolveWaiters(run);
    }
  }

  private commitDeferredTerminals(run: WorkflowRun, records: readonly DeferredTerminalRecord[]): void {
    const pending = records.filter((record) =>
      record.nodeId === SYNTHESIS_NODE_ID
        ? run.synthesisResult === undefined
        : run.taskResults[record.nodeId] === undefined && !isTerminalTask(run.taskStatus[record.nodeId]),
    );
    if (pending.length === 0) return;
    const events: JournalEvent[] = pending.map((record) =>
      record.nodeId === SYNTHESIS_NODE_ID
        ? {
            kind: "synthesis_result",
            schemaVersion: JOURNAL_SCHEMA_VERSION,
            runId: run.runId,
            result: record.result,
            attemptId: run.attemptIds[SYNTHESIS_NODE_ID],
            owner: this.ownerForNode(run, SYNTHESIS_NODE_ID),
            timestamp: Math.max(run.updatedAt, record.result.updatedAt),
          }
        : {
            kind: "task_result",
            schemaVersion: JOURNAL_SCHEMA_VERSION,
            runId: run.runId,
            nodeId: record.nodeId,
            result: record.result,
            attemptId: run.attemptIds[record.nodeId],
            owner: this.ownerForNode(run, record.nodeId),
            timestamp: Math.max(run.updatedAt, record.result.updatedAt),
          },
    );
    const transitions: JournalEvent[] = pending
      .filter((record) => record.nodeId !== SYNTHESIS_NODE_ID)
      .map((record) => ({
        kind: "task_transition",
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        runId: run.runId,
        nodeId: record.nodeId,
        status: record.result.status,
        ...(record.result.agentId ? { agentId: record.result.agentId } : {}),
        attemptId: run.attemptIds[record.nodeId],
        owner: this.ownerForNode(run, record.nodeId),
        timestamp: Math.max(run.updatedAt, record.result.updatedAt),
      }));
    this.appendEvents([...events, ...transitions]);
    for (const record of pending) {
      if (record.nodeId === SYNTHESIS_NODE_ID) {
        run.synthesisResult = record.result;
        if (record.result.agentId) run.synthesisAgentId = record.result.agentId;
      } else {
        run.taskResults[record.nodeId] = record.result;
        run.taskStatus[record.nodeId] = record.result.status;
        if (record.result.agentId) run.agentIds[record.nodeId] = record.result.agentId;
      }
      run.compactions[record.nodeId] = Math.max(run.compactions[record.nodeId] ?? 0, record.result.compactionCount);
      run.updatedAt = Math.max(run.updatedAt, record.result.updatedAt);
    }
  }
  private async pump(run: WorkflowRun): Promise<void> {
    if (this.branchChanging || this.pumping.has(run.runId) || run.status !== "running") return;
    this.pumping.add(run.runId);
    const branchEpoch = this.branchEpoch;
    const isCurrent = (): boolean =>
      !this.branchChanging && branchEpoch === this.branchEpoch && this.runs.get(run.runId) === run;
    try {
      if (!isCurrent()) return;
      const completed = new Set(
        Object.entries(run.taskStatus)
          .filter(([, status]) => status === "completed")
          .map(([nodeId]) => nodeId),
      );
      const ready = readyTaskIds(run.definition, completed);
      for (const nodeId of ready) {
        if (!isCurrent() || run.status !== "running") break;
        if (run.taskStatus[nodeId] !== "pending" && run.taskStatus[nodeId] !== "ready") continue;
        if (run.taskStatus[nodeId] === "pending") this.setTaskStatus(run, nodeId, "ready");
        this.setTaskStatus(run, nodeId, "dispatching");
        const dispatch = this.dispatchTask(run, nodeId, branchEpoch);
        this.trackDispatch(run.runId, dispatch);
      }
      if (!isCurrent() || run.status !== "running") return;
      const statuses = Object.values(run.taskStatus);
      if (statuses.some((status) => status === "failed" || status === "blocked" || status === "stopped")) {
        if (statuses.some((status) => status === "stopped") && run.terminalIntent === "stop") {
          if (!isCurrent()) return;
          await this.stop(run);
        } else {
          if (!isCurrent()) return;
          await this.failRun(
            run,
            statuses.some((status) => status === "stopped")
              ? "one or more workflow tasks stopped unexpectedly"
              : "one or more workflow tasks failed",
          );
        }
        return;
      }
      if (!isCurrent() || statuses.some((status) => !isTerminalTask(status))) return;
      if (run.definition.synthesis && !run.synthesisResult && (!run.synthesisAgentId || run.status === "running")) {
        if (!isCurrent()) return;
        this.setWorkflowStatus(run, "synthesizing");
        const dispatch = this.dispatchSynthesis(run);
        this.trackDispatch(run.runId, dispatch);
        return;
      }
      if (!isCurrent()) return;
      if (!run.definition.synthesis) {
        this.setWorkflowStatus(run, "completed");
      } else if (run.synthesisResult) {
        const synthesisStatus =
          run.synthesisResult.status === "completed"
            ? "completed"
            : run.synthesisResult.status === "stopped"
              ? "stopped"
              : "failed";
        this.setWorkflowStatus(run, synthesisStatus, run.synthesisResult.error);
      }
    } finally {
      if (this.runs.get(run.runId) === run && this.branchEpoch === branchEpoch) {
        this.pumping.delete(run.runId);
      }
    }
  }

  private recoverInterruptedRun(
    run: WorkflowRun,
    plan: readonly RecoveryPlanItem[],
    terminalResults: readonly DeferredTerminalRecord[],
  ): void {
    const sourceKey = this.recoverySourceKey(run, plan, terminalResults);
    const memo = this.memoizedRecovery(run.runId, "run_recovery", sourceKey);
    if (memo?.kind === "run_recovery") {
      // The durable event belongs to this branch and source snapshot. Reapply
      // it to the freshly replayed run without another append.
      applyRecoveryEvent(run, memo);
      return;
    }

    const exhausted = plan.find((item) => item.sourceGeneration + 1 > MAX_ATTEMPTS_PER_NODE);
    if (exhausted) {
      const message = `workflow node ${exhausted.nodeId} exceeded interrupted-attempt limit`;
      if (exhausted.nodeId === SYNTHESIS_NODE_ID) {
        const result = resultFromLifecycle(
          "failed",
          run.synthesisAgentId,
          undefined,
          message,
          run.compactions[SYNTHESIS_NODE_ID] ?? 0,
        );
        result.attemptId = run.attemptIds[SYNTHESIS_NODE_ID];
        this.commitSynthesisTerminal(run, result, "failed");
      } else {
        this.failTask(run, exhausted.nodeId, message);
      }
      return;
    }

    const rotations: RecoveryRotation[] = plan.map((item) => {
      const generation = item.sourceGeneration + 1;
      const attemptId = `${run.runId}/${item.nodeId}/attempt-${generation}`;
      return {
        nodeId: item.nodeId,
        sourceAttemptId: item.sourceAttemptId,
        sourceGeneration: item.sourceGeneration,
        sourceStatus: item.sourceStatus,
        attemptId,
        generation,
        owner: { extension: "pi-workflows", runId: run.runId, nodeId: item.nodeId, attemptId },
        ...(item.oldAgentId ? { supersededAgentId: item.oldAgentId } : {}),
      };
    });
    const recoveryBase = {
      kind: "run_recovery" as const,
      schemaVersion: JOURNAL_SCHEMA_VERSION as 2,
      runId: run.runId,
      status: "interrupted" as const,
      branchGeneration: this.recoveryBranchGeneration,
      rotations,
      ...(terminalResults.length > 0
        ? {
            terminalResults: terminalResults.map(
              ({ kind: _kind, runId: _runId, nodeId, attemptId, result, owner }) => ({
                nodeId,
                attemptId,
                result: { ...result, updatedAt: run.updatedAt },
                owner,
              }),
            ),
          }
        : {}),
    };
    const event: RunRecoveryEvent = {
      ...recoveryBase,
      recoveryId: deriveRecoveryId(recoveryBase),
      timestamp: Date.now(),
    };
    // This is the only persistence boundary for the complete recovery. Do not
    // mutate the run or memoize until append returns successfully.
    this.write(event);
    applyRecoveryEvent(run, event);
    this.rememberRecovery({
      branchGeneration: this.recoveryBranchGeneration,
      runId: run.runId,
      key: sourceKey,
      event,
    });
  }

  private recoverInterruptedNode(
    run: WorkflowRun,
    nodeId: string,
    oldAgentId: string,
    resumeImmediately = true,
    legacyMigration = false,
  ): void {
    const sourceGeneration = run.attempts[nodeId] ?? 1;
    const sourceAttemptId = this.sourceAttemptId(run, nodeId);
    const sourceStatus: RecoverySourceStatus = nodeId === SYNTHESIS_NODE_ID ? "synthesizing" : run.taskStatus[nodeId];
    if (nodeId !== SYNTHESIS_NODE_ID && isTerminalTask(run.taskStatus[nodeId])) return;
    const plan: RecoveryPlanItem = {
      nodeId,
      sourceAttemptId,
      sourceGeneration,
      sourceStatus,
      oldAgentId,
    };
    const sourceKey = this.recoverySourceKey(run, [plan]);
    const memo = this.memoizedRecovery(run.runId, "attempt_recovery", sourceKey);
    if (memo?.kind === "attempt_recovery") {
      applyRecoveryEvent(run, memo);
      this.resumeRecoveredNode(run, nodeId, resumeImmediately);
      return;
    }

    const generation = sourceGeneration + 1;
    if (generation > MAX_ATTEMPTS_PER_NODE) {
      const message = `workflow node ${nodeId} exceeded interrupted-attempt limit`;
      if (nodeId === SYNTHESIS_NODE_ID) {
        const result = resultFromLifecycle(
          "failed",
          run.synthesisAgentId,
          undefined,
          message,
          run.compactions[nodeId] ?? 0,
        );
        result.attemptId = run.attemptIds[nodeId];
        this.commitSynthesisTerminal(run, result, "failed");
      } else {
        this.failTask(run, nodeId, message);
      }
      return;
    }

    const attemptId = `${run.runId}/${nodeId}/attempt-${generation}`;
    const rotation: RecoveryRotation = {
      nodeId,
      sourceAttemptId,
      sourceGeneration,
      sourceStatus,
      attemptId,
      generation,
      owner: { extension: "pi-workflows", runId: run.runId, nodeId, attemptId },
      ...(oldAgentId ? { supersededAgentId: oldAgentId } : {}),
    };
    const event: AttemptRecoveryEvent = {
      kind: "attempt_recovery",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: run.runId,
      nodeId,
      branchGeneration: this.recoveryBranchGeneration,
      rotation,
      ...(legacyMigration ? { legacyMigration: true } : {}),
      timestamp: Date.now(),
    };
    this.write(event);
    applyRecoveryEvent(run, event);
    this.rememberRecovery({
      branchGeneration: this.recoveryBranchGeneration,
      runId: run.runId,
      key: sourceKey,
      event,
    });
    this.resumeRecoveredNode(run, nodeId, resumeImmediately);
  }

  private resumeRecoveredNode(run: WorkflowRun, nodeId: string, resumeImmediately: boolean): void {
    if (!resumeImmediately) return;
    if (nodeId === SYNTHESIS_NODE_ID && run.status === "synthesizing") {
      const dispatch = this.dispatchSynthesis(run);
      this.trackDispatch(run.runId, dispatch);
    } else if (nodeId !== SYNTHESIS_NODE_ID && run.status === "running") {
      void this.pump(run);
    }
  }

  private applyManagedTerminal(run: WorkflowRun, nodeId: string, response: ManagedSpawnResponse): void {
    const snapshot = response.terminal;
    if (!snapshot) return;
    if (snapshot.status === "interrupted") {
      this.recoverInterruptedNode(run, nodeId, response.id);
      return;
    }
    const status = managedTerminalStatus(snapshot);
    const compactionCount = Math.max(run.compactions[nodeId] ?? 0, snapshot.compactionCount);
    const result = resultFromLifecycle(
      status,
      response.id,
      snapshot.result,
      snapshot.error,
      compactionCount,
      snapshot.completedAt,
      snapshot.outputFile,
      snapshot.tokenCount,
    );
    result.attemptId = run.attemptIds[nodeId];

    if (nodeId === SYNTHESIS_NODE_ID) {
      this.commitSynthesisTerminal(run, result, status);
      return;
    }
    if (!run.taskStatus[nodeId] || run.taskResults[nodeId] || isTerminalTask(run.taskStatus[nodeId])) return;
    this.commitTaskTerminal(run, nodeId, result, status);
    if (status === "completed" && run.status !== "stopping" && !this.settling.has(run.runId)) {
      this.maybePause(run);
      if (run.status === "running") void this.pump(run);
    }
  }

  /**
   * Append the journaled results of `task.inputs` to its prompt.
   *
   * Must be a pure function of the journaled prefix: the composed prompt feeds pi-subagents'
   * managed fingerprint, and a replay that recomposes a different prompt is reported as a spawn
   * key conflict and fails the run non-retryably. So: iterate the declared `inputs` array in
   * order (never `Object.keys(run.taskResults)`, whose order differs between a live run and a
   * replay), read only journaled result fields (never `run.taskStatus`, live agent state, or the
   * clock), and never throw — `dispatchTask` has no error path around composition.
   */
  private composeTaskPrompt(run: WorkflowRun, task: WorkflowTask): string {
    const inputs = task.inputs ?? [];
    if (inputs.length === 0) return task.prompt;
    const separator = "\n\n";
    // pi-subagents-protocol rejects an oversized prompt by throwing, so budget against the
    // remaining headroom rather than adding a fixed section and hoping it fits.
    const headroom = MAX_DISPATCH_PROMPT_CHARS - task.prompt.length - separator.length;
    const budget = Math.min(MAX_TASK_INPUT_CHARS, headroom);
    if (budget < MIN_TASK_INPUT_CHARS) return task.prompt;
    const entries: ResultEntry[] = inputs.map((id) => {
      const dependency = run.definition.tasks.find((candidate) => candidate.id === id);
      return {
        task: dependency ?? { id, description: id },
        result: run.taskResults[id],
        fallbackStatus: "missing",
      };
    });
    const section = buildBoundedResultSection([TASK_INPUT_HEADER], entries, {
      maxPerResult: MAX_TASK_RESULT_CHARS,
      maxTotal: budget,
      overflowMarker: "\n\n[dependency input truncated: additional results omitted]",
    });
    return cap(`${task.prompt}${separator}${section}`, MAX_DISPATCH_PROMPT_CHARS).text;
  }

  private async dispatchTask(run: WorkflowRun, nodeId: string, branchEpoch: number): Promise<void> {
    const task = run.definition.tasks.find((candidate) => candidate.id === nodeId);
    if (
      !task ||
      this.branchChanging ||
      branchEpoch !== this.branchEpoch ||
      this.runs.get(run.runId) !== run ||
      run.status !== "running"
    )
      return;
    const attemptId = run.attemptIds[nodeId];
    const prompt = this.composeTaskPrompt(run, task);
    const tierOverride = task.tier === undefined ? run.definition.tier : undefined;
    // Keeping the `task` identity when nothing changes guarantees a byte-identical dispatch
    // for every workflow that does not declare `inputs`.
    const dispatchTaskDefinition: WorkflowTask =
      tierOverride === undefined && prompt === task.prompt
        ? task
        : { ...task, prompt, ...(tierOverride === undefined ? {} : { tier: tierOverride }) };
    let response: ManagedSpawnResponse;
    try {
      response = normalizeManagedSpawnResponse(
        await spawnManaged(this.client, dispatchTaskDefinition, run.runId, nodeId, attemptId),
      );
    } catch (error: unknown) {
      if (branchEpoch !== this.branchEpoch || this.runs.get(run.runId) !== run) return;
      const message = boundedError(error) ?? "managed spawn failed";
      if ((run.status as WorkflowStatus) === "stopping") {
        if (!isTerminalTask(run.taskStatus[nodeId])) this.setTaskStatus(run, nodeId, "stopped", run.agentIds[nodeId]);
        return;
      }
      this.failTask(run, nodeId, message);
      return;
    }

    if (
      this.branchChanging ||
      branchEpoch !== this.branchEpoch ||
      this.runs.get(run.runId) !== run ||
      run.status !== "running"
    ) {
      if (
        !this.branchChanging &&
        branchEpoch === this.branchEpoch &&
        this.runs.get(run.runId) === run &&
        (run.status as WorkflowStatus) === "stopping"
      ) {
        run.agentIds[nodeId] = response.id;
        this.rememberLateDispatchTarget(run, nodeId, response.id, attemptId);
        return;
      }
      this.quarantineAgent(response.id);
      const allowStaleBranch = this.branchChanging || branchEpoch !== this.branchEpoch;
      const quiesced = await this.stopAndQuiesceOwned(
        run,
        nodeId,
        response.id,
        attemptId,
        branchEpoch,
        !response.terminal,
        allowStaleBranch,
      );
      if (allowStaleBranch && !quiesced) this.rememberLateDispatchQuiescence(run.runId, response.id);
      return;
    }
    if (response.terminal) {
      // Keep terminal persistence failures outside the spawn-error handler. A
      // journal append failure must leave the current attempt untouched rather
      // than turning an already durable managed result into a new task failure.
      this.tryLifecycleMutation(run, `managed-terminal:${nodeId}:${attemptId}`, () => {
        this.applyManagedTerminal(run, nodeId, response);
      });
      return;
    }
    if (
      this.branchChanging ||
      branchEpoch !== this.branchEpoch ||
      this.runs.get(run.runId) !== run ||
      run.status !== "running"
    ) {
      this.quarantineAgent(response.id);
      const allowStaleBranch = this.branchChanging || branchEpoch !== this.branchEpoch;
      const quiesced = await this.stopAndQuiesceOwned(
        run,
        nodeId,
        response.id,
        attemptId,
        branchEpoch,
        !response.terminal,
        allowStaleBranch,
      );
      if (allowStaleBranch && !quiesced) this.rememberLateDispatchQuiescence(run.runId, response.id);
      return;
    }
    const taskStatus = run.taskStatus[nodeId];
    if (response.state === "running" && (taskStatus === "dispatching" || taskStatus === "queued")) {
      this.setTaskStatus(run, nodeId, "running", response.id);
    } else if (taskStatus === "dispatching") {
      this.setTaskStatus(run, nodeId, "queued", response.id);
    }
  }

  private async dispatchSynthesis(run: WorkflowRun, branchEpoch = this.branchEpoch): Promise<void> {
    const synthesis = run.definition.synthesis;
    if (
      !synthesis ||
      this.branchChanging ||
      branchEpoch !== this.branchEpoch ||
      this.runs.get(run.runId) !== run ||
      run.status !== "synthesizing"
    )
      return;
    const prompt = buildSynthesisPrompt(run.definition, run);
    const task: WorkflowTask = {
      id: SYNTHESIS_NODE_ID,
      subagent_type: synthesis.subagent_type,
      tier: synthesis.tier ?? run.definition.tier,
      description: "Synthesize workflow results",
      prompt,
      depends_on: [],
    };
    const attemptId = run.attemptIds[SYNTHESIS_NODE_ID];
    let response: ManagedSpawnResponse;
    try {
      response = normalizeManagedSpawnResponse(
        await spawnManaged(this.client, task, run.runId, SYNTHESIS_NODE_ID, attemptId),
      );
    } catch (error: unknown) {
      if (branchEpoch !== this.branchEpoch || this.runs.get(run.runId) !== run) return;
      const result = resultFromLifecycle("failed", run.synthesisAgentId, undefined, boundedError(error), 0);
      result.attemptId = run.attemptIds[SYNTHESIS_NODE_ID];
      this.commitSynthesisTerminal(run, result, "failed");
      return;
    }

    if (
      this.branchChanging ||
      branchEpoch !== this.branchEpoch ||
      this.runs.get(run.runId) !== run ||
      run.status !== "synthesizing"
    ) {
      if (
        !this.branchChanging &&
        branchEpoch === this.branchEpoch &&
        this.runs.get(run.runId) === run &&
        (run.status as WorkflowStatus) === "stopping"
      ) {
        run.synthesisAgentId = response.id;
        this.rememberLateDispatchTarget(run, SYNTHESIS_NODE_ID, response.id, attemptId);
        return;
      }
      this.quarantineAgent(response.id);
      const allowStaleBranch = this.branchChanging || branchEpoch !== this.branchEpoch;
      const quiesced = await this.stopAndQuiesceOwned(
        run,
        SYNTHESIS_NODE_ID,
        response.id,
        attemptId,
        branchEpoch,
        !response.terminal,
        allowStaleBranch,
      );
      if (allowStaleBranch && !quiesced) this.rememberLateDispatchQuiescence(run.runId, response.id);
      return;
    }
    if (response.terminal) {
      // Do not route a terminal journal failure through the RPC error path; the
      // managed terminal fact remains retryable/recoverable as this attempt.
      this.tryLifecycleMutation(run, `managed-terminal:${SYNTHESIS_NODE_ID}:${attemptId}`, () => {
        this.applyManagedTerminal(run, SYNTHESIS_NODE_ID, response);
      });
      return;
    }
    run.synthesisAgentId ??= response.id;
    if (
      this.branchChanging ||
      branchEpoch !== this.branchEpoch ||
      this.runs.get(run.runId) !== run ||
      run.status !== "synthesizing"
    ) {
      this.quarantineAgent(response.id);
      const allowStaleBranch = this.branchChanging || branchEpoch !== this.branchEpoch;
      const quiesced = await this.stopAndQuiesceOwned(
        run,
        SYNTHESIS_NODE_ID,
        response.id,
        attemptId,
        branchEpoch,
        !response.terminal,
        allowStaleBranch,
      );
      if (allowStaleBranch && !quiesced) this.rememberLateDispatchQuiescence(run.runId, response.id);
      return;
    }
  }
  /**
   * Gate lifecycle observations at the workflow boundary. Attempt-aware runs
   * must carry the exact current generation and agent identity; only a created
   * event may establish an agent id when dispatch has not returned one yet.
   * Legacy journal runs intentionally retain the pre-v2 permissive behavior.
   */
  private acceptsLifecycleEvent(
    run: WorkflowRun,
    nodeId: string,
    eventName: string,
    ownerAttemptId: string | undefined,
    agentId: string | undefined,
  ): boolean {
    const expectedAttemptId = run.attemptIds[nodeId];
    if (run.attemptTracking) {
      if (!expectedAttemptId || ownerAttemptId !== expectedAttemptId || !agentId) return false;
    }

    const expectedAgentId = nodeId === SYNTHESIS_NODE_ID ? run.synthesisAgentId : run.agentIds[nodeId];
    if (agentId && expectedAgentId && agentId !== expectedAgentId) return false;
    if (run.attemptTracking && !expectedAgentId && eventName !== "subagents:created") return false;
    return true;
  }

  private onLifecycle(eventName: string, data: Record<string, unknown>): void {
    if (this.lifecycleSuspended || this.branchChanging || this.branchEventsClosed) return;
    const owner = ownerFor(data);
    if (!owner) return;
    const run = this.runs.get(owner.runId);
    if (!run) return;
    const agentId = typeof data.id === "string" ? data.id : undefined;
    if (agentId && this.quarantinedAgentIds.has(agentId)) return;
    if (owner.nodeId !== SYNTHESIS_NODE_ID && !(owner.nodeId in run.taskStatus)) return;

    const settling = run.status === "stopping" || this.settling.has(run.runId);
    if (isTerminalWorkflow(run.status)) return;
    if (!this.acceptsLifecycleEvent(run, owner.nodeId, eventName, owner.attemptId, agentId)) return;
    const terminalEvent = eventName === "subagents:completed" || eventName === "subagents:failed";
    if (run.status === "stopping" && !terminalEvent) return;
    if (
      owner.nodeId === SYNTHESIS_NODE_ID
        ? run.synthesisResult !== undefined
        : run.taskResults[owner.nodeId] !== undefined || isTerminalTask(run.taskStatus[owner.nodeId])
    )
      return;

    if (eventName === "subagents:compacted") {
      const previousCount = run.compactions[owner.nodeId] ?? 0;
      const observedCount = data.compactionCount;
      const count =
        typeof observedCount === "number" && Number.isSafeInteger(observedCount) && observedCount >= 0
          ? Math.max(previousCount, observedCount)
          : previousCount + 1;
      const timestamp = Date.now();
      const event: JournalEvent = {
        kind: "task_compacted",
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        runId: run.runId,
        nodeId: owner.nodeId,
        compactionCount: count,
        attemptId: run.attemptIds[owner.nodeId],
        owner: this.ownerForNode(run, owner.nodeId),
        timestamp,
      };
      this.tryLifecycleMutation(run, `compacted:${owner.nodeId}:${count}`, () => {
        this.write(event);
        run.compactions[owner.nodeId] = Math.max(run.compactions[owner.nodeId] ?? 0, count);
        run.updatedAt = timestamp;
      });
      return;
    }

    if (owner.nodeId === SYNTHESIS_NODE_ID) {
      if (eventName === "subagents:created" && agentId) run.synthesisAgentId ??= agentId;
      if (eventName === "subagents:started" || !terminalEvent) return;
      const status = statusFromLifecycle(eventName, data);
      const timestamp = Date.now();
      const result = resultFromLifecycle(
        status,
        agentId ?? run.synthesisAgentId,
        data.result,
        data.error,
        run.compactions[SYNTHESIS_NODE_ID] ?? 0,
        timestamp,
        data.outputFile,
        tokenCountFrom(data.tokens),
      );
      result.attemptId = run.attemptIds[SYNTHESIS_NODE_ID];
      this.tryLifecycleMutation(run, `terminal:${owner.nodeId}:${owner.attemptId ?? "legacy"}`, () => {
        this.commitSynthesisTerminal(run, result, status);
      });
      return;
    }

    if (eventName === "subagents:created") {
      if (run.taskStatus[owner.nodeId] === "dispatching") {
        this.tryLifecycleMutation(run, `created:${owner.nodeId}:${owner.attemptId ?? "legacy"}`, () => {
          this.setTaskStatus(run, owner.nodeId, "queued", agentId);
        });
      }
      return;
    }
    if (eventName === "subagents:started") {
      if (run.taskStatus[owner.nodeId] === "dispatching" || run.taskStatus[owner.nodeId] === "queued") {
        this.tryLifecycleMutation(run, `started:${owner.nodeId}:${owner.attemptId ?? "legacy"}`, () => {
          this.setTaskStatus(run, owner.nodeId, "running", agentId);
        });
      }
      return;
    }
    if (!terminalEvent) return;

    const status = statusFromLifecycle(eventName, data);
    const timestamp = Date.now();
    const result = resultFromLifecycle(
      status,
      agentId ?? run.agentIds[owner.nodeId],
      data.result,
      data.error,
      run.compactions[owner.nodeId] ?? 0,
      timestamp,
      data.outputFile,
      tokenCountFrom(data.tokens),
    );
    result.attemptId = run.attemptIds[owner.nodeId];
    this.tryLifecycleMutation(run, `terminal:${owner.nodeId}:${owner.attemptId ?? "legacy"}`, () => {
      this.commitTaskTerminal(run, owner.nodeId, result, status);
      if (status === "completed" && !settling && run.status !== "stopping") {
        this.maybePause(run);
        if (run.status === "running") void this.pump(run);
      }
    });
  }

  private blockDependents(run: WorkflowRun, failedNodeId: string): void {
    const blockedIds = this.blockedDependentIds(run, failedNodeId);
    if (blockedIds.length === 0) return;
    const timestamp = Date.now();
    const events: JournalEvent[] = blockedIds.map((nodeId) => ({
      kind: "task_transition",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: run.runId,
      nodeId,
      status: "blocked",
      ...(run.attemptIds[nodeId] ? { attemptId: run.attemptIds[nodeId] } : {}),
      owner: this.ownerForNode(run, nodeId),
      timestamp,
    }));
    this.appendEvents(events);
    for (const nodeId of blockedIds) run.taskStatus[nodeId] = "blocked";
    run.updatedAt = timestamp;
  }

  private failTask(run: WorkflowRun, nodeId: string, message: string): void {
    if (isTerminalWorkflow(run.status) || run.terminalIntent === "stop") return;
    const result = resultFromLifecycle(
      "failed",
      run.agentIds[nodeId],
      undefined,
      message,
      run.compactions[nodeId] ?? 0,
    );
    result.attemptId = run.attemptIds[nodeId];
    this.commitTaskTerminal(run, nodeId, result, "failed", message);
  }

  /**
   * Failure policy: fail-fast for scheduling, but never abandon sibling agents.
   * Mark the intent, stop every remaining owned agent, consume/journal terminal
   * callbacks, then settle the workflow as failed with dependents blocked.
   */
  private beginFailureCleanup(run: WorkflowRun, message: string): void {
    if (isTerminalWorkflow(run.status) || run.terminalIntent === "stop") return;
    if (run.terminalIntent !== "failure" || run.status !== "stopping" || run.error !== message) {
      this.setWorkflowStatus(run, "stopping", message, "failure");
    }
    this.startFailureCleanup(run, message);
  }

  private startFailureCleanup(run: WorkflowRun, message: string): void {
    if (isTerminalWorkflow(run.status) || run.terminalIntent !== "failure") return;
    if (this.settling.has(run.runId)) return;
    const cleanup = this.settleTerminalCleanup(run, message);
    this.settling.set(run.runId, cleanup);
    void cleanup.then(
      () => {
        if (this.settling.get(run.runId) === cleanup) this.settling.delete(run.runId);
      },
      () => {
        if (this.settling.get(run.runId) === cleanup) this.settling.delete(run.runId);
      },
    );
  }

  private terminalRecoveryKey(runId: string, sourceKey: string): string {
    return JSON.stringify([this.recoveryBranchGeneration, runId, "terminal_recovery", sourceKey]);
  }

  private applyTerminalRecoveryMemo(run: WorkflowRun, memo: TerminalRecoveryMemo): void {
    applyTerminalRecoveryEvent(run, memo.event);
  }

  private rememberTerminalRecovery(memo: TerminalRecoveryMemo): void {
    const key = this.terminalRecoveryKey(memo.runId, memo.key);
    this.terminalRecoveryMemo.delete(key);
    this.terminalRecoveryMemo.set(key, memo);
    while (this.terminalRecoveryMemo.size > MAX_RECOVERY_MEMO_ENTRIES) {
      const oldest = this.terminalRecoveryMemo.keys().next().value;
      if (typeof oldest !== "string") break;
      this.terminalRecoveryMemo.delete(oldest);
    }
  }

  /**
   * Complete a terminal-intent run recovered from a session branch with one
   * durable state transition. The event is built entirely from an immutable
   * source snapshot; append is the only boundary before applying it.
   */
  private recoverTerminalIntent(run: WorkflowRun, terminalRecords: readonly DeferredTerminalRecord[]): void {
    const source = snapshotRun(run);
    const terminalRecordsForKey = [...terminalRecords]
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId) || left.attemptId.localeCompare(right.attemptId))
      .map((record) => ({
        nodeId: record.nodeId,
        attemptId: record.attemptId,
        owner: record.owner,
        result: { ...record.result, updatedAt: 0 },
      }));
    const sourceKey = JSON.stringify({ source, terminalRecords: terminalRecordsForKey });
    const memo = this.terminalRecoveryMemo.get(this.terminalRecoveryKey(run.runId, sourceKey));
    if (memo) {
      this.applyTerminalRecoveryMemo(run, memo);
      return;
    }

    const terminalIntent = source.terminalIntent;
    if (terminalIntent === undefined) return;
    const fallbackError =
      source.error ?? (terminalIntent === "failure" ? "workflow failure cleanup" : "workflow stopped");
    const recoveredByNode = new Map(terminalRecords.map((record) => [record.nodeId, record]));
    const finalStatuses: Record<string, TaskStatus> = { ...source.taskStatus };
    const resultForNode = (nodeId: string): WorkflowRun["taskResults"][string] | undefined => {
      const sourceResult = source.taskResults[nodeId];
      if (sourceResult) {
        return { ...sourceResult, attemptId: source.attemptIds[nodeId] };
      }
      const recovered = recoveredByNode.get(nodeId)?.result;
      if (!recovered) return undefined;
      return { ...recovered, attemptId: source.attemptIds[nodeId], updatedAt: source.updatedAt };
    };
    for (const task of source.definition.tasks) {
      const observed = resultForNode(task.id);
      if (observed && !isTerminalTask(source.taskStatus[task.id])) finalStatuses[task.id] = observed.status;
    }

    const blockedNodeIds = new Set(
      source.definition.tasks.filter((task) => source.taskStatus[task.id] === "blocked").map((task) => task.id),
    );
    if (terminalIntent === "failure") {
      const failedOrBlocked = new Set(
        source.definition.tasks
          .filter((task) => finalStatuses[task.id] === "failed" || finalStatuses[task.id] === "blocked")
          .map((task) => task.id),
      );
      let changed = true;
      while (changed) {
        changed = false;
        for (const task of source.definition.tasks) {
          if (isTerminalTask(finalStatuses[task.id])) continue;
          if (!task.depends_on.some((dependency) => failedOrBlocked.has(dependency))) continue;
          finalStatuses[task.id] = "blocked";
          failedOrBlocked.add(task.id);
          blockedNodeIds.add(task.id);
          changed = true;
        }
      }
    }

    const terminalResults: RecoveryTerminalResult[] = [];
    const terminalFact = (nodeId: string, result: WorkflowRun["taskResults"][string]): RecoveryTerminalResult => {
      const attemptId = source.attemptIds[nodeId];
      return {
        nodeId,
        attemptId,
        result: { ...result, attemptId },
        owner: { extension: "pi-workflows", runId: source.runId, nodeId, attemptId },
      };
    };
    for (const task of source.definition.tasks) {
      const sourceStatus = source.taskStatus[task.id];
      if (isTerminalTask(sourceStatus)) continue;
      if (blockedNodeIds.has(task.id)) continue;
      const result =
        resultForNode(task.id) ??
        resultFromLifecycle(
          "stopped",
          source.agentIds[task.id],
          undefined,
          fallbackError,
          source.compactions[task.id] ?? 0,
          source.updatedAt,
        );
      terminalResults.push(terminalFact(task.id, result));
    }

    if (source.definition.synthesis && !source.synthesisResult) {
      const observed = source.synthesisResult ?? recoveredByNode.get(SYNTHESIS_NODE_ID)?.result;
      const result =
        observed ??
        resultFromLifecycle(
          "stopped",
          source.synthesisAgentId,
          undefined,
          fallbackError,
          source.compactions[SYNTHESIS_NODE_ID] ?? 0,
          source.updatedAt,
        );
      terminalResults.push(terminalFact(SYNTHESIS_NODE_ID, result));
    }

    const recoveryBase = {
      kind: "terminal_recovery" as const,
      schemaVersion: JOURNAL_SCHEMA_VERSION as 2,
      runId: source.runId,
      status: terminalIntent === "failure" ? ("failed" as const) : ("stopped" as const),
      terminalIntent,
      branchGeneration: this.recoveryBranchGeneration,
      terminalResults,
      blockedNodeIds: [...blockedNodeIds].sort(),
      error: fallbackError,
    };
    const event: TerminalRecoveryEvent = {
      ...recoveryBase,
      recoveryId: deriveRecoveryId(recoveryBase),
      timestamp: source.updatedAt,
    };
    // Do not mutate the replayed run or memoize until this single append succeeds.
    this.write(event);
    applyTerminalRecoveryEvent(run, event);
    this.rememberTerminalRecovery({
      branchGeneration: this.recoveryBranchGeneration,
      runId: run.runId,
      key: sourceKey,
      event,
    });
  }

  private async settleTerminalCleanup(
    run: WorkflowRun,
    message: string,
    cleanupEpoch = this.branchEpoch,
    cleanupTargets?: TerminalCleanupTarget[],
  ): Promise<void> {
    const isCurrent = (): boolean =>
      !this.branchChanging && cleanupEpoch === this.branchEpoch && this.runs.get(run.runId) === run;
    // Capture exact owners before the first yield. A pending lifecycle callback
    // may make a target terminal before the cleanup RPC is allowed to run.
    let pendingTargets = cleanupTargets ? [...cleanupTargets] : this.initialTerminalCleanupTargets(run);
    // Let beginFailureCleanup/stop publish the promise in `settling` before a
    // synchronous stop RPC can emit lifecycle callbacks.
    await Promise.resolve();
    if (!isCurrent()) return;
    const addTarget = (target: TerminalCleanupTarget): void => {
      if (
        pendingTargets.some(
          (existing) =>
            existing.agentId === target.agentId &&
            existing.owner.nodeId === target.owner.nodeId &&
            existing.owner.attemptId === target.owner.attemptId,
        )
      )
        return;
      pendingTargets.push(target);
    };
    for (const target of this.takeLateDispatchTargets(run)) addTarget(target);

    let agentsSettled = pendingTargets.length === 0;
    if (pendingTargets.length > 0) {
      if (this.client.quiesceOwned) {
        const agentIds = pendingTargets.map(({ agentId }) => agentId);
        const owners = pendingTargets.map(({ owner }) => owner);
        const result = await this.client.quiesceOwned(run.runId, agentIds, BRANCH_QUIESCE_TIMEOUT_MS, owners).catch(
          (error: unknown): WorkflowQuiesceResult => ({
            settled: false,
            pending: agentIds,
            diagnostic: `owned quiescence failed: ${boundedError(error) ?? "unknown error"}`,
          }),
        );
        const pendingIds = new Set(result.pending);
        if (result.settled && result.pending.length === 0) {
          pendingTargets = [];
        } else {
          const retained = pendingTargets.filter((target) => pendingIds.has(target.agentId));
          // A false result without a matching pending id does not prove that
          // any target settled. Keep the exact targets and retry fail-closed.
          pendingTargets = result.pending.length === 0 || retained.length === 0 ? pendingTargets : retained;
        }
        agentsSettled = pendingTargets.length === 0;
      } else {
        // An owner-scoped stop only requests cancellation; without the v3
        // quiescence proof, the AgentSession may still own provider work.
        const stopPromises = pendingTargets
          .filter((target) => !target.fallbackStopRequested)
          .map((target) => {
            target.fallbackStopRequested = true;
            return this.stopOwned(run, target.owner.nodeId, target.agentId, target.owner.attemptId).catch(() => {});
          });
        await Promise.allSettled(stopPromises);
        agentsSettled = false;
      }
    }

    const dispatchesSettled = await this.waitForDispatches(run.runId, BRANCH_QUIESCE_TIMEOUT_MS);
    if (!isCurrent()) return;
    let lateTargetsAdded = false;
    for (const target of this.takeLateDispatchTargets(run)) {
      const previousCount = pendingTargets.length;
      addTarget(target);
      lateTargetsAdded ||= pendingTargets.length > previousCount;
    }
    agentsSettled = pendingTargets.length === 0;
    if (lateTargetsAdded) {
      if (isCurrent()) await this.settleTerminalCleanup(run, message, cleanupEpoch, pendingTargets);
      return;
    }
    if (!agentsSettled || !dispatchesSettled) {
      // A stop acknowledgement only requests cancellation; the AgentSession
      // still owns provider work and its pool slot until its promise settles.
      // Stay in `stopping` and retry instead of publishing a false terminal run.
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      if (isCurrent()) await this.settleTerminalCleanup(run, message, cleanupEpoch, pendingTargets);
      return;
    }

    if (this.hasPendingJournalWork(run.runId)) {
      // Do not synthesize a stopped/failed fact over a lifecycle callback whose
      // durable prefix is still retrying (or has become permanently blocked).
      // A retry may commit the observed terminal result and make the synthetic
      // fact unnecessary; a blocked journal must remain nonterminal fail-closed.
      if (this.journalBlockedRuns.has(run.runId)) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      if (isCurrent()) await this.settleTerminalCleanup(run, message, cleanupEpoch, pendingTargets);
      return;
    }

    for (const [nodeId, status] of Object.entries(run.taskStatus)) {
      if (isTerminalTask(status)) continue;
      const result =
        run.taskResults[nodeId] ??
        resultFromLifecycle(
          "stopped",
          run.agentIds[nodeId],
          undefined,
          run.terminalIntent === "failure" ? "workflow failure cleanup" : message,
          run.compactions[nodeId] ?? 0,
        );
      result.attemptId ??= run.attemptIds[nodeId];
      this.commitTaskTerminal(run, nodeId, result, "stopped", undefined, false);
    }

    if (run.synthesisAgentId && !run.synthesisResult) {
      const result = resultFromLifecycle(
        "stopped",
        run.synthesisAgentId,
        undefined,
        run.terminalIntent === "failure" ? "workflow failure cleanup" : message,
        run.compactions[SYNTHESIS_NODE_ID] ?? 0,
      );
      result.attemptId = run.attemptIds[SYNTHESIS_NODE_ID];
      this.commitSynthesisTerminal(run, result, "stopped");
    }

    if (run.status === "stopping" && isCurrent()) {
      this.setWorkflowStatus(run, run.terminalIntent === "failure" ? "failed" : "stopped", message);
      this.lateDispatchTargets.delete(run.runId);
    }
  }

  private async failRun(run: WorkflowRun, message: string): Promise<void> {
    if (isTerminalWorkflow(run.status)) return;
    for (const task of run.definition.tasks) {
      if (run.taskStatus[task.id] === "failed") this.blockDependents(run, task.id);
    }
    this.beginFailureCleanup(run, message);
    const cleanup = this.settling.get(run.runId);
    if (cleanup) await cleanup;
  }

  private maybePause(run: WorkflowRun): void {
    if (run.status !== "pausing") return;
    if (!Object.values(run.taskStatus).some(activeStatus) && !run.synthesisAgentId) {
      this.setWorkflowStatus(run, "paused");
    }
  }

  private async stop(run: WorkflowRun): Promise<void> {
    if (isTerminalWorkflow(run.status)) return;
    if (run.status !== "stopping" || run.terminalIntent !== "stop" || run.error !== "workflow stopped") {
      this.setWorkflowStatus(run, "stopping", "workflow stopped", "stop");
    }
    run.nonResumable = true;
    const existing = this.settling.get(run.runId);
    if (existing) {
      await existing;
      return;
    }
    const cleanup = this.settleTerminalCleanup(run, "workflow stopped");
    this.settling.set(run.runId, cleanup);
    try {
      await cleanup;
    } finally {
      if (this.settling.get(run.runId) === cleanup) this.settling.delete(run.runId);
    }
  }

  private reconcileManagedSpawnTombstone(entry: SessionEntryLike): DeferredTerminalRecord | undefined {
    if (entry.type !== "custom" || entry.customType !== "subagents:managed-spawn" || !isRecord(entry.data)) return;
    const data = entry.data;
    const allowedKeys = new Set([
      "schemaVersion",
      "spawnKey",
      "fingerprint",
      "id",
      "requestId",
      "type",
      "description",
      "owner",
      "tier",
      "tierSnapshot",
      "state",
      "createdAt",
      "updatedAt",
      "compactionCount",
      "terminal",
    ]);
    if (Object.keys(data).some((key) => !allowedKeys.has(key))) return;
    if (data.schemaVersion !== 1 || (data.state !== "completed" && data.state !== "failed" && data.state !== "stopped"))
      return;
    const tier = data.tier;
    if (tier !== undefined && (typeof tier !== "string" || !WORKFLOW_TIER_VALUES.has(tier))) return;
    if (data.tierSnapshot !== undefined && (typeof tier !== "string" || !isValidTierSnapshot(data.tierSnapshot, tier)))
      return;
    const bounded = (value: unknown, max: number): string | undefined =>
      typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value
        ? value
        : undefined;
    const spawnKey = bounded(data.spawnKey, 256);
    const id = bounded(data.id, 128);
    const fingerprint = bounded(data.fingerprint, 128);
    const requestId = bounded(data.requestId, 128);
    const type = bounded(data.type, 128);
    const description = bounded(data.description, 512);
    if (!spawnKey || !id || !fingerprint || !requestId || !type || !description || !isRecord(data.owner)) return;
    const ownerKeys = new Set(["extension", "runId", "nodeId", "attemptId"]);
    if (Object.keys(data.owner).some((key) => !ownerKeys.has(key))) return;
    const ownerRunId = bounded(data.owner.runId, 256);
    const ownerNodeId = bounded(data.owner.nodeId, 256);
    const ownerAttemptId = bounded(data.owner.attemptId, 256);
    if (data.owner.extension !== "pi-workflows" || !ownerRunId || !ownerNodeId || !ownerAttemptId) return;
    const run = this.runs.get(ownerRunId);
    if (!run || isTerminalWorkflow(run.status)) return;
    const isSynthesis = ownerNodeId === SYNTHESIS_NODE_ID;
    if (!isSynthesis && !(ownerNodeId in run.taskStatus)) return;
    if (isSynthesis && !run.definition.synthesis) return;
    const currentAttemptId = run.attemptIds[ownerNodeId];
    const generation = run.attempts[ownerNodeId];
    if (!currentAttemptId || !Number.isSafeInteger(generation) || generation < 1 || ownerAttemptId !== currentAttemptId)
      return;
    if (currentAttemptId !== `${run.runId}/${ownerNodeId}/attempt-${generation}`) return;
    const expectedSpawnKeys = new Set([
      currentAttemptId,
      `${run.runId}/${ownerNodeId}/${currentAttemptId}`,
      `${run.runId}/${ownerNodeId}/attempt-${generation}`,
      `${run.runId}:${ownerNodeId}:${currentAttemptId}`,
    ]);
    if (!expectedSpawnKeys.has(spawnKey)) return;
    const currentAgentId = isSynthesis ? run.synthesisAgentId : run.agentIds[ownerNodeId];
    if (currentAgentId && currentAgentId !== id) return;
    if (isSynthesis ? run.synthesisResult : run.taskResults[ownerNodeId]) return;
    if (!isSynthesis && isTerminalTask(run.taskStatus[ownerNodeId])) return;

    const terminal = data.terminal;
    if (!isRecord(terminal)) return;
    const terminalKeys = new Set([
      "status",
      "result",
      "error",
      "outputFile",
      "tokenCount",
      "compactionCount",
      "completedAt",
    ]);
    if (Object.keys(terminal).some((key) => !terminalKeys.has(key))) return;
    if (terminal.status !== data.state) return;
    const resultText = terminal.result === undefined ? undefined : bounded(terminal.result, 8_000);
    const errorText = terminal.error === undefined ? undefined : bounded(terminal.error, 2_000);
    const outputFile = terminal.outputFile === undefined ? undefined : bounded(terminal.outputFile, 2_000);
    if (
      (terminal.result !== undefined && !resultText) ||
      (terminal.error !== undefined && !errorText) ||
      (terminal.outputFile !== undefined && !outputFile)
    )
      return;
    const compactionCount = terminal.compactionCount;
    const persistedCompactionCount = data.compactionCount;
    const completedAt = terminal.completedAt;
    const createdAt = data.createdAt;
    const updatedAt = data.updatedAt;
    if (
      typeof compactionCount !== "number" ||
      !Number.isSafeInteger(compactionCount) ||
      compactionCount < 0 ||
      typeof persistedCompactionCount !== "number" ||
      !Number.isSafeInteger(persistedCompactionCount) ||
      persistedCompactionCount !== compactionCount ||
      typeof completedAt !== "number" ||
      !Number.isFinite(completedAt) ||
      completedAt < 0 ||
      typeof createdAt !== "number" ||
      !Number.isFinite(createdAt) ||
      createdAt < 0 ||
      typeof updatedAt !== "number" ||
      !Number.isFinite(updatedAt) ||
      updatedAt < createdAt ||
      completedAt < createdAt ||
      completedAt > updatedAt
    )
      return;
    const tokenCount = terminal.tokenCount;
    if (
      tokenCount !== undefined &&
      (typeof tokenCount !== "number" || !Number.isSafeInteger(tokenCount) || tokenCount < 0)
    )
      return;
    const status = data.state === "completed" ? "completed" : data.state === "stopped" ? "stopped" : "failed";
    const result = resultFromLifecycle(
      status,
      id,
      resultText,
      errorText,
      compactionCount,
      completedAt,
      outputFile,
      tokenCount,
    );
    result.attemptId = currentAttemptId;
    return {
      kind: "terminal",
      runId: run.runId,
      nodeId: ownerNodeId,
      attemptId: currentAttemptId,
      result,
      owner: { extension: "pi-workflows", runId: run.runId, nodeId: ownerNodeId, attemptId: currentAttemptId },
    };
  }
  private reconcileSubagentRecord(
    entry: SessionEntryLike,
  ): DeferredInterruptedRecord | DeferredTerminalRecord | undefined {
    if (entry.type !== "custom" || entry.customType !== "subagents:record" || !isRecord(entry.data)) return;
    const owner = ownerFor(entry.data);
    if (!owner) return;
    const run = this.runs.get(owner.runId);
    if (!run) return;
    if (isTerminalWorkflow(run.status)) return;
    if (owner.nodeId !== SYNTHESIS_NODE_ID && !(owner.nodeId in run.taskStatus)) return;

    const currentAttemptId = run.attemptIds[owner.nodeId];
    const recordAgentId = typeof entry.data.id === "string" ? entry.data.id : undefined;
    if (!this.acceptsLifecycleEvent(run, owner.nodeId, "subagents:record", owner.attemptId, recordAgentId)) return;
    const currentAgentId = owner.nodeId === SYNTHESIS_NODE_ID ? run.synthesisAgentId : run.agentIds[owner.nodeId];
    const status = entry.data.status;
    if (
      status !== "completed" &&
      status !== "steered" &&
      status !== "error" &&
      status !== "stopped" &&
      status !== "aborted" &&
      status !== "interrupted"
    )
      return;

    // An interrupted record is not a failed task result. It means the previous
    // AgentSession disappeared during reload. Legacy records without an
    // attemptId are accepted only while their agent id is still the current
    // journaled agent; after a recovery event clears that id, the same old
    // record is ignored on every later restore.
    if (status === "interrupted") {
      if (run.terminalIntent) return;
      if (!owner.attemptId && (!recordAgentId || !currentAgentId || recordAgentId !== currentAgentId)) return;
      if (owner.nodeId === SYNTHESIS_NODE_ID ? run.synthesisResult : run.taskResults[owner.nodeId]) return;
      return {
        kind: "interrupted",
        runId: run.runId,
        nodeId: owner.nodeId,
        oldAgentId: recordAgentId ?? currentAgentId ?? "",
      };
    }

    const resultStatus =
      status === "completed" || status === "steered" ? "completed" : status === "stopped" ? "stopped" : "failed";
    if (owner.nodeId === SYNTHESIS_NODE_ID ? run.synthesisResult : run.taskResults[owner.nodeId]) return;
    if (!currentAttemptId) return;
    const result = resultFromLifecycle(
      resultStatus,
      recordAgentId ?? currentAgentId,
      entry.data.result,
      entry.data.error,
      run.compactions[owner.nodeId] ?? 0,
      Date.now(),
      entry.data.outputFile,
      typeof entry.data.tokens === "number" ? entry.data.tokens : undefined,
    );
    result.attemptId = currentAttemptId;
    return {
      kind: "terminal",
      runId: run.runId,
      nodeId: owner.nodeId,
      attemptId: currentAttemptId,
      result,
      owner: {
        extension: "pi-workflows",
        runId: run.runId,
        nodeId: owner.nodeId,
        attemptId: currentAttemptId,
      },
    };
  }

  private resolveWaiters(run: WorkflowRun): void {
    const waiters = this.waiters.get(run.runId);
    if (!waiters) return;
    this.waiters.delete(run.runId);
    for (const waiter of waiters) {
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.cleanup();
      waiter.resolve(run);
    }
  }

  private summary(run: WorkflowRun, includeDetails = false): WorkflowSummary {
    const statuses = Object.values(run.taskStatus);
    const completedTasks = statuses.filter((status) => status === "completed").length;
    const failedTasks = statuses.filter(
      (status) => status === "failed" || status === "blocked" || status === "stopped",
    ).length;
    const activeTasks = statuses.filter(activeStatus).length;
    const phaseCompletion = run.definition.phases.map((phase) => {
      const phaseTasks = run.definition.tasks.filter((task) => task.phase === phase.id);
      return phaseTasks.length > 0 && phaseTasks.every((task) => run.taskStatus[task.id] === "completed");
    });
    const completedPhases = phaseCompletion.filter(Boolean).length;
    const tokenValues = [...Object.values(run.taskResults), ...(run.synthesisResult ? [run.synthesisResult] : [])]
      .map((result) => result.tokenCount)
      .filter((value): value is number => value !== undefined);
    const tokenCount = tokenValues.length > 0 ? tokenValues.reduce((total, value) => total + value, 0) : undefined;
    const taskDetails = includeDetails
      ? run.definition.tasks.map((task) => ({
          id: task.id,
          status: run.taskStatus[task.id] ?? "pending",
          ...(run.agentIds[task.id] ? { agentId: run.agentIds[task.id] } : {}),
          compactions: run.compactions[task.id] ?? 0,
          ...resultPreview(run.taskResults[task.id]),
        }))
      : undefined;
    const synthesisDetails =
      includeDetails && run.synthesisResult
        ? {
            status: run.synthesisResult.status,
            ...(run.synthesisAgentId ? { agentId: run.synthesisAgentId } : {}),
            compactions: run.compactions[SYNTHESIS_NODE_ID] ?? 0,
            ...resultPreview(run.synthesisResult),
          }
        : undefined;
    return {
      runId: run.runId,
      name: run.definition.name,
      ...(run.definition.description ? { description: run.definition.description } : {}),
      status: run.status,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      elapsedMs: Math.max(
        0,
        (run.status === "completed" || run.status === "failed" || run.status === "stopped"
          ? run.updatedAt
          : Date.now()) - run.startedAt,
      ),
      taskCount: run.definition.tasks.length,
      phaseCount: run.definition.phases.length,
      completedPhases,
      completedTasks,
      failedTasks,
      activeTasks,
      ...(tokenCount === undefined ? {} : { tokenCount }),
      ...(run.synthesisResult?.text ? { synthesisPreview: run.synthesisResult.text.slice(0, 500) } : {}),
      ...(run.error ? { error: run.error.slice(0, 2_000) } : {}),
      ...(run.nonResumable ? { nonResumable: true } : {}),
      ...(taskDetails ? { tasks: taskDetails } : {}),
      ...(synthesisDetails ? { synthesis: synthesisDetails } : {}),
    };
  }
}
