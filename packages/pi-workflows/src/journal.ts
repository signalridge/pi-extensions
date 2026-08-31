/**
 * journal.ts — durable journal for script-based workflow runs (schema v4).
 *
 * A script run is journaled as an ordered event stream in the session entry
 * store. `run_created` carries the raw script, its hash, and its parsed meta
 * (the runtime re-derives call indexes from the script itself, so no task
 * array is persisted). Each completed `agent()`/`checkpoint()` call journals a
 * `call_result` keyed by its lexical call index; a nested workflow journals a
 * `workflow_result` at its parent call index; a resume rebuilds the
 * runtime's `resumeJournal` map from these entries and replays the longest
 * unchanged prefix. Nested `workflow()` calls are represented by one
 * `workflow_result` boundary in the parent namespace, so child calls can be
 * replayed without re-spawning the whole nested run.
 *
 * The atomic recovery machinery (run/terminal/attempt recovery with generation
 * rotations, quarantine of malformed runs, stale-generation rejection) is
 * preserved from the declarative journal and re-keyed to call indexes, because
 * interrupted managed spawns still need generation rotation on restore.
 *
 * Schema-v3 and older runs are quarantined rather than replayed — the call
 * hash and metadata contracts changed, and a script run must not silently
 * inherit incompatible bookkeeping.
 */

import { createHash } from "node:crypto";
import type { ManagedOwner } from "@signalridge/pi-subagents-protocol";
import { isManagedAgentTier } from "@signalridge/pi-subagents-protocol";
import {
  MAX_CALLS_PER_WORKFLOW,
  normalizeAgentRetries,
  normalizeAgentTimeout,
  normalizeConcurrency,
  normalizeMaxAgents,
  normalizeTokenBudget,
  type WorkflowMeta,
} from "./runtime.js";

export const JOURNAL_ENTRY_TYPE = "pi-workflows:journal";
/** Breaking journal contract: v3 facts are quarantined, never replayed. */
export const JOURNAL_SCHEMA_VERSION = 4;
export type JournalSchemaVersion = 4;
export const JOURNAL_TEXT_LIMIT = 8_000;
export const JOURNAL_SCRIPT_LIMIT = 200_000;
export const JOURNAL_ERROR_LIMIT = 2_000;
export const JOURNAL_ID_LIMIT = 256;
export const JOURNAL_TIMESTAMP_LIMIT = 8_640_000_000_000_000;
export const JOURNAL_RECOVERY_ID_PREFIX = "r4-";
export const JOURNAL_RECOVERY_ID_LIMIT = JOURNAL_RECOVERY_ID_PREFIX.length + 64;
/** Maximum number of distinct atomic recoveries retained while replaying one run. */
export const JOURNAL_RECOVERY_SEEN_LIMIT = 4_096;
/** A script run may issue up to 1000 agent()/workflow()/checkpoint() calls. */
export const JOURNAL_CALL_LIMIT = MAX_CALLS_PER_WORKFLOW;
/** One atomic recovery event may rotate every active call in a run. */
export const JOURNAL_RECOVERY_NODE_LIMIT = JOURNAL_CALL_LIMIT;
const RECOVERY_ID_PATTERN = /^r4-[0-9a-f]{64}$/;

export class StaleJournalGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleJournalGenerationError";
  }
}

export type WorkflowStatus =
  | "pending"
  | "running"
  | "pausing"
  | "paused"
  | "stopping"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";

export type CallStatus = "running" | "completed" | "failed" | "stopped";

const WORKFLOW_STATUS_VALUES = new Set<WorkflowStatus>([
  "pending",
  "running",
  "pausing",
  "paused",
  "stopping",
  "completed",
  "failed",
  "stopped",
  "interrupted",
]);
const CALL_STATUS_VALUES = new Set<CallStatus>(["running", "completed", "failed", "stopped"]);
const JOURNAL_KINDS = new Set([
  "run_created",
  "run_revision",
  "run_removed",
  "workflow_transition",
  "run_recovery",
  "terminal_recovery",
  "attempt_recovery",
  "call_transition",
  "call_attempt",
  "call_result",
  "workflow_result",
]);

export type WorkflowOwner = ManagedOwner;

/** The Agent tier one journaled call resolved to. */
export interface CallTierIdentity {
  tier?: string;
}

/** A completed agent()/checkpoint() call, journaled for resume replay. */
export interface CallResult extends CallTierIdentity {
  status: "completed" | "failed" | "stopped";
  agentId?: string;
  attemptId?: string;
  /** The JSON-serializable call result (text for plain agents, parsed value for schema agents). */
  result?: unknown;
  error?: string;
  outputFile?: string;
  tokenCount?: number;
  compactionCount: number;
  updatedAt: number;
}

export interface ScriptRun {
  runId: string;
  schemaVersion: number;
  script: string;
  scriptHash: string;
  meta: WorkflowMeta;
  /** Frozen invocation input reused by automatic and manual resume. */
  args?: unknown;
  /** Explicit marker recording whether the current run was given args. */
  frozenArgsPresent: boolean;
  /** Number of the latest edited-script revision. */
  revision?: number;
  /** Toolset marker persisted across resume (e.g. "web-research" for deep-research). */
  toolset?: string;
  /** Frozen run params — persisted so resume after restore keeps original budget/scale. */
  frozenMaxAgents?: number;
  frozenConcurrency?: number;
  frozenAgentRetries?: number;
  frozenTokenBudget?: number | null;
  frozenAgentTimeoutMs?: number | null;
  frozenExcludeTools?: string[];
  status: WorkflowStatus;
  /** Call index → status. Absent entries were never dispatched (replayed or skipped). */
  callStatus: Record<string, CallStatus>;
  agentIds: Record<string, string>;
  /** Monotonic per-call attempt generation; completed facts are never reset. */
  attempts: Record<string, number>;
  attemptIds: Record<string, string>;
  attemptTracking?: boolean;
  /** Call index → journaled result (the resume journal source). */
  callResults: Record<string, CallResult>;
  /** Call index → resolved tier identity for live and stopped calls. */
  callTiers: Record<string, CallTierIdentity>;
  /** Call index → latest accepted nested workflow result generation. */
  workflowResultGenerations: Record<string, number>;
  compactions: Record<string, number>;
  startedAt: number;
  updatedAt: number;
  error?: string;
  /** Bounded JSON-serializable terminal script value for restored inspection. */
  finalResult?: unknown;
  nonResumable?: boolean;
  /** Terminal cleanup intent while active agents settle. */
  terminalIntent?: "stop" | "failure";
}

interface JournalBase {
  schemaVersion: JournalSchemaVersion;
  runId: string;
  timestamp: number;
}

/** State observed immediately before an atomic recovery rotation. */
export type RecoverySourceStatus = CallStatus | "running";

export interface RecoveryRotation extends CallTierIdentity {
  nodeId: string;
  sourceAttemptId: string;
  sourceGeneration: number;
  sourceStatus: RecoverySourceStatus;
  attemptId: string;
  generation: number;
  owner: WorkflowOwner;
  supersededAgentId?: string;
}

export interface RecoveryTerminalResult {
  nodeId: string;
  attemptId: string;
  result: CallResult;
  owner: WorkflowOwner;
}

export interface RunRecoveryEvent extends JournalBase {
  kind: "run_recovery";
  status: "interrupted";
  branchGeneration: number;
  rotations: RecoveryRotation[];
  terminalResults?: RecoveryTerminalResult[];
  recoveryId: string;
  timestamp: number;
}

