import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model, Tool } from "@earendil-works/pi-ai";
import { hasApi } from "@earendil-works/pi-ai";
import {
  buildContextEntries,
  buildSessionContext,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
  buildReplacementHistory,
  CHECKPOINT_KIND,
  type CodexCheckpointDetails,
  checkpointMarker,
  checkpointMarkerVariants,
  createCheckpointDetails,
  fallbackSummary,
  parseCheckpointDetails,
  projectCheckpointContext,
} from "./checkpoint.js";
import { hasCheckpointMarker, rewriteCheckpointMarker } from "./protocol.js";
import { requestRemoteCompaction } from "./remote.js";
import {
  type CodexCompactSettings,
  type CodexCompactSettingsRuntime,
  type CodexCompactSettingsState,
  createCodexCompactSettingsRuntime,
} from "./settings.js";
import { showCodexCompactMenu } from "./settings-menu.js";

// Extension-owned reload handoff only. Weak keys retain neither sessions nor ctx;
// one scalar record per live manager, fenced by session identity + checkpoint ID.
const provenanceKey = Symbol.for("@signalridge/pi-codex-compact/retry-provenance/v1");
type TailProvenance = { checkpointId: string; mode: "full" | "runtime-omitted" };
const provenanceGlobal = globalThis as typeof globalThis & {
  [provenanceKey]?: WeakMap<object, TailProvenance>;
};
const tailProvenance = provenanceGlobal[provenanceKey] ?? new WeakMap<object, TailProvenance>();
provenanceGlobal[provenanceKey] = tailProvenance;
function provenanceId(ctx: ExtensionContext, checkpointId: string): string {
  return JSON.stringify([ctx.sessionManager.getSessionId(), checkpointId]);
}
function resetTailProvenance(ctx: ExtensionContext): void {
  tailProvenance.delete(ctx.sessionManager);
  const checkpoint = activeCheckpoint(ctx);
  if (checkpoint)
    tailProvenance.set(ctx.sessionManager, {
      checkpointId: provenanceId(ctx, checkpoint.details.checkpointId),
      mode: "full",
    });
}

const STATUS_KEY = "codex-compact";
const EXPERIMENTAL_WARNING =
  "Experimental: Codex Remote Compaction V2 uses an opaque, provider-specific checkpoint. Sessions require this extension and openai-codex for full replay.";

function isSupportedModel(model: Model<Api> | undefined): model is Model<"openai-codex-responses"> {
  return model?.provider === "openai-codex" && hasApi(model, "openai-codex-responses");
}

function activeCompaction(entries: SessionEntry[]) {
  // Pi places the effective compaction first, before any retained older entries.
  // Searching raw history (or scanning this list backwards) can resurrect a
  // superseded remote checkpoint after native fallback.
  const entry = buildContextEntries(entries, entries.at(-1)?.id ?? null)[0];
  return entry?.type === "compaction" ? entry : undefined;
}

function activeCheckpoint(ctx: ExtensionContext) {
  const entry = activeCompaction(ctx.sessionManager.getBranch());
  const details = parseCheckpointDetails(entry?.details);
  return entry && details ? { entry, details } : undefined;
}

function isCheckpointCompatible(
  details: CodexCheckpointDetails,
  model: Model<Api> | undefined,
): model is Model<"openai-codex-responses"> {
  return isSupportedModel(model) && model.id === details.modelId;
}

function keptMessages(event: SessionBeforeCompactEvent): AgentMessage[] {
  const leafId = event.branchEntries.at(-1)?.id ?? null;
  const contextEntries = buildContextEntries(event.branchEntries, leafId);
  const keptIndex = contextEntries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
  if (keptIndex < 0) {
    throw new Error("Pi compaction cut point is not present in the active context");
  }
  return contextEntries.slice(keptIndex).flatMap(sessionEntryToContextMessages);
}

