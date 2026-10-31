import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model, Tool } from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
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
import { authorizeCanonicalHistory } from "./authorization.js";
import { requestBoundedCompaction } from "./bounded-compaction.js";
import {
  buildReplacementHistory,
  CHECKPOINT_KIND,
  type CodexCheckpointDetails,
  checkpointMarker,
  checkpointMarkerVariants,
  createCheckpointDetails,
  fallbackSummary,
  fallbackSummaryVariants,
  parseCheckpointDetails,
  projectCheckpointContext,
} from "./checkpoint.js";
import { createDiagnosticTrace, diagnosticSummary, readLastDiagnostic } from "./diagnostics.js";
import {
  type CompactionCancellationCode,
  type CompactionFailure,
  type CompactionFailureCode,
  compactionAbortError,
  compactionError,
  compactionFailure,
  failureFrom,
  formatCompactionCancellation,
  formatCompactionFailure,
} from "./failure.js";
import { PreparationBranchFence } from "./preparation-branch.js";
import { hasCheckpointMarker, rewriteCheckpointMarker } from "./protocol.js";
import { createRecoveryCommand } from "./recovery-command.js";
import {
  type CodexCompactSettings,
  type CodexCompactSettingsRuntime,
  type CodexCompactSettingsState,
  createCodexCompactSettingsRuntime,
  effectiveStageTimeoutMs,
} from "./settings.js";
import { showCodexCompactMenu } from "./settings-menu.js";
import { comparableTools, sameTools, ToolStateTracker } from "./tool-state.js";

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
  "Codex remote compaction is experimental; full replay requires this extension and the same openai-codex model.";

function isSupportedModel(model: Model<Api> | undefined): model is Model<"openai-codex-responses"> {
  return model?.provider === "openai-codex" && piAi.hasApi(model, "openai-codex-responses");
}

function activeCompaction(entries: SessionEntry[]) {
  // Pi places the effective compaction first, before any retained older entries.
  // Searching raw history (or scanning this list backwards) can resurrect a
  // superseded remote checkpoint after native fallback.
  const entry = buildContextEntries(entries, entries.at(-1)?.id ?? null)[0];
  return entry?.type === "compaction" ? entry : undefined;
}

