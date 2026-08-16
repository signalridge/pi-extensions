import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type JsonObject, validateCompactionItem } from "./protocol.js";

export const CHECKPOINT_KIND = "pi-codex-remote-compaction";
export const CHECKPOINT_VERSION = 1;
export const REPLACEMENT_TOKEN_BUDGET = 64_000;
export const REPLACEMENT_BYTE_BUDGET = 8 * 1024 * 1024;
const MAX_MEDIA_ITEM_BYTES = 2 * 1024 * 1024;

export interface CodexCheckpointDetails {
  kind: typeof CHECKPOINT_KIND;
  version: typeof CHECKPOINT_VERSION;
  checkpointId: string;
  provider: "openai-codex";
  api: "openai-codex-responses";
  modelId: string;
  protocol: "remote-compaction-v2";
  replacementHistory: JsonObject[];
  keptMessageFingerprints: string[];
  createdAt: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function fingerprintMessage(message: AgentMessage): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(message)))
    .digest("hex");
}

const LEGACY_FALLBACK_SCOPES = ["@narumitw/pi-codex-compact"] as const;

export function checkpointMarker(checkpointId: string): string {
  return checkpointMarkerForScope(checkpointId, "@signalridge/pi-codex-compact");
}

export function checkpointMarkerVariants(checkpointId: string): readonly string[] {
  return [
    checkpointMarker(checkpointId),
    ...LEGACY_FALLBACK_SCOPES.map((scope) => checkpointMarkerForScope(checkpointId, scope)),
  ];
}

function checkpointMarkerForScope(checkpointId: string, scope: string): string {
  return [
    `[PI_CODEX_REMOTE_CHECKPOINT:${checkpointId}]`,
    "Opaque checkpoint injection failed. Do not infer missing history; tell the user to re-enable",
    `${scope} with an openai-codex model.`,
  ].join(" ");
}

export function fallbackSummary(checkpointId: string): string {
  return fallbackSummaryForScope(checkpointId, "@signalridge/pi-codex-compact");
}

/**
 * CompactionSummaryMessage contains only the rendered summary; it does not
 * retain the CompactionEntry id/details. Keep the old namespace as an exact
 * compatibility spelling rather than accepting a loose substring match.
 */
export function fallbackSummaryVariants(checkpointId: string): readonly string[] {
  return [
    fallbackSummary(checkpointId),
    ...LEGACY_FALLBACK_SCOPES.map((scope) => fallbackSummaryForScope(checkpointId, scope)),
  ];
}

function fallbackSummaryForScope(checkpointId: string, scope: string): string {
  return [
    `OpenAI Codex Remote Compaction V2 checkpoint ${checkpointId} stores the older history opaquely.`,
    `Full replay requires ${scope} and an openai-codex model.`,
    "Without them, only Pi's retained recent messages remain available.",
  ].join(" ");
}

function markerMessage(checkpointId: string, timestamp: number): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: checkpointMarker(checkpointId) }],
    timestamp,
  };
}

export function parseCheckpointDetails(value: unknown): CodexCheckpointDetails | undefined {
  if (!isObject(value)) return undefined;
  if (
    value.kind !== CHECKPOINT_KIND ||
    value.version !== CHECKPOINT_VERSION ||
    typeof value.checkpointId !== "string" ||
    value.checkpointId.length < 8 ||
    value.provider !== "openai-codex" ||
    value.api !== "openai-codex-responses" ||
    typeof value.modelId !== "string" ||
    value.protocol !== "remote-compaction-v2" ||
    !Array.isArray(value.replacementHistory) ||
    !Array.isArray(value.keptMessageFingerprints) ||
    typeof value.createdAt !== "string"
  ) {
    return undefined;
  }
  if (
    value.replacementHistory.length === 0 ||
    !value.replacementHistory.every(isObject) ||
    !value.keptMessageFingerprints.every(
      (fingerprint) => typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint),
    ) ||
    serializedBytes(value.replacementHistory) > REPLACEMENT_BYTE_BUDGET
  ) {
    return undefined;
  }
  const last = value.replacementHistory.at(-1);
  try {
    validateCompactionItem(last);
  } catch {
    return undefined;
  }
  return structuredClone(value) as unknown as CodexCheckpointDetails;
}

