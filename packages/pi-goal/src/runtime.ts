import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkpointGoalActiveTime, formatDuration, formatTokenCount, updateGoalUsage } from "./accounting.js";
import { formatError, notifyTerminal, truncateNotification } from "./errors.js";
import { appendGoalPromptMarker, extractContinuationMarker, extractGoalPromptMarker } from "./markers.js";
import {
  type ActiveGoal,
  clearLegacyPersistedGoal,
  type PendingQueueAction,
  type SafetyPauseCause,
  serializeGoalState,
} from "./persistence.js";
import { buildContinuePrompt, type GoalStatus } from "./prompts.js";
import { nextToolFreeRepeatState, resetGoalSafetyEpoch } from "./safety.js";

export { queueGoalSafetyReset, resetGoalSafetyEpoch } from "./safety.js";

import { DEFAULT_GOAL_SETTINGS, type GoalSettings, type GoalSettingsLoadIssue } from "./settings.js";
import { GoalToolPolicy, type GoalToolVisibilitySnapshot } from "./tool-policy.js";
import { GoalWaitTimer } from "./wait.js";

export { GOAL_BLOCKED_TOOL, GOAL_COMPLETE_TOOL, GOAL_TOOL_NAMES, GOAL_WAIT_TOOL } from "./tool-policy.js";

export interface ContinuationTicket {
  goalId: string;
  iteration: number;
  marker: string;
  prompt: string;
}

export interface BudgetWrapUp {
  goalId: string;
  delivered: boolean;
}

export type GoalRecoveryKind = "provider_retry" | "compaction_retry";

export type GoalRunOrigin = "manual" | "automatic";

export interface GoalRecovery {
  goalId: string;
  kind: GoalRecoveryKind;
  automaticOwner: boolean;
  errorMessage?: string;
}

export interface CompletedGoalRun {
  goalId?: string | null;
  origin?: GoalRunOrigin;
  toolAttempted: boolean;
}

type StoppedGoalStatus = "paused" | "blocked" | "usage_limited" | "budget_limited";

export type GoalStopRequest =
  | { kind: "explicit_pause"; expectedGoalId: string }
  | { kind: "budget_limit"; expectedGoalId: string; reason: string }
  | {
      kind: "safety_pause";
      expectedGoalId: string;
      cause: SafetyPauseCause;
      abortTurn: boolean;
      reason: string;
    }
  | { kind: "retry_exhausted"; expectedGoalId: string; reason: string }
  /**
   * `goal_wait`: the goal has no work left until something outside the session
   * happens. Stops exactly like a reported blocker — same usage accounting,
   * same stale-call block — but lands on `paused`, which is already the state
   * every resume path knows how to bring back.
   */
  | { kind: "wait"; expectedGoalId: string; reason: string }
  | {
      kind: "tools_unavailable";
      expectedGoalId: string;
      abortTurn: boolean;
      recordUsage: boolean;
    }
  | { kind: "blocker_report"; expectedGoalId: string; reason: string }
  | {
      kind: "agent_interruption";
      expectedGoalId: string;
      status: "paused" | "blocked" | "usage_limited";
      reason: string;
    }
  | {
      kind: "activation_rollback";
      expectedGoalId: string;
      restoreGoal: ActiveGoal;
      abortTurn: boolean;
    };

export interface StatusContext {
  cwd: string;
  mode?: "tui" | "rpc" | "json" | "print";
  ui: {
    confirm: (title: string, message: string) => Promise<boolean>;
    notify: (message: string, level?: "info" | "warning" | "error") => void;
    setStatus: (key: string, value: string | undefined) => void;
  };
  isIdle?: () => boolean;
  hasPendingMessages?: () => boolean;
  abort?: () => void;
  sessionManager?: unknown;
}

export const STATUS_KEY = "goal";
export const GOAL_STATE_ENTRY_TYPE = "goal-state";
export const MAX_GOAL_ID_LENGTH = 128;

/** Canonical Goal state passed to the in-process managed-run publisher. */
export type GoalStateSnapshotStatus = GoalStatus | "cleared";

export interface GoalStateSnapshot {
  goalId: string;
  status: GoalStateSnapshotStatus;
  summary?: string;
  reason?: string;
}

/** Terminal statuses for Goal persistence and managed-run lifecycle publication. */
export function isTerminalGoalStatus(status: GoalStateSnapshotStatus): boolean {
  return status !== "active" && status !== "queued";
}

function buildGoalStateSnapshot(
  goal: ActiveGoal,
  summary: string | undefined,
  reason: string | undefined,
): GoalStateSnapshot {
  const snapshot: GoalStateSnapshot = { goalId: goal.id, status: goal.status };
  if (goal.status === "complete" && summary) snapshot.summary = summary;
  else if (goal.status !== "complete" && isTerminalGoalStatus(goal.status) && reason) {
    snapshot.reason = reason;
  }
  return snapshot;
}

interface GoalTerminalDetails {
  goalId: string;
  summary?: string;
  reason?: string;
}

export interface GoalSettingsRuntimeSnapshot {
  settings: GoalSettings;
  activeGoal?: ActiveGoal;
  queueFrozen: boolean;
  queueFreezeAwaitingSettle: boolean;
  continuationIntent?: ContinuationTicket;
  continuationDelivery?: ContinuationTicket;
  goalRecovery?: GoalRecovery;
  budgetWrapUp?: BudgetWrapUp;
  guardAbortGoalId?: string;
  staleGoalToolCallsBlocked: boolean;
  cancelledContinuationMarkers: string[];
  terminalDetails?: GoalTerminalDetails;
  toolVisibility: GoalToolVisibilitySnapshot;
}

interface PendingGoalPrompt {
  goalId: string;
  resetSafetyEpoch: boolean;
}

interface PendingNonGoalInput {
  behavior: "steer" | "followUp";
  fingerprint: string;
  resetSafetyEpoch: boolean;
}

const MAX_CANCELLED_CONTINUATION_PROMPTS = 20;
const MAX_PENDING_GOAL_PROMPTS = 20;
const MAX_PENDING_NON_GOAL_INPUTS = 20;
const BUDGET_WRAP_UP_MESSAGE_TYPE = "goal-budget-wrap-up";
const BUDGET_WRAP_UP_PROMPT =
  "The active /goal token budget is exhausted. Stop substantive work and do not call substantive tools. Summarize progress, verified results, remaining work, and blockers concisely. Treat completion as unproven. Do not call goal_complete unless authoritative, requirement-by-requirement evidence already proves every requirement is complete. Weak, indirect, or missing evidence is not enough. Budget exhaustion is not completion.";