function isOpaqueCompaction(entry: ReturnType<typeof activeCompaction>): boolean {
  if (!entry) return false;
  const details = entry.details;
  if (details && typeof details === "object" && "kind" in details && details.kind === CHECKPOINT_KIND) return true;
  // Missing details still have a recognizable complete portability summary.
  // A native summary discussing checkpoints may share the introduction; that
  // alone must not prevent future compaction of readable context.
  const prefix = "OpenAI Codex Remote Compaction V2 checkpoint ";
  if (!entry.summary.startsWith(prefix)) return false;
  const end = entry.summary.indexOf(" stores the older history opaquely.", prefix.length);
  if (end < 0) return false;
  return fallbackSummaryVariants(entry.summary.slice(prefix.length, end)).includes(entry.summary);
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

// Pi 0.87 exposes the canonical context-edit projection; older supported hosts
// have only raw context entries and must continue using that legacy path.
const piCodingAgentCompat: { buildSessionProjection?: typeof piCodingAgent.buildSessionProjection } = piCodingAgent;
const piAiCompat: {
  getCurrentSystemMessage?: typeof piAi.getCurrentSystemMessage;
  getCurrentSystemPrompt?: typeof piAi.getCurrentSystemPrompt;
  getCurrentTools?: typeof piAi.getCurrentTools;
} = piAi;

function keptMessages(event: SessionBeforeCompactEvent): AgentMessage[] {
  const leafId = event.branchEntries.at(-1)?.id ?? null;
  const projection = piCodingAgentCompat.buildSessionProjection?.(event.branchEntries, leafId);
  if (projection) {
    // The cut point is a raw entry ID even when its model-visible contribution
    // was omitted or replaced. Keep its position; fingerprint only projected messages.
    const keptIndex = projection.entries.findIndex(
      (entry) => entry.sourceEntry.id === event.preparation.firstKeptEntryId,
    );
    if (keptIndex < 0) throw new Error("Pi compaction cut point is not present in the active context");
    // appendCompaction snapshots the resolved system state on the new compaction
    // entry; it does not retain earlier system entries from this raw cut point.
    return projection.entries
      .slice(keptIndex)
      .flatMap((entry) => entry.messages)
      .filter((message) => message.role !== "system");
  }
  const contextEntries = buildContextEntries(event.branchEntries, leafId);
  const keptIndex = contextEntries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
  if (keptIndex < 0) throw new Error("Pi compaction cut point is not present in the active context");
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

function transcriptMatchesLiveState(
  messages: AgentMessage[],
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  toolState: ToolStateTracker,
): boolean {
  // Older Pi hosts have no persisted system/tool projection: their provider
  // still uses the live shorthand, so retain that legacy compaction path.
  if (!piCodingAgentCompat.buildSessionProjection) return true;
  const { getCurrentSystemPrompt, getCurrentTools } = piAiCompat;
  if (!getCurrentSystemPrompt || !getCurrentTools) return false;
  return (
    toolState.matchesPrompt(ctx.sessionManager, ctx.sessionManager.getSessionId(), {
      canonical: getCurrentSystemPrompt(messages),
      effective: ctx.getSystemPrompt(),
    }) &&
    toolState.matches(
      ctx.sessionManager,
      ctx.sessionManager.getSessionId(),
      comparableTools(getCurrentTools(messages)),
      activeTools(pi),
    )
  );
}

function sessionStateMatchesRequest(
  messages: AgentMessage[],
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  sourceBranch: PreparationBranchFence,
  toolState: ToolStateTracker,
): boolean {
  if (!transcriptMatchesLiveState(messages, pi, ctx, toolState)) return false;
  const branch = ctx.sessionManager.getBranch();
  const currentLeafId = ctx.sessionManager.getLeafId ? ctx.sessionManager.getLeafId() : (branch.at(-1)?.id ?? null);
  if (!sourceBranch.matches(branch, currentLeafId)) return false;
  if (!piCodingAgentCompat.buildSessionProjection) return true;
  const latest = buildSessionContext(branch, currentLeafId).messages;
  return transcriptMatchesLiveState(latest, pi, ctx, toolState);
}

function projectedCurrentMessages(
  branchEntries: SessionEntry[],
  model: Model<"openai-codex-responses">,
): { messages: AgentMessage[]; transcript: AgentMessage[]; prior?: CodexCheckpointDetails } {
  const leafId = branchEntries.at(-1)?.id ?? null;
  const session = buildSessionContext(branchEntries, leafId);
  const compaction = activeCompaction(branchEntries);
  const prior = parseCheckpointDetails(compaction?.details);
  if (!prior) {
    if (isOpaqueCompaction(compaction)) {
      throw compactionError("checkpoint_malformed");
    }
    return { messages: session.messages, transcript: session.messages };
  }
  if (prior.modelId !== model.id) {
    throw compactionError("checkpoint_incompatible");
  }
  const projected = projectCheckpointContext(session.messages, prior, "full");
  if (!projected) {
    throw compactionError("checkpoint_projection_failed");
  }
  // A successful checkpoint projection changes the conversation. Pi restores
  // one resolved canonical system head after that same ordinary context hook;
  // reproduce its declaration layout here, not separate historical additions.
  // The original transcript remains authoritative for all live-state guards.
  const head = piAiCompat.getCurrentSystemMessage?.(session.messages);
  const messages = head ? [head, ...projected.filter((message) => message.role !== "system")] : projected;
  return { messages, transcript: session.messages, prior };
}

function notifyFailure(
  ctx: ExtensionContext,
  settings: CodexCompactSettings,
  failure: CompactionFailure,
  diagnostic = "",
): void {
  if (!ctx.hasUI || !settings.notifyOnFallback) return;
  try {
    ctx.ui.notify(
      `Codex remote compaction failed; using Pi compaction. ${formatCompactionFailure(failure)}${diagnostic ? ` ${diagnostic}` : ""}`,
      "warning",
    );
  } catch {
    // Diagnostic UI is best effort and must not alter the fallback decision.
  }
}

function setCompactionStatus(ctx: ExtensionContext, value: string | undefined): void {
  try {
    ctx.ui.setStatus(STATUS_KEY, value);
  } catch {
    // Progress UI must not override a compaction outcome, especially cancellation.
  }
}

function cancelOpaqueCompaction(ctx: ExtensionContext, failure: CompactionFailure, diagnostic = ""): { cancel: true } {
  try {
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Compaction cancelled to preserve the existing opaque checkpoint. ${formatCompactionFailure(failure)}${
          failure.code === "checkpoint_incompatible"
            ? " Retry with its original Codex model or recover a pre-compaction branch."
            : failure.code === "checkpoint_malformed" || failure.code === "checkpoint_projection_failed"
              ? " Recover a pre-compaction branch if the checkpoint cannot be replayed safely."
              : ""
        }${diagnostic ? ` ${diagnostic}` : ""}`,
        "warning",
      );
    }
  } catch {
    // Pi may swallow hook exceptions and continue with native compaction.
    // Notification is best effort; the cancellation result must always survive.
  }
  return { cancel: true };
}

function cancelPreparation(
  ctx: ExtensionContext,
  code: CompactionCancellationCode | CompactionFailure,
  opaque: boolean,
): { cancel: true } {
  try {
    if (ctx.hasUI) {
      ctx.ui.notify(
        `${opaque ? "Compaction cancelled to preserve the existing opaque checkpoint." : "Compaction cancelled."} ${typeof code === "string" ? formatCompactionCancellation(code) : formatCompactionFailure(code)}`,
        "warning",
      );
    }
  } catch {
    // Cancellation must remain effective even if its best-effort diagnostic fails.
  }
  return { cancel: true };
}

function sessionStillOwned(ctx: ExtensionContext, sessionId: string, signal: AbortSignal): boolean {
  return !signal.aborted && ctx.sessionManager.getSessionId() === sessionId;
}

async function awaitCompactionAuth(
  ctx: ExtensionContext,
  model: Model<"openai-codex-responses">,
  signal: AbortSignal,
  deadline: number,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  let timedOut = false;
  try {
    if (signal.aborted) throw compactionAbortError();
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      timedOut = true;
      throw compactionError("authentication_timeout");
    }
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(compactionAbortError());
      signal.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => {
        timedOut = true;
        reject(compactionError("authentication_timeout"));
      }, remainingMs);
    });
    // Race only our wait. Pi owns token refresh and persistence, which must be
    // allowed to finish after cancellation. Promise.race observes late rejection.
    const auth = await Promise.race([ctx.modelRegistry.getApiKeyAndHeaders(model), interrupted]);
    if (signal.aborted) throw compactionAbortError();
    if (performance.now() >= deadline) {
      timedOut = true;
      throw compactionError("authentication_timeout");
    }
    return auth;
  } catch {
    // Authentication errors and abort reasons can contain credentials.
    if (signal.aborted) throw compactionAbortError();
    timedOut ||= performance.now() >= deadline;
    throw compactionError(timedOut ? "authentication_timeout" : "authentication_failed");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

function modelFingerprint(model: Model<Api> | undefined): string | undefined {
  // Clone first: a model's toJSON must neither hide routing changes nor escape
  // the cancellation boundary. SDK data accessors remain supported by cloning.
  return model === undefined
    ? undefined
    : JSON.stringify([
        model.provider,
        model.api,
        model.id,
        model.baseUrl,
        structuredClone(model.headers),
        structuredClone(model),
      ]);
}

async function compactRemotely(
  pi: ExtensionAPI,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  settings: CodexCompactSettings,
  toolState: ToolStateTracker,
  ownerSignal: AbortSignal,
  fetch?: typeof globalThis.fetch,
) {
  const model = ctx.model;
  if (!settings.enabled) return undefined;
  if (event.signal.aborted || ownerSignal.aborted) return { cancel: true };
  // Protect only the effective boundary, never a historical checkpoint already
  // superseded by native compaction. Unsupported routes cannot decode opaque
  // history either: cancel before consent/auth rather than summarize its marker.
  const compaction = activeCompaction(event.branchEntries);
  const prior = parseCheckpointDetails(compaction?.details);
  if (isOpaqueCompaction(compaction) && (!prior || !isCheckpointCompatible(prior, model))) {
    return cancelOpaqueCompaction(ctx, compactionFailure(prior ? "checkpoint_incompatible" : "checkpoint_malformed"));
  }
  if (!isSupportedModel(model)) return undefined;
  const signal = AbortSignal.any([event.signal, ownerSignal]);
  const sessionId = ctx.sessionManager.getSessionId();
  const sourceBranch = new PreparationBranchFence(event.branchEntries);
  let sourceModel: string | undefined;
  let issuingModelId: string;
  try {
    issuingModelId = model.id;
    sourceModel = modelFingerprint(model);
  } catch {
    const failure = compactionFailure("payload_rejected");
    if (isOpaqueCompaction(compaction)) return cancelOpaqueCompaction(ctx, failure);
    notifyFailure(ctx, settings, failure);
    return undefined;
  }
  const isOwned = () => sessionStillOwned(ctx, sessionId, signal);
  let witnessedRequest: { canonicalPrompt: string; effectivePrompt: string; transcript?: AgentMessage[] } | undefined;
  const isCurrent = () => {
    try {
      if (!isOwned() || modelFingerprint(ctx.model) !== sourceModel) return false;
      const branch = ctx.sessionManager.getBranch();
      const leafId = ctx.sessionManager.getLeafId ? ctx.sessionManager.getLeafId() : (branch.at(-1)?.id ?? null);
      if (!sourceBranch.matches(branch, leafId)) return false;
      if (!witnessedRequest) return true;
      // Projection may retain references to mutable checkpoint system messages.
      // Compare rebuilt LIVE canonical text to an immutable string, not just an
      // old transcript or matchesPrompt's ordinary equal-view shortcut.
      const latest = buildSessionContext(branch, leafId).messages;
      return (
        piAiCompat.getCurrentSystemPrompt?.(latest) === witnessedRequest.canonicalPrompt &&
        ctx.getSystemPrompt() === witnessedRequest.effectivePrompt &&
        (!witnessedRequest.transcript || transcriptMatchesLiveState(witnessedRequest.transcript, pi, ctx, toolState))
      );
    } catch {
      return false;
    }
  };
  const cancelInvalidatedPreparation = () => {
    // Explicit abort and retired session/reload owners must not notify through
    // stale UI. Same-owner branch/model invalidation is a local cancellation.
    if (!isOwned()) return { cancel: true as const };
    let modelChanged = true;
    try {
      modelChanged = modelFingerprint(ctx.model) !== sourceModel;
    } catch {
      // Unsupported live model state cannot authorize or escape cancellation.
    }
    const branch = ctx.sessionManager.getBranch();
    const leafId = ctx.sessionManager.getLeafId ? ctx.sessionManager.getLeafId() : (branch.at(-1)?.id ?? null);
    return cancelPreparation(
      ctx,
      modelChanged
        ? "preparation_model_changed"
        : witnessedRequest && sourceBranch.matches(branch, leafId)
          ? compactionFailure("loadout_mismatch")
          : "preparation_branch_changed",
      isOpaqueCompaction(compaction),
    );
  };
  try {
    // Pin BOTH divergent views before any async consent/auth seam can turn C/E
    // into E/E. Equal-prompt and legacy operations keep their existing lifecycle.
    if (piCodingAgentCompat.buildSessionProjection && piAiCompat.getCurrentSystemPrompt) {
      const transcript = buildSessionContext(event.branchEntries, event.branchEntries.at(-1)?.id ?? null).messages;
      const canonicalPrompt = piAiCompat.getCurrentSystemPrompt(transcript);
      const effectivePrompt = ctx.getSystemPrompt();
      if (canonicalPrompt !== effectivePrompt) witnessedRequest = { canonicalPrompt, effectivePrompt };
    }
  } catch (error) {
    if (!isOwned()) return { cancel: true };
    const failure = failureFrom(error, "checkpoint_projection_failed");
    if (isOpaqueCompaction(compaction)) return cancelOpaqueCompaction(ctx, failure);
    notifyFailure(ctx, settings, failure);
    return undefined;
  }
  if (!isCurrent()) return cancelInvalidatedPreparation();
  // Native compaction also bypasses request-local filters. Lack of consent must
  // cancel, not fall through to a native summary of the same canonical history.
  if (settings.allowCanonicalHistory !== true) {
    const canAsk = ctx.mode === "tui" && ctx.hasUI;
    const authorized = await authorizeCanonicalHistory(ctx, signal);
    if (!isCurrent()) return cancelInvalidatedPreparation();
    if (!authorized) {
      return cancelPreparation(
        ctx,
        canAsk ? "canonical_consent_denied" : "canonical_consent_required",
        isOpaqueCompaction(compaction),
      );
    }
  }
  if (!isCurrent()) return cancelInvalidatedPreparation();
  const deadline = performance.now() + settings.requestTimeoutMs;
  const stageTimeoutMs = effectiveStageTimeoutMs(settings);
  const diagnostics = createDiagnosticTrace(sessionId, event.reason, {
    signal,
    operationTimeoutMs: settings.requestTimeoutMs,
    stageTimeoutMs,
  });
  diagnostics.phase("auth");
  if (ctx.mode === "tui" && ctx.hasUI) setCompactionStatus(ctx, "Codex remote compaction…");
  let phase: CompactionFailureCode = "authentication_failed";
  try {
    const effectiveBeforeAuth = piCodingAgentCompat.buildSessionProjection ? ctx.getSystemPrompt() : undefined;
    const auth = await awaitCompactionAuth(ctx, model, signal, Math.min(deadline, performance.now() + stageTimeoutMs));
    if (!isCurrent()) return cancelInvalidatedPreparation();
    if (effectiveBeforeAuth !== undefined && ctx.getSystemPrompt() !== effectiveBeforeAuth) {
      throw compactionError("loadout_mismatch");
    }
    if (!auth.ok || !auth.apiKey) {
      throw compactionError("credentials_unavailable");
    }
    phase = "provider_unavailable";
    const provider = ctx.modelRegistry.getProvider(model.provider);
    if (!provider) throw compactionError("provider_unavailable");
    const providerStream = provider.stream;
    const authResolver = ctx.modelRegistry.getApiKeyAndHeaders;
    const resolvedAuth = JSON.stringify(auth);
    const authStatus = () => JSON.stringify(ctx.modelRegistry.getProviderAuthStatus?.(model.provider));
    const sourceAuthStatus = authStatus();
    const providerIsCurrent = () =>
      ctx.modelRegistry.getProvider(model.provider) === provider &&
      provider.stream === providerStream &&
      ctx.modelRegistry.getApiKeyAndHeaders === authResolver &&
      JSON.stringify(auth) === resolvedAuth &&
      authStatus() === sourceAuthStatus;
    const requestModel = {
      ...structuredClone(model),
      // Public routing fields may be non-enumerable SDK compatibility views.
      // Preserve them explicitly rather than relying on clone enumeration.
      provider: model.provider,
      api: model.api,
      id: issuingModelId,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      headers: structuredClone(model.headers),
      baseUrl: auth.baseUrl ?? model.baseUrl,
    };
    phase = "checkpoint_projection_failed";
    const current = projectedCurrentMessages(event.branchEntries, model);
    phase = "loadout_mismatch";
    if (!sessionStateMatchesRequest(current.transcript, pi, ctx, sourceBranch, toolState)) {
      throw compactionError("loadout_mismatch");
    }
    const prompts =
      piCodingAgentCompat.buildSessionProjection && piAiCompat.getCurrentSystemPrompt
        ? { canonical: piAiCompat.getCurrentSystemPrompt(current.transcript), effective: ctx.getSystemPrompt() }
        : undefined;
    if (
      witnessedRequest &&
      (prompts?.canonical !== witnessedRequest.canonicalPrompt ||
        prompts?.effective !== witnessedRequest.effectivePrompt)
    ) {
      throw compactionError("loadout_mismatch");
    }
    if (prompts && prompts.canonical !== prompts.effective) {
      witnessedRequest = {
        canonicalPrompt: prompts.canonical,
        effectivePrompt: prompts.effective,
        transcript: current.transcript,
      };
    }
    phase = "payload_rejected";
    const requestTools = structuredClone(activeTools(pi));
    const context: Context = {
      systemPrompt: prompts?.canonical ?? ctx.getSystemPrompt(),
      messages: convertToLlm(current.messages),
      tools: requestTools,
    };
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) throw compactionError("remote_timeout");
    phase = "remote_provider_error";
    const response = await requestBoundedCompaction({
      provider,
      model: requestModel,
      context,
      isCurrent: () => {
        if (!isCurrent()) return false;
        const currentState =
          providerIsCurrent() &&
          sessionStateMatchesRequest(current.transcript, pi, ctx, sourceBranch, toolState) &&
          (!piCodingAgentCompat.buildSessionProjection || sameTools(requestTools, activeTools(pi)));
        if (!currentState) phase = "state_divergence";
        return currentState;
      },
      validatePayload: toolState.payloadValidator(ctx.sessionManager, sessionId, prompts),
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal,
      priorCheckpoint: current.prior
        ? {
            marker: checkpointMarker(current.prior.checkpointId),
            replacementHistory: current.prior.replacementHistory,
          }
        : undefined,
      requestTimeoutMs: remainingMs,
      stageTimeoutMs,
      diagnostics,
      maxRetries: settings.maxRetries,
      fetch,
    });
    if (!isCurrent()) return cancelInvalidatedPreparation();
    phase = "state_divergence";
    // appendCompaction will snapshot the session's resolved system/tool state;
    // never persist a checkpoint for a request that became stale while in flight.
    if (
      !providerIsCurrent() ||
      !sessionStateMatchesRequest(current.transcript, pi, ctx, sourceBranch, toolState) ||
      (piCodingAgentCompat.buildSessionProjection && !sameTools(requestTools, activeTools(pi)))
    ) {
      throw compactionError("state_divergence");
    }
    phase = "local_compaction_failed";
    const replacementHistory = buildReplacementHistory(response.promptInput, response.item, {
      tokenBudget: settings.replacementTokenBudget,
    });
    const details = createCheckpointDetails({
      modelId: issuingModelId,
      replacementHistory,
      keptMessages: keptMessages(event),
      // Canonical hosts persist recovery omissions before this hook. Retained
      // projected messages are full lineage, never a tail to remove afterward.
      willRetry: !piCodingAgentCompat.buildSessionProjection && event.willRetry,
    });
    if (!isCurrent()) return cancelInvalidatedPreparation();
    if (performance.now() >= deadline) throw compactionError("remote_timeout");
    // Synchronous fingerprinting/retention may outlast timer delivery too.
    if (performance.now() >= deadline) throw compactionError("remote_timeout");
    diagnostics.finish("prepared");
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
    if (!isCurrent()) {
      return cancelInvalidatedPreparation();
    }
    // Native preparation sees only this boundary's portability warning, not
    // the opaque history. Falling through would replace it with a lossy native
    // summary. Historical checkpoints superseded by a native boundary do not
    // block fallback; current malformed/incompatible opaque boundaries do.
    const failure = failureFrom(error, phase);
    diagnostics.finish(
      "failure",
      failure.code,
      failure.code === "remote_timeout" || failure.code === "authentication_timeout"
        ? performance.now() >= deadline
          ? "operation"
          : "stage"
        : "none",
    );
    const summary = diagnosticSummary(diagnostics.snapshot());
    if (isOpaqueCompaction(activeCompaction(event.branchEntries))) {
      return cancelOpaqueCompaction(ctx, failure, summary);
    }
    notifyFailure(ctx, settings, failure, summary);
    return undefined;
  } finally {
    diagnostics.finish("cancelled");
    if (!ownerSignal.aborted && ctx.mode === "tui" && ctx.hasUI && ctx.sessionManager.getSessionId() === sessionId) {
      setCompactionStatus(ctx, undefined);
    }
  }
}

export function createCodexCompactExtension(
  options: { fetch?: typeof globalThis.fetch; settingsRuntime?: CodexCompactSettingsRuntime } = {},
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const providerWarnings = new Set<string>();
    const settingsRuntime = options.settingsRuntime ?? createCodexCompactSettingsRuntime();
    const toolState = new ToolStateTracker();
    let sessionController = new AbortController();
    let generation = 0;
    let active = true;
    let experimentalWarningShown = false;
    const recovery = createRecoveryCommand(pi, settingsRuntime, {
      project: projectedCurrentMessages,
      matches: (transcript, ctx) => transcriptMatchesLiveState(transcript, pi, ctx, toolState),
      tools: () => activeTools(pi),
      authenticate: awaitCompactionAuth,
      payloadValidator: (ctx) => {
        const branch = ctx.sessionManager.getBranch();
        const transcript = buildSessionContext(branch, branch.at(-1)?.id ?? null).messages;
        const prompts =
          piCodingAgentCompat.buildSessionProjection && piAiCompat.getCurrentSystemPrompt
            ? { canonical: piAiCompat.getCurrentSystemPrompt(transcript), effective: ctx.getSystemPrompt() }
            : undefined;
        return toolState.payloadValidator(ctx.sessionManager, ctx.sessionManager.getSessionId(), prompts);
      },
      fetch: options.fetch,
    });
    // Idle recovery has its own controller; never abort unrelated agent work.
    pi.on("input", () => recovery.cancel());
    pi.on("before_agent_start", () => recovery.cancel());
    pi.on("agent_start", () => recovery.cancel());
    pi.on("session_before_tree", () => recovery.cancel());
    pi.on("session_before_switch", () => recovery.cancel());
    pi.on("session_before_fork", () => recovery.cancel());

    pi.registerCommand("codex-compact", {
      description: "Compact now or configure experimental Codex Remote Compaction V2",
      handler: async (args, ctx) => {
        if (args.trim() === "diagnostics") {
          if (ctx.mode !== "tui" || !ctx.hasUI) return;
          const ownerGeneration = generation;
          const sessionId = ctx.sessionManager.getSessionId();
          const ui = ctx.ui;
          const rows = await readLastDiagnostic(sessionId);
          if (
            !active ||
            ctx.mode !== "tui" ||
            !ctx.hasUI ||
            ctx.ui !== ui ||
            ownerGeneration !== generation ||
            sessionController.signal.aborted ||
            ctx.sessionManager.getSessionId() !== sessionId
          )
            return;
          const last = rows.at(-1);
          try {
            ctx.ui.notify(
              last
                ? `${last.outcome} [${last.error}; timeout=${last.timeoutScope}]. ${diagnosticSummary(last)}`
                : "No diagnostics available for this session.",
              "info",
            );
          } catch {
            /* Read-only, best effort UI. */
          }
          return;
        }
        if (await recovery.handle(args, ctx)) return;
        const ownerGeneration = generation;
        await showCodexCompactMenu(settingsRuntime, ctx, {
          signal: sessionController.signal,
          isCurrent: () => ownerGeneration === generation && !sessionController.signal.aborted,
          recover: () => recovery.run(ctx, sessionController.signal),
        });
      },
    });

    pi.on("session_start", async (event, ctx) => {
      active = true;
      recovery.cancel();
      toolState.reset(ctx.sessionManager);
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
        if (state.kind === "invalid") {
          ctx.ui.notify(
            `Invalid pi-codex-compact.json; using defaults without overwriting it. ${state.issue}`,
            "warning",
          );
        }
      }
    });

    pi.on("session_before_compact", (event, ctx) => {
      recovery.cancel();
      return compactRemotely(
        pi,
        event,
        ctx,
        settingsRuntime.get().settings,
        toolState,
        sessionController.signal,
        options.fetch,
      );
    });

    // Legacy hosts trim a recovery tail after compaction. Canonical hosts have
    // already persisted context edits before the hook and keep full provenance.
    pi.on("session_compact", (event, ctx) => {
      if (!active) return;
      resetTailProvenance(ctx);
      const checkpoint = activeCheckpoint(ctx);
      if (checkpoint?.entry.id === event.compactionEntry.id && ctx.hasUI && !experimentalWarningShown) {
        experimentalWarningShown = true;
        try {
          ctx.ui.notify(EXPERIMENTAL_WARNING, "warning");
        } catch {
          // An unavailable UI must not interfere with a committed checkpoint.
        }
      }
      if (
        !piCodingAgentCompat.buildSessionProjection &&
        event.willRetry &&
        checkpoint?.entry.id === event.compactionEntry.id &&
        checkpoint.details.retryTrimmedTail
      ) {
        tailProvenance.set(ctx.sessionManager, {
          checkpointId: provenanceId(ctx, checkpoint.details.checkpointId),
          mode: "runtime-omitted",
        });
      }
    });

    pi.on("session_tree", (_event, ctx) => {
      recovery.cancel();
      generation += 1;
      sessionController.abort();
      sessionController = new AbortController();
      if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
      toolState.reset(ctx.sessionManager);
      if (active) resetTailProvenance(ctx);
    });

    pi.on("context", (event, ctx) => {
      if (!active || !settingsRuntime.get().settings.enabled) return undefined;
      // Agent-core invokes context preparation for a new request. Cache warming
      // reuses the prepared context and only invokes provider callbacks.
      if (
        piCodingAgentCompat.buildSessionProjection &&
        piAiCompat.getCurrentTools &&
        piAiCompat.getCurrentSystemPrompt
      ) {
        // The public context event hides system messages. Read the canonical
        // branch, whose prepared declarations were persisted before this hook.
        const branch = ctx.sessionManager.getBranch();
        const transcript = buildSessionContext(branch, branch.at(-1)?.id ?? null).messages;
        toolState.prepare(
          ctx.sessionManager,
          ctx.sessionManager.getSessionId(),
          comparableTools(piAiCompat.getCurrentTools(transcript)),
          activeTools(pi),
          { canonical: piAiCompat.getCurrentSystemPrompt(transcript), effective: ctx.getSystemPrompt() },
        );
      }
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || !isCheckpointCompatible(checkpoint.details, ctx.model)) return undefined;
      const provenance = tailProvenance.get(ctx.sessionManager);
      const mode = piCodingAgentCompat.buildSessionProjection
        ? "full"
        : provenance?.checkpointId === provenanceId(ctx, checkpoint.details.checkpointId)
          ? provenance.mode
          : undefined;
      const messages = projectCheckpointContext(event.messages, checkpoint.details, mode);
      return messages ? { messages } : undefined;
    });

    pi.on("before_provider_request", (event, ctx) => {
      if (!active || !settingsRuntime.get().settings.enabled) return undefined;
      // A provider callback must match fresh context preparation and the actual
      // wire declarations. Warming cannot bless an unsent registry edit; remote
      // compaction's own onPayload does not establish observations.
      if (
        piCodingAgentCompat.buildSessionProjection &&
        piAiCompat.getCurrentTools &&
        piAiCompat.getCurrentSystemPrompt
      ) {
        const branch = ctx.sessionManager.getBranch();
        const transcript = buildSessionContext(branch, branch.at(-1)?.id ?? null).messages;
        toolState.observe(
          ctx.sessionManager,
          ctx.sessionManager.getSessionId(),
          comparableTools(piAiCompat.getCurrentTools(transcript)),
          activeTools(pi),
          event.payload,
          { canonical: piAiCompat.getCurrentSystemPrompt(transcript), effective: ctx.getSystemPrompt() },
        );
      }
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || !isCheckpointCompatible(checkpoint.details, ctx.model)) return undefined;
      const markers = checkpointMarkerVariants(checkpoint.details.checkpointId);
      if (!hasCheckpointMarker(event.payload, markers)) return undefined;
      return rewriteCheckpointMarker(event.payload, markers, checkpoint.details.replacementHistory);
    });

    pi.on("model_select", (event, ctx) => {
      recovery.cancel();
      if (!settingsRuntime.get().settings.enabled) return;
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || isCheckpointCompatible(checkpoint.details, event.model)) return;
      const key = `${ctx.sessionManager.getSessionId()}:${event.model.provider}:${event.model.id}`;
      if (providerWarnings.has(key)) return;
      providerWarnings.add(key);
      if (ctx.hasUI) {
        ctx.ui.notify(
          "The active Codex checkpoint cannot replay on this model; ordinary requests expose only its fallback marker and retained recent messages. Compaction is cancelled while this opaque checkpoint is active to preserve older history.",
          "warning",
        );
      }
    });

    pi.on("session_shutdown", async (event, ctx) => {
      active = false;
      recovery.cancel();
      toolState.reset(ctx.sessionManager);
      if (event.reason !== "reload") tailProvenance.delete(ctx.sessionManager);
      generation += 1;
      sessionController.abort();
      providerWarnings.clear();
      if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
      await settingsRuntime.flush();
    });
  };
}

export default createCodexCompactExtension();
