import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CanonicalFingerprints, canonicalEntryKey } from "./canonical-fingerprint.js";
import { completePlanArguments } from "./command.js";
import {
  normalizePlanModeCompletion,
  PLAN_MODE_COMPLETE_PARAMS,
  PLAN_MODE_COMPLETE_TOOL_NAME,
  planModeCompleted,
  renderPlanModeCompletion,
} from "./completion-tool.js";
import { isStaleExtensionContextError, onAgentSettled, setPlanThinkingLevel } from "./extension-runtime.js";
import { formatImplementationHandoff, startFreshImplementationFromState } from "./fresh-implementation.js";
import { resolveHypaExecutablePaths } from "./hypa-wrapper.js";
import {
  createImplementationModelCoordinator,
  describeImplementationHandoff,
  type ImplementationModelHandoff,
  type ImplementationModelTarget,
  sameModel,
} from "./implementation-model.js";
import {
  createImplementationRetentionCoordinator,
  implementationRetentionPreview,
} from "./implementation-retention.js";
import { PLAN_HANDOFF_IDENTITY_ENTRY, PlanInputOwnership } from "./input-ownership.js";
import { invalidPlanMessage, latestAssistantText, parseProposedPlan } from "./message-transform.js";
import { modelMutationPending } from "./model-mutation.js";
import { createPlanActionController } from "./plan-action-controller.js";
import { createPlanExportController } from "./plan-export-controller.js";
import {
  clearPlanModeUi,
  planModeStatusText as formatPlanModeStatusText,
  showStoredPlan,
  updatePlanModeUi,
} from "./presentation.js";
import { buildPlanModePrompt } from "./prompt.js";
import {
  answerPlanModeQuestions,
  normalizePlanModeQuestionParams,
  PLAN_MODE_QUESTION_PARAMS,
  PLAN_MODE_QUESTION_TOOL_NAME,
  planModeQuestionCancelled,
} from "./question-tool.js";
import { withoutRequiredPlanModeTools, withRequiredPlanModeTools } from "./required-tools.js";
import { preflightSavedPlanImplementation, savedPlanBlocksNewWorkflow } from "./saved-plan-preflight.js";
import {
  awaitPlanModeSettingsWrites,
  configuredImplementationPlanRetention,
  configuredPlanModeToggleShortcut,
  configuredThinkingLevel,
  type PlanModeSettings,
  readPlanModeSettings,
} from "./settings.js";
import { type PlanCompletionSource, type PlanModeState, restorePlanModeState } from "./state.js";
import {
  canSelectToolInPlanMode,
  classifyPlanModeTool,
  findBlockedCommandSegment,
  readCommand,
} from "./tool-policy.js";
import {
  compareTools,
  filterAvailableSelectedToolNames,
  snapshotPlanModeSelectedNames,
  snapshotPlanModeToolNames,
  toolPolicyLabel,
} from "./tool-selection.js";

const STATE_ENTRY_TYPE = "plan-mode-state";
const PROPOSED_PLAN_MESSAGE_TYPE = "proposed-plan";
const BLOCKED_BUILTIN_TOOLS = new Set(["edit", "write"]);
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
interface ReadyPresentationIntent {
  nonce: number;
  plan: string;
  source: PlanCompletionSource;
}
type InteractiveUi = typeof import("./interactive-ui.js");