export interface TerminalRecoveryEvent extends JournalBase {
  kind: "terminal_recovery";
  status: "failed" | "stopped";
  terminalIntent: "failure" | "stop";
  branchGeneration: number;
  terminalResults: RecoveryTerminalResult[];
  blockedNodeIds: string[];
  error?: string;
  recoveryId: string;
  timestamp: number;
}

export interface AttemptRecoveryEvent extends JournalBase {
  kind: "attempt_recovery";
  nodeId: string;
  branchGeneration: number;
  rotation: RecoveryRotation;
}

export type JournalEvent =
  | (JournalBase & {
      kind: "run_created";
      script: string;
      scriptHash: string;
      meta: WorkflowMeta;
      args?: unknown;
      /** Explicit args presence marker for deterministic resume. */
      frozenArgsPresent: boolean;
      toolset?: string;
      frozenMaxAgents?: number;
      frozenConcurrency?: number;
      frozenAgentRetries?: number;
      frozenTokenBudget?: number | null;
      frozenAgentTimeoutMs?: number | null;
      frozenExcludeTools?: string[];
      attempts?: Record<string, number>;
      attemptIds?: Record<string, string>;
    })
  | (JournalBase & {
      kind: "run_revision";
      revision: number;
      script: string;
      scriptHash: string;
      meta: WorkflowMeta;
    })
  | (JournalBase & {
      kind: "run_removed";
    })
  | (JournalBase & {
      kind: "workflow_transition";
      status: WorkflowStatus;
      error?: string;
      finalResult?: unknown;
      terminalIntent?: "stop" | "failure";
    })
  | RunRecoveryEvent
  | TerminalRecoveryEvent
  | AttemptRecoveryEvent
  | (JournalBase & {
      kind: "call_transition";
      nodeId: string;
      status: CallStatus;
      tier?: string;
      agentId?: string;
      attemptId?: string;
      owner?: WorkflowOwner;
    })
  | (JournalBase & {
      kind: "call_attempt";
      nodeId: string;
      attemptId: string;
      generation: number;
      tier?: string;
      owner?: WorkflowOwner;
    })
  | (JournalBase & {
      kind: "call_result";
      nodeId: string;
      result: CallResult;
      /** Stable hash of the call inputs (prompt/model/tier/phase/schema). */
      callHash?: string;
      /** Store write delta to replay additively on resume. */
      storeDelta?: Record<string, unknown>;
      attemptId?: string;
      owner?: WorkflowOwner;
    })
  | (JournalBase & {
      /** A completed nested workflow result, without managed-spawn attempt identity. */
      kind: "workflow_result";
      nodeId: string;
      result: CallResult;
      /** Monotonic nested-call generation used to fence changed/resumed children. */
      generation: number;
      /** Logical agents represented by this nested replay boundary. */
      agentCount?: number;
      /** Stable hash of the nested workflow name/script/args. */
      callHash: string;
      /** Store writes produced by the child, merged in child call order. */
      storeDelta?: Record<string, unknown>;
    });

export interface JournalWriter {
  append(event: JournalEvent): void;
}

export interface SessionEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}

export interface ReplayJournalOptions {
  onInvalid?: (diagnostic: string) => void;
  /** Internal observer for events that passed replay validation and were applied. */
  onAccepted?: (event: JournalEvent) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) {
    throw new Error(`${label} is invalid or exceeds ${limit} characters`);
  }
  return value;
}

function validTimestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > JOURNAL_TIMESTAMP_LIMIT) {
    throw new Error(`${label} timestamp is invalid`);
  }
  return value;
}

function parseCallIndex(value: unknown, label: string): string {
  const index = boundedString(value, label, JOURNAL_ID_LIMIT);
  if (!/^(?:0|[1-9]\d*)$/u.test(index) || Number(index) >= JOURNAL_CALL_LIMIT) {
    throw new Error(`${label} is not a valid call index`);
  }
  return index;
}

function parsePersistedValue(raw: unknown, label: string): unknown {
  try {
    const cloned = structuredClone(raw);
    const serialized = JSON.stringify(cloned);
    if (serialized === undefined) throw new Error(`${label} is not JSON-serializable`);
    if (serialized.length > JOURNAL_SCRIPT_LIMIT) throw new Error(`${label} exceeds the persistence limit`);
    return cloned;
  } catch (error: unknown) {
    throw new Error(error instanceof Error ? error.message : `${label} is not structured-cloneable`);
  }
}

function parseMeta(raw: unknown): WorkflowMeta {
  if (!isRecord(raw)) throw new Error("meta is invalid");
  const name = boundedString(raw.name, "meta.name", 512);
  const description = boundedString(raw.description, "meta.description", 100_000);
  if (Object.hasOwn(raw, "model") || Object.hasOwn(raw, "thinking")) {
    throw new Error("workflow journal meta model/thinking fields are unsupported");
  }
  const meta: WorkflowMeta = { name, description };
  if (raw.phases !== undefined) {
    if (!Array.isArray(raw.phases)) throw new Error("meta.phases must be an array");
    meta.phases = raw.phases.map((phase, i) => {
      if (!isRecord(phase) || typeof phase.title !== "string" || phase.title.length === 0) {
        throw new Error(`meta.phases[${i}].title is invalid`);
      }
      if (Object.hasOwn(phase, "model") || Object.hasOwn(phase, "thinking")) {
        throw new Error(`workflow journal phase ${i} model/thinking fields are unsupported`);
      }
      const out: NonNullable<WorkflowMeta["phases"]>[number] = { title: phase.title.slice(0, 512) };
      if (phase.detail !== undefined) out.detail = String(phase.detail).slice(0, 2_000);
      return out;
    });
  }
  return meta;
}

function parseCallTierIdentity(raw: Record<string, unknown>, label: string): CallTierIdentity {
  if (raw.tier === undefined) return {};
  if (!isManagedAgentTier(raw.tier)) throw new Error(`${label}.tier is invalid`);
  return { tier: raw.tier };
}

function parseResult(raw: unknown, label: string): CallResult {
  if (!isRecord(raw)) throw new Error(`${label} is invalid`);
  const status = raw.status;
  if (status !== "completed" && status !== "failed" && status !== "stopped") {
    throw new Error(`${label} status is invalid`);
  }
  const compactionCount = raw.compactionCount;
  if (typeof compactionCount !== "number" || !Number.isInteger(compactionCount) || compactionCount < 0) {
    throw new Error(`${label} compactionCount is invalid`);
  }
  const updatedAt = validTimestamp(raw.updatedAt, label);
  const tierIdentity = parseCallTierIdentity(raw, label);
  const result: CallResult = {
    status,
    compactionCount,
    updatedAt,
    ...tierIdentity,
    ...(raw.agentId === undefined ? {} : { agentId: boundedString(raw.agentId, `${label}.agentId`, JOURNAL_ID_LIMIT) }),
    ...(raw.attemptId === undefined
      ? {}
      : { attemptId: boundedString(raw.attemptId, `${label}.attemptId`, JOURNAL_ID_LIMIT) }),
    ...(raw.result === undefined ? {} : { result: raw.result }),
    ...(raw.error === undefined ? {} : { error: boundedString(raw.error, `${label}.error`, JOURNAL_ERROR_LIMIT) }),
    ...(raw.outputFile === undefined
      ? {}
      : { outputFile: boundedString(raw.outputFile, `${label}.outputFile`, JOURNAL_ID_LIMIT) }),
    ...(raw.tokenCount === undefined
      ? {}
      : {
          tokenCount: (() => {
            if (typeof raw.tokenCount !== "number" || !Number.isInteger(raw.tokenCount) || raw.tokenCount < 0) {
              throw new Error(`${label}.tokenCount is invalid`);
            }
            return raw.tokenCount;
          })(),
        }),
  };
  return result;
}

