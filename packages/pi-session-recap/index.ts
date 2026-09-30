/**
 * Drafts a short Claude Code-style recap after the user has been away.
 * See README.md for triggers, flags, and model selection.
 */

import type { Message } from "@earendil-works/pi-ai";
import { complete, completeSimple } from "@earendil-works/pi-ai/compat";
import {
  type ContextEditEntry,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  type ProjectedSessionEntry,
  type SessionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text, type TUI, truncateToWidth } from "@earendil-works/pi-tui";

type Model = Parameters<typeof completeSimple>[0];

type RecapContext = {
  messages: Message[];
  broaderContext?: string;
};

type RecapGeneration = { kind: "recap"; text: string } | { kind: "endpoint-mismatch" };

type RecapReason = "idle" | "manual" | "resume" | "focus";

const RECAP_KEY = "session-recap";

const DEFAULT_AWAY_SECONDS = 90;
const DEFAULT_IDLE_SECONDS = 120;
// Give the UI a moment after final agent settlement while blurred before drafting.
const POST_SETTLE_DEBOUNCE_MS = 3000;

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

function extractText(content: Message["content"] | null | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function findInitialTask(entries: SessionEntry[]): string | undefined {
  // The original request can predate compaction, so look on the active branch,
  // applying its latest edit rather than recovering discarded prompt text.
  const edits = new Map<string, ContextEditEntry["replacement"]>();
  for (const entry of entries) {
    if (entry.type === "context_edit") edits.set(entry.targetId, entry.replacement);
  }

  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const replacement = edits.get(entry.id);
    if (replacement === null) continue;
    const task = extractText(replacement?.content ?? entry.message.content).trim();
    if (task) return task;
  }
  return undefined;
}

/** Pi 0.84–0.86 do not expose projections; those hosts have no context edits. */
function projectedEntries(manager: ExtensionContext["sessionManager"]): ProjectedSessionEntry[] {
  if (typeof manager.buildSessionProjection === "function") return manager.buildSessionProjection().entries;
  return manager.buildContextEntries().map((sourceEntry) => ({
    sourceEntry,
    messages: sessionEntryToContextMessages(sourceEntry),
  }));
}

