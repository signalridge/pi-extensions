import * as piAi from "@earendil-works/pi-ai";
import {
  type Api,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { MenuContext, RunMenuResult } from "@narumitw/pi-tui-kit";
import { wrapCustomUi } from "@signalridge/pi-ui";
import {
  type BtwBringToMainSegment,
  type BtwBringToMainSummary,
  BtwTextRangeSelector,
  type BtwTextRangeSelectorState,
  buildQuickBringToMainSegments,
  estimateBringToMainTokens,
  formatBtwBringToMain,
  getAnsweredTurns,
  summarizeBringToMain,
} from "./bring-to-main.js";
import { type RunBtwFullscreen, runBtwFullscreen } from "./fullscreen-ui.js";
import {
  type BtwCommandMenuResult,
  type BtwResumeThreadSummary,
  runBtwMenuPreservingEditor,
  showBtwCommandMenu,
} from "./menu.js";
import {
  type BtwSettings,
  effectiveRememberThinkingLevelChanges,
  parseBtwModelReference,
  readBtwSettings,
  updateBtwSettings,
} from "./settings.js";
import {
  BTW_THINKING_LEVELS,
  type BtwThinkingLevel,
  bindSideThreadToModel,
  type CompleteSimpleFunction,
  canSendSideThreadToModel,
  completeSideThreadTurn,
  createSideThread,
  type SideQuestionAuth,
  type SideThread,
  sideThreadDestinationError,
} from "./side-thread.js";
import { sanitizeSingleLine } from "./text.js";
import {
  BtwAnsweringView,
  type BtwThinkingControl,
  BtwTranscriptPager,
  type TranscriptPagerAction,
} from "./transcript-pager.js";

export {
  BTW_SETTINGS_FILE,
  type BtwSettings,
  type BtwSettingsLoadResult,
  normalizeBtwSettings,
  parseBtwModelReference,
  readBtwSettings,
} from "./settings.js";
export {
  BTW_THINKING_LEVELS,
  type BtwThinkingLevel,
  buildUserPrompt,
  completeSideQuestion,
} from "./side-thread.js";
export { sanitizeSingleLine } from "./text.js";

const MAX_CONTEXT_CHARS = 40_000;

interface LoadBtwThinkingLevelOptions {
  settingsPath?: string;
  warn?: (message: string) => void;
}

type BtwModelRegistry = Pick<ExtensionCommandContext["modelRegistry"], "find" | "getApiKeyAndHeaders">;

type BtwProviderRegistry = Pick<ExtensionCommandContext["modelRegistry"], "getProvider"> &
  Partial<Pick<ExtensionCommandContext["modelRegistry"], "streamSimple">>;

function isVirtualBtwModel(model: Model<Api>): boolean {
  return model.api === "pi-virtual";
}

export function createModelRegistryCompleteSimple(
  modelRegistry: BtwProviderRegistry,
  aiCapabilities: Partial<Pick<typeof piAi, "normalizeContext">> = piAi,
): CompleteSimpleFunction {
  return async (model, context, options) => {
    if (isVirtualBtwModel(model)) {
      if (typeof modelRegistry.streamSimple !== "function") {
        throw new Error("Virtual /btw models require Pi's ModelRegistry.streamSimple route (Pi 0.99.1 or newer).");
      }
      // Pi routes the virtual selection to a physical model and resolves that
      // provider's credentials at request time. Keep the original Context so
      // the registry can normalize it before dispatch.
      return modelRegistry.streamSimple(model, context, options).result();
    }
    const provider = modelRegistry.getProvider(model.provider);
    if (!provider) throw new Error(`No provider registered for model provider: ${model.provider}`);
    // Older Pi hosts accept the original Context; 0.87+ providers require the
    // normalized transcript. Keep the direct provider call so Pi's already-resolved
    // request endpoint and credentials are not resolved again by the registry.
    const providerContext =
      typeof aiCapabilities.normalizeContext === "function"
        ? aiCapabilities.normalizeContext(context)
        : (context as TranscriptContext);
    return provider.streamSimple(model, providerContext, options).result();
  };
}

interface ResolveBtwModelOptions {
  settings: BtwSettings;
  currentModel: Model<Api> | undefined;
  modelRegistry: BtwModelRegistry;
  warn?: (message: string) => void;
}

export interface ResolvedBtwModel {
  model: Model<Api>;
  auth: SideQuestionAuth;
  /** An auth-resolved endpoint differs from the registered model destination. */
  endpointOverridden?: boolean;
}

export interface BtwThreadState {
  id: string;
  title?: string;
  thread: SideThread;
  thinkingLevel: BtwThinkingLevel;
  createdAt: number;
  updatedAt: number;
  activitySequence?: number;
}

export async function resolveBtwModel({
  settings,
  currentModel,
  modelRegistry,
  warn,
}: ResolveBtwModelOptions): Promise<ResolvedBtwModel | undefined> {
  const reportWarning = (message: string) => warn?.(sanitizeSingleLine(message));
  if (settings.model) {
    const fallback = currentModel ? `${currentModel.provider}/${currentModel.id}` : "the current model";
    const reference = parseBtwModelReference(settings.model);
    if (!reference) {
      reportWarning(`pi-btw model ${settings.model} is invalid; falling back to ${fallback}.`);
      return resolveBtwModel({ settings: {}, currentModel, modelRegistry, warn: reportWarning });
    }
    const configuredModel = modelRegistry.find(reference.provider, reference.modelId);
    if (!configuredModel) {
      reportWarning(`pi-btw model ${settings.model} was not found; falling back to ${fallback}.`);
    } else {
      const sameAsCurrent =
        configuredModel === currentModel ||
        (configuredModel.provider === currentModel?.provider && configuredModel.id === currentModel.id);
      const fallbackAction = sameAsCurrent ? "no distinct current model is available" : `falling back to ${fallback}`;
      if (isVirtualBtwModel(configuredModel)) return { model: configuredModel, auth: {} };
      try {
        const auth = await modelRegistry.getApiKeyAndHeaders(configuredModel);
        if (auth.ok) return resolvedPhysicalBtwModel(configuredModel, auth);
        const reason = auth.error;
        reportWarning(`pi-btw model ${settings.model} is unavailable (${reason}); ${fallbackAction}.`);
      } catch (error: unknown) {
        reportWarning(`pi-btw model ${settings.model} credentials failed (${formatError(error)}); ${fallbackAction}.`);
      }
      if (sameAsCurrent) return undefined;
    }
  }

  if (!currentModel) return undefined;
  if (isVirtualBtwModel(currentModel)) return { model: currentModel, auth: {} };
  try {
    const auth = await modelRegistry.getApiKeyAndHeaders(currentModel);
    if (auth.ok) return resolvedPhysicalBtwModel(currentModel, auth);
  } catch {
    // The caller reports the final lack of an available model.
  }
  return undefined;
}

function resolvedPhysicalBtwModel(model: Model<Api>, auth: SideQuestionAuth): ResolvedBtwModel {
  return {
    model: auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
    auth,
    endpointOverridden: Boolean(auth.baseUrl && auth.baseUrl !== model.baseUrl),
  };
}

function effectiveSideModel(selected: ResolvedBtwModel): Model<Api> {
  return selected.auth.baseUrl ? { ...selected.model, baseUrl: selected.auth.baseUrl } : selected.model;
}

export async function loadBtwThinkingLevel(
  currentThinkingLevel: BtwThinkingLevel,
  options: LoadBtwThinkingLevelOptions = {},
): Promise<BtwThinkingLevel> {
  const settings = await readBtwSettings(options.settingsPath);
  if (settings.kind === "missing") return currentThinkingLevel;
  if (settings.kind === "loaded") {
    return settings.settings.thinkingLevel ?? currentThinkingLevel;
  }

  options.warn?.(
    sanitizeSingleLine(
      `pi-btw settings ignored: ${settings.reason}; expected optional model "provider/model-id", thinkingLevel "${BTW_THINKING_LEVELS.join('" | "')}", and boolean rememberThinkingLevelChanges. Using current Pi thinking level.`,
    ),
  );
  return currentThinkingLevel;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notifySafely(
  ctx: ExtensionCommandContext,
  message: string,
  level: Parameters<ExtensionCommandContext["ui"]["notify"]>[1],
): void {
  try {
    ctx.ui.notify(sanitizeSingleLine(message), level);
  } catch {
    // Async command continuations may finish after their ExtensionContext is replaced.
  }
}

export interface BtwExtensionDependencies {
  showCommandMenu?: (
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    resumeThreads: readonly BtwResumeThreadSummary[],
    isSessionCurrent?: () => boolean,
    registerClose?: (close: () => void) => () => void,
  ) => Promise<BtwCommandMenuResult>;
  loadSettings?: typeof loadSettingsForCommand;
  resolveModel?: typeof resolveBtwModelWithLoader;
  runThread?: typeof runBtwThread;
  runFullscreen?: RunBtwFullscreen;
}

export default function btw(pi: ExtensionAPI, dependencies: BtwExtensionDependencies = {}) {
  const showCommandMenu = dependencies.showCommandMenu ?? showCommandMenuForBtw;
  const loadSettings = dependencies.loadSettings ?? loadSettingsForCommand;
  const resolveModel = dependencies.resolveModel ?? resolveBtwModelWithLoader;
  const runThread = dependencies.runThread ?? runBtwThread;
  const runFullscreen = dependencies.runFullscreen ?? runBtwFullscreen;
  // Pi creates a fresh extension instance after session replacement or reload.
  const resumableThreads = new Map<string, BtwThreadState>();
  const busyThreadIds = new Set<string>();
  let nextThreadNumber = 1;
  let activitySequence = 0;

  let activeSessionManager: ExtensionCommandContext["sessionManager"] | undefined;
  let activeSessionId: string | undefined;
  let sessionGeneration = 0;
  let closeActiveMenu: (() => void) | undefined;
  const closeActiveFullscreens = new Set<() => void>();
  const closeMenuBeforeBoundary = (ctx: { sessionManager: ExtensionCommandContext["sessionManager"] }) => {
    if (activeSessionManager === ctx.sessionManager) closeActiveMenu?.();
  };
  const closeFullscreenOnCommit = (ctx: { sessionManager: ExtensionCommandContext["sessionManager"] }) => {
    if (activeSessionManager !== ctx.sessionManager) return;
    for (const close of closeActiveFullscreens) close();
  };
  const resetThreads = (): void => {
    resumableThreads.clear();
    busyThreadIds.clear();
    nextThreadNumber = 1;
    activitySequence = 0;
  };
  const bindSession = (ctx: { sessionManager: ExtensionCommandContext["sessionManager"] }): void => {
    const sessionId = ctx.sessionManager.getSessionId?.();
    if (activeSessionManager === ctx.sessionManager && activeSessionId === sessionId) return;
    resetThreads();
    activeSessionManager = ctx.sessionManager;
    activeSessionId = sessionId;
    sessionGeneration += 1;
  };

  pi.on("session_start", (_event, ctx) => bindSession(ctx));
  // Pi restores the saved editor synchronously when custom UI closes. Closing
  // at session_tree is too late: a branch may already own that same editor.
  pi.on("session_before_switch", (_event, ctx) => closeMenuBeforeBoundary(ctx));
  pi.on("session_before_tree", (_event, ctx) => closeMenuBeforeBoundary(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (activeSessionManager !== ctx.sessionManager) return;
    closeMenuBeforeBoundary(ctx);
    closeFullscreenOnCommit(ctx);
    resetThreads();
    activeSessionManager = undefined;
    activeSessionId = undefined;
    sessionGeneration += 1;
  });
  pi.on("session_tree", (_event, ctx) => {
    if (activeSessionManager !== ctx.sessionManager) {
      bindSession(ctx);
      return;
    }
    closeFullscreenOnCommit(ctx);
    resetThreads();
    sessionGeneration += 1;
  });
  const listResumeThreads = (): BtwResumeThreadSummary[] =>
    [...resumableThreads.values()]
      .filter((state) => !busyThreadIds.has(state.id) && state.thread.turns.length > 0 && state.title)
      .sort(
        (first, second) =>
          (second.activitySequence ?? 0) - (first.activitySequence ?? 0) || second.id.localeCompare(first.id),
      )
      .map((state) => ({
        id: state.id,
        title: state.title ?? "Untitled side thread",
        questionCount: state.thread.turns.length,
      }));
  pi.registerCommand("btw", {
    description: "Ask a quick side question without adding it to the main conversation",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/btw requires interactive TUI mode", "error");
        return;
      }

      bindSession(ctx);
      const commandSessionManager = ctx.sessionManager;
      const commandSessionId = commandSessionManager.getSessionId?.();
      const commandGeneration = sessionGeneration;
      const ownsCommandSession = () =>
        commandGeneration === sessionGeneration &&
        activeSessionManager === commandSessionManager &&
        commandSessionManager.getSessionId?.() === commandSessionId;

      let menuResult: BtwCommandMenuResult = "start";
      if (!question) {
        const registerClose = (close: () => void) => {
          if (!ownsCommandSession()) close();
          else closeActiveMenu = close;
          return () => {
            if (closeActiveMenu === close) closeActiveMenu = undefined;
          };
        };
        menuResult = await showCommandMenu(pi, ctx, listResumeThreads(), ownsCommandSession, registerClose);
        if (!ownsCommandSession() || menuResult === "closed") return;
      }

      const resumeThreadId = typeof menuResult === "object" && menuResult !== null ? menuResult.threadId : undefined;
      let state: BtwThreadState | undefined;
      let leasedThreadId: string;
      if (resumeThreadId !== undefined) {
        state = resumableThreads.get(resumeThreadId);
        if (!state) {
          notifySafely(ctx, "The selected /btw side thread is no longer available", "warning");
          return;
        }
        if (busyThreadIds.has(resumeThreadId)) {
          notifySafely(ctx, "The selected /btw side thread is already active", "warning");
          return;
        }
        leasedThreadId = resumeThreadId;
      } else {
        leasedThreadId = `btw-${nextThreadNumber}`;
        nextThreadNumber += 1;
      }
      busyThreadIds.add(leasedThreadId);
      const startingTurnCount = state?.thread.turns.length ?? 0;

      try {
        const settings = await loadSettings(ctx);
        if (!ownsCommandSession()) return;
        const resolution = await resolveModel(settings, ctx);
        if (!ownsCommandSession()) return;
        if (resolution.kind === "cancelled") {
          notifySafely(ctx, "Cancelled", "info");
          return;
        }
        if (resolution.kind === "unavailable") {
          notifySafely(ctx, "No available model for /btw", "error");
          return;
        }

        const registerFullscreenClose = (close: () => void) => {
          if (!ownsCommandSession()) close();
          else closeActiveFullscreens.add(close);
          return () => closeActiveFullscreens.delete(close);
        };
        await runFullscreen(
          ctx,
          (fullscreenCtx) => {
            if (!ownsCommandSession()) return Promise.resolve({ kind: "closed" } as const);
            if (!state) {
              const createdAt = Date.now();
              state = {
                id: leasedThreadId,
                thread: createSideThread(),
                thinkingLevel: settings.thinkingLevel ?? pi.getThinkingLevel(),
                createdAt,
                updatedAt: createdAt,
                activitySequence: 0,
              };
            }
            return runThread({
              initialQuestion: question || undefined,
              selected: resolution.selected,
              thinkingLevel: state.thinkingLevel,
              rememberThinkingLevelChanges: effectiveRememberThinkingLevelChanges(settings),
              state,
              ctx: fullscreenCtx,
              isSessionCurrent: ownsCommandSession,
            });
          },
          { isSessionCurrent: ownsCommandSession, registerClose: registerFullscreenClose },
        );
      } catch (error) {
        if (ownsCommandSession()) throw error;
        // A committed boundary closes Pi's custom UI before its new editor is
        // populated; its disposed side thread is no longer this command's error.
      } finally {
        // A side-thread turn may settle after Pi replaced the session. Never let
        // that stale continuation delete a new session's lease or repopulate its
        // resume menu with conversation state from the previous session.
        if (ownsCommandSession()) {
          busyThreadIds.delete(leasedThreadId);
          if (state?.title && state.thread.turns.length > 0) {
            if (state.thread.turns.length > startingTurnCount) {
              state.activitySequence = ++activitySequence;
            }
            resumableThreads.set(state.id, state);
          }
        }
      }
    },
  });
}