function mergeCallResultTierIdentity(previous: CallTierIdentity | undefined, result: CallResult): CallResult {
  return result.tier === undefined && previous?.tier !== undefined ? { ...result, tier: previous.tier } : result;
}

function priorCallTierIdentity(run: ScriptRun, nodeId: string): CallTierIdentity {
  return {
    ...(run.callTiers[nodeId] ?? {}),
    ...(run.callResults[nodeId]?.tier === undefined ? {} : { tier: run.callResults[nodeId].tier }),
  };
}

function parseOwner(raw: unknown, runId: string, nodeId: string): WorkflowOwner {
  if (!isRecord(raw) || raw.extension !== "pi-workflows") throw new Error("journal owner is invalid");
  const ownerRunId = boundedString(raw.runId, "owner.runId", JOURNAL_ID_LIMIT);
  const ownerNodeId = boundedString(raw.nodeId, "owner.nodeId", JOURNAL_ID_LIMIT);
  if (ownerRunId !== runId || ownerNodeId !== nodeId) {
    throw new Error("journal owner does not match its event");
  }
  return {
    extension: "pi-workflows",
    runId: ownerRunId,
    nodeId: ownerNodeId,
    ...(raw.attemptId === undefined
      ? {}
      : { attemptId: boundedString(raw.attemptId, "owner.attemptId", JOURNAL_ID_LIMIT) }),
  };
}

function parseAttemptMap(raw: unknown, label: string): Record<string, number> {
  if (!isRecord(raw)) throw new Error(`${label} is invalid`);
  const out: Record<string, number> = {};
  for (const [nodeId, generation] of Object.entries(raw)) {
    parseCallIndex(nodeId, `${label} key`);
    if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) {
      throw new Error(`${label}.${nodeId} generation is invalid`);
    }
    out[nodeId] = generation;
  }
  return out;
}

function parseAttemptIdMap(raw: unknown, label: string): Record<string, string> {
  if (!isRecord(raw)) throw new Error(`${label} is invalid`);
  const out: Record<string, string> = {};
  for (const [nodeId, attemptId] of Object.entries(raw)) {
    parseCallIndex(nodeId, `${label} key`);
    out[nodeId] = boundedString(attemptId, `${label}.${nodeId}`, JOURNAL_ID_LIMIT);
  }
  return out;
}

function defaultAttemptId(runId: string, nodeId: string, generation = 1): string {
  return `${runId}/${nodeId}/attempt-${generation}`;
}

function parseRotation(raw: unknown, runId: string): RecoveryRotation {
  if (!isRecord(raw)) throw new Error("recovery rotation is invalid");
  const nodeId = parseCallIndex(raw.nodeId, "rotation.nodeId");
  const sourceAttemptId = boundedString(raw.sourceAttemptId, "rotation.sourceAttemptId", JOURNAL_ID_LIMIT);
  const sourceGeneration = raw.sourceGeneration;
  if (typeof sourceGeneration !== "number" || !Number.isInteger(sourceGeneration) || sourceGeneration < 1) {
    throw new Error("rotation.sourceGeneration is invalid");
  }
  const sourceStatus = raw.sourceStatus;
  if (
    sourceStatus !== "running" &&
    sourceStatus !== "completed" &&
    sourceStatus !== "failed" &&
    sourceStatus !== "stopped"
  ) {
    throw new Error("rotation.sourceStatus is invalid");
  }
  const attemptId = boundedString(raw.attemptId, "rotation.attemptId", JOURNAL_ID_LIMIT);
  const generation = raw.generation;
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) {
    throw new Error("rotation.generation is invalid");
  }
  if (generation <= sourceGeneration) throw new Error("rotation generation must exceed its source");
  const owner = parseOwner(raw.owner, runId, nodeId);
  if (owner.attemptId !== attemptId) throw new Error("rotation owner does not match its attempt");
  const tierIdentity = parseCallTierIdentity(raw, "rotation");
  return {
    nodeId,
    sourceAttemptId,
    sourceGeneration,
    sourceStatus,
    attemptId,
    generation,
    owner,
    ...tierIdentity,
    ...(raw.supersededAgentId === undefined
      ? {}
      : { supersededAgentId: boundedString(raw.supersededAgentId, "rotation.supersededAgentId", JOURNAL_ID_LIMIT) }),
  };
}

function parseTerminalResult(raw: unknown, runId: string): RecoveryTerminalResult {
  if (!isRecord(raw)) throw new Error("recovery terminal result is invalid");
  const nodeId = parseCallIndex(raw.nodeId, "terminal.nodeId");
  const attemptId = boundedString(raw.attemptId, "terminal.attemptId", JOURNAL_ID_LIMIT);
  const result = parseResult(raw.result, "terminal.result");
  const owner = parseOwner(raw.owner, runId, nodeId);
  if (owner.attemptId !== attemptId) throw new Error("terminal owner does not match its attempt");
  return { nodeId, attemptId, result, owner };
}

function parseRunRecovery(raw: Record<string, unknown>, run: ScriptRun, timestamp: number): RunRecoveryEvent {
  if (raw.status !== "interrupted") throw new Error("run recovery status is invalid");
  if (typeof raw.branchGeneration !== "number" || !Number.isInteger(raw.branchGeneration) || raw.branchGeneration < 0) {
    throw new Error("run recovery branchGeneration is invalid");
  }
  if (!Array.isArray(raw.rotations) || raw.rotations.length > JOURNAL_RECOVERY_NODE_LIMIT) {
    throw new Error("run recovery rotations are invalid");
  }
  const rotations = raw.rotations.map((rotation) => parseRotation(rotation, run.runId));
  const terminalResults =
    raw.terminalResults === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(raw.terminalResults) || raw.terminalResults.length > JOURNAL_RECOVERY_NODE_LIMIT) {
            throw new Error("run recovery terminalResults are invalid");
          }
          return raw.terminalResults.map((terminal) => parseTerminalResult(terminal, run.runId));
        })();
  const recoveryId = boundedString(raw.recoveryId, "recoveryId", JOURNAL_RECOVERY_ID_LIMIT);
  if (!RECOVERY_ID_PATTERN.test(recoveryId)) throw new Error("recoveryId is malformed");
  return {
    kind: "run_recovery",
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    runId: run.runId,
    status: "interrupted",
    branchGeneration: raw.branchGeneration,
    rotations,
    ...(terminalResults === undefined || terminalResults.length === 0 ? {} : { terminalResults }),
    recoveryId,
    timestamp,
  };
}