export function buildRecapContext(entries: ProjectedSessionEntry[], branchEntries: SessionEntry[]): RecapContext {
  let summary: string | undefined;
  // Pi places the active compaction first; an older checkpoint may also be
  // retained after it on legacy hosts, but must not replace its summary.
  const activeCompactionId = entries.find(({ sourceEntry }) => sourceEntry.type === "compaction")?.sourceEntry.id;
  // Keep first positions: findIndex also selects the first occurrence when a
  // malformed/legacy branch repeats an ID. Missing IDs retain -1 semantics.
  const branchPositions = new Map<string, number>();
  branchEntries.forEach((entry, index) => {
    if (!branchPositions.has(entry.id)) branchPositions.set(entry.id, index);
  });
  const activeCompactionPosition =
    activeCompactionId === undefined ? -1 : (branchPositions.get(activeCompactionId) ?? -1);
  for (const { sourceEntry, messages } of entries) {
    if (sourceEntry.type !== "compaction" && sourceEntry.type !== "branch_summary") continue;
    if (sourceEntry.type === "compaction" && sourceEntry.id !== activeCompactionId) continue;
    // A newer checkpoint may retain an older branch summary after it in Pi's
    // projected order. Only summaries following that checkpoint may override it.
    if (
      sourceEntry.type === "branch_summary" &&
      activeCompactionPosition >= 0 &&
      (branchPositions.get(sourceEntry.id) ?? -1) < activeCompactionPosition
    )
      continue;
    if (messages.length > 0) summary = sourceEntry.summary.trim() || summary;
  }

  const initialTask = findInitialTask(branchEntries);
  const messages = convertToLlm(
    entries
      .filter(({ sourceEntry }) => sourceEntry.type !== "compaction" && sourceEntry.type !== "branch_summary")
      .flatMap(({ messages }) => messages),
  )
    // Projected system messages carry the parent prompt and tool declarations.
    // The recap is an independent provider request, not a continuation of that agent.
    .filter((message) => message.role !== "system")
    .map((message) => {
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
  // Filter before taking the window: Pi's provider transform drops incomplete
  // assistants, and their raw entries should not displace earlier completed work.
  // A context edit may also leave a result without its call. Only keep the first
  // result for each call, as additional results would be invalid OpenAI `tool`
  // messages even when Pi's projection retains them.
  const pendingToolCalls = new Set<string>();
  const visibleMessages = messages.filter((message) => {
    if (message.role === "user") {
      pendingToolCalls.clear();
    } else if (message.role === "assistant") {
      pendingToolCalls.clear();
      if (message.stopReason === "aborted" || message.stopReason === "error") return false;
      for (const block of message.content) {
        if (block.type === "toolCall") pendingToolCalls.add(block.id);
      }
    } else if (message.role === "toolResult") {
      if (!pendingToolCalls.delete(message.toolCallId)) return false;
    }
    return true;
  });
  const start = Math.max(0, visibleMessages.length - RECENT_MESSAGE_WINDOW);
  let recentMessages = visibleMessages.slice(start);
  if (recentMessages[0]?.role === "toolResult") {
    // The suffix begins inside a result run. Reach back to its assistant, but
    // replace one result rather than widening the message window arbitrarily.
    let callIndex = start - 1;
    while (callIndex >= 0 && visibleMessages[callIndex].role === "toolResult") callIndex--;
    const call = visibleMessages[callIndex];
    if (call?.role === "assistant") {
      const results = recentMessages.slice(1);
      const selectedIds = new Set<string>();
      for (const message of results) {
        if (message.role !== "toolResult") break;
        selectedIds.add(message.toolCallId);
      }
      // Without this trim, Pi would synthesize results for omitted calls on the
      // provider wire, defeating the bound (and obscuring the retained results).
      // If only one result from this run was in the suffix, dropping it leaves
      // no call to anchor; keep the later messages without an empty assistant.
      recentMessages = selectedIds.size
        ? [
            {
              ...call,
              content: call.content.filter((block) => block.type !== "toolCall" || selectedIds.has(block.id)),
            },
            ...results,
          ]
        : results;
    }
  }
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

export function hasMeaningfulActivity(entries: ProjectedSessionEntry[]): boolean {
  // Conversion makes custom messages and summaries look like user turns. Only an
  // actual, model-visible user request starts a new activity window.
  let lastUserIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const { sourceEntry, messages } = entries[i];
    if (
      sourceEntry.type === "message" &&
      sourceEntry.message.role === "user" &&
      messages.some((m) => m.role === "user")
    ) {
      lastUserIdx = i;
      break;
    }
  }

  let assistantWords = 0;
  for (const { sourceEntry, messages } of entries.slice(lastUserIdx + 1)) {
    // Only model-visible summaries count; older retained compactions and
    // context-edited omissions project no messages.
    if (
      (sourceEntry.type === "compaction" || sourceEntry.type === "branch_summary") &&
      messages.length > 0 &&
      sourceEntry.summary.trim()
    )
      return true;
    // Pi's provider transform discards incomplete assistant turns altogether;
    // their partial words and tool calls are not model-visible work.
    if (
      sourceEntry.type === "message" &&
      sourceEntry.message.role === "assistant" &&
      (sourceEntry.message.stopReason === "aborted" || sourceEntry.message.stopReason === "error")
    )
      continue;
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      if (message.content.some((block) => block.type === "toolCall")) return true;
      assistantWords += extractText(message.content).split(/\s+/).filter(Boolean).length;
    }
  }
  return assistantWords >= MIN_ASSISTANT_WORDS;
}

export function selectRecapModel(
  target: string | undefined,
  registry: Pick<ExtensionContext["modelRegistry"], "find">,
): Model | undefined {
  // Consent must name the actual physical destination. Never fall back to the
  // active model (or a cheaper model) if the target is absent or unavailable.
  const slash = target?.indexOf("/") ?? -1;
  if (!target || slash <= 0 || slash === target.length - 1) return undefined;
  const selected = registry.find(target.slice(0, slash), target.slice(slash + 1));
  // Pi can route virtual models only within its own request runtime.
  return selected?.api === "pi-virtual" ? undefined : selected;
}

async function generateRecap(
  recapContext: RecapContext,
  ctx: ExtensionContext,
  model: Model,
  signal: AbortSignal | undefined,
  isCurrent: () => boolean,
): Promise<RecapGeneration | undefined> {
  // Ambient-auth providers can succeed without returning an API key.
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (signal?.aborted || !isCurrent() || !auth?.ok) return undefined;

  // Auth can redirect a registered model to a different physical endpoint.
  // Naming provider/model-id does not consent to that destination, and this
  // independent request cannot use the parent's post-hook redacted context.
  if (auth.baseUrl && auth.baseUrl !== model.baseUrl) return { kind: "endpoint-mismatch" };

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

  // Auth may have resolved after input, a session transition, or a context edit.
  // Reproject before either completion path can dispatch the original context.
  if (signal?.aborted || !isCurrent()) return undefined;

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

  return text ? { kind: "recap", text } : undefined;
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
    description: "Idle-fallback: seconds after agent_settled before a recap when the terminal doesn't report focus",
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
    description: "Physical destination for recap history, e.g. anthropic/claude-sonnet-4-6",
    type: "string",
    default: "",
  });
  pi.registerFlag("recap-allow-raw-history", {
    description: "Allow sending unredacted session history to --recap-model (required for all recaps)",
    type: "boolean",
    default: false,
  });

  let idleTimer: NodeJS.Timeout | undefined;
  let awayTimer: NodeJS.Timeout | undefined;
  let postSettleTimer: NodeJS.Timeout | undefined;
  let resumeTimer: NodeJS.Timeout | undefined;
  let activeController: AbortController | undefined;
  let agentActive = false;
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
  const hasRawHistoryConsent = (): boolean => pi.getFlag("recap-allow-raw-history") === true;
  const recapTarget = (): string => String(pi.getFlag("recap-model") ?? "").trim();
  const automaticEnabled = (): boolean => !isDisabled() && hasRawHistoryConsent() && Boolean(recapTarget());

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
  const clearPostSettleTimer = () => {
    if (postSettleTimer) {
      clearTimeout(postSettleTimer);
      postSettleTimer = undefined;
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

    // A context hook can redact only the parent request, not this independent
    // completion. Projected SessionManager entries are pre-hook, unredacted history.
    const target = recapTarget();
    const consent = hasRawHistoryConsent();
    const model = consent ? selectRecapModel(target, ctx.modelRegistry) : undefined;
    if (!model) {
      if (reason === "manual") {
        try {
          ctx.ui.notify(
            !consent || !target
              ? 'Recap sends raw session history. To enable it, set --recap-allow-raw-history and --recap-model "provider/model-id" to a physical destination.'
              : 'Recap target is unavailable or virtual. Set --recap-model "provider/model-id" to an available physical model.',
            "warning",
          );
        } catch {
          // The UI may have closed before the command could report the skip.
        }
      }
      return;
    }
    const activeModel = ctx.model;
    const stillAuthorized = () => {
      // Real ModelRegistry.find returns a fresh object on each lookup; compare the
      // actual wire destination rather than object identity after async auth.
      const currentTarget = selectRecapModel(target, ctx.modelRegistry);
      return (
        hasRawHistoryConsent() &&
        recapTarget() === target &&
        currentTarget?.provider === model.provider &&
        currentTarget?.id === model.id &&
        currentTarget?.api === model.api &&
        currentTarget?.baseUrl === model.baseUrl &&
        ctx.model?.provider === activeModel?.provider &&
        ctx.model?.id === activeModel?.id &&
        ctx.model?.api === activeModel?.api
      );
    };

    const entries = projectedEntries(sessionManager);
    if (reason !== "manual" && !hasMeaningfulActivity(entries)) return;

    const recapContext = buildRecapContext(entries, sessionManager.getBranch());
    if (recapContext.messages.length === 0 && !recapContext.broaderContext) return;

    const startContext = JSON.stringify(recapContext);
    if (reason !== "manual" && lastDraftedContext === startContext) return;

    cancelActive();
    const controller = new AbortController();
    activeController = controller;

    const showStatus = reason === "manual" || reason === "idle";
    if (showStatus) setRecapStatus(ctx, "✦ drafting recap…");

    try {
      const result = await generateRecap(recapContext, ctx, model, controller.signal, () => {
        if (!isCurrentIdentity(generation, sessionManager) || !stillAuthorized()) return false;
        const currentEntries = projectedEntries(sessionManager);
        if (reason !== "manual" && !hasMeaningfulActivity(currentEntries)) return false;
        return JSON.stringify(buildRecapContext(currentEntries, sessionManager.getBranch())) === startContext;
      });
      if (!isCurrentIdentity(generation, sessionManager) || !stillAuthorized() || controller.signal.aborted) return;
      if (result?.kind === "endpoint-mismatch") {
        if (reason === "manual") {
          try {
            ctx.ui.notify(
              "Recap skipped: authentication resolved a different endpoint than the named model's registered base URL. No history was sent; choose a physical model whose endpoints match.",
              "warning",
            );
          } catch {
            // The UI may have closed before the command could report the skip.
          }
        }
        return;
      }
      if (!result) return;

      const currentEntries = projectedEntries(sessionManager);
      if (reason !== "manual" && !hasMeaningfulActivity(currentEntries)) return;
      const currentContext = buildRecapContext(currentEntries, sessionManager.getBranch());
      if (!isCurrentIdentity(generation, sessionManager) || JSON.stringify(currentContext) !== startContext) return;

      lastDraftedContext = startContext;
      clearIdleTimer();
      clearPostSettleTimer();
      showRecap(ctx, result.text);
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
    if (!automaticEnabled() || !hasInteractiveUi(ctx) || !isBlurred || !ownsSession(ctx)) return;
    if (agentActive && !pi.getFlag("recap-during-active")) {
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
    if (!automaticEnabled()) return;
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
    clearAwayTimer();
    clearPostSettleTimer();
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
  };

  pi.on("turn_start", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    clearIdleTimer();
    clearPostSettleTimer();
    cancelActive();
  });

  pi.on("input", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    clearIdleTimer();
    clearPostSettleTimer();
    clearAwayTimer();
    cancelActive();
    clearRecap(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    agentActive = true;
    clearIdleTimer();
    clearPostSettleTimer();
    cancelActive();
    clearRecap(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    agentActive = false;
    // A later agent_settled handler may queue another turn. Do not start a
    // provider request in the middle of the notification dispatch; the blurred
    // post-settlement timer below gives that continuation time to begin.
    if (!automaticEnabled() || !hasRecapUi(ctx)) return;

    // Unlike agent_end / turn_end, settlement follows retries, compaction and
    // queued work, so neither automatic timer starts from an intermediate run.
    const generation = sessionGeneration;
    const sessionManager = ctx.sessionManager;
    if (ctx.mode === "tui" && isBlurred) {
      // The blur threshold can expire during the settlement debounce. Let the
      // settled path own the recap so later handlers can queue a continuation.
      clearAwayTimer();
      clearPostSettleTimer();
      const timer = setTimeout(() => {
        if (postSettleTimer === timer) postSettleTimer = undefined;
        if (!isCurrentIdentity(generation, sessionManager)) return;
        tryAwayRecap(ctx);
      }, POST_SETTLE_DEBOUNCE_MS);
      postSettleTimer = timer;
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

  const resetSessionState = (ctx: ExtensionContext): boolean => {
    if (!ownsSession(ctx)) return false;
    sessionGeneration += 1;
    agentActive = false;
    lastDraftedContext = undefined;
    clearIdleTimer();
    clearAwayTimer();
    clearPostSettleTimer();
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
    if (!automaticEnabled() || !hasRecapUi(ctx)) return;
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
