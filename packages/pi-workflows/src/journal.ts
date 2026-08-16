import { createHash } from "node:crypto";
import type { ManagedOwner } from "@signalridge/pi-subagents-protocol";
import { validateWorkflow, type WorkflowDefinition } from "./schema.js";
import {
  canTransitionTask,
  canTransitionWorkflow,
  isTerminalTask,
  type TaskStatus,
  type WorkflowStatus,
} from "./state-machine.js";

export const JOURNAL_ENTRY_TYPE = "pi-workflows:journal";
export const JOURNAL_SCHEMA_VERSION = 2;
export const JOURNAL_LEGACY_SCHEMA_VERSION = 1;
export type JournalSchemaVersion = 1 | 2;
export const JOURNAL_TEXT_LIMIT = 8_000;
export const JOURNAL_ERROR_LIMIT = 2_000;
export const JOURNAL_ID_LIMIT = 256;
export const JOURNAL_TIMESTAMP_LIMIT = 8_640_000_000_000_000;
export const JOURNAL_RECOVERY_ID_PREFIX = "r1-";
export const JOURNAL_RECOVERY_ID_LIMIT = JOURNAL_RECOVERY_ID_PREFIX.length + 64;
/** Maximum number of distinct atomic recoveries retained while replaying one run. */
export const JOURNAL_RECOVERY_SEEN_LIMIT = 4_096;
const RECOVERY_ID_PATTERN = /^r1-[0-9a-f]{64}$/;

export class StaleJournalGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleJournalGenerationError";
  }
}

const WORKFLOW_STATUS_VALUES = new Set<WorkflowStatus>([
  "pending",
  "running",
  "pausing",
  "paused",
  "synthesizing",
  "stopping",
  "completed",
  "failed",
  "stopped",
  "interrupted",
]);
const TASK_STATUS_VALUES = new Set<TaskStatus>([
  "pending",
  "ready",
  "dispatching",
  "queued",
  "running",
  "completed",
  "failed",
  "stopped",
  "blocked",
]);
const JOURNAL_KINDS = new Set([
  "run_created",
  "workflow_transition",
  "run_recovery",
  "terminal_recovery",
  "attempt_recovery",
  "task_transition",
  "task_attempt",
  "task_result",
  "task_compacted",
  "synthesis_result",
]);

/** One atomic recovery event may rotate every active node in a run. */
export const JOURNAL_RECOVERY_NODE_LIMIT = 129; // 128 tasks plus synthesis
const JOURNAL_GENERATION_LIMIT = 1_000_000;
export type WorkflowOwner = ManagedOwner;

export interface WorkflowTaskResult {
  status: "completed" | "failed" | "stopped";
  agentId?: string;
  attemptId?: string;
  text?: string;
  error?: string;
  /** Persisted output transcript pointer, when pi-subagents provided one. */
  outputFile?: string;
  /** Total input + output token count, when lifecycle accounting provided it. */
  tokenCount?: number;
  compactionCount: number;
  truncated?: boolean;
  updatedAt: number;
}

export interface WorkflowRun {
  runId: string;
  schemaVersion: number;
  definition: WorkflowDefinition;
  status: WorkflowStatus;
  taskStatus: Record<string, TaskStatus>;
  agentIds: Record<string, string>;
  /** Monotonic per-node attempt generation; completed facts are never reset. */
  attempts: Record<string, number>;
  attemptIds: Record<string, string>;
  /** True when the journal carries generation-specific owner IDs. */
  attemptTracking?: boolean;
  taskResults: Record<string, WorkflowTaskResult>;
  compactions: Record<string, number>;
  startedAt: number;
  updatedAt: number;
  synthesisAgentId?: string;
  synthesisResult?: WorkflowTaskResult;
  error?: string;
  nonResumable?: boolean;
  /** Terminal cleanup intent while active agents settle. */
  terminalIntent?: "stop" | "failure";
}

interface JournalBase {
  schemaVersion: JournalSchemaVersion;
  runId: string;
  timestamp: number;
}

/** State that was observed immediately before an atomic recovery rotation. */
export type RecoverySourceStatus = TaskStatus | "synthesizing";

/**
 * A generation rotation is self-contained: replay can clear the superseded
 * attempt and make the new attempt ready without relying on a following
 * task_transition entry.
 */
export interface RecoveryRotation {
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
  result: WorkflowTaskResult;
  owner: WorkflowOwner;
}

export interface RunRecoveryEvent extends JournalBase {
  kind: "run_recovery";
  status: "interrupted";
  branchGeneration: number;
  rotations: RecoveryRotation[];
  terminalResults?: RecoveryTerminalResult[];
  recoveryId: string;
  /** Set only when reading a schema-v2 atomic event written before recoveryId existed. */
  legacyMigration?: true;
  timestamp: number;
}
/**
 * A terminal-intent recovery is one durable state transition. It settles every
 * unresolved node before publishing the final workflow outcome, so replay never
 * has to infer a terminal state from a prefix of result/transition events.
 */
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
  /** Only used to migrate a legacy prefix ending after workflow_transition. */
  legacyMigration?: true;
}

export type JournalEvent =
  | (JournalBase & {
      kind: "run_created";
      definition: WorkflowDefinition;
      attempts?: Record<string, number>;
      attemptIds?: Record<string, string>;
    })
  | (JournalBase & {
      kind: "workflow_transition";
      status: WorkflowStatus;
      error?: string;
      terminalIntent?: "stop" | "failure";
    })
  | RunRecoveryEvent
  | TerminalRecoveryEvent
  | AttemptRecoveryEvent
  | (JournalBase & {
      kind: "task_transition";
      nodeId: string;
      status: TaskStatus;
      agentId?: string;
      attemptId?: string;
      owner?: WorkflowOwner;
    })
  | (JournalBase & {
      kind: "task_attempt";
      nodeId: string;
      attemptId: string;
      generation: number;
      owner?: WorkflowOwner;
    })
  | (JournalBase & {
      kind: "task_result";
      nodeId: string;
      result: WorkflowTaskResult;
      attemptId?: string;
      owner?: WorkflowOwner;
    })
  | (JournalBase & {
      kind: "task_compacted";
      nodeId: string;
      compactionCount: number;
      attemptId?: string;
      owner?: WorkflowOwner;
    })
  | (JournalBase & {
      kind: "synthesis_result";
      result: WorkflowTaskResult;
      attemptId?: string;
      owner?: WorkflowOwner;
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
  /** Called at most once for malformed/forged/future journal data. */
  onInvalid?: (diagnostic: string) => void;
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
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) throw new Error(`${label} contains unsupported field "${key}"`);
  }
}

export type RecoveryIdInput =
  | (Pick<RunRecoveryEvent, "runId" | "status" | "branchGeneration" | "rotations" | "terminalResults"> & {
      kind?: "run_recovery";
    })
  | Pick<
      TerminalRecoveryEvent,
      | "kind"
      | "runId"
      | "status"
      | "terminalIntent"
      | "branchGeneration"
      | "terminalResults"
      | "blockedNodeIds"
      | "error"
    >;

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("recovery semantic payload contains an unsupported value");
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedRecoveryRotations(rotations: readonly RecoveryRotation[]): RecoveryRotation[] {
  return [...rotations].sort((left, right) => {
    const nodeOrder = compareStrings(left.nodeId, right.nodeId);
    if (nodeOrder !== 0) return nodeOrder;
    const attemptOrder = compareStrings(left.sourceAttemptId, right.sourceAttemptId);
    if (attemptOrder !== 0) return attemptOrder;
    return left.sourceGeneration - right.sourceGeneration;
  });
}

