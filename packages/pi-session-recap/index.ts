/**
 * Drafts a short Claude Code-style recap after the user has been away.
 * See README.md for triggers, flags, and model selection.
 */

import type { Message } from "@earendil-works/pi-ai";
import { complete, completeSimple } from "@earendil-works/pi-ai/compat";
import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text, type TUI, truncateToWidth } from "@earendil-works/pi-tui";

type Model = Parameters<typeof completeSimple>[0];

type RecapContext = {
  messages: Message[];
  broaderContext?: string;
};

type RecapReason = "idle" | "manual" | "resume" | "focus";

const RECAP_KEY = "session-recap";

const DEFAULT_AWAY_SECONDS = 90;
const DEFAULT_IDLE_SECONDS = 120;
const ANTHROPIC_RECAP_MODEL = "claude-haiku-4-5";
const GPT_MODEL_ID = /(?:^|\/)gpt-/;
const LUNA_RECAP_MODEL = /(?:^|\/)gpt-5[.-]6-luna(?:$|[@:])/;

// Debounce after a turn ends while blurred, so mid-loop turn_ends (which are
// immediately followed by the next turn_start) don't trigger drafts.
const POST_TURN_DEBOUNCE_MS = 3000;

// `completeSimple` cannot express "reasoning off": omitting `reasoning` is
// sufficient for every other API, but openai-codex-responses then inherits the
// server-side default effort. Codex recaps use `complete` with an explicit
// `reasoningEffort: "none"` instead.

const RECENT_MESSAGE_WINDOW = 30;
const MIN_ASSISTANT_WORDS = 30;
const INITIAL_TASK_EDGE_CHARS = 4000;
const TOOL_RESULT_EDGE_CHARS = 2000;

// DECSET 1004 focus reporting — https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
const FOCUS_ENABLE = "\x1b[?1004h";
const FOCUS_DISABLE = "\x1b[?1004l";
const FOCUS_IN_SEQ = "\x1b[I";
const FOCUS_OUT_SEQ = "\x1b[O";

/**
 * Everything this extension handles is untrusted: transcript tool results, the
 * initial request, and the recap the model writes from them. Neutralize C0/C1
 * controls and bidi overrides rather than dropping them, so an escape sequence
 * cannot be reassembled and the surrounding text keeps its shape.
 *
 * `keepLineBreaks` separates the two boundaries. Prompt text keeps its line
 * structure so the model still reads tool output as tool output; anything handed
 * to the terminal is collapsed onto one line by the caller.
 *
 * Duplicated rather than shared, per the package boundary rule; `pi-stamp`'s
 * metadata sanitizer is the reference shape.
 */
export function sanitizeTerminalText(value: string, keepLineBreaks = false): string {
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (keepLineBreaks && (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d)) {
      safe += character;
      continue;
    }
    safe += isUnsafeTerminalCodePoint(codePoint) ? " " : character;
  }
  return safe;
}

function isUnsafeTerminalCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function extractText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function buildRecapContext(contextEntries: SessionEntry[], branchEntries: SessionEntry[]): RecapContext {
  let summary: string | undefined;
  for (let i = contextEntries.length - 1; i >= 0; i--) {
    const entry = contextEntries[i];
    const candidate = entry.type === "compaction" || entry.type === "branch_summary" ? entry.summary.trim() : undefined;
    if (candidate) {
      summary = candidate;
      break;
    }
  }

  let initialTask: string | undefined;
  for (const entry of branchEntries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    initialTask = extractText(entry.message.content).trim() || undefined;
    break;
  }

  const messages = convertToLlm(
    contextEntries
      .filter((entry) => entry.type !== "compaction" && entry.type !== "branch_summary")
      .flatMap(sessionEntryToContextMessages),
  ).map((message) => {
    if (message.role !== "toolResult") return message;
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type !== "text") return block;
        // Sanitize before slicing, never after: a cut through an escape sequence
        // would leave the model a half-sequence to complete on its own.
        const text = sanitizeTerminalText(block.text, true);
        if (text.length <= TOOL_RESULT_EDGE_CHARS * 2) return { ...block, text };
        return {
          ...block,
          text: `${text.slice(0, TOOL_RESULT_EDGE_CHARS)}\n… [tool result truncated for recap] …\n${text.slice(-TOOL_RESULT_EDGE_CHARS)}`,
        };
      }),
    };
  });
  let start = Math.max(0, messages.length - RECENT_MESSAGE_WINDOW);
  while (start > 0 && messages[start].role === "toolResult") start--;
  let recentMessages = messages.slice(start);
  if (recentMessages[0]?.role === "assistant") {
    recentMessages = [
      {
        role: "user",
        content: "(Earlier conversation omitted.)",
        timestamp: recentMessages[0].timestamp,
      },
      ...recentMessages,
    ];
  }

  const broader: string[] = [];
  const initialTaskInRecent = recentMessages.some(
    (message) => message.role === "user" && extractText(message.content).trim() === initialTask,
  );
  if (initialTask && !initialTaskInRecent) {
    // Same rule as the tool results above: sanitize first, then truncate. The
    // comparison above deliberately stays on the raw text so it still matches the
    // recent message it was read from.
    const safeInitialTask = sanitizeTerminalText(initialTask, true);
    const framedInitialTask =
      safeInitialTask.length <= INITIAL_TASK_EDGE_CHARS * 2
        ? safeInitialTask
        : `${safeInitialTask.slice(0, INITIAL_TASK_EDGE_CHARS)}\n… [middle of initial request omitted for recap] …\n${safeInitialTask.slice(-INITIAL_TASK_EDGE_CHARS)}`;
    broader.push(`Initial user request:\n${framedInitialTask}`);
  }
  if (summary) broader.push(`Session summary:\n${sanitizeTerminalText(summary, true)}`);

  return {
    messages: recentMessages,
    broaderContext: broader.length > 0 ? broader.join("\n\n") : undefined,
  };
}