export function latestCheckpoint(entries: readonly SessionEntry[]):
  | {
      entry: CompactionEntry<CodexCheckpointDetails>;
      details: CodexCheckpointDetails;
    }
  | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "compaction") continue;
    const details = parseCheckpointDetails(entry.details);
    if (details) return { entry: entry as CompactionEntry<CodexCheckpointDetails>, details };
  }
  return undefined;
}

function isOlderCompactionSummary(message: AgentMessage, timestamp: number): boolean {
  return (
    message.role === "compactionSummary" &&
    Number.isFinite(message.timestamp) &&
    Number.isFinite(timestamp) &&
    message.timestamp < timestamp
  );
}

/**
 * After a RESUME, Pi replays older compaction summaries among the newest
 * checkpoint's retained messages, so the kept lineage is contiguous only modulo
 * those. Walk a fingerprint cursor and a message cursor together, stepping past
 * strictly older summaries; anything else is a genuine lineage break. The
 * timestamp guard is what keeps a newer summary from being skipped, because
 * that one really did rewrite the history this checkpoint was built from.
 */
function keptLineageEnd(
  messages: readonly AgentMessage[],
  fingerprints: readonly string[],
  keptStart: number,
  timestamp: number,
): number | undefined {
  // Each fingerprint consumes at least one message, so a tail shorter than the
  // fingerprint list can never match. Rejecting it here keeps the truncated-array
  // case O(1) instead of hashing every remaining message before giving up.
  if (messages.length - keptStart < fingerprints.length) return undefined;
  let messageIndex = keptStart;
  let fingerprintIndex = 0;
  while (fingerprintIndex < fingerprints.length) {
    if (messageIndex >= messages.length) return undefined;
    const message = messages[messageIndex];
    if (fingerprintMessage(message) === fingerprints[fingerprintIndex]) {
      messageIndex += 1;
      fingerprintIndex += 1;
      continue;
    }
    if (!isOlderCompactionSummary(message, timestamp)) return undefined;
    messageIndex += 1;
  }
  while (messageIndex < messages.length && isOlderCompactionSummary(messages[messageIndex], timestamp)) {
    messageIndex += 1;
  }
  return messageIndex;
}

export function projectCheckpointContext(
  messages: readonly AgentMessage[],
  details: CodexCheckpointDetails,
): AgentMessage[] | undefined {
  const summaries = new Set(fallbackSummaryVariants(details.checkpointId));
  // `createdAt` is the checkpoint's own authoritative birth time; the rendered summary's
  // timestamp is only where Pi happened to place the entry. Skipping is what deletes a
  // summary from the projection, so it must be bounded by whichever of the two is older.
  const createdAt = Date.parse(details.createdAt);
  // A branch can contain more than one historical rendering of the same
  // checkpoint. Search newest-first and require the persisted kept-message
  // lineage to match before replacing anything.
  for (let summaryIndex = messages.length - 1; summaryIndex >= 0; summaryIndex--) {
    const summaryMessage = messages[summaryIndex];
    if (summaryMessage?.role !== "compactionSummary" || !summaries.has(summaryMessage.summary)) continue;
    const keptEnd = keptLineageEnd(
      messages,
      details.keptMessageFingerprints,
      summaryIndex + 1,
      Number.isFinite(createdAt) ? Math.min(createdAt, summaryMessage.timestamp) : summaryMessage.timestamp,
    );
    if (keptEnd === undefined) continue;
    return [
      ...messages.slice(0, summaryIndex),
      // The marker keeps the anchor's own position, falling back to the checkpoint's
      // creation time so a session file with no usable anchor timestamp cannot emit NaN.
      markerMessage(
        details.checkpointId,
        Number.isFinite(summaryMessage.timestamp) ? summaryMessage.timestamp : createdAt || 0,
      ),
      ...messages.slice(keptEnd),
    ];
  }
  return undefined;
}

