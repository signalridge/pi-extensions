import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, Provider, ProviderHeaders, Usage } from "@earendil-works/pi-ai";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_VERSION, type CodexCheckpointDetails, fingerprintMessage } from "./checkpoint.js";
import type { CompactionFailureCode } from "./failure.js";

// Remote-request and history-size failures after a compatible checkpoint was
// projected and credentials were resolved. Authentication, checkpoint validity,
// consent, ownership, live-state divergence and the local loadout/payload guards
// (whose unsent drift must never reach transport) keep cancelling.
const LAYERED_FAILURES: ReadonlySet<CompactionFailureCode> = new Set<CompactionFailureCode>([
  "remote_http_error",
  "remote_timeout",
  "remote_transport_error",
  "remote_provider_error",
  "remote_context_window_exceeded",
  "segmentation_unsupported",
  "remote_attempt_budget_exhausted",
  "remote_response_invalid",
  "local_compaction_failed",
]);

export function isLayeredFailure(code: CompactionFailureCode): boolean {
  return LAYERED_FAILURES.has(code);
}

/**
 * Exactly what this compaction drops past the effective checkpoint: Pi's history
 * span plus a split turn's prefix. Pi starts both after the checkpoint entry, so
 * its placeholder summary is never included; older rendered summaries are already
 * represented by the opaque item and are skipped defensively. Preparation is
 * canonical: marker-shaped user text is real history, not an injected replay marker.
 * A remote checkpoint's opaque item also covers its own kept messages, which lead
 * the span; a layered checkpoint replays them verbatim, so they are summarized.
 */
export function layeredSummaryInput(
  preparation: SessionBeforeCompactEvent["preparation"],
  prior: CodexCheckpointDetails,
): AgentMessage[] {
  const messages = [
    ...(Array.isArray(preparation.messagesToSummarize) ? preparation.messagesToSummarize : []),
    ...(preparation.isSplitTurn && Array.isArray(preparation.turnPrefixMessages) ? preparation.turnPrefixMessages : []),
  ].filter((message) => message.role !== "compactionSummary");
  if (prior.version !== CHECKPOINT_VERSION) return messages;
  let covered = 0;
  while (
    covered < messages.length &&
    covered < prior.keptMessageFingerprints.length &&
    fingerprintMessage(messages[covered]) === prior.keptMessageFingerprints[covered]
  )
    covered++;
  return messages.slice(covered);
}

export interface LayeredSummaryRequest {
  provider: Provider;
  model: Model<"openai-codex-responses">;
  messages: AgentMessage[];
  previousSummary?: string;
  customInstructions?: string;
  thinkingLevel?: ThinkingLevel;
  apiKey: string;
  headers?: ProviderHeaders;
  env?: Record<string, string>;
  signal: AbortSignal;
  isCurrent: () => boolean;
  timeoutMs: number;
  maxRetries: number;
  fetch?: typeof globalThis.fetch;
}

export type LayeredSummaryResult =
  | { ok: true; text: string; usage: Usage }
  | { ok: false; reason: "failed" | "timeout" | "aborted" };

// Pi 1.4 exports the native summarizer; older hosts keep cancel-only behavior.
const piCodingAgentCompat: {
  generateSummaryWithUsage?: typeof piCodingAgent.generateSummaryWithUsage;
} = piCodingAgent;

/**
 * One native summary request through the same provider and resolved
 * credentials as the failed remote request. Provider errors never cross this
 * boundary; only a closed reason does. An aborted or empty response fails.
 */
export async function requestLayeredSummary(request: LayeredSummaryRequest): Promise<LayeredSummaryResult> {
  const summarize = piCodingAgentCompat.generateSummaryWithUsage;
  if (request.signal.aborted) return { ok: false, reason: "aborted" };
  if (request.timeoutMs <= 0) return { ok: false, reason: "timeout" };
  if (!summarize) return { ok: false, reason: "failed" };
  const deadline = performance.now() + request.timeoutMs;
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let stopReason: string | undefined;
  let onAbort = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("Layered summary aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
  });
  void interrupted.catch(() => undefined);
  const ensureCurrent = () => {
    let current = false;
    try {
      current = request.isCurrent();
    } catch {
      // State accessors may throw secrets too; expose only a closed failure.
    }
    if (performance.now() >= deadline) timedOut = true;
    if (!current || signal.aborted || timedOut) {
      controller.abort();
      throw new Error("Layered summary is no longer current");
    }
  };
  const physicalFetch = request.fetch ?? globalThis.fetch;
  const guardedFetch: typeof globalThis.fetch = async (input, init) => {
    // Providers may retry internally without invoking streamFn again. Fence
    // every physical attempt, including when the caller supplied no fetch.
    ensureCurrent();
    return physicalFetch(input, init);
  };
  const streamFn: StreamFn = (model, context, options) => {
    ensureCurrent();
    const stream = request.provider.streamSimple(model, context, {
      ...options,
      apiKey: request.apiKey,
      headers: structuredClone(request.headers),
      env: structuredClone(request.env),
      signal,
      transport: "sse",
      timeoutMs: Math.max(1, deadline - performance.now()),
      maxRetries: request.maxRetries,
      fetch: guardedFetch,
    });
    // Pi returns an aborted response's partial text as a summary. Observe the
    // provider's own final stop reason (registered before Pi awaits it).
    stream.result().then(
      (message) => {
        stopReason = message.stopReason;
      },
      () => undefined,
    );
    return stream;
  };
  const closed = (): LayeredSummaryResult => ({
    ok: false,
    reason: request.signal.aborted ? "aborted" : timedOut || performance.now() >= deadline ? "timeout" : "failed",
  });
  try {
    ensureCurrent();
    const result = await Promise.race([
      summarize(
        request.messages,
        request.model,
        undefined,
        request.apiKey,
        undefined,
        signal,
        request.customInstructions,
        request.previousSummary,
        request.thinkingLevel,
        streamFn,
      ),
      interrupted,
    ]);
    ensureCurrent();
    if (stopReason !== "stop") return closed();
    const text = typeof result.text === "string" ? result.text.trim() : "";
    return text ? { ok: true, text, usage: result.usage } : { ok: false, reason: "failed" };
  } catch {
    return closed();
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
