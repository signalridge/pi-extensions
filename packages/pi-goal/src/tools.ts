import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  type ExtensionAPI,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { notifyTerminal, safeTerminalText } from "./errors.js";
import {
  formatStatus,
  GOAL_BLOCKED_TOOL,
  GOAL_COMPLETE_TOOL,
  GOAL_WAIT_TOOL,
  type GoalRuntime,
  goalIdRejectionReason,
  isContradictoryCompletionSummary,
  MAX_GOAL_ID_LENGTH,
  STATUS_KEY,
  transitionGoal,
  truncateNotification,
} from "./runtime.js";
import { createGoalWait, MAX_GOAL_WAIT_REASON_LENGTH, MIN_GOAL_WAIT_DELAY_MS, resolveGoalWaitDelay } from "./wait.js";

interface GoalCompleteDetails {
  goal: string;
  goal_id: string;
  summary: string;
}

interface GoalWaitDetails {
  goal: string;
  goal_id: string;
  reason: string;
  requested_resume_after_ms?: number;
  effective_resume_after_ms?: number;
  resume_at?: number;
}

interface GoalBlockedDetails {
  goal: string;
  goal_id: string;
  reason: string;
  evidence: string;
  repeated_turns: number;
}

const MAX_GOAL_TEXT_LENGTH = 4_000;
const MAX_COMPLETION_SUMMARY_LENGTH = 4_000;
const MAX_BLOCKER_REASON_LENGTH = 1_000;
const MAX_BLOCKER_EVIDENCE_LENGTH = 4_000;