const CONTRADICTORY_COMPLETION_PATTERNS = [
  /(?<!could\s)\bnot\s+(?:yet\s+)?(?:complete|completed|done|finished)\b/i,
  /\bstill\s+(?:incomplete|failing|failing\s+tests?|fails?)\b/i,
  /\btests?\s+(?:still\s+)?fail(?:ing)?\b/i,
] as const;
// One instance belongs to one extension factory. It owns all mutable session state
// and the cross-cutting invariants used by command and lifecycle orchestration.
// Keep this state machine cohesive despite its size: prompt ownership, continuation,
// budget, safety, and queue transitions share ordering-sensitive invariants. Tool visibility is
// delegated to GoalToolPolicy.
// Cohesion justification: Goal transitions, continuation ownership, queue state, and budget/retry
// recovery share one generation-guarded runtime; separating them further would duplicate stale-turn
// and persistence invariants across modules.
export class GoalRuntime {
  settings: GoalSettings = DEFAULT_GOAL_SETTINGS;
  settingsLoadIssue?: GoalSettingsLoadIssue;
  activeGoal?: ActiveGoal;
  /** The single `goal_wait` safety wake-up. Cancelled with continuation work. */
  private readonly goalWaitTimer = new GoalWaitTimer();
  /** Terminal details captured for the matching persisted-state snapshot. */
  private terminalDetails?: GoalTerminalDetails;
  private goalStateSink?: (snapshot: GoalStateSnapshot) => void;
  queuedGoals: ActiveGoal[] = [];
  pendingQueueAction?: PendingQueueAction;
  queueFrozen = false;
  queueFreezeAwaitingSettle = false;
  completionStatusTimer?: NodeJS.Timeout;
  private continuationDispatchTimer?: NodeJS.Timeout;
  continuationIntent?: ContinuationTicket;
  continuationDelivery?: ContinuationTicket;
  goalRecovery?: GoalRecovery;
  budgetWrapUp?: BudgetWrapUp;
  /** `null` marks a run that must not be charged to the active goal. */
  agentRunGoalId?: string | null;
  agentRunOrigin?: GoalRunOrigin;
  agentRunToolAttempted = false;
  guardAbortGoalId?: string;
  staleGoalToolCallsBlocked = false;
  readonly toolPolicy: GoalToolPolicy;
  pendingGoalPromptMarkers = new Map<string, PendingGoalPrompt>();
  claimedGoalPromptMarkers = new Set<string>();
  cancelledContinuationMarkers = new Set<string>();
  claimedContinuationMarkers = new Set<string>();
  pendingNonGoalInputs: PendingNonGoalInput[] = [];
  menuGeneration = 0;
  menuController = new AbortController();

  readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.toolPolicy = new GoalToolPolicy(pi);
  }

  setGoalStateSink(sink: ((snapshot: GoalStateSnapshot) => void) | undefined) {
    this.goalStateSink = sink;
  }

  private publishGoalState(snapshot: GoalStateSnapshot) {
    try {
      this.goalStateSink?.(snapshot);
    } catch {
      // Protocol publication must not interrupt canonical Goal persistence.
    }
  }

  replaceMenuSession() {
    this.menuGeneration += 1;
    this.menuController.abort(new DOMException("Goal session replaced", "AbortError"));
    this.menuController = new AbortController();
  }

  closeMenuSession() {
    this.menuGeneration += 1;
    this.menuController.abort(new DOMException("Goal session shut down", "AbortError"));
  }

  canRecordGoalUsage(goalId?: string) {
    return (
      this.agentRunGoalId !== null &&
      (goalId === undefined || this.agentRunGoalId === undefined || this.agentRunGoalId === goalId) &&
      !(this.pendingQueueAction?.kind === "prioritize" && this.pendingQueueAction.displacedUsageFinalized === true)
    );
  }

  hasActiveBudgetWrapUp() {
    return (
      this.activeGoal?.status === "budget_limited" &&
      this.budgetWrapUp?.goalId === this.activeGoal.id &&
      this.budgetWrapUp.delivered
    );
  }

  hasActiveGoalRecovery() {
    return Boolean(this.activeGoal && this.goalRecovery?.goalId === this.activeGoal.id);
  }

  beginAgentRun(goalId: string | null | undefined, origin: GoalRunOrigin | undefined) {
    this.agentRunGoalId = goalId;
    this.agentRunOrigin = origin;
    this.agentRunToolAttempted = false;
  }

  beginRecoveryRunIfNeeded() {
    if (this.agentRunGoalId !== undefined || !this.activeGoal) return;
    const recovery = this.goalRecovery;
    if (!recovery || recovery.goalId !== this.activeGoal.id) return;
    this.beginAgentRun(recovery.goalId, recovery.automaticOwner ? "automatic" : "manual");
  }

  markAgentToolAttempted() {
    if (this.agentRunGoalId !== undefined) this.agentRunToolAttempted = true;
  }

  finishAgentRun(): CompletedGoalRun {
    const run = {
      goalId: this.agentRunGoalId,
      origin: this.agentRunOrigin,
      toolAttempted: this.agentRunToolAttempted,
    };
    this.clearAgentRun();
    return run;
  }

  clearAgentRun() {
    this.agentRunGoalId = undefined;
    this.agentRunOrigin = undefined;
    this.agentRunToolAttempted = false;
  }

  reclassifyAgentRunAsManual() {
    if (this.agentRunGoalId !== undefined) this.agentRunOrigin = "manual";
  }

  isAutomaticRunForGoal(goalId: string) {
    return this.agentRunGoalId === goalId && this.agentRunOrigin === "automatic";
  }

  recordGoalUsage(goal: ActiveGoal, ctx: StatusContext, checkpointActiveTime = goal.status === "active") {
    if (!this.canRecordGoalUsage(goal.id)) return false;
    updateGoalUsage(goal, ctx, checkpointActiveTime);
    return true;
  }

  requestContinuation(goal: ActiveGoal) {
    if (this.hasContinuationWorkForGoal(goal.id)) return false;
    const marker = continuationMarker(goal);
    this.continuationIntent = {
      goalId: goal.id,
      iteration: goal.iteration,
      marker,
      prompt: buildContinuePrompt(goal, marker),
    };
    return true;
  }

  dispatchContinuationIfSettled(ctx: StatusContext) {
    const intent = this.continuationIntent;
    if (!intent) return false;
    if (this.activeGoal?.status === "active" && !this.toolPolicy.toolsAvailable()) {
      this.pauseGoalForUnavailableTools(ctx);
      return false;
    }
    if (!this.activeGoal || this.activeGoal.id !== intent.goalId || this.activeGoal.status !== "active") {
      this.continuationIntent = undefined;
      return false;
    }
    if (this.enforceAutomaticTurnLimit(ctx, false) || this.enforceNoProgressLimit(ctx)) {
      return false;
    }
    if (ctx.isIdle?.() !== true || hasPendingMessages(ctx)) return false;

    this.clearContinuationDispatchTimer();
    this.continuationIntent = undefined;
    this.continuationDelivery = intent;
    try {
      this.pi.sendUserMessage(intent.prompt, { deliverAs: "followUp" });
      return true;
    } catch (error) {
      if (this.continuationDelivery?.marker === intent.marker) {
        this.continuationDelivery = undefined;
      }
      if (this.activeGoal?.id === intent.goalId && this.activeGoal.status === "active") {
        this.continuationIntent = intent;
      }
      notifyTerminal(ctx.ui, `Goal prompt failed: ${formatError(error)}`, "error");
      return false;
    }
  }

  hasContinuationWorkForGoal(goalId: string) {
    return this.continuationIntent?.goalId === goalId || this.continuationDelivery?.goalId === goalId;
  }

  updateStatus(ctx: StatusContext, goal: ActiveGoal) {
    this.clearCompletionStatusTimer();
    ctx.ui.setStatus(STATUS_KEY, formatStatus(goal, this.settings.continuationLimits.automaticTurns));
  }

  stopActiveGoal(ctx: StatusContext, request: GoalStopRequest) {
    const currentGoal = this.activeGoal;
    if (!currentGoal || currentGoal.id !== request.expectedGoalId) return undefined;

    let goal = currentGoal;
    let status: StoppedGoalStatus;
    let terminalReason: string | undefined;
    switch (request.kind) {
      case "explicit_pause":
        this.recordGoalUsage(goal, ctx);
        this.cancelContinuationWork();
        this.clearGoalRecoveryForGoal(goal.id);
        this.clearBudgetWrapUp();
        this.blockStaleGoalToolCalls();
        abortCurrentTurn(ctx);
        status = "paused";
        break;
      case "budget_limit":
        this.cancelContinuationWork();
        this.clearGoalRecoveryForGoal(goal.id);
        this.clearBudgetWrapUp();
        status = "budget_limited";
        terminalReason = request.reason;
        break;
      case "safety_pause":
        this.cancelContinuationWork();
        this.clearGoalRecoveryForGoal(goal.id);
        this.clearBudgetWrapUp();
        this.blockStaleGoalToolCalls();
        if (request.abortTurn) {
          this.guardAbortGoalId = goal.id;
          abortCurrentTurn(ctx);
        }
        goal = { ...goal, safetyPauseCause: request.cause };
        status = "paused";
        terminalReason = request.reason;
        break;
      case "wait":
        this.recordGoalUsage(goal, ctx);
        this.cancelContinuationWork();
        this.clearGoalRecoveryForGoal(goal.id);
        this.clearBudgetWrapUp();
        this.blockStaleGoalToolCalls();
        status = "paused";
        terminalReason = request.reason;
        break;
      case "retry_exhausted":
        this.clearGoalRecoveryForGoal(goal.id);
        this.cancelContinuationWork();
        this.clearBudgetWrapUp();
        this.blockStaleGoalToolCalls();
        status = "blocked";
        terminalReason = request.reason;
        break;
      case "tools_unavailable":
        if (request.recordUsage) this.recordGoalUsage(goal, ctx);
        this.cancelContinuationWork();
        this.clearGoalRecoveryForGoal(goal.id);
        this.clearBudgetWrapUp();
        if (request.abortTurn) {
          this.blockStaleGoalToolCalls();
          abortCurrentTurn(ctx);
        } else {
          this.clearStaleGoalToolCallBlock();
        }
        status = "paused";
        break;
      case "blocker_report":
        this.recordGoalUsage(goal, ctx);
        this.cancelContinuationWork();
        this.clearBudgetWrapUp();
        this.clearGoalRecoveryForGoal(goal.id);
        this.blockStaleGoalToolCalls();
        status = "blocked";
        terminalReason = request.reason;
        break;
      case "agent_interruption":
        this.cancelContinuationWork();
        this.clearBudgetWrapUp();
        this.blockStaleGoalToolCalls();
        abortCurrentTurn(ctx);
        status = request.status;
        terminalReason = request.reason;
        break;
      case "activation_rollback":
        goal = request.restoreGoal;
        if (request.abortTurn) abortCurrentTurn(ctx);
        this.blockStaleGoalToolCalls();
        status = "paused";
        break;
    }

    this.activeGoal = transitionGoal(goal, status);
    if (terminalReason !== undefined) this.setTerminalReason(this.activeGoal.id, terminalReason);
    const stoppedGoal = this.activeGoal;
    this.persistGoal(stoppedGoal);
    if (this.activeGoal?.id === stoppedGoal.id && this.activeGoal.status === stoppedGoal.status) {
      this.updateStatus(ctx, stoppedGoal);
    }
    return stoppedGoal;
  }

  blockStaleGoalToolCalls() {
    this.staleGoalToolCallsBlocked = true;
  }

  clearStaleGoalToolCallBlock() {
    this.staleGoalToolCallsBlocked = false;
  }

  clearGoalRecovery() {
    this.goalRecovery = undefined;
  }

  clearBudgetWrapUp() {
    this.budgetWrapUp = undefined;
  }

  setCompletionSummary(goalId: string, summary: string) {
    this.terminalDetails = { goalId, summary };
  }

  setTerminalReason(goalId: string, reason: string) {
    this.terminalDetails = { goalId, reason };
  }

  clearTerminalDetails() {
    this.terminalDetails = undefined;
  }

  isActiveBudgetWrapUpMessage(message: unknown) {
    if (!message || typeof message !== "object") return false;
    const candidate = message as {
      role?: unknown;
      customType?: unknown;
      details?: { goalId?: unknown };
    };
    return (
      candidate.role === "custom" &&
      candidate.customType === BUDGET_WRAP_UP_MESSAGE_TYPE &&
      typeof candidate.details?.goalId === "string" &&
      candidate.details.goalId === this.budgetWrapUp?.goalId &&
      candidate.details.goalId === this.activeGoal?.id
    );
  }

  keepBudgetWrapUpMessage(message: unknown) {
    if (!message || typeof message !== "object") return true;
    const candidate = message as { role?: unknown; customType?: unknown };
    if (candidate.role !== "custom" || candidate.customType !== BUDGET_WRAP_UP_MESSAGE_TYPE) {
      return true;
    }
    return this.isActiveBudgetWrapUpMessage(message);
  }

  queueBudgetWrapUp(ctx: StatusContext, goal: ActiveGoal) {
    if (!this.budgetWrapUp || this.budgetWrapUp.goalId !== goal.id) {
      this.budgetWrapUp = { goalId: goal.id, delivered: false };
    }
    if (this.budgetWrapUp.delivered) return true;
    this.budgetWrapUp.delivered = true;
    try {
      this.pi.sendMessage(
        {
          customType: BUDGET_WRAP_UP_MESSAGE_TYPE,
          content: BUDGET_WRAP_UP_PROMPT,
          display: true,
          details: { goalId: goal.id },
        },
        { deliverAs: "steer" },
      );
      return true;
    } catch (error) {
      this.budgetWrapUp.delivered = false;
      notifyTerminal(ctx.ui, `Goal budget wrap-up failed: ${formatError(error)}`, "error");
      return false;
    }
  }

  limitActiveGoalForBudget(ctx: StatusContext, sendWrapUp: boolean) {
    const goal = this.activeGoal;
    if (goal?.status !== "active" || goal.tokenBudget === undefined || goal.tokensUsed < goal.tokenBudget) {
      return false;
    }

    const stoppedGoal = this.stopActiveGoal(ctx, {
      kind: "budget_limit",
      expectedGoalId: goal.id,
      reason: `token budget reached (${formatBudget(goal)})`,
    });
    if (!stoppedGoal) return false;
    notifyTerminal(ctx.ui, `Goal token budget reached: ${formatBudget(stoppedGoal)}`, "warning");
    if (sendWrapUp) this.queueBudgetWrapUp(ctx, stoppedGoal);
    return true;
  }

  recordAutomaticTurn(ctx: StatusContext, message: unknown) {
    const goal = this.activeGoal;
    if (goal?.status !== "active" || !this.isAutomaticRunForGoal(goal.id)) return false;
    const candidate = message as { role?: unknown; stopReason?: unknown } | undefined;
    if (candidate?.role === "assistant" && candidate.stopReason === "aborted") return false;
    goal.automaticModelTurns = Math.min(Number.MAX_SAFE_INTEGER, goal.automaticModelTurns + 1);
    this.recordGoalUsage(goal, ctx);
    this.persistGoal(goal);
    this.updateStatus(ctx, goal);
    // Terminal errors need agent_end classification before a safety pause can
    // choose between usage_limited, blocked, or retryable cleanup.
    if (candidate?.role === "assistant" && candidate.stopReason === "error") return false;
    return this.enforceAutomaticTurnLimit(ctx, true);
  }

  recordAutomaticRunProgress(ctx: StatusContext, goalId: string, messages: readonly unknown[], toolAttempted: boolean) {
    const goal = this.activeGoal;
    if (goal?.id !== goalId || goal.status !== "active") return false;
    const next = nextToolFreeRepeatState(goal, messages, toolAttempted);
    goal.toolFreeRepeatCount = next.toolFreeRepeatCount;
    goal.lastToolFreeOutputFingerprint = next.lastToolFreeOutputFingerprint;
    this.persistGoal(goal);
    this.updateStatus(ctx, goal);
    const limit = this.settings.continuationLimits.noProgressTurns;
    if (limit === null || goal.toolFreeRepeatCount < limit) return false;
    return this.pauseGoalForSafety(ctx, "no_progress", false);
  }

  enforceAutomaticTurnLimit(ctx: StatusContext, abortTurn: boolean) {
    const goal = this.activeGoal;
    const limit = this.settings.continuationLimits.automaticTurns;
    if (goal?.status !== "active" || limit === null || goal.automaticModelTurns < limit) {
      return false;
    }
    return this.pauseGoalForSafety(ctx, "continuation_limit", abortTurn);
  }

  enforceNoProgressLimit(ctx: StatusContext, abortTurn = false) {
    const goal = this.activeGoal;
    const limit = this.settings.continuationLimits.noProgressTurns;
    if (goal?.status !== "active" || limit === null || goal.toolFreeRepeatCount < limit) {
      return false;
    }
    return this.pauseGoalForSafety(ctx, "no_progress", abortTurn);
  }

  pauseGoalForSafety(ctx: StatusContext, cause: SafetyPauseCause, abortTurn: boolean) {
    const goal = this.activeGoal;
    if (goal?.status !== "active") return false;
    const automaticLimit = this.settings.continuationLimits.automaticTurns;
    const count =
      cause === "continuation_limit"
        ? `${goal.automaticModelTurns} of ${automaticLimit ?? "Unlimited"} automatic model responses`
        : `no progress across ${goal.toolFreeRepeatCount} automatic runs`;
    const stoppedGoal = this.stopActiveGoal(ctx, {
      kind: "safety_pause",
      expectedGoalId: goal.id,
      cause,
      abortTurn,
      reason: `${cause} (${count}; ${formatTokenCount(goal.tokensUsed)} tokens)`,
    });
    if (!stoppedGoal) return false;
    notifyTerminal(
      ctx.ui,
      cause === "continuation_limit"
        ? `Automatic-work limit reached: ${stoppedGoal.automaticModelTurns} of ${automaticLimit} responses. Goal progress is saved with ${formatTokenCount(stoppedGoal.tokensUsed)} cumulative tokens. Open /goal to review and continue.`
        : `Goal paused: ${count}; ${formatTokenCount(stoppedGoal.tokensUsed)} cumulative tokens. Open /goal to review and continue.`,
      "warning",
    );
    return true;
  }

  resetActiveSafetyEpoch(ctx: StatusContext) {
    const goal = this.activeGoal;
    if (goal?.status !== "active") return false;
    this.activeGoal = resetGoalSafetyEpoch(goal);
    this.reclassifyAgentRunAsManual();
    this.persistGoal(this.activeGoal);
    this.updateStatus(ctx, this.activeGoal);
    return true;
  }

  finalizeSettledRecovery(ctx: StatusContext) {
    const recovery = this.goalRecovery;
    if (!recovery) return false;
    this.goalRecovery = undefined;
    const goal = this.activeGoal;
    if (goal?.id !== recovery.goalId || goal.status !== "active") return false;
    const details = recovery.errorMessage ? `: ${truncateNotification(recovery.errorMessage)}` : "";
    const stoppedGoal = this.stopActiveGoal(ctx, {
      kind: "retry_exhausted",
      expectedGoalId: goal.id,
      reason: `agent error after retries${details}`,
    });
    if (!stoppedGoal) return false;
    notifyTerminal(
      ctx.ui,
      `Goal blocked after agent error retries were exhausted${details}. Resolve the blocker or run /goal resume to retry.`,
      "warning",
    );
    return true;
  }

  clearSettledSafetyTracking() {
    this.guardAbortGoalId = undefined;
    this.pendingNonGoalInputs = [];
    this.claimedGoalPromptMarkers.clear();
    this.claimedContinuationMarkers.clear();
    this.clearAgentRun();
  }

  clearGoalRecoveryForGoal(goalId: string) {
    if (this.goalRecovery?.goalId === goalId) this.goalRecovery = undefined;
  }

  isPiOwnedCompactionRetry(event: unknown, goalId: string) {
    const compaction = event as { reason?: unknown; willRetry?: unknown };
    if (compaction.willRetry === true) return true;
    return (
      this.goalRecovery?.goalId === goalId &&
      this.goalRecovery.kind === "compaction_retry" &&
      (compaction.reason === undefined || compaction.reason === "overflow")
    );
  }

  clearContinuationTracking() {
    this.clearContinuationDispatchTimer();
    this.continuationIntent = undefined;
    this.continuationDelivery = undefined;
    this.cancelledContinuationMarkers.clear();
    this.claimedContinuationMarkers.clear();
  }

  clearPendingGoalPrompts() {
    this.pendingGoalPromptMarkers.clear();
    this.claimedGoalPromptMarkers.clear();
    this.pendingNonGoalInputs = [];
  }

  async sendOwnedGoalPrompt(
    ctx: StatusContext,
    goalId: string,
    prompt: string,
    resetSafetyEpoch = true,
    isCurrent?: () => boolean,
  ) {
    const pending = this.rememberPendingGoalPrompt(goalId, prompt, resetSafetyEpoch);
    const sent = await sendPrompt(this.pi, ctx, pending.prompt, isCurrent);
    if (!sent || (isCurrent && !isCurrent())) {
      this.pendingGoalPromptMarkers.delete(pending.marker);
      return false;
    }
    return true;
  }

  /**
   * Arm the `goal_wait` safety wake-up.
   *
   * The callback is supplied by the command layer, which owns the only correct
   * resume: tool-policy preparation, recovery clearing, and prompt delivery all
   * have to happen, and a shortcut here would be a second, worse resume path.
   * Unset (a headless or partially-built runtime) simply means a wait keeps
   * waiting for real input, which is the safe direction.
   */
  onGoalWaitElapsed?: (ctx: StatusContext, goalId: string) => void;

  scheduleGoalWaitWake(ctx: StatusContext, goalId: string, resumeAt: number): void {
    this.goalWaitTimer.schedule(resumeAt, () => {
      // Re-checked at fire time, not at schedule time: the goal may have been
      // completed, cleared, or replaced during the wait, and waking a goal that
      // is no longer the active one would resume the wrong work.
      if (this.activeGoal?.id !== goalId || this.activeGoal.status !== "paused") return;
      this.onGoalWaitElapsed?.(ctx, goalId);
    });
  }

  clearGoalWaitWake(): void {
    this.goalWaitTimer.clear();
  }

  cancelContinuationWork() {
    this.clearGoalWaitWake();
    this.clearContinuationDispatchTimer();
    if (this.continuationDelivery) {
      this.rememberCancelledContinuationMarker(this.continuationDelivery.marker);
    }
    this.continuationIntent = undefined;
    this.continuationDelivery = undefined;
  }

  scheduleContinuationDispatch(ctx: StatusContext, goalId: string) {
    this.clearContinuationDispatchTimer();
    const generation = this.menuGeneration;
    this.continuationDispatchTimer = setTimeout(() => {
      this.continuationDispatchTimer = undefined;
      if (generation !== this.menuGeneration || this.activeGoal?.id !== goalId || this.activeGoal.status !== "active") {
        return;
      }
      this.dispatchContinuationIfSettled(ctx);
    }, 0);
  }

  private clearContinuationDispatchTimer() {
    if (!this.continuationDispatchTimer) return;
    clearTimeout(this.continuationDispatchTimer);
    this.continuationDispatchTimer = undefined;
  }

  consumeCancelledContinuationPrompt(prompt: string) {
    const marker = extractContinuationMarker(prompt);
    return marker ? this.cancelledContinuationMarkers.delete(marker) : false;
  }

  hasPendingOwnedGoalPrompt(prompt: string) {
    const marker = extractGoalPromptMarker(prompt);
    return marker ? this.pendingGoalPromptMarkers.has(marker) : false;
  }

  hasOwnedPromptBoundary(prompt: string) {
    const goalMarker = extractGoalPromptMarker(prompt);
    if (
      goalMarker &&
      (this.pendingGoalPromptMarkers.has(goalMarker) || this.claimedGoalPromptMarkers.has(goalMarker))
    ) {
      return true;
    }
    const continuationMarker = extractContinuationMarker(prompt);
    return Boolean(
      continuationMarker &&
        (this.continuationDelivery?.marker === continuationMarker ||
          this.claimedContinuationMarkers.has(continuationMarker)),
    );
  }

  consumeStaleOwnedGoalPrompt(prompt: string) {
    const marker = extractGoalPromptMarker(prompt);
    if (!marker) return false;
    const pending = this.pendingGoalPromptMarkers.get(marker);
    if (!pending) return false;
    if (
      !this.queueFrozen &&
      !this.pendingQueueAction &&
      this.activeGoal?.id === pending.goalId &&
      this.activeGoal.status === "active"
    ) {
      return false;
    }
    this.pendingGoalPromptMarkers.delete(marker);
    return true;
  }

  noteQueuedNonGoalInput(prompt: string, behavior: "steer" | "followUp", resetSafetyEpoch = false) {
    this.pendingNonGoalInputs.push({
      behavior,
      fingerprint: inputFingerprint(prompt),
      resetSafetyEpoch,
    });
    if (this.pendingNonGoalInputs.length > MAX_PENDING_NON_GOAL_INPUTS) {
      this.pendingNonGoalInputs.shift();
    }
  }

  consumeQueuedNonGoalInput(prompt: string, allowDeliveryFallback = true) {
    if (typeof prompt !== "string") return undefined;
    const fingerprint = inputFingerprint(prompt);
    // Pi delivers steers before follow-ups. Prefer a matching steer even when an
    // identical follow-up was queued first so it cannot steal follow-up ownership.
    const steerIndex = this.pendingNonGoalInputs.findIndex(
      (pending) => pending.behavior === "steer" && pending.fingerprint === fingerprint,
    );
    const exactIndex =
      steerIndex >= 0
        ? steerIndex
        : this.pendingNonGoalInputs.findIndex(
            (pending) => pending.behavior === "followUp" && pending.fingerprint === fingerprint,
          );
    if (exactIndex >= 0) return this.pendingNonGoalInputs.splice(exactIndex, 1)[0];
    if (!allowDeliveryFallback) return undefined;

    // Skills, templates, and later input handlers can transform the raw text after
    // pi-goal records it. Fall back to Pi's delivery priority as a bounded marker:
    // steers drain before follow-ups, and settlement clears stale entries.
    const fallbackSteerIndex = this.pendingNonGoalInputs.findIndex((pending) => pending.behavior === "steer");
    const fallbackIndex =
      fallbackSteerIndex >= 0
        ? fallbackSteerIndex
        : this.pendingNonGoalInputs.findIndex((pending) => pending.behavior === "followUp");
    if (fallbackIndex < 0) return undefined;
    return this.pendingNonGoalInputs.splice(fallbackIndex, 1)[0];
  }

  consumeQueuedNonGoalFollowUpForAgentStart() {
    // A pending steer owns the next intra-run boundary. Do not let a later
    // follow-up suppress cleanup until all earlier-priority steers have started.
    if (this.pendingNonGoalInputs.some((pending) => pending.behavior === "steer")) return false;
    const index = this.pendingNonGoalInputs.findIndex((pending) => pending.behavior === "followUp");
    if (index < 0) return false;
    this.pendingNonGoalInputs.splice(index, 1);
    return true;
  }

  markContinuationStarted(prompt: string) {
    const marker = extractContinuationMarker(prompt);
    if (!marker) {
      // A user, retry, or another extension started newer work. Cancel both an
      // unsent intent and a delivery that may have lost the non-atomic idle race;
      // the newer work's agent_end will record a fresh intent.
      this.cancelContinuationWork();
      return undefined;
    }
    if (this.continuationDelivery?.marker === marker) {
      this.continuationDelivery = undefined;
      this.rememberClaimedContinuationMarker(marker);
    }
    return marker.split(":", 1)[0];
  }

  persistGoal(goal: ActiveGoal) {
    if (!isTerminalGoalStatus(goal.status) || this.terminalDetails?.goalId !== goal.id) {
      this.clearTerminalDetails();
    }
    this.pi.appendEntry(GOAL_STATE_ENTRY_TYPE, serializeGoalState(goal, this.queuedGoals, this.pendingQueueAction));
    this.publishGoalState(buildGoalStateSnapshot(goal, this.terminalDetails?.summary, this.terminalDetails?.reason));
  }

  clearPersistedGoal(cwd: string, clearedGoal?: ActiveGoal, reason = "goal cleared") {
    this.pi.appendEntry(GOAL_STATE_ENTRY_TYPE, serializeGoalState(undefined, [], undefined));
    if (clearedGoal) {
      this.publishGoalState({
        goalId: clearedGoal.id,
        status: "cleared",
        reason,
      });
    }
    this.clearTerminalDetails();
    clearLegacyPersistedGoal(cwd);
  }

  clearActiveGoal(ctx: StatusContext, reason = "goal cleared") {
    const clearedGoal = this.activeGoal;
    this.cancelContinuationWork();
    this.clearGoalRecovery();
    this.clearBudgetWrapUp();
    this.clearStaleGoalToolCallBlock();
    this.activeGoal = undefined;
    this.queuedGoals = [];
    this.pendingQueueAction = undefined;
    this.queueFrozen = false;
    this.queueFreezeAwaitingSettle = false;
    this.clearPersistedGoal(ctx.cwd, clearedGoal, reason);
    ctx.ui.setStatus(STATUS_KEY, undefined);
    // Do not relock toolPolicy: after first activation, keep tools visible for the
    // rest of this extension runtime to avoid repeated tool-schema churn.
  }

  snapshotSettingsApplicationState(): GoalSettingsRuntimeSnapshot {
    return {
      settings: structuredClone(this.settings),
      activeGoal: this.activeGoal ? structuredClone(this.activeGoal) : undefined,
      queueFrozen: this.queueFrozen,
      queueFreezeAwaitingSettle: this.queueFreezeAwaitingSettle,
      continuationIntent: this.continuationIntent ? structuredClone(this.continuationIntent) : undefined,
      continuationDelivery: this.continuationDelivery ? structuredClone(this.continuationDelivery) : undefined,
      goalRecovery: this.goalRecovery ? structuredClone(this.goalRecovery) : undefined,
      budgetWrapUp: this.budgetWrapUp ? structuredClone(this.budgetWrapUp) : undefined,
      guardAbortGoalId: this.guardAbortGoalId,
      staleGoalToolCallsBlocked: this.staleGoalToolCallsBlocked,
      cancelledContinuationMarkers: [...this.cancelledContinuationMarkers],
      terminalDetails: this.terminalDetails ? structuredClone(this.terminalDetails) : undefined,
      toolVisibility: this.toolPolicy.snapshot(),
    };
  }

  restoreSettingsApplicationState(snapshot: GoalSettingsRuntimeSnapshot) {
    this.settings = structuredClone(snapshot.settings);
    this.activeGoal = snapshot.activeGoal ? structuredClone(snapshot.activeGoal) : undefined;
    this.queueFrozen = snapshot.queueFrozen;
    this.queueFreezeAwaitingSettle = snapshot.queueFreezeAwaitingSettle;
    this.continuationIntent = snapshot.continuationIntent ? structuredClone(snapshot.continuationIntent) : undefined;
    this.continuationDelivery = snapshot.continuationDelivery
      ? structuredClone(snapshot.continuationDelivery)
      : undefined;
    this.goalRecovery = snapshot.goalRecovery ? structuredClone(snapshot.goalRecovery) : undefined;
    this.budgetWrapUp = snapshot.budgetWrapUp ? structuredClone(snapshot.budgetWrapUp) : undefined;
    this.guardAbortGoalId = snapshot.guardAbortGoalId;
    this.staleGoalToolCallsBlocked = snapshot.staleGoalToolCallsBlocked;
    this.cancelledContinuationMarkers = new Set(snapshot.cancelledContinuationMarkers);
    this.terminalDetails = snapshot.terminalDetails ? structuredClone(snapshot.terminalDetails) : undefined;
    this.toolPolicy.restore(snapshot.toolVisibility);
  }

  pauseGoalForUnavailableTools(ctx: StatusContext, abortTurn = true, recordUsage = true) {
    const goal = this.activeGoal;
    if (goal?.status !== "active") return false;
    const stoppedGoal = this.stopActiveGoal(ctx, {
      kind: "tools_unavailable",
      expectedGoalId: goal.id,
      abortTurn,
      recordUsage,
    });
    if (!stoppedGoal) return false;
    notifyTerminal(
      ctx.ui,
      "Goal tools are unavailable, so the active goal was paused. Restore the tools and run /goal resume.",
      "warning",
    );
    return true;
  }

  showCompletionStatus(ctx: StatusContext) {
    this.clearCompletionStatusTimer();
    ctx.ui.setStatus(STATUS_KEY, "complete");
    this.completionStatusTimer = setTimeout(() => {
      this.completionStatusTimer = undefined;
      try {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      } catch {
        // The completion status is best-effort; the captured ctx may be stale after
        // session replacement or reload before this timer fires.
      }
    }, 8_000);
  }

  clearCompletionStatusTimer() {
    if (!this.completionStatusTimer) return;
    clearTimeout(this.completionStatusTimer);
    this.completionStatusTimer = undefined;
  }

  private rememberPendingGoalPrompt(goalId: string, prompt: string, resetSafetyEpoch: boolean) {
    const marker = randomUUID();
    this.pendingGoalPromptMarkers.set(marker, { goalId, resetSafetyEpoch });
    if (this.pendingGoalPromptMarkers.size > MAX_PENDING_GOAL_PROMPTS) {
      const oldest = this.pendingGoalPromptMarkers.keys().next().value;
      if (oldest) this.pendingGoalPromptMarkers.delete(oldest);
    }
    return { marker, prompt: appendGoalPromptMarker(prompt, marker) };
  }

  private consumePendingGoalPrompt(prompt: string) {
    const marker = extractGoalPromptMarker(prompt);
    if (!marker) return undefined;
    const pending = this.pendingGoalPromptMarkers.get(marker);
    this.pendingGoalPromptMarkers.delete(marker);
    if (pending) this.rememberClaimedGoalPromptMarker(marker);
    return pending;
  }

  private rememberClaimedGoalPromptMarker(marker: string) {
    this.claimedGoalPromptMarkers.add(marker);
    if (this.claimedGoalPromptMarkers.size <= MAX_PENDING_GOAL_PROMPTS) return;
    const oldest = this.claimedGoalPromptMarkers.values().next().value;
    if (oldest) this.claimedGoalPromptMarkers.delete(oldest);
  }

  private rememberClaimedContinuationMarker(marker: string) {
    this.claimedContinuationMarkers.add(marker);
    if (this.claimedContinuationMarkers.size <= MAX_CANCELLED_CONTINUATION_PROMPTS) return;
    const oldest = this.claimedContinuationMarkers.values().next().value;
    if (oldest) this.claimedContinuationMarkers.delete(oldest);
  }

  consumeOwnedGoalPrompt(prompt: string) {
    return this.consumePendingGoalPrompt(prompt);
  }

  private rememberCancelledContinuationMarker(marker: string) {
    this.cancelledContinuationMarkers.add(marker);
    if (this.cancelledContinuationMarkers.size <= MAX_CANCELLED_CONTINUATION_PROMPTS) return;
    const oldest = this.cancelledContinuationMarkers.values().next().value;
    if (oldest) this.cancelledContinuationMarkers.delete(oldest);
  }
}

