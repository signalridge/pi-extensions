/**
 * Data collection, caching, and insights for the /usage dashboard.
 *
 * Performance model (see CHANGELOG 0.4.0):
 * - Session JSONL files are scanned at the buffer level. Only lines relevant
 *   to assistant or non-message accounting are decoded and JSON.parsed. Ordinary
 *   multi-megabyte tool results are skipped; accounting-bearing large results
 *   use an allocation-safe byte parser for their small metadata fields.
 * - Per-file extraction results are persisted to an on-disk cache keyed by
 *   (size, mtimeMs). Session files are append-only, so a warm load only
 *   re-parses files that changed since the last run.
 */

import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { civilDayStart, civilHourStart, civilMonthStart } from "./civil-time.js";
import { buildObservationProofs } from "./lineage-proof.js";

export { getAgentDir };

// =============================================================================
// Types
// =============================================================================

export interface TokenStats {
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface BaseStats {
  messages: number;
  cost: number;
  tokens: TokenStats;
}

export interface ModelStats extends BaseStats {
  sessions: Set<string>;
}

export interface ProviderStats extends BaseStats {
  sessions: Set<string>;
  models: Map<string, ModelStats>;
}

export interface TotalStats extends BaseStats {
  sessions: number;
}

export interface Insight {
  /** Structure is cost-based; spend alarms require materiality, integrity alarms do not. */
  kind: "structure" | "alarm";
  /** Leading stat, already formatted (e.g. "34%", "$446", "1.4×"). */
  stat: string;
  headline: string;
  /** Dimmed follow-up line; empty string renders nothing. */
  advice: string;
}

export interface PeriodInsights {
  insights: Insight[];
}

interface CostCount {
  cost: number;
  messages: number;
}

interface PeriodRawData {
  /** All recorded cost, including non-message usage and tool/summary reports. */
  totalCost: number;
  /** Cost attached to assistant messages, used as the turn-insight denominator. */
  assistantCost: number;
  /** Cost from standalone usage entries and tool/summary reports. */
  nonAssistantCost: number;
  /** Usage reported by tool results, compactions, and branch summaries. */
  auxiliaryCost: number;
  /** Aggregates retained because a partial overlap could not be proven exactly. */
  unresolvedToolCost: number;
  /** Integrity warnings are independent of whether a report has recorded cost. */
  unresolvedToolCount: number;
  /** Messages at ≥ CTX_TAX_THRESHOLD context. */
  ctxHigh: CostCount;
  /** Messages below CTX_LOW_THRESHOLD context (comparison group). */
  ctxLow: CostCount;
  projectCosts: Map<string, number>;
  sessionCosts: Map<string, number>;
  /** Cost of each session's first-ever message falling in this period. */
  upfrontCost: number;
  /** Cache misses after >TTL_GAP_MS idle — resuming after the cache expired. */
  ttlMissCost: number;
  /** Cache misses right after a mid-session model switch (no idle gap). */
  modelSwitchMissCost: number;
  /** Cache misses with no idle gap, compaction, or model switch — true prefix changes. */
  prefixMissCost: number;
  reasoningTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  freshTokens: number;
}

/** Per-message adjacency info, computed on raw file order before dedupe. */
interface MessageMeta {
  /** Gap to the previous assistant or matching cache-warm request; -1 when unknown. */
  gapMs: number;
  /** Context size of the previous assistant message in the same file; 0 when first. */
  prevCtx: number;
  /** True when the provider/model differs from the previous assistant message. */
  modelSwitched: boolean;
  /** True for the first deduped message of a session across all its files. */
  isSessionStart: boolean;
}

export interface TrendInfo {
  /** Cost over the last 7 calendar days including today. */
  last7Cost: number;
  /** Average weekly cost over the prior 28 days. */
  priorWeeklyPace: number;
}

export interface TimeFilteredStats {
  providers: Map<string, ProviderStats>;
  totals: TotalStats;
  insights: PeriodInsights;
}

/**
 * One (provider, model, thinkingLevel) cell inside an hourly bucket.
 * Powers the graph explorer; built post-dedupe so it matches table totals.
 */
export interface HourlyCell {
  messages: number;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

/** Composite key: `${provider}\u0000${model}\u0000${thinkingLevel}` */
export type HourlyKey = string;

export const HOURLY_KEY_SEP = "\u0000";

export function makeHourlyKey(provider: string, model: string, thinkingLevel: string): HourlyKey {
  return provider + HOURLY_KEY_SEP + model + HOURLY_KEY_SEP + thinkingLevel;
}

export function splitHourlyKey(key: HourlyKey): { provider: string; model: string; thinkingLevel: string } {
  const [provider = "", model = "", thinkingLevel = ""] = key.split(HOURLY_KEY_SEP);
  return { provider, model, thinkingLevel };
}

export interface PeriodBounds {
  todayMs: number;
  weekStartMs: number;
  lastWeekStartMs: number;
  thisMonthStartMs: number;
  last30DaysStartMs: number;
  nowMs: number;
}

export interface UsageData {
  today: TimeFilteredStats;
  thisWeek: TimeFilteredStats;
  lastWeek: TimeFilteredStats;
  thisMonth: TimeFilteredStats;
  last30Days: TimeFilteredStats;
  allTime: TimeFilteredStats;
  /** Deduped usage bucketed by hour start (ms) → series key → metrics. */
  hourly: Map<number, Map<HourlyKey, HourlyCell>>;
  bounds: PeriodBounds;
}

export type TabName = "today" | "thisWeek" | "lastWeek" | "thisMonth" | "last30Days" | "allTime";

export const TAB_ORDER: TabName[] = ["today", "thisWeek", "lastWeek", "thisMonth", "last30Days", "allTime"];

export type UsageSource = "assistant" | "auxiliary" | "usage";

/** Pi's own label for usage that cannot be attributed to a provider/model. */
export const AUXILIARY_PROVIDER = "Tools";
export const AUXILIARY_MODEL = "summaries";
export const AUXILIARY_THINKING_LEVEL = "Tools/summaries";

export interface UsageAmount {
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface SessionMessage extends UsageAmount {
  provider: string;
  model: string;
  /** Thinking level active when the message was produced; "" when unknown. */
  thinkingLevel: string;
  /** Assistant response, tool/summary report, or standalone model-attributed usage. */
  source: UsageSource;
  /** Stable Pi session entry id; empty only for legacy records without one. */
  sourceId: string;
  timestamp: number;
  /**
   * True when a compaction entry occurred between this request's nearest
   * assistant ancestor and this one. Compaction legitimately changes the request prefix,
   * so such messages are excluded from prefix-change cache-miss accounting.
   */
  afterCompaction: boolean;
  /** A context edit on this request's branch intentionally changes its prefix. */
  afterContextEdit?: boolean;
  /** Concrete response model, when Pi recorded one in addition to the request alias. */
  responseModel?: string;
  /** Only cache_warm usage refreshes the TTL for its provider/model on its branch. */
  cacheWarm?: boolean;
  /** Nearest assistant ancestor's entry id (when the journal has usable lineage). */
  previousAssistantId?: string;
  /** Timestamp of the latest matching cache warm on this assistant's branch. */
  branchWarmAt?: number;
}

export interface ChildToolUsage {
  resultIndex: number;
  /** Persisted child session path when the tool supplied one; empty otherwise. */
  sessionFile: string;
  usage: UsageAmount;
}

export interface ToolUsageRecord {
  /** Parent tool-result entry id, stable across copied branch history. */
  sourceId: string;
  timestamp: number;
  /** Canonical Pi 0.81+ tool usage; null for legacy nested-agent results. */
  reportedUsage: UsageAmount | null;
  /** Run id used to derive the standard nested-session path when needed. */
  runId: string;
  /** Recognised per-child usage from nested-agent tool details. */
  children: ChildToolUsage[];
}

export interface ParsedSessionFile {
  /** Empty string when the file has no session header — such files are ignored. */
  sessionId: string;
  /** Parent session file used to establish copied-branch lineage. */
  parentSession: string;
  /** Working directory from the session header; "" when absent. */
  cwd: string;
  /** Extracted assistant and summary usage records, pre-dedupe. */
  messages: SessionMessage[];
  /** Tool usage is reconciled against recursively scanned child sessions later. */
  toolUsages: ToolUsageRecord[];
}

// =============================================================================
// Paths
// =============================================================================

/**
 * The root holding every session file Pi writes. Pi keeps default sessions in
 * per-cwd directories below `<agentDir>/sessions`, but `--session-dir`,
 * `PI_CODING_AGENT_SESSION_DIR` and the `sessionDir` setting store them flat in
 * the configured directory. Pass the active session's directory (as Pi resolved
 * it) to follow the configured location instead of re-parsing Pi's options.
 */
export function getSessionsDir(activeSessionDir?: string): string {
  const defaultRoot = join(getAgentDir(), "sessions");
  if (!activeSessionDir) return defaultRoot;
  const dir = resolve(activeSessionDir);
  return dirname(dir) === resolve(defaultRoot) ? defaultRoot : dir;
}

export function getDefaultCachePath(): string {
  return join(getAgentDir(), "usage-extension-cache.json");
}

// =============================================================================
// Session file discovery
// =============================================================================

async function collectSessionFilesRecursively(dir: string, files: string[], signal?: AbortSignal): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (signal?.aborted) return;
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await collectSessionFilesRecursively(entryPath, files, signal);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }
  } catch {
    // Skip directories we can't read
  }
}

async function getAllSessionFiles(sessionsDir: string, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  await collectSessionFilesRecursively(sessionsDir, files, signal);
  files.sort();
  return files;
}

// =============================================================================
// Session file parsing
// =============================================================================

const NEWLINE = 0x0a;

// Relevance patterns for the buffer-level pre-filter. Pi writes compact JSON
// (`"role":"assistant"`), but imported/third-party session files have been seen
// with Python-style spaced JSON (`"role": "assistant"`), so both are matched.
// False positives (e.g. a tool result quoting one of these strings verbatim)
// only cost a wasted JSON.parse — the parsed entry is still shape-checked.
const PATTERN_ASSISTANT_COMPACT = Buffer.from('"role":"assistant"');
const PATTERN_ASSISTANT_SPACED = Buffer.from('"role": "assistant"');
const PATTERN_TOOL_RESULT_COMPACT = Buffer.from('"role":"toolResult"');
const PATTERN_TOOL_RESULT_SPACED = Buffer.from('"role": "toolResult"');
const PATTERN_USAGE_COMPACT = Buffer.from('"usage":{');
const PATTERN_USAGE_SPACED = Buffer.from('"usage": {');
const PATTERN_SESSION_COMPACT = Buffer.from('"type":"session"');
const PATTERN_SESSION_SPACED = Buffer.from('"type": "session"');
const PATTERN_THINKING_COMPACT = Buffer.from('"type":"thinking_level_change"');
const PATTERN_THINKING_SPACED = Buffer.from('"type": "thinking_level_change"');
const PATTERN_COMPACTION_COMPACT = Buffer.from('"type":"compaction"');
const PATTERN_COMPACTION_SPACED = Buffer.from('"type": "compaction"');
const PATTERN_CONTEXT_EDIT_COMPACT = Buffer.from('"type":"context_edit"');
const PATTERN_CONTEXT_EDIT_SPACED = Buffer.from('"type": "context_edit"');
const PATTERN_USAGE_ENTRY_COMPACT = Buffer.from('"type":"usage"');
const PATTERN_USAGE_ENTRY_SPACED = Buffer.from('"type": "usage"');
const PATTERN_BRANCH_SUMMARY_COMPACT = Buffer.from('"type":"branch_summary"');
const PATTERN_BRANCH_SUMMARY_SPACED = Buffer.from('"type": "branch_summary"');
// pi-subagents versions predating Pi 0.81 persisted child usage in details but
// could not put it on the canonical tool-result usage field. Their tool names
// are near the start of the line, so we can recover those records without
// scanning every multi-megabyte tool result.
const PATTERN_SUBAGENT_TOOL_COMPACT = Buffer.from('"toolName":"subagent"');
const PATTERN_SUBAGENT_TOOL_SPACED = Buffer.from('"toolName": "subagent"');
const PATTERN_SUBAGENT_WAIT_TOOL_COMPACT = Buffer.from('"toolName":"subagent_wait"');
const PATTERN_SUBAGENT_WAIT_TOOL_SPACED = Buffer.from('"toolName": "subagent_wait"');

const PARSE_YIELD_EVERY_LINES = 2000;

function isThinkingLevel(value: unknown): value is string {
  return typeof value === "string" && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value);
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseUsageAmount(value: unknown): UsageAmount | null {
  if (!value || typeof value !== "object") return null;
  const persisted = value as Record<string, unknown>;
  const costValue = persisted.cost;
  const cost =
    typeof costValue === "number"
      ? finiteNumber(costValue)
      : costValue && typeof costValue === "object"
        ? finiteNumber((costValue as Record<string, unknown>).total)
        : 0;
  const usage = {
    cost,
    input: finiteNumber(persisted.input),
    output: finiteNumber(persisted.output),
    cacheRead: finiteNumber(persisted.cacheRead),
    cacheWrite: finiteNumber(persisted.cacheWrite),
    reasoning: finiteNumber(persisted.reasoning),
  };
  return usage.cost === 0 && usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0
    ? null
    : usage;
}