function parseTerminalRecovery(raw: Record<string, unknown>, run: ScriptRun, timestamp: number): TerminalRecoveryEvent {
  if (raw.status !== "failed" && raw.status !== "stopped") throw new Error("terminal recovery status is invalid");
  if (raw.terminalIntent !== "failure" && raw.terminalIntent !== "stop") {
    throw new Error("terminal recovery intent is invalid");
  }
  if (typeof raw.branchGeneration !== "number" || !Number.isInteger(raw.branchGeneration) || raw.branchGeneration < 0) {
    throw new Error("terminal recovery branchGeneration is invalid");
  }
  if (!Array.isArray(raw.terminalResults) || raw.terminalResults.length > JOURNAL_RECOVERY_NODE_LIMIT) {
    throw new Error("terminal recovery terminalResults are invalid");
  }
  const terminalResults = raw.terminalResults.map((terminal) => parseTerminalResult(terminal, run.runId));
  if (!Array.isArray(raw.blockedNodeIds) || raw.blockedNodeIds.length > JOURNAL_RECOVERY_NODE_LIMIT) {
    throw new Error("terminal recovery blockedNodeIds are invalid");
  }
  const blockedNodeIds = raw.blockedNodeIds.map((nodeId) => parseCallIndex(nodeId, "blockedNodeId"));
  const recoveryId = boundedString(raw.recoveryId, "recoveryId", JOURNAL_RECOVERY_ID_LIMIT);
  if (!RECOVERY_ID_PATTERN.test(recoveryId)) throw new Error("recoveryId is malformed");
  return {
    kind: "terminal_recovery",
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    runId: run.runId,
    status: raw.status,
    terminalIntent: raw.terminalIntent,
    branchGeneration: raw.branchGeneration,
    terminalResults,
    blockedNodeIds,
    ...(raw.error === undefined
      ? {}
      : { error: boundedString(raw.error, "terminal recovery error", JOURNAL_ERROR_LIMIT) }),
    recoveryId,
    timestamp,
  };
}

function parseAttemptRecovery(raw: Record<string, unknown>, run: ScriptRun, timestamp: number): AttemptRecoveryEvent {
  if (typeof raw.branchGeneration !== "number" || !Number.isInteger(raw.branchGeneration) || raw.branchGeneration < 0) {
    throw new Error("attempt recovery branchGeneration is invalid");
  }
  const rotation = parseRotation(raw.rotation, run.runId);
  return {
    kind: "attempt_recovery",
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    runId: run.runId,
    nodeId: rotation.nodeId,
    branchGeneration: raw.branchGeneration,
    rotation,
    timestamp,
  };
}