export function createGoal(text: string, tokenBudget: number | undefined, baselineTokens: number): ActiveGoal {
  const now = Date.now();
  return {
    id: randomUUID(),
    text,
    status: "active",
    startedAt: now,
    updatedAt: now,
    iteration: 0,
    tokenBudget,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    baselineTokens,
    activeStartedAt: now,
    automaticModelTurns: 0,
    toolFreeRepeatCount: 0,
  };
}

export function transitionGoal(goal: ActiveGoal, requestedStatus: GoalStatus): ActiveGoal {
  const now = Date.now();
  const status =
    requestedStatus === "active" && goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget
      ? "budget_limited"
      : requestedStatus;
  const next = { ...goal, status, updatedAt: now };
  checkpointGoalActiveTime(next, now, status === "active");
  return next;
}

export function nextGoalInstance(goal: ActiveGoal): ActiveGoal {
  return { ...goal, id: randomUUID(), updatedAt: Date.now() };
}

export function editedGoalStatus(status: GoalStatus): GoalStatus {
  if (status === "paused" || status === "blocked" || status === "usage_limited") return status;
  return "active";
}

export function incrementGoal(goal: ActiveGoal): ActiveGoal {
  return { ...goal, iteration: goal.iteration + 1, updatedAt: Date.now() };
}

