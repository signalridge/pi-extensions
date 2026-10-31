import type { Usage } from "@earendil-works/pi-ai";
import { trustedDiagnosticTrace } from "./diagnostics.js";
import { compactionAbortError, compactionError, failureFrom, isCompactionAbortError } from "./failure.js";
import type { JsonObject } from "./protocol.js";
import { type RemoteCompactionRequest, type RemoteCompactionResponse, requestRemoteCompaction } from "./remote.js";
import { planWireSegments, type WireSegments } from "./wire-segments.js";

export const MAX_FOLD_ATTEMPTS = 8;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

function addUsage(total: Usage | undefined, next: Usage): Usage {
  if (!total) return structuredClone(next);
  const result = structuredClone(total);
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) result[key] += next[key];
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
    result.cost[key] += next.cost[key];
  return result;
}

/** One operation, memory-only intermediate folds, one complete final result. */
export async function requestBoundedCompaction(
  request: Omit<RemoteCompactionRequest, "selectInput" | "beforeFetch">,
): Promise<RemoteCompactionResponse> {
  try {
    return await performBoundedCompaction(request);
  } catch (error) {
    if (isCompactionAbortError(error)) throw compactionAbortError();
    const failure = failureFrom(error, "payload_rejected");
    throw compactionError(failure.code, failure.httpStatus);
  }
}

async function performBoundedCompaction(
  request: Omit<RemoteCompactionRequest, "selectInput" | "beforeFetch">,
): Promise<RemoteCompactionResponse> {
  const diagnostics = trustedDiagnosticTrace(request.diagnostics);
  const deadline = performance.now() + (request.requestTimeoutMs ?? 900_000);
  // Bytes are only a conservative scheduling heuristic, NOT a token counter.
  const target = Math.max(1, Math.min(4 * 1024 * 1024, 3 * (request.model.contextWindow - request.model.maxTokens)));
  const identity = () => JSON.stringify([request.model, request.headers, request.env, request.apiKey]);
  const originalIdentity = identity();
  const provider = request.provider;
  const stream = provider.stream;
  const auth = { apiKey: request.apiKey, headers: structuredClone(request.headers), env: structuredClone(request.env) };
  const ownershipLost = () =>
    request.signal.aborted ||
    request.isCurrent?.() === false ||
    request.provider !== provider ||
    provider.stream !== stream ||
    identity() !== originalIdentity;
  let attempts = 0;
  let transportIdentity: string | undefined;
  let original: JsonObject[] | undefined;
  let originalBody: string | undefined;
  let plan: WireSegments | undefined;
  let cursor = 0;
  let previous: JsonObject | undefined;
  let usage: Usage | undefined;
  let ceiling = Number.POSITIVE_INFINITY;
  let backoffTarget = Number.POSITIVE_INFINITY;
  let lost = false;
  const check = () => {
    try {
      lost ||= ownershipLost();
    } catch {
      lost = true;
    }
    if (lost) throw compactionAbortError();
    if (performance.now() >= deadline) throw compactionError("remote_timeout");
  };
  while (true) {
    check();
    if (attempts >= MAX_FOLD_ATTEMPTS) throw compactionError("remote_attempt_budget_exhausted");
    let end: number | undefined;
    let sentBytes = 0;
    let fixedBytes = 0;
    try {
      diagnostics?.fold();
      const response = await requestRemoteCompaction({
        ...request,
        ...structuredClone(auth),
        requestTimeoutMs: Math.min(request.stageTimeoutMs ?? 300_000, deadline - performance.now()),
        isCurrent: () => {
          // Deadline retains its own closed diagnostic at the no-send gate.
          try {
            lost ||= ownershipLost();
          } catch {
            lost = true;
          }
          return !lost;
        },
        beforeFetch: (input, init) => {
          check();
          const transport = JSON.stringify([
            input instanceof Request ? input.url : String(input),
            init?.method,
            [...new Headers(init?.headers).entries()],
          ]);
          if (transportIdentity !== undefined && transport !== transportIdentity)
            throw compactionError("loadout_mismatch");
          transportIdentity = transport;
          if (attempts >= MAX_FOLD_ATTEMPTS) throw compactionError("remote_attempt_budget_exhausted");
          attempts++;
        },
        selectInput: (input, prepared) => {
          check();
          const serialized = JSON.stringify(prepared);
          if (originalBody === undefined) {
            originalBody = serialized;
            original = structuredClone(input);
          } else if (serialized !== originalBody) {
            throw compactionError("payload_rejected");
          }
          const bodyFor = (stop: number) => [
            ...input.slice(0, plan?.prefixEnd ?? 0),
            ...(previous ? [structuredClone(previous)] : []),
            ...input.slice(cursor, stop),
          ];
          const bytes = (selection: JsonObject[]) =>
            Buffer.byteLength(
              JSON.stringify({
                ...prepared,
                input: [...selection, { type: "compaction_trigger" }],
              }),
              "utf8",
            );
          if (end === undefined) {
            if (!plan && ceiling === Number.POSITIVE_INFINITY && bytes(input) <= target) {
              end = input.length;
            } else {
              plan ??= planWireSegments(input);
              if (!previous) cursor = plan.prefixEnd;
              const candidates = plan.ends.filter((stop) => stop > cursor && stop < ceiling);
              // A minimum atomic group may exceed the heuristic; try it intact
              // once, provided it respects the absolute request byte limit.
              end = candidates[0];
              if (end === undefined) throw compactionError("segmentation_unsupported");
              for (const stop of candidates) {
                if (bytes(bodyFor(stop)) > Math.min(target, backoffTarget)) break;
                end = stop;
              }
            }
          }
          const selected = bodyFor(end);
          sentBytes = bytes(selected);
          let prefixEnd = 0;
          while (input[prefixEnd]?.type === "additional_tools") prefixEnd++;
          fixedBytes = bytes([...input.slice(0, prefixEnd), ...(previous ? [previous] : [])]);
          if (sentBytes > MAX_REQUEST_BYTES) throw compactionError("segmentation_unsupported");
          return selected;
        },
      });
      check();
      if (!original || end === undefined || end <= cursor) throw compactionError("segmentation_unsupported");
      diagnostics?.usage(response.usage);
      diagnostics?.phase("fold_done");
      check();
      usage = addUsage(usage, response.usage);
      cursor = end;
      previous = response.item;
      if (cursor === original.length) return { item: previous, promptInput: structuredClone(original), usage };
      ceiling = Number.POSITIVE_INFINITY;
      backoffTarget = Number.POSITIVE_INFINITY;
    } catch (error) {
      check();
      if (failureFrom(error, "remote_provider_error").code !== "remote_context_window_exceeded") throw error;
      if (end === undefined || !original) throw error;
      // Strictly earlier CLOSED boundary: an identical rejected request is
      // never retried by the fold coordinator, nor is an atomic group split.
      plan ??= planWireSegments(original);
      if (!previous) cursor = plan.prefixEnd;
      const rejectedEnd = end;
      if (!plan.ends.some((stop) => stop > cursor && stop < rejectedEnd)) throw error;
      ceiling = rejectedEnd;
      // Halve NEW content rather than dropping one tiny group per rejection.
      // Declarations, the previous opaque item, and metadata are fixed costs.
      backoffTarget = fixedBytes + Math.floor((sentBytes - fixedBytes) / 2);
    }
  }
}