function activeTools(pi: ExtensionAPI): Tool[] {
  const enabled = new Set(pi.getActiveTools());
  return pi
    .getAllTools()
    .filter((tool) => enabled.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
}

function projectedCurrentMessages(
  event: SessionBeforeCompactEvent,
  model: Model<"openai-codex-responses">,
): { messages: AgentMessage[]; prior?: CodexCheckpointDetails } {
  const leafId = event.branchEntries.at(-1)?.id ?? null;
  const session = buildSessionContext(event.branchEntries, leafId);
  const compaction = activeCompaction(event.branchEntries);
  const prior = parseCheckpointDetails(compaction?.details);
  if (!prior) {
    const details = compaction?.details;
    if (
      (details && typeof details === "object" && "kind" in details && details.kind === CHECKPOINT_KIND) ||
      compaction?.summary.startsWith("OpenAI Codex Remote Compaction V2 checkpoint ")
    ) {
      throw new Error("The active opaque checkpoint is malformed");
    }
    return { messages: session.messages };
  }
  if (prior.modelId !== model.id) {
    throw new Error("The active opaque checkpoint belongs to a different Codex model");
  }
  const projected = projectCheckpointContext(session.messages, prior, "full");
  if (!projected) {
    throw new Error("The previous opaque checkpoint could not be projected safely");
  }
  return { messages: projected, prior };
}

function notifyFailure(ctx: ExtensionContext, error: unknown, settings: CodexCompactSettings): void {
  if (!ctx.hasUI || !settings.notifyOnFallback) return;
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`Codex remote compaction failed; using Pi compaction. ${message}`, "warning");
}

function sessionStillOwned(ctx: ExtensionContext, sessionId: string, signal: AbortSignal): boolean {
  return !signal.aborted && ctx.sessionManager.getSessionId() === sessionId;
}