async function showCommandMenuForBtw(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  resumeThreads: readonly BtwResumeThreadSummary[],
  isSessionCurrent?: () => boolean,
  registerClose?: (close: () => void) => () => void,
): Promise<BtwCommandMenuResult> {
  const currentModel = ctx.model;
  const availableModels = ctx.modelRegistry.getAll();
  const currentThinkingLevel = pi.getThinkingLevel();
  const loaded = await readBtwSettings();
  if (isSessionCurrent && !isSessionCurrent()) return "closed";
  const settings = loaded.kind === "loaded" ? loaded.settings : {};
  const configured = settings.model ? parseBtwModelReference(settings.model) : undefined;
  const configuredModel = configured
    ? availableModels.find((model) => model.provider === configured.provider && model.id === configured.modelId)
    : undefined;
  const model = configuredModel ?? currentModel;
  return showBtwCommandMenu(ctx, {
    currentThinkingLevel,
    availableThinkingLevels: model ? getSupportedThinkingLevels(model) : BTW_THINKING_LEVELS,
    resumeThreads,
    isSessionCurrent,
    registerClose,
  });
}

async function loadSettingsForCommand(ctx: ExtensionCommandContext): Promise<BtwSettings> {
  const settingsResult = await readBtwSettings();
  if (settingsResult.kind === "loaded") return settingsResult.settings;
  if (settingsResult.kind === "invalid") {
    notifySafely(ctx, `pi-btw settings ignored: ${settingsResult.reason}`, "warning");
  }
  return {};
}