export function formatStatus(
  goal: ActiveGoal | undefined,
  automaticTurnLimit: number | null = DEFAULT_GOAL_SETTINGS.continuationLimits.automaticTurns,
) {
  if (!goal) return undefined;
  if (goal.status === "complete") return "complete";
  const automatic =
    automaticTurnLimit === null ? "automatic Unlimited" : `automatic ${goal.automaticModelTurns}/${automaticTurnLimit}`;
  if (goal.status === "queued") return `queued · ${automatic}`;
  if (goal.status === "paused" && goal.safetyPauseCause === "continuation_limit") {
    if (automaticTurnLimit === null) {
      return `paused · previous automatic limit at ${goal.automaticModelTurns}`;
    }
    if (goal.automaticModelTurns < automaticTurnLimit) {
      return `paused · automatic ${goal.automaticModelTurns}/${automaticTurnLimit}`;
    }
    return `paused · automatic limit ${goal.automaticModelTurns}/${automaticTurnLimit}`;
  }
  if (goal.status === "paused") return `paused · ${automatic}`;
  if (goal.status === "blocked") return `blocked · ${automatic}`;
  if (goal.status === "usage_limited") return `usage · ${automatic}`;
  if (goal.status === "budget_limited") return `budget ${formatBudget(goal)} · ${automatic}`;
  if (goal.tokenBudget !== undefined) return `active ${formatBudget(goal)} · ${automatic}`;
  return `active ${formatDuration(goal.timeUsedSeconds)} · ${automatic}`;
}