function hasMeaningfulActivity(entries: SessionEntry[]): boolean {
  let lastUserIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "message" && e.message.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  const tail = lastUserIdx >= 0 ? entries.slice(lastUserIdx + 1) : entries;
  let assistantWords = 0;
  let toolCalls = 0;
  for (const e of tail) {
    if (e.type !== "message" || e.message.role !== "assistant") continue;
    assistantWords += extractText(e.message.content).split(/\s+/).filter(Boolean).length;
    toolCalls += e.message.content.filter((block) => block.type === "toolCall").length;
  }
  return toolCalls > 0 || assistantWords >= MIN_ASSISTANT_WORDS;
}

export function selectRecapModel(
  activeModel: Model | undefined,
  overrideSpec: string | undefined,
  registry: Pick<ExtensionContext["modelRegistry"], "find" | "getAvailable">,
): Model | undefined {
  if (overrideSpec) {
    const slash = overrideSpec.indexOf("/");
    if (slash <= 0) return activeModel;
    return registry.find(overrideSpec.slice(0, slash), overrideSpec.slice(slash + 1)) ?? activeModel;
  }
  if (!activeModel) return undefined;

  const available = registry.getAvailable().filter((model) => model.provider === activeModel.provider);
  if (activeModel.provider === "anthropic") {
    return available.find((model) => model.id === ANTHROPIC_RECAP_MODEL) ?? activeModel;
  }
  if (!GPT_MODEL_ID.test(activeModel.id)) return activeModel;
  return available.find((model) => LUNA_RECAP_MODEL.test(model.id)) ?? activeModel;
}

async function generateRecap(
  recapContext: RecapContext,
  ctx: ExtensionContext,
  overrideSpec: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const model = selectRecapModel(ctx.model, overrideSpec, ctx.modelRegistry);
  if (!model) return undefined;

  // Ambient-auth providers can succeed without returning an API key.
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth?.ok) return undefined;

  const prompt =
    (recapContext.broaderContext ? `Broader session context:\n${recapContext.broaderContext}\n\n` : "") +
    "The user stepped away and is coming back. Write exactly 1-3 short sentences. " +
    "Start by stating the high-level task — what they are building or debugging, not " +
    "implementation details. Next: the concrete next step. Skip status reports and commit recaps.";

  const context = {
    systemPrompt: "",
    messages: [
      ...recapContext.messages,
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: prompt }],
        timestamp: Date.now(),
      },
    ],
  };
  const options = {
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    signal,
    cacheRetention: "none" as const,
    maxTokens: 256,
  };

  let response: Awaited<ReturnType<typeof completeSimple>>;
  try {
    // Recaps never need reasoning; keep the common options identical for both
    // completion paths and only add the Codex-specific explicit override.
    if (model.api === "openai-codex-responses") {
      response = await complete(model, context, {
        ...options,
        reasoningEffort: "none",
      });
    } else {
      response = await completeSimple(model, context, options);
    }
  } catch (err) {
    // completeSimple cannot route custom handlers registered only inside Pi.
    if (err instanceof Error && err.message.startsWith("No API provider registered for api:")) {
      return undefined;
    }
    throw err;
  }

  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return text || undefined;
}