function parsedTimestamp(messageTimestamp: unknown, entryTimestamp: unknown): number {
  const parsed =
    typeof messageTimestamp === "number"
      ? messageTimestamp
      : new Date(String(messageTimestamp ?? entryTimestamp ?? "")).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function auxiliaryMessage(usage: UsageAmount, timestamp: number, sourceId: string): SessionMessage {
  return {
    provider: AUXILIARY_PROVIDER,
    model: AUXILIARY_MODEL,
    thinkingLevel: AUXILIARY_THINKING_LEVEL,
    source: "auxiliary",
    sourceId,
    ...usage,
    timestamp,
    afterCompaction: false,
  };
}

function standaloneUsageMessage(entry: Record<string, unknown>, thinkingLevel: string): SessionMessage | null {
  const usage = parseUsageAmount(entry.usage);
  if (
    !usage ||
    typeof entry.provider !== "string" ||
    !entry.provider ||
    typeof entry.model !== "string" ||
    !entry.model
  )
    return null;
  return {
    provider: entry.provider,
    model: entry.model,
    thinkingLevel,
    source: "usage",
    sourceId: typeof entry.id === "string" ? entry.id : "",
    ...usage,
    timestamp: parsedTimestamp(undefined, entry.timestamp),
    afterCompaction: false,
    ...(entry.kind === "cache_warm" ? { cacheWarm: true } : {}),
  };
}

function buildToolUsageRecord(
  toolName: unknown,
  detailsValue: unknown,
  reportedValue: unknown,
  sourceIdValue: unknown,
  messageTimestamp: unknown,
  entryTimestamp: unknown,
): ToolUsageRecord | null {
  const reportedUsage = parseUsageAmount(reportedValue);
  const details = detailsValue && typeof detailsValue === "object" ? (detailsValue as Record<string, unknown>) : null;
  const totalChildUsage = parseUsageAmount(details?.totalChildUsage);
  const knownNestedTool = toolName === "subagent" || toolName === "subagent_wait";
  const children: ChildToolUsage[] = [];
  if (details && Array.isArray(details.results)) {
    for (let resultIndex = 0; resultIndex < details.results.length; resultIndex++) {
      const result = details.results[resultIndex];
      if (!result || typeof result !== "object") continue;
      const child = result as Record<string, unknown>;
      const usage = parseUsageAmount(child.usage);
      const sessionFile = typeof child.sessionFile === "string" ? child.sessionFile : "";
      // Legacy fallback is deliberately restricted to recognised nested-agent
      // records. Generic Pi 0.81 tools remain canonical through reportedUsage.
      if (usage && (knownNestedTool || totalChildUsage || (reportedUsage && sessionFile))) {
        children.push({ resultIndex, sessionFile, usage });
      }
    }
  }
  if (!reportedUsage && children.length === 0) return null;
  return {
    sourceId: typeof sourceIdValue === "string" ? sourceIdValue : "",
    timestamp: parsedTimestamp(messageTimestamp, entryTimestamp),
    reportedUsage,
    runId: details && typeof details.runId === "string" ? details.runId : "",
    children,
  };
}

const LARGE_TOOL_RESULT_BYTES = 64 * 1024;
const DIRECT_ENTRY_PROPERTIES = new Set(["message", "id", "timestamp"]);
const DIRECT_MESSAGE_PROPERTIES = new Set(["toolName", "details", "usage", "timestamp"]);
const DIRECT_MESSAGE_ONLY = new Set(["message"]);
const DIRECT_USAGE_ONLY = new Set(["usage"]);
const DIRECT_CHILD_PROPERTIES = new Set(["usage", "sessionFile"]);

function skipJsonWhitespace(buffer: Buffer, offset: number, limit: number): number {
  while (
    offset < limit &&
    (buffer[offset] === 0x20 || buffer[offset] === 0x09 || buffer[offset] === 0x0a || buffer[offset] === 0x0d)
  )
    offset++;
  return offset;
}

/** Find one JSON value's end without decoding large strings or container bodies. */
function jsonValueEnd(buffer: Buffer, offset: number, limit: number): number {
  offset = skipJsonWhitespace(buffer, offset, limit);
  if (offset >= limit) return offset;
  const first = buffer[offset];
  if (first === 0x22) {
    let escaped = false;
    for (let i = offset + 1; i < limit; i++) {
      const byte = buffer[i];
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) return i + 1;
    }
    return limit;
  }
  if (first === 0x7b || first === 0x5b) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = offset; i < limit; i++) {
      const byte = buffer[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (byte === 0x5c) escaped = true;
        else if (byte === 0x22) inString = false;
        continue;
      }
      if (byte === 0x22) inString = true;
      else if (byte === 0x7b || byte === 0x5b) depth++;
      else if (byte === 0x7d || byte === 0x5d) {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return limit;
  }
  let end = offset;
  while (end < limit && buffer[end] !== 0x2c && buffer[end] !== 0x5d && buffer[end] !== 0x7d) end++;
  return end;
}

interface DirectObjectScan {
  end: number;
  values: Map<string, [start: number, end: number]>;
}

/** Scan direct object properties while skipping nested values allocation-free. */
function scanDirectObjectProperties(
  buffer: Buffer,
  objectStart: number,
  limit: number,
  wanted: Set<string>,
  stopWhenFound = false,
  decodeKeys = false,
): DirectObjectScan {
  const values = new Map<string, [number, number]>();
  let cursor = objectStart + 1;
  while (cursor < limit) {
    cursor = skipJsonWhitespace(buffer, cursor, limit);
    if (buffer[cursor] === 0x7d) return { end: cursor + 1, values };
    if (buffer[cursor] === 0x2c) {
      cursor++;
      continue;
    }
    if (buffer[cursor] !== 0x22) return { end: jsonValueEnd(buffer, objectStart, limit), values };
    const keyEnd = jsonValueEnd(buffer, cursor, limit);
    const colon = skipJsonWhitespace(buffer, keyEnd, limit);
    if (buffer[colon] !== 0x3a) return { end: jsonValueEnd(buffer, objectStart, limit), values };
    const valueStart = skipJsonWhitespace(buffer, colon + 1, limit);
    const valueEnd = jsonValueEnd(buffer, valueStart, limit);
    const key = decodeKeys
      ? (JSON.parse(buffer.toString("utf8", cursor, keyEnd)) as string)
      : buffer.toString("utf8", cursor + 1, keyEnd - 1);
    if (wanted.has(key)) values.set(key, [valueStart, valueEnd]);
    if (stopWhenFound && values.size === wanted.size) return { end: valueEnd, values };
    if (valueEnd <= valueStart) return { end: limit, values };
    cursor = valueEnd;
  }
  return { end: limit, values };
}

function parseJsonRange(buffer: Buffer, range: [number, number] | undefined): unknown {
  if (!range) return undefined;
  try {
    return JSON.parse(buffer.toString("utf8", range[0], range[1]));
  } catch {
    return undefined;
  }
}

interface ChildResultsScan {
  end: number;
  results: Array<Record<string, unknown>>;
}

function scanChildResults(buffer: Buffer, arrayStart: number, limit: number): ChildResultsScan {
  const results: Array<Record<string, unknown>> = [];
  let cursor = arrayStart + 1;
  while (cursor < limit) {
    cursor = skipJsonWhitespace(buffer, cursor, limit);
    if (buffer[cursor] === 0x5d) return { end: cursor + 1, results };
    if (buffer[cursor] === 0x2c) {
      cursor++;
      continue;
    }
    if (buffer[cursor] === 0x7b) {
      const scanned = scanDirectObjectProperties(buffer, cursor, limit, DIRECT_CHILD_PROPERTIES);
      results.push({
        usage: parseJsonRange(buffer, scanned.values.get("usage")),
        sessionFile: parseJsonRange(buffer, scanned.values.get("sessionFile")),
      });
      if (scanned.end <= cursor) return { end: limit, results };
      cursor = scanned.end;
      continue;
    }
    const valueEnd = jsonValueEnd(buffer, cursor, limit);
    if (valueEnd <= cursor) return { end: limit, results };
    cursor = valueEnd;
  }
  return { end: limit, results };
}

interface LargeDetailsScan {
  end: number;
  details: Record<string, unknown>;
}

/** Scan nested-agent details and its result metadata in a single byte pass. */
function scanLargeDetails(buffer: Buffer, objectStart: number, limit: number): LargeDetailsScan {
  const details: Record<string, unknown> = { results: [] };
  let cursor = objectStart + 1;
  while (cursor < limit) {
    cursor = skipJsonWhitespace(buffer, cursor, limit);
    if (buffer[cursor] === 0x7d) return { end: cursor + 1, details };
    if (buffer[cursor] === 0x2c) {
      cursor++;
      continue;
    }
    if (buffer[cursor] !== 0x22) return { end: jsonValueEnd(buffer, objectStart, limit), details };
    const keyEnd = jsonValueEnd(buffer, cursor, limit);
    const colon = skipJsonWhitespace(buffer, keyEnd, limit);
    if (buffer[colon] !== 0x3a) return { end: jsonValueEnd(buffer, objectStart, limit), details };
    const valueStart = skipJsonWhitespace(buffer, colon + 1, limit);
    const key = buffer.toString("utf8", cursor + 1, keyEnd - 1);
    let valueEnd: number;
    if (key === "results" && buffer[valueStart] === 0x5b) {
      const scanned = scanChildResults(buffer, valueStart, limit);
      details.results = scanned.results;
      valueEnd = scanned.end;
    } else {
      valueEnd = jsonValueEnd(buffer, valueStart, limit);
      if (key === "runId" || key === "totalChildUsage") {
        details[key] = parseJsonRange(buffer, [valueStart, valueEnd]);
      }
    }
    if (valueEnd <= valueStart) return { end: limit, details };
    cursor = valueEnd;
  }
  return { end: limit, details };
}

/**
 * Parse only the small accounting fields from a large tool-result line. This
 * avoids UTF-8 decoding and JSON.parse allocation for multi-megabyte content.
 */
function parseLargeToolResultLine(line: Buffer): ToolUsageRecord | null {
  const entryStart = skipJsonWhitespace(line, 0, line.length);
  const entry = scanDirectObjectProperties(line, entryStart, line.length, DIRECT_ENTRY_PROPERTIES).values;
  const messageRange = entry.get("message");
  if (!messageRange || line[messageRange[0]] !== 0x7b) return null;
  const message = scanDirectObjectProperties(line, messageRange[0], messageRange[1], DIRECT_MESSAGE_PROPERTIES).values;
  const detailsRange = message.get("details");
  const details =
    detailsRange && line[detailsRange[0]] === 0x7b
      ? scanLargeDetails(line, detailsRange[0], detailsRange[1]).details
      : null;
  return buildToolUsageRecord(
    parseJsonRange(line, message.get("toolName")),
    details,
    parseJsonRange(line, message.get("usage")),
    parseJsonRange(line, entry.get("id")),
    parseJsonRange(line, message.get("timestamp")),
    parseJsonRange(line, entry.get("timestamp")),
  );
}

function lineMightBeRelevant(line: Buffer): boolean {
  // Entry type/role fields are at the front of Pi's JSONL objects. Restrict
  // those checks to a small prefix so multi-megabyte tool output is not scanned
  // repeatedly for every possible entry shape.
  const head = line.length > 1024 ? line.subarray(0, 1024) : line;
  if (head.includes(PATTERN_ASSISTANT_COMPACT) || head.includes(PATTERN_ASSISTANT_SPACED)) return true;

  if (head.includes(PATTERN_TOOL_RESULT_COMPACT) || head.includes(PATTERN_TOOL_RESULT_SPACED)) {
    if (
      head.includes(PATTERN_SUBAGENT_TOOL_COMPACT) ||
      head.includes(PATTERN_SUBAGENT_TOOL_SPACED) ||
      head.includes(PATTERN_SUBAGENT_WAIT_TOOL_COMPACT) ||
      head.includes(PATTERN_SUBAGENT_WAIT_TOOL_SPACED)
    ) {
      return true;
    }
    // Usage may precede large nestedCalls/args. Only a direct message.usage
    // qualifies: content and nested tool arguments are not accounting records.
    // The cheap byte check keeps ordinary output on the skipped-line fast path.
    if (!line.includes(PATTERN_USAGE_COMPACT) && !line.includes(PATTERN_USAGE_SPACED)) return false;
    const start = skipJsonWhitespace(line, 0, line.length);
    if (line[start] !== 0x7b) return false;
    const message = scanDirectObjectProperties(line, start, line.length, DIRECT_MESSAGE_ONLY, true).values.get(
      "message",
    );
    return Boolean(
      message &&
        line[message[0]] === 0x7b &&
        scanDirectObjectProperties(line, message[0], message[1], DIRECT_USAGE_ONLY, true).values.has("usage"),
    );
  }

  return (
    head.includes(PATTERN_SESSION_COMPACT) ||
    head.includes(PATTERN_THINKING_COMPACT) ||
    head.includes(PATTERN_COMPACTION_COMPACT) ||
    head.includes(PATTERN_CONTEXT_EDIT_COMPACT) ||
    head.includes(PATTERN_USAGE_ENTRY_COMPACT) ||
    head.includes(PATTERN_BRANCH_SUMMARY_COMPACT) ||
    head.includes(PATTERN_SESSION_SPACED) ||
    head.includes(PATTERN_THINKING_SPACED) ||
    head.includes(PATTERN_COMPACTION_SPACED) ||
    head.includes(PATTERN_CONTEXT_EDIT_SPACED) ||
    head.includes(PATTERN_USAGE_ENTRY_SPACED) ||
    head.includes(PATTERN_BRANCH_SUMMARY_SPACED)
  );
}

const LINEAGE_PROPERTIES = new Set(["id", "parentId"]);

/** Validate a skipped large JSONL entry without decoding or allocating its body.
 * A header alone is not a lineage node: Pi skips the entire malformed line. */