export function formatBudget(goal: ActiveGoal) {
  return `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget ?? 0)}`;
}

export function goalSummary(
  goal: ActiveGoal,
  queuedGoals: readonly ActiveGoal[] = [],
  experimentalGoals = false,
  queueFrozen = false,
  pendingAction?: PendingQueueAction,
  automaticTurnLimit: number | null = DEFAULT_GOAL_SETTINGS.continuationLimits.automaticTurns,
) {
  const summary = [
    `Goal: ${goal.text}`,
    `Status: ${queueFrozen ? "queue off" : goal.status}`,
    `Iteration: ${goal.iteration}`,
    automaticTurnLimit === null
      ? `Automatic work: ${goal.automaticModelTurns} responses · Unlimited`
      : `Automatic work: ${goal.automaticModelTurns} of ${automaticTurnLimit} responses`,
    `Active elapsed: ${formatDuration(goal.timeUsedSeconds)}`,
    `Tokens: ${goal.tokenBudget === undefined ? formatTokenCount(goal.tokensUsed) : formatBudget(goal)}`,
  ];
  if (goal.safetyPauseCause) {
    summary.push(
      goal.safetyPauseCause === "continuation_limit"
        ? `Safety pause: automatic-work limit reached (${goal.automaticModelTurns} of ${automaticTurnLimit ?? "Unlimited"} responses). Progress is saved; open /goal to review and continue.`
        : "Safety pause: no progress. Progress is saved; open /goal to review and continue.",
    );
  }
  if (experimentalGoals || queuedGoals.length > 0 || queueFrozen || pendingAction) {
    const orderedGoals = [
      `[${goal.status}] ${goal.text}`,
      ...(pendingAction?.kind === "prioritize" ? [`[pending] ${pendingAction.objective}`] : []),
      ...queuedGoals.map((queuedGoal) => `[${queuedGoal.status}] ${queuedGoal.text}`),
    ];
    summary.push(
      `Goals (${orderedGoals.length}):`,
      ...orderedGoals.map((queuedGoal, index) => `${index + 1}. ${queuedGoal}`),
    );
  }
  if (pendingAction?.kind === "advance") {
    summary.push(
      `Pending queue action: ${pendingAction.reason === "complete" ? "complete" : "skip"} current goal when Pi settles.`,
    );
  }
  if (queueFrozen) {
    summary.push(
      "Queue is frozen. Re-enable experimental.goals and run /reload, or use /goal clear.",
      "Commands: /goal, /goal clear",
    );
  } else {
    summary.push(`Commands: ${goalCommandHint(goal.status, experimentalGoals)}`);
  }
  return summary.join("\n");
}