type ModelResolutionOutcome =
  | { kind: "cancelled" }
  | { kind: "unavailable" }
  | { kind: "selected"; selected: ResolvedBtwModel };

async function resolveBtwModelWithLoader(
  settings: BtwSettings,
  ctx: ExtensionCommandContext,
): Promise<ModelResolutionOutcome> {
  return wrapCustomUi(ctx.ui).custom<ModelResolutionOutcome>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, "Resolving /btw model credentials...");
    let settled = false;
    loader.onAbort = () => {
      if (settled) return;
      settled = true;
      done({ kind: "cancelled" });
    };

    resolveBtwModel({
      settings,
      currentModel: ctx.model,
      modelRegistry: ctx.modelRegistry,
      warn: (message) => {
        if (!settled) notifySafely(ctx, message, "warning");
      },
    })
      .then((selected) => {
        if (settled) return;
        settled = true;
        done(selected ? { kind: "selected", selected } : { kind: "unavailable" });
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        done({ kind: "unavailable" });
      });

    return loader;
  });
}

interface RunBtwThreadDependencies {
  ask?: typeof askThreadQuestion;
  interact?: typeof showThreadComposer;
  chooseBringToMain?: typeof chooseBringToMain;
  deliverBringToMain?: typeof loadBringToMainDraft;
  persistThinkingLevel?: (level: BtwThinkingLevel) => Promise<unknown>;
  now?: () => number;
}