function sortedRecoveryTerminals(terminals: readonly RecoveryTerminalResult[]): RecoveryTerminalResult[] {
  return [...terminals].sort((left, right) => {
    const nodeOrder = compareStrings(left.nodeId, right.nodeId);
    if (nodeOrder !== 0) return nodeOrder;
    return compareStrings(left.attemptId, right.attemptId);
  });
}

function recoverySemanticPayload(event: RecoveryIdInput): Record<string, unknown> {
  if ("kind" in event && event.kind === "terminal_recovery") {
    return {
      blockedNodeIds: [...event.blockedNodeIds].sort(compareStrings),
      branchGeneration: event.branchGeneration,
      ...(event.error === undefined ? {} : { error: event.error }),
      kind: event.kind,
      runId: event.runId,
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      status: event.status,
      terminalIntent: event.terminalIntent,
      terminalResults: sortedRecoveryTerminals(event.terminalResults),
    };
  }
  return {
    branchGeneration: event.branchGeneration,
    kind: "run_recovery",
    rotations: sortedRecoveryRotations(event.rotations),
    runId: event.runId,
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    status: event.status,
    terminalResults: sortedRecoveryTerminals(event.terminalResults ?? []),
  };
}

/** Bounded digest of all normalized semantic fields, excluding timestamp and migration metadata. */
export function recoverySemanticFingerprint(event: RecoveryIdInput): string {
  return `s1-${digestCanonical(recoverySemanticPayload(event))}`;
}

/**
 * Derive the durable recovery identity from bounded source/target metadata.
 * Terminal recovery includes the complete terminal fact set because it is the
 * state transition, not merely a generation rotation.
 */
export function deriveRecoveryId(event: RecoveryIdInput): string {
  if ("kind" in event && event.kind === "terminal_recovery") {
    return `${JOURNAL_RECOVERY_ID_PREFIX}${digestCanonical({
      blockedNodeIds: [...event.blockedNodeIds].sort(compareStrings),
      branchNamespace: event.branchGeneration,
      ...(event.error === undefined ? {} : { error: event.error }),
      runId: event.runId,
      status: event.status,
      terminalIntent: event.terminalIntent,
      terminalResults: sortedRecoveryTerminals(event.terminalResults),
      version: 1,
    })}`;
  }
  const rotations = sortedRecoveryRotations(event.rotations);
  const terminals = sortedRecoveryTerminals(event.terminalResults ?? []);
  const identity = {
    branchNamespace: event.branchGeneration,
    runId: event.runId,
    sources: rotations.map((rotation) => ({
      nodeId: rotation.nodeId,
      sourceAttemptId: rotation.sourceAttemptId,
      sourceGeneration: rotation.sourceGeneration,
      sourceStatus: rotation.sourceStatus,
      ...(rotation.supersededAgentId === undefined ? {} : { supersededAgentId: rotation.supersededAgentId }),
    })),
    status: event.status,
    targets: rotations.map((rotation) => ({
      nodeId: rotation.nodeId,
      attemptId: rotation.attemptId,
      generation: rotation.generation,
      owner: rotation.owner,
      ...(rotation.supersededAgentId === undefined ? {} : { supersededAgentId: rotation.supersededAgentId }),
    })),
    terminalNodes: terminals.map((terminal) => ({
      nodeId: terminal.nodeId,
      attemptId: terminal.attemptId,
      status: terminal.result.status,
      ...(terminal.result.agentId === undefined ? {} : { agentId: terminal.result.agentId }),
      ...(terminal.result.outputFile === undefined ? {} : { outputFile: terminal.result.outputFile }),
      ...(terminal.result.tokenCount === undefined ? {} : { tokenCount: terminal.result.tokenCount }),
      compactionCount: terminal.result.compactionCount,
      ...(terminal.result.truncated === undefined ? {} : { truncated: terminal.result.truncated }),
    })),
    version: 1,
  };
  return `${JOURNAL_RECOVERY_ID_PREFIX}${digestCanonical(identity)}`;
}

function parseRecoveryId(value: unknown, label: string): string {
  const recoveryId = boundedString(value, label, JOURNAL_RECOVERY_ID_LIMIT);
  if (!RECOVERY_ID_PATTERN.test(recoveryId)) throw new Error(`${label} has an invalid format`);
  return recoveryId;
}
function parseOwner(value: unknown, runId: string, nodeId: string): WorkflowOwner {
  if (!isRecord(value)) throw new Error("owner must be an object");
  assertKeys(value, ["extension", "runId", "nodeId", "attemptId"], "owner");
  const extension = boundedString(value.extension, "owner.extension", 64);
  const ownerRunId = boundedString(value.runId, "owner.runId", JOURNAL_ID_LIMIT);
  const ownerNodeId = boundedString(value.nodeId, "owner.nodeId", JOURNAL_ID_LIMIT);
  const attemptId =
    value.attemptId === undefined ? undefined : boundedString(value.attemptId, "owner.attemptId", JOURNAL_ID_LIMIT);
  if (extension !== "pi-workflows" || ownerRunId !== runId || ownerNodeId !== nodeId) {
    throw new Error("journal owner does not match its workflow node");
  }
  return {
    extension: "pi-workflows",
    runId: ownerRunId,
    nodeId: ownerNodeId,
    ...(attemptId ? { attemptId } : {}),
  };
}

function parseResult(value: unknown, label: string): WorkflowTaskResult {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKeys(
    value,
    [
      "status",
      "agentId",
      "attemptId",
      "text",
      "error",
      "outputFile",
      "tokenCount",
      "compactionCount",
      "truncated",
      "updatedAt",
    ],
    label,
  );
  const status = value.status;
  if (status !== "completed" && status !== "failed" && status !== "stopped") {
    throw new Error(`${label}.status is invalid`);
  }
  const compactionCount = value.compactionCount;
  if (typeof compactionCount !== "number" || !Number.isInteger(compactionCount) || compactionCount < 0) {
    throw new Error(`${label}.compactionCount is invalid`);
  }
  const tokenCount = value.tokenCount;
  if (tokenCount !== undefined && (typeof tokenCount !== "number" || !Number.isInteger(tokenCount) || tokenCount < 0)) {
    throw new Error(`${label}.tokenCount is invalid`);
  }
  if (value.truncated !== undefined && typeof value.truncated !== "boolean") {
    throw new Error(`${label}.truncated is invalid`);
  }
  return {
    status,
    ...(value.agentId === undefined
      ? {}
      : { agentId: boundedString(value.agentId, `${label}.agentId`, JOURNAL_ID_LIMIT) }),
    ...(value.attemptId === undefined
      ? {}
      : { attemptId: boundedString(value.attemptId, `${label}.attemptId`, JOURNAL_ID_LIMIT) }),
    ...(value.text === undefined ? {} : { text: boundedString(value.text, `${label}.text`, JOURNAL_TEXT_LIMIT + 32) }),
    ...(value.error === undefined
      ? {}
      : { error: boundedString(value.error, `${label}.error`, JOURNAL_ERROR_LIMIT + 32) }),
    ...(value.outputFile === undefined
      ? {}
      : { outputFile: boundedString(value.outputFile, `${label}.outputFile`, JOURNAL_ID_LIMIT) }),
    ...(tokenCount === undefined ? {} : { tokenCount }),
    compactionCount,
    ...(value.truncated === undefined ? {} : { truncated: value.truncated }),
    updatedAt: validTimestamp(value.updatedAt, `${label}.updatedAt`),
  };
}