function validLargeJsonLine(line: Buffer, lineageKeys: { ambiguous: boolean }): boolean {
  let seenId = false;
  let seenParentId = false;
  type Frame = {
    kind: "object" | "array";
    expect: "keyOrEnd" | "key" | "colon" | "valueOrEnd" | "value" | "commaOrEnd";
  };
  const stack: Frame[] = [];
  let cursor = skipJsonWhitespace(line, 0, line.length);
  let expectValue = true;
  const stringEnd = (start: number): number => {
    for (let i = start + 1; i < line.length; i++) {
      const byte = line[i];
      if (byte === 0x22) return i + 1;
      if (byte < 0x20) return -1;
      if (byte !== 0x5c) continue;
      const escaped = line[++i];
      if (escaped === 0x75) {
        for (let digit = 0; digit < 4; digit++) {
          const hex = line[++i];
          if (!((hex >= 0x30 && hex <= 0x39) || (hex >= 0x41 && hex <= 0x46) || (hex >= 0x61 && hex <= 0x66)))
            return -1;
        }
      } else if (![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(escaped)) return -1;
    }
    return -1;
  };
  while (cursor < line.length) {
    cursor = skipJsonWhitespace(line, cursor, line.length);
    if (cursor >= line.length) break;
    const frame = stack.at(-1);
    const byte = line[cursor];
    if (!expectValue && !frame) return false;
    if (!expectValue && frame) {
      if (frame.expect === "keyOrEnd" || frame.expect === "key") {
        if (byte === 0x7d && frame.expect === "keyOrEnd") {
          stack.pop();
          cursor++;
          continue;
        }
        if (byte !== 0x22) return false;
        const keyStart = cursor;
        cursor = stringEnd(cursor);
        if (cursor < 0) return false;
        if (stack.length === 1 && frame.kind === "object") {
          // Validation already walks the entire line. Notice non-canonical
          // top-level keys without decoding the multi-megabyte content body.
          if (line.subarray(keyStart + 1, cursor - 1).includes(0x5c)) lineageKeys.ambiguous = true;
          const keyLength = cursor - keyStart - 2;
          const rawKey = keyLength === 2 || keyLength === 8 ? line.toString("ascii", keyStart + 1, cursor - 1) : "";
          if (rawKey === "id") {
            if (seenId) lineageKeys.ambiguous = true;
            seenId = true;
          } else if (rawKey === "parentId") {
            if (seenParentId) lineageKeys.ambiguous = true;
            seenParentId = true;
          }
        }
        frame.expect = "colon";
        continue;
      }
      if (frame.expect === "colon") {
        if (byte !== 0x3a) return false;
        frame.expect = "value";
        cursor++;
        continue;
      }
      if (frame.expect === "commaOrEnd") {
        if (byte === (frame.kind === "object" ? 0x7d : 0x5d)) {
          stack.pop();
          cursor++;
          continue;
        }
        if (byte !== 0x2c) return false;
        frame.expect = frame.kind === "object" ? "key" : "value";
        cursor++;
        continue;
      }
      if (frame.expect === "valueOrEnd" && byte === 0x5d) {
        stack.pop();
        cursor++;
        continue;
      }
    }
    if (frame && frame.expect !== "value" && frame.expect !== "valueOrEnd") return false;
    if (frame) frame.expect = "commaOrEnd";
    else expectValue = false;
    if (byte === 0x7b || byte === 0x5b) {
      stack.push({ kind: byte === 0x7b ? "object" : "array", expect: byte === 0x7b ? "keyOrEnd" : "valueOrEnd" });
      cursor++;
    } else if (byte === 0x22) {
      cursor = stringEnd(cursor);
      if (cursor < 0) return false;
    } else if (byte === 0x74 || byte === 0x66 || byte === 0x6e) {
      const word = byte === 0x74 ? "true" : byte === 0x66 ? "false" : "null";
      if (line.toString("ascii", cursor, cursor + word.length) !== word) return false;
      cursor += word.length;
    } else if (byte === 0x2d || (byte >= 0x30 && byte <= 0x39)) {
      if (byte === 0x2d) cursor++;
      if (line[cursor] === 0x30) cursor++;
      else if (line[cursor] >= 0x31 && line[cursor] <= 0x39) {
        do cursor++;
        while (line[cursor] >= 0x30 && line[cursor] <= 0x39);
      } else return false;
      if (line[cursor] === 0x2e) {
        cursor++;
        if (line[cursor] < 0x30 || line[cursor] > 0x39) return false;
        do cursor++;
        while (line[cursor] >= 0x30 && line[cursor] <= 0x39);
      }
      if (line[cursor] === 0x65 || line[cursor] === 0x45) {
        cursor++;
        if (line[cursor] === 0x2b || line[cursor] === 0x2d) cursor++;
        if (line[cursor] < 0x30 || line[cursor] > 0x39) return false;
        do cursor++;
        while (line[cursor] >= 0x30 && line[cursor] <= 0x39);
      }
    } else return false;
  }
  return !expectValue && stack.length === 0;
}

/** Read direct entry properties without decoding nested content. Pi writes custom
 * data/content before id and parentId, and tool results can be megabytes long. */
function skippedEntryLineage(
  line: Buffer,
  verifiedLineageKeys?: { ambiguous: boolean },
): { id: string; parentId: string | null } | null {
  let start = 0;
  while (start < line.length && (line[start] === 0x20 || line[start] === 0x09 || line[start] === 0x0d)) start++;
  if (line[start] !== 0x7b) return null;
  if (line.length <= LARGE_TOOL_RESULT_BYTES) {
    try {
      const parsed: unknown = JSON.parse(line.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const { id, parentId } = parsed as Record<string, unknown>;
      return typeof id === "string" && (typeof parentId === "string" || parentId === null) ? { id, parentId } : null;
    } catch {
      return null;
    }
  }
  const lineageKeys = verifiedLineageKeys ?? { ambiguous: false };
  if (!verifiedLineageKeys && !validLargeJsonLine(line, lineageKeys)) return null;
  // Canonical Pi entries put id and parentId before message/content. Only
  // duplicate or escaped top-level keys require a full direct-property scan;
  // JSON.parse uses decoded keys and the final value for duplicates.
  const { values } = scanDirectObjectProperties(
    line,
    start,
    line.length,
    LINEAGE_PROPERTIES,
    !lineageKeys.ambiguous,
    lineageKeys.ambiguous,
  );
  const id = parseJsonRange(line, values.get("id"));
  const parentId = parseJsonRange(line, values.get("parentId"));
  return typeof id === "string" && (typeof parentId === "string" || parentId === null) ? { id, parentId } : null;
}

interface EffectiveEdit {
  fingerprint: string;
  editId: string;
}

/** Immutable AVL map: branch forks share untouched nodes instead of copying every
 * edit. Height and size are cached so updates stay logarithmic and the changed
 * target check stays constant-time. */
interface EditTree<Value> {
  readonly key: string;
  readonly value: Value;
  readonly left: EditTree<Value> | null;
  readonly right: EditTree<Value> | null;
  readonly height: number;
  readonly size: number;
}

function editNode<Value>(
  key: string,
  value: Value,
  left: EditTree<Value> | null,
  right: EditTree<Value> | null,
): EditTree<Value> {
  return {
    key,
    value,
    left,
    right,
    height: 1 + Math.max(left?.height ?? 0, right?.height ?? 0),
    size: 1 + (left?.size ?? 0) + (right?.size ?? 0),
  };
}

function balanceEditTree<Value>(node: EditTree<Value>): EditTree<Value> {
  const skew = (node.left?.height ?? 0) - (node.right?.height ?? 0);
  if (skew > 1) {
    const left = node.left as EditTree<Value>;
    if ((left.left?.height ?? 0) < (left.right?.height ?? 0)) {
      const pivot = left.right as EditTree<Value>;
      const rotated = editNode(left.key, left.value, left.left, pivot.left);
      return balanceEditTree(
        editNode(pivot.key, pivot.value, rotated, editNode(node.key, node.value, pivot.right, node.right)),
      );
    }
    return editNode(left.key, left.value, left.left, editNode(node.key, node.value, left.right, node.right));
  }
  if (skew < -1) {
    const right = node.right as EditTree<Value>;
    if ((right.right?.height ?? 0) < (right.left?.height ?? 0)) {
      const pivot = right.left as EditTree<Value>;
      const rotated = editNode(right.key, right.value, pivot.right, right.right);
      return balanceEditTree(
        editNode(pivot.key, pivot.value, editNode(node.key, node.value, node.left, pivot.left), rotated),
      );
    }
    return editNode(right.key, right.value, editNode(node.key, node.value, node.left, right.left), right.right);
  }
  return node;
}

function editTreeGet<Value>(root: EditTree<Value> | null, key: string): Value | undefined {
  let node = root;
  while (node) {
    if (key === node.key) return node.value;
    node = key < node.key ? node.left : node.right;
  }
  return undefined;
}

function editTreeSet<Value>(root: EditTree<Value> | null, key: string, value: Value): EditTree<Value> {
  if (!root) return editNode(key, value, null, null);
  if (key === root.key) return editNode(key, value, root.left, root.right);
  return key < root.key
    ? balanceEditTree(editNode(root.key, root.value, editTreeSet(root.left, key, value), root.right))
    : balanceEditTree(editNode(root.key, root.value, root.left, editTreeSet(root.right, key, value)));
}

function editTreeDelete<Value>(root: EditTree<Value> | null, key: string): EditTree<Value> | null {
  if (!root) return null;
  if (key < root.key) {
    const left = editTreeDelete(root.left, key);
    return left === root.left ? root : balanceEditTree(editNode(root.key, root.value, left, root.right));
  }
  if (key > root.key) {
    const right = editTreeDelete(root.right, key);
    return right === root.right ? root : balanceEditTree(editNode(root.key, root.value, root.left, right));
  }
  if (!root.left) return root.right;
  if (!root.right) return root.left;
  let successor = root.right;
  while (successor.left) successor = successor.left;
  return balanceEditTree(
    editNode(successor.key, successor.value, root.left, editTreeDelete(root.right, successor.key)),
  );
}

function editTreeForEach<Value>(root: EditTree<Value> | null, visit: (key: string, value: Value) => void): void {
  if (!root) return;
  editTreeForEach(root.left, visit);
  visit(root.key, root.value);
  editTreeForEach(root.right, visit);
}

interface BranchState {
  thinkingLevel: string;
  lastAssistantId: string;
  /** Only changed targets in the previous assistant's projected context explain a prefix miss. */
  changedTargets: EditTree<true> | null;
  effectiveEdits: EditTree<EffectiveEdit> | null;
  /** An ancestor of every effective edit, used to retain the tree on full-range compactions. */
  earliestEffectiveEditId: string;
  baselineEdits: EditTree<EffectiveEdit> | null;
  pendingCompaction: boolean;
  latestCompactionId: string;
  warmByModel: ReadonlyMap<string, number>;
}

const EMPTY_BRANCH: BranchState = {
  thinkingLevel: "",
  lastAssistantId: "",
  changedTargets: null,
  effectiveEdits: null,
  earliestEffectiveEditId: "",
  baselineEdits: null,
  pendingCompaction: false,
  latestCompactionId: "",
  warmByModel: new Map(),
};

interface LineageEntry {
  parentId: string | null;
  state: BranchState;
  /** Byte offsets into the current parse buffer, not a retained JSON body. */
  lineRange: [number, number];
  content?: { role: "user" | "assistant" | "toolResult" | "custom"; fingerprint: string } | null;
  firstKeptId?: string;
  /** Present only when every parent was seen before this unique canonical id. */
  depth?: number;
  /** Ancestors at distances 1, 2, 4, ... for logarithmic lineage checks. */
  jumps?: string[];
}

function isAncestor(
  lineage: Map<string, LineageEntry>,
  ancestorId: string,
  descendantId: string,
  duplicateIds: boolean,
): boolean {
  if (ancestorId === descendantId) return true;
  const descendant = lineage.get(descendantId);
  if (!duplicateIds && descendant?.depth !== undefined) {
    const ancestor = lineage.get(ancestorId);
    // A canonical path contains only already-seen canonical entries.
    if (ancestor?.depth === undefined || ancestor.depth > descendant.depth) return false;
    let cursor = descendantId;
    let distance = descendant.depth - ancestor.depth;
    let bit = 0;
    while (distance > 0) {
      if (distance % 2 === 1) cursor = lineage.get(cursor)?.jumps?.[bit] ?? "";
      distance = Math.floor(distance / 2);
      bit++;
    }
    return cursor === ancestorId;
  }
  let cursor: string | null = descendantId;
  // Malformed/imported journals may contain cycles or late/duplicate ids.
  const visited = new Set<string>();
  while (cursor !== null && !visited.has(cursor)) {
    if (cursor === ancestorId) return true;
    visited.add(cursor);
    cursor = lineage.get(cursor)?.parentId ?? null;
  }
  return false;
}

/** A context edit only changes a request if its target survives the latest
 * compaction on this branch (Pi's buildContextEntries projection). */
function editChangesContext(
  lineage: Map<string, LineageEntry>,
  parentId: string | null,
  targetId: unknown,
  compactionId: string,
  duplicateIds: boolean,
): boolean {
  if (typeof targetId !== "string" || !parentId || !isAncestor(lineage, targetId, parentId, duplicateIds)) return false;
  if (!compactionId || isAncestor(lineage, compactionId, targetId, duplicateIds)) return true;
  const firstKeptId = lineage.get(compactionId)?.firstKeptId;
  return Boolean(firstKeptId && isAncestor(lineage, firstKeptId, targetId, duplicateIds));
}

function contentFingerprint(content: unknown): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/** Decode a target only when an edit actually references it. Most tool results
 * never need their content inspected; lineage retains only byte offsets. */
function originalContent(
  lineage: Map<string, LineageEntry>,
  targetId: string,
  buffer: Buffer,
): Exclude<LineageEntry["content"], undefined> {
  const target = lineage.get(targetId);
  if (!target) return null;
  if (target.content !== undefined) return target.content;
  let content: Exclude<LineageEntry["content"], undefined> = null;
  try {
    const [start, end] = target.lineRange;
    const entry = JSON.parse(buffer.toString("utf8", start, end)) as Record<string, unknown>;
    if (entry.type === "custom_message") {
      content = { role: "custom", fingerprint: contentFingerprint(entry.content ?? []) };
    } else if (entry.type === "message" && entry.message && typeof entry.message === "object") {
      const msg = entry.message as Record<string, unknown>;
      if (
        msg.role === "user" ||
        msg.role === "toolResult" ||
        (msg.role === "assistant" && msg.stopReason !== "aborted" && msg.stopReason !== "error")
      ) {
        content = { role: msg.role, fingerprint: contentFingerprint(msg.content ?? []) };
      }
    }
  } catch {
    // Invalid imported entries cannot contribute an editable model message.
  }
  target.content = content;
  return content;
}

function applyContextEdit(
  lineage: Map<string, LineageEntry>,
  branch: BranchState,
  targetId: string,
  replacement: unknown,
  editId: string,
  buffer: Buffer,
  changesCachedPrefix: boolean,
): BranchState {
  const original = originalContent(lineage, targetId, buffer);
  if (!original) return branch;
  let fingerprint: string;
  if (replacement === null) {
    fingerprint = "omitted";
  } else if (replacement && typeof replacement === "object" && "content" in replacement) {
    let content = (replacement as { content: unknown }).content;
    if (typeof content !== "string" && !Array.isArray(content)) return branch;
    if ((original.role === "assistant" || original.role === "toolResult") && typeof content === "string") {
      content = [{ type: "text", text: content }];
    }
    fingerprint = contentFingerprint(content);
  } else {
    return branch;
  }
  const effective = editTreeGet(branch.effectiveEdits, targetId)?.fingerprint ?? original.fingerprint;
  if (effective === fingerprint) return branch;
  const effectiveEdits = editTreeSet(branch.effectiveEdits, targetId, { fingerprint, editId });
  const baseline = editTreeGet(branch.baselineEdits, targetId)?.fingerprint ?? original.fingerprint;
  const changedTargets = !changesCachedPrefix
    ? branch.changedTargets
    : fingerprint === baseline
      ? editTreeDelete(branch.changedTargets, targetId)
      : editTreeSet(branch.changedTargets, targetId, true);
  return {
    ...branch,
    effectiveEdits,
    earliestEffectiveEditId: branch.earliestEffectiveEditId || editId,
    changedTargets,
  };
}

/**
 * Extract the session id plus assistant/tool/summary usage from a JSONL buffer.
 * Returns partial results when aborted — callers must check `signal.aborted`
 * before caching or using the result.
 */
export async function parseSessionBuffer(buffer: Buffer, signal?: AbortSignal): Promise<ParsedSessionFile> {
  const messages: SessionMessage[] = [];
  const toolUsages: ToolUsageRecord[] = [];
  let sessionId = "";
  let parentSession = "";
  let cwd = "";
  // Legacy/imported entries without parent links can only use append-order
  // thinking changes. Canonical Pi entries (including parentId: null roots)
  // use their branch state, so separate roots and siblings cannot leak levels.
  let legacyThinkingLevel = "";
  // Replay the small ancestry state for each entry, including skipped entries.
  // Parent links, not append order, determine which branch owns an edit, a
  // compaction, or a cache warm. No message/tool/custom bodies are retained.
  const lineage = new Map<string, LineageEntry>();
  // Reused ids can invalidate ancestry cached by older entries. Fall back to the
  // bounded parent walk for the rest of such an imported/malformed journal.
  let duplicateIds = false;
  let appendState = EMPTY_BRANCH; // Best effort for imported entries without usable parent links.

  let start = 0;
  let lineNumber = 0;

  while (start < buffer.length) {
    let end = buffer.indexOf(NEWLINE, start);
    if (end === -1) end = buffer.length;

    lineNumber++;
    if (lineNumber % PARSE_YIELD_EVERY_LINES === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (signal?.aborted) return { sessionId, cwd, parentSession, messages, toolUsages };
    }

    const lineBuffer = buffer.subarray(start, end);
    if (end > start) {
      const relevant = lineMightBeRelevant(lineBuffer);
      const head = lineBuffer.subarray(0, Math.min(1024, lineBuffer.length));
      const largeToolResult =
        relevant &&
        lineBuffer.length > LARGE_TOOL_RESULT_BYTES &&
        (head.includes(PATTERN_TOOL_RESULT_COMPACT) || head.includes(PATTERN_TOOL_RESULT_SPACED));
      const lineageKeys = { ambiguous: false };
      const validLargeToolResult = largeToolResult && validLargeJsonLine(lineBuffer, lineageKeys);
      let entry: Record<string, unknown> | null = null;
      if (relevant && !largeToolResult) {
        try {
          const parsed: unknown = JSON.parse(buffer.toString("utf8", start, end));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) entry = parsed as Record<string, unknown>;
        } catch {
          // Skip malformed lines.
        }
      }
      const header = entry
        ? {
            id: entry.id,
            parentId: entry.parentId,
          }
        : largeToolResult && !validLargeToolResult
          ? null
          : skippedEntryLineage(lineBuffer, validLargeToolResult ? lineageKeys : undefined);
      const id = typeof header?.id === "string" ? header.id : "";
      const parentId = typeof header?.parentId === "string" ? header.parentId : null;
      const hasParentLink = typeof header?.parentId === "string" || header?.parentId === null;
      const parent = parentId ? lineage.get(parentId) : undefined;
      const branch = parent?.state ?? (hasParentLink ? EMPTY_BRANCH : appendState);
      let state = branch;
      let firstKeptId: string | undefined;

      if (validLargeToolResult) {
        const toolUsage = parseLargeToolResultLine(lineBuffer);
        if (toolUsage) toolUsages.push(toolUsage);
      } else if (entry?.type === "session") {
        if (typeof entry.id === "string") sessionId = entry.id;
        if (typeof entry.cwd === "string") cwd = entry.cwd;
        if (typeof entry.parentSession === "string") parentSession = entry.parentSession;
      } else if (entry?.type === "thinking_level_change") {
        if (typeof entry.thinkingLevel === "string") {
          legacyThinkingLevel = entry.thinkingLevel;
          state = { ...branch, thinkingLevel: entry.thinkingLevel };
        }
      } else if (entry?.type === "compaction") {
        const usage = parseUsageAmount(entry.usage);
        if (usage) messages.push(auxiliaryMessage(usage, parsedTimestamp(undefined, entry.timestamp), id));
        firstKeptId = typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : undefined;
        // Pi's context projection discards edits before the kept range, even
        // when the edited target itself survives compaction.
        let effectiveEdits: EditTree<EffectiveEdit> | null = null;
        let earliestEffectiveEditId = "";
        const keptId = firstKeptId;
        if (keptId && branch.effectiveEdits) {
          if (
            branch.earliestEffectiveEditId &&
            isAncestor(lineage, keptId, branch.earliestEffectiveEditId, duplicateIds)
          ) {
            // All effective edits follow this ancestor on the same branch. Reuse
            // the immutable tree instead of rebuilding it at every compaction.
            effectiveEdits = branch.effectiveEdits;
            earliestEffectiveEditId = branch.earliestEffectiveEditId;
          } else {
            editTreeForEach(branch.effectiveEdits, (targetId, edit) => {
              if (isAncestor(lineage, keptId, edit.editId, duplicateIds)) {
                effectiveEdits = editTreeSet(effectiveEdits, targetId, edit);
              }
            });
            // A conservative ancestor bound for retained edits; a later
            // compaction keeping this point can reuse the filtered tree.
            if (effectiveEdits) earliestEffectiveEditId = keptId;
          }
        }
        state = {
          ...branch,
          effectiveEdits,
          earliestEffectiveEditId,
          changedTargets: null,
          pendingCompaction: true,
          latestCompactionId: id,
        };
      } else if (entry?.type === "context_edit") {
        if (
          typeof entry.targetId === "string" &&
          parentId &&
          isAncestor(lineage, entry.targetId, parentId, duplicateIds)
        ) {
          const previousAssistant = lineage.get(branch.lastAssistantId);
          // Retain edits to targets hidden by the current compaction: a later
          // compaction can keep an earlier range and make those edits effective.
          // Only a target visible in both requests can explain a cache miss.
          const changesCachedPrefix =
            editChangesContext(lineage, parentId, entry.targetId, branch.latestCompactionId, duplicateIds) &&
            Boolean(
              branch.lastAssistantId &&
                editChangesContext(
                  lineage,
                  branch.lastAssistantId,
                  entry.targetId,
                  previousAssistant?.state.latestCompactionId ?? "",
                  duplicateIds,
                ),
            );
          state = applyContextEdit(
            lineage,
            branch,
            entry.targetId as string,
            entry.replacement,
            id,
            buffer,
            changesCachedPrefix,
          );
        }
      } else if (entry?.type === "usage") {
        const message = standaloneUsageMessage(entry, hasParentLink ? branch.thinkingLevel : legacyThinkingLevel);
        if (message) messages.push(message);
        // Successful zero-usage refreshes have no billable record, but still
        // reset the TTL on this branch. Keep timing separate from accounting.
        if (
          entry.kind === "cache_warm" &&
          entry.usage &&
          typeof entry.usage === "object" &&
          typeof entry.provider === "string" &&
          entry.provider &&
          typeof entry.model === "string" &&
          entry.model
        ) {
          const timestamp = parsedTimestamp(undefined, entry.timestamp);
          if (timestamp > 0) {
            const warmByModel = new Map(branch.warmByModel);
            warmByModel.set(JSON.stringify([entry.provider, entry.model]), timestamp);
            state = { ...branch, warmByModel };
          }
        }
      } else if (entry?.type === "branch_summary") {
        const usage = parseUsageAmount(entry.usage);
        if (usage) messages.push(auxiliaryMessage(usage, parsedTimestamp(undefined, entry.timestamp), id));
      } else if (entry?.type === "message" && (entry.message as { role?: unknown } | undefined)?.role === "assistant") {
        const msg = entry.message as Record<string, unknown>;
        const usage = msg.usage as
          | {
              cost?: { total?: number };
              input?: number;
              output?: number;
              cacheRead?: number;
              cacheWrite?: number;
              reasoning?: number;
            }
          | undefined;
        if (usage && typeof msg.provider === "string" && typeof msg.model === "string") {
          const fallbackTs = entry.timestamp ? new Date(entry.timestamp as string).getTime() : 0;
          const timestamp = (msg.timestamp as number) || (Number.isNaN(fallbackTs) ? 0 : fallbackTs);
          // Pi persists warm usage under responseModel ?? model, while the
          // assistant's model field may be a request alias. Never fall back to
          // an alias when a different concrete responseModel is known.
          const responseModel =
            typeof msg.responseModel === "string" && msg.responseModel ? msg.responseModel : undefined;
          const branchWarmAt = branch.warmByModel.get(JSON.stringify([msg.provider, responseModel ?? msg.model]));
          messages.push({
            provider: msg.provider,
            model: msg.model,
            ...(responseModel ? { responseModel } : {}),
            thinkingLevel: isThinkingLevel(msg.thinkingLevel)
              ? msg.thinkingLevel
              : hasParentLink
                ? branch.thinkingLevel
                : legacyThinkingLevel,
            source: "assistant",
            sourceId: id,
            cost: usage.cost?.total || 0,
            input: usage.input || 0,
            output: usage.output || 0,
            cacheRead: usage.cacheRead || 0,
            cacheWrite: usage.cacheWrite || 0,
            reasoning: usage.reasoning || 0,
            timestamp,
            afterCompaction: branch.pendingCompaction,
            ...((branch.changedTargets?.size ?? 0) > 0 ? { afterContextEdit: true } : {}),
            ...(hasParentLink && id ? { previousAssistantId: branch.lastAssistantId } : {}),
            ...(branchWarmAt ? { branchWarmAt } : {}),
          });
          state = {
            ...branch,
            lastAssistantId: id,
            baselineEdits: branch.effectiveEdits,
            changedTargets: null,
            pendingCompaction: false,
          };
        }
      } else if (
        entry?.type === "message" &&
        (entry.message as { role?: unknown } | undefined)?.role === "toolResult"
      ) {
        const msg = entry.message as Record<string, unknown>;
        const toolUsage = buildToolUsageRecord(
          msg.toolName,
          msg.details,
          msg.usage,
          entry.id,
          msg.timestamp,
          entry.timestamp,
        );
        if (toolUsage) toolUsages.push(toolUsage);
      }

      if (id) {
        if (lineage.has(id)) duplicateIds = true;
        const canonical = hasParentLink && (parentId === null || parent?.depth !== undefined) && !duplicateIds;
        const jumps: string[] = [];
        if (canonical && parentId) {
          jumps.push(parentId);
          for (let bit = 1; ; bit++) {
            const next = lineage.get(jumps[bit - 1])?.jumps?.[bit - 1];
            if (!next) break;
            jumps.push(next);
          }
        }
        lineage.set(id, {
          parentId,
          state,
          lineRange: [start, end],
          ...(firstKeptId ? { firstKeptId } : {}),
          ...(canonical ? { depth: (parent?.depth ?? -1) + 1, jumps } : {}),
        });
      }
      appendState = state;
    }

    start = end + 1;
  }

  return { sessionId, cwd, parentSession, messages, toolUsages };
}

// =============================================================================
// On-disk cache
// =============================================================================

const CACHE_VERSION = 12;

type CachedMessageTuple = [
  providerIdx: number,
  modelIdx: number,
  cost: number,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  timestamp: number,
  thinkingLevelIdx: number,
  reasoning: number,
  afterCompaction: 0 | 1,
  source: 0 | 1 | 2,
  sourceIdIdx: number,
  afterContextEdit: 0 | 1,
  cacheWarm: 0 | 1,
  previousAssistantIdIdx: number,
  branchWarmAt: number,
  responseModelIdx: number,
];

type CachedUsageTuple = [
  cost: number,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  reasoning: number,
];

type CachedChildToolUsageTuple = [resultIndex: number, sessionFileIdx: number, usage: CachedUsageTuple];

type CachedToolUsageTuple = [
  sourceIdIdx: number,
  timestamp: number,
  reportedUsage: CachedUsageTuple | null,
  runIdIdx: number,
  children: CachedChildToolUsageTuple[],
];

interface CacheFileEntry {
  size: number;
  mtimeMs: number;
  sessionId: string;
  parentSession: string;
  cwd: string;
  messages: CachedMessageTuple[];
  toolUsages: CachedToolUsageTuple[];
}

export interface CachedFileState {
  size: number;
  mtimeMs: number;
  parsed: ParsedSessionFile;
}

export async function loadUsageCache(cachePath: string, signal?: AbortSignal): Promise<Map<string, CachedFileState>> {
  const result = new Map<string, CachedFileState>();
  let raw: { version?: unknown; names?: unknown; files?: unknown };
  try {
    signal?.throwIfAborted();
    const text = await readFile(cachePath, { encoding: "utf8", signal });
    signal?.throwIfAborted();
    // JSON.parse is synchronous; an abort cannot interrupt an in-flight parse.
    raw = JSON.parse(text);
    signal?.throwIfAborted();
  } catch {
    signal?.throwIfAborted();
    return result; // Missing or corrupt cache — rebuild from scratch.
  }
  if (
    !raw ||
    raw.version !== CACHE_VERSION ||
    !Array.isArray(raw.names) ||
    typeof raw.files !== "object" ||
    raw.files === null
  ) {
    return result;
  }

  const names = raw.names as unknown[];
  for (const [filePath, entry] of Object.entries(raw.files as Record<string, CacheFileEntry>)) {
    signal?.throwIfAborted();
    if (
      !entry ||
      !nonnegativeNumber(entry.size) ||
      !Number.isInteger(entry.size) ||
      !nonnegativeNumber(entry.mtimeMs) ||
      typeof entry.sessionId !== "string" ||
      typeof entry.parentSession !== "string" ||
      typeof entry.cwd !== "string" ||
      !Array.isArray(entry.messages) ||
      !Array.isArray(entry.toolUsages)
    ) {
      continue;
    }
    const messages: SessionMessage[] = [];
    let valid = true;
    for (const tuple of entry.messages) {
      signal?.throwIfAborted();
      if (!Array.isArray(tuple) || tuple.length !== 18) {
        valid = false;
        break;
      }
      const provider = names[tuple[0]];
      const model = names[tuple[1]];
      const thinkingLevel = names[tuple[8]];
      const sourceId = names[tuple[12]];
      if (
        ![0, 1, 8, 12].every((slot) => nameIndexValid(tuple[slot], names)) ||
        ![2, 3, 4, 5, 6, 7, 9, 16].every((slot) => nonnegativeNumber(tuple[slot])) ||
        typeof provider !== "string" ||
        typeof model !== "string" ||
        typeof thinkingLevel !== "string" ||
        typeof sourceId !== "string" ||
        (tuple[10] !== 0 && tuple[10] !== 1) ||
        (tuple[11] !== 0 && tuple[11] !== 1 && tuple[11] !== 2) ||
        (tuple[13] !== 0 && tuple[13] !== 1) ||
        (tuple[14] !== 0 && tuple[14] !== 1) ||
        (tuple[14] === 1 && tuple[11] !== 2) ||
        (tuple[15] !== -1 && !nameIndexValid(tuple[15], names)) ||
        typeof tuple[16] !== "number" ||
        !Number.isFinite(tuple[16]) ||
        tuple[16] < 0 ||
        (tuple[16] > 0 && tuple[11] !== 0) ||
        (tuple[17] !== -1 && (!nameIndexValid(tuple[17], names) || tuple[11] !== 0))
      ) {
        valid = false;
        break;
      }
      messages.push({
        provider,
        model,
        thinkingLevel,
        source: tuple[11] === 1 ? "auxiliary" : tuple[11] === 2 ? "usage" : "assistant",
        sourceId,
        cost: tuple[2],
        input: tuple[3],
        output: tuple[4],
        cacheRead: tuple[5],
        cacheWrite: tuple[6],
        timestamp: tuple[7],
        reasoning: tuple[9],
        afterCompaction: tuple[10] === 1,
        ...(tuple[13] === 1 ? { afterContextEdit: true } : {}),
        ...(tuple[14] === 1 ? { cacheWarm: true } : {}),
        ...(tuple[15] >= 0 ? { previousAssistantId: names[tuple[15]] as string } : {}),
        ...(tuple[16] > 0 ? { branchWarmAt: tuple[16] } : {}),
        ...(tuple[17] >= 0 ? { responseModel: names[tuple[17]] as string } : {}),
      });
    }
    if (!valid) continue;
    const toolUsages: ToolUsageRecord[] = [];
    for (const tuple of entry.toolUsages) {
      signal?.throwIfAborted();
      if (!Array.isArray(tuple) || tuple.length !== 5 || !Array.isArray(tuple[4])) {
        valid = false;
        break;
      }
      const sourceId = names[tuple[0]];
      const runId = names[tuple[3]];
      const reportedUsage = cachedUsageAmount(tuple[2]);
      if (
        !nameIndexValid(tuple[0], names) ||
        !nameIndexValid(tuple[3], names) ||
        !nonnegativeNumber(tuple[1]) ||
        typeof sourceId !== "string" ||
        typeof runId !== "string" ||
        (tuple[2] !== null && !reportedUsage)
      ) {
        valid = false;
        break;
      }
      const children: ChildToolUsage[] = [];
      for (const childTuple of tuple[4]) {
        signal?.throwIfAborted();
        if (!Array.isArray(childTuple) || childTuple.length !== 3) {
          valid = false;
          break;
        }
        const sessionFile = names[childTuple[1]];
        const usage = cachedUsageAmount(childTuple[2]);
        if (
          !nonnegativeNumber(childTuple[0]) ||
          !Number.isInteger(childTuple[0]) ||
          !nameIndexValid(childTuple[1], names) ||
          typeof sessionFile !== "string" ||
          !usage
        ) {
          valid = false;
          break;
        }
        children.push({ resultIndex: childTuple[0], sessionFile, usage });
      }
      if (!valid) break;
      toolUsages.push({
        sourceId,
        timestamp: tuple[1],
        reportedUsage,
        runId,
        children,
      });
    }
    if (!valid) continue;
    result.set(filePath, {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      parsed: { sessionId: entry.sessionId, cwd: entry.cwd, parentSession: entry.parentSession, messages, toolUsages },
    });
  }
  signal?.throwIfAborted();
  return result;
}

function nonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nameIndexValid(value: unknown, names: unknown[]): value is number {
  return nonnegativeNumber(value) && Number.isInteger(value) && typeof names[value] === "string";
}

function cachedUsageAmount(value: unknown): UsageAmount | null {
  if (!Array.isArray(value) || value.length !== 6 || value.some((part) => !nonnegativeNumber(part))) {
    return null;
  }
  return {
    cost: value[0],
    input: value[1],
    output: value[2],
    cacheRead: value[3],
    cacheWrite: value[4],
    reasoning: value[5],
  };
}

function cacheUsageAmount(usage: UsageAmount): CachedUsageTuple {
  return [usage.cost, usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.reasoning];
}

const CACHE_LOCK_TIMEOUT_MS = 5_000;

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

async function cacheFileMatches(filePath: string, state: CachedFileState): Promise<boolean> {
  try {
    const current = await stat(filePath);
    return current.size === state.size && current.mtimeMs === state.mtimeMs;
  } catch {
    return false;
  }
}

async function mergeCacheStates(
  latest: Map<string, CachedFileState>,
  requested: Map<string, CachedFileState>,
  signal?: AbortSignal,
): Promise<Map<string, CachedFileState>> {
  const merged = new Map(requested);
  for (const [filePath, latestState] of latest) {
    signal?.throwIfAborted();
    const requestedState = merged.get(filePath);
    if (requestedState) {
      if (latestState.mtimeMs > requestedState.mtimeMs && (await cacheFileMatches(filePath, latestState))) {
        merged.set(filePath, latestState);
      }
      continue;
    }
    if (await cacheFileMatches(filePath, latestState)) merged.set(filePath, latestState);
  }
  return merged;
}

async function acquireCacheLock(
  lockPath: string,
  { signal, waitForLock = true }: { signal?: AbortSignal; waitForLock?: boolean } = {},
): Promise<(() => Promise<void>) | null> {
  const deadline = Date.now() + CACHE_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockPath, "wx");
    } catch (error: unknown) {
      signal?.throwIfAborted();
      if (errorCode(error) !== "EEXIST") throw error;
      if (!waitForLock) return null;
      // Age alone cannot establish that a writer is dead. Never steal a lock;
      // an active writer can legitimately take longer than the old 30s threshold.
      await sleep(25, undefined, { signal });
      continue;
    }

    const owner = `${process.pid}:${randomUUID()}`;
    let initialized = false;
    const release = async (): Promise<void> => {
      try {
        const held = await handle.stat();
        const onDisk = await lstat(lockPath).catch((error: unknown) => {
          if (errorCode(error) === "ENOENT") return null;
          throw error;
        });
        // A manual lock replacement must not be unlinked by its predecessor.
        // This check is best effort, not an atomic compare-and-unlink: only
        // remove an orphan manually after confirming no writer is active.
        if (onDisk && held.dev === onDisk.dev && held.ino === onDisk.ino) {
          if (!initialized || (await readFile(lockPath, "utf8")) === owner) {
            await unlink(lockPath);
          }
        }
      } catch (error) {
        // Another process may have removed the lock between the ownership
        // check and the read/unlink. Do not hide unrelated filesystem failures.
        if (errorCode(error) !== "ENOENT") throw error;
      } finally {
        await handle.close();
      }
    };
    try {
      await handle.writeFile(owner);
      initialized = true;
      // open/write may finish after cancellation; clean up before returning.
      signal?.throwIfAborted();
      return release;
    } catch (error) {
      await release();
      throw error;
    }
  }
  signal?.throwIfAborted();
  throw new Error(
    `usage cache lock busy: ${lockPath}; cache not saved. If no /usage writer is active, remove this orphaned lock manually and retry.`,
  );
}