function rawText(item: JsonObject): string {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .flatMap((part) =>
      isObject(part) && typeof part.text === "string" && part.type === "input_text" ? [part.text] : [],
    )
    .join("\n");
}

function hasMedia(item: JsonObject): boolean {
  return Array.isArray(item.content) && item.content.some((part) => isObject(part) && part.type === "input_image");
}

function truncateTextItem(item: JsonObject, maxChars: number): JsonObject | undefined {
  if (!Array.isArray(item.content) || maxChars <= 32) return undefined;
  let remaining = maxChars - 16;
  const content = [...item.content].reverse().flatMap((part) => {
    if (!isObject(part) || part.type !== "input_text" || typeof part.text !== "string" || remaining <= 0) {
      return [];
    }
    const text = part.text.slice(-remaining);
    remaining -= text.length;
    return [{ ...part, text: `[truncated]\n${text}` }];
  });
  if (content.length === 0) return undefined;
  return { ...item, content: content.reverse() };
}

export function buildReplacementHistory(
  input: readonly unknown[],
  compactionItem: JsonObject,
  options: { tokenBudget?: number; byteBudget?: number } = {},
): JsonObject[] {
  const tokenBudget = options.tokenBudget ?? REPLACEMENT_TOKEN_BUDGET;
  const byteBudget = options.byteBudget ?? REPLACEMENT_BYTE_BUDGET;
  const opaque = validateCompactionItem(compactionItem);
  let remainingBytes = byteBudget - serializedBytes(opaque);
  let remainingChars = tokenBudget * 4;
  if (remainingBytes <= 0) throw new Error("Opaque compaction item exceeds replacement history budget");
  const retainedNewestFirst: JsonObject[] = [];
  const candidates = input.filter(
    (item): item is JsonObject => isObject(item) && item.role === "user" && item.type !== "compaction_trigger",
  );
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index];
    const bytes = serializedBytes(candidate);
    if (hasMedia(candidate) && bytes > MAX_MEDIA_ITEM_BYTES) continue;
    const text = rawText(candidate);
    let retained = candidate;
    if (text.length > remainingChars) {
      if (hasMedia(candidate)) continue;
      const truncated = truncateTextItem(candidate, remainingChars);
      if (!truncated) continue;
      retained = truncated;
    }
    if (serializedBytes(retained) > remainingBytes) {
      if (hasMedia(retained)) continue;
      const maxCharsByBytes = Math.max(0, remainingBytes - 128);
      const truncated = truncateTextItem(retained, Math.min(remainingChars, maxCharsByBytes));
      if (!truncated || serializedBytes(truncated) > remainingBytes) continue;
      retained = truncated;
    }
    retainedNewestFirst.push(structuredClone(retained));
    remainingBytes -= serializedBytes(retained);
    remainingChars -= Math.min(remainingChars, rawText(retained).length);
    if (remainingBytes <= 128 || remainingChars <= 32) break;
  }
  return [...retainedNewestFirst.reverse(), opaque];
}

export function createCheckpointDetails(input: {
  modelId: string;
  replacementHistory: JsonObject[];
  keptMessages: readonly AgentMessage[];
  checkpointId?: string;
  createdAt?: string;
}): CodexCheckpointDetails {
  const details: CodexCheckpointDetails = {
    kind: CHECKPOINT_KIND,
    version: CHECKPOINT_VERSION,
    checkpointId: input.checkpointId ?? randomUUID(),
    provider: "openai-codex",
    api: "openai-codex-responses",
    modelId: input.modelId,
    protocol: "remote-compaction-v2",
    replacementHistory: structuredClone(input.replacementHistory),
    keptMessageFingerprints: input.keptMessages.map(fingerprintMessage),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  const parsed = parseCheckpointDetails(details);
  if (!parsed) throw new Error("Created an invalid Codex checkpoint");
  return parsed;
}