export function hasPendingMessages(ctx: StatusContext) {
  return ctx.hasPendingMessages?.() ?? false;
}

export function abortCurrentTurn(ctx: StatusContext) {
  try {
    ctx.abort?.();
  } catch {
    // Best effort: stale goal guards still prevent follow-on tool calls.
  }
}

export function blocksStaleGoalToolCalls(status: GoalStatus) {
  return status === "paused" || status === "blocked" || status === "usage_limited";
}

export function isResumableGoalStatus(status: GoalStatus) {
  return blocksStaleGoalToolCalls(status) || status === "budget_limited";
}

export function stoppedStatusLabel(status: GoalStatus) {
  if (status === "usage_limited") return "usage-limited";
  if (status === "budget_limited") return "budget-limited";
  return status;
}

export function isContradictoryCompletionSummary(summary: string) {
  return CONTRADICTORY_COMPLETION_PATTERNS.some((pattern) => pattern.test(summary));
}

export function goalIdRejectionReason(goal: ActiveGoal, requestedGoalId: string) {
  if (!requestedGoalId) return "missing goal_id";
  if (requestedGoalId.length > MAX_GOAL_ID_LENGTH) return "goal_id is too long";
  if (requestedGoalId !== goal.id) return "goal_id does not match the active goal";
  return undefined;
}