/** Digest of an atomic recovery's semantic content, for duplicate detection. */
export function recoverySemanticFingerprint(event: RunRecoveryEvent | TerminalRecoveryEvent): string {
  const { recoveryId: _recoveryId, ...rest } = event;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

function parseDuplicateRunRecovery(raw: Record<string, unknown>, run: ScriptRun): RunRecoveryEvent {
  // Duplicate detection must fingerprint the same semantic event as the normal
  // parser. In particular, preserve branchGeneration and timestamp; replacing
  // either with current run state turns an idempotent retry into a conflict.
  return parseRunRecovery(raw, run, validTimestamp(raw.timestamp, "timestamp"));
}

function parseDuplicateTerminalRecovery(raw: Record<string, unknown>, run: ScriptRun): TerminalRecoveryEvent {
  // Preserve every semantic field, including blocked nodes, error, branch
  // generation, and timestamp, so an at-least-once append is truly idempotent.
  return parseTerminalRecovery(raw, run, validTimestamp(raw.timestamp, "timestamp"));
}

function parseFrozenArgsPresence(raw: Record<string, unknown>): boolean {
  if (raw.frozenArgsPresent === undefined) throw new Error("frozen args presence marker is required");
  if (typeof raw.frozenArgsPresent !== "boolean") throw new Error("frozen args presence marker must be boolean");
  const hasArgs = Object.hasOwn(raw, "args");
  if (raw.frozenArgsPresent && (!hasArgs || raw.args === undefined)) {
    throw new Error("frozen args presence marker requires workflow args");
  }
  if (!raw.frozenArgsPresent && hasArgs) {
    throw new Error("frozen args presence marker conflicts with workflow args");
  }
  return raw.frozenArgsPresent;
}

function parseEvent(raw: unknown, runs: Map<string, ScriptRun>): JournalEvent {
  if (!isRecord(raw)) throw new Error("journal event is not an object");
  if (typeof raw.kind !== "string" || !JOURNAL_KINDS.has(raw.kind)) throw new Error("journal event kind is unknown");
  if (raw.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    throw new Error(
      `journal schema version ${String(raw.schemaVersion)} is unsupported; expected ${JOURNAL_SCHEMA_VERSION}`,
    );
  }
  const runId = boundedString(raw.runId, "runId", JOURNAL_ID_LIMIT);
  const timestamp = validTimestamp(raw.timestamp, "timestamp");

  if (raw.kind === "run_created") {
    if (runs.has(runId)) throw new Error("duplicate workflow run_created event");
    const script = boundedString(raw.script, "script", JOURNAL_SCRIPT_LIMIT);
    const scriptHash = boundedString(raw.scriptHash, "scriptHash", 128);
    const meta = parseMeta(raw.meta);
    const frozenArgsPresent = parseFrozenArgsPresence(raw);
    const args = raw.args === undefined ? undefined : parsePersistedValue(raw.args, "workflow args");
    const toolset = Object.hasOwn(raw, "toolset") ? boundedString(raw.toolset, "toolset", 64) : undefined;
    const frozenMaxAgents = (() => {
      if (!Object.hasOwn(raw, "frozenMaxAgents")) return undefined;
      if (typeof raw.frozenMaxAgents !== "number" || !Number.isFinite(raw.frozenMaxAgents) || raw.frozenMaxAgents < 1) {
        throw new Error("frozenMaxAgents is invalid");
      }
      return normalizeMaxAgents(raw.frozenMaxAgents);
    })();
    const frozenConcurrency = (() => {
      if (!Object.hasOwn(raw, "frozenConcurrency")) return undefined;
      if (
        typeof raw.frozenConcurrency !== "number" ||
        !Number.isFinite(raw.frozenConcurrency) ||
        raw.frozenConcurrency < 1
      ) {
        throw new Error("frozenConcurrency is invalid");
      }
      return normalizeConcurrency(raw.frozenConcurrency);
    })();
    const frozenAgentRetries = (() => {
      if (!Object.hasOwn(raw, "frozenAgentRetries")) return undefined;
      if (
        typeof raw.frozenAgentRetries !== "number" ||
        !Number.isFinite(raw.frozenAgentRetries) ||
        raw.frozenAgentRetries < 0
      ) {
        throw new Error("frozenAgentRetries is invalid");
      }
      return normalizeAgentRetries(raw.frozenAgentRetries);
    })();
    const frozenTokenBudget = (() => {
      if (!Object.hasOwn(raw, "frozenTokenBudget")) return undefined;
      if (raw.frozenTokenBudget === null) return null;
      if (
        typeof raw.frozenTokenBudget !== "number" ||
        !Number.isFinite(raw.frozenTokenBudget) ||
        raw.frozenTokenBudget < 1
      ) {
        throw new Error("frozenTokenBudget is invalid");
      }
      return normalizeTokenBudget(raw.frozenTokenBudget);
    })();
    const frozenAgentTimeoutMs = (() => {
      if (!Object.hasOwn(raw, "frozenAgentTimeoutMs")) return undefined;
      if (raw.frozenAgentTimeoutMs === null) return null;
      if (
        typeof raw.frozenAgentTimeoutMs !== "number" ||
        !Number.isFinite(raw.frozenAgentTimeoutMs) ||
        raw.frozenAgentTimeoutMs < 1
      ) {
        throw new Error("frozenAgentTimeoutMs is invalid");
      }
      return normalizeAgentTimeout(raw.frozenAgentTimeoutMs);
    })();
    const frozenExcludeTools = (() => {
      if (!Object.hasOwn(raw, "frozenExcludeTools")) return undefined;
      if (!Array.isArray(raw.frozenExcludeTools) || !raw.frozenExcludeTools.every((v) => typeof v === "string")) {
        throw new Error("frozenExcludeTools is invalid");
      }
      return [...raw.frozenExcludeTools] as string[];
    })();
    return {
      kind: "run_created",
      schemaVersion: raw.schemaVersion as JournalSchemaVersion,
      runId,
      script,
      scriptHash,
      meta,
      ...(args === undefined ? {} : { args }),
      frozenArgsPresent,
      ...(toolset ? { toolset } : {}),
      ...(frozenMaxAgents !== undefined ? { frozenMaxAgents } : {}),
      ...(frozenConcurrency !== undefined ? { frozenConcurrency } : {}),
      ...(frozenAgentRetries !== undefined ? { frozenAgentRetries } : {}),
      ...(frozenTokenBudget !== undefined ? { frozenTokenBudget } : {}),
      ...(frozenAgentTimeoutMs !== undefined ? { frozenAgentTimeoutMs } : {}),
      ...(frozenExcludeTools ? { frozenExcludeTools } : {}),
      timestamp,
      ...(raw.attempts === undefined ? {} : { attempts: parseAttemptMap(raw.attempts, "attempts") }),
      ...(raw.attemptIds === undefined ? {} : { attemptIds: parseAttemptIdMap(raw.attemptIds, "attemptIds") }),
    };
  }

  const run = runs.get(runId);
  if (!run) throw new Error("journal event references an unknown run");
  if (raw.kind === "run_revision") {
    const revision = raw.revision;
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision <= (run.revision ?? 0))
      throw new Error("workflow revision is invalid or stale");
    const script = boundedString(raw.script, "revision.script", JOURNAL_SCRIPT_LIMIT);
    const scriptHash = boundedString(raw.scriptHash, "revision.scriptHash", 128);
    return {
      kind: "run_revision",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId,
      revision,
      script,
      scriptHash,
      meta: parseMeta(raw.meta),
      timestamp,
    };
  }
  if (raw.kind === "run_removed")
    return { kind: "run_removed", schemaVersion: JOURNAL_SCHEMA_VERSION, runId, timestamp };
  if (raw.kind === "run_recovery") return parseRunRecovery(raw, run, timestamp);
  if (raw.kind === "terminal_recovery") return parseTerminalRecovery(raw, run, timestamp);
  if (raw.kind === "attempt_recovery") return parseAttemptRecovery(raw, run, timestamp);
  if (raw.kind === "workflow_transition") {
    if (!WORKFLOW_STATUS_VALUES.has(raw.status as WorkflowStatus)) throw new Error("workflow status is unknown");
    if (!canTransitionWorkflow(run.status, raw.status as WorkflowStatus)) {
      throw new Error(`invalid workflow transition: ${run.status} -> ${String(raw.status)}`);
    }
    if (raw.terminalIntent !== undefined && raw.terminalIntent !== "stop" && raw.terminalIntent !== "failure") {
      throw new Error("workflow terminal intent is invalid");
    }
    let finalResult: unknown;
    if (raw.finalResult !== undefined) {
      try {
        finalResult = structuredClone(raw.finalResult);
      } catch {
        throw new Error("workflow finalResult is not structured-cloneable");
      }
    }
    return {
      kind: "workflow_transition",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId,
      status: raw.status as WorkflowStatus,
      timestamp,
      ...(finalResult === undefined ? {} : { finalResult }),
      ...(raw.error === undefined ? {} : { error: boundedString(raw.error, "error", JOURNAL_ERROR_LIMIT) }),
      ...(raw.terminalIntent === undefined ? {} : { terminalIntent: raw.terminalIntent }),
    };
  }

  // Terminal workflow outcomes are immutable. A late call fact from the
  // superseded execution is stale, not a reason to quarantine an otherwise
  // valid run.
  if (isTerminalWorkflowStatus(run.status) && raw.kind !== "workflow_transition") {
    throw new StaleJournalGenerationError("journal event follows a terminal workflow outcome");
  }

  const nodeId = parseCallIndex(raw.nodeId, "nodeId");
  if (raw.kind === "workflow_result") {
    if (raw.schemaVersion !== JOURNAL_SCHEMA_VERSION) throw new Error("workflow result schema version is unsupported");
    if (raw.owner !== undefined || raw.attemptId !== undefined)
      throw new Error("workflow result cannot carry a managed attempt");
    const result = mergeCallResultTierIdentity(
      priorCallTierIdentity(run, nodeId),
      parseResult(raw.result, "workflow result"),
    );
    if (result.status !== "completed") throw new Error("workflow result must be completed");
    if (result.attemptId !== undefined) throw new Error("workflow result payload cannot carry a managed attempt");
    const generation = raw.generation;
    if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1 || generation > 1_000_000) {
      throw new Error("workflow result generation is invalid");
    }
    const latestGeneration = run.workflowResultGenerations[nodeId] ?? 0;
    if (generation < latestGeneration) {
      throw new StaleJournalGenerationError("nested workflow result generation is stale");
    }
    if (
      generation === latestGeneration &&
      run.callResults[nodeId] &&
      JSON.stringify(run.callResults[nodeId]) !== JSON.stringify(result)
    ) {
      throw new Error("contradictory nested workflow result");
    }
    const agentCount =
      raw.agentCount === undefined
        ? undefined
        : typeof raw.agentCount === "number" &&
            Number.isInteger(raw.agentCount) &&
            raw.agentCount >= 0 &&
            raw.agentCount <= JOURNAL_CALL_LIMIT
          ? raw.agentCount
          : (() => {
              throw new Error("workflow result agentCount is invalid");
            })();
    const callHash = boundedString(raw.callHash, "workflow result callHash", 128);
    const storeDelta =
      raw.storeDelta === undefined
        ? undefined
        : (() => {
            if (!isRecord(raw.storeDelta)) throw new Error("workflow result storeDelta is invalid");
            return raw.storeDelta as Record<string, unknown>;
          })();
    return {
      kind: "workflow_result",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId,
      nodeId,
      result,
      generation,
      ...(agentCount === undefined ? {} : { agentCount }),
      callHash,
      ...(storeDelta === undefined ? {} : { storeDelta }),
      timestamp,
    };
  }
  const owner = raw.owner === undefined ? undefined : parseOwner(raw.owner, runId, nodeId);
  const rawAttemptId =
    raw.attemptId === undefined ? undefined : boundedString(raw.attemptId, "attemptId", JOURNAL_ID_LIMIT);
  const attemptId = rawAttemptId ?? run.attemptIds[nodeId];
  if (run.attemptTracking && (rawAttemptId === undefined || owner === undefined || owner.attemptId === undefined)) {
    throw new Error("journal attempt-aware event is missing a required raw or owner attemptId");
  }
  if (raw.kind !== "call_attempt" && owner?.attemptId && attemptId && owner.attemptId !== attemptId) {
    throw new StaleJournalGenerationError("journal owner references a different attempt");
  }
  if (raw.kind !== "call_attempt" && attemptId !== run.attemptIds[nodeId]) {
    throw new StaleJournalGenerationError("journal event references a superseded attempt");
  }

  if (raw.kind === "call_attempt") {
    const generation = raw.generation;
    if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1 || generation > 1_000_000) {
      throw new Error("call attempt generation is invalid");
    }
    if (generation <= (run.attempts[nodeId] ?? 0)) {
      throw new StaleJournalGenerationError("call attempt generation is stale");
    }
    const expectedAttemptId = `${runId}/${nodeId}/attempt-${generation}`;
    if (attemptId !== expectedAttemptId || owner?.attemptId !== attemptId) {
      throw new Error("call attempt does not identify its next generation");
    }
    const tierIdentity = parseCallTierIdentity(raw, "call attempt");
    return {
      kind: "call_attempt",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId,
      nodeId,
      attemptId,
      generation,
      ...tierIdentity,
      timestamp,
      ...(owner ? { owner } : {}),
    };
  }

  if (raw.kind === "call_transition") {
    if (!CALL_STATUS_VALUES.has(raw.status as CallStatus)) throw new Error("call status is unknown");
    const agentId = raw.agentId === undefined ? undefined : boundedString(raw.agentId, "agentId", JOURNAL_ID_LIMIT);
    const tierIdentity = parseCallTierIdentity(raw, "call transition");
    return {
      kind: "call_transition",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId,
      nodeId,
      status: raw.status as CallStatus,
      ...tierIdentity,
      timestamp,
      ...(agentId ? { agentId } : {}),
      ...(attemptId ? { attemptId } : {}),
      ...(owner ? { owner } : {}),
    };
  }

  const result = parseResult(raw.result, "call result");
  if (run.attemptTracking && result.attemptId === undefined) {
    throw new Error("call result is missing a required payload attemptId");
  }
  if (result.attemptId && attemptId && result.attemptId !== attemptId) {
    throw new StaleJournalGenerationError("call result payload references a superseded attempt");
  }
  const normalizedResult = result.attemptId === undefined && attemptId ? { ...result, attemptId } : result;
  const resultWithTierIdentity = mergeCallResultTierIdentity(priorCallTierIdentity(run, nodeId), normalizedResult);
  return {
    kind: "call_result",
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    runId,
    nodeId,
    result: resultWithTierIdentity,
    ...(raw.callHash === undefined ? {} : { callHash: boundedString(raw.callHash, "callHash", 128) }),
    ...(raw.storeDelta === undefined
      ? {}
      : {
          storeDelta: (() => {
            if (!isRecord(raw.storeDelta)) throw new Error("call result storeDelta is invalid");
            return raw.storeDelta as Record<string, unknown>;
          })(),
        }),
    attemptId,
    timestamp,
    ...(owner ? { owner } : {}),
  };
}