function hasInteractiveUi(ctx: ExtensionContext): boolean {
  return ctx.hasUI && ctx.mode === "tui";
}

function hasRecapUi(ctx: ExtensionContext): boolean {
  return ctx.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc");
}

function transcriptDocument(tui: TUI): Container | undefined {
  try {
    if (!Array.isArray(tui.children)) return undefined;
    const document = tui.children[0];
    return document instanceof Container ? document : undefined;
  } catch {
    return undefined;
  }
}

function renderWidthSafe(content: Component, width: number): string[] {
  const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (safeWidth === 0) return [];
  return content.render(Math.max(1, safeWidth)).map((line) => truncateToWidth(line, safeWidth, ""));
}

type DisposableComponent = Component & { dispose?(): void };

type RecapPresentation = {
  dock: DisposableComponent;
  hasTranscriptDocument(): boolean;
};

function createRecapPresentation(tui: TUI, header: string, body: string): RecapPresentation {
  const content = new Container();
  content.addChild(new Text(header, 1, 0));
  content.addChild(new Text(body, 1, 0));

  let mountedDocument: Container | undefined;
  let disposed = false;
  let transcriptRecap: Component;

  const removeFromDocument = (document: Container) => {
    try {
      document.removeChild(transcriptRecap);
    } catch {
      // The host may already have disposed the document during a mode switch.
    }
  };

  const reconcileTranscript = () => {
    if (disposed) return;

    const nextDocument = transcriptDocument(tui);
    if (nextDocument === mountedDocument) {
      if (nextDocument) {
        try {
          if (!nextDocument.children.includes(transcriptRecap)) nextDocument.addChild(transcriptRecap);
        } catch {
          // A renderer can be torn down while its component tree is replaced.
        }
      }
      return;
    }

    if (mountedDocument) removeFromDocument(mountedDocument);
    mountedDocument = undefined;
    if (!nextDocument) return;

    try {
      nextDocument.addChild(transcriptRecap);
      mountedDocument = nextDocument;
    } catch {
      // Fall back to the dock when the document shape is unavailable.
    }
  };

  const renderContent = (width: number): string[] => {
    try {
      return renderWidthSafe(content, width);
    } catch {
      return [];
    }
  };

  transcriptRecap = {
    render: (width) => (disposed || tui.mode !== "fullscreen" ? [] : renderContent(width)),
    invalidate: () => {
      if (disposed) return;
      // Renderer switches invalidate the stable component tree before rendering.
      // Reconcile here, never from render(), so document mutation is outside a
      // render phase and the stable TUI proxy can follow the new renderer.
      reconcileTranscript();
      content.invalidate();
    },
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (mountedDocument) removeFromDocument(mountedDocument);
    mountedDocument = undefined;
  };

  const dock: DisposableComponent = {
    render: (width) => (disposed || tui.mode !== "regular" ? [] : renderContent(width)),
    invalidate: () => {
      if (disposed) return;
      reconcileTranscript();
      content.invalidate();
    },
    dispose,
  };

  // setWidget invokes factories outside a render phase. Mount immediately when
  // the document is available, including while the current renderer is regular.
  reconcileTranscript();

  return {
    dock,
    hasTranscriptDocument: () => mountedDocument !== undefined,
  };
}

export function showRecap(ctx: ExtensionContext, recap: string): void {
  if (!hasRecapUi(ctx)) return;

  // The recap is model output written from tool results, so it is untrusted text
  // heading straight for the terminal. This is the single boundary every caller
  // passes through; the widget is one line, so collapse the whitespace too.
  const safeRecap = sanitizeTerminalText(recap).replace(/\s+/gu, " ").trim();
  if (!safeRecap) return;

  const plainContent = ["✦ recap", safeRecap];
  if (ctx.mode === "rpc") {
    try {
      ctx.ui.setWidget(RECAP_KEY, plainContent, { placement: "aboveEditor" });
    } catch {
      // UI teardown can race a late recap; there is nothing left to render.
    }
    return;
  }

  let header = plainContent[0];
  let body = plainContent[1];
  try {
    const theme = ctx.ui.theme;
    header = theme.fg("accent", theme.bold(header));
    body = theme.fg("dim", safeRecap);
  } catch {
    // Keep an unstyled, still-visible fallback if the theme is being replaced.
  }

  const regularContent = [header, body];
  let presentation: RecapPresentation | undefined;
  try {
    ctx.ui.setWidget(
      RECAP_KEY,
      (tui) => {
        presentation = createRecapPresentation(tui, header, body);
        return presentation.dock;
      },
      { placement: "aboveEditor" },
    );
  } catch {
    presentation?.dock.dispose?.();
    presentation = undefined;
  }

  if (!presentation?.hasTranscriptDocument()) {
    try {
      ctx.ui.setWidget(RECAP_KEY, regularContent, { placement: "aboveEditor" });
    } catch {
      presentation?.dock.dispose?.();
      // UI teardown can race a late recap; there is nothing left to render.
    }
  }
}