function inputFingerprint(prompt: string) {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

async function sendPrompt(pi: ExtensionAPI, ctx: StatusContext, prompt: string, isCurrent?: () => boolean) {
  try {
    await pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    return true;
  } catch (error) {
    if (!isCurrent || isCurrent()) {
      notifyTerminal(ctx.ui, `Goal prompt failed: ${formatError(error)}`, "error");
    }
    return false;
  }
}

function goalCommandHint(status: GoalStatus, experimentalGoals = false) {
  const queueCommands = experimentalGoals
    ? ", /goal add <objective>, /goal prioritize <objective>, /goal drop-last, /goal skip"
    : "";
  if (status === "active") {
    return `/goal edit <objective>, /goal pause, /goal clear${queueCommands}`;
  }
  if (isResumableGoalStatus(status)) {
    return `/goal edit <objective>, /goal resume, /goal clear${queueCommands}`;
  }
  return `/goal edit <objective>, /goal clear${queueCommands}`;
}

function continuationMarker(goal: ActiveGoal) {
  return `${goal.id}:${goal.iteration}:${randomUUID()}`;
}

export type { AssistantMessageLike } from "./errors.js";
export {
  findFinalAssistantMessage,
  formatError,
  isGoalContextOverflow,
  isRetryableGoalInterruption,
  isUsageLimitedGoalInterruption,
  truncateNotification,
} from "./errors.js";
