import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assistantTokensAfterGoalState, currentTokenTotal, rebaseGoalUsage } from "./accounting.js";
import type { GoalCommandController } from "./commands.js";
import { notifyTerminal } from "./errors.js";
import { type ActiveGoal, loadGoalStateFromSession } from "./persistence.js";
import {
  buildGoalBindingUpdate,
  buildGoalPrompt,
  buildGoalSystemPrompt,
  GOAL_BINDING_UPDATE_HEADER,
} from "./prompts.js";
import { activateQueuedGoal } from "./queue.js";
import type { GoalRunController } from "./run-protocol.js";
import {
  type AssistantMessageLike,
  abortCurrentTurn,
  blocksStaleGoalToolCalls,
  findFinalAssistantMessage,
  formatError,
  type GoalRuntime,
  hasPendingMessages,
  incrementGoal,
  isGoalContextOverflow,
  isRetryableGoalInterruption,
  isUsageLimitedGoalInterruption,
  resetGoalSafetyEpoch,
  STATUS_KEY,
  type StatusContext,
  truncateNotification,
} from "./runtime.js";
import { hasAssistantToolCall } from "./safety.js";
import { DEFAULT_GOAL_SETTINGS, readGoalSettings } from "./settings.js";

const EXPERIMENTAL_GOALS_WARNING =
  "Experimental ordered goals are enabled for pi-goal. Queue behavior and persisted state may change.";

interface GoalLifecycleOptions {
  settingsPath?: string;
}