function taskNodeIds(run: WorkflowRun): Set<string> {
  return new Set([...run.definition.tasks.map((task) => task.id), "__synthesis__"]);
}

function parseAttemptMap(value: unknown, definition: WorkflowDefinition, label: string): Record<string, number> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set([...definition.tasks.map((task) => task.id), "__synthesis__"]);
  const result: Record<string, number> = {};
  for (const [nodeId, generation] of Object.entries(value)) {
    if (!allowed.has(nodeId)) throw new Error(`${label} contains an unknown node`);
    if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1 || generation > 1_000_000) {
      throw new Error(`${label}.${nodeId} is invalid`);
    }
    result[nodeId] = generation;
  }
  return result;
}

function parseAttemptIdMap(value: unknown, definition: WorkflowDefinition, label: string): Record<string, string> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set([...definition.tasks.map((task) => task.id), "__synthesis__"]);
  const result: Record<string, string> = {};
  for (const [nodeId, attemptId] of Object.entries(value)) {
    if (!allowed.has(nodeId)) throw new Error(`${label} contains an unknown node`);
    result[nodeId] = boundedString(attemptId, `${label}.${nodeId}`, JOURNAL_ID_LIMIT);
  }
  return result;
}

function parseBranchGeneration(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function recoverableTaskStatus(status: TaskStatus): boolean {
  return (
    status === "pending" ||
    status === "ready" ||
    status === "dispatching" ||
    status === "queued" ||
    status === "running"
  );
}

function activeTaskStatus(status: TaskStatus): boolean {
  return status === "dispatching" || status === "queued" || status === "running";
}

function parseRecoveryRotationShape(
  value: unknown,
  runId: string,
  nodes: ReadonlySet<string>,
  label: string,
): RecoveryRotation {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKeys(
    value,
    [
      "nodeId",
      "sourceAttemptId",
      "sourceGeneration",
      "sourceStatus",
      "attemptId",
      "generation",
      "owner",
      "supersededAgentId",
    ],
    label,
  );
  const nodeId = boundedString(value.nodeId, `${label}.nodeId`, JOURNAL_ID_LIMIT);
  if (!nodes.has(nodeId)) throw new Error(`${label}.nodeId references an unknown node`);
  const sourceAttemptId = boundedString(value.sourceAttemptId, `${label}.sourceAttemptId`, JOURNAL_ID_LIMIT);
  const sourceGeneration = value.sourceGeneration;
  if (
    typeof sourceGeneration !== "number" ||
    !Number.isInteger(sourceGeneration) ||
    sourceGeneration < 1 ||
    sourceGeneration > JOURNAL_GENERATION_LIMIT
  ) {
    throw new Error(`${label}.sourceGeneration is invalid`);
  }
  const sourceStatus = value.sourceStatus;
  if (nodeId === "__synthesis__") {
    if (sourceStatus !== "synthesizing") throw new Error(`${label}.sourceStatus is invalid for synthesis`);
  } else if (typeof sourceStatus !== "string" || !TASK_STATUS_VALUES.has(sourceStatus as TaskStatus)) {
    throw new Error(`${label}.sourceStatus is invalid`);
  }
  const generation = value.generation;
  if (
    typeof generation !== "number" ||
    !Number.isInteger(generation) ||
    generation !== sourceGeneration + 1 ||
    generation > JOURNAL_GENERATION_LIMIT
  ) {
    throw new Error(`${label}.generation is invalid or not the next generation`);
  }
  const attemptId = boundedString(value.attemptId, `${label}.attemptId`, JOURNAL_ID_LIMIT);
  const expectedAttemptId = `${runId}/${nodeId}/attempt-${generation}`;
  if (attemptId !== expectedAttemptId) throw new Error(`${label}.attemptId does not match its generation`);
  const owner = parseOwner(value.owner, runId, nodeId);
  if (owner.attemptId !== attemptId) throw new Error(`${label}.owner must identify the new attempt`);
  const supersededAgentId =
    value.supersededAgentId === undefined
      ? undefined
      : boundedString(value.supersededAgentId, `${label}.supersededAgentId`, JOURNAL_ID_LIMIT);
  return {
    nodeId,
    sourceAttemptId,
    sourceGeneration,
    sourceStatus: sourceStatus as RecoverySourceStatus,
    attemptId,
    generation,
    owner,
    ...(supersededAgentId === undefined ? {} : { supersededAgentId }),
  };
}

function parseRecoveryRotation(
  value: unknown,
  run: WorkflowRun,
  label: string,
  allowInterruptedSynthesis = false,
): RecoveryRotation {
  const rotation = parseRecoveryRotationShape(value, run.runId, taskNodeIds(run), label);
  const { nodeId, sourceAttemptId, sourceGeneration, sourceStatus } = rotation;
  if (run.attemptIds[nodeId] !== sourceAttemptId) {
    throw new Error(`${label}.sourceAttemptId does not match the current attempt`);
  }
  if (run.attempts[nodeId] !== sourceGeneration) {
    throw new Error(`${label}.sourceGeneration does not match the current generation`);
  }
  if (nodeId === "__synthesis__") {
    const synthesisSourceAllowed =
      run.status === "synthesizing" || (allowInterruptedSynthesis && run.status === "interrupted");
    if (sourceStatus !== "synthesizing" || !synthesisSourceAllowed) {
      throw new Error(`${label}.sourceStatus is invalid for synthesis`);
    }
  } else {
    const taskStatus = run.taskStatus[nodeId];
    if (taskStatus !== sourceStatus || !recoverableTaskStatus(taskStatus)) {
      throw new Error(`${label}.sourceStatus does not match the current task`);
    }
  }
  return rotation;
}

function parseRecoveryRotationsShape(
  raw: unknown,
  runId: string,
  nodes: ReadonlySet<string>,
  terminalNodes: ReadonlySet<string> = new Set(),
): RecoveryRotation[] {
  if (!Array.isArray(raw)) throw new Error("journal recovery rotations must be an array");
  if (raw.length > JOURNAL_RECOVERY_NODE_LIMIT) throw new Error("journal recovery has too many rotations");
  const seen = new Set<string>();
  return raw.map((value, index) => {
    const rotation = parseRecoveryRotationShape(value, runId, nodes, `rotations[${index}]`);
    if (seen.has(rotation.nodeId)) throw new Error("journal recovery contains duplicate node rotations");
    if (terminalNodes.has(rotation.nodeId)) throw new Error("journal recovery both settles and rotates a node");
    seen.add(rotation.nodeId);
    return rotation;
  });
}

function parseRecoveryRotations(
  raw: unknown,
  run: WorkflowRun,
  terminalNodes: ReadonlySet<string> = new Set(),
): RecoveryRotation[] {
  if (!Array.isArray(raw)) throw new Error("journal recovery rotations must be an array");
  if (raw.length > JOURNAL_RECOVERY_NODE_LIMIT) throw new Error("journal recovery has too many rotations");
  const seen = new Set<string>();
  const rotations = raw.map((value, index) => {
    const rotation = parseRecoveryRotation(value, run, `rotations[${index}]`);
    if (seen.has(rotation.nodeId)) throw new Error("journal recovery contains duplicate node rotations");
    if (terminalNodes.has(rotation.nodeId)) throw new Error("journal recovery both settles and rotates a node");
    seen.add(rotation.nodeId);
    return rotation;
  });
  for (const task of run.definition.tasks) {
    if (!activeTaskStatus(run.taskStatus[task.id]) || terminalNodes.has(task.id)) continue;
    if (!seen.has(task.id)) throw new Error(`journal recovery omits active task ${task.id}`);
  }
  if (
    run.status === "synthesizing" &&
    !run.synthesisResult &&
    !terminalNodes.has("__synthesis__") &&
    !seen.has("__synthesis__")
  ) {
    throw new Error("journal recovery omits active synthesis");
  }
  return rotations;
}

function parseRecoveryTerminalResultShape(
  value: unknown,
  runId: string,
  nodes: ReadonlySet<string>,
  label: string,
): RecoveryTerminalResult {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKeys(value, ["nodeId", "attemptId", "result", "owner"], label);
  const nodeId = boundedString(value.nodeId, `${label}.nodeId`, JOURNAL_ID_LIMIT);
  if (!nodes.has(nodeId)) throw new Error("journal recovery terminal result references an unknown node");
  const attemptId = boundedString(value.attemptId, `${label}.attemptId`, JOURNAL_ID_LIMIT);
  const owner = parseOwner(value.owner, runId, nodeId);
  if (owner.attemptId !== attemptId) throw new Error("journal recovery terminal result owner is invalid");
  const parsed = parseResult(value.result, `${label}.result`);
  if (parsed.attemptId !== undefined && parsed.attemptId !== attemptId) {
    throw new Error("journal recovery terminal result payload references a superseded attempt");
  }
  return {
    nodeId,
    attemptId,
    result: parsed.attemptId === undefined ? { ...parsed, attemptId } : parsed,
    owner,
  };
}

function parseRecoveryTerminalResultShapes(
  raw: unknown,
  runId: string,
  nodes: ReadonlySet<string>,
): RecoveryTerminalResult[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("journal recovery terminal results must be an array");
  if (raw.length > JOURNAL_RECOVERY_NODE_LIMIT) throw new Error("journal recovery has too many terminal results");
  const seen = new Set<string>();
  return raw.map((value, index) => {
    const terminal = parseRecoveryTerminalResultShape(value, runId, nodes, `terminalResults[${index}]`);
    if (seen.has(terminal.nodeId)) throw new Error("journal recovery contains duplicate terminal results");
    seen.add(terminal.nodeId);
    return terminal;
  });
}

function parseRecoveryTerminalResults(raw: unknown, run: WorkflowRun): RecoveryTerminalResult[] {
  const terminals = parseRecoveryTerminalResultShapes(raw, run.runId, taskNodeIds(run));
  for (const terminal of terminals) {
    const currentStatus = terminal.nodeId === "__synthesis__" ? undefined : run.taskStatus[terminal.nodeId];
    if (terminal.nodeId === "__synthesis__" && run.synthesisResult) {
      throw new Error("journal recovery terminal result references settled synthesis");
    }
    if (currentStatus !== undefined && isTerminalTask(currentStatus)) {
      throw new Error("journal recovery terminal result references a settled task");
    }
    if (terminal.attemptId !== run.attemptIds[terminal.nodeId]) {
      throw new Error("journal recovery terminal result references a superseded attempt");
    }
  }
  return terminals;
}

function parseRunRecovery(raw: Record<string, unknown>, run: WorkflowRun, timestamp: number): RunRecoveryEvent {
  if (raw.schemaVersion !== JOURNAL_SCHEMA_VERSION) throw new Error("run recovery schema version is unsupported");
  assertKeys(
    raw,
    [
      "kind",
      "schemaVersion",
      "runId",
      "status",
      "branchGeneration",
      "rotations",
      "terminalResults",
      "recoveryId",
      "legacyMigration",
      "timestamp",
    ],
    "run recovery",
  );
  if (raw.legacyMigration !== undefined && raw.legacyMigration !== true) {
    throw new Error("run recovery legacy migration marker is invalid");
  }
  if (run.status === "interrupted" || !["running", "pausing", "synthesizing", "stopping"].includes(run.status)) {
    throw new Error(`invalid workflow recovery source state: ${run.status}`);
  }
  if (run.terminalIntent !== undefined) throw new Error("workflow with terminal intent cannot be recovered");
  if (raw.status !== "interrupted") throw new Error("run recovery status must be interrupted");
  const branchGeneration = parseBranchGeneration(raw.branchGeneration, "branchGeneration");
  const terminalResults = parseRecoveryTerminalResults(raw.terminalResults, run);
  if (Array.isArray(raw.rotations) && raw.rotations.length + terminalResults.length > JOURNAL_RECOVERY_NODE_LIMIT) {
    throw new Error("journal recovery affects too many nodes");
  }
  const base = {
    kind: "run_recovery" as const,
    schemaVersion: JOURNAL_SCHEMA_VERSION as 2,
    runId: run.runId,
    status: "interrupted" as const,
    branchGeneration,
    rotations: parseRecoveryRotations(raw.rotations, run, new Set(terminalResults.map((item) => item.nodeId))),
    ...(terminalResults.length > 0 ? { terminalResults } : {}),
  };
  const expectedRecoveryId = deriveRecoveryId(base);
  const legacyMigration = raw.recoveryId === undefined;
  const recoveryId = legacyMigration ? expectedRecoveryId : parseRecoveryId(raw.recoveryId, "recoveryId");
  if (recoveryId !== expectedRecoveryId) {
    throw new Error("run recovery recoveryId does not match its semantic source and target fields");
  }
  return {
    ...base,
    recoveryId,
    ...(legacyMigration ? { legacyMigration: true } : {}),
    timestamp,
  };
}

function parseDuplicateRunRecovery(raw: Record<string, unknown>, run: WorkflowRun): RunRecoveryEvent {
  if (raw.schemaVersion !== JOURNAL_SCHEMA_VERSION) throw new Error("run recovery schema version is unsupported");
  assertKeys(
    raw,
    [
      "kind",
      "schemaVersion",
      "runId",
      "status",
      "branchGeneration",
      "rotations",
      "terminalResults",
      "recoveryId",
      "legacyMigration",
      "timestamp",
    ],
    "run recovery duplicate",
  );
  if (raw.legacyMigration !== undefined && raw.legacyMigration !== true) {
    throw new Error("run recovery legacy migration marker is invalid");
  }
  const runId = boundedString(raw.runId, "runId", JOURNAL_ID_LIMIT);
  if (runId !== run.runId) throw new Error("run recovery duplicate references a different run");
  if (raw.status !== "interrupted") throw new Error("run recovery status must be interrupted");
  const branchGeneration = parseBranchGeneration(raw.branchGeneration, "branchGeneration");
  const nodes = taskNodeIds(run);
  const terminalResults = parseRecoveryTerminalResultShapes(raw.terminalResults, runId, nodes);
  if (Array.isArray(raw.rotations) && raw.rotations.length + terminalResults.length > JOURNAL_RECOVERY_NODE_LIMIT) {
    throw new Error("journal recovery affects too many nodes");
  }
  const base: RecoveryIdInput = {
    kind: "run_recovery" as const,
    runId,
    status: "interrupted",
    branchGeneration,
    rotations: parseRecoveryRotationsShape(
      raw.rotations,
      runId,
      nodes,
      new Set(terminalResults.map((item) => item.nodeId)),
    ),
    ...(terminalResults.length > 0 ? { terminalResults } : {}),
  };
  const expectedRecoveryId = deriveRecoveryId(base);
  const legacyMigration = raw.recoveryId === undefined;
  const recoveryId = legacyMigration ? expectedRecoveryId : parseRecoveryId(raw.recoveryId, "recoveryId");
  if (recoveryId !== expectedRecoveryId) {
    throw new Error("run recovery recoveryId does not match its semantic source and target fields");
  }
  return {
    ...base,
    kind: "run_recovery",
    schemaVersion: JOURNAL_SCHEMA_VERSION as 2,
    recoveryId,
    ...(legacyMigration ? { legacyMigration: true } : {}),
    timestamp: validTimestamp(raw.timestamp, "timestamp"),
  };
}

function parseBlockedNodeIds(raw: unknown, nodes: ReadonlySet<string>): string[] {
  if (!Array.isArray(raw)) throw new Error("terminal recovery blockedNodeIds must be an array");
  if (raw.length > JOURNAL_RECOVERY_NODE_LIMIT) throw new Error("terminal recovery has too many blocked nodes");
  const seen = new Set<string>();
  return raw.map((value, index) => {
    const nodeId = boundedString(value, `blockedNodeIds[${index}]`, JOURNAL_ID_LIMIT);
    if (nodeId === "__synthesis__" || !nodes.has(nodeId)) {
      throw new Error("terminal recovery blockedNodeIds references an unknown task node");
    }
    if (seen.has(nodeId)) throw new Error("terminal recovery contains duplicate blocked nodes");
    seen.add(nodeId);
    return nodeId;
  });
}

type TerminalRecoveryBase = Omit<TerminalRecoveryEvent, "recoveryId" | "timestamp"> & { recoveryId: string };

function parseTerminalRecoveryBase(
  raw: Record<string, unknown>,
  runId: string,
  nodes: ReadonlySet<string>,
  label: string,
): TerminalRecoveryBase {
  if (raw.schemaVersion !== JOURNAL_SCHEMA_VERSION) throw new Error("terminal recovery schema version is unsupported");
  assertKeys(
    raw,
    [
      "kind",
      "schemaVersion",
      "runId",
      "status",
      "terminalIntent",
      "branchGeneration",
      "terminalResults",
      "blockedNodeIds",
      "error",
      "recoveryId",
      "timestamp",
    ],
    label,
  );
  if (raw.kind !== "terminal_recovery") throw new Error(`${label} kind is invalid`);
  const parsedRunId = boundedString(raw.runId, `${label}.runId`, JOURNAL_ID_LIMIT);
  if (parsedRunId !== runId) throw new Error(`${label} references a different workflow run`);
  const statusValue = raw.status;
  if (statusValue !== "failed" && statusValue !== "stopped") throw new Error(`${label}.status is invalid`);
  const status: "failed" | "stopped" = statusValue;
  const terminalIntentValue = raw.terminalIntent;
  if (terminalIntentValue !== "failure" && terminalIntentValue !== "stop") {
    throw new Error(`${label}.terminalIntent is invalid`);
  }
  const terminalIntent: "failure" | "stop" = terminalIntentValue;
  if ((terminalIntent === "failure" && status !== "failed") || (terminalIntent === "stop" && status !== "stopped")) {
    throw new Error(`${label}.status does not match terminalIntent`);
  }
  const branchGeneration = parseBranchGeneration(raw.branchGeneration, `${label}.branchGeneration`);
  if (!Array.isArray(raw.terminalResults)) throw new Error(`${label}.terminalResults must be an array`);
  const terminalResults = parseRecoveryTerminalResultShapes(raw.terminalResults, parsedRunId, nodes);
  const blockedNodeIds = parseBlockedNodeIds(raw.blockedNodeIds, nodes);
  const affected = new Set<string>();
  for (const terminal of terminalResults) {
    if (affected.has(terminal.nodeId)) throw new Error(`${label} settles and blocks the same node`);
    affected.add(terminal.nodeId);
  }
  for (const nodeId of blockedNodeIds) {
    if (affected.has(nodeId)) throw new Error(`${label} settles and blocks the same node`);
    affected.add(nodeId);
  }
  const error = raw.error === undefined ? undefined : boundedString(raw.error, `${label}.error`, JOURNAL_ERROR_LIMIT);
  const base = {
    kind: "terminal_recovery" as const,
    schemaVersion: JOURNAL_SCHEMA_VERSION as 2,
    runId: parsedRunId,
    status,
    terminalIntent,
    branchGeneration,
    terminalResults,
    blockedNodeIds,
    ...(error === undefined ? {} : { error }),
  };
  const expectedRecoveryId = deriveRecoveryId(base);
  const recoveryId = parseRecoveryId(raw.recoveryId, `${label}.recoveryId`);
  if (recoveryId !== expectedRecoveryId) {
    throw new Error(`${label}.recoveryId does not match its semantic terminal fields`);
  }
  return { ...base, recoveryId };
}

function parseTerminalRecovery(
  raw: Record<string, unknown>,
  run: WorkflowRun,
  timestamp: number,
): TerminalRecoveryEvent {
  const base = parseTerminalRecoveryBase(raw, run.runId, taskNodeIds(run), "terminal recovery");
  if (run.status !== "stopping" || run.terminalIntent !== base.terminalIntent) {
    throw new Error(`invalid terminal recovery source state: ${run.status}`);
  }
  const terminalNodes = new Set(base.terminalResults.map((terminal) => terminal.nodeId));
  for (const terminal of base.terminalResults) {
    if (terminal.nodeId === "__synthesis__") {
      if (!run.definition.synthesis) throw new Error("terminal recovery references undefined synthesis");
      if (run.synthesisResult && JSON.stringify(run.synthesisResult) !== JSON.stringify(terminal.result)) {
        throw new Error("terminal recovery synthesis fact contradicts an existing result");
      }
      if (!run.synthesisResult && terminal.attemptId !== run.attemptIds.__synthesis__) {
        throw new Error("terminal recovery synthesis fact references a superseded attempt");
      }
    } else {
      const existingResult = run.taskResults[terminal.nodeId];
      if (existingResult && JSON.stringify(existingResult) !== JSON.stringify(terminal.result)) {
        throw new Error("terminal recovery task fact contradicts an existing result");
      }
      if (!existingResult && isTerminalTask(run.taskStatus[terminal.nodeId])) {
        throw new Error("terminal recovery task fact references a settled task");
      }
      if (!existingResult && terminal.attemptId !== run.attemptIds[terminal.nodeId]) {
        throw new Error("terminal recovery task fact references a superseded attempt");
      }
    }
  }
  for (const task of run.definition.tasks) {
    if (isTerminalTask(run.taskStatus[task.id]) || run.taskResults[task.id]) continue;
    if (!terminalNodes.has(task.id) && !base.blockedNodeIds.includes(task.id)) {
      throw new Error(`terminal recovery omits unresolved task ${task.id}`);
    }
  }
  const synthesisUnresolved = run.definition.synthesis !== undefined && !run.synthesisResult;
  if (synthesisUnresolved && !terminalNodes.has("__synthesis__")) {
    throw new Error("terminal recovery omits unresolved synthesis");
  }
  return { ...base, timestamp };
}

function parseDuplicateTerminalRecovery(raw: Record<string, unknown>, run: WorkflowRun): TerminalRecoveryEvent {
  const base = parseTerminalRecoveryBase(raw, run.runId, taskNodeIds(run), "terminal recovery duplicate");
  return { ...base, timestamp: validTimestamp(raw.timestamp, "timestamp") };
}

function parseAttemptRecovery(raw: Record<string, unknown>, run: WorkflowRun, timestamp: number): AttemptRecoveryEvent {
  if (raw.schemaVersion !== JOURNAL_SCHEMA_VERSION) throw new Error("attempt recovery schema version is unsupported");
  assertKeys(
    raw,
    ["kind", "schemaVersion", "runId", "nodeId", "branchGeneration", "rotation", "legacyMigration", "timestamp"],
    "attempt recovery",
  );
  const legacyMigration = raw.legacyMigration === true;
  if (
    run.terminalIntent !== undefined ||
    ["completed", "failed", "stopped"].includes(run.status) ||
    (run.status === "interrupted" && !legacyMigration)
  ) {
    throw new Error(`invalid attempt recovery source state: ${run.status}`);
  }
  if (raw.legacyMigration !== undefined && raw.legacyMigration !== true) {
    throw new Error("attempt recovery legacy migration marker is invalid");
  }
  const branchGeneration = parseBranchGeneration(raw.branchGeneration, "branchGeneration");
  const nodeId = boundedString(raw.nodeId, "nodeId", JOURNAL_ID_LIMIT);
  const rotation = parseRecoveryRotation(raw.rotation, run, "rotation", legacyMigration);
  if (rotation.nodeId !== nodeId) throw new Error("attempt recovery node does not match its rotation");
  return {
    kind: "attempt_recovery",
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    runId: run.runId,
    nodeId,
    branchGeneration,
    rotation,
    ...(legacyMigration ? { legacyMigration: true } : {}),
    timestamp,
  };
}

function defaultAttemptId(runId: string, nodeId: string): string {
  return `${runId}/${nodeId}/attempt-1`;
}

function parseEvent(raw: unknown, runs: Map<string, WorkflowRun>): JournalEvent {
  if (!isRecord(raw)) throw new Error("journal event must be an object");
  assertKeys(
    raw,
    [
      "kind",
      "schemaVersion",
      "runId",
      "definition",
      "attempts",
      "attemptIds",
      "status",
      "error",
      "terminalIntent",
      "nodeId",
      "agentId",
      "attemptId",
      "generation",
      "owner",
      "result",
      "compactionCount",
      "branchGeneration",
      "rotations",
      "rotation",
      "sourceAttemptId",
      "sourceGeneration",
      "sourceStatus",
      "supersededAgentId",
      "legacyMigration",
      "terminalResults",
      "blockedNodeIds",
      "recoveryId",
      "timestamp",
    ],
    "journal event",
  );
  if (typeof raw.kind !== "string" || !JOURNAL_KINDS.has(raw.kind)) throw new Error("journal event kind is unknown");
  if (raw.schemaVersion !== JOURNAL_SCHEMA_VERSION && raw.schemaVersion !== JOURNAL_LEGACY_SCHEMA_VERSION) {
    throw new Error("journal schema version is unsupported");
  }
  const runId = boundedString(raw.runId, "runId", JOURNAL_ID_LIMIT);
  const timestamp = validTimestamp(raw.timestamp, "timestamp");

  if (raw.kind === "run_created") {
    if (runs.has(runId)) throw new Error("duplicate workflow run_created event");
    const definition = validateWorkflow(raw.definition);
    return {
      kind: "run_created",
      schemaVersion: raw.schemaVersion as JournalSchemaVersion,
      runId,
      definition,
      timestamp,
      ...(raw.attempts === undefined ? {} : { attempts: parseAttemptMap(raw.attempts, definition, "attempts") }),
      ...(raw.attemptIds === undefined
        ? {}
        : { attemptIds: parseAttemptIdMap(raw.attemptIds, definition, "attemptIds") }),
    };
  }

  const run = runs.get(runId);
  if (!run) throw new Error("journal event references an unknown run");
  const nodes = taskNodeIds(run);
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
    return {
      kind: "workflow_transition",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId,
      status: raw.status as WorkflowStatus,
      timestamp,
      ...(raw.error === undefined ? {} : { error: boundedString(raw.error, "error", JOURNAL_ERROR_LIMIT) }),
      ...(raw.terminalIntent === undefined ? {} : { terminalIntent: raw.terminalIntent }),
    };
  }

  // Terminal workflow outcomes are immutable. A late task/synthesis fact from
  // the superseded execution is stale, not a reason to quarantine an otherwise
  // valid run (duplicate workflow transition entries remain replay-compatible).
  if (isTerminalWorkflowStatus(run.status) && raw.kind !== "workflow_transition") {
    throw new StaleJournalGenerationError("journal event follows a terminal workflow outcome");
  }

  if (raw.kind === "synthesis_result") {
    const result = parseResult(raw.result, "synthesis result");
    const rawAttemptId =
      raw.attemptId === undefined ? undefined : boundedString(raw.attemptId, "attemptId", JOURNAL_ID_LIMIT);
    if (rawAttemptId !== undefined && result.attemptId !== undefined && rawAttemptId !== result.attemptId) {
      throw new StaleJournalGenerationError("synthesis result carries conflicting attempt generations");
    }
    const synthesisAttemptId = rawAttemptId ?? result.attemptId ?? run.attemptIds.__synthesis__;
    const owner = raw.owner === undefined ? undefined : parseOwner(raw.owner, runId, "__synthesis__");
    const currentAttemptId = run.attemptIds.__synthesis__;
    if (
      run.attemptTracking &&
      (rawAttemptId === undefined ||
        result.attemptId === undefined ||
        owner === undefined ||
        owner.attemptId === undefined)
    ) {
      throw new Error("synthesis result is missing a required raw, payload, or owner attemptId");
    }
    if (
      run.attemptTracking &&
      (rawAttemptId !== result.attemptId ||
        synthesisAttemptId !== currentAttemptId ||
        owner?.attemptId !== currentAttemptId)
    ) {
      throw new StaleJournalGenerationError("synthesis result references a stale attempt");
    }
    if (synthesisAttemptId !== currentAttemptId) {
      throw new StaleJournalGenerationError("synthesis result references a superseded attempt");
    }
    if (owner?.attemptId && currentAttemptId && owner.attemptId !== currentAttemptId) {
      throw new StaleJournalGenerationError("journal synthesis owner references a superseded attempt");
    }
    return {
      kind: "synthesis_result",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId,
      result: result.attemptId === undefined ? { ...result, attemptId: synthesisAttemptId } : result,
      attemptId: synthesisAttemptId,
      timestamp,
      ...(owner ? { owner } : {}),
    };
  }

  const nodeId = boundedString(raw.nodeId, "nodeId", JOURNAL_ID_LIMIT);
  if (
    !nodes.has(nodeId) ||
    (nodeId === "__synthesis__" && raw.kind !== "task_compacted" && raw.kind !== "task_attempt")
  )
    throw new Error("journal event references an unknown task node");
  const owner = raw.owner === undefined ? undefined : parseOwner(raw.owner, runId, nodeId);
  const rawAttemptId =
    raw.attemptId === undefined ? undefined : boundedString(raw.attemptId, "attemptId", JOURNAL_ID_LIMIT);
  const attemptId = rawAttemptId ?? run.attemptIds[nodeId];
  if (run.attemptTracking && (rawAttemptId === undefined || owner === undefined || owner.attemptId === undefined)) {
    throw new Error("journal attempt-aware event is missing a required raw or owner attemptId");
  }
  if (raw.kind !== "task_attempt" && owner?.attemptId && attemptId && owner.attemptId !== attemptId) {
    throw new StaleJournalGenerationError("journal owner references a different attempt");
  }
  if (raw.kind !== "task_attempt" && attemptId !== run.attemptIds[nodeId]) {
    throw new StaleJournalGenerationError("journal event references a superseded attempt");
  }

  if (raw.kind === "task_attempt") {
    const generation = raw.generation;
    if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1 || generation > 1_000_000) {
      throw new Error("task attempt generation is invalid");
    }
    if (generation <= (run.attempts[nodeId] ?? 0)) {
      throw new StaleJournalGenerationError("task attempt generation is stale");
    }
    const expectedAttemptId = `${runId}/${nodeId}/attempt-${generation}`;
    if (attemptId !== expectedAttemptId || owner?.attemptId !== attemptId) {
      throw new Error("task attempt does not identify its next generation");
    }
    return {
      kind: "task_attempt",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId,
      nodeId,
      attemptId,
      generation,
      timestamp,
      ...(owner ? { owner } : {}),
    };
  }

  if (raw.kind === "task_transition") {
    if (!TASK_STATUS_VALUES.has(raw.status as TaskStatus)) throw new Error("task status is unknown");
    const previous = run.taskStatus[nodeId];
    const legacyDirectStart = previous === "pending" && raw.status === "running";
    if (!previous || (!canTransitionTask(previous, raw.status as TaskStatus) && !legacyDirectStart)) {
      throw new Error(`invalid task transition: ${String(previous)} -> ${String(raw.status)}`);
    }
    const agentId = raw.agentId === undefined ? undefined : boundedString(raw.agentId, "agentId", JOURNAL_ID_LIMIT);
    return {
      kind: "task_transition",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId,
      nodeId,
      status: raw.status as TaskStatus,
      timestamp,
      ...(agentId ? { agentId } : {}),
      ...(attemptId ? { attemptId } : {}),
      ...(owner ? { owner } : {}),
    };
  }

  if (raw.kind === "task_compacted") {
    if (
      typeof raw.compactionCount !== "number" ||
      !Number.isInteger(raw.compactionCount) ||
      raw.compactionCount < 0 ||
      raw.compactionCount > 1_000_000
    ) {
      throw new Error("compaction count is invalid");
    }
    return {
      kind: "task_compacted",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId,
      nodeId,
      compactionCount: raw.compactionCount,
      attemptId,
      timestamp,
      ...(owner ? { owner } : {}),
    };
  }

  const result = parseResult(raw.result, "task result");
  if (run.attemptTracking && result.attemptId === undefined) {
    throw new Error("task result is missing a required payload attemptId");
  }
  if (result.attemptId && attemptId && result.attemptId !== attemptId) {
    throw new StaleJournalGenerationError("task result payload references a superseded attempt");
  }
  return {
    kind: "task_result",
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    runId,
    nodeId,
    result: result.attemptId === undefined && attemptId ? { ...result, attemptId } : result,
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
): Map<string, WorkflowRun> {
  const runs = new Map<string, WorkflowRun>();
  const quarantined = new Set<string>();
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
    try {
      if (
        isRecord(raw) &&
        (raw.kind === "run_recovery" || raw.kind === "terminal_recovery") &&
        typeof raw.recoveryId === "string"
      ) {
        for (const [seenRunId, seen] of seenRecoveries) {
          if (seenRunId === rawRunId || !seen.has(raw.recoveryId)) continue;
          // A colliding recovery ID belongs to the malformed current entry; keep the previously validated owner intact.
          throw new Error(`recoveryId ${raw.recoveryId} is already owned by workflow run ${seenRunId}`);
        }
      }
      if (isRecord(raw) && (raw.kind === "run_recovery" || raw.kind === "terminal_recovery") && rawRunId) {
        const run = runs.get(rawRunId);
        const seen = seenRecoveries.get(rawRunId);
        if (run && seen) {
          // Parse duplicates without consulting current generation/status: the
          // first copy already advanced those fields. The normalized semantic
          // digest still validates every bounded field before accepting a no-op.
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
        seenRecoveries.set(event.runId, new Map());
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
        continue;
      }
      applyJournalEvent(runs, event);
    } catch (error: unknown) {
      if (error instanceof StaleJournalGenerationError) continue;
      if (rawRunId) {
        quarantined.add(rawRunId);
        runs.delete(rawRunId);
        seenRecoveries.delete(rawRunId);
      }
      report(error instanceof Error ? error.message : String(error));
    }
  }
  for (const [runId, run] of runs) {
    try {
      validateAggregate(run);
    } catch (error: unknown) {
      runs.delete(runId);
      quarantined.add(runId);
      seenRecoveries.delete(runId);
      report(`${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return runs;
}

function applyRecoveryRotation(run: WorkflowRun, rotation: RecoveryRotation): void {
  run.attemptTracking = true;
  run.attempts[rotation.nodeId] = rotation.generation;
  run.attemptIds[rotation.nodeId] = rotation.attemptId;
  delete run.agentIds[rotation.nodeId];
  delete run.taskResults[rotation.nodeId];
  run.compactions[rotation.nodeId] = 0;
  if (rotation.nodeId === "__synthesis__") {
    run.synthesisAgentId = undefined;
    run.synthesisResult = undefined;
  } else {
    run.taskStatus[rotation.nodeId] = "ready";
  }
}

function applyRecoveryTerminalResult(run: WorkflowRun, terminal: RecoveryTerminalResult): void {
  run.compactions[terminal.nodeId] = Math.max(run.compactions[terminal.nodeId] ?? 0, terminal.result.compactionCount);
  if (terminal.nodeId === "__synthesis__") {
    run.synthesisResult = terminal.result;
    if (terminal.result.agentId) run.synthesisAgentId = terminal.result.agentId;
  } else {
    run.taskResults[terminal.nodeId] = terminal.result;
    run.taskStatus[terminal.nodeId] = terminal.result.status;
    if (terminal.result.agentId) run.agentIds[terminal.nodeId] = terminal.result.agentId;
  }
}

export function applyRecoveryTerminalResults(
  run: WorkflowRun,
  terminalResults: readonly RecoveryTerminalResult[],
): void {
  for (const terminal of terminalResults) applyRecoveryTerminalResult(run, terminal);
}

/** Apply an already validated atomic recovery event after its append succeeds. */
export function applyRecoveryEvent(run: WorkflowRun, event: RunRecoveryEvent | AttemptRecoveryEvent): void {
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
export function applyTerminalRecoveryEvent(run: WorkflowRun, event: TerminalRecoveryEvent): void {
  for (const terminal of event.terminalResults) applyRecoveryTerminalResult(run, terminal);
  for (const nodeId of event.blockedNodeIds) {
    if (!isTerminalTask(run.taskStatus[nodeId])) run.taskStatus[nodeId] = "blocked";
  }
  run.status = event.status;
  run.terminalIntent = event.terminalIntent;
  if (event.error !== undefined) run.error = event.error;
  if (event.status === "stopped") run.nonResumable = true;
  run.updatedAt = event.timestamp;
}

function applyJournalEvent(runs: Map<string, WorkflowRun>, event: JournalEvent): void {
  if (event.kind === "run_created") {
    const taskStatus: Record<string, TaskStatus> = {};
    const attempts: Record<string, number> = {};
    const attemptIds: Record<string, string> = {};
    for (const task of event.definition.tasks) {
      taskStatus[task.id] = "pending";
      attempts[task.id] = event.attempts?.[task.id] ?? 1;
      attemptIds[task.id] = event.attemptIds?.[task.id] ?? defaultAttemptId(event.runId, task.id);
    }
    attempts.__synthesis__ = event.attempts?.__synthesis__ ?? 1;
    attemptIds.__synthesis__ = event.attemptIds?.__synthesis__ ?? defaultAttemptId(event.runId, "__synthesis__");
    runs.set(event.runId, {
      runId: event.runId,
      schemaVersion: event.schemaVersion,
      definition: event.definition,
      status: "pending",
      taskStatus,
      agentIds: {},
      attempts,
      attemptIds,
      attemptTracking: event.attemptIds !== undefined,
      taskResults: {},
      compactions: {},
      startedAt: event.timestamp,
      updatedAt: event.timestamp,
    });
    return;
  }

  const run = runs.get(event.runId);
  if (!run) return;
  run.updatedAt = event.timestamp;
  switch (event.kind) {
    case "workflow_transition":
      run.status = event.status;
      if (event.error !== undefined) run.error = event.error;
      if (event.terminalIntent !== undefined) run.terminalIntent = event.terminalIntent;
      break;
    case "run_recovery":
    case "attempt_recovery":
      applyRecoveryEvent(run, event);
      break;
    case "terminal_recovery":
      applyTerminalRecoveryEvent(run, event);
      break;
    case "task_attempt":
      run.attemptTracking = true;
      run.attempts[event.nodeId] = event.generation;
      run.attemptIds[event.nodeId] = event.attemptId;
      delete run.agentIds[event.nodeId];
      delete run.taskResults[event.nodeId];
      if (event.nodeId === "__synthesis__") {
        run.synthesisAgentId = undefined;
        run.synthesisResult = undefined;
      } else {
        run.taskStatus[event.nodeId] = "ready";
      }
      run.compactions[event.nodeId] = 0;
      break;
    case "task_transition":
      if (event.attemptId && event.attemptId !== run.attemptIds[event.nodeId]) {
        throw new Error("task transition references a superseded attempt");
      }
      run.taskStatus[event.nodeId] = event.status;
      if (event.agentId) run.agentIds[event.nodeId] = event.agentId;
      break;
    case "task_result":
      if (event.attemptId && event.attemptId !== run.attemptIds[event.nodeId]) {
        throw new Error("task result references a superseded attempt");
      }
      if (
        run.taskResults[event.nodeId] &&
        JSON.stringify(run.taskResults[event.nodeId]) !== JSON.stringify(event.result)
      ) {
        throw new Error("contradictory terminal task result");
      }
      run.taskResults[event.nodeId] = event.result;
      run.taskStatus[event.nodeId] = event.result.status;
      run.compactions[event.nodeId] = Math.max(run.compactions[event.nodeId] ?? 0, event.result.compactionCount);
      if (event.result.agentId) run.agentIds[event.nodeId] = event.result.agentId;
      break;
    case "task_compacted":
      if (event.attemptId && event.attemptId !== run.attemptIds[event.nodeId]) {
        throw new Error("compaction references a superseded attempt");
      }
      run.compactions[event.nodeId] = event.compactionCount;
      break;
    case "synthesis_result":
      if (run.synthesisResult && JSON.stringify(run.synthesisResult) !== JSON.stringify(event.result)) {
        throw new Error("contradictory synthesis result");
      }
      run.synthesisResult = event.result;
      run.compactions.__synthesis__ = Math.max(run.compactions.__synthesis__ ?? 0, event.result.compactionCount);
      if (event.result.agentId) run.synthesisAgentId = event.result.agentId;
      break;
  }
}

function validateAggregate(run: WorkflowRun): void {
  const nodes = [...run.definition.tasks.map((task) => task.id), "__synthesis__"];
  for (const nodeId of nodes) {
    if (!Number.isInteger(run.attempts[nodeId]) || run.attempts[nodeId] < 1) {
      throw new Error(`missing attempt generation for ${nodeId}`);
    }
    boundedString(run.attemptIds[nodeId], `attemptIds.${nodeId}`, JOURNAL_ID_LIMIT);
  }
  if (isTerminalWorkflowStatus(run.status)) {
    const statuses = Object.values(run.taskStatus);
    if (run.status === "completed" && statuses.some((status) => status !== "completed")) {
      throw new Error("completed workflow has non-completed tasks");
    }
    if (run.status === "stopped" && statuses.some((status) => !isTerminalTask(status))) {
      throw new Error("stopped workflow has active tasks");
    }
    if (run.status === "failed" && statuses.some((status) => !isTerminalTask(status))) {
      throw new Error("failed workflow has active tasks");
    }
    if (run.status === "failed" || run.status === "stopped") {
      if (run.synthesisAgentId && !run.synthesisResult) {
        throw new Error(`${run.status} workflow has an active synthesis agent`);
      }
    }
  }
  if (run.synthesisResult && Object.values(run.taskStatus).some((status) => !isTerminalTask(status))) {
    throw new Error("synthesis settled before workflow tasks");
  }
}

function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

export function snapshotRun(run: WorkflowRun): WorkflowRun {
  return JSON.parse(JSON.stringify(run)) as WorkflowRun;
}