export type BtwThreadResult = { kind: "closed" };

type BtwThreadThinkingControl = Omit<BtwThinkingControl, "keybindings">;

interface BtwThreadSteeringControl {
  questions: readonly string[];
  submit: (question: string) => void;
  thinking: BtwThreadThinkingControl;
  prepareContext: () => string | false;
}

type BtwBringToMainChoice =
  | BtwThreadResult
  | {
      kind: "bringToMain";
      draft: string;
      summary: BtwBringToMainSummary;
      selectionState?: BtwTextRangeSelectorState;
    }
  | { kind: "back" };

type BtwBringToMainDelivery = "loaded" | "back" | "closed";

interface RunBtwThreadOptions {
  initialQuestion?: string;
  selected: ResolvedBtwModel;
  thinkingLevel: BtwThinkingLevel;
  rememberThinkingLevelChanges?: boolean;
  settingsPath?: string;
  state?: BtwThreadState;
  ctx: ExtensionCommandContext;
  isSessionCurrent?: () => boolean;
  dependencies?: RunBtwThreadDependencies;
}

type ParsedSideQuestion =
  | { kind: "ready"; question: string; includeParent: boolean }
  | { kind: "error"; message: string };

function parseSideQuestion(input: string, selected: ResolvedBtwModel, thread: SideThread): ParsedSideQuestion {
  // Previous model responses can echo opted-in parent secrets. Reject a switch
  // before even constructing a request from those previous side messages.
  if (!canSendSideThreadToModel(thread, effectiveSideModel(selected))) {
    return { kind: "error", message: sideThreadDestinationError(thread) };
  }
  const question = input.trim();
  if (!question.startsWith("--with-parent=")) {
    if (/^--with-parent(?:\s|$)/u.test(question)) {
      return { kind: "error", message: "Use --with-parent=provider/model-id before the side question." };
    }
    return { kind: "ready", question, includeParent: false };
  }
  const match = /^--with-parent=(\S+)\s+([\s\S]+)$/u.exec(question);
  const destination = match?.[1];
  if (!destination || !parseBtwModelReference(destination) || !match[2]?.trim()) {
    return { kind: "error", message: "Use --with-parent=provider/model-id followed by a side question." };
  }
  const actual = `${selected.model.provider}/${selected.model.id}`;
  const displayActual = sanitizeSingleLine(actual);
  if (isVirtualBtwModel(selected.model)) {
    return {
      kind: "error",
      message: "Parent history cannot be shared with a virtual model: its physical destination is unknown.",
    };
  }
  if (destination !== actual) {
    return {
      kind: "error",
      message: `Parent history was not shared: selected model is ${displayActual}, not ${sanitizeSingleLine(destination)}. Retry with --with-parent=${displayActual}.`,
    };
  }
  if (selected.endpointOverridden) {
    return {
      kind: "error",
      message: `Parent history was not shared with ${displayActual}: credentials changed its endpoint. Use a model without an auth-resolved endpoint override.`,
    };
  }
  return { kind: "ready", question: match[2].trim(), includeParent: true };
}