export function registerGoalLifecycle(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  commands: GoalCommandController,
  runController: GoalRunController,
  options: GoalLifecycleOptions = {},
) {
  function afterTreeNavigationSettles(ctx: StatusContext, ownsWork: () => boolean, work: () => Promise<unknown>) {
    const generation = runtime.menuGeneration;
    const signal = runtime.menuController.signal;
    let timer: ReturnType<typeof setTimeout>;
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    };
    const attempt = () => {
      if (signal.aborted || generation !== runtime.menuGeneration || !ownsWork()) {
        cancel();
        return;
      }
      if (ctx.isIdle?.() !== true || hasPendingMessages(ctx)) {
        timer = setTimeout(attempt, 1_000);
        return;
      }
      cancel();
      void work().catch((error) => {
        if (!signal.aborted && generation === runtime.menuGeneration) {
          notifyTerminal(ctx.ui, `Cannot restore /goal after tree navigation: ${formatError(error)}`, "error");
        }
      });
    };
    signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(attempt, 0);
  }

  pi.on("session_start", async (_event, ctx) => {
    runtime.replaceMenuSession();
    runtime.inputWakeGoalId = undefined;
    runtime.inputWakeNeedsPrompt = false;
    runtime.pendingDirectInputs = [];
    runtime.ambiguousWaitInputGoalId = undefined;
    runtime.acceptedRunPrompt = undefined;
    runtime.pendingInputWake = undefined;
    runtime.clearGoalWaitWake();
    runtime.clearCompletionStatusTimer();
    runtime.clearContinuationTracking();
    runtime.clearPendingGoalPrompts();
    runtime.clearAgentRun();
    runtime.guardAbortGoalId = undefined;
    runtime.pendingStoppedUsageGoalId = undefined;
    runtime.pendingReplacementUsage = undefined;
    runtime.clearGoalRecovery();
    runtime.clearBudgetWrapUp();
    runtime.clearStaleGoalToolCallBlock();
    runtime.queuedGoals = [];
    runtime.pendingQueueAction = undefined;
    runtime.queueFrozen = false;
    runtime.queueFreezeAwaitingSettle = false;
    runtime.clearTerminalDetails();
    const previousToolVisibility = runtime.settings.toolVisibility;
    const settingsResult = readGoalSettings(options.settingsPath);
    runtime.settings = settingsResult.kind === "loaded" ? settingsResult.settings : DEFAULT_GOAL_SETTINGS;
    runtime.settingsLoadIssue = settingsResult.kind === "invalid" ? settingsResult : undefined;
    if (settingsResult.kind === "invalid") {
      notifyTerminal(ctx.ui, `pi-goal settings ignored: ${settingsResult.reason}. Using default settings.`, "warning");
    }
    if (runtime.settings.experimental.goals) {
      notifyTerminal(ctx.ui, EXPERIMENTAL_GOALS_WARNING, "warning");
    }
    try {
      runtime.toolPolicy.prepareSessionStart(runtime.settings.toolVisibility, previousToolVisibility);
    } catch (error) {
      notifyTerminal(ctx.ui, `Could not restore always-visible goal tools: ${formatError(error)}`, "error");
    }

    const loaded = loadGoalStateFromSession(ctx);
    runtime.activeGoal = loaded.goal;
    runtime.queuedGoals = loaded.queue;
    runtime.pendingQueueAction = loaded.pendingAction;
    runtime.queueFrozen = loaded.hasExperimentalQueueState && !runtime.settings.experimental.goals;
    runController.bindSession(ctx);
    if (runtime.queueFrozen) {
      if (runtime.activeGoal) runtime.persistGoal(runtime.activeGoal);
      ctx.ui.setStatus(STATUS_KEY, "queue off");
      notifyTerminal(
        ctx.ui,
        "An experimental goal queue is frozen because experimental.goals is disabled. Re-enable it and run /reload to continue, or use /goal clear.",
        "warning",
      );
      return;
    }

    let startRestoredQueuedGoal = false;
    if (runtime.activeGoal?.status === "queued" && !runtime.pendingQueueAction) {
      runtime.activeGoal = activateQueuedGoal(runtime.activeGoal, currentTokenTotal(ctx));
      startRestoredQueuedGoal = runtime.activeGoal.status === "active";
    }
    if (runtime.pendingQueueAction) await commands.dispatchPendingQueueActionIfSettled(ctx);
    if (runtime.activeGoal) {
      if (runtime.activeGoal.status === "active" && runtime.activeGoal.safetyResetPending) {
        // Resume/edit activation is persisted before its queued prompt starts. A
        // reload must commit that promised reset before enforcing the old limits.
        runtime.activeGoal = resetGoalSafetyEpoch(runtime.activeGoal);
      }
      if (runtime.activeGoal.status === "active") {
        if (runtime.activeGoal.usageBaselinePending) {
          runtime.activeGoal = rebaseGoalUsage(
            { ...runtime.activeGoal, usageBaselinePending: undefined },
            currentTokenTotal(ctx),
          );
        }
        runtime.recordGoalUsage(runtime.activeGoal, ctx);
        if (runtime.limitActiveGoalForBudget(ctx, false)) return;
        if (runtime.enforceAutomaticTurnLimit(ctx, false) || runtime.enforceNoProgressLimit(ctx)) return;
      }
      // On lazy restore, an earlier restrictive session-start policy still wins:
      // reconciliation unlocks ownership without widening the active tool set.
      runtime.toolPolicy.reconcileRestoredState(runtime.settings.toolVisibility, true);
      if (runtime.activeGoal.status === "active" && !runtime.toolPolicy.toolsAvailable()) {
        runtime.pauseGoalForUnavailableTools(ctx, false);
        return;
      }
      runtime.persistGoal(runtime.activeGoal);
      runtime.updateStatus(ctx, runtime.activeGoal);
      runtime.scheduleGoalWaitWake(ctx);
      if (startRestoredQueuedGoal) {
        const restoredGoal = runtime.activeGoal;
        const sent = await runtime.sendOwnedGoalPrompt(
          ctx,
          restoredGoal.id,
          buildGoalPrompt(restoredGoal),
          false, // Reloaded queue activation preserves its persisted safety epoch.
        );
        if (!sent && runtime.activeGoal?.id === restoredGoal.id) {
          runtime.stopActiveGoal(ctx, {
            kind: "activation_rollback",
            expectedGoalId: restoredGoal.id,
            restoreGoal: restoredGoal,
            abortTurn: false,
          });
        }
      }
    } else {
      runtime.toolPolicy.reconcileRestoredState(runtime.settings.toolVisibility, false);
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });

  pi.on("session_before_tree", (_event, ctx) => {
    const goal = runtime.activeGoal;
    if (runtime.queueFrozen || goal?.status !== "active") return;
    if (!runtime.recordGoalUsage(goal, ctx)) return;
    runtime.persistGoal(goal);
    runtime.updateStatus(ctx, goal);
  });

  pi.on("session_tree", (_event, ctx) => {
    runtime.replaceMenuSession();
    runtime.clearCompletionStatusTimer();
    runtime.cancelContinuationWork();
    runtime.clearContinuationTracking();
    runtime.clearPendingGoalPrompts();
    runtime.clearAgentRun();
    runtime.pendingNonGoalInputs = [];
    runtime.pendingDirectInputs = [];
    runtime.ambiguousWaitInputGoalId = undefined;
    runtime.acceptedRunPrompt = undefined;
    runtime.inputWakeGoalId = undefined;
    runtime.inputWakeNeedsPrompt = false;
    runtime.guardAbortGoalId = undefined;
    runtime.pendingStoppedUsageGoalId = undefined;
    runtime.pendingReplacementUsage = undefined;
    runtime.clearGoalRecovery();
    runtime.clearBudgetWrapUp();
    runtime.clearStaleGoalToolCallBlock();
    runtime.clearTerminalDetails();

    const loaded = loadGoalStateFromSession(ctx);
    runtime.activeGoal = loaded.goal;
    runtime.queuedGoals = loaded.queue;
    runtime.pendingQueueAction = loaded.pendingAction;
    runtime.queueFrozen = loaded.hasExperimentalQueueState && !runtime.settings.experimental.goals;
    if (runtime.queueFrozen) {
      runController.handleTreeNavigation(undefined);
      ctx.ui.setStatus(STATUS_KEY, "queue off");
      return;
    }
    if (!runtime.activeGoal) {
      runController.handleTreeNavigation(undefined);
      runtime.toolPolicy.reconcileRestoredState(runtime.settings.toolVisibility, false);
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    let startQueuedHead = false;
    if (runtime.activeGoal.status === "queued" && !runtime.pendingQueueAction) {
      runtime.activeGoal = activateQueuedGoal(runtime.activeGoal, currentTokenTotal(ctx));
      startQueuedHead = runtime.activeGoal.status === "active";
    }
    runController.handleTreeNavigation(runtime.activeGoal.id);
    runtime.toolPolicy.reconcileRestoredState(runtime.settings.toolVisibility, true);
    const pending = runtime.pendingQueueAction;
    if (pending) {
      afterTreeNavigationSettles(
        ctx,
        () => runtime.pendingQueueAction === pending,
        () => commands.dispatchPendingQueueActionIfSettled(ctx),
      );
    }
    if (runtime.activeGoal.status === "active") {
      const usageIsFinalized =
        runtime.pendingQueueAction?.kind === "prioritize" &&
        runtime.pendingQueueAction.displacedUsageFinalized === true;
      const unaccountedTokens =
        usageIsFinalized || startQueuedHead || runtime.activeGoal.usageBaselinePending
          ? 0
          : assistantTokensAfterGoalState(ctx, loaded.source === "legacy-goals" ? "goals-state" : "goal-state");
      const goalWithUsage = {
        ...runtime.activeGoal,
        tokensUsed: Math.min(Number.MAX_SAFE_INTEGER, runtime.activeGoal.tokensUsed + unaccountedTokens),
      };
      runtime.activeGoal = rebaseGoalUsage(
        { ...goalWithUsage, usageBaselinePending: undefined },
        currentTokenTotal(ctx),
      );
      if (runtime.activeGoal.safetyResetPending) runtime.activeGoal = resetGoalSafetyEpoch(runtime.activeGoal);
      if (runtime.limitActiveGoalForBudget(ctx, false)) return;
      if (runtime.enforceAutomaticTurnLimit(ctx, false) || runtime.enforceNoProgressLimit(ctx)) return;
      if (!runtime.toolPolicy.toolsAvailable()) {
        runtime.pauseGoalForUnavailableTools(ctx, false, false);
        return;
      }
    }
    runtime.persistGoal(runtime.activeGoal);
    runtime.updateStatus(ctx, runtime.activeGoal);
    runtime.scheduleGoalWaitWake(ctx);
    if (startQueuedHead) {
      const queuedHead = runtime.activeGoal;
      afterTreeNavigationSettles(
        ctx,
        () => runtime.activeGoal?.id === queuedHead.id && runtime.activeGoal.status === "active",
        async () => {
          const sent = await runtime.sendOwnedGoalPrompt(ctx, queuedHead.id, buildGoalPrompt(queuedHead), false);
          if (!sent && runtime.activeGoal?.id === queuedHead.id) {
            runtime.stopActiveGoal(ctx, {
              kind: "activation_rollback",
              expectedGoalId: queuedHead.id,
              restoreGoal: queuedHead,
              abortTurn: false,
            });
          }
        },
      );
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    runController.unbindSession();
    runtime.closeMenuSession();
    runtime.inputWakeGoalId = undefined;
    runtime.inputWakeNeedsPrompt = false;
    runtime.pendingDirectInputs = [];
    runtime.ambiguousWaitInputGoalId = undefined;
    runtime.acceptedRunPrompt = undefined;
    runtime.pendingInputWake = undefined;
    runtime.clearGoalWaitWake();
    if (runtime.activeGoal) {
      if (!runtime.queueFrozen && runtime.activeGoal.status === "active") {
        runtime.recordGoalUsage(runtime.activeGoal, ctx, false);
      }
      runtime.persistGoal(runtime.activeGoal);
    }
    runtime.clearContinuationTracking();
    runtime.clearPendingGoalPrompts();
    runtime.clearAgentRun();
    runtime.guardAbortGoalId = undefined;
    runtime.pendingStoppedUsageGoalId = undefined;
    runtime.pendingReplacementUsage = undefined;
    runtime.clearGoalRecovery();
    runtime.clearBudgetWrapUp();
    runtime.clearStaleGoalToolCallBlock();
    runtime.activeGoal = undefined;
    runtime.queuedGoals = [];
    runtime.pendingQueueAction = undefined;
    runtime.queueFrozen = false;
    runtime.queueFreezeAwaitingSettle = false;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    runtime.clearCompletionStatusTimer();
    runtime.clearTerminalDetails();
  });

  pi.on("session_before_compact", (event, ctx) => {
    if (runtime.queueFrozen) return;
    if (runtime.activeGoal?.status === "budget_limited") {
      if ((event as { willRetry?: boolean }).willRetry === true) return { cancel: true as const };
      return;
    }
    if (runtime.activeGoal?.status !== "active") return;
    if (!runtime.recordGoalUsage(runtime.activeGoal, ctx)) return;
    runtime.cancelContinuationWork();
    runtime.persistGoal(runtime.activeGoal);
    runtime.updateStatus(ctx, runtime.activeGoal);
    if (runtime.pendingQueueAction) return;
    if (runtime.limitActiveGoalForBudget(ctx, false)) return { cancel: true as const };
  });

  pi.on("session_compact", async (event, ctx) => {
    if (runtime.queueFrozen) return;
    if (runtime.activeGoal?.status !== "active") {
      runtime.clearGoalRecovery();
      if (runtime.pendingQueueAction) await commands.dispatchPendingQueueActionIfSettled(ctx);
      runtime.scheduleGoalWaitWake(ctx);
      return;
    }

    const restoredState = loadGoalStateFromSession(ctx);
    if (restoredState.goal?.id === runtime.activeGoal.id) {
      runtime.activeGoal = restoredState.goal;
      runtime.queuedGoals = restoredState.queue;
      runtime.pendingQueueAction = restoredState.pendingAction;
    }
    const usageRecorded = runtime.recordGoalUsage(runtime.activeGoal, ctx);
    if (usageRecorded) {
      runtime.persistGoal(runtime.activeGoal);
      runtime.updateStatus(ctx, runtime.activeGoal);
    }
    if (runtime.pendingQueueAction) {
      await commands.dispatchPendingQueueActionIfSettled(ctx);
      return;
    }
    if (!usageRecorded) return;
    if (runtime.limitActiveGoalForBudget(ctx, false)) return;

    const wasPiRetry = runtime.isPiOwnedCompactionRetry(event, runtime.activeGoal.id);
    if (wasPiRetry) return;
    // Between-tool compaction continues the same low-level run. agent_end owns
    // its iteration and continuation ticket; creating one here skips that count.
    if (runtime.agentRunGoalId !== undefined) return;
    runtime.clearGoalRecoveryForGoal(runtime.activeGoal.id);
    runtime.requestContinuation(runtime.activeGoal);
    // Pi emits session_compact before it clears its manual-compaction controller,
    // so sendUserMessage still rejects inside this hook even when ctx reports idle.
    // Defer one task; threshold compaction retains the intent for agent_settled
    // when Pi is still busy.
    runtime.scheduleContinuationDispatch(ctx, runtime.activeGoal.id);
  });

  pi.on("session_compact_failed", (_event, ctx) => {
    runtime.scheduleGoalWaitWake(ctx);
  });

  pi.on("input", (event, _ctx) => {
    if (event.source === "extension") {
      if (runtime.consumeCancelledContinuationPrompt(event.text) || runtime.consumeStaleOwnedGoalPrompt(event.text)) {
        return { action: "handled" as const };
      }
      if (runtime.queueFrozen) return;
      // Streaming input is queued before its model work starts. Keep owned
      // markers pending for message_start, and track non-goal delivery mode so a
      // steer cannot consume a later follow-up's cleanup protection.
      if (runtime.hasPendingOwnedGoalPrompt(event.text)) return;
      if (event.streamingBehavior === "steer" || event.streamingBehavior === "followUp") {
        runtime.noteQueuedNonGoalInput(event.text, event.streamingBehavior);
      } else {
        runtime.noteDirectInput(event.text, false);
      }
      return;
    }
    if (runtime.queueFrozen) return;
    if (/^\/goal(?:\s|$)/u.test(event.text.trimStart())) return;
    if (event.streamingBehavior === "followUp") {
      runtime.noteQueuedNonGoalInput(event.text, "followUp", true);
      return;
    }
    if (event.streamingBehavior === "steer") {
      runtime.noteQueuedNonGoalInput(event.text, "steer", true);
    } else {
      runtime.noteDirectInput(event.text, true);
    }
  });

  pi.on("message_start", (event, ctx) => {
    const message = event.message as { role?: unknown; content?: unknown };
    if (
      message.role === "assistant" &&
      runtime.activeGoal?.status === "paused" &&
      runtime.guardAbortGoalId === runtime.activeGoal.id
    ) {
      abortCurrentTurn(ctx);
      return;
    }
    if (message.role === "custom") {
      if (runtime.isActiveBudgetWrapUpMessage(message)) {
        runtime.beginAgentRun(runtime.activeGoal?.id, "manual");
        return;
      }
      runtime.finalizeStoppedRunUsage(ctx);
      if (runtime.guardAbortGoalId === runtime.activeGoal?.id) {
        runtime.guardAbortGoalId = undefined;
      }
      beginNonGoalFollowUp(ctx, false);
      return;
    }
    if (message.role !== "user") return;
    const prompt = Array.isArray(message.content)
      ? message.content
          .filter((part) => part && typeof part === "object" && Reflect.get(part, "type") === "text")
          .map((part) => Reflect.get(part as object, "text"))
          .filter((text): text is string => typeof text === "string")
          .join("\n")
      : typeof message.content === "string"
        ? message.content
        : "";
    const ownedPrompt = runtime.consumeOwnedGoalPrompt(prompt);
    const ownedPromptBoundary = runtime.hasOwnedPromptBoundary(prompt);
    const acceptedRunPrompt = runtime.acceptedRunPrompt;
    const initialRunMessage =
      acceptedRunPrompt !== undefined &&
      (prompt === acceptedRunPrompt || prompt.startsWith(`${acceptedRunPrompt}\n\n`));
    runtime.acceptedRunPrompt = undefined;
    if (initialRunMessage && runtime.pendingInputWake) {
      const ticket = runtime.pendingInputWake;
      runtime.pendingInputWake = undefined;
      if (!commands.commitWaitingGoalOnInput(ctx, ticket)) {
        runtime.beginAgentRun(null, undefined);
        abortCurrentTurn(ctx);
      }
      return;
    }
    const classifyInput = !ownedPromptBoundary && !initialRunMessage;
    const collidingCandidates =
      classifyInput && runtime.hasDirectInputCandidate(prompt) && runtime.hasQueuedInputCandidate(prompt);
    const exactDirectInput = classifyInput ? runtime.consumeDirectInput(prompt, false) : undefined;
    const exactQueuedInput = classifyInput ? runtime.consumeQueuedNonGoalInput(prompt, false) : undefined;
    const agreeingRealInputs = Boolean(exactDirectInput?.realInput && exactQueuedInput?.realInput);
    if (agreeingRealInputs && exactQueuedInput) runtime.pendingNonGoalInputs.unshift(exactQueuedInput);
    const ambiguousInput =
      !agreeingRealInputs && (collidingCandidates || Boolean(exactDirectInput && exactQueuedInput));
    const deliveredDirectInput = ambiguousInput
      ? exactDirectInput
        ? { ...exactDirectInput, realInput: false }
        : undefined
      : (exactDirectInput ??
        (exactQueuedInput ? undefined : classifyInput ? runtime.consumeDirectInput(prompt) : undefined));
    const queuedNonGoalInput = ambiguousInput
      ? exactQueuedInput
        ? { ...exactQueuedInput, realInput: false }
        : undefined
      : !classifyInput || deliveredDirectInput
        ? undefined
        : (exactQueuedInput ?? runtime.consumeQueuedNonGoalInput(prompt));
    if (!ownedPrompt && ownedPromptBoundary) return;
    if (!ownedPrompt) {
      if (initialRunMessage || deliveredDirectInput || queuedNonGoalInput) {
        runtime.clearGoalRecovery();
        if (deliveredDirectInput?.realInput || queuedNonGoalInput?.realInput) runtime.clearBudgetWrapUp();
        runtime.clearStaleGoalToolCallBlock();
        if (runtime.guardAbortGoalId === runtime.activeGoal?.id) runtime.guardAbortGoalId = undefined;
      }
      if (deliveredDirectInput?.realInput && deliveredDirectInput.waiting) {
        if (commands.resumeWaitingGoalOnInput(ctx, true)) runtime.guardAbortGoalId = undefined;
      } else if (deliveredDirectInput?.realInput) {
        runtime.resetActiveSafetyEpoch(ctx);
      } else if (queuedNonGoalInput?.behavior === "followUp") {
        beginNonGoalFollowUp(ctx, queuedNonGoalInput.realInput, true);
      } else if (queuedNonGoalInput?.realInput) {
        if (commands.resumeWaitingGoalOnInput(ctx, true)) {
          runtime.guardAbortGoalId = undefined;
        } else if (queuedNonGoalInput.realInput) {
          runtime.resetActiveSafetyEpoch(ctx);
        }
      }
      if (runtime.activeGoal?.status !== "active") runtime.beginAgentRun(null, undefined);
      return;
    }
    if (runtime.activeGoal?.id !== ownedPrompt.goalId || runtime.activeGoal.status !== "active") {
      return;
    }
    if (
      runtime.activeGoal.usageBaselinePending ||
      (runtime.agentRunGoalId !== undefined && runtime.agentRunGoalId !== ownedPrompt.goalId)
    ) {
      runtime.activeGoal = rebaseGoalUsage(
        { ...runtime.activeGoal, usageBaselinePending: undefined },
        currentTokenTotal(ctx),
      );
    }
    runtime.beginAgentRun(ownedPrompt.goalId, "manual");
    if (ownedPrompt.resetSafetyEpoch) {
      runtime.activeGoal = resetGoalSafetyEpoch(runtime.activeGoal);
    }
    runtime.persistGoal(runtime.activeGoal);
    runtime.updateStatus(ctx, runtime.activeGoal);
  });

  pi.on("context", (event, ctx) => {
    const messages = event.messages.filter((message) => runtime.keepBudgetWrapUpMessage(message));
    if (runtime.activeGoal?.status === "paused" && runtime.guardAbortGoalId === runtime.activeGoal.id) {
      // A current custom follow-up clears the guard at message_start. Otherwise,
      // context transformation aborts before the provider adapter receives the signal.
      abortCurrentTurn(ctx);
    }
    const goal = runtime.activeGoal;
    if (!runtime.queueFrozen && goal?.status === "active" && runtime.inputWakeGoalId === goal.id) {
      // Native queued input reaches message_start without before_agent_start.
      // Keep the rotated guard visible for every remaining response in this run,
      // without enqueueing another user turn or changing persisted user input.
      messages.push({
        role: "custom",
        customType: "goal-input-wake",
        content: runtime.inputWakeNeedsPrompt
          ? `${GOAL_BINDING_UPDATE_HEADER}\n\n${buildGoalSystemPrompt(goal)}`
          : buildGoalBindingUpdate(goal),
        display: false,
        timestamp: Date.now(),
      });
      return { messages };
    }
    if (messages.length !== event.messages.length) return { messages };
  });

  pi.on("tool_call", (event, ctx) => {
    runtime.markAgentToolAttempted();
    if (runtime.queueFrozen) {
      if (!runtime.toolPolicy.isGoalToolName(event.toolName)) return;
      // Blocking alone feeds an error tool result back to the model. Abort too so
      // stale Goal calls cannot loop while the experimental queue remains frozen.
      abortCurrentTurn(ctx);
      return {
        block: true,
        reason:
          "The experimental goal queue is frozen. Re-enable experimental.goals and run /reload, or use /goal clear.",
      };
    }
    if (
      runtime.activeGoal?.status === "budget_limited" &&
      runtime.budgetWrapUp?.goalId === runtime.activeGoal.id &&
      event.toolName !== "goal_complete"
    ) {
      // A blocked tool result would normally trigger another model call. Abort the
      // wrap-up instead so a tool-seeking model cannot create an unbounded loop.
      abortCurrentTurn(ctx);
      return {
        block: true,
        reason: "Goal token budget is exhausted; only goal_complete is allowed during wrap-up.",
      };
    }
    if (!runtime.staleGoalToolCallsBlocked) return;
    if (!runtime.activeGoal || !blocksStaleGoalToolCalls(runtime.activeGoal.status)) {
      runtime.clearStaleGoalToolCallBlock();
      return;
    }
    // A blocked tool result would normally trigger another model call. Abort the
    // current turn so a tool-seeking model cannot create an unbounded loop that
    // burns provider quota while the goal is stopped.
    abortCurrentTurn(ctx);
    return {
      block: true,
      reason: "Blocked stale /goal tool call after the goal stopped or was interrupted.",
    };
  });

  pi.on("tool_execution_end", (_event, ctx) => {
    if (runtime.queueFrozen) return;
    if (
      runtime.activeGoal?.status === "budget_limited" &&
      runtime.budgetWrapUp?.goalId === runtime.activeGoal.id &&
      !runtime.budgetWrapUp.delivered
    ) {
      runtime.queueBudgetWrapUp(ctx, runtime.activeGoal);
      return;
    }
    if (runtime.activeGoal?.status !== "active") return;

    // AgentSession persists assistant message_end before tool execution events,
    // so the completed assistant call's usage is authoritative at this boundary.
    if (!runtime.recordGoalUsage(runtime.activeGoal, ctx)) return;
    runtime.persistGoal(runtime.activeGoal);
    runtime.updateStatus(ctx, runtime.activeGoal);
    if (runtime.limitActiveGoalForBudget(ctx, true)) return;
    if (!runtime.toolPolicy.toolsAvailable()) runtime.pauseGoalForUnavailableTools(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    runtime.pendingInputWake = undefined;
    runtime.acceptedRunPrompt = typeof event.prompt === "string" ? event.prompt : undefined;
    runtime.inputWakeGoalId = undefined;
    runtime.inputWakeNeedsPrompt = false;
    runtime.clearAgentRun();
    if (runtime.queueFrozen) return;
    // Pi-owned retries emit agent_start directly. Reaching a normal prompt
    // boundary means cleanup no longer owns the next run, so the hard-cap guard
    // must not abort it.
    if (runtime.guardAbortGoalId) runtime.guardAbortGoalId = undefined;
    const goalPrompt = runtime.consumeOwnedGoalPrompt(event.prompt);
    const goalPromptGoalId = goalPrompt?.goalId;
    const continuationGoalId = goalPromptGoalId ? undefined : runtime.markContinuationStarted(event.prompt);
    const ownedPromptGoalId = goalPromptGoalId ?? continuationGoalId;
    const ownedPromptBoundary = runtime.hasOwnedPromptBoundary(event.prompt);
    const activeBudgetWrapUp = runtime.hasActiveBudgetWrapUp();
    const recoveryBeforeInput = runtime.hasActiveGoalRecovery();
    const acceptedDirectInput =
      ownedPromptBoundary || ownedPromptGoalId !== undefined ? undefined : runtime.consumeDirectInput(event.prompt);
    const queuedNonGoalInput =
      activeBudgetWrapUp || acceptedDirectInput
        ? undefined
        : runtime.consumeQueuedNonGoalInput(
            event.prompt,
            !recoveryBeforeInput && ownedPromptGoalId === undefined && !ownedPromptBoundary,
          );
    if (acceptedDirectInput || queuedNonGoalInput) runtime.clearGoalRecovery();
    const activeGoalRecovery = runtime.hasActiveGoalRecovery();
    if (acceptedDirectInput?.realInput || queuedNonGoalInput?.realInput) {
      const ticket = commands.prepareWaitingGoalOnInput(ctx);
      if (ticket) {
        runtime.pendingInputWake = ticket;
        runtime.beginAgentRun(null, undefined);
        return { systemPrompt: `${event.systemPrompt}\n\n${buildGoalSystemPrompt(ticket.resumedGoal)}` };
      }
    }
    if (!ownedPromptBoundary && ownedPromptGoalId === undefined && acceptedDirectInput?.realInput) {
      if (acceptedDirectInput.waiting) commands.resumeWaitingGoalOnInput(ctx);
      else runtime.resetActiveSafetyEpoch(ctx);
    }
    if (queuedNonGoalInput?.behavior === "followUp") {
      beginNonGoalFollowUp(ctx, queuedNonGoalInput.realInput, false);
    } else if (queuedNonGoalInput?.realInput) {
      if (!commands.resumeWaitingGoalOnInput(ctx) && queuedNonGoalInput.realInput) {
        runtime.resetActiveSafetyEpoch(ctx);
      }
    }
    const runOrigin = continuationGoalId
      ? "automatic"
      : activeGoalRecovery && runtime.goalRecovery?.automaticOwner
        ? "automatic"
        : "manual";
    if (runtime.pendingQueueAction?.kind === "prioritize" && !activeBudgetWrapUp && !activeGoalRecovery) {
      // A turn that starts after priority intent is committed belongs to neither
      // the displaced goal nor the not-yet-activated urgent goal. Persist the
      // displaced goal's final accounting boundary so reload cannot absorb this run.
      if (!runtime.pendingQueueAction.displacedUsageFinalized) {
        if (runtime.activeGoal?.status === "active") {
          runtime.recordGoalUsage(runtime.activeGoal, ctx, false);
        }
        runtime.pendingQueueAction.displacedUsageFinalized = true;
        if (runtime.activeGoal) {
          runtime.persistGoal(runtime.activeGoal);
          runtime.updateStatus(ctx, runtime.activeGoal);
        }
      }
      runtime.beginAgentRun(null, undefined);
      if (ownedPromptGoalId) abortCurrentTurn(ctx);
      return;
    }
    if (activeBudgetWrapUp && runtime.activeGoal) {
      runtime.beginAgentRun(runtime.activeGoal.id, "manual");
      return;
    }
    if (
      runtime.pendingQueueAction?.kind === "advance" &&
      runtime.pendingQueueAction.goalId === runtime.activeGoal?.id
    ) {
      runtime.beginAgentRun(ownedPromptGoalId ?? runtime.activeGoal.id, runOrigin);
      if (ownedPromptGoalId) abortCurrentTurn(ctx);
      return;
    }
    if (ownedPromptGoalId && ownedPromptGoalId !== runtime.activeGoal?.id) {
      runtime.beginAgentRun(ownedPromptGoalId, runOrigin);
      if (runtime.activeGoal?.status === "active" && !runtime.toolPolicy.toolsAvailable()) {
        runtime.pauseGoalForUnavailableTools(ctx, false);
      }
      abortCurrentTurn(ctx);
      return;
    }
    if (runtime.activeGoal?.status !== "active") return;
    runtime.beginAgentRun(runtime.activeGoal.id, runOrigin);
    if (!runtime.toolPolicy.toolsAvailable()) {
      runtime.pauseGoalForUnavailableTools(ctx, ownedPromptGoalId !== undefined);
      return;
    }
    if (goalPromptGoalId === runtime.activeGoal.id && runtime.activeGoal.usageBaselinePending) {
      runtime.activeGoal = rebaseGoalUsage(
        { ...runtime.activeGoal, usageBaselinePending: undefined },
        currentTokenTotal(ctx),
      );
    }
    if (goalPrompt?.resetSafetyEpoch && goalPromptGoalId === runtime.activeGoal.id) {
      runtime.activeGoal = resetGoalSafetyEpoch(runtime.activeGoal);
      runtime.persistGoal(runtime.activeGoal);
      runtime.updateStatus(ctx, runtime.activeGoal);
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildGoalSystemPrompt(runtime.activeGoal)}`,
    };
  });

  pi.on("agent_start", (_event, _ctx) => {
    if (runtime.queueFrozen) return;
    const activeGoal = runtime.activeGoal;
    if (activeGoal && runtime.guardAbortGoalId === activeGoal.id && activeGoal.status === "paused") {
      if (runtime.consumeQueuedNonGoalFollowUpForAgentStart()) {
        runtime.guardAbortGoalId = undefined;
        runtime.clearStaleGoalToolCallBlock();
        runtime.beginAgentRun(null, undefined);
      }
      // Unknown runs defer cleanup until their message/context boundary: custom
      // follow-ups have no input event, while bare recovery is aborted pre-provider.
      return;
    }
    runtime.beginRecoveryRunIfNeeded();
  });

  pi.on("turn_end", (event, ctx) => {
    if (runtime.queueFrozen) return;
    runtime.recordAutomaticTurn(ctx, event.message);
  });

  pi.on("agent_end", (event, ctx) => {
    const run = runtime.finishAgentRun();
    const replacement = runtime.pendingReplacementUsage;
    if (replacement && replacement.runGoalId === run.goalId) {
      runtime.pendingReplacementUsage = undefined;
      const successor = runtime.activeGoal;
      if (successor?.id === replacement.replacementGoalId) {
        const rebasedSuccessor = rebaseGoalUsage(
          { ...successor, usageBaselinePending: undefined },
          currentTokenTotal(ctx),
        );
        runtime.activeGoal = rebasedSuccessor;
        runtime.persistGoal(rebasedSuccessor);
        if (runtime.activeGoal === rebasedSuccessor) runtime.updateStatus(ctx, rebasedSuccessor);
      }
    }
    if (runtime.finalizeStoppedRunUsage(ctx, run.goalId)) return;
    if (runtime.queueFrozen || run.goalId === null) return;
    if (!runtime.canRecordGoalUsage() && !runtime.hasActiveBudgetWrapUp()) return;
    if (run.goalId && run.goalId !== runtime.activeGoal?.id) return;
    if (!runtime.activeGoal) return;
    if (runtime.activeGoal.status === "budget_limited" && runtime.budgetWrapUp?.goalId === runtime.activeGoal.id) {
      runtime.recordGoalUsage(runtime.activeGoal, ctx);
      runtime.persistGoal(runtime.activeGoal);
      runtime.updateStatus(ctx, runtime.activeGoal);
      runtime.clearBudgetWrapUp();
      return;
    }
    if (runtime.activeGoal.status !== "active") return;
    if (runtime.pendingQueueAction?.kind === "advance" && runtime.pendingQueueAction.goalId === runtime.activeGoal.id) {
      runtime.recordGoalUsage(runtime.activeGoal, ctx);
      runtime.persistGoal(runtime.activeGoal);
      runtime.updateStatus(ctx, runtime.activeGoal);
      return;
    }

    const goalId = runtime.activeGoal.id;
    const alreadyAwaitingContinuation = runtime.hasContinuationWorkForGoal(goalId);
    const finalAssistant = findFinalAssistantMessage(event.messages);

    if (!alreadyAwaitingContinuation) runtime.activeGoal = incrementGoal(runtime.activeGoal);
    runtime.recordGoalUsage(runtime.activeGoal, ctx);

    if (finalAssistant?.stopReason === "aborted") {
      runtime.clearGoalRecoveryForGoal(goalId);
      stopGoalAfterAgentEnd(ctx, runtime.activeGoal, finalAssistant, "paused");
      return;
    }

    if (finalAssistant?.stopReason === "error") {
      if (isRetryableGoalInterruption(finalAssistant)) {
        if (run.origin === "automatic" && runtime.enforceAutomaticTurnLimit(ctx, true)) return;
        if (runtime.limitActiveGoalForBudget(ctx, false)) return;
        if (!runtime.toolPolicy.toolsAvailable()) {
          runtime.pauseGoalForUnavailableTools(ctx);
          return;
        }
        runtime.goalRecovery = {
          goalId,
          kind: isGoalContextOverflow(finalAssistant) ? "compaction_retry" : "provider_retry",
          automaticOwner: run.origin === "automatic",
          errorMessage: finalAssistant.errorMessage,
        };
        runtime.cancelContinuationWork();
        runtime.persistGoal(runtime.activeGoal);
        runtime.updateStatus(ctx, runtime.activeGoal);
        return;
      }
      runtime.clearGoalRecoveryForGoal(goalId);
      stopGoalAfterAgentEnd(
        ctx,
        runtime.activeGoal,
        finalAssistant,
        isUsageLimitedGoalInterruption(finalAssistant) ? "usage_limited" : "blocked",
      );
      return;
    }

    runtime.clearGoalRecoveryForGoal(goalId);

    if (runtime.limitActiveGoalForBudget(ctx, false)) return;
    if (!runtime.toolPolicy.toolsAvailable()) {
      runtime.pauseGoalForUnavailableTools(ctx);
      return;
    }
    if (
      run.origin === "automatic" &&
      runtime.recordAutomaticRunProgress(
        ctx,
        goalId,
        event.messages,
        run.toolAttempted || hasAssistantToolCall(event.messages),
      )
    ) {
      return;
    }

    runtime.persistGoal(runtime.activeGoal);
    runtime.updateStatus(ctx, runtime.activeGoal);

    const currentGoal = runtime.activeGoal;
    if (!currentGoal || currentGoal.id !== goalId || currentGoal.status !== "active") return;
    if (runtime.pendingQueueAction?.kind === "prioritize") return;
    runtime.requestContinuation(currentGoal);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (runtime.queueFrozen) {
      runtime.clearSettledSafetyTracking();
      runtime.queueFreezeAwaitingSettle = false;
      if (runtime.settings.experimental.goals) {
        await commands.resumeQueueAfterUnfreeze(ctx);
      }
      return;
    }
    runtime.finalizeSettledRecovery(ctx);
    let dispatchedQueueAction = false;
    if (runtime.pendingQueueAction) {
      dispatchedQueueAction = await commands.dispatchPendingQueueActionIfSettled(ctx);
    }
    if (!dispatchedQueueAction) runtime.dispatchContinuationIfSettled(ctx);
    runtime.clearSettledSafetyTracking();
    runtime.acceptedRunPrompt = undefined;
    runtime.pendingInputWake = undefined;
    runtime.inputWakeGoalId = undefined;
    runtime.inputWakeNeedsPrompt = false;
    runtime.scheduleGoalWaitWake(ctx);
  });

  function beginNonGoalFollowUp(ctx: StatusContext, realInput = false, inRun = false) {
    const resumed = realInput && commands.resumeWaitingGoalOnInput(ctx, inRun);
    if (resumed) runtime.guardAbortGoalId = undefined;
    runtime.clearGoalRecovery();
    runtime.clearStaleGoalToolCallBlock();
    if (realInput) runtime.clearBudgetWrapUp();
    const activeGoalId = runtime.activeGoal?.status === "active" ? runtime.activeGoal.id : undefined;
    runtime.beginAgentRun(activeGoalId ?? null, activeGoalId ? "manual" : undefined);
    if (realInput && activeGoalId && !resumed) runtime.resetActiveSafetyEpoch(ctx);
  }

  function stopGoalAfterAgentEnd(
    ctx: StatusContext,
    goal: ActiveGoal,
    assistant: AssistantMessageLike,
    status: "paused" | "blocked" | "usage_limited",
  ) {
    const stoppedGoal = runtime.stopActiveGoal(ctx, {
      kind: "agent_interruption",
      expectedGoalId: goal.id,
      status,
      reason: assistant.errorMessage ?? `goal ${status} after agent interruption`,
    });
    if (!stoppedGoal) return;

    const details = assistant.errorMessage ? ` (${truncateNotification(assistant.errorMessage)})` : "";
    if (status === "paused") {
      notifyTerminal(ctx.ui, `Goal paused after interruption${details}. Run /goal resume to continue.`, "warning");
      return;
    }
    if (status === "usage_limited") {
      notifyTerminal(
        ctx.ui,
        `Goal stopped after provider usage limit${details}. Run /goal resume when usage is available.`,
        "warning",
      );
      return;
    }
    notifyTerminal(
      ctx.ui,
      `Goal blocked after agent error${details}. Resolve the blocker or run /goal resume to retry.`,
      "warning",
    );
  }
}