export function boundedText(value: unknown, limit = JOURNAL_TEXT_LIMIT): { text?: string; truncated?: boolean } {
  if (typeof value !== "string" || value.length === 0) return {};
  if (value.length <= limit) return { text: value };
  return { text: `${value.slice(0, limit)}\n…[truncated]`, truncated: true };
}

export function boundedError(value: unknown): string | undefined {
  const result = boundedText(value instanceof Error ? value.message : value, JOURNAL_ERROR_LIMIT);
  return result.text;
}

export function replayJournal(
  entries: readonly SessionEntryLike[],
  options: ReplayJournalOptions = {},
): Map<string, ScriptRun> {
  const runs = new Map<string, ScriptRun>();
  const quarantined = new Set<string>();
  const removed = new Set<string>();
  /** Parsed creation facts are retained separately from mutable run state for duplicate checks. */
  const creationFingerprints = new Map<string, string>();
  /** Recovery identities are scoped to one replayed run and bounded explicitly. */
  const seenRecoveries = new Map<string, Map<string, string>>();
  let reported = false;
  const report = (message: string): void => {
    if (reported) return;
    reported = true;
    options.onInvalid?.(`quarantined malformed workflow journal run: ${message}`.slice(0, 2_000));
  };
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== JOURNAL_ENTRY_TYPE) continue;
    const raw = entry.data;
    const rawRunId = isRecord(raw) && typeof raw.runId === "string" ? raw.runId : undefined;
    if (rawRunId && quarantined.has(rawRunId)) continue;
    if (rawRunId && removed.has(rawRunId)) continue;
    // Set inside the guarded region, delivered outside it. An observer that
    // throws is reporting that the accepted facts contradict each other, which
    // is exactly the condition the caller needs to see — running it inside the
    // `try` would quarantine the run and swallow the diagnostic, turning a real
    // conflict into a silently missing cache entry. `finally` also delivers on
    // the `continue` paths, which a trailing statement would skip.
    let accepted: JournalEvent | undefined;
    try {
      if (
        isRecord(raw) &&
        raw.schemaVersion === JOURNAL_SCHEMA_VERSION &&
        raw.kind === "run_created" &&
        rawRunId &&
        runs.has(rawRunId)
      ) {
        // Parse against an empty run map so every creation field participates in
        // the comparison, including frozen limits and attempt seeds. Comparing
        // against mutable run state would make a harmless retry conflict after
        // later call/recovery events have changed that state.
        const candidate = parseEvent(raw, new Map());
        const candidateFingerprint = JSON.stringify(candidate);
        if (creationFingerprints.get(rawRunId) === candidateFingerprint) continue;
        throw new Error("conflicting duplicate workflow run_created event");
      }
      if (
        isRecord(raw) &&
        (raw.kind === "run_recovery" || raw.kind === "terminal_recovery") &&
        typeof raw.recoveryId === "string"
      ) {
        for (const [seenRunId, seen] of seenRecoveries) {
          if (seenRunId === rawRunId || !seen.has(raw.recoveryId)) continue;
          throw new Error(`recoveryId ${raw.recoveryId} is already owned by workflow run ${seenRunId}`);
        }
      }
      if (
        isRecord(raw) &&
        raw.schemaVersion === JOURNAL_SCHEMA_VERSION &&
        (raw.kind === "run_recovery" || raw.kind === "terminal_recovery") &&
        rawRunId
      ) {
        const run = runs.get(rawRunId);
        const seen = seenRecoveries.get(rawRunId);
        if (run && seen) {
          const candidate =
            raw.kind === "run_recovery"
              ? parseDuplicateRunRecovery(raw, run)
              : parseDuplicateTerminalRecovery(raw, run);
          const previousFingerprint = seen.get(candidate.recoveryId);
          if (previousFingerprint !== undefined) {
            const candidateFingerprint = recoverySemanticFingerprint(candidate);
            if (candidateFingerprint !== previousFingerprint) {
              throw new Error(`conflicting duplicate recoveryId ${candidate.recoveryId}`);
            }
            continue;
          }
        }
      }

      const event = parseEvent(raw, runs);
      if (quarantined.has(event.runId)) continue;
      if (event.kind === "run_created") {
        applyJournalEvent(runs, event);
        creationFingerprints.set(event.runId, JSON.stringify(event));
        seenRecoveries.set(event.runId, new Map());
        accepted = event;
        continue;
      }
      if (event.kind === "run_recovery" || event.kind === "terminal_recovery") {
        const seen = seenRecoveries.get(event.runId) ?? new Map<string, string>();
        const previousFingerprint = seen.get(event.recoveryId);
        if (previousFingerprint !== undefined) {
          const eventFingerprint = recoverySemanticFingerprint(event);
          if (eventFingerprint !== previousFingerprint) {
            throw new Error(`conflicting duplicate recoveryId ${event.recoveryId}`);
          }
          continue;
        }
        if (seen.size >= JOURNAL_RECOVERY_SEEN_LIMIT) {
          throw new Error(`workflow recovery history exceeds ${JOURNAL_RECOVERY_SEEN_LIMIT} entries`);
        }
        applyJournalEvent(runs, event);
        seen.set(event.recoveryId, recoverySemanticFingerprint(event));
        seenRecoveries.set(event.runId, seen);
        accepted = event;
        continue;
      }
      applyJournalEvent(runs, event);
      accepted = event;
      if (event.kind === "run_removed") {
        removed.add(event.runId);
      }
    } catch (error: unknown) {
      if (error instanceof StaleJournalGenerationError) continue;
      if (rawRunId) {
        quarantined.add(rawRunId);
        runs.delete(rawRunId);
        creationFingerprints.delete(rawRunId);
        seenRecoveries.delete(rawRunId);
      }
      report(error instanceof Error ? error.message : String(error));
    } finally {
      if (accepted) options.onAccepted?.(accepted);
    }
  }
  for (const [runId, run] of runs) {
    try {
      validateAggregate(run);
    } catch (error: unknown) {
      runs.delete(runId);
      quarantined.add(runId);
      creationFingerprints.delete(runId);
      seenRecoveries.delete(runId);
      report(`${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return runs;
}

function applyRecoveryRotation(run: ScriptRun, rotation: RecoveryRotation): void {
  run.attemptTracking = true;
  run.attempts[rotation.nodeId] = rotation.generation;
  run.attemptIds[rotation.nodeId] = rotation.attemptId;
  delete run.agentIds[rotation.nodeId];
  delete run.callResults[rotation.nodeId];
  const rotationTier = rotation.tier ?? run.callTiers[rotation.nodeId]?.tier;
  if (rotationTier !== undefined) run.callTiers[rotation.nodeId] = { tier: rotationTier };
  run.compactions[rotation.nodeId] = 0;
  run.callStatus[rotation.nodeId] = "running";
}

function applyRecoveryTerminalResult(run: ScriptRun, terminal: RecoveryTerminalResult): void {
  run.compactions[terminal.nodeId] = Math.max(run.compactions[terminal.nodeId] ?? 0, terminal.result.compactionCount);
  const result = mergeCallResultTierIdentity(priorCallTierIdentity(run, terminal.nodeId), terminal.result);
  run.callResults[terminal.nodeId] = result;
  run.callTiers[terminal.nodeId] = result.tier === undefined ? {} : { tier: result.tier };
  run.callStatus[terminal.nodeId] = result.status;
  if (result.agentId) run.agentIds[terminal.nodeId] = result.agentId;
}

export function applyRecoveryTerminalResults(run: ScriptRun, terminalResults: readonly RecoveryTerminalResult[]): void {
  for (const terminal of terminalResults) applyRecoveryTerminalResult(run, terminal);
}

/** Apply an already validated atomic recovery event after its append succeeds. */
export function applyRecoveryEvent(run: ScriptRun, event: RunRecoveryEvent | AttemptRecoveryEvent): void {
  if (event.kind === "run_recovery") {
    run.status = "interrupted";
    run.terminalIntent = undefined;
    for (const rotation of event.rotations) applyRecoveryRotation(run, rotation);
    applyRecoveryTerminalResults(run, event.terminalResults ?? []);
  } else {
    applyRecoveryRotation(run, event.rotation);
  }
  run.updatedAt = event.timestamp;
}
/** Apply a validated terminal recovery after its durable append succeeds. */
export function applyTerminalRecoveryEvent(run: ScriptRun, event: TerminalRecoveryEvent): void {
  for (const terminal of event.terminalResults) applyRecoveryTerminalResult(run, terminal);
  for (const nodeId of event.blockedNodeIds) {
    if (run.callStatus[nodeId] !== "completed") run.callStatus[nodeId] = "stopped";
  }
  run.status = event.status;
  run.terminalIntent = event.terminalIntent;
  if (event.error !== undefined) run.error = event.error;
  if (event.status === "stopped") run.nonResumable = true;
  run.updatedAt = event.timestamp;
}

function applyJournalEvent(runs: Map<string, ScriptRun>, event: JournalEvent): void {
  if (event.kind === "run_created") {
    const callStatus: Record<string, CallStatus> = {};
    const attempts: Record<string, number> = {};
    const attemptIds: Record<string, string> = {};
    for (const nodeId of Object.keys(event.attemptIds ?? {})) {
      callStatus[nodeId] = "running";
      attempts[nodeId] = event.attempts?.[nodeId] ?? 1;
      attemptIds[nodeId] = event.attemptIds?.[nodeId] ?? defaultAttemptId(event.runId, nodeId);
    }
    runs.set(event.runId, {
      runId: event.runId,
      schemaVersion: event.schemaVersion,
      script: event.script,
      scriptHash: event.scriptHash,
      meta: event.meta,
      ...(event.args === undefined ? {} : { args: structuredClone(event.args) }),
      frozenArgsPresent: event.frozenArgsPresent,
      revision: 0,
      ...(event.toolset ? { toolset: event.toolset } : {}),
      ...(event.frozenMaxAgents !== undefined ? { frozenMaxAgents: event.frozenMaxAgents } : {}),
      ...(event.frozenConcurrency !== undefined ? { frozenConcurrency: event.frozenConcurrency } : {}),
      ...(event.frozenAgentRetries !== undefined ? { frozenAgentRetries: event.frozenAgentRetries } : {}),
      ...(event.frozenTokenBudget !== undefined ? { frozenTokenBudget: event.frozenTokenBudget } : {}),
      ...(event.frozenAgentTimeoutMs !== undefined ? { frozenAgentTimeoutMs: event.frozenAgentTimeoutMs } : {}),
      ...(event.frozenExcludeTools ? { frozenExcludeTools: event.frozenExcludeTools } : {}),
      status: "pending",
      callStatus,
      agentIds: {},
      attempts,
      attemptIds,
      attemptTracking: event.attemptIds !== undefined,
      callResults: {},
      callTiers: {},
      workflowResultGenerations: {},
      compactions: {},
      startedAt: event.timestamp,
      updatedAt: event.timestamp,
    });
    return;
  }

  const run = runs.get(event.runId);
  if (!run) return;
  if (event.kind === "run_removed") {
    runs.delete(event.runId);
    return;
  }
  run.updatedAt = event.timestamp;
  switch (event.kind) {
    case "run_revision":
      run.revision = event.revision;
      run.script = event.script;
      run.scriptHash = event.scriptHash;
      run.meta = event.meta;
      break;
    case "workflow_transition":
      run.status = event.status;
      if (event.error !== undefined) run.error = event.error;
      if (event.finalResult !== undefined) run.finalResult = structuredClone(event.finalResult);
      if (event.terminalIntent !== undefined) run.terminalIntent = event.terminalIntent;
      break;
    case "run_recovery":
    case "attempt_recovery":
      applyRecoveryEvent(run, event);
      break;
    case "terminal_recovery":
      applyTerminalRecoveryEvent(run, event);
      break;
    case "call_attempt":
      run.attemptTracking = true;
      run.attempts[event.nodeId] = event.generation;
      run.attemptIds[event.nodeId] = event.attemptId;
      delete run.agentIds[event.nodeId];
      delete run.callResults[event.nodeId];
      if (event.tier !== undefined) run.callTiers[event.nodeId] = { tier: event.tier };
      run.callStatus[event.nodeId] = "running";
      run.compactions[event.nodeId] = 0;
      break;
    case "call_transition":
      if (event.attemptId && event.attemptId !== run.attemptIds[event.nodeId]) {
        throw new Error("call transition references a superseded attempt");
      }
      if (event.tier !== undefined) run.callTiers[event.nodeId] = { tier: event.tier };
      // Identity-only transitions use status "running". A delayed retry must
      // not regress a terminal call result that was already replayed.
      if (
        event.status !== "running" ||
        run.callStatus[event.nodeId] === undefined ||
        run.callStatus[event.nodeId] === "running"
      ) {
        run.callStatus[event.nodeId] = event.status;
      }
      if (event.agentId) run.agentIds[event.nodeId] = event.agentId;
      break;
    case "workflow_result": {
      run.workflowResultGenerations[event.nodeId] = event.generation;
      const result = mergeCallResultTierIdentity(priorCallTierIdentity(run, event.nodeId), event.result);
      run.callResults[event.nodeId] = result;
      run.callTiers[event.nodeId] = result.tier === undefined ? {} : { tier: result.tier };
      run.callStatus[event.nodeId] = result.status;
      run.compactions[event.nodeId] = result.compactionCount;
      break;
    }
    case "call_result": {
      if (event.attemptId && event.attemptId !== run.attemptIds[event.nodeId]) {
        throw new Error("call result references a superseded attempt");
      }
      const result = mergeCallResultTierIdentity(priorCallTierIdentity(run, event.nodeId), event.result);
      if (run.callResults[event.nodeId] && JSON.stringify(run.callResults[event.nodeId]) !== JSON.stringify(result)) {
        throw new Error("contradictory terminal call result");
      }
      run.callResults[event.nodeId] = result;
      run.callTiers[event.nodeId] = result.tier === undefined ? {} : { tier: result.tier };
      run.callStatus[event.nodeId] = result.status;
      run.compactions[event.nodeId] = Math.max(run.compactions[event.nodeId] ?? 0, result.compactionCount);
      if (result.agentId) run.agentIds[event.nodeId] = result.agentId;
      break;
    }
  }
}

function validateAggregate(run: ScriptRun): void {
  if (run.frozenArgsPresent === true && run.args === undefined) {
    throw new Error("frozen args presence marker requires workflow args");
  }
  if (run.frozenArgsPresent === false && run.args !== undefined) {
    throw new Error("frozen args presence marker conflicts with workflow args");
  }
  for (const nodeId of Object.keys(run.attemptIds)) {
    if (!Number.isInteger(run.attempts[nodeId]) || run.attempts[nodeId] < 1) {
      throw new Error(`missing attempt generation for ${nodeId}`);
    }
    boundedString(run.attemptIds[nodeId], `attemptIds.${nodeId}`, JOURNAL_ID_LIMIT);
  }
  if (isTerminalWorkflowStatus(run.status)) {
    const statuses = Object.values(run.callStatus);
    if (
      run.status === "completed" &&
      statuses.some((status) => status !== "completed" && status !== "failed" && status !== "stopped")
    ) {
      throw new Error("completed workflow has active calls");
    }
    if (
      run.status === "stopped" &&
      statuses.some((status) => status !== "completed" && status !== "stopped" && status !== "failed")
    ) {
      throw new Error("stopped workflow has active calls");
    }
  }
}

function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

function canTransitionWorkflow(previous: WorkflowStatus, next: WorkflowStatus): boolean {
  if (previous === next) return true;
  switch (previous) {
    case "pending":
      return next === "running" || next === "stopping";
    case "running":
      return (
        next === "pausing" ||
        next === "paused" ||
        next === "stopping" ||
        next === "interrupted" ||
        next === "completed" ||
        next === "failed"
      );
    case "pausing":
      return next === "paused" || next === "stopping";
    case "paused":
      return next === "running" || next === "stopping";
    case "interrupted":
      return next === "running" || next === "stopping";
    case "stopping":
      return next === "stopped" || next === "failed" || next === "interrupted";
    default:
      return false;
  }
}

export function snapshotRun(run: ScriptRun): ScriptRun {
  return JSON.parse(JSON.stringify(run)) as ScriptRun;
}

/**
 * Build the runtime's resume journal from raw session entries.
 *
 * The runtime keys its cache by `${runId}:${callIndex}` (the same namespacing
 * the store deltas use), so a nested workflow() call with its own runId can
 * never replay the parent's entry. Every `call_result` or `workflow_result`
 * event that carries a `callHash` is a replayable fact. Entries from another
 * schema or without a hash are not replayable; they are ignored here even when
 * `replayJournal` retains them as non-replayable lifecycle history.
 */
export function buildResumeJournal(entries: readonly SessionEntryLike[]): Map<
  string,
  {
    index: number;
    runId?: string;
    hash: string;
    result: unknown;
    tier?: string;
    storeDelta?: Record<string, unknown>;
    generation?: number;
    agentCount?: number;
  }
> {
  type ResumeEntry = {
    index: number;
    runId?: string;
    hash: string;
    result: unknown;
    tier?: string;
    storeDelta?: Record<string, unknown>;
    generation?: number;
    agentCount?: number;
  };
  const journal = new Map<string, ResumeEntry>();
  const journalRunIds = new Map<string, string>();

  // Reuse the authoritative replay validator so stale call results from an
  // older attempt, terminal-after-lifecycle facts, and quarantined runs never
  // enter the cache merely because they appear later in the session branch.
  const replayedRuns = replayJournal(entries, {
    onAccepted: (event) => {
      if ((event.kind !== "call_result" && event.kind !== "workflow_result") || event.callHash === undefined) return;
      if (event.result.status !== "completed" || !Object.hasOwn(event.result, "result")) return;

      const candidate: ResumeEntry = {
        index: Number(event.nodeId),
        runId: event.runId,
        hash: event.callHash,
        result: event.result.result,
        ...(event.result.tier === undefined ? {} : { tier: event.result.tier }),
        ...(event.kind === "workflow_result" ? { generation: event.generation } : {}),
        ...(event.kind === "workflow_result" && event.agentCount !== undefined ? { agentCount: event.agentCount } : {}),
        ...(event.storeDelta !== undefined && Object.keys(event.storeDelta).length > 0
          ? { storeDelta: event.storeDelta }
          : {}),
      };
      const key = `${event.runId}:${event.nodeId}`;
      const existing = journal.get(key);
      if (candidate.generation !== undefined && existing?.generation !== undefined) {
        if (candidate.generation < existing.generation) return;
        // Same generation, same content is an at-least-once retry. Same
        // generation, different content is a contradiction `replayJournal` has
        // already rejected before accepting the second fact — reaching here
        // would mean the two validators disagree, so surface it rather than
        // quietly keeping whichever arrived first.
        if (candidate.generation === existing.generation) {
          if (JSON.stringify(existing) !== JSON.stringify(candidate))
            throw new Error("contradictory nested workflow result");
          return;
        }
      }
      journal.set(key, candidate);
      journalRunIds.set(key, event.runId);
    },
  });

  // replayJournal may quarantine a run after an accepted fact (for example,
  // when a later contradictory event invalidates the aggregate). Do not retain
  // cache entries belonging to that run.
  for (const [key, runId] of journalRunIds) {
    if (!replayedRuns.has(runId)) journal.delete(key);
  }
  return journal;
}

/** Derive a stable recovery id from a recovery event's content. */
export function deriveRecoveryId(event: { runId: string; rotations: unknown[]; timestamp: number }): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ runId: event.runId, rotations: event.rotations, timestamp: event.timestamp }))
    .digest("hex");
  return `${JOURNAL_RECOVERY_ID_PREFIX}${digest}`;
}