export async function runBtwThread({
  initialQuestion,
  selected,
  thinkingLevel,
  rememberThinkingLevelChanges = false,
  settingsPath,
  state,
  ctx,
  isSessionCurrent,
  dependencies = {},
}: RunBtwThreadOptions): Promise<BtwThreadResult> {
  const ask = dependencies.ask ?? askThreadQuestion;
  const interact = dependencies.interact ?? showThreadComposer;
  const chooseBringToMainAction = dependencies.chooseBringToMain ?? chooseBringToMain;
  const deliverBringToMainDraft = dependencies.deliverBringToMain ?? loadBringToMainDraft;
  const persistThinkingLevel =
    dependencies.persistThinkingLevel ??
    ((level: BtwThinkingLevel) => updateBtwSettings({ thinkingLevel: level }, { settingsPath }));
  const now = dependencies.now ?? Date.now;
  const sessionManager = ctx.sessionManager;
  const sessionId = sessionManager.getSessionId?.();
  const thread = state?.thread ?? createSideThread();
  const ownsSession = (): boolean => {
    try {
      return (
        (!isSessionCurrent || isSessionCurrent()) &&
        ctx.sessionManager === sessionManager &&
        sessionManager.getSessionId?.() === sessionId
      );
    } catch {
      return false;
    }
  };
  const prepareContext = (includeParent: boolean): string | false => {
    if (!ownsSession()) return false;
    // Public Pi context hooks cannot be replayed here. Never read the parent
    // projection unless this particular request names its physical destination.
    return includeParent ? buildSessionConversationContext(sessionManager) : "";
  };
  const thinkingLevels = getSupportedThinkingLevels(selected.model);
  const pendingWrites = new Set<Promise<void>>();
  const steeringQuestions: string[] = [];
  let activeThinkingLevel = clampThinkingLevel(selected.model, state?.thinkingLevel ?? thinkingLevel);
  if (state) state.thinkingLevel = activeThinkingLevel;
  let pendingQuestion = initialQuestion;
  let composerDraft: string | undefined;
  const createThinkingControl = (): BtwThreadThinkingControl => ({
    level: activeThinkingLevel,
    levels: thinkingLevels,
    onChange: (level) => {
      if (!thinkingLevels.includes(level)) return;
      activeThinkingLevel = level;
      if (state) state.thinkingLevel = level;
      if (!rememberThinkingLevelChanges) return;
      let write!: Promise<void>;
      write = Promise.resolve()
        .then(() => persistThinkingLevel(level))
        .then(() => undefined)
        .catch((error: unknown) => {
          notifySafely(
            ctx,
            `Thinking level changed to ${level}, but could not be remembered in pi-btw.json: ${formatError(error)}`,
            "warning",
          );
        })
        .finally(() => pendingWrites.delete(write));
      pendingWrites.add(write);
    },
  });

  try {
    while (true) {
      if (!ownsSession()) return { kind: "closed" };
      if (!pendingQuestion) {
        const action = await interact(thread, thread.turns.length > 0, ctx, composerDraft, createThinkingControl());
        if (!ownsSession() || action.kind === "close") return { kind: "closed" };
        if (action.kind === "bringToMain") {
          const choice = await chooseBringToMainAction(thread, ctx, {}, ownsSession);
          if (!ownsSession()) return { kind: "closed" };
          if (choice.kind === "closed") return choice;
          if (choice.kind === "back") {
            composerDraft = action.questionDraft;
            continue;
          }
          const delivery = await deliverBringToMainDraft(choice.draft, ctx, choice.summary, ownsSession);
          if (!ownsSession() || delivery === "loaded" || delivery === "closed") return { kind: "closed" };
          composerDraft = action.questionDraft;
          continue;
        }
        composerDraft = undefined;
        pendingQuestion = action.question;
      }

      const startingTurnCount = thread.turns.length;
      const parsed = parseSideQuestion(pendingQuestion, selected, thread);
      const question = parsed.kind === "ready" ? parsed.question : pendingQuestion;
      if (parsed.kind === "ready" && parsed.includeParent) {
        // Keep the provenance even if the model echoes a secret only in its
        // answer; later default questions must not relay that answer elsewhere.
        bindSideThreadToModel(thread, effectiveSideModel(selected));
      }
      const result =
        parsed.kind === "error"
          ? parsed
          : await ask(thread, question, selected, activeThinkingLevel, ctx, {
              questions: steeringQuestions,
              submit: (question) => steeringQuestions.push(question),
              thinking: createThinkingControl(),
              prepareContext: () => prepareContext(parsed.includeParent),
            });
      if (!ownsSession()) return { kind: "closed" };
      if (result.kind === "aborted") {
        notifySafely(ctx, "Cancelled", "info");
        return { kind: "closed" };
      }
      if (result.kind === "error") {
        thread.turns.push({ kind: "error", question, answer: result.message });
      }
      if (state && thread.turns.length > startingTurnCount) {
        state.title ||= sanitizeSingleLine(question) || "Untitled side thread";
        state.updatedAt = now();
      }

      pendingQuestion = steeringQuestions.shift();
    }
  } finally {
    await Promise.allSettled([...pendingWrites]);
  }
}

type BtwCustomFactory<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: T) => void,
) => Component;

async function showBtwCustomPreservingEditor<T>(
  ctx: ExtensionCommandContext,
  factory: BtwCustomFactory<T>,
  ownsSession: () => boolean,
): Promise<T | undefined> {
  if (!ownsSession()) return undefined;
  let liveEditorText = ctx.ui.getEditorText();
  let completed = false;
  const result = await ctx.ui.custom<T>((tui, theme, keybindings, done) =>
    factory(tui, theme, keybindings, (value) => {
      try {
        if (ownsSession()) liveEditorText = ctx.ui.getEditorText();
      } catch {
        // Keep completion finite if session replacement invalidates the editor context.
      }
      completed = true;
      done(value);
    }),
  );
  if (completed && ownsSession()) {
    try {
      if (ctx.ui.getEditorText() !== liveEditorText && ownsSession()) ctx.ui.setEditorText(liveEditorText);
    } catch {
      // A replaced context owns a different editor and must not receive stale restoration.
    }
  }
  return ownsSession() ? result : undefined;
}

interface ChooseBringToMainDependencies {
  showMenu?: typeof showBtwMenu;
  showPreview?: typeof showBringToMainPreview;
}

