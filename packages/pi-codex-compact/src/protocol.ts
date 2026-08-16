export const MAX_SSE_BYTES = 8 * 1024 * 1024;
export const MAX_COMPACTION_ITEM_BYTES = 2 * 1024 * 1024;

export type JsonObject = Record<string, unknown>;

export class CodexCompactionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexCompactionProtocolError";
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function isCompactionItem(value: unknown): value is JsonObject {
  return (
    isObject(value) &&
    value.type === "compaction" &&
    typeof value.encrypted_content === "string" &&
    value.encrypted_content.length > 0
  );
}

export function validateCompactionItem(value: unknown, maxBytes = MAX_COMPACTION_ITEM_BYTES): JsonObject {
  if (!isCompactionItem(value)) {
    throw new CodexCompactionProtocolError("Remote response did not contain a valid compaction item");
  }
  if (byteLength(value) > maxBytes) {
    throw new CodexCompactionProtocolError("Remote compaction item exceeded the size limit");
  }
  return structuredClone(value);
}

export interface CollectedCompaction {
  item: JsonObject;
  completedResponse?: JsonObject;
}

function compactionItemsFromEvent(event: JsonObject): unknown[] {
  const items: unknown[] = [];
  if (event.type === "response.output_item.done" && isObject(event.item)) {
    items.push(event.item);
  }
  if (event.type === "response.completed" && isObject(event.response)) {
    const output = event.response.output;
    if (Array.isArray(output)) items.push(...output);
  }
  return items.filter((item) => isObject(item) && item.type === "compaction");
}

export async function collectCompactionSse(
  stream: ReadableStream<Uint8Array>,
  options: {
    signal?: AbortSignal;
    maxBytes?: number;
    maxItemBytes?: number;
  } = {},
): Promise<CollectedCompaction> {
  const maxBytes = options.maxBytes ?? MAX_SSE_BYTES;
  const reader = stream.getReader();
  const onAbort = () => {
    void reader.cancel(new DOMException("Compaction aborted", "AbortError")).catch(() => undefined);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let bytes = 0;
  let pending = "";
  let dataLines: string[] = [];
  let completedResponse: JsonObject | undefined;
  const items = new Map<string, JsonObject>();

  const checkAbort = () => {
    if (options.signal?.aborted) throw new DOMException("Compaction aborted", "AbortError");
  };
  const dispatch = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    dataLines = [];
    if (data === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new CodexCompactionProtocolError("Remote compaction returned malformed SSE JSON");
    }
    if (!isObject(parsed)) return;
    if (parsed.type === "response.completed") {
      completedResponse = isObject(parsed.response) ? parsed.response : {};
    }
    for (const candidate of compactionItemsFromEvent(parsed)) {
      const item = validateCompactionItem(candidate, options.maxItemBytes);
      items.set(JSON.stringify(item), item);
    }
  };
  const processLine = (line: string) => {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    if (line === "data") dataLines.push("");
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  };

  try {
    while (true) {
      checkAbort();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new CodexCompactionProtocolError("Remote compaction stream exceeded the size limit");
      }
      pending += decoder.decode(value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const rawLine = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        processLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.decode();
    if (pending.length > 0) processLine(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
    dispatch();
    checkAbort();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  if (!completedResponse) {
    throw new CodexCompactionProtocolError("Remote compaction stream ended without response.completed");
  }
  if (items.size !== 1) {
    throw new CodexCompactionProtocolError(
      `Remote compaction returned ${items.size} distinct compaction items; expected exactly one`,
    );
  }
  return { item: [...items.values()][0], completedResponse };
}

function markerTextFromItem(item: unknown): string | undefined {
  if (!isObject(item) || item.role !== "user" || !Array.isArray(item.content)) return undefined;
  if (item.content.length !== 1) return undefined;
  const content = item.content[0];
  if (!isObject(content) || content.type !== "input_text" || typeof content.text !== "string") {
    return undefined;
  }
  return content.text;
}

type CheckpointMarker = string | readonly string[];

function markerMatches(text: string | undefined, marker: CheckpointMarker): boolean {
  return text !== undefined && (typeof marker === "string" ? text === marker : marker.includes(text));
}

export function rewriteCheckpointMarker(
  payload: unknown,
  marker: CheckpointMarker,
  replacementHistory: readonly unknown[],
): JsonObject {
  if (!isObject(payload) || !Array.isArray(payload.input)) {
    throw new CodexCompactionProtocolError("OpenAI Codex payload is missing an input array");
  }
  const matches = payload.input
    .map((item, index) => (markerMatches(markerTextFromItem(item), marker) ? index : -1))
    .filter((index) => index >= 0);
  if (matches.length !== 1) {
    throw new CodexCompactionProtocolError(
      `Provider payload contained ${matches.length} checkpoint markers; expected exactly one`,
    );
  }
  const index = matches[0];
  return {
    ...payload,
    input: [
      ...payload.input.slice(0, index),
      ...structuredClone(replacementHistory),
      ...payload.input.slice(index + 1),
    ],
  };
}

export function appendCompactionTrigger(payload: unknown): JsonObject {
  if (!isObject(payload) || !Array.isArray(payload.input)) {
    throw new CodexCompactionProtocolError("OpenAI Codex payload is missing an input array");
  }
  if (payload.input.some((item) => isObject(item) && item.type === "compaction_trigger")) {
    throw new CodexCompactionProtocolError("Provider payload already contains a compaction trigger");
  }
  return { ...payload, input: [...payload.input, { type: "compaction_trigger" }] };
}

export function prepareRemoteCompactionPayload(
  payload: unknown,
  checkpoint?: { marker: CheckpointMarker; replacementHistory: readonly unknown[] },
): JsonObject {
  const expanded = checkpoint
    ? rewriteCheckpointMarker(payload, checkpoint.marker, checkpoint.replacementHistory)
    : payload;
  return appendCompactionTrigger(expanded);
}

export function hasCheckpointMarker(payload: unknown, marker: CheckpointMarker): boolean {
  return (
    isObject(payload) &&
    Array.isArray(payload.input) &&
    payload.input.some((item) => markerMatches(markerTextFromItem(item), marker))
  );
}