export function registerGoalTools(pi: ExtensionAPI, runtime: GoalRuntime) {
  const goalCompleteTool = defineTool({
    name: GOAL_COMPLETE_TOOL,
    label: "Goal Complete",
    description:
      "Mark the active /goal as complete after all required work is done and verified, using the current goal_id stale-turn guard. Do not use for partial progress, blockers, failing, or unverified work.",
    promptSnippet: "Mark the active /goal as complete after fully finishing and verifying it, with the current goal_id",
    promptGuidelines: [
      "When a /goal is active, keep working until the goal is complete; do not stop with only a plan or partial progress.",
      "Before calling goal_complete, audit the active goal requirement by requirement against the current files, command output, tests, or external state.",
      "Pass the exact goal_id shown in the current /goal prompt; never reuse a goal_id from an older, stopped, replaced, or cleared turn.",
      "Call goal_complete only after the requested goal is fully implemented, verified, and no known required work remains; otherwise keep working.",
    ],
    parameters: Type.Object({
      goal_id: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_ID_LENGTH,
        description:
          "The exact goal_id shown in the current active /goal prompt. Used only to reject stale completion calls from older turns.",
      }),
      summary: Type.String({
        minLength: 1,
        maxLength: MAX_COMPLETION_SUMMARY_LENGTH,
        description:
          "State what was completed and what evidence verified it. Do not use this tool to report partial progress, blockers, failures, or remaining work.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const completedGoal = runtime.activeGoal;
      const goal = completedGoal?.text ?? "unknown goal";
      const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
      const summary = typeof params.summary === "string" ? params.summary.trim() : "";

      if (!completedGoal) {
        const rejection = "Goal completion rejected: no active goal.";
        notifyTerminal(ctx.ui, rejection, "warning");

        return {
          content: toolContent(rejection),
          details: completionDetails(goal, requestedGoalId, summary),
        };
      }
      const completingDuringBudgetWrapUp = runtime.hasActiveBudgetWrapUp();
      if (!runtime.canRecordGoalUsage() && !completingDuringBudgetWrapUp) {
        const rejection = "Goal completion rejected: current run does not own the active goal.";
        notifyTerminal(ctx.ui, rejection, "warning");
        return {
          content: toolContent(rejection),
          details: completionDetails(goal, requestedGoalId, summary),
        };
      }
      if (hasPendingSkipForGoal(runtime, completedGoal.id)) {
        runtime.recordGoalUsage(completedGoal, ctx);
        runtime.persistGoal(completedGoal);
        runtime.updateStatus(ctx, completedGoal);
        runtime.clearBudgetWrapUp();
        const rejection = "Goal completion rejected: goal is queued to be skipped.";
        notifyTerminal(ctx.ui, rejection, "warning");
        return {
          content: toolContent(rejection),
          details: completionDetails(goal, requestedGoalId, summary),
          terminate: true,
        };
      }
      const staleGoalRejection = goalIdRejectionReason(completedGoal, requestedGoalId);
      if (staleGoalRejection) {
        const rejection = `Goal completion rejected: ${staleGoalRejection}.`;
        notifyTerminal(ctx.ui, rejection, "warning");
        if (completingDuringBudgetWrapUp) {
          runtime.recordGoalUsage(completedGoal, ctx);
          runtime.persistGoal(completedGoal);
          runtime.updateStatus(ctx, completedGoal);
          runtime.clearBudgetWrapUp();
        }

        return {
          content: toolContent(rejection),
          details: completionDetails(goal, requestedGoalId, summary),
          terminate: completingDuringBudgetWrapUp || undefined,
        };
      }
      if (completedGoal.status !== "active" && !completingDuringBudgetWrapUp) {
        const rejection = `Goal completion rejected: goal is ${completedGoal.status}, not active.`;
        notifyTerminal(ctx.ui, rejection, "warning");

        return {
          content: toolContent(rejection),
          details: completionDetails(goal, requestedGoalId, summary),
        };
      }

      const rejectionReason = !summary
        ? "summary is empty"
        : summary.length > MAX_COMPLETION_SUMMARY_LENGTH
          ? "summary is too long"
          : isContradictoryCompletionSummary(summary)
            ? "summary says the goal is not complete"
            : undefined;
      if (rejectionReason) {
        runtime.recordGoalUsage(completedGoal, ctx);
        runtime.persistGoal(completedGoal);
        runtime.updateStatus(ctx, completedGoal);
        const rejection = `Goal completion rejected: ${rejectionReason}.`;
        notifyTerminal(ctx.ui, rejection, "warning");
        if (completingDuringBudgetWrapUp) runtime.clearBudgetWrapUp();

        return {
          content: toolContent(rejection),
          details: completionDetails(goal, requestedGoalId, summary),
          terminate: completingDuringBudgetWrapUp || undefined,
        };
      }

      runtime.activeGoal = transitionGoal(completedGoal, "complete");
      runtime.setCompletionSummary(runtime.activeGoal.id, summary);
      runtime.recordGoalUsage(runtime.activeGoal, ctx);
      if (runtime.pendingQueueAction?.kind === "prioritize") {
        runtime.persistGoal(runtime.activeGoal);
        ctx.ui.setStatus(STATUS_KEY, "complete");
        notifyTerminal(ctx.ui, `Goal complete: ${goal}. Priority goal waits for Pi to settle.`, "info");
        return {
          content: toolContent(`Goal complete: ${summary}`),
          details: completionDetails(goal, requestedGoalId, summary),
          terminate: true,
        };
      }
      if (runtime.queuedGoals.length > 0) {
        runtime.pendingQueueAction = {
          kind: "advance",
          goalId: runtime.activeGoal.id,
          reason: "complete",
          completedText: goal,
        };
        runtime.persistGoal(runtime.activeGoal);
        ctx.ui.setStatus(STATUS_KEY, "complete");
        notifyTerminal(ctx.ui, `Goal complete: ${goal}. Next goal queued: ${runtime.queuedGoals[0]?.text}`, "info");
        return {
          content: toolContent(`Goal complete: ${summary}\nNext goal queued: ${runtime.queuedGoals[0]?.text}`),
          details: completionDetails(goal, requestedGoalId, summary),
          terminate: true,
        };
      }
      runtime.persistGoal(runtime.activeGoal);

      ctx.ui.setStatus(STATUS_KEY, formatStatus(runtime.activeGoal));
      runtime.clearActiveGoal(ctx);
      runtime.showCompletionStatus(ctx);
      notifyTerminal(ctx.ui, `Goal complete: ${goal}`, "info");

      return {
        content: toolContent(`Goal complete: ${summary}`),
        details: completionDetails(goal, requestedGoalId, summary),
        terminate: true,
      };
    },
  });

  const goalBlockedTool = defineTool({
    name: GOAL_BLOCKED_TOOL,
    label: "Goal Blocked",
    description:
      "Stop the active /goal only at a true impasse after the same blocker recurs for at least three consecutive goal turns, with the current goal_id and concrete evidence that user or external action is required. Do not use for ordinary clarification, uncertainty, or recoverable failures.",
    promptSnippet: "Mark the active /goal blocked only after the same blocker recurs for three consecutive goal turns",
    promptGuidelines: [
      "Use goal_blocked only for a true impasse after the same blocker recurs for at least three consecutive goal turns and concrete evidence shows user or external action is required.",
      "After a blocked goal is resumed, start a fresh three-turn blocker audit before using goal_blocked again.",
      "Do not use goal_blocked for ordinary clarification, incomplete work, uncertainty, difficult tasks, or recoverable tool/provider failures.",
      "Pass goal_blocked the exact current goal_id; never reuse a goal_id from an older, stopped, replaced, or cleared goal turn.",
    ],
    parameters: Type.Object({
      goal_id: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_ID_LENGTH,
        description: "The exact goal_id shown in the current active /goal prompt.",
      }),
      reason: Type.String({
        minLength: 1,
        maxLength: MAX_BLOCKER_REASON_LENGTH,
        description: "The specific user or external action required to unblock the goal.",
      }),
      evidence: Type.String({
        minLength: 1,
        maxLength: MAX_BLOCKER_EVIDENCE_LENGTH,
        description: "Concrete evidence from the repeated attempts that proves the impasse.",
      }),
      repeated_turns: Type.Integer({
        minimum: 3,
        description: "Number of separate turns spent trying to resolve this same blocker.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const blockedGoal = runtime.activeGoal;
      const goal = blockedGoal?.text ?? "unknown goal";
      const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      const evidence = typeof params.evidence === "string" ? params.evidence.trim() : "";
      const repeatedTurns = typeof params.repeated_turns === "number" ? params.repeated_turns : Number.NaN;
      const reject = (rejectionReason: string, terminate = false) => {
        const rejection = `goal_blocked rejected: ${rejectionReason}.`;
        notifyTerminal(ctx.ui, rejection, "warning");
        return {
          content: toolContent(rejection),
          details: blockerDetails(goal, requestedGoalId, reason, evidence, repeatedTurns),
          ...(terminate ? { terminate: true as const } : {}),
        };
      };

      if (!blockedGoal) return reject("no active goal");
      if (!runtime.canRecordGoalUsage()) {
        return reject("current run does not own the active goal");
      }
      if (hasPendingSkipForGoal(runtime, blockedGoal.id)) {
        runtime.recordGoalUsage(blockedGoal, ctx);
        runtime.persistGoal(blockedGoal);
        runtime.updateStatus(ctx, blockedGoal);
        runtime.clearBudgetWrapUp();
        return reject("goal is queued to be skipped", true);
      }
      const staleGoalRejection = goalIdRejectionReason(blockedGoal, requestedGoalId);
      if (staleGoalRejection) return reject(staleGoalRejection);
      if (blockedGoal.status !== "active") {
        return reject(`goal is ${blockedGoal.status}, not active`);
      }
      if (!reason) return reject("reason is empty");
      if (reason.length > MAX_BLOCKER_REASON_LENGTH) return reject("reason is too long");
      if (!evidence) return reject("evidence is empty");
      if (evidence.length > MAX_BLOCKER_EVIDENCE_LENGTH) return reject("evidence is too long");
      if (!Number.isInteger(repeatedTurns)) return reject("repeated_turns must be a whole number");
      if (repeatedTurns < 3) return reject("repeated_turns must be at least 3");

      const stoppedGoal = runtime.stopActiveGoal(ctx, {
        kind: "blocker_report",
        expectedGoalId: blockedGoal.id,
        reason,
      });
      if (!stoppedGoal) return reject("active goal changed before blocker transition");
      notifyTerminal(ctx.ui, `Goal blocked: ${truncateNotification(reason)}`, "warning");

      return {
        content: toolContent(`Goal blocked: ${reason}`),
        details: blockerDetails(goal, requestedGoalId, reason, evidence, repeatedTurns),
        terminate: true,
      };
    },
  });

  const goalWaitTool = defineTool({
    name: GOAL_WAIT_TOOL,
    label: "Goal Wait",
    description: `Keep the active /goal alive but quiet while something outside this session is expected — CI finishing, a review landing, a reply arriving. The goal pauses, stays resumable, and records why. Call it alone, after arranging whatever will wake it, or pass resume_after_ms as a safety deadline. Requests below ${MIN_GOAL_WAIT_DELAY_MS}ms are clamped to ${MIN_GOAL_WAIT_DELAY_MS}ms. Do not use it for ordinary unfinished work: if there is anything left you can do yourself, do it instead.`,
    promptSnippet: "Pause the active /goal while waiting on something outside this session",
    promptGuidelines: [
      "Use goal_wait only when progress genuinely depends on a later external event — not when work remains that you could do now.",
      `Prefer deadlines measured in minutes; anything under ${MIN_GOAL_WAIT_DELAY_MS}ms is a polling loop and is clamped.`,
      "Omit resume_after_ms when a message will wake the goal anyway; pass it only as a bounded safety net.",
      "Call goal_wait alone: a sibling tool call in the same turn can prevent the turn from ending.",
    ],
    parameters: Type.Object({
      goal_id: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_ID_LENGTH,
        description: "The exact goal_id shown in the current active /goal prompt.",
      }),
      reason: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_WAIT_REASON_LENGTH,
        description: "What is being waited for, and what will make it done.",
      }),
      resume_after_ms: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: `Safety wake-up in milliseconds. Clamped up to ${MIN_GOAL_WAIT_DELAY_MS}ms. Omit to wait for external input only.`,
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const goal = runtime.activeGoal;
      const requestedGoalId = params.goal_id.trim();
      const reason = safeTerminalText(params.reason).trim();
      const requestedResumeAfterMs = params.resume_after_ms;

      const details = (): GoalWaitDetails => {
        const { requestedMs, effectiveMs } = resolveGoalWaitDelay(requestedResumeAfterMs);
        return {
          goal: (goal?.text ?? "").slice(0, MAX_GOAL_TEXT_LENGTH),
          goal_id: requestedGoalId.slice(0, MAX_GOAL_ID_LENGTH),
          reason: reason.slice(0, MAX_GOAL_WAIT_REASON_LENGTH),
          ...(requestedMs === undefined ? {} : { requested_resume_after_ms: requestedMs }),
          ...(effectiveMs === undefined ? {} : { effective_resume_after_ms: effectiveMs }),
        };
      };

      const reject = (why: string, terminate = false) => {
        const rejection = `goal_wait rejected: ${why}`;
        notifyTerminal(ctx.ui, rejection, "warning");
        return {
          content: toolContent(rejection),
          details: details(),
          ...(terminate ? { terminate: true as const } : {}),
        };
      };

      if (!goal) return reject("no active goal");
      if (!runtime.canRecordGoalUsage()) return reject("current run does not own the active goal");
      if (hasPendingSkipForGoal(runtime, goal.id)) {
        runtime.recordGoalUsage(goal, ctx);
        runtime.persistGoal(goal);
        runtime.updateStatus(ctx, goal);
        runtime.clearBudgetWrapUp();
        return reject("goal is queued to be skipped", true);
      }
      const staleGoalRejection = goalIdRejectionReason(goal, requestedGoalId);
      if (staleGoalRejection) return reject(staleGoalRejection);
      if (goal.status !== "active") return reject(`goal is ${goal.status}, not active`);
      if (!reason) return reject("reason is empty");

      const wait = createGoalWait(reason, requestedResumeAfterMs);
      const stoppedGoal = runtime.stopActiveGoal(ctx, {
        kind: "wait",
        expectedGoalId: goal.id,
        reason,
      });
      if (!stoppedGoal) return reject("active goal changed before the wait took effect");

      // Armed after the stop, so a wake can never race a goal that is still
      // being transitioned out of `active`.
      if (wait.resumeAt !== undefined) runtime.scheduleGoalWaitWake(ctx, stoppedGoal.id, wait.resumeAt);

      const { requestedMs, effectiveMs } = resolveGoalWaitDelay(requestedResumeAfterMs);
      const clamped = requestedMs !== undefined && effectiveMs !== undefined && effectiveMs !== requestedMs;
      const deadline =
        effectiveMs === undefined
          ? "It will stay paused until you send it something or resume it."
          : `It will wake in ${Math.round(effectiveMs / 1000)}s${clamped ? ` (raised from ${requestedMs}ms)` : ""}.`;
      notifyTerminal(ctx.ui, `Goal waiting: ${truncateNotification(reason)}`, "info");

      return {
        content: toolContent(`Goal waiting: ${reason}. ${deadline}`),
        details: { ...details(), ...(wait.resumeAt === undefined ? {} : { resume_at: wait.resumeAt }) },
        terminate: true,
      };
    },
  });

  pi.registerTool(goalCompleteTool);
  pi.registerTool(goalBlockedTool);
  pi.registerTool(goalWaitTool);
}