export async function chooseBringToMain(
  thread: SideThread,
  ctx: ExtensionCommandContext,
  dependencies: ChooseBringToMainDependencies = {},
  isSessionCurrent?: () => boolean,
): Promise<BtwBringToMainChoice> {
  const sessionManager = ctx.sessionManager;
  const sessionId = sessionManager?.getSessionId?.();
  const ownsSession = () => {
    try {
      return (
        (!isSessionCurrent || isSessionCurrent()) &&
        ctx.sessionManager === sessionManager &&
        sessionManager?.getSessionId?.() === sessionId
      );
    } catch {
      return false;
    }
  };
  if (!ownsSession()) return { kind: "closed" };
  const answered = getAnsweredTurns(thread.turns);
  if (answered.length === 0) return { kind: "back" };
  const showMenu = dependencies.showMenu ?? showBtwMenu;
  const showPreview = dependencies.showPreview ?? showBringToMainPreview;
  const makeChoice = (segments: readonly BtwBringToMainSegment[]) => ({
    kind: "bringToMain" as const,
    draft: formatBtwBringToMain(segments),
    summary: summarizeBringToMain(segments),
  });

  const latestSegments = buildQuickBringToMainSegments(thread.turns, { kind: "latest" });
  const entireSegments = buildQuickBringToMainSegments(thread.turns, { kind: "entire" });
  const latestOption = `Latest question and answer  1 Q&A · ~${estimateBringToMainTokens(latestSegments)} tokens`;
  const fromOption = "From a question onward…  Choose a starting question";
  const exactOption = "Select exact text…  Lines or characters";
  const entireOption = `Entire side thread  ${answered.length} Q&A · ~${estimateBringToMainTokens(entireSegments)} tokens`;
  const cancelOption = "Cancel  Return to the side thread";
  let selectedScope: string | undefined;

  while (true) {
    if (!ownsSession()) return { kind: "closed" };
    const scopeResult = await showMenu(
      ctx,
      "Bring what back to the main thread?",
      [latestOption, fromOption, exactOption, entireOption, cancelOption],
      selectedScope,
      ownsSession,
    );
    if (!ownsSession() || scopeResult.kind === "close") return { kind: "closed" };
    if (scopeResult.kind === "back" || scopeResult.value === cancelOption) return { kind: "back" };
    const scope = scopeResult.value;
    selectedScope = scope;
    if (scope === latestOption) return makeChoice(latestSegments);
    if (scope === entireOption) {
      const choice = makeChoice(entireSegments);
      const preview = await showPreview(ctx, choice.draft, choice.summary, ownsSession);
      if (!ownsSession() || preview.kind === "close") return { kind: "closed" };
      if (preview.kind === "back") continue;
      return choice;
    }
    if (scope === fromOption) {
      const questions = answered.map(
        (turn, index) => `${index + 1}. ${truncatePreview(sanitizeSingleLine(turn.question))}`,
      );
      let selectedQuestion: string | undefined;
      while (true) {
        if (!ownsSession()) return { kind: "closed" };
        const questionResult = await showMenu(
          ctx,
          "Start from which question?",
          questions,
          selectedQuestion,
          ownsSession,
        );
        if (!ownsSession() || questionResult.kind === "close") return { kind: "closed" };
        if (questionResult.kind === "back") break;
        const answeredTurnIndex = questions.indexOf(questionResult.value);
        if (answeredTurnIndex < 0) continue;
        selectedQuestion = questionResult.value;
        const choice = makeChoice(buildQuickBringToMainSegments(thread.turns, { kind: "from", answeredTurnIndex }));
        const preview = await showPreview(ctx, choice.draft, choice.summary, ownsSession);
        if (!ownsSession() || preview.kind === "close") return { kind: "closed" };
        if (preview.kind === "back") continue;
        return choice;
      }
      continue;
    }

    if (scope !== exactOption) continue;
    let selectionState: BtwTextRangeSelectorState | undefined;
    while (true) {
      if (!ownsSession()) return { kind: "closed" };
      const selectedRange = await showBtwCustomPreservingEditor<BtwBringToMainChoice>(
        ctx,
        (tui, theme, keybindings, done) => {
          let selector: BtwTextRangeSelector;
          selector = new BtwTextRangeSelector(
            tui,
            theme,
            keybindings,
            thread.turns,
            (action) => {
              if (action.kind === "back") done({ kind: "back" });
              else if (action.kind === "close") done({ kind: "closed" });
              else done({ ...makeChoice(action.segments), selectionState: selector.getState() });
            },
            selectionState,
          );
          return selector;
        },
        ownsSession,
      );
      if (!ownsSession() || !selectedRange) return { kind: "closed" };
      if (selectedRange.kind === "closed") return selectedRange;
      if (selectedRange.kind === "back") break;
      const preview = await showPreview(ctx, selectedRange.draft, selectedRange.summary, ownsSession);
      if (!ownsSession() || preview.kind === "close") return { kind: "closed" };
      if (preview.kind === "back") {
        selectionState = selectedRange.selectionState;
        continue;
      }
      return {
        kind: "bringToMain",
        draft: selectedRange.draft,
        summary: selectedRange.summary,
      };
    }
  }
}

type BtwMenuSelectorAction = { kind: "select"; value: string } | { kind: "back" } | { kind: "close" };

type BtwBringToMainPreviewAction = { kind: "bring" } | { kind: "back" } | { kind: "close" };

async function showBringToMainPreview(
  ctx: ExtensionCommandContext,
  draft: string,
  summary: BtwBringToMainSummary,
  isSessionCurrent?: () => boolean,
): Promise<BtwBringToMainPreviewAction> {
  const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
  if (ctx.signal?.aborted || (isSessionCurrent && !isSessionCurrent())) return { kind: "close" };
  let confirmed = false;
  const count = summary.messages === 1 ? "1 message" : `${summary.messages} messages`;
  const lineCount = summary.lines === 1 ? "1 line" : `${summary.lines} lines`;
  const menu = defineMenu<void, "preview", "bring", MenuContext>({
    start: "preview",
    screens: {
      preview: () => ({
        kind: "review",
        title: `Preview · ${count} · ${lineCount} · ~${summary.tokens} tokens`,
        content: draft,
        viewportSize: "adaptive",
        hint: "back",
        confirm: { id: "bring", label: "Bring", action: "bring" },
      }),
    },
    actions: {
      bring: async () => {
        confirmed = true;
        return { kind: "close" } as const;
      },
    },
  });
  const result = await runBtwMenuPreservingEditor(
    ctx,
    (menuContext) => runMenu(menuContext, menu, { getState: () => undefined }),
    isSessionCurrent,
  );
  if (isSessionCurrent && !isSessionCurrent()) return { kind: "close" };
  if (confirmed && result.kind === "closed" && result.reason === "close") {
    return { kind: "bring" };
  }
  return terminalBtwMenuAction(result);
}

async function showBtwMenu(
  ctx: ExtensionCommandContext,
  title: string,
  options: readonly string[],
  initialValue?: string,
  isSessionCurrent?: () => boolean,
): Promise<BtwMenuSelectorAction> {
  const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
  if (ctx.signal?.aborted || (isSessionCurrent && !isSessionCurrent())) return { kind: "close" };
  const items = options.map((label, index) => ({ id: `option-${index}`, label }));
  const initialIndex = initialValue === undefined ? -1 : options.indexOf(initialValue);
  let selectedValue: string | undefined;
  const menu = defineMenu<void, "choices", "select", MenuContext>({
    start: "choices",
    screens: {
      choices: () => ({
        kind: "choice",
        title,
        items,
        action: "select",
        initialItemId: initialIndex >= 0 ? `option-${initialIndex}` : undefined,
        hint: "back",
      }),
    },
    actions: {
      select: async ({ itemId }: { itemId: string }) => {
        const index = Number.parseInt(itemId.slice("option-".length), 10);
        selectedValue = options[index];
        return selectedValue === undefined ? ({ kind: "stay" } as const) : ({ kind: "close" } as const);
      },
    },
  });
  const result = await runBtwMenuPreservingEditor(
    ctx,
    (menuContext) => runMenu(menuContext, menu, { getState: () => undefined }),
    isSessionCurrent,
  );
  if (isSessionCurrent && !isSessionCurrent()) return { kind: "close" };
  return selectedValue !== undefined && result.kind === "closed" && result.reason === "close"
    ? { kind: "select", value: selectedValue }
    : terminalBtwMenuAction(result);
}