interface PlanModeDependencies {
  readSettings?(): ReturnType<typeof readPlanModeSettings>;
  settingsPath?: string;
  loadInteractiveUi?(): Promise<InteractiveUi>;
}
export default function planMode(pi: ExtensionAPI, dependencies: PlanModeDependencies = {}) {
  let interactiveUiPromise: Promise<InteractiveUi> | undefined;
  const loadInteractiveUi = () => {
    if (dependencies.loadInteractiveUi) return dependencies.loadInteractiveUi();
    if (!interactiveUiPromise) {
      interactiveUiPromise = import("./interactive-ui.js").catch((error) => {
        interactiveUiPromise = undefined;
        throw error;
      });
    }
    return interactiveUiPromise;
  };
  let state: PlanModeState = { enabled: false, awaitingAction: false };
  let settings: PlanModeSettings = { thinkingLevel: "inherit" };
  let toggleShortcut: ReturnType<typeof configuredPlanModeToggleShortcut>;
  let previousTools: string[] | undefined;
  let permittedTools: Set<string> | undefined;
  let readyPresentationIntent: ReadyPresentationIntent | undefined;
  let latestCommandContext: ExtensionCommandContext | undefined;
  let nextReadyPresentationNonce = 0;
  let menuGeneration = 0;
  let workflowGeneration = 0;
  let refreshStateBeforeFirstAgentStart = false;
  let menuController = new AbortController();
  let workflowController = new AbortController();
  const ownedThinkingChanges: Array<{ previousLevel: string; level: string }> = [];
  let settingOwnedThinking = false;
  const implementationModels = createImplementationModelCoordinator({
    pi,
    setThinkingLevel: (level) => setOwnedThinkingLevel(level),
  });
  const implementationRetention = createImplementationRetentionCoordinator();
  const fingerprints = new CanonicalFingerprints();
  const inputOwnership = new PlanInputOwnership(
    (data) => pi.appendEntry(PLAN_HANDOFF_IDENTITY_ENTRY, data),
    fingerprints,
  );
  let stateOrigin: ReturnType<typeof captureStateOrigin> | undefined;
  function captureStateOrigin(ctx: Pick<ExtensionContext, "sessionManager">) {
    const branch = ctx.sessionManager.getBranch();
    const source = [...branch]
      .reverse()
      .find((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE);
    return {
      manager: ctx.sessionManager,
      sessionId: ctx.sessionManager.getSessionId?.(),
      branch: branch.map((entry) => fingerprints.key(entry, canonicalEntryKey)),
      // A descendant may share the full prefix but own a newer authoritative
      // state. Pin the complete native entry, including identity and data.
      source: source && fingerprints.key(source, canonicalEntryKey),
    };
  }
  function originIsCurrent(
    origin: ReturnType<typeof captureStateOrigin>,
    ctx: Pick<ExtensionContext, "sessionManager">,
    checkStateSource = true,
  ) {
    const live = captureStateOrigin(ctx);
    return (
      origin.manager === live.manager &&
      origin.sessionId === live.sessionId &&
      (!checkStateSource || origin.source === live.source) &&
      origin.branch.every((entry, index) => live.branch[index] === entry)
    );
  }
  function stateIsCurrent(ctx: ExtensionContext) {
    stateOrigin ??= captureStateOrigin(ctx);
    return originIsCurrent(stateOrigin, ctx);
  }
  const persistState = (ctx: ExtensionContext) => {
    if (!stateIsCurrent(ctx)) return;
    pi.appendEntry<PlanModeState>(STATE_ENTRY_TYPE, state);
    stateOrigin = captureStateOrigin(ctx);
  };

  const clearPlanModeShortcutHandler = () => {};
  const applyPlanModeShortcut = (nextShortcut: ReturnType<typeof configuredPlanModeToggleShortcut>) => {
    if (toggleShortcut && toggleShortcut !== nextShortcut) {
      pi.registerShortcut(toggleShortcut, {
        handler: clearPlanModeShortcutHandler,
      });
    }
    if (!nextShortcut) {
      toggleShortcut = undefined;
      return;
    }
    if (toggleShortcut === nextShortcut) return;
    pi.registerShortcut(nextShortcut, {
      description: "Toggle Plan mode",
      handler: (ctx) => {
        // Pi's editor captures registrations at startup; replacing a registration
        // does not replace that captured handler until /reload.
        if (configuredPlanModeToggleShortcut(settings) === nextShortcut) return togglePlanMode(ctx);
      },
    });
    toggleShortcut = nextShortcut;
  };
  const planExports = createPlanExportController({
    getState: () => state,
    getSettings: () => settings,
    finishReady: (ctx) => exitPlanMode(ctx),
  });
  const planActions = createPlanActionController({
    loadInteractiveUi,
    getState: () => state,
    captureLifecycle: captureMenuLifecycle,
    statusText: planStatusText,
    implementationOutcome,
    getExportDestination: (ctx) => planExports.getDestination(ctx),
    show: (ctx) => showStoredPlan(pi, ctx, state),
    finalize: requestFinalPlan,
    implementHere: startImplementation,
    implementFresh: startFreshImplementation,
    exportPlan: (ctx, path, signal, isCurrent) => planExports.export(path, ctx, signal, isCurrent),
    settings: showSettings,
    save: savePlanForLater,
    stay: updateUi,
    exitReady: (ctx) => {
      exitPlanMode(ctx);
      ctx.ui.notify("Plan mode disabled. Proposed plan discarded.", "info");
    },
    clearSaved: (ctx) => {
      exitPlanMode(ctx);
      ctx.ui.notify("Saved plan cleared.", "info");
    },
  });

  pi.registerFlag("plan", {
    description: "Start in Codex-like Plan mode",
    type: "boolean",
    default: false,
  });

  pi.registerTool({
    name: PLAN_MODE_QUESTION_TOOL_NAME,
    label: "Plan question",
    description:
      "Ask the user one to three Plan-mode clarification questions with meaningful options, then wait for the answer. Only available while Plan mode is active.",
    promptSnippet: "Ask user decision questions while Plan mode is active",
    promptGuidelines: [
      "In Plan mode, use plan_mode_question for important preferences, tradeoffs, or assumptions that cannot be discovered from read-only exploration.",
    ],
    parameters: PLAN_MODE_QUESTION_PARAMS,
    async execute(_toolCallId, params: unknown, signal, _onUpdate, ctx) {
      if (!stateIsCurrent(ctx) || !state.enabled) {
        return planModeQuestionCancelled(
          [],
          "plan_mode_inactive",
          "Error: plan_mode_question is only available while Plan mode is active.",
        );
      }

      const parsed = normalizePlanModeQuestionParams(params);
      if (!parsed.ok) {
        return planModeQuestionCancelled([], "invalid_input", `Error: ${parsed.error}`);
      }

      if (!ctx.hasUI) {
        return planModeQuestionCancelled(
          parsed.questions,
          "ui_unavailable",
          "Unable to ask Plan-mode questions because interactive UI is not available.",
        );
      }

      const sessionGeneration = menuGeneration;
      const questionWorkflowGeneration = workflowGeneration;
      return answerPlanModeQuestions(parsed.questions, ctx, {
        signal: AbortSignal.any(
          [signal, ctx.signal, menuController.signal, workflowController.signal].filter(
            (candidate): candidate is AbortSignal => candidate !== undefined,
          ),
        ),
        isCurrent: () =>
          stateIsCurrent(ctx) &&
          sessionGeneration === menuGeneration &&
          questionWorkflowGeneration === workflowGeneration,
        isEnabled: () => state.enabled,
      });
    },
  });

  pi.registerTool({
    name: PLAN_MODE_COMPLETE_TOOL_NAME,
    exposure: "model-only",
    label: "Complete plan",
    description:
      "Submit the complete decision-ready implementation plan for user review. Only available while Plan mode is active, and must be the final standalone action.",
    promptSnippet: "Submit the final Plan-mode implementation plan",
    promptGuidelines: [
      "Call plan_mode_complete alone as the final action only after the implementation plan is decision-complete.",
    ],
    parameters: PLAN_MODE_COMPLETE_PARAMS,
    renderResult: renderPlanModeCompletion,
    async execute(toolCallId, params: unknown, _signal, _onUpdate, ctx) {
      if (!stateIsCurrent(ctx) || !state.enabled)
        throw new Error("plan_mode_complete is only available while Plan mode is active");
      if (!inputOwnership.consumeCall(toolCallId, ctx, workflowGeneration)) {
        throw new Error("Plan completion authorization was retired or does not match the accepted native revision");
      }
      const parsed = normalizePlanModeCompletion(params);
      if (!parsed.ok) throw new Error(parsed.error);
      acceptCompletedPlan(parsed.plan, PLAN_MODE_COMPLETE_TOOL_NAME, ctx);
      return planModeCompleted(parsed.plan);
    },
  });

  pi.registerCommand("plan", {
    description: "Enter or manage Codex-like Plan mode",
    getArgumentCompletions: completePlanArguments,
    handler: async (args, ctx) => {
      if (!stateIsCurrent(ctx)) return;
      reconcileModelHandoff(ctx);
      latestCommandContext = ctx;
      const prompt = args.trim();
      const command = prompt.toLowerCase();
      if (command === "start") {
        if (savedPlanBlocksNewWorkflow(ctx, state.savedPlan !== undefined && !state.enabled)) return;
        if (state.enabled) {
          ctx.ui.notify("Plan mode is already active.", "info");
          return;
        }
        await withPlanningModel(ctx, () => {
          enterPlanMode(ctx);
          ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
        });
        return;
      }
      if (command === "show") {
        showStoredPlan(pi, ctx, state);
        return;
      }
      if (command === "finalize") {
        requestFinalPlan(ctx);
        return;
      }
      if (command === "implement") {
        if (!(state.enabled && state.latestPlan?.trim()) && !state.savedPlan?.plan.trim()) {
          ctx.ui.notify("No completed plan is available to implement.", "warning");
          return;
        }
        await startImplementation(ctx);
        return;
      }
      if (command === "save") {
        savePlanForLater(ctx);
        return;
      }
      const exportMatch = /^export(?:\s+([\s\S]+))?$/iu.exec(prompt);
      if (exportMatch) {
        const lifecycle = captureMenuLifecycle();
        await planExports.export(exportMatch[1], ctx, lifecycle.signal, lifecycle.isCurrent);
        return;
      }
      if (command === "exit" || command === "off") {
        const notification = state.activeImplementation
          ? "Active implementation plan cleared."
          : state.savedPlan
            ? "Saved plan cleared."
            : state.latestPlan
              ? "Plan mode disabled. Proposed plan discarded."
              : "Plan mode disabled.";
        const restoring = exitPlanMode(ctx);
        ctx.ui.notify(notification, "info");
        await restoring;
        return;
      }
      if (command === "tools") {
        if (savedPlanBlocksNewWorkflow(ctx, state.savedPlan !== undefined && !state.enabled)) return;
        if (state.enabled) {
          const message =
            "Plan-mode tools are locked while Planning is active. Exit Plan mode and choose tools before starting again.";
          if (!ctx.hasUI) throw new Error(message);
          ctx.ui.notify(message, "warning");
          return;
        }
        if (!ctx.hasUI) {
          throw new Error("/plan tools requires TUI or RPC mode and is unavailable here.");
        }
        await showLaunchMenu(ctx, "tools");
        return;
      }
      if (prompt) {
        if (savedPlanBlocksNewWorkflow(ctx, state.savedPlan !== undefined && !state.enabled)) return;
        await withPlanningModel(ctx, () => enterPlanModeWithPrompt(prompt, ctx));
        return;
      }
      if (!ctx.hasUI) {
        throw new Error(
          "The interactive /plan menu is unavailable in print and JSON modes. Use /plan start or /plan <prompt>.",
        );
      }
      if (!state.enabled) {
        if (state.activeImplementation && ctx.hasUI) {
          await showActivePlanMenu(ctx);
          return;
        }
        if (state.savedPlan) {
          await planActions.showSaved(ctx);
          return;
        }
        await showLaunchMenu(ctx);
        return;
      }
      await planActions.showCurrent(ctx);
    },
  });

  pi.on("session_start", async (event, ctx) => {
    const generation = ++menuGeneration;
    advanceWorkflow();
    permittedTools = undefined;
    refreshStateBeforeFirstAgentStart = event.reason === "new";
    menuController.abort(new DOMException("Plan-mode session replaced", "AbortError"));
    menuController = new AbortController();
    readyPresentationIntent = undefined;
    latestCommandContext = undefined;
    implementationRetention.reset();
    settings = { thinkingLevel: "inherit" };
    restoreState(ctx);
    implementationRetention.restore(state.activeImplementation);
    const loadedSettings = await (dependencies.readSettings?.() ?? readPlanModeSettings());
    if (generation !== menuGeneration || menuController.signal.aborted) return;
    if (loadedSettings.kind === "loaded") {
      settings = loadedSettings.settings;
      applyPlanModeShortcut(configuredPlanModeToggleShortcut(settings));
    } else if (loadedSettings.kind === "invalid") {
      ctx.ui.notify(`pi-plan-mode settings ignored: ${loadedSettings.reason}`, "warning");
    }
    if (loadedSettings.notice) ctx.ui.notify(loadedSettings.notice, "warning");
    const persistFlagActivation = pi.getFlag("plan") === true && !state.enabled;
    const flagHandoff = persistFlagActivation ? state.modelHandoff : undefined;
    if (flagHandoff) {
      state = { ...state, modelHandoff: undefined };
      const restored = await finishModelHandoff(ctx, flagHandoff);
      if (!restored || generation !== menuGeneration || menuController.signal.aborted) return;
    }
    if (persistFlagActivation) {
      state = state.savedPlan
        ? {
            ...state,
            enabled: true,
            latestPlan: state.savedPlan.plan,
            latestPlanSource: state.savedPlan.source,
            awaitingAction: true,
            savedPlan: undefined,
            activeImplementation: undefined,
          }
        : { ...state, enabled: true, activeImplementation: undefined };
    }
    if (state.enabled) {
      activatePlanModeTools();
      applyPlanThinkingLevel();
    } else deactivatePlanModeQuestionTool();
    if (persistFlagActivation) persistState(ctx);
    updateUi(ctx);
  });

  function guardModelMutation(_event: unknown, ctx: ExtensionContext) {
    if (!modelMutationPending(ctx)) return;
    // Never await a mutation here: setModel awaits model_select handlers,
    // which may themselves request navigation or session replacement.
    ctx.ui.notify(
      "Plan model change is in progress; retry navigation or session replacement after it finishes.",
      "warning",
    );
    return { cancel: true };
  }
  pi.on("session_before_tree", guardModelMutation);
  pi.on("session_before_switch", guardModelMutation);
  pi.on("session_before_fork", guardModelMutation);

  pi.on("session_tree", (_event, ctx) => {
    // This is the committed boundary: getBranch() now belongs to the target.
    // Pi has already restored any loadout declared by the target's canonical
    // transcript. Even an empty system loadout owns the target's tools.
    const targetDeclaresTools = ctx.sessionManager
      .buildSessionProjection()
      .messages.some((message) => message.role === "system");
    menuGeneration += 1;
    advanceWorkflow();
    menuController.abort(new DOMException("Plan-mode branch changed", "AbortError"));
    menuController = new AbortController();
    readyPresentationIntent = undefined;
    latestCommandContext = undefined;
    refreshStateBeforeFirstAgentStart = false;
    if (state.enabled) {
      if (!targetDeclaresTools) restoreTools();
      restoreThinkingLevel();
    }
    previousTools = undefined;
    permittedTools = undefined;
    restoreState(ctx);
    implementationRetention.reset();
    implementationRetention.restore(state.activeImplementation);
    if (state.enabled) {
      activatePlanModeTools();
      applyPlanThinkingLevel();
    } else deactivatePlanModeQuestionTool();
    updateUi(ctx);
  });

  pi.on("thinking_level_select", (event, ctx) => {
    if (menuController.signal.aborted || !stateIsCurrent(ctx)) return;
    const owned = ownedThinkingChanges.findIndex(
      (change) =>
        change.previousLevel === event.previousLevel && (settingOwnedThinking || change.level === event.level),
    );
    if (owned >= 0) {
      ownedThinkingChanges.splice(owned, 1);
      return;
    }
    implementationModels.thinkingSelected();
    if (state.modelHandoff) {
      reconcileModelHandoff(ctx);
      return;
    }
    if (!state.enabled || !state.appliedThinkingLevel) return;
    if (event.level !== state.appliedThinkingLevel) {
      state = {
        ...state,
        manualThinkingLevel: event.level,
        previousThinkingLevel: undefined,
        appliedThinkingLevel: undefined,
      };
      persistState(ctx);
    }
  });

  pi.on("model_select", (event, ctx) => {
    if (menuController.signal.aborted) return;
    implementationModels.modelSelected(event.model);
    if (!stateIsCurrent(ctx)) return;
    reconcileModelHandoff(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    inputOwnership.commitHandoffs(ctx, workflowGeneration);
    menuGeneration += 1;
    advanceWorkflow();
    menuController.abort(new DOMException("Plan-mode session shut down", "AbortError"));
    readyPresentationIntent = undefined;
    latestCommandContext = undefined;
    refreshStateBeforeFirstAgentStart = false;
    implementationRetention.reset();
    await awaitPlanModeSettingsWrites(dependencies.settingsPath);
    captureManualThinkingLevel();
    persistState(ctx);
    if (state.enabled) {
      restoreTools();
      restoreThinkingLevel();
    }
    clearUi(ctx);
    fingerprints.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!stateIsCurrent(ctx)) return { block: true, reason: "Plan branch reconciliation is pending." };
    if (!state.enabled) return;
    if (
      event.toolName === PLAN_MODE_COMPLETE_TOOL_NAME &&
      !inputOwnership.authorizeCall(event.toolCallId, ctx, workflowGeneration)
    ) {
      return { block: true, reason: "Plan completion requires an accepted user or owned Plan revision." };
    }
    if (event.toolName === "update_plan") {
      return {
        block: true,
        reason:
          "Plan mode blocks update_plan because it tracks execution progress rather than conversational planning.",
      };
    }
    const calledTool = toolByName(event.toolName);
    if (calledTool && classifyPlanModeTool(calledTool) === "blocked") {
      return {
        block: true,
        reason: `Plan mode blocks built-in tool '${event.toolName}' because its policy class is blocked.`,
      };
    }
    if (!calledTool && BLOCKED_BUILTIN_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Plan mode blocks built-in tool '${event.toolName}' because its metadata is unavailable.`,
      };
    }
    if (!permittedTools?.has(event.toolName)) {
      return {
        block: true,
        reason: `Plan mode blocks tool '${event.toolName}' because it is outside the frozen planning tool selection.`,
      };
    }
    // Built-in-compatible overrides retain the canonical name but replace its source metadata.
    if (event.toolName !== "bash") return;

    const command = readCommand(event.input);
    let blocked = findBlockedCommandSegment(command, settings.safeSubcommands, { hypaExecutables: new Set() });
    if (blocked !== undefined) {
      const admittedWorkflow = workflowGeneration;
      const admittedSession = menuGeneration;
      const hypaExecutables = await resolveHypaExecutablePaths(
        ctx.cwd,
        process.env.PATH,
        process.platform,
        process.env.HYPA_BIN,
      );
      if (
        admittedWorkflow !== workflowGeneration ||
        admittedSession !== menuGeneration ||
        !state.enabled ||
        !stateIsCurrent(ctx) ||
        !permittedTools?.has(event.toolName) ||
        command !== readCommand(event.input) ||
        ctx.signal?.aborted
      ) {
        return { block: true, reason: "Plan inspection authorization changed while resolving the executable." };
      }
      blocked = findBlockedCommandSegment(command, settings.safeSubcommands, { hypaExecutables });
    }
    if (blocked !== undefined) {
      return {
        block: true,
        reason: `Plan mode blocks bash commands outside its reviewed inspection policy or containing explicitly unsafe arguments.\nBlocked command: ${blocked}`,
      };
    }
  });

  pi.on("context", async (event, ctx) => {
    if (!stateIsCurrent(ctx)) {
      return { messages: inputOwnership.context(event.messages, ctx, workflowGeneration) as typeof event.messages };
    }
    // Tool registration may refresh Pi's loadout during a run. Reconcile at
    // every model response boundary, not only at before_agent_start.
    if (state.enabled) applyPlanModeTools();
    const messages = inputOwnership.context(event.messages, ctx, workflowGeneration, state.activeImplementation);
    invalidateReadyForAcceptedRevision(ctx);
    const result = implementationRetention.transformContext(
      messages,
      state,
      Boolean(inputOwnership.authorized(ctx, workflowGeneration)),
    );
    if (result.clearActiveImplementationId) {
      clearActiveImplementation(result.clearActiveImplementationId, ctx);
    }
    return { messages: result.messages as typeof event.messages };
  });

  pi.on("context_with_system", (event, ctx) => {
    if (!stateIsCurrent(ctx) || !state.enabled) return;
    // Pi declares a live loadout delta before context handlers run. Removing a
    // late registration from the runtime alone is too late for that request's
    // transcript; also filter its request-local declarations at this boundary.
    applyPlanModeTools();
    const active = new Set(safeGetActiveTools());
    return {
      messages: event.messages.map((message) =>
        message.role === "system" && message.toolsAdded
          ? { ...message, toolsAdded: message.toolsAdded.filter((tool) => active.has(tool.name)) }
          : message,
      ),
    };
  });

  pi.on("input", (event, ctx) => inputOwnership.input(event, ctx, workflowGeneration));
  pi.on("message_start", (event, ctx) => {
    const retired = inputOwnership.message(event.message, ctx, workflowGeneration);
    // Native acceptance supplies an operation context, unlike an input/command
    // barrier. Abort only this positively attributed stale extension delivery.
    if (retired && ctx.signal && !ctx.signal.aborted) ctx.abort();
    if (event.message.role === "user") invalidateReadyForAcceptedRevision(ctx);
  });

  function invalidateReadyForAcceptedRevision(ctx: ExtensionContext) {
    if (!stateIsCurrent(ctx) || !state.enabled || !inputOwnership.revisionStarted(ctx, workflowGeneration)) return;
    if (!state.latestPlan && !state.awaitingAction) return;
    readyPresentationIntent = undefined;
    state = { ...state, latestPlan: undefined, latestPlanSource: undefined, awaitingAction: false };
    persistState(ctx);
    updateUi(ctx);
  }

  pi.on("before_agent_start", (event, ctx) => {
    if (refreshStateBeforeFirstAgentStart) {
      // New-session setup may append authoritative destination state after
      // session_start. Rebuild it, never reuse the empty setup cache. A changed
      // manager/session/prefix still waits for its committed lifecycle handler.
      if (stateOrigin && !originIsCurrent(stateOrigin, ctx, false)) return;
      refreshStateBeforeFirstAgentStart = false;
      restoreState(ctx);
      implementationRetention.reset();
      implementationRetention.restore(state.activeImplementation);
      if (state.enabled) {
        activatePlanModeTools();
        applyPlanThinkingLevel();
      } else deactivatePlanModeQuestionTool();
      updateUi(ctx);
    }
    if (!stateIsCurrent(ctx) || !state.enabled) return;
    invalidateReadyForAcceptedRevision(ctx);
    applyPlanModeTools();
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildPlanModePrompt()}`,
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!stateIsCurrent(ctx) || !state.enabled || !inputOwnership.authorized(ctx, workflowGeneration)) return;

    // A queued revision may follow an unrelated assistant in the same run.
    // Never fall back through a final tool-only response to that older prose.
    const finalAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
    const text = latestAssistantText(finalAssistant ? [finalAssistant] : []);
    const parsedPlan = parseProposedPlan(text);
    if (parsedPlan.kind !== "valid") {
      if (parsedPlan.kind !== "absent") {
        ctx.ui.notify(invalidPlanMessage(parsedPlan.kind), "warning");
      }
      persistState(ctx);
      updateUi(ctx);
      return;
    }
    acceptCompletedPlan(parsedPlan.plan, "legacy_proposed_plan", ctx);
  });

  onAgentSettled(pi, async (_event, ctx) => {
    if (!stateIsCurrent(ctx)) {
      inputOwnership.settled();
      return;
    }
    inputOwnership.commitHandoffs(ctx, workflowGeneration);
    inputOwnership.settled();
    const settledImplementationId = implementationRetention.implementationSettled(state.activeImplementation);
    if (settledImplementationId) clearActiveImplementation(settledImplementationId, ctx);

    const intent = readyPresentationIntent;
    if (!intent || !readyPresentationIsCurrent(intent)) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

    readyPresentationIntent = undefined;
    try {
      if (intent.source === "legacy_proposed_plan") {
        pi.sendMessage(
          {
            customType: PROPOSED_PLAN_MESSAGE_TYPE,
            content: `**Proposed Plan**\n\n${intent.plan}`,
            display: true,
          },
          { triggerTurn: false },
        );
      }
      if (ctx.hasUI && completedPlanIsCurrent(intent)) {
        await planActions.showReady(latestCommandContext ?? ctx);
      }
    } catch (error: unknown) {
      if (!isStaleExtensionContextError(error)) throw error;
    }
  });

  function advanceWorkflow(retireOperation = true) {
    workflowGeneration += 1;
    inputOwnership.reset(retireOperation);
    workflowController.abort(new DOMException("Plan-mode workflow changed", "AbortError"));
    workflowController = new AbortController();
  }

  function enterPlanMode(ctx: ExtensionContext) {
    if (!stateIsCurrent(ctx)) return;
    inputOwnership.commitHandoffs(ctx, workflowGeneration);
    advanceWorkflow();
    if (!state.enabled) {
      previousTools = withoutRequiredPlanModeTools(safeGetActiveTools());
      permittedTools = undefined;
    }
    state = {
      ...state,
      enabled: true,
      awaitingAction: false,
      savedPlan: undefined,
      activeImplementation: undefined,
      modelHandoff: undefined,
    };
    activatePlanModeTools();
    applyPlanThinkingLevel();
    persistState(ctx);
    updateUi(ctx);
  }

  function enterPlanModeWithPrompt(prompt: string, ctx: ExtensionContext) {
    const previousState = state;
    const wasEnabled = state.enabled;
    enterPlanMode(ctx);
    if (!wasEnabled) {
      ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
    }
    if (sendPlanModeUserMessage(prompt, ctx)) return;
    if (!previousState.enabled) {
      restoreTools();
      restoreThinkingLevel();
    }
    state = previousState;
    persistState(ctx);
    updateUi(ctx);
  }

  function exitPlanMode(ctx: ExtensionContext) {
    if (!stateIsCurrent(ctx)) return;
    if (state.modelHandoff && rejectBusyModelRestore(ctx)) return;
    inputOwnership.commitHandoffs(ctx, workflowGeneration);
    advanceWorkflow();
    const wasEnabled = state.enabled;
    const handoff = state.modelHandoff;
    readyPresentationIntent = undefined;
    state = {
      ...state,
      enabled: false,
      latestPlan: undefined,
      latestPlanSource: undefined,
      awaitingAction: false,
      savedPlan: undefined,
      activeImplementation: undefined,
      manualThinkingLevel: undefined,
      modelHandoff: undefined,
    };
    if (wasEnabled) {
      restoreTools();
      restoreThinkingLevel();
      state = { ...state, manualThinkingLevel: undefined };
    }
    persistState(ctx);
    updateUi(ctx);
    return handoff ? finishModelHandoff(ctx, handoff).then(() => {}) : undefined;
  }

  /** End an outstanding implementation handoff before a new planning workflow starts. */
  function withPlanningModel(ctx: ExtensionContext, enter: () => void) {
    const handoff = state.modelHandoff;
    if (!handoff) {
      enter();
      return;
    }
    if (rejectBusyModelRestore(ctx)) return;
    const sessionGeneration = menuGeneration;
    const planWorkflowGeneration = workflowGeneration;
    state = { ...state, modelHandoff: undefined };
    persistState(ctx);
    return finishModelHandoff(ctx, handoff).then((restored) => {
      if (!restored || sessionGeneration !== menuGeneration || planWorkflowGeneration !== workflowGeneration) return;
      if (stateIsCurrent(ctx)) enter();
    });
  }

  function rejectBusyModelRestore(ctx: ExtensionContext) {
    if (ctx.isIdle()) return false;
    ctx.ui.notify("Planning model restoration deferred: session operation is busy; retry when idle.", "warning");
    return true;
  }

  async function finishModelHandoff(ctx: ExtensionContext, handoff: ImplementationModelHandoff) {
    const sessionGeneration = menuGeneration;
    const workflow = workflowGeneration;
    const selection = implementationModels.captureSelection(ctx, handoff.previousModel);
    const isCurrent = () =>
      sessionGeneration === menuGeneration &&
      workflow === workflowGeneration &&
      stateIsCurrent(ctx) &&
      selection.isCurrent();
    try {
      const outcome = await implementationModels.restore(ctx, handoff, isCurrent);
      if (!isCurrent() || outcome.kind === "obsolete") return false;
      if (outcome.kind === "busy") {
        // No physical mutation started. Keep the restore handoff for an idle
        // retry, including when a synchronous callback made the host busy.
        state = { ...state, modelHandoff: handoff };
        persistState(ctx);
        updateUi(ctx);
        ctx.ui.notify(outcome.message, "warning");
        return false;
      }
      if (outcome.kind === "unavailable") ctx.ui.notify(outcome.message, "warning");
      else if (outcome.kind === "restored") {
        if (outcome.message) ctx.ui.notify(outcome.message, "info");
        if (outcome.warning) ctx.ui.notify(outcome.warning, "warning");
      }
      return isCurrent();
    } catch (error: unknown) {
      if (!isCurrent() || isStaleExtensionContextError(error)) return false;
      const detail = error instanceof Error ? error.message : String(error);
      try {
        ctx.ui.notify(`Unable to restore the planning model: ${detail}`, "warning");
      } catch {
        // The context can become stale while Pi switches models.
      }
      return false;
    } finally {
      selection.release();
    }
  }

  async function applyImplementationModel(
    ctx: ExtensionContext,
    target: Extract<ImplementationModelTarget, { kind: "target" }>,
    rollBack: () => void,
  ) {
    const sessionGeneration = menuGeneration;
    const implementationWorkflow = workflowGeneration;
    const implementationId = state.activeImplementation?.id;
    const selection = implementationModels.captureSelection(ctx, target.model);
    const isCurrent = () =>
      sessionGeneration === menuGeneration &&
      implementationWorkflow === workflowGeneration &&
      stateIsCurrent(ctx) &&
      state.activeImplementation?.id === implementationId &&
      selection.isCurrent();
    try {
      const result = await implementationModels.apply(ctx, target, isCurrent);
      // An obsolete switch cannot compensate into a destination branch/workflow.
      if (!isCurrent() || result.kind === "obsolete") return false;
      if (result.kind === "failed") {
        ctx.ui.notify(
          `Unable to switch to the implementation model ${result.message}. Implementation was not started; the plan remains available.`,
          "warning",
        );
        rollBack();
        return false;
      }
      if (result.handoff) {
        state = {
          ...state,
          modelHandoff: result.handoff,
          modelHandoffBoundary: ctx.sessionManager.getBranch().at(-1)?.id,
        };
        persistState(ctx);
        updateUi(ctx);
        ctx.ui.notify(describeImplementationHandoff(result.handoff), "info");
      }
      if (result.warning) ctx.ui.notify(result.warning, "warning");
      return true;
    } finally {
      selection.release();
    }
  }

  function togglePlanMode(ctx: ExtensionContext) {
    if (!stateIsCurrent(ctx)) return;
    if (state.enabled) {
      ctx.ui.notify(planModeDisableNotification(), "info");
      return exitPlanMode(ctx);
    }
    if (savedPlanBlocksNewWorkflow(ctx, state.savedPlan !== undefined)) return;
    return withPlanningModel(ctx, () => {
      enterPlanMode(ctx);
      ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
    });
  }

  function planModeDisableNotification() {
    return state.activeImplementation
      ? "Active implementation plan cleared."
      : state.savedPlan
        ? "Saved plan cleared."
        : state.latestPlan
          ? "Plan mode disabled. Proposed plan discarded."
          : "Plan mode disabled.";
  }

  function sendPlanModeUserMessage(message: string, ctx: ExtensionContext) {
    try {
      const implementation = state.activeImplementation;
      const transport = inputOwnership.send(
        message,
        implementation ? { implementationId: implementation.id, plan: implementation.plan } : { revision: true },
        ctx,
        workflowGeneration,
      );
      if (ctx.isIdle()) pi.sendUserMessage(transport);
      else pi.sendUserMessage(transport, { deliverAs: "followUp" });
      return true;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Unable to send Plan-mode message: ${detail}`, "error");
      return false;
    }
  }

  function acceptCompletedPlan(plan: string, source: PlanCompletionSource, ctx: ExtensionContext) {
    const normalized = normalizePlanModeCompletion({ plan });
    if (!normalized.ok) {
      ctx.ui.notify(`Proposed plan is not ready: ${normalized.error}.`, "warning");
      persistState(ctx);
      updateUi(ctx);
      return;
    }
    if (
      state.enabled &&
      state.awaitingAction &&
      state.latestPlan === normalized.plan &&
      state.latestPlanSource === source
    ) {
      return;
    }
    state = {
      ...state,
      latestPlan: normalized.plan,
      latestPlanSource: source,
      awaitingAction: true,
    };
    readyPresentationIntent = {
      nonce: ++nextReadyPresentationNonce,
      plan: normalized.plan,
      source,
    };
    persistState(ctx);
    updateUi(ctx);
  }

  function completedPlanIsCurrent(intent: ReadyPresentationIntent) {
    return (
      state.enabled &&
      state.awaitingAction &&
      state.latestPlan === intent.plan &&
      state.latestPlanSource === intent.source
    );
  }

  function readyPresentationIsCurrent(intent: ReadyPresentationIntent) {
    return completedPlanIsCurrent(intent) && readyPresentationIntent?.nonce === intent.nonce;
  }

  function requestFinalPlan(ctx: ExtensionContext) {
    if (!state.enabled) {
      ctx.ui.notify("Plan mode is not active. Use /plan first.", "warning");
      return;
    }
    sendPlanModeUserMessage(
      "Finalize the current implementation plan now. If any material decision remains, use plan_mode_question instead. Otherwise call plan_mode_complete alone as your final action with the complete decision-ready plan.",
      ctx,
    );
  }

  function savePlanForLater(ctx: ExtensionContext) {
    const plan = state.enabled ? state.latestPlan?.trim() : undefined;
    if (!plan) {
      const message = "No completed plan is available to save.";
      if (!ctx.hasUI) throw new Error(message);
      ctx.ui.notify(message, "warning");
      return;
    }
    const source = state.latestPlanSource ?? "legacy_proposed_plan";

    advanceWorkflow();
    readyPresentationIntent = undefined;
    state = {
      ...state,
      enabled: false,
      latestPlan: undefined,
      latestPlanSource: undefined,
      awaitingAction: false,
      savedPlan: { plan, source },
      activeImplementation: undefined,
      manualThinkingLevel: undefined,
    };
    restoreTools();
    restoreThinkingLevel();
    state = { ...state, manualThinkingLevel: undefined };
    persistState(ctx);
    updateUi(ctx);
    ctx.ui.notify("Plan saved for later. Plan mode disabled.", "info");
  }

  async function startFreshImplementation(ctx: ExtensionContext, menuIsCurrent: () => boolean) {
    await startFreshImplementationFromState(ctx, {
      getState: () => state,
      menuIsCurrent,
      retention: configuredImplementationPlanRetention(settings),
      stateEntryType: STATE_ENTRY_TYPE,
      registerHandoff: (message, implementationId, plan, replacementCtx) =>
        inputOwnership.send(message, { implementationId, plan }, replacementCtx, workflowGeneration),
    });
  }

  async function startImplementation(ctx: ExtensionContext) {
    if (!stateIsCurrent(ctx)) return;
    const origin = captureStateOrigin(ctx);
    const savedPlan = state.enabled ? undefined : state.savedPlan;
    if (savedPlan) {
      const sessionGeneration = menuGeneration;
      const planWorkflowGeneration = workflowGeneration;
      const isCurrent = () =>
        originIsCurrent(origin, ctx) &&
        sessionGeneration === menuGeneration &&
        planWorkflowGeneration === workflowGeneration &&
        !menuController.signal.aborted &&
        !state.enabled &&
        state.savedPlan === savedPlan;
      if (!(await preflightSavedPlanImplementation(ctx, isCurrent))) return;
    }
    const plan = (state.enabled ? state.latestPlan : savedPlan?.plan)?.trim();
    const source = (state.enabled ? state.latestPlanSource : savedPlan?.source) ?? "legacy_proposed_plan";
    if (!plan) {
      ctx.ui.notify("Plan mode disabled. No proposed plan is available to implement.", "warning");
      return;
    }
    const modelTarget = implementationModels.resolve(ctx, settings);
    if (modelTarget.kind === "unavailable") {
      ctx.ui.notify(`${modelTarget.message} Implementation was not started; the plan remains available.`, "warning");
      return;
    }

    if (modelTarget.kind === "target" && !ctx.isIdle()) {
      ctx.ui.notify(
        "Implementation model switch deferred: session operation is busy; retry when idle. The plan remains available.",
        "warning",
      );
      return;
    }

    advanceWorkflow();
    const previousState = state;
    const wasEnabled = state.enabled;
    readyPresentationIntent = undefined;
    state = {
      ...state,
      enabled: false,
      latestPlan: undefined,
      latestPlanSource: undefined,
      awaitingAction: false,
      savedPlan: undefined,
      activeImplementation: {
        id: randomUUID(),
        plan,
        source,
        startedAt: Date.now(),
        retention: configuredImplementationPlanRetention(settings),
      },
      manualThinkingLevel: undefined,
    };
    if (wasEnabled) {
      restoreTools();
      restoreThinkingLevel();
      state = { ...state, manualThinkingLevel: undefined };
    }
    persistState(ctx);
    updateUi(ctx);

    const rollBack = () => {
      if (savedPlan) {
        state = previousState;
      } else {
        enterPlanMode(ctx);
        state = previousState;
        applyPlanThinkingLevel();
      }
      persistState(ctx);
      updateUi(ctx);
    };
    // Switch only after Plan thinking is restored, so Pi's model-switch thinking
    // change is never mistaken for a manual Plan-mode choice.
    if (modelTarget.kind === "target" && !(await applyImplementationModel(ctx, modelTarget, rollBack))) return;
    const sent = sendPlanModeUserMessage(formatImplementationHandoff(plan), ctx);
    if (!sent) {
      const handoff = state.modelHandoff;
      if (handoff) {
        const sessionGeneration = menuGeneration;
        state = { ...state, modelHandoff: undefined };
        const restored = await finishModelHandoff(ctx, handoff);
        if (!restored || sessionGeneration !== menuGeneration) return;
      }
      rollBack();
    }
  }

  function clearActiveImplementation(id: string, ctx: ExtensionContext) {
    if (state.activeImplementation?.id !== id) return false;
    // Automatic retention cleanup retires future guidance, not the already
    // accepted implementation request receiving its first context.
    advanceWorkflow(false);
    state = { ...state, activeImplementation: undefined };
    persistState(ctx);
    updateUi(ctx);
    return true;
  }

  async function showLaunchMenu(ctx: ExtensionContext, initialScreen: "main" | "tools" = "main") {
    const lifecycle = captureMenuLifecycle();
    if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
    const ui = await loadInteractiveUi();
    if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
    const tools = selectableTools();
    await ui.showPlanLaunchMenu(ctx, {
      statusText: "Status: Off — normal tools are active.",
      initialScreen,
      getSelectedNames: () => snapshotPlanModeSelectedNames(tools, toolSelectionSnapshot()),
      toolSummary: (selectedNames) =>
        `When started: ${snapshotPlanModeToolNames(tools, selectedNames, toolSelectionSnapshot()).join(", ")}`,
      tools: tools.map((tool) => {
        const selectable = canSelectToolInPlanMode(tool);
        const policy = toolPolicyLabel(tool);
        const description = tool.description ?? "No description available";
        return {
          name: tool.name,
          description: `${policy} · ${description}`,
          searchText: [policy, description].join(" "),
          disabled: !selectable,
          disabledReason: selectable ? undefined : "Blocked by Plan-mode policy",
        };
      }),
      ...lifecycle,
      start: (signal) => {
        if (signal.aborted || !lifecycle.isCurrent()) return;
        return withPlanningModel(ctx, () => {
          enterPlanMode(ctx);
          ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
        });
      },
      startWithTools: (names, signal) => {
        if (signal.aborted || !lifecycle.isCurrent()) return;
        state = {
          ...state,
          selectedToolNames: filterAvailableSelectedToolNames(names, tools),
          selectedToolKeys: undefined,
        };
        return withPlanningModel(ctx, () => {
          enterPlanMode(ctx);
          ctx.ui.notify("Plan mode enabled with the selected tools.", "info");
        });
      },
      settings: (signal) => showSettings(ctx, signal, lifecycle.isCurrent),
    });
  }

  async function showActivePlanMenu(ctx: ExtensionContext) {
    if (!ctx.hasUI) {
      ctx.ui.notify(planStatusText(), "info");
      return;
    }
    const lifecycle = captureMenuLifecycle();
    if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
    const ui = await loadInteractiveUi();
    if (!lifecycle.isCurrent() || lifecycle.signal.aborted) return;
    await ui.showActiveImplementationMenu(ctx, {
      statusText: planStatusText(),
      getExportDestination: () => planExports.getDestination(ctx),
      signal: lifecycle.signal,
      isCurrent: lifecycle.isCurrent,
      show: () => showStoredPlan(pi, ctx, state),
      exportPlan: (path, signal) => planExports.export(path, ctx, signal, lifecycle.isCurrent),
      settings: (signal) => showSettings(ctx, signal, lifecycle.isCurrent),
      startNew: () =>
        withPlanningModel(ctx, () => {
          enterPlanMode(ctx);
          ctx.ui.notify("Plan mode enabled. I will explore and plan, but not modify files.", "info");
        }),
      clear: () => {
        const restoring = exitPlanMode(ctx);
        ctx.ui.notify("Active implementation plan cleared.", "info");
        return restoring;
      },
    });
  }

  async function showSettings(ctx: ExtensionContext, signal: AbortSignal, isCurrent: () => boolean) {
    if (!isCurrent() || signal.aborted) return false;
    const ui = await loadInteractiveUi();
    if (!isCurrent() || signal.aborted) return false;
    const result = await ui.showPlanModeSettings(ctx, {
      tools: selectableTools(),
      signal,
      isCurrent,
      settingsPath: dependencies.settingsPath,
      onSaved: (saved) => {
        if (isCurrent()) {
          settings = saved;
          applyPlanModeShortcut(configuredPlanModeToggleShortcut(saved));
        }
      },
      ...(dependencies.readSettings
        ? { readSettings: async () => dependencies.readSettings?.() ?? { kind: "missing" } }
        : {}),
    });
    return result.kind === "closed" && "reason" in result && result.reason === "close";
  }

  function captureMenuLifecycle() {
    const sessionGeneration = menuGeneration;
    const planWorkflowGeneration = workflowGeneration;
    const controller = menuController;
    const origin = stateOrigin;
    return {
      signal: controller.signal,
      isCurrent: () =>
        (!origin || originIsCurrent(origin, { sessionManager: origin.manager })) &&
        sessionGeneration === menuGeneration &&
        planWorkflowGeneration === workflowGeneration &&
        !controller.signal.aborted,
    };
  }

  function activatePlanModeTools() {
    previousTools ??= withoutRequiredPlanModeTools(safeGetActiveTools());
    permittedTools ??= new Set(planModeToolNames());
    applyPlanModeTools();
  }

  function applyPlanModeTools() {
    pi.setActiveTools(
      Array.from(permittedTools ?? []).filter((name) => {
        const tool = toolByName(name);
        return !tool || canSelectToolInPlanMode(tool);
      }),
    );
  }

  function planModeToolNames() {
    const tools = selectableTools();
    if (
      tools.length === 0 &&
      state.selectedToolNames === undefined &&
      state.selectedToolKeys === undefined &&
      settings.defaultPlanTools === undefined
    ) {
      return ["read", "bash", PLAN_MODE_QUESTION_TOOL_NAME, PLAN_MODE_COMPLETE_TOOL_NAME];
    }

    const selectedNames = snapshotPlanModeSelectedNames(tools, toolSelectionSnapshot());
    return withRequiredPlanModeTools(
      tools.filter((tool) => selectedNames.has(tool.name) && canSelectToolInPlanMode(tool)).map((tool) => tool.name),
    );
  }

  function toolSelectionSnapshot() {
    return {
      selectedToolNames: state.selectedToolNames,
      selectedToolKeys: state.selectedToolKeys,
      defaultPlanTools: settings.defaultPlanTools,
    };
  }

  function selectableTools() {
    return safeGetAllTools()
      .filter((tool) => tool.name !== PLAN_MODE_QUESTION_TOOL_NAME && tool.name !== PLAN_MODE_COMPLETE_TOOL_NAME)
      .sort(compareTools);
  }

  function safeGetAllTools() {
    try {
      return pi.getAllTools();
    } catch {
      return [];
    }
  }

  function restoreTools() {
    const restoredTools = previousTools ?? DEFAULT_TOOLS;
    pi.setActiveTools(withoutRequiredPlanModeTools(restoredTools));
    previousTools = undefined;
    permittedTools = undefined;
  }

  function setOwnedThinkingLevel(level: Parameters<typeof setPlanThinkingLevel>[1]) {
    const change = { previousLevel: pi.getThinkingLevel(), level: String(level) };
    if (change.previousLevel === level) return;
    ownedThinkingChanges.push(change);
    settingOwnedThinking = true;
    try {
      setPlanThinkingLevel(pi, level);
      change.level = pi.getThinkingLevel();
    } finally {
      settingOwnedThinking = false;
      if (change.level === change.previousLevel) {
        const index = ownedThinkingChanges.indexOf(change);
        if (index >= 0) ownedThinkingChanges.splice(index, 1);
      }
    }
  }

  function applyPlanThinkingLevel() {
    if (state.manualThinkingLevel) {
      if (pi.getThinkingLevel() !== state.manualThinkingLevel) {
        setOwnedThinkingLevel(state.manualThinkingLevel);
      }
      return;
    }
    const configured = configuredThinkingLevel(settings);
    if (!configured) {
      state = {
        ...state,
        previousThinkingLevel: undefined,
        appliedThinkingLevel: undefined,
      };
      return;
    }
    const current = pi.getThinkingLevel();
    if (!state.appliedThinkingLevel) state.previousThinkingLevel = current;
    if (current !== configured) setOwnedThinkingLevel(configured);
    state.appliedThinkingLevel = pi.getThinkingLevel();
  }

  function captureManualThinkingLevel() {
    if (!state.appliedThinkingLevel) return;
    const current = pi.getThinkingLevel();
    if (current === state.appliedThinkingLevel) return;
    state = {
      ...state,
      manualThinkingLevel: current,
      previousThinkingLevel: undefined,
      appliedThinkingLevel: undefined,
    };
  }

  function restoreThinkingLevel() {
    captureManualThinkingLevel();
    const { appliedThinkingLevel, previousThinkingLevel } = state;
    if (appliedThinkingLevel && previousThinkingLevel && pi.getThinkingLevel() === appliedThinkingLevel) {
      setOwnedThinkingLevel(previousThinkingLevel);
    }
    state = { ...state, appliedThinkingLevel: undefined, previousThinkingLevel: undefined };
  }

  function deactivatePlanModeQuestionTool() {
    const activeTools = safeGetActiveTools();
    const filteredTools = withoutRequiredPlanModeTools(activeTools);
    if (filteredTools.length !== activeTools.length) {
      pi.setActiveTools(filteredTools);
    }
  }

  function safeGetActiveTools() {
    try {
      return pi.getActiveTools();
    } catch {
      return DEFAULT_TOOLS;
    }
  }

  function reconcileModelHandoff(ctx: ExtensionContext) {
    let handoff = state.modelHandoff;
    if (!handoff) return;
    const branch = ctx.sessionManager.getBranch();
    const boundary = state.modelHandoffBoundary
      ? branch.findIndex((entry) => entry.id === state.modelHandoffBoundary)
      : -1;
    // Older handoffs have no provable native publication boundary. Do not
    // infer thinking provenance from timestamps or callback arrival. Retain
    // only model ownership, and anchor all future selection auditing now.
    if (boundary < 0) {
      const {
        previousThinkingLevel: _previous,
        appliedThinkingLevel: _applied,
        thinkingModel: _model,
        ...remaining
      } = handoff;
      handoff = remaining.appliedModel ? remaining : undefined;
      state = {
        ...state,
        modelHandoff: handoff,
        modelHandoffBoundary: branch.at(-1)?.id,
      };
      persistState(ctx);
      if (!handoff) return;
    }
    const later = boundary >= 0 ? branch.slice(boundary + 1) : [];
    const model = handoff.appliedModel ?? handoff.thinkingModel;
    if (!model || !ctx.model || !sameModel(ctx.model, model) || later.some((entry) => entry.type === "model_change")) {
      state = { ...state, modelHandoff: undefined, modelHandoffBoundary: undefined };
      persistState(ctx);
    } else if (handoff.appliedThinkingLevel && later.some((entry) => entry.type === "thinking_level_change")) {
      const {
        previousThinkingLevel: _previous,
        appliedThinkingLevel: _applied,
        thinkingModel: _model,
        ...remaining
      } = handoff;
      state = { ...state, modelHandoff: remaining.appliedModel ? remaining : undefined };
      persistState(ctx);
    }
  }

  function restoreState(ctx: ExtensionContext) {
    state = restorePlanModeState(ctx.sessionManager.getBranch(), STATE_ENTRY_TYPE);
    fingerprints.clear();
    stateOrigin = captureStateOrigin(ctx);
    reconcileModelHandoff(ctx);
  }

  function updateUi(ctx: ExtensionContext) {
    updatePlanModeUi(ctx, state, formatToolSummary);
  }

  function clearUi(ctx: ExtensionContext) {
    clearPlanModeUi(ctx);
  }

  function planStatusText() {
    return formatPlanModeStatusText(state, formatToolSummary);
  }

  function implementationOutcome() {
    return implementationRetentionPreview(configuredImplementationPlanRetention(settings));
  }

  function formatToolSummary() {
    const names = state.enabled ? Array.from(permittedTools ?? []) : planModeToolNames();
    return `Tools: ${names.length > 0 ? names.join(", ") : "none"}`;
  }

  function toolByName(toolName: string) {
    return safeGetAllTools().find((candidate) => candidate.name === toolName);
  }
}

export { completePlanArguments } from "./command.js";
export {
  extractProposedPlan,
  latestAssistantText,
  parseProposedPlan,
  stripProposedPlanBlocks,
  stripProposedPlanBlocksFromMessage,
} from "./message-transform.js";
export { buildPlanModePrompt } from "./prompt.js";
export { normalizePlanModeQuestionParams } from "./question-tool.js";
export { withoutPlanModeQuestionTool, withRequiredPlanModeTools } from "./required-tools.js";
export { normalizePlanModeSettings, readPlanModeSettings } from "./settings.js";
export { canSelectToolInPlanMode, classifyPlanModeTool, isSafeCommand } from "./tool-policy.js";