export async function saveUsageCache(
  cachePath: string,
  states: Map<string, CachedFileState>,
  options: { signal?: AbortSignal; waitForLock?: boolean } = {},
): Promise<void> {
  const release = await acquireCacheLock(`${cachePath}.lock`, options);
  if (!release) return;
  const { signal } = options;
  try {
    const statesToWrite = await mergeCacheStates(await loadUsageCache(cachePath, signal), states, signal);
    signal?.throwIfAborted();
    const names: string[] = [];
    const nameIndex = new Map<string, number>();
    const intern = (name: string): number => {
      let idx = nameIndex.get(name);
      if (idx === undefined) {
        idx = names.length;
        names.push(name);
        nameIndex.set(name, idx);
      }
      return idx;
    };

    const files: Record<string, CacheFileEntry> = {};
    for (const [filePath, state] of statesToWrite) {
      signal?.throwIfAborted();
      files[filePath] = {
        size: state.size,
        mtimeMs: state.mtimeMs,
        sessionId: state.parsed.sessionId,
        cwd: state.parsed.cwd,
        parentSession: state.parsed.parentSession,
        messages: state.parsed.messages.map((m): CachedMessageTuple => {
          signal?.throwIfAborted();
          return [
            intern(m.provider),
            intern(m.model),
            m.cost,
            m.input,
            m.output,
            m.cacheRead,
            m.cacheWrite,
            m.timestamp,
            intern(m.thinkingLevel),
            m.reasoning,
            m.afterCompaction ? 1 : 0,
            m.source === "auxiliary" ? 1 : m.source === "usage" ? 2 : 0,
            intern(m.sourceId),
            m.afterContextEdit ? 1 : 0,
            m.cacheWarm ? 1 : 0,
            m.previousAssistantId === undefined ? -1 : intern(m.previousAssistantId),
            m.branchWarmAt || 0,
            m.responseModel ? intern(m.responseModel) : -1,
          ];
        }),
        toolUsages: state.parsed.toolUsages.map((tool): CachedToolUsageTuple => {
          signal?.throwIfAborted();
          return [
            intern(tool.sourceId),
            tool.timestamp,
            tool.reportedUsage ? cacheUsageAmount(tool.reportedUsage) : null,
            intern(tool.runId),
            tool.children.map((child): CachedChildToolUsageTuple => {
              signal?.throwIfAborted();
              return [child.resultIndex, intern(child.sessionFile), cacheUsageAmount(child.usage)];
            }),
          ];
        }),
      };
    }

    signal?.throwIfAborted();
    const payload = JSON.stringify({ version: CACHE_VERSION, names, files });
    signal?.throwIfAborted();
    // A unique temporary name plus the lock prevents same-process collisions and
    // merges concurrently discovered files before the final atomic rename.
    const tmpPath = join(dirname(cachePath), `.usage-cache-${process.pid}-${randomUUID()}.tmp`);
    try {
      signal?.throwIfAborted();
      await writeFile(tmpPath, payload, { encoding: "utf8", signal });
      signal?.throwIfAborted();
      await rename(tmpPath, cachePath);
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  } finally {
    await release();
  }
}

// =============================================================================
// Aggregation
// =============================================================================

function emptyTokens(): TokenStats {
  return { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function emptyModelStats(): ModelStats {
  return { sessions: new Set(), messages: 0, cost: 0, tokens: emptyTokens() };
}

function emptyProviderStats(): ProviderStats {
  return { sessions: new Set(), messages: 0, cost: 0, tokens: emptyTokens(), models: new Map() };
}

function emptyTimeFilteredStats(): TimeFilteredStats {
  return {
    providers: new Map(),
    totals: { sessions: 0, messages: 0, cost: 0, tokens: emptyTokens() },
    insights: { insights: [] },
  };
}

function emptyPeriodRawData(): PeriodRawData {
  return {
    totalCost: 0,
    assistantCost: 0,
    nonAssistantCost: 0,
    auxiliaryCost: 0,
    unresolvedToolCost: 0,
    unresolvedToolCount: 0,
    ctxHigh: { cost: 0, messages: 0 },
    ctxLow: { cost: 0, messages: 0 },
    projectCosts: new Map(),
    sessionCosts: new Map(),
    upfrontCost: 0,
    ttlMissCost: 0,
    modelSwitchMissCost: 0,
    prefixMissCost: 0,
    reasoningTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    freshTokens: 0,
  };
}

/**
 * Collapse a session cwd to a short, stable project label: `~` for the home
 * directory, up to two path segments below home (worktrees collapse to their
 * repository), absolute paths elsewhere.
 */
export function projectLabelFromCwd(cwd: string): string {
  if (!cwd) return "(unknown)";
  // Compare Windows paths (C:\Users\me\...) in their forward-slash form; the
  // label displays that normalized form.
  const normalized = cwd.replaceAll("\\", "/");
  // Collapse any home-directory prefix to "~", not just the current user's —
  // session stores merged from other machines can carry a different username.
  const home = homedir().replaceAll("\\", "/");
  let homePrefix: string | null = null;
  if (normalized === home || normalized.startsWith(`${home}/`)) {
    homePrefix = home;
  } else {
    const m = /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/.exec(normalized);
    if (m?.[1]) homePrefix = m[1];
  }
  if (homePrefix !== null && normalized.length <= homePrefix.length) return "~";
  let rel = homePrefix !== null ? normalized.slice(homePrefix.length + 1) : normalized;
  const wt = rel.indexOf("/.worktrees/");
  if (wt !== -1) rel = rel.slice(0, wt);
  const parts = rel.split("/").filter(Boolean);
  if (homePrefix !== null) return `~/${parts.slice(0, 2).join("/")}`;
  // A drive path outside a home (D:/work/repo/sub) keeps its meaningful
  // segments rather than the drive letter.
  const drive = /^[A-Za-z]:$/.test(parts[0] ?? "");
  const label = (drive ? parts.slice(1) : parts).slice(0, 2).join("/");
  return drive ? label : `/${label}`;
}

function emptyUsageData(bounds: PeriodBounds): UsageData {
  return {
    today: emptyTimeFilteredStats(),
    thisWeek: emptyTimeFilteredStats(),
    lastWeek: emptyTimeFilteredStats(),
    thisMonth: emptyTimeFilteredStats(),
    last30Days: emptyTimeFilteredStats(),
    allTime: emptyTimeFilteredStats(),
    hourly: new Map(),
    bounds,
  };
}

const HOUR_MS = 3_600_000;

function addToHourlyBuckets(hourly: Map<number, Map<HourlyKey, HourlyCell>>, msg: SessionMessage): void {
  if (msg.timestamp <= 0) return; // Unknown time can't be placed on a time axis.
  const hour = civilHourStart(msg.timestamp);
  let bucket = hourly.get(hour);
  if (!bucket) {
    bucket = new Map();
    hourly.set(hour, bucket);
  }
  const key = makeHourlyKey(msg.provider, msg.model, msg.thinkingLevel);
  let cell = bucket.get(key);
  if (!cell) {
    cell = { messages: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    bucket.set(key, cell);
  }
  if (msg.source === "assistant") cell.messages++;
  cell.cost += msg.cost;
  cell.input += msg.input;
  cell.output += msg.output;
  cell.cacheRead += msg.cacheRead;
  cell.cacheWrite += msg.cacheWrite;
  cell.reasoning += msg.reasoning;
}

// Helper to accumulate stats into a target
function accumulateStats(
  target: BaseStats,
  cost: number,
  tokens: { total: number; input: number; output: number; cacheRead: number; cacheWrite: number },
  countMessage: boolean,
): void {
  if (countMessage) target.messages++;
  target.cost += cost;
  target.tokens.total += tokens.total;
  target.tokens.input += tokens.input;
  target.tokens.output += tokens.output;
  target.tokens.cacheRead += tokens.cacheRead;
  target.tokens.cacheWrite += tokens.cacheWrite;
}

function getPeriodsForTimestamp(
  timestamp: number,
  todayMs: number,
  weekStartMs: number,
  lastWeekStartMs: number,
  thisMonthStartMs: number,
  last30DaysStartMs: number,
): TabName[] {
  const periods: TabName[] = ["allTime"];
  if (timestamp >= todayMs) periods.push("today");
  if (timestamp >= weekStartMs) {
    periods.push("thisWeek");
  } else if (timestamp >= lastWeekStartMs) {
    periods.push("lastWeek");
  }
  if (timestamp >= thisMonthStartMs) periods.push("thisMonth");
  if (timestamp >= last30DaysStartMs) periods.push("last30Days");
  return periods;
}

const DAY_MS = 24 * HOUR_MS;
const PROGRESS_REPORT_EVERY = 100;

function addMessagesToUsageData(
  data: UsageData,
  sessionId: string,
  project: string,
  messages: SessionMessage[],
  meta: MessageMeta[],
  todayMs: number,
  weekStartMs: number,
  lastWeekStartMs: number,
  thisMonthStartMs: number,
  last30DaysStartMs: number,
  rawByPeriod: Record<TabName, PeriodRawData>,
  costByDayIdx: Map<number, number>,
): void {
  const sessionContributed = {
    today: false,
    thisWeek: false,
    lastWeek: false,
    thisMonth: false,
    last30Days: false,
    allTime: false,
  };

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    const mm = meta[mi];
    if (!msg || !mm) continue;

    // pi's built-in test providers never call a real API — keep them out of stats.
    if (EXCLUDED_PROVIDERS.has(msg.provider)) continue;

    // Day-indexed cost totals power the burn-trend insight.
    if (msg.timestamp > 0) {
      const dayIdx = Math.floor((msg.timestamp - todayMs) / DAY_MS);
      costByDayIdx.set(dayIdx, (costByDayIdx.get(dayIdx) ?? 0) + msg.cost);
    }

    addToHourlyBuckets(data.hourly, msg);

    const periods = getPeriodsForTimestamp(
      msg.timestamp,
      todayMs,
      weekStartMs,
      lastWeekStartMs,
      thisMonthStartMs,
      last30DaysStartMs,
    );
    const tokens = {
      // Count fresh tokens processed this turn.
      // Include cacheWrite because those prompt tokens were newly written and billed.
      // Exclude cacheRead because repeated cache hits would otherwise dominate totals.
      total: msg.input + msg.output + msg.cacheWrite,
      input: msg.input,
      output: msg.output,
      cacheRead: msg.cacheRead,
      cacheWrite: msg.cacheWrite,
    };

    for (const period of periods) {
      const stats = data[period];

      let providerStats = stats.providers.get(msg.provider);
      if (!providerStats) {
        providerStats = emptyProviderStats();
        stats.providers.set(msg.provider, providerStats);
      }

      let modelStats = providerStats.models.get(msg.model);
      if (!modelStats) {
        modelStats = emptyModelStats();
        providerStats.models.set(msg.model, modelStats);
      }

      const isAssistant = msg.source === "assistant";
      modelStats.sessions.add(sessionId);
      accumulateStats(modelStats, msg.cost, tokens, isAssistant);

      providerStats.sessions.add(sessionId);
      accumulateStats(providerStats, msg.cost, tokens, isAssistant);

      accumulateStats(stats.totals, msg.cost, tokens, isAssistant);
      sessionContributed[period] = true;

      const raw = rawByPeriod[period];
      raw.totalCost += msg.cost;
      raw.projectCosts.set(project, (raw.projectCosts.get(project) ?? 0) + msg.cost);
      raw.sessionCosts.set(sessionId, (raw.sessionCosts.get(sessionId) ?? 0) + msg.cost);

      // Non-message usage belongs in accounting totals, project/session mix,
      // and burn trend, but not assistant-turn or cache-miss insights. Only
      // tool/summary reports lack a real provider/model attribution.
      if (!isAssistant) {
        raw.nonAssistantCost += msg.cost;
        if (msg.source === "auxiliary") raw.auxiliaryCost += msg.cost;
        if ("unresolvedToolUsage" in msg && msg.unresolvedToolUsage === true) {
          raw.unresolvedToolCost += msg.cost;
          raw.unresolvedToolCount++;
        }
        continue;
      }
      raw.assistantCost += msg.cost;

      const ctx = msg.input + msg.cacheRead + msg.cacheWrite;
      if (ctx >= CTX_TAX_THRESHOLD) {
        raw.ctxHigh.cost += msg.cost;
        raw.ctxHigh.messages++;
      } else if (ctx < CTX_LOW_THRESHOLD) {
        raw.ctxLow.cost += msg.cost;
        raw.ctxLow.messages++;
      }
      if (mm.isSessionStart) raw.upfrontCost += msg.cost;
      if (
        !msg.afterCompaction &&
        !msg.afterContextEdit &&
        mm.prevCtx >= MISS_MIN_PREV_CONTEXT &&
        msg.cacheRead < Math.min(MISS_MAX_CACHE_READ, 0.3 * mm.prevCtx)
      ) {
        if (mm.gapMs > TTL_GAP_MS) raw.ttlMissCost += msg.cost;
        else if (mm.gapMs >= 0 && mm.modelSwitched) raw.modelSwitchMissCost += msg.cost;
        else if (mm.gapMs >= 0) raw.prefixMissCost += msg.cost;
      }
      raw.reasoningTokens += msg.reasoning;
      raw.outputTokens += msg.output;
      raw.cacheReadTokens += msg.cacheRead;
      raw.freshTokens += msg.input + msg.cacheWrite;
    }
  }

  if (sessionContributed.today) data.today.totals.sessions++;
  if (sessionContributed.thisWeek) data.thisWeek.totals.sessions++;
  if (sessionContributed.lastWeek) data.lastWeek.totals.sessions++;
  if (sessionContributed.thisMonth) data.thisMonth.totals.sessions++;
  if (sessionContributed.last30Days) data.last30Days.totals.sessions++;
  if (sessionContributed.allTime) data.allTime.totals.sessions++;
}

// =============================================================================
// Nested tool-usage accounting
// =============================================================================

// Recognised nested-agent tool results report usage for child runs that
// pi-subagents also persists as ordinary session files, which this scan
// already counts with full model attribution. When every child session file
// behind a report is part of the scan, the children speak for themselves and
// the parent's aggregate is skipped. Partial canonical reports emit only missing
// vectors when both the report sum and persisted scanned contributions are exact.
// Otherwise retain and flag the unresolved aggregate; legacy missing children
// remain under Tools / summaries.
//
// Copied branch history gets a new parent filename, so a copy's runId-derived
// child paths can dangle even though the original's resolve. Resolved child
// identities are therefore unioned across all copies of an entry before any
// emission, and identical emissions collapse in the sourceId dedupe.

interface ScannedSessionIndex {
  /** Resolved paths of scanned files that have a session header. */
  paths: Set<string>;
  /** Directory of each scanned file → number of scanned files inside it. */
  fileCountByDir: Map<string, number>;
  soleFileByDir: Map<string, string>;
  messagesByPath: Map<string, SessionMessage[]>;
  /** Session-file lineage; absent parent paths are retained but not inferred. */
  lineage: Map<string, { parentPath?: string }>;
}

function parentSessionPath(filePath: string, parentSession: string): string | undefined {
  const trimmed = parentSession.trim();
  if (!trimmed) return undefined;
  return resolve(isAbsolute(trimmed) ? trimmed : join(dirname(filePath), trimmed));
}

function buildScannedSessionIndex(states: Map<string, CachedFileState>): ScannedSessionIndex {
  const paths = new Set<string>();
  const fileCountByDir = new Map<string, number>();
  const soleFileByDir = new Map<string, string>();
  const messagesByPath = new Map<string, SessionMessage[]>();
  const lineage = new Map<string, { parentPath?: string }>();
  for (const [filePath, state] of states) {
    if (!state.parsed.sessionId) continue;
    const resolved = resolve(filePath);
    paths.add(resolved);
    messagesByPath.set(resolved, state.parsed.messages);
    const dir = dirname(resolved);
    fileCountByDir.set(dir, (fileCountByDir.get(dir) ?? 0) + 1);
    soleFileByDir.set(dir, resolved);
    lineage.set(resolved, { parentPath: parentSessionPath(resolved, state.parsed.parentSession) });
  }
  return { paths, fileCountByDir, soleFileByDir, messagesByPath, lineage };
}

function sessionLineageContains(index: ScannedSessionIndex, descendantPath: string, ancestorPath: string): boolean {
  let current = resolve(descendantPath);
  const target = resolve(ancestorPath);
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    const parentPath = index.lineage.get(current)?.parentPath;
    if (!parentPath) return false;
    if (parentPath === target) return true;
    current = parentPath;
  }
  return false;
}

function sessionsAreRelated(index: ScannedSessionIndex, leftPath: string, rightPath: string): boolean {
  const left = resolve(leftPath);
  const right = resolve(rightPath);
  return left === right || sessionLineageContains(index, left, right) || sessionLineageContains(index, right, left);
}

function scannedChildPath(
  parentFilePath: string,
  tool: ToolUsageRecord,
  child: ChildToolUsage,
  index: ScannedSessionIndex,
): string | undefined {
  if (child.sessionFile) {
    const explicit = isAbsolute(child.sessionFile)
      ? resolve(child.sessionFile)
      : resolve(dirname(parentFilePath), child.sessionFile);
    if (index.paths.has(explicit)) return explicit;
  }
  if (tool.runId) {
    const runDir = resolve(
      dirname(parentFilePath),
      basename(parentFilePath, ".jsonl"),
      tool.runId,
      `run-${child.resultIndex}`,
    );
    // The run directory holds exactly one session per child run, so either the
    // conventional name or a lone scanned file inside it identifies the child.
    const conventional = join(runDir, "session.jsonl");
    if (index.paths.has(conventional)) return conventional;
    if (index.fileCountByDir.get(runDir) === 1) return index.soleFileByDir.get(runDir);
  }
  return undefined;
}

/** Identity of one child slot of one tool entry, stable across copied history. */
function toolChildIdentity(tool: ToolUsageRecord, child: ChildToolUsage): string {
  return JSON.stringify([tool.sourceId, tool.timestamp, child.resultIndex, cacheUsageAmount(child.usage)]);
}

interface ResolvedToolChild {
  filePath: string;
  childPath: string;
  identity: string;
}

function resolvedToolChildIdentities(
  states: Map<string, CachedFileState>,
  index: ScannedSessionIndex,
): ResolvedToolChild[] {
  const resolved: ResolvedToolChild[] = [];
  for (const [filePath, state] of states) {
    for (const tool of state.parsed.toolUsages) {
      if (!tool.sourceId) continue;
      for (const child of tool.children) {
        const childPath = scannedChildPath(filePath, tool, child, index);
        if (childPath) resolved.push({ filePath, childPath, identity: toolChildIdentity(tool, child) });
      }
    }
  }
  return resolved;
}

function toolUsageMessages(
  parentFilePath: string,
  tool: ToolUsageRecord,
  index: ScannedSessionIndex,
  resolvedChildren: readonly ResolvedToolChild[],
): Array<SessionMessage & { unresolvedToolUsage?: true }> {
  const scanned = (child: ChildToolUsage) =>
    scannedChildPath(parentFilePath, tool, child, index) ??
    (tool.sourceId
      ? resolvedChildren.find(
          (resolved) =>
            resolved.identity === toolChildIdentity(tool, child) &&
            sessionsAreRelated(index, resolved.filePath, parentFilePath),
        )?.childPath
      : undefined);
  if (tool.reportedUsage) {
    if (tool.children.length > 0 && tool.children.every(scanned)) return [];
    const resolved = tool.children.map(scanned);
    if (resolved.some(Boolean)) {
      const distinctPaths = new Set(resolved.filter((path) => path !== undefined));
      const proven =
        distinctPaths.size === resolved.filter(Boolean).length &&
        childrenExactlyReport(tool) &&
        tool.children.every((child, i) => {
          const path = resolved[i];
          return !path || exactUsageSpan(index.messagesByPath.get(path) ?? [], child.usage);
        });
      if (proven) {
        const missing = tool.children.filter((_child, i) => !resolved[i]);
        return [auxiliaryMessage(sumUsage(missing.map((child) => child.usage)), tool.timestamp, tool.sourceId)];
      }
      // No residual arithmetic on inconsistent vectors. Keep the original
      // report visible, but explicitly label this accounting as unresolved.
      return [{ ...auxiliaryMessage(tool.reportedUsage, tool.timestamp, tool.sourceId), unresolvedToolUsage: true }];
    }
    return [auxiliaryMessage(tool.reportedUsage, tool.timestamp, tool.sourceId)];
  }
  // Before Pi 0.81, recognised nested-agent tools persisted per-child usage in
  // details only. Count just the children whose sessions this scan cannot see.
  return tool.children
    .filter((child) => !scanned(child))
    .map((child) =>
      auxiliaryMessage(child.usage, tool.timestamp, tool.sourceId ? `${tool.sourceId}:child:${child.resultIndex}` : ""),
    );
}
// =============================================================================
// Collection orchestration
// =============================================================================

function sumUsage(amounts: UsageAmount[]): UsageAmount {
  const sum: UsageAmount = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  for (const amount of amounts) for (const key of USAGE_FIELDS) sum[key] += amount[key];
  return sum;
}

const USAGE_FIELDS = ["cost", "input", "output", "cacheRead", "cacheWrite", "reasoning"] as const;

function childrenExactlyReport(tool: ToolUsageRecord): boolean {
  const total = sumUsage(tool.children.map((child) => child.usage));
  return (
    new Set(tool.children.map((child) => child.resultIndex)).size === tool.children.length &&
    tool.children.every((child) => USAGE_FIELDS.every((key) => nonnegativeNumber(child.usage[key]))) &&
    USAGE_FIELDS.every((key) => total[key] === tool.reportedUsage?.[key])
  );
}

/** A reused child session can contain several calls. Require an exact contiguous
 * persisted vector, not a token sum, cost-only match, or numerical tolerance. */
function exactUsageSpan(messages: SessionMessage[], amount: UsageAmount): boolean {
  const prefix = sumUsage([]);
  const seen = new Set([JSON.stringify(cacheUsageAmount(prefix))]);
  const seenEntries = new Set<string>();
  for (const message of messages) {
    if (EXCLUDED_PROVIDERS.has(message.provider)) continue;
    if (message.sourceId) {
      const identity = messageIdentity(message);
      if (seenEntries.has(identity)) continue;
      seenEntries.add(identity);
    }
    if (!USAGE_FIELDS.every((key) => nonnegativeNumber(message[key]))) return false;
    for (const key of USAGE_FIELDS) prefix[key] += message[key];
    const difference = USAGE_FIELDS.map((key) => prefix[key] - amount[key]);
    if (seen.has(JSON.stringify(difference))) return true;
    seen.add(JSON.stringify(cacheUsageAmount(prefix)));
  }
  return false;
}

function messageIdentity(m: SessionMessage): string {
  return JSON.stringify([
    m.sourceId,
    m.provider,
    m.model,
    m.thinkingLevel,
    m.source,
    m.cost,
    m.input,
    m.output,
    m.cacheRead,
    m.cacheWrite,
    m.reasoning,
    m.timestamp,
  ]);
}

const STAT_CONCURRENCY = 16;
const DEFAULT_PARSE_CONCURRENCY = 4;
const AGGREGATE_YIELD_EVERY_FILES = 200;

export interface CollectProgress {
  /** Why this pass needs to parse files. */
  mode: "first-run" | "rebuild" | "update";
  /** Session files that need parsing this pass (0 = fully warm). */
  filesToParse: number;
  /** Files parsed so far; reported in coarse increments. */
  filesParsed: number;
  /** Newest session activity already ingested (ms since epoch); null when starting fresh. */
  sinceMs: number | null;
}

export interface CollectUsageOptions {
  signal?: AbortSignal;
  /** Called once before parsing begins and periodically while files are parsed. */
  onProgress?: (progress: CollectProgress) => void;
  /** Defaults to `<agentDir>/sessions`. */
  sessionsDir?: string;
  /** Defaults to `<agentDir>/usage-extension-cache.json`. Pass `null` to disable the on-disk cache. */
  cachePath?: string | null;
  /** Reference time for period bucketing. Defaults to `new Date()`. */
  now?: Date;
  parseConcurrency?: number;
}

export async function collectUsageData(options: CollectUsageOptions = {}): Promise<UsageData | null> {
  const signal = options.signal;
  const now = options.now ?? new Date();
  const sessionsDir = options.sessionsDir ?? getSessionsDir();
  const cachePath = options.cachePath === undefined ? getDefaultCachePath() : options.cachePath;
  const parseConcurrency = Math.max(1, options.parseConcurrency ?? DEFAULT_PARSE_CONCURRENCY);

  const todayMs = civilDayStart(now.getTime());

  // Reconstruct each intended midnight independently, including when today's
  // midnight is skipped and normalizes to 01:00.
  const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, ...
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStartMs = civilDayStart(now.getTime(), -daysSinceMonday);
  const lastWeekStartMs = civilDayStart(now.getTime(), -daysSinceMonday - 7);
  // Calendar month to date, from the first instant of the local first.
  const thisMonthStartMs = civilMonthStart(now.getTime());
  // Rolling 30 calendar days including today.
  const last30DaysStartMs = civilDayStart(now.getTime(), -29);

  // 1. Discover session files.
  const filePaths = await getAllSessionFiles(sessionsDir, signal);
  if (signal?.aborted) return null;

  // 2. Stat them (batched) so cache freshness can be checked without reading contents.
  const fileStats = new Map<string, { size: number; mtimeMs: number }>();
  {
    let next = 0;
    await Promise.all(
      Array.from({ length: STAT_CONCURRENCY }, async () => {
        while (next < filePaths.length) {
          if (signal?.aborted) return;
          const filePath = filePaths[next++];
          if (!filePath) continue;
          try {
            const st = await stat(filePath);
            fileStats.set(filePath, { size: st.size, mtimeMs: st.mtimeMs });
          } catch {
            // File vanished between listing and stat — skip it.
          }
        }
      }),
    );
  }
  if (signal?.aborted) return null;

  // 3. Load the cache and decide which files actually need parsing.
  let cacheFileExists = false;
  if (cachePath) {
    try {
      await stat(cachePath);
      cacheFileExists = true;
    } catch {
      // No cache file yet — first run.
    }
  }
  let previous: Map<string, CachedFileState>;
  try {
    previous = cachePath ? await loadUsageCache(cachePath, signal) : new Map<string, CachedFileState>();
  } catch (error) {
    if (signal?.aborted) return null;
    throw error;
  }
  if (signal?.aborted) return null;
  const current = new Map<string, CachedFileState>();
  const toParse: string[] = [];
  for (const filePath of filePaths) {
    const st = fileStats.get(filePath);
    if (!st) continue;
    const cached = previous.get(filePath);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      current.set(filePath, cached);
    } else {
      toParse.push(filePath);
    }
  }
  let dirty = toParse.length > 0;
  if (!dirty) {
    for (const filePath of previous.keys()) {
      if (!fileStats.has(filePath)) {
        dirty = true; // A cached file was deleted — evict it by rewriting.
        break;
      }
    }
  }

  // Progress reporting: distinguish a true first run from a format-change
  // rebuild (cache file present but unusable) and a routine incremental update.
  const progressMode: CollectProgress["mode"] =
    previous.size > 0 ? "update" : cacheFileExists ? "rebuild" : "first-run";
  let sinceMs: number | null = null;
  if (progressMode === "update") {
    for (const state of previous.values()) {
      if (state.mtimeMs > (sinceMs ?? 0)) sinceMs = state.mtimeMs;
    }
  }
  let filesParsed = 0;
  const reportProgress = (): void => {
    options.onProgress?.({ mode: progressMode, filesToParse: toParse.length, filesParsed, sinceMs });
  };
  reportProgress();

  // 4. Parse new/changed files with bounded concurrency.
  {
    let next = 0;
    await Promise.all(
      Array.from({ length: parseConcurrency }, async () => {
        while (next < toParse.length) {
          if (signal?.aborted) return;
          const filePath = toParse[next++];
          if (!filePath) continue;
          const st = fileStats.get(filePath);
          if (!st) continue;
          let buffer: Buffer;
          try {
            buffer = await readFile(filePath);
          } catch {
            filesParsed++;
            continue; // File vanished — skip it.
          }
          const parsed = await parseSessionBuffer(buffer, signal);
          if (signal?.aborted) return; // Never cache a partial parse.
          current.set(filePath, { size: st.size, mtimeMs: st.mtimeMs, parsed });
          filesParsed++;
          if (filesParsed % PROGRESS_REPORT_EVERY === 0 || filesParsed === toParse.length) {
            reportProgress();
          }
        }
      }),
    );
  }

  // A cancelled scan must not read/merge/serialize the entire cache just to
  // preserve completed files. The next invocation will reparse uncached files.
  if (signal?.aborted) return null;

  // 5. Persist the refreshed cache (also evicts entries for deleted files).
  if (cachePath && dirty) {
    await saveUsageCache(cachePath, current, { signal }).catch(() => {
      // Cache write failures (including cancellation) must never break /usage.
    });
    if (signal?.aborted) return null;
  }

  // 6. Aggregate in sorted path order with cross-file dedupe.
  const data = emptyUsageData({
    todayMs,
    weekStartMs,
    lastWeekStartMs,
    thisMonthStartMs,
    last30DaysStartMs,
    nowMs: now.getTime(),
  });
  const rawByPeriod: Record<TabName, PeriodRawData> = {
    today: emptyPeriodRawData(),
    thisWeek: emptyPeriodRawData(),
    lastWeek: emptyPeriodRawData(),
    thisMonth: emptyPeriodRawData(),
    last30Days: emptyPeriodRawData(),
    allTime: emptyPeriodRawData(),
  };
  const costByDayIdx = new Map<number, number>();
  const seenSessions = new Set<string>();
  const seenStableMessageProofs = new Set<string>();
  const seenLegacyMessageKeys = new Set<string>();
  const scannedSessions = buildScannedSessionIndex(current);
  const resolvedToolChildren = resolvedToolChildIdentities(current, scannedSessions);
  // Establish all matching observations before emitting anything. In particular,
  // two copies can be proven by a scanned parent that sorts after both of them.
  const messagesByFile = new Map<string, SessionMessage[]>();
  const observations: Array<{ filePath: string; identity: string }> = [];
  let proofFiles = 0;
  for (const [filePath, state] of current) {
    if (!state.parsed.sessionId) continue;
    if (++proofFiles % AGGREGATE_YIELD_EVERY_FILES === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (signal?.aborted) return null;
    }
    const toolMessages = state.parsed.toolUsages.flatMap((tool) =>
      toolUsageMessages(filePath, tool, scannedSessions, resolvedToolChildren),
    );
    const messages = [...state.parsed.messages, ...toolMessages];
    messagesByFile.set(filePath, messages);
    for (const message of messages) {
      if (message.sourceId) observations.push({ filePath: resolve(filePath), identity: messageIdentity(message) });
    }
  }
  const proofs = buildObservationProofs(scannedSessions.lineage, observations);
  let processedFiles = 0;

  for (const filePath of filePaths) {
    const state = current.get(filePath);
    if (!state?.parsed.sessionId) continue;

    if (++processedFiles % AGGREGATE_YIELD_EVERY_FILES === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (signal?.aborted) return null;
    }

    // Deduplicate copied history across branched session files, computing
    // adjacency metadata (idle gaps, previous context) on the raw file order
    // so branch copies do not distort miss classification.
    const rawMsgs = messagesByFile.get(filePath) ?? [];
    const deduped: SessionMessage[] = [];
    const meta: MessageMeta[] = [];
    let previousAssistant: SessionMessage | null = null;
    const assistantsById = new Map<string, SessionMessage>();
    for (const [messageIndex, m] of rawMsgs.entries()) {
      // Parent-linked journals can fork within one file. Use the assistant on
      // this entry's ancestor path, not the last assistant appended on a sibling.
      const prev =
        m.source !== "assistant"
          ? null
          : m.previousAssistantId === undefined
            ? previousAssistant
            : (assistantsById.get(m.previousAssistantId) ?? null);
      const warmAt = m.branchWarmAt;
      const previousRequestAt =
        prev && warmAt && warmAt > prev.timestamp && warmAt <= m.timestamp ? warmAt : prev?.timestamp;
      if (m.source === "assistant") {
        previousAssistant = m;
        if (m.sourceId) assistantsById.set(m.sourceId, m);
      }

      // Independent reused ids and conflicting accounting never share proof.
      if (m.sourceId) {
        const identity = messageIdentity(m);
        const proofPath = proofs.get(identity)?.get(resolve(filePath)) ?? resolve(filePath);
        const proof = JSON.stringify([identity, proofPath]);
        if (seenStableMessageProofs.has(proof)) continue;
        seenStableMessageProofs.add(proof);
      } else {
        const legacyKey = `${filePath}:${state.parsed.sessionId}:${messageIndex}`;
        if (seenLegacyMessageKeys.has(legacyKey)) continue;
        seenLegacyMessageKeys.add(legacyKey);
      }
      deduped.push(m);
      meta.push({
        gapMs:
          prev && previousRequestAt && previousRequestAt > 0 && m.timestamp > 0 ? m.timestamp - previousRequestAt : -1,
        prevCtx: prev ? prev.input + prev.cacheRead + prev.cacheWrite : 0,
        modelSwitched:
          prev !== null &&
          (prev.provider !== m.provider ||
            ((prev.responseModel ?? prev.model) !== (m.responseModel ?? m.model) &&
              (prev.model !== m.model || Boolean(prev.responseModel && m.responseModel)))),
        isSessionStart: false,
      });
    }
    if (deduped.length === 0) continue;
    const firstAssistantIndex = deduped.findIndex((m) => m.source === "assistant");
    if (firstAssistantIndex !== -1 && !seenSessions.has(state.parsed.sessionId)) {
      seenSessions.add(state.parsed.sessionId);
      const firstMeta = meta[firstAssistantIndex];
      if (firstMeta) firstMeta.isSessionStart = true;
    }

    addMessagesToUsageData(
      data,
      state.parsed.sessionId,
      projectLabelFromCwd(state.parsed.cwd),
      deduped,
      meta,
      todayMs,
      weekStartMs,
      lastWeekStartMs,
      thisMonthStartMs,
      last30DaysStartMs,
      rawByPeriod,
      costByDayIdx,
    );
  }

  // Burn trend: last 7 calendar days vs the average weekly pace of the prior 28.
  let last7 = 0;
  let prior28 = 0;
  for (const [idx, c] of costByDayIdx) {
    if (idx >= -6) last7 += c;
    else if (idx >= -34) prior28 += c;
  }
  const trend: TrendInfo | null = prior28 > 0 ? { last7Cost: last7, priorWeeklyPace: prior28 / 4 } : null;

  for (const period of TAB_ORDER) {
    data[period].insights = computeInsights(rawByPeriod[period], trend);
  }

  return data;
}

// =============================================================================
// Insights
// =============================================================================

// Context tax (structure)
const CTX_TAX_THRESHOLD = 150_000;
const CTX_LOW_THRESHOLD = 100_000;
// Project mix (structure)
const PROJECT_TOP_COUNT = 3;
const PROJECT_MAX_DOMINANCE_PERCENT = 90;
// Reasoning share (structure)
const REASONING_MIN_PERCENT = 5;
// Burn trend (structure)
const TREND_HIGH_RATIO = 1.5;
const TREND_LOW_RATIO = 0.6;
// Cache-miss alarms
const TTL_GAP_MS = 5 * 60_000;
const MISS_MIN_PREV_CONTEXT = 20_000;
const MISS_MAX_CACHE_READ = 5_000;
/** pi's built-in test providers never send anything to a real API. */
const EXCLUDED_PROVIDERS = new Set(["faux-provider", "fake-provider"]);

const CACHE_MISS_ALARM_PERCENT = 2;
const CACHE_MISS_ALARM_MIN_COST = 1;
// Concentration / upfront alarms
const TOP_SESSION_COUNT = 5;
const CONCENTRATION_ALARM_PERCENT = 35;
const UPFRONT_ALARM_PERCENT = 8;
// Cache-leverage alarm
const LEVERAGE_FLOOR = 5;
const LEVERAGE_MIN_COST = 5;
const LEVERAGE_MIN_FRESH_TOKENS = 1_000_000;

function fmtMoney(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  if (v >= 100) return `$${Math.round(v)}`;
  return `$${v.toFixed(2)}`;
}

function fmtPercent(p: number): string {
  return p >= 10 ? `${Math.round(p)}%` : `${p.toFixed(1)}%`;
}

/**
 * Insights come in two kinds:
 * - structure: always-on decomposition of where the period's cost went.
 * - alarm: flags unresolved accounting, or a material wasteful spend pattern.
 *   An all-clear period shows a calm panel instead of a wall of 2% factoids.
 * Spend insights require recorded cost. Accounting-integrity warnings do not:
 * zero/unknown-cost reports can still double-count tokens.
 */
function computeInsights(raw: PeriodRawData, trend: TrendInfo | null): PeriodInsights {
  const insights: Insight[] = [];

  // Integrity warnings survive even a zero-cost period's empty spend state.
  if (raw.unresolvedToolCount > 0) {
    insights.push({
      kind: "alarm",
      stat:
        raw.unresolvedToolCost > 0
          ? fmtMoney(raw.unresolvedToolCost)
          : `${raw.unresolvedToolCount} report${raw.unresolvedToolCount === 1 ? "" : "s"}`,
      headline: "tool reports have unresolved overlap with scanned child usage",
      advice:
        "Totals retain these reports and may double-count child usage. Exact cost and token vectors did not prove a safe reconciliation.",
    });
  }

  if (raw.totalCost <= 0) return { insights };
  const total = raw.totalCost;
  const assistantTotal = raw.assistantCost;
  const assistantPctLabel = raw.nonAssistantCost > 0 ? "assistant-message cost" : "this period";

  // --- Spend alarms (listed before structure) ---

  const ttlPct = assistantTotal > 0 ? (raw.ttlMissCost / assistantTotal) * 100 : 0;
  if (ttlPct >= CACHE_MISS_ALARM_PERCENT && raw.ttlMissCost >= CACHE_MISS_ALARM_MIN_COST) {
    insights.push({
      kind: "alarm",
      stat: fmtMoney(raw.ttlMissCost),
      headline: `spent resuming conversations after a break (${fmtPercent(ttlPct)} of ${assistantPctLabel})`,
      advice:
        "Sent context is only reusable for a few minutes. After a longer pause, the next message pays to send the whole conversation again. Replying while a session is fresh avoids this.",
    });
  }

  const switchPct = assistantTotal > 0 ? (raw.modelSwitchMissCost / assistantTotal) * 100 : 0;
  if (switchPct >= CACHE_MISS_ALARM_PERCENT && raw.modelSwitchMissCost >= CACHE_MISS_ALARM_MIN_COST) {
    insights.push({
      kind: "alarm",
      stat: fmtMoney(raw.modelSwitchMissCost),
      headline: `spent switching models mid-conversation (${fmtPercent(switchPct)} of ${assistantPctLabel})`,
      advice:
        "Changing model re-sends the whole conversation at full price — the previous model's saved context doesn't transfer. Switching between tasks instead of mid-conversation avoids this.",
    });
  }

  const prefixPct = assistantTotal > 0 ? (raw.prefixMissCost / assistantTotal) * 100 : 0;
  if (prefixPct >= CACHE_MISS_ALARM_PERCENT && raw.prefixMissCost >= CACHE_MISS_ALARM_MIN_COST) {
    insights.push({
      kind: "alarm",
      stat: fmtMoney(raw.prefixMissCost),
      headline: `spent re-sending conversations mid-session (${fmtPercent(prefixPct)} of ${assistantPctLabel})`,
      advice:
        "These messages paid full price for context that had already been sent — with no break, compaction, context edit, or model switch to explain it. Usually a tool or workflow is restarting or rewriting conversations. Worth a look if it stays high.",
    });
  }

  if (raw.sessionCosts.size > TOP_SESSION_COUNT) {
    const sortedSessions = Array.from(raw.sessionCosts.values()).sort((a, b) => b - a);
    const topWeight = sortedSessions.slice(0, TOP_SESSION_COUNT).reduce((sum, c) => sum + c, 0);
    const topPct = (topWeight / total) * 100;
    if (topPct >= CONCENTRATION_ALARM_PERCENT) {
      insights.push({
        kind: "alarm",
        stat: fmtMoney(topWeight),
        headline: `came from just ${TOP_SESSION_COUNT} of your ${raw.sessionCosts.size} sessions (${fmtPercent(topPct)} of this period)`,
        advice: "A handful of sessions drove most of the spend. The graph view can show what they were doing.",
      });
    }
  }

  const upfrontPct = assistantTotal > 0 ? (raw.upfrontCost / assistantTotal) * 100 : 0;
  if (upfrontPct >= UPFRONT_ALARM_PERCENT) {
    insights.push({
      kind: "alarm",
      stat: fmtMoney(raw.upfrontCost),
      headline: `spent on the opening message of new sessions (${fmtPercent(upfrontPct)} of ${assistantPctLabel})`,
      advice: "A session's first message sends everything from scratch. Fewer, longer sessions cut this overhead.",
    });
  }

  if (assistantTotal >= LEVERAGE_MIN_COST && raw.freshTokens >= LEVERAGE_MIN_FRESH_TOKENS) {
    const leverage = raw.cacheReadTokens / raw.freshTokens;
    if (leverage < LEVERAGE_FLOOR) {
      insights.push({
        kind: "alarm",
        stat: `${leverage.toFixed(1)}×`,
        headline: "tokens reused from history for every token paid at full price",
        advice:
          "Typical interactive use reuses 10× or more. A low number means conversations keep being sent from scratch — look for workflows that restart sessions.",
      });
    }
  }

  // --- Structure (always-on) ---

  if (raw.auxiliaryCost > 0) {
    const pct = (raw.auxiliaryCost / total) * 100;
    if (pct >= 1) {
      insights.push({
        kind: "structure",
        stat: fmtPercent(pct),
        headline: "of your cost came from usage reported by tools and conversation summaries",
        advice: "Pi records this separately because it cannot be attributed reliably to a specific provider and model.",
      });
    }
  }

  if (raw.ctxHigh.messages > 0 && assistantTotal > 0) {
    const pct = (raw.ctxHigh.cost / assistantTotal) * 100;
    if (pct >= 1) {
      const avgHigh = raw.ctxHigh.cost / raw.ctxHigh.messages;
      const avgLow = raw.ctxLow.messages > 0 ? raw.ctxLow.cost / raw.ctxLow.messages : 0;
      const cmp =
        avgLow > 0
          ? ` — ${fmtMoney(avgHigh)}/msg vs ${fmtMoney(avgLow)} under ${formatThresholdTokens(CTX_LOW_THRESHOLD)}`
          : "";
      insights.push({
        kind: "structure",
        stat: fmtPercent(pct),
        headline: `of your ${raw.nonAssistantCost > 0 ? "assistant-message cost" : "cost"} came from messages with ≥${formatThresholdTokens(CTX_TAX_THRESHOLD)} tokens loaded${cmp}`,
        advice: "Long conversations cost more per message. /compact mid-task and /clear between tasks keep them lean.",
      });
    }
  }

  if (raw.projectCosts.size >= 2) {
    const top = [...raw.projectCosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, PROJECT_TOP_COUNT);
    const topPct = (top[0]?.[1] / total) * 100;
    if (topPct < PROJECT_MAX_DOMINANCE_PERCENT) {
      const rest = top
        .slice(1)
        .map(([label, c]) => `${label} ${fmtPercent((c / total) * 100)}`)
        .join(", ");
      insights.push({
        kind: "structure",
        stat: fmtPercent(topPct),
        headline: `of your cost was ${top[0]?.[0]}${rest ? ` — then ${rest}` : ""}`,
        advice: "",
      });
    }
  }

  if (raw.outputTokens > 0) {
    const reasoningPct = (raw.reasoningTokens / raw.outputTokens) * 100;
    if (reasoningPct >= REASONING_MIN_PERCENT) {
      insights.push({
        kind: "structure",
        stat: fmtPercent(reasoningPct),
        headline: "of your output tokens were hidden reasoning",
        advice:
          "Models charge for their behind-the-scenes thinking as output tokens. pi records this only from 0.80.3 (June 2026), so older periods understate it.",
      });
    }
  }

  if (trend && trend.priorWeeklyPace > 0) {
    const ratio = trend.last7Cost / trend.priorWeeklyPace;
    const advice =
      ratio >= TREND_HIGH_RATIO
        ? "Spending is up against your own baseline — the graph view shows what changed."
        : ratio <= TREND_LOW_RATIO
          ? "Spending is well below your recent baseline."
          : "";
    insights.push({
      kind: "structure",
      stat: `${ratio.toFixed(1)}×`,
      headline: `your last 7 days (${fmtMoney(trend.last7Cost)}) vs your prior 4-week pace (${fmtMoney(trend.priorWeeklyPace)}/wk)`,
      advice,
    });
  }

  return { insights };
}

function formatThresholdTokens(n: number): string {
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  if (n >= 1_000) return `${n / 1_000}k`;
  return String(n);
}