function terminalBtwMenuAction(result: RunMenuResult): { kind: "back" } | { kind: "close" } {
  if (result.kind === "closed") return { kind: result.reason };
  if (result.kind === "error") throw result.error;
  return { kind: "close" };
}

export async function loadBringToMainDraft(
  draft: string,
  ctx: ExtensionCommandContext,
  summary: BtwBringToMainSummary,
  isSessionCurrent?: () => boolean,
): Promise<BtwBringToMainDelivery> {
  const sessionManager = ctx.sessionManager;
  const sessionId = sessionManager?.getSessionId?.();
  const ownsSession = () => {
    try {
      return (
        (!isSessionCurrent || isSessionCurrent()) &&
        ctx.sessionManager === sessionManager &&
        sessionManager?.getSessionId?.() === sessionId
      );
    } catch {
      return false;
    }
  };
  if (!ownsSession()) return "closed";
  const describeContent = () =>
    `${summary.messages} ${summary.messages === 1 ? "message" : "messages"} (~${summary.tokens} ${summary.tokens === 1 ? "token" : "tokens"})`;
  const existing = ctx.ui.getEditorText();
  if (!ownsSession()) return "closed";
  if (!existing.trim()) {
    if (!ownsSession()) return "closed";
    ctx.ui.setEditorText(draft);
    ctx.ui.notify(`Brought ${describeContent()} to the main editor. Review and submit when ready.`, "info");
    return "loaded";
  }

  const appendOption = "Append after current draft  Recommended";
  const replaceOption = "⚠ Replace current draft  Discards current editor text";
  const cancelOption = "Cancel  Return to the side thread";
  while (true) {
    if (!ownsSession()) return "closed";
    const action = await showBtwMenu(
      ctx,
      "The main editor already has a draft",
      [appendOption, replaceOption, cancelOption],
      undefined,
      ownsSession,
    );
    if (!ownsSession() || action.kind === "close") return "closed";
    if (action.kind === "back" || action.value === cancelOption) return "back";
    if (action.value === appendOption) {
      const current = ctx.ui.getEditorText();
      if (!ownsSession()) return "closed";
      ctx.ui.setEditorText(`${current}\n\n${draft}`);
      ctx.ui.notify(
        `Appended ${describeContent()} to the existing main-editor draft. Review and submit when ready.`,
        "info",
      );
      return "loaded";
    }
    if (action.value !== replaceOption) continue;

    const current = ctx.ui.getEditorText();
    if (!ownsSession()) return "closed";
    const characters = [...current].length;
    const confirmed = await showBtwMenu(
      ctx,
      `Replace the current ${characters}-character editor draft?`,
      ["Back  Keep current editor text", "⚠ Replace current draft  Cannot be undone"],
      undefined,
      ownsSession,
    );
    if (!ownsSession() || confirmed.kind === "close") return "closed";
    if (confirmed.kind === "back" || confirmed.value === "Back  Keep current editor text") continue;
    if (confirmed.value !== "⚠ Replace current draft  Cannot be undone") continue;
    const latest = ctx.ui.getEditorText();
    if (!ownsSession()) return "closed";
    if (latest !== current) {
      ctx.ui.notify(
        "The main editor changed during confirmation. Review the updated draft and choose again.",
        "warning",
      );
      continue;
    }
    if (!ownsSession()) return "closed";
    ctx.ui.setEditorText(draft);
    ctx.ui.notify(`Replaced the main-editor draft with ${describeContent()}. Review and submit when ready.`, "info");
    return "loaded";
  }
}

function truncatePreview(text: string): string {
  return text.length <= 72 ? text : `${text.slice(0, 69)}…`;
}

async function askThreadQuestion(
  thread: SideThread,
  question: string,
  selected: ResolvedBtwModel,
  thinkingLevel: BtwThinkingLevel,
  ctx: ExtensionCommandContext,
  steering: BtwThreadSteeringControl,
) {
  return ctx.ui.custom<Awaited<ReturnType<typeof completeSideThreadTurn>>>((tui, theme, keybindings, done) => {
    let settled = false;
    const view = new BtwAnsweringView(
      tui,
      theme,
      thread.turns,
      question,
      () => {
        if (settled) return;
        settled = true;
        done({ kind: "aborted" });
      },
      thinkingLevel,
      {
        steering: {
          questions: steering.questions,
          onSubmit: steering.submit,
          thinking: { ...steering.thinking, keybindings },
        },
      },
    );
    completeSideThreadTurn({
      thread,
      question,
      model: selected.model,
      thinkingLevel,
      auth: selected.auth,
      signal: view.signal,
      completeSimple: createModelRegistryCompleteSimple(ctx.modelRegistry),
      prepareContext: steering.prepareContext,
    }).then((result) => {
      if (settled) return;
      settled = true;
      view.finish();
      done(result);
    });
    return view;
  });
}

async function showThreadComposer(
  thread: SideThread,
  startAtBottom: boolean,
  ctx: ExtensionCommandContext,
  initialQuestion: string | undefined,
  thinking: BtwThreadThinkingControl,
): Promise<TranscriptPagerAction> {
  return ctx.ui.custom<TranscriptPagerAction>(
    (tui, theme, keybindings, done) =>
      new BtwTranscriptPager(tui, theme, thread.turns, done, {
        startAtBottom,
        initialQuestion,
        thinking: { ...thinking, keybindings },
      }),
  );
}

type MessageContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  arguments?: unknown;
};

type SessionMessage = {
  role?: string;
  content?: unknown;
  summary?: string;
  stopReason?: string;
  toolName?: string;
  command?: string;
  output?: string;
  excludeFromContext?: boolean;
};