function toolContent(text: string) {
  return [
    {
      type: "text" as const,
      text: truncateHead(safeTerminalText(text), {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      }).content,
    },
  ];
}

function completionDetails(goal: string, goalId: string, summary: string): GoalCompleteDetails {
  return {
    goal: goal.slice(0, MAX_GOAL_TEXT_LENGTH),
    goal_id: goalId.slice(0, MAX_GOAL_ID_LENGTH),
    summary: summary.slice(0, MAX_COMPLETION_SUMMARY_LENGTH),
  };
}

function blockerDetails(
  goal: string,
  goalId: string,
  reason: string,
  evidence: string,
  repeatedTurns: number,
): GoalBlockedDetails {
  return {
    goal: goal.slice(0, MAX_GOAL_TEXT_LENGTH),
    goal_id: goalId.slice(0, MAX_GOAL_ID_LENGTH),
    reason: reason.slice(0, MAX_BLOCKER_REASON_LENGTH),
    evidence: evidence.slice(0, MAX_BLOCKER_EVIDENCE_LENGTH),
    repeated_turns: Number.isFinite(repeatedTurns) ? repeatedTurns : 0,
  };
}

function hasPendingSkipForGoal(runtime: GoalRuntime, goalId: string) {
  return (
    runtime.pendingQueueAction?.kind === "advance" &&
    runtime.pendingQueueAction.reason === "skip" &&
    runtime.pendingQueueAction.goalId === goalId
  );
}