async function compactRemotely(
  pi: ExtensionAPI,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  settings: CodexCompactSettings,
  fetch?: typeof globalThis.fetch,
) {
  const model = ctx.model;
  if (!settings.enabled || !isSupportedModel(model)) return undefined;
  const sessionId = ctx.sessionManager.getSessionId();
  ctx.ui.setStatus(STATUS_KEY, "Codex remote compaction…");
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!sessionStillOwned(ctx, sessionId, event.signal)) return { cancel: true };
    if (!auth.ok || !auth.apiKey) {
      throw new Error(auth.ok ? "OpenAI Codex OAuth token is unavailable" : auth.error);
    }
    const provider = ctx.modelRegistry.getProvider(model.provider);
    if (!provider) throw new Error("OpenAI Codex provider is unavailable");
    const current = projectedCurrentMessages(event, model);
    const context: Context = {
      systemPrompt: ctx.getSystemPrompt(),
      messages: convertToLlm(current.messages),
      tools: activeTools(pi),
    };
    const response = await requestRemoteCompaction({
      provider,
      model,
      context,
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal: event.signal,
      priorCheckpoint: current.prior
        ? {
            marker: checkpointMarker(current.prior.checkpointId),
            replacementHistory: current.prior.replacementHistory,
          }
        : undefined,
      requestTimeoutMs: settings.requestTimeoutMs,
      maxRetries: settings.maxRetries,
      fetch,
    });
    if (!sessionStillOwned(ctx, sessionId, event.signal)) return { cancel: true };
    const replacementHistory = buildReplacementHistory(response.promptInput, response.item, {
      tokenBudget: settings.replacementTokenBudget,
    });
    const details = createCheckpointDetails({
      modelId: model.id,
      replacementHistory,
      keptMessages: keptMessages(event),
      willRetry: event.willRetry,
    });
    return {
      compaction: {
        summary: fallbackSummary(details.checkpointId),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        usage: response.usage,
        details,
      },
    };
  } catch (error) {
    if (event.signal.aborted || ctx.sessionManager.getSessionId() !== sessionId) {
      return { cancel: true };
    }
    notifyFailure(ctx, error, settings);
    return undefined;
  } finally {
    if (ctx.sessionManager.getSessionId() === sessionId) ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

export function createCodexCompactExtension(
  options: { fetch?: typeof globalThis.fetch; settingsRuntime?: CodexCompactSettingsRuntime } = {},
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const providerWarnings = new Set<string>();
    const settingsRuntime = options.settingsRuntime ?? createCodexCompactSettingsRuntime();
    let sessionController = new AbortController();
    let generation = 0;
    let active = true;

    pi.registerCommand("codex-compact", {
      description: "Compact now or configure experimental Codex Remote Compaction V2",
      handler: async (_args, ctx) => {
        const ownerGeneration = generation;
        await showCodexCompactMenu(settingsRuntime, ctx, {
          signal: sessionController.signal,
          isCurrent: () => ownerGeneration === generation && !sessionController.signal.aborted,
        });
      },
    });

    pi.on("session_start", async (event, ctx) => {
      active = true;
      if (event.reason !== "reload") resetTailProvenance(ctx);
      sessionController.abort();
      sessionController = new AbortController();
      generation += 1;
      const ownerGeneration = generation;
      const sessionId = ctx.sessionManager.getSessionId();
      providerWarnings.clear();
      let state: Readonly<CodexCompactSettingsState>;
      try {
        state = await settingsRuntime.reload(sessionController.signal);
      } catch (error) {
        if (sessionController.signal.aborted || ownerGeneration !== generation) return;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Could not load pi-codex-compact.json; using defaults. ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        }
        return;
      }
      if (
        sessionController.signal.aborted ||
        ownerGeneration !== generation ||
        ctx.sessionManager.getSessionId() !== sessionId
      ) {
        return;
      }
      if (ctx.hasUI) {
        ctx.ui.notify(EXPERIMENTAL_WARNING, "warning");
        if (state.kind === "invalid") {
          ctx.ui.notify(
            `Invalid pi-codex-compact.json; using defaults without overwriting it. ${state.issue}`,
            "warning",
          );
        }
      }
    });

    pi.on("session_before_compact", (event, ctx) =>
      compactRemotely(pi, event, ctx, settingsRuntime.get().settings, options.fetch),
    );

    // Post-compaction continuation (item 53): `session_before_compact` drives
    // the remote request, but the replay window only opens after Pi finishes
    // compaction. Observing `session_compact` keeps both sides of the
    // lifecycle handled and lets the extension re-validate the checkpoint in
    // the post-compaction context without mutating session state.
    pi.on("session_compact", (event, ctx) => {
      if (!active) return;
      resetTailProvenance(ctx);
      const checkpoint = activeCheckpoint(ctx);
      // Pi rebuilds persisted context before this event, then removes the eligible
      // tail before retry. Only this event plus validated proof establishes omission.
      if (event.willRetry && checkpoint?.entry.id === event.compactionEntry.id && checkpoint.details.retryTrimmedTail) {
        tailProvenance.set(ctx.sessionManager, {
          checkpointId: provenanceId(ctx, checkpoint.details.checkpointId),
          mode: "runtime-omitted",
        });
      }
    });

    pi.on("session_tree", (_event, ctx) => {
      if (active) resetTailProvenance(ctx);
    });

    pi.on("context", (event, ctx) => {
      if (!active || !settingsRuntime.get().settings.enabled) return undefined;
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || !isCheckpointCompatible(checkpoint.details, ctx.model)) return undefined;
      const provenance = tailProvenance.get(ctx.sessionManager);
      const mode =
        provenance?.checkpointId === provenanceId(ctx, checkpoint.details.checkpointId) ? provenance.mode : undefined;
      const messages = projectCheckpointContext(event.messages, checkpoint.details, mode);
      return messages ? { messages } : undefined;
    });

    pi.on("before_provider_request", (event, ctx) => {
      if (!settingsRuntime.get().settings.enabled) return undefined;
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || !isCheckpointCompatible(checkpoint.details, ctx.model)) return undefined;
      const markers = checkpointMarkerVariants(checkpoint.details.checkpointId);
      if (!hasCheckpointMarker(event.payload, markers)) return undefined;
      return rewriteCheckpointMarker(event.payload, markers, checkpoint.details.replacementHistory);
    });

    pi.on("model_select", (event, ctx) => {
      if (!settingsRuntime.get().settings.enabled) return;
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || isCheckpointCompatible(checkpoint.details, event.model)) return;
      const key = `${ctx.sessionManager.getSessionId()}:${event.model.provider}:${event.model.id}`;
      if (providerWarnings.has(key)) return;
      providerWarnings.add(key);
      if (ctx.hasUI) {
        ctx.ui.notify(
          "The active Codex checkpoint cannot replay on this model; Pi will expose only its fallback marker and retained recent messages.",
          "warning",
        );
      }
    });

    pi.on("session_shutdown", async (event, ctx) => {
      active = false;
      if (event.reason !== "reload") tailProvenance.delete(ctx.sessionManager);
      generation += 1;
      sessionController.abort();
      providerWarnings.clear();
      ctx.ui.setStatus(STATUS_KEY, undefined);
      await settingsRuntime.flush();
    });
  };
}

export default createCodexCompactExtension();