type SessionEntry = {
  type: string;
  message?: SessionMessage;
};

function buildSessionConversationContext(manager: ExtensionCommandContext["sessionManager"]): string {
  // Pi 0.87+ applies context edits in the projection; raw branch messages can
  // contain omitted or replaced content that must not reach the side provider.
  if (typeof manager.buildSessionProjection === "function") {
    return serializeConversationContext(manager.buildSessionProjection().messages, (message) => message);
  }
  return buildConversationContext(manager.getBranch());
}

export function buildConversationContext(entries: readonly SessionEntry[]) {
  return serializeConversationContext(entries, (entry) => (entry.type === "message" ? entry.message : undefined));
}

function serializeConversationContext<T>(items: readonly T[], getMessage: (item: T) => SessionMessage | undefined) {
  const sections: string[] = [];
  // One extra character distinguishes an exact fit from a truncated context.
  let remaining = MAX_CONTEXT_CHARS + 1;

  for (let index = items.length - 1; index >= 0 && remaining > 0; index--) {
    const message = getMessage(items[index]);
    if (!message?.role) continue;

    const role = message.role;
    if (
      role !== "user" &&
      role !== "assistant" &&
      role !== "toolResult" &&
      role !== "custom" &&
      role !== "bashExecution" &&
      role !== "compactionSummary" &&
      role !== "branchSummary"
    ) {
      continue;
    }
    if (role === "bashExecution" && message.excludeFromContext) continue;

    const content = extractContentTail(
      role === "compactionSummary" || role === "branchSummary"
        ? message.summary
        : role === "bashExecution"
          ? message.output || "(no output)"
          : message.content,
      remaining,
    );
    if (!content) continue;
    if (sections.length > 0) {
      sections.push("\n\n".slice(-remaining));
      remaining -= Math.min(2, remaining);
    }
    if (remaining === 0) break;
    sections.push(content.slice(-remaining));
    remaining -= Math.min(content.length, remaining);
    if (remaining === 0) break;

    const label =
      role === "toolResult"
        ? `Tool result from ${message.toolName ?? "unknown tool"}`
        : role === "bashExecution"
          ? `Bash ${message.command ?? ""}`
          : role === "custom"
            ? "Context"
            : role === "compactionSummary"
              ? "Compaction summary"
              : role === "branchSummary"
                ? "Branch summary"
                : role === "user"
                  ? "User"
                  : "Assistant";
    const status = message.stopReason && message.stopReason !== "stop" ? ` (${message.stopReason})` : "";
    const prefix = `${label}${status}: `;
    sections.push(prefix.slice(-remaining));
    remaining -= Math.min(prefix.length, remaining);
  }

  return truncateFromStart(sections.reverse().join(""), MAX_CONTEXT_CHARS);
}

function extractContentTail(content: unknown, budget: number): string {
  if (typeof content === "string") return content.trim().slice(-budget);
  if (!Array.isArray(content)) return "";
  const lines: string[] = [];
  for (let index = content.length - 1; index >= 0 && budget > 0; index--) {
    const part = content[index];
    if (!part || typeof part !== "object") continue;
    const block = part as MessageContentBlock;
    let line = "";
    if (block.type === "text" && typeof block.text === "string") {
      line = block.text.trim().slice(-budget);
    } else if (block.type === "toolCall" && typeof block.name === "string") {
      // Construct the suffix first: arguments can dwarf the entire context budget.
      line = budget > 1 ? `${formatJsonTail(block.arguments, budget - 1)})` : ")";
      if (line.length < budget) line = `${`Tool call: ${block.name}(`.slice(-(budget - line.length))}${line}`;
    }
    if (!line) continue;
    if (lines.length > 0) {
      lines.push("\n");
      budget--;
    }
    if (budget === 0) break;
    lines.push(line.slice(-budget));
    budget -= Math.min(line.length, budget);
  }
  return lines.reverse().join("");
}

/** Serialize JSON-shaped tool arguments from the end without a full JSON allocation. */
function formatJsonTail(value: unknown, budget: number): string {
  const chunks: string[] = [];
  const ancestors = new Set<object>();
  const take = (text: string) => {
    if (budget <= 0) return;
    chunks.push(text.slice(-budget));
    budget -= Math.min(text.length, budget);
  };
  const visit = (item: unknown): void => {
    if (budget <= 0) return;
    if (typeof item === "string") {
      take(JSON.stringify(item.slice(-budget)));
    } else if (item !== null && typeof item === "object") {
      if (ancestors.has(item)) throw new Error("Circular arguments");
      ancestors.add(item);
      if (Array.isArray(item)) {
        take("]");
        for (let index = item.length - 1; index >= 0 && budget > 0; index--) {
          if (index < item.length - 1) take(",");
          visit(item[index] ?? null);
        }
        take("[");
      } else {
        take("}");
        const record = item as Record<string, unknown>;
        // Every JSON-shaped property emits at least one character. Retain at
        // most budget suffix keys, without allocating a full Object.keys array.
        // Enumeration is still linear (and the VM may allocate internally).
        const capacity = Math.max(1, budget);
        const keys: string[] = [];
        let count = 0;
        for (const key in record) {
          if (!Object.hasOwn(record, key)) continue;
          keys[count % capacity] = key;
          count++;
        }
        let hasItem = false;
        for (let index = count - 1; index >= Math.max(0, count - capacity) && budget > 0; index--) {
          const key = keys[index % capacity];
          const child = record[key];
          if (child === undefined || typeof child === "function" || typeof child === "symbol") continue;
          if (hasItem) take(",");
          visit(child);
          take(":");
          if (budget > 0) take(JSON.stringify(key.slice(-budget)));
          hasItem = true;
        }
        take("{");
      }
      ancestors.delete(item);
    } else {
      take(JSON.stringify(item) ?? "");
    }
  };
  const limit = budget;
  try {
    visit(value);
    return chunks.reverse().join("");
  } catch {
    return String(value).slice(-limit);
  }
}

function truncateFromStart(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return `[Earlier context omitted; showing the last ${maxChars} characters.]\n${text.slice(-maxChars)}`;
}