function setRecapStatus(ctx: ExtensionContext, text: string | undefined): void {
  if (!hasRecapUi(ctx)) return;
  try {
    const rendered = text === undefined || ctx.mode === "rpc" ? text : ctx.ui.theme.fg("dim", text);
    ctx.ui.setStatus(RECAP_KEY, rendered);
  } catch {
    // UI teardown can race a late status update.
  }
}

function clearRecap(ctx: ExtensionContext): void {
  if (!hasRecapUi(ctx)) return;
  try {
    ctx.ui.setWidget(RECAP_KEY, undefined);
  } catch {
    // UI teardown can race session cleanup.
  }
  setRecapStatus(ctx, undefined);
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("recap-away-seconds", {
    description: "Seconds of continuous terminal blur before an away recap is generated",
    type: "string",
    default: String(DEFAULT_AWAY_SECONDS),
  });
  pi.registerFlag("recap-idle-seconds", {
    description: "Idle-fallback: seconds after turn_end before a recap when the terminal doesn't report focus",
    type: "string",
    default: String(DEFAULT_IDLE_SECONDS),
  });
  pi.registerFlag("recap-disable-focus", {
    description: "Disable DECSET ?1004 focus reporting (idle fallback still runs)",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("recap-during-active", {
    description: "Allow away recaps while an agent turn is still running",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("recap-disable", {
    description: "Disable the automatic session recap",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("recap-model", {
    description: "Override automatic model selection, e.g. anthropic/claude-sonnet-4-6",
    type: "string",
    default: "",
  });

  let idleTimer: NodeJS.Timeout | undefined;
  let awayTimer: NodeJS.Timeout | undefined;
  let postTurnTimer: NodeJS.Timeout | undefined;
  let resumeTimer: NodeJS.Timeout | undefined;
  let activeController: AbortController | undefined;
  let agentActive = false;
  let awayRecapPending = false;
  let focusListener: ((chunk: Buffer) => void) | undefined;
  let focusEnabled = false;
  let isBlurred = false;
  let focusEventsSeen = false;
  let lastDraftedContext: string | undefined;
  let sessionGeneration = 0;
  let activeSessionManager: ExtensionContext["sessionManager"] | undefined;
  let sessionIdentityBound = false;

  const flagMilliseconds = (name: string, fallback: number): number => {
    const seconds = Number(pi.getFlag(name) ?? fallback);
    return Math.max(5, Number.isFinite(seconds) ? seconds : fallback) * 1000;
  };
  const isDisabled = (): boolean => Boolean(pi.getFlag("recap-disable"));

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };
  const clearAwayTimer = () => {
    if (awayTimer) {
      clearTimeout(awayTimer);
      awayTimer = undefined;
    }
  };
  const clearPostTurnTimer = () => {
    if (postTurnTimer) {
      clearTimeout(postTurnTimer);
      postTurnTimer = undefined;
    }
  };
  const clearResumeTimer = () => {
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = undefined;
    }
  };

  const cancelActive = () => {
    activeController?.abort();
    activeController = undefined;
  };

  const ownsSession = (ctx: ExtensionContext): boolean =>
    !sessionIdentityBound || activeSessionManager === ctx.sessionManager;
  const isCurrentIdentity = (generation: number, sessionManager: ExtensionContext["sessionManager"]): boolean =>
    generation === sessionGeneration && (!sessionIdentityBound || activeSessionManager === sessionManager);
  const generateAndShow = async (ctx: ExtensionContext, reason: RecapReason) => {
    if (!hasRecapUi(ctx)) return;
    const generation = sessionGeneration;
    const sessionManager = ctx.sessionManager;
    if (!isCurrentIdentity(generation, sessionManager)) return;

    const entries = sessionManager.getBranch();
    if (reason !== "manual" && !hasMeaningfulActivity(entries)) return;

    const recapContext = buildRecapContext(sessionManager.buildContextEntries(), entries);
    if (recapContext.messages.length === 0 && !recapContext.broaderContext) return;

    const startContext = JSON.stringify(recapContext);
    if (reason !== "manual" && lastDraftedContext === startContext) return;

    cancelActive();
    const controller = new AbortController();
    activeController = controller;

    const showStatus = reason === "manual" || reason === "idle";
    if (showStatus) setRecapStatus(ctx, "✦ drafting recap…");

    try {
      const override = String(pi.getFlag("recap-model") ?? "").trim() || undefined;
      const recap = await generateRecap(recapContext, ctx, override, controller.signal);
      if (!isCurrentIdentity(generation, sessionManager) || !recap || controller.signal.aborted) return;

      const currentContext = buildRecapContext(sessionManager.buildContextEntries(), sessionManager.getBranch());
      if (!isCurrentIdentity(generation, sessionManager) || JSON.stringify(currentContext) !== startContext) return;

      lastDraftedContext = startContext;
      clearIdleTimer();
      clearPostTurnTimer();
      showRecap(ctx, recap);
    } catch (err) {
      if (!controller.signal.aborted) console.error("[session-recap] failed:", err);
    } finally {
      if (activeController === controller) {
        activeController = undefined;
        if (showStatus && isCurrentIdentity(generation, sessionManager)) setRecapStatus(ctx, undefined);
      }
    }
  };

  const runGenerationSafely = (
    ctx: ExtensionContext,
    reason: RecapReason,
    generation: number,
    sessionManager: ExtensionContext["sessionManager"],
  ): void => {
    if (!isCurrentIdentity(generation, sessionManager)) return;
    void Promise.resolve()
      .then(() => {
        if (!isCurrentIdentity(generation, sessionManager)) return;
        return generateAndShow(ctx, reason);
      })
      .catch((err: unknown) => {
        if (isCurrentIdentity(generation, sessionManager)) console.error("[session-recap] failed:", err);
      });
  };

  const tryAwayRecap = (ctx: ExtensionContext) => {
    if (isDisabled() || !hasInteractiveUi(ctx) || !isBlurred || !ownsSession(ctx)) return;
    if (agentActive && !pi.getFlag("recap-during-active")) {
      awayRecapPending = true;
      return;
    }
    if (!activeController) {
      const generation = sessionGeneration;
      const sessionManager = ctx.sessionManager;
      runGenerationSafely(ctx, "focus", generation, sessionManager);
    }
  };

  const handleFocusOut = (ctx: ExtensionContext) => {
    if (!ownsSession(ctx)) return;
    focusEventsSeen = true;
    isBlurred = true;
    clearIdleTimer();
    if (isDisabled()) return;
    clearAwayTimer();

    const generation = sessionGeneration;
    const sessionManager = ctx.sessionManager;
    const timer = setTimeout(
      () => {
        if (awayTimer === timer) awayTimer = undefined;
        if (!isCurrentIdentity(generation, sessionManager)) return;
        tryAwayRecap(ctx);
      },
      flagMilliseconds("recap-away-seconds", DEFAULT_AWAY_SECONDS),
    );
    awayTimer = timer;
  };

  const handleFocusIn = () => {
    focusEventsSeen = true;
    isBlurred = false;
    awayRecapPending = false;
    clearAwayTimer();
    clearPostTurnTimer();
    clearIdleTimer();
    // Leave an in-flight recap to land as the user returns.
  };

  const attachFocusReporting = (ctx: ExtensionContext) => {
    if (focusEnabled || pi.getFlag("recap-disable-focus") || !hasInteractiveUi(ctx)) return;
    if (!process.stdout.isTTY || !process.stdin.isTTY) return;

    try {
      process.stdout.write(FOCUS_ENABLE);
    } catch {
      return;
    }

    // Focus sequences may straddle input chunks, so retain the unmatched tail.
    const MAX_SEQ = Math.max(FOCUS_IN_SEQ.length, FOCUS_OUT_SEQ.length);
    let buf = "";
    const listener = (chunk: Buffer) => {
      buf += chunk.toString("binary");
      let i = 0;
      while (i + MAX_SEQ <= buf.length) {
        if (buf.startsWith(FOCUS_IN_SEQ, i)) {
          handleFocusIn();
          i += FOCUS_IN_SEQ.length;
        } else if (buf.startsWith(FOCUS_OUT_SEQ, i)) {
          handleFocusOut(ctx);
          i += FOCUS_OUT_SEQ.length;
        } else {
          i++;
        }
      }
      buf = buf.slice(i);
    };
    process.stdin.on("data", listener);
    focusListener = listener;
    focusEnabled = true;
  };

  const detachFocusReporting = () => {
    if (focusListener) {
      process.stdin.off("data", focusListener);
      focusListener = undefined;
    }
    if (focusEnabled) {
      try {
        process.stdout.write(FOCUS_DISABLE);
      } catch {}
      focusEnabled = false;
    }
    isBlurred = false;
    awayRecapPending = false;
  };

  pi.on("turn_end", (_event, ctx) => {
    if (isDisabled() || !hasRecapUi(ctx) || !ownsSession(ctx)) return;

    // Debounce mid-loop turn_end → turn_start pairs.
    const generation = sessionGeneration;
    const sessionManager = ctx.sessionManager;
    if (ctx.mode === "tui" && isBlurred) {
      clearPostTurnTimer();
      const timer = setTimeout(() => {
        if (postTurnTimer === timer) postTurnTimer = undefined;
        if (!isCurrentIdentity(generation, sessionManager)) return;
        tryAwayRecap(ctx);
      }, POST_TURN_DEBOUNCE_MS);
      postTurnTimer = timer;
    }

    if (!focusEventsSeen) {
      clearIdleTimer();
      const timer = setTimeout(
        () => {
          if (idleTimer === timer) idleTimer = undefined;
          if (!isCurrentIdentity(generation, sessionManager)) return;
          if (!focusEventsSeen) runGenerationSafely(ctx, "idle", generation, sessionManager);
        },
        flagMilliseconds("recap-idle-seconds", DEFAULT_IDLE_SECONDS),
      );
      idleTimer = timer;
    }
  });

  pi.on("turn_start", () => {
    clearIdleTimer();
    clearPostTurnTimer();
    cancelActive();
  });

  pi.on("input", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    clearIdleTimer();
    clearPostTurnTimer();
    clearAwayTimer();
    cancelActive();
    awayRecapPending = false;
    clearRecap(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    agentActive = true;
    clearIdleTimer();
    clearPostTurnTimer();
    cancelActive();
    clearRecap(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    agentActive = false;
    if (awayRecapPending) {
      awayRecapPending = false;
      tryAwayRecap(ctx);
    }
  });

  const resetSessionState = (ctx: ExtensionContext): boolean => {
    if (!ownsSession(ctx)) return false;
    sessionGeneration += 1;
    agentActive = false;
    awayRecapPending = false;
    lastDraftedContext = undefined;
    clearIdleTimer();
    clearAwayTimer();
    clearPostTurnTimer();
    clearResumeTimer();
    cancelActive();
    clearRecap(ctx);
    return true;
  };

  // Successful replacements emit session_shutdown after before-handlers;
  // cancelled before-events require no state mutation.
  pi.on("session_shutdown", (_event, ctx) => {
    if (!resetSessionState(ctx)) return;
    sessionIdentityBound = true;
    detachFocusReporting();
    activeSessionManager = undefined;
  });

  pi.on("session_tree", (_event, ctx) => {
    if (!resetSessionState(ctx)) return;
    // A tree navigation keeps the same manager but starts a new recap identity.
    sessionIdentityBound = true;
    activeSessionManager = ctx.sessionManager;
  });

  pi.on("session_start", (event, ctx) => {
    // A new context supersedes any late callbacks from the previous session.
    detachFocusReporting();
    sessionIdentityBound = true;
    activeSessionManager = ctx.sessionManager;
    resetSessionState(ctx);
    focusEventsSeen = false;
    isBlurred = false;
    attachFocusReporting(ctx);
    if (isDisabled() || !hasRecapUi(ctx)) return;
    if (event.reason === "resume" || event.reason === "fork") {
      const generation = sessionGeneration;
      const sessionManager = ctx.sessionManager;
      const timer = setTimeout(() => {
        if (resumeTimer === timer) resumeTimer = undefined;
        if (!isCurrentIdentity(generation, sessionManager)) return;
        runGenerationSafely(ctx, "resume", generation, sessionManager);
      }, 300);
      resumeTimer = timer;
    }
  });

  pi.registerCommand("recap", {
    description: "Generate a recap of recent session activity",
    handler: (_args, ctx) => generateAndShow(ctx, "manual"),
  });
}
