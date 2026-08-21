/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Foreground agents bypass the queue (they block the parent anyway), and so do
 * nested children — see `occupiesPoolSlot`.
 */

import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ManagedSpawnRequest as ProtocolManagedSpawnRequest, WorkflowTier } from "@signalridge/pi-subagents-protocol";
import { isWorkflowTier, parseManagedSpawnRequest } from "@signalridge/pi-subagents-protocol";
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import type { AgentTierResolutionSnapshot } from "./agent-tiers.js";
import {
  INTERNAL_AGENT_CONFIG_OVERRIDE,
  type InternalAgentConfigOverride,
} from "./internal-run.js";
import { assignHandle, handleBase } from "./mention.js";
import { shutdownAndDisposeSession } from "./session-lifecycle.js";
import type { WorkflowThinking } from "./settings.js";
import type { AgentInvocation, AgentOwner, AgentRecord, AgentRecordSnapshot, IsolationMode, ResumableAgentEntry, SubagentType, ThinkingLevel } from "./types.js";
import { addUsage } from "./usage.js";
import type { WorkflowTierResolutionSnapshot } from "./workflow-tiers.js";
import {
  cleanupWorktree,
  cleanupWorktreeAsync,
  createWorktree,
  isWorktreeIsolationEnabled,
  pruneWorktrees,
  pruneWorktreesAsync,
  type WorktreeCleanupResult,
  type WorktreeInfo,
} from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentCreated = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

export interface WorktreeCleanupFailure {
  readonly path: string;
  readonly repoRoot: string;
  readonly reason: string;
  readonly recoveryCommands: readonly string[];
}

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = 4;
/** Bound on the resumable (`@handle`) index. */
const MAX_RESUMABLE_ENTRIES = 128;
/**
 * Cumulative descendants one top-level agent may start, over its whole life.
 *
 * High enough that no ordinary delegation notices it, low enough that a runaway
 * fan-out is caught by a number here rather than by the account's rate limit.
 */
export const DEFAULT_MAX_SUBAGENT_SPAWNS_PER_BRANCH = 64;
/**
 * Nested worktree cleanup waits for cooperative children, but a provider that
 * ignores abort must not hold its parent forever. Timed-out descendants are
 * quarantined and their worktrees stay pinned for recovery until settlement.
 */
const OWNED_CHILD_QUIESCE_TIMEOUT_MS = 5_000;
/** Shutdown briefly drains abort-responsive providers; stragglers retain worktrees. */
const DISPOSE_PROVIDER_QUIESCE_TIMEOUT_MS = 1_000;

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

/**
 * Whether a record occupies one of the `maxConcurrent` background slots.
 * Nested children don't: their parent already holds a slot, so counting (and
 * therefore queueing) them would deadlock a parent that waits on its own child.
 *
 * Note this bounds nothing horizontally — the depth cap limits how DEEP nesting
 * goes, not how WIDE. A parent's only limit on concurrent children is that each
 * spawn costs it a turn, which is unbounded when max turns is unlimited.
 */
function occupiesPoolSlot(record: Pick<AgentRecord, "isBackground" | "parentAgentId">): boolean {
  return !!record.isBackground && record.parentAgentId === undefined;
}


/** Clone only inert JSON-like data and freeze every level to break aliases. */
function cloneFrozenData<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || value === undefined || typeof value === "string" ||
    typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") throw new Error("Agent invocation metadata must contain only inert data");
  if (seen.has(value)) throw new Error("Agent invocation metadata must not be cyclic");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const clone: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        clone.push(cloneFrozenData(value[index], seen));
      }
      return Object.freeze(clone) as T;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Agent invocation metadata must contain only plain objects");
    }
    const clone: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) clone[key] = cloneFrozenData(item, seen);
    return Object.freeze(clone) as T;
  } finally {
    seen.delete(value);
  }
}
/**
 * Copy the observable record state for public consumers.
 *
 * Mutable nested data is copied and frozen. Live session and manager control
 * handles are removed entirely so a record lookup cannot steer, prompt, or
 * mutate the authoritative run through an AgentSession capability.
 */
function snapshotAgentRecord(record: AgentRecord): AgentRecordSnapshot {
  const owner = record.owner ? Object.freeze({ ...record.owner }) : undefined;
  const lifetimeUsage = Object.freeze({ ...record.lifetimeUsage });
  const pendingSteers = record.pendingSteers ? Object.freeze([...record.pendingSteers]) : undefined;
  const invocation = record.invocation ? cloneFrozenData(record.invocation) : undefined;
  const worktree = record.worktree ? Object.freeze({ ...record.worktree }) : undefined;
  const worktreeResult = record.worktreeResult
    ? Object.freeze({
        ...record.worktreeResult,
        ...(record.worktreeResult.recoveryCommands
          ? { recoveryCommands: Object.freeze([...record.worktreeResult.recoveryCommands]) }
          : {}),
      })
    : undefined;
  const ancestorAgentIds = record.ancestorAgentIds
    ? Object.freeze([...record.ancestorAgentIds])
    : undefined;
  const snapshot = {
    ...record,
    owner,
    lifetimeUsage,
    pendingSteers,
    invocation,
    worktree,
    worktreeResult,
    ...(ancestorAgentIds ? { ancestorAgentIds } : {}),
  };
  Reflect.deleteProperty(snapshot, "session");
  Reflect.deleteProperty(snapshot, "abortController");
  Reflect.deleteProperty(snapshot, "outputCleanup");

  Reflect.deleteProperty(snapshot, "promise");
  return Object.freeze(snapshot);
}

const WORKTREE_FAILURE_DIAGNOSTIC_LIMIT = 2_000;

function shellQuote(value: string | undefined): string {
  if (!value) return "''";
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function worktreeRecoveryCommands(cwd?: string, path?: string): readonly string[] {
  const c = cwd ? shellQuote(cwd) : "'.'";
  const p = path ? shellQuote(path) : "''";
  return Object.freeze([
    `git -C ${c} worktree remove --force ${p}`,
    `rm -rf -- ${p}`,
    `git -C ${c} worktree prune`,
  ]);
}


function sameFilesystemPath(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

function cleanupFailureResult(cwd: string, worktree: WorktreeInfo, error: unknown): WorktreeCleanupResult {
  const reason = `Worktree cleanup threw before reporting an outcome for ${worktree.path}: ${error instanceof Error ? error.message : String(error)}`
    .replace(/\s+/g, " ")
    .slice(0, WORKTREE_FAILURE_DIAGNOSTIC_LIMIT);
  return {
    hasChanges: false,
    path: worktree.path,
    cleanupSucceeded: false,
    cleanupDiagnostic: reason,
    recoveryCommands: worktreeRecoveryCommands(cwd, worktree.path),
  };
}

function snapshotCleanupFailure(worktree: WorktreeInfo, result: WorktreeCleanupResult): WorktreeCleanupFailure {
  const reason = (result.cleanupDiagnostic ?? `Worktree cleanup failed for ${worktree.path}`)
    .replace(/\s+/g, " ")
    .slice(0, WORKTREE_FAILURE_DIAGNOSTIC_LIMIT);
  const recovery = result.recoveryCommands?.length
    ? result.recoveryCommands
    : worktreeRecoveryCommands(worktree.repoRoot, worktree.path);
  return Object.freeze({
    path: worktree.path,
    repoRoot: worktree.repoRoot,
    reason,
    recoveryCommands: Object.freeze([...recovery]),
  });
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
  internalOverride?: InternalAgentConfigOverride;
}

export type ManagedSpawnRequest = ProtocolManagedSpawnRequest;

export const MANAGED_SPAWN_ENTRY_TYPE = "subagents:managed-spawn";
export const MANAGED_SPAWN_SCHEMA_VERSION = 1;
const MANAGED_TEXT_LIMIT = 8_000;
const MANAGED_ERROR_LIMIT = 2_000;
const MANAGED_PATH_LIMIT = 2_000;
const MANAGED_MAX_TIMESTAMP = 8_640_000_000_000_000;
const MANAGED_PERSIST_RETRY_INITIAL_DELAY_MS = 25;
const MANAGED_PERSIST_RETRY_MAX_DELAY_MS = 2_000;
const MANAGED_PERSIST_RETRY_MAX_ATTEMPTS = 8;

export type ManagedSpawnState = "queued" | "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface ManagedTerminalSnapshot {
  status: "completed" | "failed" | "stopped" | "interrupted";
  result?: string;
  error?: string;
  outputFile?: string;
  tokenCount?: number;
  compactionCount: number;
  completedAt: number;
}

/**
 * Session-persisted idempotency state for one workflow-owned spawn. The prompt
 * is represented by the bounded SHA-256 fingerprint rather than retained in
 * the session entry; terminal output is capped and points at the transcript.
 */
export interface ManagedSpawnTombstone {
  schemaVersion: typeof MANAGED_SPAWN_SCHEMA_VERSION;
  spawnKey: string;
  fingerprint: string;
  id: string;
  requestId: string;
  type: string;
  description: string;
  owner: AgentOwner;
  /** Semantic tier requested by the workflow; resolution remains internal. */
  tier?: WorkflowTier;
  /** Named managed thread, when this spawn re-enters a sequential session. */
  thread?: string;
  /** Effective policy fingerprint that makes thread reuse safe across calls/reloads. */
  threadPolicyFingerprint?: string;
  /** Internal audit snapshot of the resolved model/thinking policy. */
  tierSnapshot?: WorkflowTierResolutionSnapshot;
  state: ManagedSpawnState;
  createdAt: number;
  updatedAt: number;
  compactionCount: number;
  terminal?: ManagedTerminalSnapshot;
}

/** Response returned by managed spawn, including an already-settled outcome. */
export interface ManagedSpawnResult {
  id: string;
  state: ManagedSpawnState;
  /** True only when this call allocated a new tombstone/Agent record. */
  created: boolean;
  terminal?: ManagedTerminalSnapshot;
}

/** Persistence seam kept optional so ordinary AgentManager users stay in-memory. */
export interface ManagedSpawnPersistence {
  append(tombstone: ManagedSpawnTombstone): void;
}

export interface ManagedSpawnEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}

type ManagedRecordStatus = AgentRecord["status"];

type ManagedRequestRecord = Record<string, unknown>;

const MANAGED_OWNER_KEYS = new Set(["extension", "runId", "nodeId", "attemptId"]);

function isRecord(value: unknown): value is ManagedRequestRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedManagedString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return normalized;
}

function rejectManagedKeys(value: ManagedRequestRecord, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field "${key}"`);
  }
}

function normalizeManagedOwner(raw: unknown, requireAttempt = false): AgentOwner {
  if (!isRecord(raw)) throw new Error("owner must be an object");
  rejectManagedKeys(raw, MANAGED_OWNER_KEYS, "owner");
  const extension = boundedManagedString(raw.extension, "owner.extension", 64);
  if (extension !== "pi-workflows") throw new Error('owner.extension must be "pi-workflows"');
  const attemptId = raw.attemptId === undefined
    ? undefined
    : boundedManagedString(raw.attemptId, "owner.attemptId", 256);
  if (requireAttempt && attemptId === undefined) throw new Error("owner.attemptId is required");
  return {
    extension,
    runId: boundedManagedString(raw.runId, "owner.runId", 256),
    nodeId: boundedManagedString(raw.nodeId, "owner.nodeId", 256),
    ...(attemptId === undefined ? {} : { attemptId }),
  };
}

function normalizeManagedSpawnRequest(raw: unknown): ManagedSpawnRequest {
  return parseManagedSpawnRequest(raw);
}

function managedFingerprint(request: ManagedSpawnRequest, policyFingerprint?: string): string {
  return createHash("sha256")
    .update(JSON.stringify([
      request.type,
      request.prompt,
      request.description,
      ...(request.tier === undefined ? [] : [request.tier]),
      request.model,
      request.thinking,
      request.toolset,
      request.excludeTools,
      request.isolation,
      request.thread,
      request.owner.extension,
      request.owner.runId,
      request.owner.nodeId,
      request.owner.attemptId,
      policyFingerprint,
    ]))
    .digest("hex");
}

/** Exact schema-v1 identity; do not add newer policy fields to this algorithm. */
function managedLegacyFingerprintV1(request: ManagedSpawnRequest): string {
  return createHash("sha256")
    .update(JSON.stringify([
      request.type,
      request.prompt,
      request.description,
      ...(request.tier === undefined ? [] : [request.tier]),
      request.owner.extension,
      request.owner.runId,
      request.owner.nodeId,
      request.owner.attemptId,
    ]))
    .digest("hex");
}

/**
 * Policy identity for a managed spawn. Prompts and owner attempt identities
 * intentionally do not participate: a thread is allowed to receive new work,
 * but its session cannot safely change model/tool/isolation policy.
 */
function managedThreadPolicyFingerprint(request: ManagedSpawnRequest, policy: ManagedSpawnPolicy): string {
  const model = policy.model as { provider?: unknown; id?: unknown } | undefined;
  const excludeTools = [...new Set([...(request.excludeTools ?? []), ...(policy.excludeTools ?? [])])].sort();
  return createHash("sha256")
    .update(JSON.stringify([
      request.type,
      request.tier,
      request.model,
      request.thinking === "off" ? undefined : request.thinking,
      request.toolset ?? policy.toolset,
      excludeTools,
      request.isolation ?? policy.isolation,
      policy.maxTurns,
      policy.isolated,
      policy.inheritContext,
      policy.thinkingLevel,
      policy.policyFingerprint,
      model?.provider,
      model?.id,
    ]))
    .digest("hex");
}

function isManagedState(value: unknown): value is ManagedSpawnState {
  return value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "stopped" || value === "interrupted";
}

function isManagedTerminalState(value: ManagedSpawnState): value is "completed" | "failed" | "stopped" | "interrupted" {
  return value === "completed" || value === "failed" || value === "stopped" || value === "interrupted";
}

function capManagedText(value: string | undefined, limit: number): string | undefined {
  if (!value) return undefined;
  if (value.length <= limit) return value;
  const marker = "\n…[truncated]";
  return `${value.slice(0, Math.max(0, limit - marker.length))}${marker}`;
}

function cloneManagedTerminal(terminal: ManagedTerminalSnapshot | undefined): ManagedTerminalSnapshot | undefined {
  return terminal ? { ...terminal } : undefined;
}

function cloneManagedTombstone(tombstone: ManagedSpawnTombstone): ManagedSpawnTombstone {
  return {
    ...tombstone,
    owner: { ...tombstone.owner },
    ...(tombstone.tierSnapshot ? { tierSnapshot: { ...tombstone.tierSnapshot } } : {}),
    terminal: cloneManagedTerminal(tombstone.terminal),
  };
}

const WORKFLOW_THINKING_LEVELS = new Set<ThinkingLevel>(["minimal", "low", "medium", "high", "xhigh", "max"]);
const WORKFLOW_CONFIGURED_THINKING = new Set<WorkflowThinking>([...WORKFLOW_THINKING_LEVELS, "inherit"]);
const TIER_SNAPSHOT_KEYS = new Set([
  "tier",
  "model",
  "thinking",
  "configuredModel",
  "configuredThinking",
  "requestedThinking",
  "modelSource",
  "thinkingSource",
  "clamped",
  "diagnostic",
]);

function parseTierSnapshot(raw: unknown, tier: WorkflowTier): WorkflowTierResolutionSnapshot | undefined {
  if (!isRecord(raw) || raw.tier !== tier) return undefined;
  try {
    rejectManagedKeys(raw, TIER_SNAPSHOT_KEYS, "tierSnapshot");
    const source = raw.modelSource;
    const thinkingSource = raw.thinkingSource;
    if ((source !== "frontmatter" && source !== "tier" && source !== "parent") ||
      (thinkingSource !== "frontmatter" && thinkingSource !== "tier" && thinkingSource !== "parent")) return undefined;
    const optionalThinking = (value: unknown): ThinkingLevel | undefined => {
      if (value === undefined) return undefined;
      return typeof value === "string" && WORKFLOW_THINKING_LEVELS.has(value as ThinkingLevel)
        ? value as ThinkingLevel
        : undefined;
    };
    const thinking = optionalThinking(raw.thinking);
    const configuredThinking = raw.configuredThinking === undefined
      ? undefined
      : typeof raw.configuredThinking === "string" && WORKFLOW_CONFIGURED_THINKING.has(raw.configuredThinking as WorkflowThinking)
        ? raw.configuredThinking as WorkflowThinking
        : undefined;
    const requestedThinking = optionalThinking(raw.requestedThinking);
    for (const [label, value] of [["model", raw.model], ["configuredModel", raw.configuredModel]] as const) {
      if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > MANAGED_PATH_LIMIT)) {
        return undefined;
      }
      if (label === "model" && typeof value === "string" && !value.includes("/")) return undefined;
    }
    if (raw.thinking !== undefined && thinking === undefined) return undefined;
    if (raw.configuredThinking !== undefined && configuredThinking === undefined) return undefined;
    if (raw.requestedThinking !== undefined && requestedThinking === undefined) return undefined;
    if (raw.clamped !== undefined && typeof raw.clamped !== "boolean") return undefined;
    if (raw.diagnostic !== undefined && (typeof raw.diagnostic !== "string" || raw.diagnostic.length > MANAGED_ERROR_LIMIT)) return undefined;
    return {
      tier,
      ...(typeof raw.model === "string" ? { model: raw.model } : {}),
      ...(thinking ? { thinking } : {}),
      ...(typeof raw.configuredModel === "string" ? { configuredModel: raw.configuredModel } : {}),
      ...(configuredThinking ? { configuredThinking } : {}),
      ...(requestedThinking ? { requestedThinking } : {}),
      modelSource: source,
      thinkingSource,
      ...(raw.clamped === true ? { clamped: true } : {}),
      ...(typeof raw.diagnostic === "string" ? { diagnostic: raw.diagnostic } : {}),
    };
  } catch {
    return undefined;
  }
}

function terminalStatusForRecord(status: ManagedRecordStatus): ManagedTerminalSnapshot["status"] | undefined {
  if (status === "completed" || status === "steered") return "completed";
  if (status === "error" || status === "aborted") return "failed";
  if (status === "stopped") return "stopped";
  return undefined;
}

function parseManagedTombstone(raw: unknown): ManagedSpawnTombstone | undefined {
  if (!isRecord(raw) || raw.schemaVersion !== MANAGED_SPAWN_SCHEMA_VERSION) return undefined;
  try {
    const state = raw.state;
    if (!isManagedState(state)) return undefined;
    const terminalValue = raw.terminal;
    const persistedCompactionCount = raw.compactionCount;
    const thread = raw.thread === undefined ? undefined : boundedManagedString(raw.thread, "thread", 128);
    const threadPolicyFingerprint = raw.threadPolicyFingerprint === undefined
      ? undefined
      : boundedManagedString(raw.threadPolicyFingerprint, "threadPolicyFingerprint", 128);
    if ((thread === undefined) !== (threadPolicyFingerprint === undefined)) return undefined;
    const tier = raw.tier;
    if (tier !== undefined && !isWorkflowTier(tier)) return undefined;
    const tierSnapshotValue = raw.tierSnapshot;
    let tierSnapshot: WorkflowTierResolutionSnapshot | undefined;
    if (tierSnapshotValue !== undefined) {
      if (tier === undefined) return undefined;
      tierSnapshot = parseTierSnapshot(tierSnapshotValue, tier);
      if (!tierSnapshot) return undefined;
    }
    if (
      typeof persistedCompactionCount !== "undefined" &&
      (typeof persistedCompactionCount !== "number" || !Number.isInteger(persistedCompactionCount) || persistedCompactionCount < 0)
    ) return undefined;
    let terminal: ManagedTerminalSnapshot | undefined;
    if (terminalValue !== undefined) {
      if (!isRecord(terminalValue) || !isManagedTerminalState(terminalValue.status as ManagedSpawnState)) return undefined;
      const completedAt = terminalValue.completedAt;
      const compactionCount = terminalValue.compactionCount;
      if (
        typeof completedAt !== "number" || !Number.isFinite(completedAt) || completedAt < 0 || completedAt > MANAGED_MAX_TIMESTAMP ||
        typeof compactionCount !== "number" || !Number.isInteger(compactionCount) || compactionCount < 0
      ) return undefined;
      if (typeof terminalValue.tokenCount !== "undefined" &&
        (typeof terminalValue.tokenCount !== "number" || !Number.isInteger(terminalValue.tokenCount) || terminalValue.tokenCount < 0)) return undefined;
      if (typeof terminalValue.result !== "undefined" && typeof terminalValue.result !== "string") return undefined;
      if (typeof terminalValue.error !== "undefined" && typeof terminalValue.error !== "string") return undefined;
      if (typeof terminalValue.outputFile !== "undefined" && typeof terminalValue.outputFile !== "string") return undefined;
      terminal = {
        status: terminalValue.status as ManagedTerminalSnapshot["status"],
        ...(capManagedText(typeof terminalValue.result === "string" ? terminalValue.result : undefined, MANAGED_TEXT_LIMIT) ? { result: capManagedText(terminalValue.result as string, MANAGED_TEXT_LIMIT) } : {}),
        ...(capManagedText(typeof terminalValue.error === "string" ? terminalValue.error : undefined, MANAGED_ERROR_LIMIT) ? { error: capManagedText(terminalValue.error as string, MANAGED_ERROR_LIMIT) } : {}),
        ...(typeof terminalValue.outputFile === "string" ? { outputFile: terminalValue.outputFile.slice(0, MANAGED_PATH_LIMIT) } : {}),
        ...(typeof terminalValue.tokenCount === "number" ? { tokenCount: terminalValue.tokenCount } : {}),
        compactionCount,
        completedAt,
      };
    }
    if (isManagedTerminalState(state) !== (terminal !== undefined)) return undefined;
    if (terminal && terminal.status !== state) return undefined;
    const createdAt = raw.createdAt;
    const updatedAt = raw.updatedAt;
    if (
      typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt < 0 || createdAt > MANAGED_MAX_TIMESTAMP ||
      typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt < 0 || updatedAt > MANAGED_MAX_TIMESTAMP
    ) return undefined;
    return {
      schemaVersion: MANAGED_SPAWN_SCHEMA_VERSION,
      spawnKey: boundedManagedString(raw.spawnKey, "spawnKey", 256),
      fingerprint: boundedManagedString(raw.fingerprint, "fingerprint", 128),
      id: boundedManagedString(raw.id, "id", 128),
      requestId: boundedManagedString(raw.requestId, "requestId", 128),
      type: boundedManagedString(raw.type, "type", 128),
      description: boundedManagedString(raw.description, "description", 512),
      owner: normalizeManagedOwner(raw.owner),
      ...(tier === undefined ? {} : { tier }),
      ...(thread === undefined ? {} : { thread, threadPolicyFingerprint }),
      ...(tierSnapshot ? { tierSnapshot } : {}),
      state,
      createdAt,
      updatedAt,
      compactionCount: typeof persistedCompactionCount === "number" ? persistedCompactionCount : terminal?.compactionCount ?? 0,
      terminal,
    };
  } catch {
    return undefined;
  }
}

export interface SpawnOptions {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Semantic workflow tier resolved by pi-subagents at session start. */
  tier?: WorkflowTier;
  /** User-named model tier; resolved by pi-subagents at session start. */
  agentTier?: string;
  /** Optional toolset hint; concrete tool availability remains agent-configured. */
  toolset?: string;
  /** Additional tool names denied for this invocation. */
  excludeTools?: string[];
  /** Named sequential-thread hint for workflow orchestration. */
  thread?: string;
  isBackground?: boolean;
  /**
   * Skip the maxConcurrent queue check for this spawn — start immediately even
   * if the configured concurrency limit would otherwise queue it. Used by the
   * scheduler so a fired job can't be deferred past its trigger window.
   */
  bypassQueue?: boolean;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /**
   * Working directory for the agent (absolute path). Default: parent session
   * cwd. The agent's tools operate here, but .pi config (extensions, skills,
   * settings, memory) still loads from the parent session's project — the
   * target directory's `.pi` extensions never execute. With isolation:
   * "worktree", the worktree is created FROM this directory and the result
   * branch lands in that repo.
   */
  cwd?: string;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called after pi-subagents resolves a semantic workflow tier. */
  onTierResolved?: (snapshot: WorkflowTierResolutionSnapshot) => void;
  /** Called after pi-subagents resolves a user-named agent tier. */
  onAgentTierResolved?: (snapshot: AgentTierResolutionSnapshot) => void;
  /** Called synchronously after a new record is allocated, before session creation. */
  onSpawned?: (id: string) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /** Nesting depth: top-level subagent = 1. */
  depth?: number;
  /** Parent agent ID for ownership-scoped nested controls. */
  parentAgentId?: string;
  /** Effective inherited nesting cap for this branch. */
  maxSubagentDepth?: number;
  /** Config-discovery root inherited by nested launches when it differs from the working directory. */
  configCwd?: string;
  /** Root session id, inherited by nested launches so transcripts stay grouped. */
  rootSessionId?: string;
  /**
   * Reuse an existing mention handle instead of allocating a fresh one. Set when
   * a resumable entry is reopened, so `@handle` keeps addressing the same
   * conversation across the eviction. Bypasses the uniqueness search on purpose:
   * the handle is already spoken for by the entry being reopened.
   */
  reclaimHandle?: string;
  /**
   * Reopen the conversation in this session file rather than starting a new
   * one. Like `reclaimHandle`, an internal capability: the value always comes
   * from a resumable entry this extension wrote, never from a tool argument or
   * an RPC payload — a forged path would let a spawn read an unrelated session.
   */
  resumeSessionFile?: string;
}

/** Internal managed-spawn policy; model and thinking are finalized by runAgent when a tier is present. */
export type ManagedSpawnPolicy = Pick<
  SpawnOptions,
  "model" | "maxTurns" | "isolated" | "inheritContext" | "thinkingLevel" | "isolation" | "invocation" | "rootSessionId" | "toolset" | "excludeTools"
> & {
  /** In-process identity of the resolved agent definition/tool allowlist for thread reuse. */
  policyFingerprint?: string;
};

interface ResumeTerminalSnapshot {
  status: AgentRecord["status"];
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

interface ResumeControl {
  controller: AbortController;
  cleanup: () => void;
  snapshot: ResumeTerminalSnapshot;
  deferred?: {
    resolve: (value: string) => void;
    reject: (error: unknown) => void;
  };
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onCreated?: OnAgentCreated;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private managedSpawns = new Map<string, ManagedSpawnTombstone>();
  private managedKeysById = new Map<string, string>();
  /** Active workflow-thread name to the managed AgentSession it re-enters. */
  private managedThreads = new Map<string, string>();
  /** Policy identity captured with each thread; policy changes cannot bypass a denylist. */
  private managedThreadPolicies = new Map<string, string>();
  /** Reservation closes the synchronous onSpawned -> same-thread re-entry window. */
  private managedThreadReservations = new Set<string>();
  private managedPersistence?: ManagedSpawnPersistence;
  private readonly managedPersistenceRetries = new Map<string, {
    tombstone: ManagedSpawnTombstone;
    attempt: number;
    timer?: ReturnType<typeof setTimeout>;
  }>();
  private maxConcurrent: number;
  /** Base repos worktrees were created from — so dispose() can prune them all,
   *  not just the parent repo (caller-supplied cwd can target other repos). */
  private worktreeRepos = new Set<string>();

  /** Queue of background agents waiting to start (spawn or resume). */
  private queue: Array<
    | { kind: "spawn"; id: string; args: SpawnArgs }
    | { kind: "resume"; id: string; start: () => void }
  > = [];
  /**
   * Resumable index: evicted top-level agents whose conversations can still be
   * reopened from disk (`@handle` reopen). Bounded; oldest evicted first.
   * Distinct from ManagedSpawnTombstone (managed-spawn idempotency).
   */
  private readonly resumable = new Map<string, ResumableAgentEntry>();
  /** Whether evicted records are indexed at all (settings: rememberAgents). */
  private rememberAgents = true;
  /** Whether spawned agents get `contact_supervisor` (settings). */
  private supervisorQuestions = true;
  /**
   * Descendants spawned so far under each top-level agent, keyed by that
   * agent's id. Cumulative for the branch's lifetime — see the budget check in
   * `spawnInternal`. Pruned with the branch's metadata.
   */
  private readonly branchSpawnCounts = new Map<string, number>();
  /** Cumulative descendants any one top-level agent may start (settings). */
  private maxSubagentSpawnsPerBranch = DEFAULT_MAX_SUBAGENT_SPAWNS_PER_BRANCH;
  /** Number of currently running background agents. */
  private runningBackground = 0;
  /** IDs that currently hold a background pool slot; guards late/double settlements. */
  private readonly heldPoolSlots = new Set<string>();
  /** Parent-signal listeners must cover queued records as well as running ones. */
  private readonly parentSignalCleanups = new Map<string, () => void>();
  /** Parent records whose descendant tree is no longer allowed to grow. */
  private readonly nestedSpawnSeals = new Set<string>();
  /** Records currently being removed; synchronous disposal callbacks fail closed. */
  private readonly removingRecords = new Set<string>();
  /** Records whose provider/session cleanup is still running after terminal status. */
  private readonly settlingRecords = new Set<string>();
  /** Active resume controller/listener and the terminal state it superseded. */
  private readonly resumeControls = new Map<string, ResumeControl>();

  /** Records whose runAgent provider/tool promise itself has not settled. */
  private readonly providerPendingRecords = new Set<string>();
  /** Terminal records whose eviction was deferred behind an owned descendant. */
  private readonly deferredRecordRemovals = new Set<string>();
  /** Child session shutdown/dispose operations started by synchronous manager APIs. */
  private readonly sessionTeardowns = new Set<Promise<void>>();
  /** Idempotent async manager disposal shared by root shutdown and callers. */
  private disposePromise?: Promise<readonly WorktreeCleanupFailure[]>;
  /** Teardown promise associated with a record that has been quarantined/evicted. */
  private readonly recordSessionTeardowns = new Map<string, Promise<void>>;
  /** Prevent late promise continuations from recreating disposed ownership metadata. */
  private disposed = false;
  /** Immutable diagnostics retained when shutdown cannot remove a worktree. */
  private worktreeCleanupFailures: readonly WorktreeCleanupFailure[] = Object.freeze([]);

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
    onCreated?: OnAgentCreated,
    managedPersistence?: ManagedSpawnPersistence,
  ) {
    this.onComplete = onComplete;
    this.onCreated = onCreated;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.managedPersistence = managedPersistence;
    this.maxConcurrent = maxConcurrent;
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /** Return the immutable cleanup failures retained by the last disposal attempt. */
  getWorktreeCleanupFailures(): readonly WorktreeCleanupFailure[] {
    return this.worktreeCleanupFailures;
  }

  /** Alias for callers that use the shorter cleanup-failure name. */
  getCleanupFailures(): readonly WorktreeCleanupFailure[] {
    return this.worktreeCleanupFailures;
  }

  private trackSessionTeardown(session: AgentSession): Promise<void> {
    const teardown = shutdownAndDisposeSession(session);
    this.sessionTeardowns.add(teardown);
    void teardown.then(
      () => this.sessionTeardowns.delete(teardown),
      () => this.sessionTeardowns.delete(teardown),
    );
    return teardown;
  }

  private trackRecordSessionTeardown(id: string, session: AgentSession): Promise<void> {
    const teardown = this.trackSessionTeardown(session);
    this.recordSessionTeardowns.set(id, teardown);
    const release = (): void => {
      if (this.recordSessionTeardowns.get(id) !== teardown) return;
      this.recordSessionTeardowns.delete(id);
      if (!this.disposed) {
        this.retryPinnedWorktreeCleanup();
        this.retryDeferredRecordRemovals();
      }
    };
    void teardown.then(release, release);
    return teardown;
  }

  private async awaitSessionTeardowns(): Promise<void> {
    while (this.sessionTeardowns.size > 0) {
      await Promise.allSettled([...this.sessionTeardowns]);
    }
  }

  private async awaitSessionTeardown(session: AgentSession | undefined): Promise<void> {
    if (!session) return;
    try {
      await this.trackSessionTeardown(session);
    } catch {
      // A broken child shutdown handler must not prevent sibling teardown.
    }
  }

  private releasePoolSlot(id: string): void {
    if (!this.heldPoolSlots.delete(id)) return;
    this.runningBackground = Math.max(0, this.runningBackground - 1);
  }

  private clearParentSignal(id: string): void {
    const cleanup = this.parentSignalCleanups.get(id);
    if (!cleanup) return;
    this.parentSignalCleanups.delete(id);
    cleanup();
  }

  /**
   * Return the reason a nested owner cannot accept another child.
   *
   * The immediate parent is the only live record used to derive a child's
   * lineage. Its immutable lineage is then checked as an ownership proof: a
   * missing, terminal, detached, removing, or sealed ancestor fails closed
   * without walking mutable parent links.
   */
  private nestedOwnerValidation(parentId: unknown): string | undefined {
    if (typeof parentId !== "string" || parentId.length === 0) return "the parent id is missing";

    const parent = this.agents.get(parentId);
    if (!parent) return `parent agent "${parentId}" is missing`;

    const ownerIds = [parent.id, ...(parent.ancestorAgentIds ?? [])];
    const seen = new Set<string>();
    for (const ownerId of ownerIds) {
      if (seen.has(ownerId)) return `the parent chain for "${ownerId}" is cyclic`;
      seen.add(ownerId);

      const record = this.agents.get(ownerId);
      if (!record) return `parent agent "${ownerId}" is missing`;
      if (this.removingRecords.has(ownerId)) return `parent agent "${ownerId}" is being removed`;
      if (this.deferredRecordRemovals.has(ownerId)) return `parent agent "${ownerId}" is pending removal`;
      if (record.detached) return `parent agent "${ownerId}" is detached`;
      if (this.nestedSpawnSeals.has(ownerId)) return `parent agent "${ownerId}" is sealed`;
      if (record.status !== "queued" && record.status !== "running") {
        return `parent agent "${ownerId}" is terminal`;
      }
    }
    return undefined;
  }

  /** Validate and return the live immediate owner before nested allocation. */
  private assertNestedOwner(parentId: unknown): AgentRecord {
    const reason = this.nestedOwnerValidation(parentId);
    if (reason) throw new Error(`Cannot spawn nested agent: ${reason}.`);
    return this.agents.get(parentId as string)!;
  }

  /** Seal one owner branch until its descendants no longer reference it. */
  private sealNestedSpawns(id: string): void {
    if (!this.disposed) this.nestedSpawnSeals.add(id);
  }

  /** Validate a nested record's ancestors before a resume can restart it. */
  private canResumeNested(record: AgentRecord): boolean {
    return !record.detached && !this.removingRecords.has(record.id) &&
      !this.settlingRecords.has(record.id) &&
      !this.deferredRecordRemovals.has(record.id) &&
      (record.parentAgentId === undefined || this.nestedOwnerValidation(record.parentAgentId) === undefined);
  }

  private clearManagedPersistenceRetry(key: string): void {
    const pending = this.managedPersistenceRetries.get(key);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.managedPersistenceRetries.delete(key);
  }

  private clearManagedPersistenceRetries(): void {
    for (const key of this.managedPersistenceRetries.keys()) this.clearManagedPersistenceRetry(key);
  }

  private scheduleManagedPersistenceRetry(tombstone: ManagedSpawnTombstone): void {
    if (this.disposed) return;
    const persistence = this.managedPersistence;
    if (!persistence) return;
    const key = tombstone.spawnKey;
    this.clearManagedPersistenceRetry(key);
    const pending = { tombstone, attempt: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    this.managedPersistenceRetries.set(key, pending);
    const attempt = (): void => {
      if (this.managedPersistenceRetries.get(key) !== pending) return;
      pending.timer = undefined;
      if (this.disposed || this.managedSpawns.get(key) !== tombstone) {
        this.managedPersistenceRetries.delete(key);
        return;
      }
      try {
        persistence.append(cloneManagedTombstone(tombstone));
        this.managedPersistenceRetries.delete(key);
      } catch (error: unknown) {
        pending.attempt += 1;
        if (pending.attempt >= MANAGED_PERSIST_RETRY_MAX_ATTEMPTS) {
          this.managedPersistenceRetries.delete(key);
          console.warn(`[pi-subagents] managed tombstone persistence retry exhausted for ${key}: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        const delay = Math.min(
          MANAGED_PERSIST_RETRY_MAX_DELAY_MS,
          MANAGED_PERSIST_RETRY_INITIAL_DELAY_MS * 2 ** Math.min(pending.attempt - 1, 6),
        );
        pending.timer = setTimeout(attempt, delay);
        pending.timer.unref?.();
      }
    };
    queueMicrotask(attempt);
  }

  private persistManaged(tombstone: ManagedSpawnTombstone, required = false): void {
    if (!this.managedPersistence) {
      if (required) throw new Error("managed spawn persistence is unavailable");
      return;
    }
    try {
      this.managedPersistence.append(cloneManagedTombstone(tombstone));
      this.clearManagedPersistenceRetry(tombstone.spawnKey);
    } catch (error: unknown) {
      if (required) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      // Terminal persistence is retried independently of the agent promise. A
      // permanently unavailable journal degrades to a warning, never a failed run.
      this.scheduleManagedPersistenceRetry(tombstone);
    }
  }

  private notifyComplete(record: AgentRecord): void {
    if (record.detached) return;
    try {
      this.onComplete?.(record);
    } catch {
      // Completion side effects must not reject the authoritative Agent promise.
    }
  }

  private replaceManagedTombstone(key: string, next: ManagedSpawnTombstone, required = false): void {
    const previous = this.managedSpawns.get(key);
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
    this.clearManagedPersistenceRetry(key);
    this.managedSpawns.set(key, next);
    this.managedKeysById.set(next.id, key);
    this.persistManaged(next, required);
  }

  private managedKeyForId(id: string): string | undefined {
    return this.managedKeysById.get(id);
  }

  private syncManagedRecord(record: AgentRecord, required = false): void {
    // A branch replacement has already persisted the stop/interrupted tombstone.
    // Never let a late AgentSession continuation append a terminal update into
    // the replacement branch.
    if (record.detached) return;
    const key = this.managedKeyForId(record.id);
    if (!key) return;
    const tombstone = this.managedSpawns.get(key);
    if (!tombstone) return;
    const terminalStatus = terminalStatusForRecord(record.status);
    const state: ManagedSpawnState = terminalStatus ?? (record.status === "queued" ? "queued" : "running");
    const compactionCount = Math.max(0, Math.floor(record.compactionCount));
    const terminal = terminalStatus
      ? {
          status: terminalStatus,
          ...(capManagedText(record.result, MANAGED_TEXT_LIMIT) ? { result: capManagedText(record.result, MANAGED_TEXT_LIMIT) } : {}),
          ...(capManagedText(record.error, MANAGED_ERROR_LIMIT) ? { error: capManagedText(record.error, MANAGED_ERROR_LIMIT) } : {}),
          ...(record.outputFile ? { outputFile: record.outputFile.slice(0, MANAGED_PATH_LIMIT) } : {}),
          ...(record.lifetimeUsage.input + record.lifetimeUsage.output > 0
            ? { tokenCount: Math.floor(record.lifetimeUsage.input + record.lifetimeUsage.output) }
            : {}),
          compactionCount,
          completedAt: record.completedAt ?? Date.now(),
        }
      : undefined;
    this.replaceManagedTombstone(key, {
      ...tombstone,
      ...(record.invocation?.tierSnapshot ? { tierSnapshot: { ...record.invocation.tierSnapshot } } : {}),
      state,
      updatedAt: Date.now(),
      compactionCount,
      ...(terminal ? { terminal } : { terminal: undefined }),
    }, required);
  }

  private settleMissingManaged(key: string): ManagedSpawnTombstone {
    const tombstone = this.managedSpawns.get(key);
    if (!tombstone) throw new Error(`managed spawn key not found: "${key}"`);
    if (isManagedTerminalState(tombstone.state) && tombstone.terminal) return tombstone;
    const now = Date.now();
    const settled: ManagedSpawnTombstone = {
      ...tombstone,
      state: "interrupted",
      updatedAt: now,
      terminal: {
        status: "interrupted",
        error: "managed agent interrupted: no live AgentSession after session reload",
        compactionCount: tombstone.compactionCount,
        completedAt: now,
      },
    };
    this.replaceManagedTombstone(key, settled);
    return settled;
  }

  private managedResult(key: string, created = false): ManagedSpawnResult {
    let tombstone = this.managedSpawns.get(key);
    if (!tombstone) throw new Error(`managed spawn key not found: "${key}"`);
    const record = this.agents.get(tombstone.id);
    if (!isManagedTerminalState(tombstone.state)) {
      if (record) {
        this.syncManagedRecord(record);
        tombstone = this.managedSpawns.get(key)!;
      } else {
        tombstone = this.settleMissingManaged(key);
      }
    }
    return {
      id: tombstone.id,
      state: tombstone.state,
      created,
      ...(tombstone.terminal ? { terminal: cloneManagedTerminal(tombstone.terminal) } : {}),
    };
  }

  /** Restore session-scoped managed idempotency entries and settle orphaned work. */
  restoreManagedSpawns(
    entries: readonly ManagedSpawnEntryLike[],
    options: { dropActive?: boolean } = {},
  ): ManagedSpawnTombstone[] {
    this.clearManagedPersistenceRetries();
    if (this.disposed) return [];
    this.managedSpawns.clear();
    this.managedKeysById.clear();
    this.managedThreads.clear();
    this.managedThreadPolicies.clear();
    this.managedThreadReservations.clear();
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== MANAGED_SPAWN_ENTRY_TYPE) continue;
      const tombstone = parseManagedTombstone(entry.data);
      if (!tombstone) continue;
      if (options.dropActive && !isManagedTerminalState(tombstone.state)) continue;
      this.managedSpawns.set(tombstone.spawnKey, tombstone);
      this.managedKeysById.set(tombstone.id, tombstone.spawnKey);
      if (tombstone.thread && tombstone.threadPolicyFingerprint) {
        const threadKey = `${tombstone.owner.runId}\u0000${tombstone.thread}`;
        this.managedThreads.set(threadKey, tombstone.id);
        this.managedThreadPolicies.set(threadKey, tombstone.threadPolicyFingerprint);
      }
    }
    const recovered: ManagedSpawnTombstone[] = [];
    for (const [key, tombstone] of this.managedSpawns) {
      if (isManagedTerminalState(tombstone.state)) continue;
      const record = this.agents.get(tombstone.id);
      if (record?.status === "queued" || record?.status === "running") {
        this.syncManagedRecord(record);
        continue;
      }
      recovered.push(cloneManagedTombstone(this.settleMissingManaged(key)));
    }
    return recovered;
  }

  getManagedSpawn(spawnKey: string): ManagedSpawnTombstone | undefined {
    const tombstone = this.managedSpawns.get(spawnKey.trim());
    return tombstone ? cloneManagedTombstone(tombstone) : undefined;
  }

  /** Reconcile a spawn whose RPC reply was lost after allocation. */
  reconcileManaged(spawnKey: string, owner: AgentOwner): ManagedSpawnResult | undefined {
    const key = spawnKey.trim();
    const tombstone = this.managedSpawns.get(key);
    if (!tombstone) return undefined;
    if (
      tombstone.owner.extension !== owner.extension ||
      tombstone.owner.runId !== owner.runId ||
      tombstone.owner.nodeId !== owner.nodeId ||
      tombstone.owner.attemptId !== owner.attemptId
    ) return undefined;
    const record = this.agents.get(tombstone.id);
    if (record && (record.status === "queued" || record.status === "running")) this.abortOwned(record.id, owner);
    return this.managedResult(key);
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    // Public/legacy spawns never receive an owner capability. The internal
    // managed path passes owner separately after validating its request.
    return this.spawnInternal(pi, ctx, type, prompt, options);
  }

  private spawnInternal(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
    owner?: AgentOwner,
    idOverride?: string,
    internalOverride?: InternalAgentConfigOverride,
  ): string {
    if (this.disposed) throw new Error("AgentManager is disposed");

    if (typeof type !== "string" || !type.trim() || type.length > 256) {
      throw new Error("Agent type must be a non-empty string of at most 256 characters");
    }
    if (typeof prompt !== "string" || prompt.length > 100_000) {
      throw new Error("Agent prompt must be a string of at most 100000 characters");
    }
    if (typeof options !== "object" || options === null) {
      throw new Error("Spawn options must be an object");
    }
    if (options.description !== undefined &&
      (typeof options.description !== "string" || options.description.length > 1_000)) {
      throw new Error("Agent description must be a string of at most 1000 characters");
    }
    // Legacy in-process callers omitted description before it became required.
    // Normalize that shape to an inert string while rejecting reference values.
    options = { ...options, description: options.description ?? type };

    for (const [label, value] of [
      ["isBackground", options.isBackground],
      ["isolated", options.isolated],
      ["inheritContext", options.inheritContext],
      ["bypassQueue", options.bypassQueue],
    ] as const) {
      if (value !== undefined && typeof value !== "boolean") {
        throw new Error(`${label} must be a boolean`);
      }
    }
    for (const [label, value] of [
      ["maxTurns", options.maxTurns],
      ["depth", options.depth],
      ["maxSubagentDepth", options.maxSubagentDepth],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error(`${label} must be a non-negative safe integer`);
      }
    }
    if (options.parentAgentId !== undefined && typeof options.parentAgentId !== "string") {
      throw new Error("parentAgentId must be a string");
    }
    if (options.rootSessionId !== undefined && typeof options.rootSessionId !== "string") {
      throw new Error("rootSessionId must be a string");
    }
    // Validate the owner capability before cwd checks, ID allocation, lifecycle
    // callbacks, queueing, or worktree creation. A missing/terminal/sealed owner
    // must fail closed without leaving any observable allocation behind.
    const nestedParent = options.parentAgentId === undefined
      ? undefined
      : this.assertNestedOwner(options.parentAgentId);
    // Never trust lineage supplied through public SpawnOptions. It is copied only
    // from the validated live immediate parent, before this record exists.
    const ancestorAgentIds = nestedParent
      ? Object.freeze([...(nestedParent.ancestorAgentIds ?? []), nestedParent.id])
      : undefined;

    // Cumulative spawn budget for the branch. The depth cap bounds how DEEP
    // nesting goes and nothing about how WIDE it gets: with nesting on by
    // default (depth 2), a single top-level agent can fan out without limit,
    // because its only cost per child is one of its own turns — and max turns
    // is commonly unlimited. This counts every descendant of a top-level agent
    // for the branch's whole lifetime, so a runaway fan-out stops at a number
    // instead of at the account's rate limit.
    //
    // Counted here rather than in the nested tool so that every path into a
    // nested spawn is covered, and counted cumulatively rather than
    // concurrently on purpose: a loop spawning one child at a time, forever, is
    // exactly the shape a concurrency limit does not catch.
    const branchRoot = ancestorAgentIds?.[0] ?? nestedParent?.id;
    if (branchRoot !== undefined) {
      const spawned = this.branchSpawnCounts.get(branchRoot) ?? 0;
      if (spawned >= this.maxSubagentSpawnsPerBranch) {
        throw new Error(
          `Nested spawn budget exhausted for this branch (${spawned}/${this.maxSubagentSpawnsPerBranch} agents). ` +
            "Complete the remaining work directly, or raise `maxSubagentSpawnsPerBranch` in subagents.json.",
        );
      }
      this.branchSpawnCounts.set(branchRoot, spawned + 1);
    }

    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    assertValidSpawnCwd(options.cwd);

    const id = idOverride ?? randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      description: options.description,
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      // Raw tri-state (not coerced to a boolean): true = background, false =
      // foreground (has an inline tool-result surface), undefined = caller never
      // declared it (e.g. a cross-extension RPC spawn). The widget's background-
      // only filter excludes only explicit `false`, so undefined agents — which
      // have no inline surface — stay visible instead of vanishing.
      isBackground: options.isBackground,
      invocation: options.invocation ? cloneFrozenData(options.invocation) : undefined,
      depth: options.depth ?? 1,
      parentAgentId: options.parentAgentId,
      ...(ancestorAgentIds ? { ancestorAgentIds } : {}),
      maxSubagentDepth: options.maxSubagentDepth,
      rootSessionId: options.rootSessionId,
      ...(owner ? { owner: Object.freeze({ ...owner }) } : {}),
    };
    // Top-level agents get a mention handle derived from their type. The name
    // space covers live records and resumable entries, so a handle is never
    // allocated twice while its conversation is still reachable.
    if (options.parentAgentId === undefined && options.reclaimHandle === undefined) {
      record.handle = assignHandle(handleBase(type), this.takenHandles());
    } else if (options.reclaimHandle !== undefined) {
      record.handle = options.reclaimHandle;
    }
    this.agents.set(id, record);
    if (!record.detached) {
      try { this.onCreated?.(record); } catch { /* observer failures cannot orphan a record */ }
      try { options.onSpawned?.(id); } catch { /* observer failures cannot orphan a record */ }
    }

    const args: SpawnArgs = { pi, ctx, type, prompt, options, internalOverride };
    // Lifecycle observers may synchronously stop or dispose a freshly allocated
    // record. Do not let the normal queue/start path resurrect that decision.
    if (this.disposed || this.agents.get(id) !== record || record.detached ||
      record.status !== (options.isBackground ? "queued" : "running")) {
      return id;
    }

    // Install the parent listener before queueing. A signal may already be
    // aborted, or may abort while this record waits for a pool slot; installing
    // it only in startAgent loses both cases.
    if (options.signal) {
      const onParentAbort = () => this.abort(id);
      const cleanup = () => options.signal!.removeEventListener("abort", onParentAbort);
      this.parentSignalCleanups.set(id, cleanup);
      if (options.signal.aborted) {
        this.clearParentSignal(id);
        record.abortController?.abort(options.signal.reason);
        record.status = "stopped";
        record.completedAt = Date.now();
        if (!record.isBackground) record.resultConsumed = true;
        this.syncManagedRecord(record);
        this.notifyComplete(record);
        return id;
      }
      options.signal.addEventListener("abort", onParentAbort, { once: true });
      if (options.signal.aborted) {
        // Close the small check/add race for custom AbortSignal
        // implementations and synchronous test doubles.
        this.abort(id);
        return id;
      }
    }

    if (occupiesPoolSlot(record) && !options.bypassQueue && this.runningBackground >= this.maxConcurrent) {
      // Queue it — will be started when a running agent completes
      this.queue.push({ kind: "spawn", id, args });
      return id;
    }

    // startAgent can throw (e.g. strict worktree-isolation failure) — clean
    // up the record so callers don't see an orphan in `listAgents()`. Use the
    // normal removal guard: a synchronously-created nested branch must not make
    // this owner disappear before its descendants are stopped.
    try {
      this.startAgent(id, record, args);
    } catch (err) {
      // startAgent may have acquired a pool slot before a synchronous runner
      // failure. Release it before removing the record so the queue cannot
      // remain permanently blocked.
      this.clearParentSignal(id);
      this.releasePoolSlot(id);
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt = Date.now();
      // A synchronous startup failure is a real terminal lifecycle outcome.
      // Publish it before eviction so managed tombstones and observers see the
      // created -> failed transition without a started event.
      this.syncManagedRecord(record);
      this.notifyComplete(record);
      this.removeRecord(id, record);
      this.drainQueue();
      throw err;
    }
    return id;
  }

  /**
   * Spawn a workflow-owned agent through the same first-class background path as
   * ordinary Agent calls. Owner metadata is supplied separately from public
   * SpawnOptions and only after this method validates the complete request.
   */
  spawnManaged(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    request: ManagedSpawnRequest,
    policy: ManagedSpawnPolicy,
    callbacks?: Pick<SpawnOptions, "onToolActivity" | "onTextDelta" | "onSessionCreated" | "onTurnEnd" | "onAssistantUsage" | "onCompaction" | "onSpawned">,
  ): ManagedSpawnResult {
    if (this.disposed) throw new Error("AgentManager is disposed");
    const normalized = normalizeManagedSpawnRequest(request);
    if (normalized.thread && (normalized.isolation === "worktree" || policy.isolation === "worktree")) {
      throw new Error("Managed workflow threads cannot use worktree isolation; use separate calls instead.");
    }
    const scope = normalized.spawnKey;
    const policyFingerprint = managedThreadPolicyFingerprint(normalized, policy);
    const fingerprint = managedFingerprint(normalized, policyFingerprint);
    const legacyFingerprint = managedLegacyFingerprintV1(normalized);
    const threadPolicyFingerprint = normalized.thread ? policyFingerprint : undefined;
    const previous = this.managedSpawns.get(scope);
    if (previous) {
      if (previous.fingerprint !== fingerprint && previous.fingerprint !== legacyFingerprint) {
        throw new Error(`Managed spawn key conflict: "${normalized.spawnKey}"`);
      }
      if (normalized.thread && previous.threadPolicyFingerprint !== threadPolicyFingerprint) {
        throw new Error(`Managed workflow thread policy conflict: "${normalized.thread}"; use a new thread name for changed model/tool policy.`);
      }
      return this.managedResult(scope);
    }

    const threadKey = normalized.thread ? `${normalized.owner.runId}\u0000${normalized.thread}` : undefined;
    if (threadKey && this.managedThreadReservations.has(threadKey)) {
      throw new Error(`Managed workflow thread "${normalized.thread}" is already running; calls must be sequential.`);
    }
    const threadedId = threadKey ? this.managedThreads.get(threadKey) : undefined;
    if (threadedId) {
      if (threadPolicyFingerprint !== undefined && this.managedThreadPolicies.get(threadKey!) !== threadPolicyFingerprint) {
        throw new Error(`Managed workflow thread policy conflict: "${normalized.thread}"; use a new thread name for changed model/tool policy.`);
      }
      const record = this.agents.get(threadedId);
      if (record?.session && record.status !== "running" && record.status !== "queued" && !record.detached) {
        const previousOwner = record.owner;
        const previousInvocation = record.invocation;
        const previousManagedKey = this.managedKeysById.get(threadedId);
        record.owner = Object.freeze({ ...normalized.owner });
        record.invocation = policy.invocation;
        const now = Date.now();
        const tombstone: ManagedSpawnTombstone = {
          schemaVersion: MANAGED_SPAWN_SCHEMA_VERSION,
          spawnKey: scope,
          fingerprint,
          id: threadedId,
          requestId: normalized.requestId,
          type: normalized.type,
          description: normalized.description,
          owner: { ...normalized.owner },
          ...(normalized.tier === undefined ? {} : { tier: normalized.tier }),
          ...(normalized.thread === undefined ? {} : { thread: normalized.thread, threadPolicyFingerprint }),
          state: "queued",
          createdAt: now,
          updatedAt: now,
          compactionCount: record.compactionCount,
        };
        this.clearManagedPersistenceRetry(scope);
        this.managedSpawns.set(scope, tombstone);
        this.managedKeysById.set(threadedId, scope);
        try {
          this.persistManaged(tombstone, true);
        } catch (error: unknown) {
          this.managedSpawns.delete(scope);
          if (previousManagedKey === undefined) this.managedKeysById.delete(threadedId);
          else this.managedKeysById.set(threadedId, previousManagedKey);
          record.owner = previousOwner;
          record.invocation = previousInvocation;
          throw error;
        }
        void this.resume(threadedId, normalized.prompt, undefined, {
          isBackground: true,
          onToolActivity: callbacks?.onToolActivity,
          onAssistantUsage: callbacks?.onAssistantUsage,
          onCompaction: callbacks?.onCompaction ? (info) => callbacks.onCompaction?.(info as CompactionInfo) : undefined,
        }).catch(() => {});
        this.syncManagedRecord(record, true);
        const resumedState = String(record.status);
        return { id: threadedId, state: resumedState === "queued" ? "queued" : "running", created: true };
      }
      if (record && !record.detached && (record.status === "running" || record.status === "queued")) {
        throw new Error(`Managed workflow thread "${normalized.thread}" is already running; calls must be sequential.`);
      }
      if (!record || record.detached || !record.session) {
        this.managedThreads.delete(threadKey!);
        this.managedThreadPolicies.delete(threadKey!);
      }
    }

    // Register and persist the immutable idempotency identity before starting
    // the session. A crash after allocation cannot cause a second AgentSession.
    const now = Date.now();
    const id = randomUUID().slice(0, 17);
    const tombstone: ManagedSpawnTombstone = {
      schemaVersion: MANAGED_SPAWN_SCHEMA_VERSION,
      spawnKey: scope,
      fingerprint,
      id,
      requestId: normalized.requestId,
      type: normalized.type,
      description: normalized.description,
      owner: { ...normalized.owner },
      ...(normalized.tier === undefined ? {} : { tier: normalized.tier }),
      ...(normalized.thread === undefined ? {} : { thread: normalized.thread, threadPolicyFingerprint }),
      state: "queued",
      createdAt: now,
      updatedAt: now,
      compactionCount: 0,
    };
    this.managedSpawns.set(scope, tombstone);
    this.managedKeysById.set(id, scope);
    if (threadKey) {
      this.managedThreads.set(threadKey, id);
      this.managedThreadPolicies.set(threadKey, threadPolicyFingerprint!);
      this.managedThreadReservations.add(threadKey);
    }
    try {
      // The allocation identity must reach the session journal before the
      // AgentSession or queue can produce side effects. A failed append rolls
      // back both maps and never invokes runAgent.
      this.persistManaged(tombstone, true);
    } catch (error: unknown) {
      this.managedSpawns.delete(scope);
      this.managedKeysById.delete(id);
      if (threadKey) {
        this.managedThreads.delete(threadKey);
        this.managedThreadPolicies.delete(threadKey);
        this.managedThreadReservations.delete(threadKey);
      }
      throw error;
    }

    try {
      this.spawnInternal(pi, ctx, normalized.type, normalized.prompt, {
        ...policy,
        ...(normalized.tier === undefined ? {} : { tier: normalized.tier }),
        ...(normalized.thread === undefined ? {} : { thread: normalized.thread }),
        description: normalized.description,
        isBackground: true,
        ...callbacks,
      }, normalized.owner, id);
    } catch (error: unknown) {
      if (threadKey) {
        this.managedThreads.delete(threadKey);
        this.managedThreadPolicies.delete(threadKey);
        this.managedThreadReservations.delete(threadKey);
      }
      const existing = this.managedSpawns.get(scope);
      if (existing?.state === "failed" && existing.terminal) return this.managedResult(scope, true);
      const completedAt = Date.now();
      this.replaceManagedTombstone(scope, {
        ...tombstone,
        state: "failed",
        updatedAt: completedAt,
        terminal: {
          status: "failed",
          error: capManagedText(error instanceof Error ? error.message : String(error), MANAGED_ERROR_LIMIT),
          compactionCount: 0,
          completedAt,
        },
      });
      return this.managedResult(scope, true);
    }

    const record = this.agents.get(id);
    if (record) this.syncManagedRecord(record);
    if (threadKey) this.managedThreadReservations.delete(threadKey);
    return this.managedResult(scope, true);
  }

  /** Forget managed idempotency keys when a logical session is replaced. */
  resetManagedSpawns(): void {
    this.clearManagedPersistenceRetries();
    this.managedSpawns.clear();
    this.managedKeysById.clear();
    this.managedThreads.clear();
    this.managedThreadPolicies.clear();
    this.managedThreadReservations.clear();
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private startAgent(id: string, record: AgentRecord, { pi, ctx, type, prompt, options, internalOverride }: SpawnArgs) {
    if (this.disposed || record.detached || this.agents.get(id) !== record) return;
    // Re-validate a caller-supplied cwd: queued spawns can start minutes after
    // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
    // curated errors; drainQueue parks a throw on the record as an error.
    assertValidSpawnCwd(options.cwd);
    // Single resolution point for the caller-supplied cwd — the worktree base
    // repo and both cleanup calls below MUST agree on this value forever.
    const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
    const baseCwd = customCwd ?? ctx.cwd;

    // Worktree isolation: try to create a temporary git worktree. Strict —
    // fail loud if not possible (no silent fallback to main tree). Done
    // BEFORE state mutation so a throw doesn't leave the record half-running.
    // "off" explicitly opts out; global switch gates "worktree" deterministically.
    let worktreeCwd: string | undefined;
    let worktreeRepoRoot: string | undefined;
    if (options.isolation === "off") {
      // Explicit opt-out — no worktree, no check.
    } else if (options.isolation === "worktree") {
      if (!isWorktreeIsolationEnabled()) {
        throw new Error('Cannot run with isolation: "worktree" — worktree isolation is disabled in project settings. Enable it or omit `isolation`.');
      }
      const wt = createWorktree(baseCwd, id);
      if (!wt) {
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
            'Initialize git and commit at least once, or omit `isolation`.',
        );
      }
      record.worktree = wt;
      worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
      worktreeRepoRoot = wt.repoRoot;
      this.worktreeRepos.add(wt.repoRoot);
    }

    record.status = "running";
    record.startedAt = Date.now();
    if (occupiesPoolSlot(record)) {
      this.heldPoolSlots.add(record.id);
      this.runningBackground++;
    }
    if (!record.detached) {
      try { this.onStart?.(record); } catch { /* lifecycle observers are best effort */ }
    }
    // `onStart` can synchronously stop the record (for example, an owner-scoped
    // stop arriving from a lifecycle observer). Do not invoke the runner after
    // that decision, and release the slot acquired above.
    if (this.disposed || record.detached || this.agents.get(id) !== record || record.status !== "running") {
      this.clearParentSignal(id);
      this.releasePoolSlot(id);
      if (record.worktree) {
        this.cleanupRecordWorktree(record, worktreeRepoRoot ?? baseCwd, options.description);
      }
      return;
    }
    this.syncManagedRecord(record);

    // The parent listener was installed before queueing so queued records also
    // stop promptly. Starting a queued record does not need a second listener.
    const detach = () => this.clearParentSignal(id);
    this.settlingRecords.add(id);

    this.providerPendingRecords.add(id);

    let rawPromise: ReturnType<typeof runAgent>;
    try {
      rawPromise = runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: internalOverride?.isolated ?? options.isolated,
      inheritContext: internalOverride?.inheritContext ?? options.inheritContext,
      ...(internalOverride ? { [INTERNAL_AGENT_CONFIG_OVERRIDE]: internalOverride } : {}),
      thinkingLevel: options.thinkingLevel,
      tier: options.tier,
      agentTier: options.agentTier,
      // Worktree wins for the working dir (the agent must run in the copy —
      // which, with a custom cwd, was created from that target). Config stays
      // with the parent project when a caller-supplied cwd is in play; it must
      // stay undefined otherwise so plain worktree runs keep resolving config
      // (incl. relative extension paths and memory) inside the worktree copy.
      cwd: worktreeCwd ?? customCwd,
      // Preserve the original repository top-level separately from the
      // worktree cwd so the child prompt can mark the whole base checkout
      // off-limits, even when the invocation started in a subdirectory.
      worktreeBase: worktreeRepoRoot,
      configCwd: options.configCwd ?? (customCwd !== undefined ? ctx.cwd : undefined),
      // Top-level conversations persist by default so `@handle` has something
      // to reopen after the record is evicted; frontmatter still overrides.
      rememberAgents: this.rememberAgents,
      supervisorQuestions: this.supervisorQuestions,
      resumeSessionFile: options.resumeSessionFile,
      toolset: options.toolset,
      excludeTools: options.excludeTools,
      thread: options.thread,
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        if (record.detached) return;
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTurnEnd: (turnCount) => {
        if (!record.detached) options.onTurnEnd?.(turnCount);
      },
      onTextDelta: (delta, fullText) => {
        if (!record.detached) options.onTextDelta?.(delta, fullText);
      },
      onAssistantUsage: (usage) => {
        if (record.detached) return;
        addUsage(record.lifetimeUsage, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        if (record.detached) return;
        record.compactionCount++;
        this.syncManagedRecord(record);
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      nestedRuntime: {
        manager: this,
        parentAgentId: id,
        depth: record.depth ?? 1,
        maxSubagentDepth: record.maxSubagentDepth,
      },
      onTierResolved: (snapshot) => {
        if (!record.detached) {
          record.invocation = {
            ...(record.invocation ?? {}),
            ...(options.tier === undefined ? {} : { tier: options.tier }),
            thinking: snapshot.thinking,
            tierSnapshot: { ...snapshot },
          };
          this.syncManagedRecord(record, true);
          options.onTierResolved?.(snapshot);
        }
      },
      // Recorded on the same record as the workflow snapshot but under its own
      // field, so a run can carry both without either overwriting the other's
      // account of how its model was chosen.
      onAgentTierResolved: (snapshot) => {
        if (!record.detached) {
          record.invocation = {
            ...(record.invocation ?? {}),
            agentTier: snapshot.tier,
            thinking: snapshot.thinking,
            agentTierSnapshot: { ...snapshot },
          };
          this.syncManagedRecord(record, true);
          options.onAgentTierResolved?.(snapshot);
        }
      },
      onSessionCreated: (session) => {
        if (record.detached) {
          this.trackRecordSessionTeardown(id, session);
          return;
        }
        record.session = session;
        // Capture the persisted session file so an evicted record can be
        // reopened as a resumable entry (@handle reopen).
        record.sessionFile = session.sessionManager?.getSessionFile?.() ?? (session as { sessionFile?: string })?.sessionFile;
        // Flush any steers that arrived before the session was ready
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            session.steer(msg).catch(() => {});
          }
          record.pendingSteers = undefined;
        }
        options.onSessionCreated?.(session);
      },
      });
    } catch (error) {
      this.settlingRecords.delete(id);

      this.providerPendingRecords.delete(id);
      detach();
      let sessionTeardown: Promise<void> | undefined;
      if (record.session) {
        sessionTeardown = this.trackRecordSessionTeardown(id, record.session);
        record.session = undefined;
      }
      const cleanupFailedStartWorktree = (): void => {
        if (this.disposed || !record.worktree) return;
        this.cleanupRecordWorktree(record, worktreeRepoRoot ?? baseCwd, options.description);
        this.retryDeferredRecordRemovals();
      };
      if (sessionTeardown) void sessionTeardown.then(cleanupFailedStartWorktree, cleanupFailedStartWorktree);
      else cleanupFailedStartWorktree();
      throw error;
    }

    const providerPromise = rawPromise.finally(() => {
      this.providerPendingRecords.delete(id);
    });
    const promise = providerPromise
      .then(async ({ responseText, session, aborted, steered, failure }) => {
        const detached = record.detached;
        if (detached && this.disposed) {
          await this.awaitSessionTeardown(session);
          return responseText;
        }
        // Don't overwrite status if externally stopped via abort(). Detached
        // records are quarantined from all observable result/session state.
        if (!detached && record.status !== "stopped") {
          // Precedence: a hard abort keeps "aborted"; then a failed final turn
          // (provider error that pi resolved instead of rejecting, #144) is an
          // honest "error" — not a completion with an empty or stale result.
          if (aborted) {
            record.status = "aborted";
          } else if (failure) {
            record.status = "error";
            record.error = failure;
          } else {
            record.status = steered ? "steered" : "completed";
          }
        }
        record.completedAt ??= Date.now();
        detach();

        // Final flush of streaming output file
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        if (detached) {
          await this.abortOwnedChildren(id);
          await this.awaitSessionTeardown(session);
          this.cleanupDetachedWorktree(record);
          if (record.session === session) record.session = undefined;
          if (options.isBackground) {
            this.releasePoolSlot(record.id);
            this.drainQueue();
          }
          return responseText;
        }

        // Publish the terminal output and session synchronously with the terminal
        // state. Descendant quiescence and worktree cleanup may await after this
        // block, but get_subagent_result must never observe a terminal record with
        // undefined output or session.
        record.result = responseText;
        record.session = session;
        record.sessionFile = session.sessionManager?.getSessionFile?.() ?? (session as { sessionFile?: string })?.sessionFile;
        this.syncManagedRecord(record);

        // Quiesce descendants before removing the parent's worktree. A nested
        // worktree's repoRoot is the parent's worktree path.
        await this.abortOwnedChildren(id);
        if (record.detached) {
          await this.awaitSessionTeardown(session);
          this.cleanupDetachedWorktree(record);
          if (record.session === session) record.session = undefined;
          if (options.isBackground) {
            this.releasePoolSlot(record.id);
            this.drainQueue();
          }
          return responseText;
        }

        let worktreeResult: WorktreeCleanupResult | undefined;
        if (record.worktree) {
          worktreeResult = this.hasIncompleteRepoDependency(record)
            ? this.blockedWorktreeCleanup(record)
            : this.cleanupRecordWorktree(record, worktreeRepoRoot ?? baseCwd, options.description);
        }
        if (worktreeResult?.hasChanges && worktreeResult.branch) {
          // With a caller-supplied cwd the branch lives in THAT repo, not the
          // parent session's — say so, or the orchestrator merges in the wrong repo.
          const repoNote = worktreeRepoRoot ? ` in \`${worktreeRepoRoot}\`` : "";
          record.result +=
            `\n\n---\nChanges saved to branch \`${worktreeResult.branch}\`${repoNote}. Merge with: \`git merge ${worktreeResult.branch}\`${worktreeRepoRoot ? ` (run in \`${worktreeRepoRoot}\`)` : ""}`;
        }
        if (worktreeResult && !worktreeResult.cleanupSucceeded) {
          record.result +=
            `\n\n---\nWorktree cleanup was not confirmed for \`${worktreeResult.path ?? record.worktree?.path ?? "unknown"}\`. ` +
            `${worktreeResult.cleanupDiagnostic ?? "The worktree may still exist."} ` +
            `Recovery: ${(worktreeResult.recoveryCommands ?? []).join(" && ")}`;
        }
        this.syncManagedRecord(record);

        // Fire onComplete for foreground agents too — lifecycle symmetry.
        // Mark resultConsumed so the callback skips notifications (result returned inline).
        if (!options.isBackground) {
          record.resultConsumed = true;
          this.notifyComplete(record);
        } else {
          this.releasePoolSlot(record.id);
          this.notifyComplete(record);
          this.drainQueue();
        }
        return responseText;
      })
      .catch(async (err) => {
        const detached = record.detached;
        if (detached && this.disposed) {
          await this.awaitSessionTeardown(record.session);
          return "";
        }
        // Detached records retain their pre-quiescence terminal state; a late
        // provider error must not publish stale-branch error text.
        if (!detached) {
          // Don't overwrite status if externally stopped via abort()
          if (record.status !== "stopped") {
            record.status = "error";
          }
          record.error = err instanceof Error ? err.message : String(err);
        }
        record.completedAt ??= Date.now();

        detach();

        // Final flush of streaming output file on error
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Publish terminal managed state before awaiting descendants.
        if (!detached) this.syncManagedRecord(record);

        await this.abortOwnedChildren(id);
        if (record.detached) {
          await this.awaitSessionTeardown(record.session);
          this.cleanupDetachedWorktree(record);
          if (options.isBackground) {
            this.releasePoolSlot(record.id);
            this.drainQueue();
          }
          return "";
        }

        if (record.worktree && !this.hasIncompleteRepoDependency(record)) {
          this.cleanupRecordWorktree(record, worktreeRepoRoot ?? baseCwd, options.description);
        }

        if (record.detached) {
          await this.awaitSessionTeardown(record.session);
          this.cleanupDetachedWorktree(record);
          if (options.isBackground) {
            this.releasePoolSlot(record.id);
            this.drainQueue();
          }
          return "";
        }
        this.syncManagedRecord(record);

        // Fire onComplete for foreground agents too — lifecycle symmetry.
        // Mark resultConsumed so the callback skips notifications (result returned inline).
        if (!options.isBackground) {
          record.resultConsumed = true;
          this.notifyComplete(record);
        } else {
          this.releasePoolSlot(record.id);
          this.notifyComplete(record);
          this.drainQueue();
        }
        return "";
      })
      .finally(() => {
        this.settlingRecords.delete(id);
        if (!this.disposed) {
          this.retryPinnedWorktreeCleanup();
          this.retryDeferredRecordRemovals();
        }
      });

    record.promise = promise;

    // Notify caller that spawn is complete (record is in the map, promise is set).
    // Called synchronously — onSessionCreated fires asynchronously inside runAgent.
    // Used by spawnAndWait to set up output files before streaming starts.
    if (!this.agents.get(id)?.detached) {
      try { this.onSpawned?.(id); } catch { /* observer failures cannot reject the run */ }
    }
  }

  /**
   * Stop and quiesce the descendants a settled parent owns. Nested records are
   * hidden from the UI and only their owner can consume them, so a child
   * outliving its parent would burn tokens unseen with no way to reach it.
   *
   * The full descendant set is aborted up front so a child waiting on a
   * grandchild cannot make the parent wait on a still-running grandchild. The
   * normal settlement path cleans worktrees deepest-first through the promise
   * chain; if a provider ignores abort, timed-out records are detached and
   * their worktrees are force-cleaned here while the parent's repoRoot remains.
   */
  private async abortOwnedChildren(parentId: string): Promise<void> {
    if (this.disposed) return;

    // This is deliberately the first operation. JavaScript cannot interleave a
    // spawn between this synchronous seal and the discovery walk: a spawn either
    // committed before the seal and is discovered below, or observes the seal and
    // is rejected before it can allocate a record/worktree.
    this.sealNestedSpawns(parentId);

    // Direct parent links are only an optimization for live records. Immutable
    // lineage is authoritative, so a grandchild remains discoverable after its
    // intermediate owner has been evicted.
    const descendants = this.descendantsOf(parentId)
      .sort((left, right) => this.recordDepth(right) - this.recordDepth(left));
    for (const record of descendants) this.sealNestedSpawns(record.id);

    const active = descendants.filter((record) => !this.isFullyCleaned(record));
    for (const record of active) this.abortRecord(record.id, false);
    this.drainQueue();

    const quiesced = active.length > 0
      ? await this.waitForTerminalRecords(active, OWNED_CHILD_QUIESCE_TIMEOUT_MS)
      : { settled: true, pending: [] as string[] };
    if (quiesced.pending.length === 0) {
      this.retryDeferredRecordRemovals();
      return;
    }

    // waitForTerminalRecords quarantines and cleans every timed-out descendant
    // deepest-first before returning, so the parent's worktree can be removed
    // safely by its own settlement path.
    this.retryDeferredRecordRemovals();
  }

  /** Start queued agents up to the concurrency limit. */
  private drainQueue() {
    if (this.disposed) {
      this.queue = [];
      return;
    }
    while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
      const next = this.queue.shift()!;
      const record = this.agents.get(next.id);
      if (record?.status !== "queued") continue;
      // A queued nested record can survive only while its immutable owner branch
      // remains live. Never start one whose owner was sealed/removed while it
      // waited in the queue.
      if (record.parentAgentId !== undefined && this.nestedOwnerValidation(record.parentAgentId) !== undefined) {
        this.abortRecord(record.id, false);
        continue;
      }
      if (record.detached) {
        record.status = "stopped";
        record.completedAt ??= Date.now();
        this.clearParentSignal(record.id);
        this.releasePoolSlot(record.id);
        continue;
      }
      if (next.kind === "resume") {
        try {
          next.start();
        } catch (err) {
          record.status = "error";
          record.error = err instanceof Error ? err.message : String(err);
          record.completedAt = Date.now();
          this.clearParentSignal(record.id);
          this.releasePoolSlot(record.id);
          this.syncManagedRecord(record);
          this.notifyComplete(record);
        }
        continue;
      }
      try {
        this.startAgent(next.id, record, next.args);
      } catch (err) {
        // Late failure (e.g. strict worktree-isolation) — surface on the record
        // so the user/agent can see it via /agents, then keep draining.
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
        this.clearParentSignal(record.id);
        this.releasePoolSlot(record.id);
        this.syncManagedRecord(record);
        this.notifyComplete(record)
      }
    }
  }

  /**
   * Called synchronously right after spawn, before onSessionCreated fires.
   * Lets the caller set up the output file path on the record.
   * The record is guaranteed to be in this.agents at this point.
   */
  private onSpawned?: (id: string) => void;

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Foreground agents bypass the concurrency queue.
   * Returns { id, record } so callers can access the agent ID.
   *
   * @param onSpawned - Called synchronously after spawn(), before onSessionCreated fires.
   *   Use this to set record.outputFile so streamToOutputFile can pick it up.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }> {
    return this.spawnAndWaitCore(pi, ctx, type, prompt, options, onSpawned);
  }

  /**
   * Package-internal foreground spawn for trusted generation tasks. The
   * symbol-keyed override never enters public Agent or managed-RPC options.
   */
  async spawnAndWaitInternal(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
    internalOverride: InternalAgentConfigOverride,
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }> {
    return this.spawnAndWaitCore(
      pi,
      ctx,
      type,
      prompt,
      { ...options, isolated: true, isolation: undefined, inheritContext: false },
      onSpawned,
      internalOverride,
    );
  }

  private async spawnAndWaitCore(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
    internalOverride?: InternalAgentConfigOverride,
  ): Promise<{ id: string; record: AgentRecord }> {
    // Temporarily register the onSpawned hook so startAgent can call it.
    const prevOnSpawned = this.onSpawned;
    this.onSpawned = onSpawned;
    let id: string;
    try {
      // spawnInternal invokes onSpawned synchronously before returning. Restore
      // the shared hook immediately so unrelated concurrent spawns cannot
      // inherit this foreground caller's callback while its run is awaited.
      id = this.spawnInternal(
        pi,
        ctx,
        type,
        prompt,
        { ...options, isBackground: false },
        undefined,
        undefined,
        internalOverride,
      );
    } finally {
      this.onSpawned = prevOnSpawned;
    }
    const record = this.agents.get(id)!;
    await record.promise;
    return { id, record };
  }

  private resumeSnapshot(record: AgentRecord): ResumeTerminalSnapshot {
    return {
      status: record.status,
      startedAt: record.startedAt,
      ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
      ...(record.result === undefined ? {} : { result: record.result }),
      ...(record.error === undefined ? {} : { error: record.error }),
    };
  }

  private restoreResumeSnapshot(record: AgentRecord, snapshot: ResumeTerminalSnapshot): void {
    record.status = snapshot.status;
    record.startedAt = snapshot.startedAt;
    record.completedAt = snapshot.completedAt;
    record.result = snapshot.result;
    record.error = snapshot.error;
  }

  private beginResumeControl(
    id: string,
    record: AgentRecord,
    signal: AbortSignal | undefined,
    snapshot: ResumeTerminalSnapshot,
    deferred?: ResumeControl["deferred"],
  ): ResumeControl {
    const controller = new AbortController();
    let control!: ResumeControl;
    const onAbort = (): void => {
      controller.abort(signal?.reason);
      if (record.status === "queued" || record.status === "running") this.abort(id);
    };
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
      if (this.resumeControls.get(id) === control) this.resumeControls.delete(id);
      if (record.abortController === controller) record.abortController = undefined;
    };
    control = { controller, cleanup, snapshot, ...(deferred ? { deferred } : {}) };
    this.resumeControls.set(id, control);
    record.abortController = controller;
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
    return control;
  }

  private cancelResumeControl(id: string): void {
    const control = this.resumeControls.get(id);
    if (!control) return;
    control.controller.abort();
    control.cleanup();
    control.deferred?.resolve("");
  }

  /**
   * Resume an existing agent session with a new prompt.
   */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
    options?: {
      isBackground?: boolean;
      onToolActivity?: (activity: { type: "start" | "end"; toolName: string }) => void;
      onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
      onCompaction?: (info: unknown) => void;
      /** Called once a queued background resume has acquired its run slot. */
      onStarted?: () => void;
    },
  ): Promise<AgentRecord | undefined> {
    if (this.disposed) return undefined;
    const record = this.agents.get(id);
    if (!record) return undefined;
    if (!this.canResumeNested(record)) return undefined;
    if (signal?.aborted) return record;
    if (this.resumeControls.has(id) || record.status === "running" || record.status === "queued") return undefined;
    if (!record.session) return undefined;

    const snapshot = this.resumeSnapshot(record);
    if (options?.isBackground) {
      // A background resume is one lifecycle, including time spent queued. Keep
      // a promise on the record for quiesce/waitForAll instead of the completed
      // promise from the original spawn.
      let resolveResume!: (value: string) => void;
      let rejectResume!: (error: unknown) => void;
      const lifecyclePromise = new Promise<string>((resolve, reject) => {
        resolveResume = resolve;
        rejectResume = reject;
      });
      const control = this.beginResumeControl(id, record, signal, snapshot, {
        resolve: resolveResume,
        reject: rejectResume,
      });
      record.isBackground = true;
      record.resultConsumed = false;
      record.result = undefined;
      record.error = undefined;
      record.completedAt = undefined;
      record.status = "queued";
      record.promise = lifecyclePromise;

      const start = (): void => {
        const execution = this.startResume(id, record, prompt, control, options);
        record.promise = execution;
        void execution
          .then(resolveResume, rejectResume)
          .catch(() => {});
      };
      if (occupiesPoolSlot(record) && this.runningBackground >= this.maxConcurrent) {
        this.queue.push({ kind: "resume", id, start });
      } else {
        start();
      }
      return record;
    }

    this.settlingRecords.add(id);
    const control = this.beginResumeControl(id, record, signal, snapshot);
    record.status = "running";
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;
    try {
      const { text, failure } = await resumeAgent(record.session, prompt, {
        onToolActivity: (activity) => {
          if (!record.detached && activity.type === "end") record.toolUses++;
        },
        onAssistantUsage: (usage) => {
          if (!record.detached) addUsage(record.lifetimeUsage, usage);
        },
        onCompaction: (info) => {
          if (record.detached) return;
          record.compactionCount++;
          this.syncManagedRecord(record);
          this.onCompact?.(record, info);
        },
        signal: control.controller.signal,
      });
      if (!record.detached && !control.controller.signal.aborted && (record.status as AgentRecord["status"]) !== "stopped") {
        record.status = failure ? "error" : "completed";
        if (failure) record.error = failure;
        record.result = text;
        record.completedAt = Date.now();
      }
    } catch (err) {
      if (!record.detached && (record.status as AgentRecord["status"]) !== "stopped") {
        record.status = control.controller.signal.aborted ? "stopped" : "error";
        if (record.status === "error") record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
      }
    } finally {
      if (record.detached) this.restoreResumeSnapshot(record, snapshot);
      control.cleanup();
      this.settlingRecords.delete(id);
      this.retryDeferredRecordRemovals();
    }

    if (record.detached) return undefined;
    this.syncManagedRecord(record);
    await this.abortOwnedChildren(id);
    if (record.detached) {
      this.restoreResumeSnapshot(record, snapshot);
      this.retryDeferredRecordRemovals();
      return undefined;
    }
    this.retryDeferredRecordRemovals();
    return record;
  }

  /**
   * Run a background resume to completion. Mirrors the foreground resume's
   * settle contract (including nested-ownership, detach, and deferred-removal
   * handling) but acquires a pool slot and notifies on completion like a
   * background spawn. Called directly or from the queue drain.
   */
  private async startResume(
    id: string,
    record: AgentRecord,
    prompt: string,
    control: ResumeControl,
    options?: {
      isBackground?: boolean;
      onToolActivity?: (activity: { type: "start" | "end"; toolName: string }) => void;
      onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
      onCompaction?: (info: unknown) => void;
      /** Called once a queued background resume has acquired its run slot. */
      onStarted?: () => void;
    },
  ): Promise<string> {
    const snapshot = control.snapshot;
    let slotHeld = false;
    try {
      if (this.disposed || record.detached || this.agents.get(id) !== record) {
        if (record.detached) this.restoreResumeSnapshot(record, snapshot);
        return "";
      }
      if (!this.canResumeNested(record)) {
        record.status = "error";
        record.error = "owner branch is no longer resumable";
        record.completedAt = Date.now();
        this.syncManagedRecord(record);
        this.notifyComplete(record);
        return "";
      }
      this.settlingRecords.add(id);
      if (occupiesPoolSlot(record)) {
        this.heldPoolSlots.add(id);
        this.runningBackground++;
        slotHeld = true;
      }
      record.status = "running";
      record.startedAt = Date.now();
      record.completedAt = undefined;
      record.result = undefined;
      record.error = undefined;
      this.syncManagedRecord(record);
      try {
        options?.onStarted?.();
      } catch {
        // Observability hooks must not prevent the resumed agent from running.
      }

      // A queued background resume reuses an existing session, so messages
      // sent while it waits must be flushed here rather than through the
      // session's idle steering queue. Otherwise cancelling this queued run
      // would leave those messages behind for a later resume.
      const pendingSteers = record.pendingSteers;
      record.pendingSteers = undefined;
      if (pendingSteers?.length) {
        for (const message of pendingSteers) {
          if (control.controller.signal.aborted) break;
          try {
            await record.session!.steer(message);
          } catch {
            // A malformed or stale queued message must not prevent the resume.
          }
        }
      }

      try {
        const { text, failure } = await resumeAgent(record.session!, prompt, {
          onToolActivity: (activity) => {
            if (!record.detached && activity.type === "end") record.toolUses++;
            options?.onToolActivity?.(activity);
          },
          onAssistantUsage: (usage) => {
            if (!record.detached) addUsage(record.lifetimeUsage, usage);
            options?.onAssistantUsage?.(usage);
          },
          onCompaction: (info) => {
            if (record.detached) return;
            record.compactionCount++;
            this.syncManagedRecord(record);
            this.onCompact?.(record, info);
            options?.onCompaction?.(info);
          },
          signal: control.controller.signal,
        });
        if (!record.detached && !control.controller.signal.aborted && (record.status as AgentRecord["status"]) !== "stopped") {
          record.status = failure ? "error" : "completed";
          if (failure) record.error = failure;
          record.result = text;
          record.completedAt = Date.now();
        }
      } catch (err) {
        if (!record.detached && (record.status as AgentRecord["status"]) !== "stopped") {
          record.status = control.controller.signal.aborted ? "stopped" : "error";
          if (record.status === "error") record.error = err instanceof Error ? err.message : String(err);
          record.completedAt = Date.now();
        }
      }

      if (record.detached) {
        this.restoreResumeSnapshot(record, snapshot);
        return "";
      }
      this.syncManagedRecord(record);
      await this.abortOwnedChildren(id);
      if (record.detached) {
        this.restoreResumeSnapshot(record, snapshot);
        return "";
      }
      this.notifyComplete(record);
      return record.result ?? "";
    } finally {
      control.cleanup();
      this.settlingRecords.delete(id);
      if (slotHeld) this.releasePoolSlot(id);
      this.retryDeferredRecordRemovals();
      this.drainQueue();
    }
  }

  /**
   * Send a steering message to an agent from the UI (mirrors the steer_subagent
   * tool). A running session delivers it now — it interrupts the agent after
   * its current tool execution and appears as a user message. Queued runs keep
   * it on `pendingSteers` until their run actually starts, including background
   * resumes that already have an old session attached. Returns false if the
   * agent can't accept steering (unknown id, or no longer running/queued).
   */
  steer(id: string, message: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "queued") return false;
    // A queued background resume already has its old session attached. Keep
    // messages in the manager until that resume actually starts; putting them
    // into AgentSession's idle queue would survive cancellation into a future
    // resume of the same conversation.
    if (record.status === "queued" || !record.session) {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
    } else {
      record.session.steer(message).catch(() => {});
    }
    return true;
  }

/**
   * Return an immutable observation snapshot. Internal manager/index code must
   * use `getRecordMutable()` when it needs to update authoritative state.
   */
  getRecord(id: string): AgentRecordSnapshot | undefined {
    const record = this.agents.get(id);
    return record ? snapshotAgentRecord(record) : undefined;
  }

  /**
   * Internal mutable lookup. This is intentionally not included in the
   * cross-extension registry; callers outside the manager implementation must
   * use `getRecord()` and receive a fresh frozen snapshot instead.
   */
  getRecordMutable(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }


  /** Internal live list for this extension's UI and lifecycle wiring. */
  listAgentsMutable(): AgentRecord[] {
    return [...this.agents.values()]
      .filter((record) => !record.detached)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  listAgents(): AgentRecordSnapshot[] {
    return this.listAgentsMutable().map(snapshotAgentRecord);
  }

  /** Stop one record without traversing its ownership branch. */
  private abortRecord(id: string, drain = true): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    const resumeControl = this.resumeControls.get(id);

    // Remove from queue if queued.
    if (record.status === "queued") {
      this.queue = this.queue.filter(q => q.id !== id);
      record.status = "stopped";
      record.completedAt = Date.now();
      this.clearParentSignal(record.id);
      resumeControl?.controller.abort();
      resumeControl?.cleanup();
      resumeControl?.deferred?.resolve("");
      // Do not let chat messages queued for a cancelled queued run leak into
      // the session when the same agent is resumed later.
      record.pendingSteers = undefined;
      this.syncManagedRecord(record);
      // Queued agents have no run promise yet. Still use the normal terminal
      // callback so lifecycle consumers (including workflow waits) cannot hang.
      try { this.notifyComplete(record) } catch { /* ignore side-effect errors */ }
      if (drain) this.drainQueue();
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    this.clearParentSignal(record.id);
    if (!record.promise) this.releasePoolSlot(record.id);
    this.syncManagedRecord(record);
    return true;
  }

  /**
   * Stop a record and every known descendant synchronously. The immutable
   * lineage makes this safe even when an intermediate owner has already been
   * removed; async provider settlement and worktree cleanup continue later.
   */
  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    const descendants = this.descendantsOf(id);
    const hasActiveDescendant = descendants.some((child) => !this.isFullyCleaned(child));
    const isActive = record.status === "queued" || record.status === "running";
    if (!isActive && !hasActiveDescendant) return false;

    // Seal before any abort callback can synchronously ask a descendant to grow.
    this.sealNestedSpawns(id);
    for (const child of descendants) this.sealNestedSpawns(child.id);

    const stopped = this.abortRecord(id, false);
    for (const child of descendants) this.abortRecord(child.id, false);
    this.drainQueue();
    this.retryDeferredRecordRemovals();
    return stopped || hasActiveDescendant;
  }

  /** Stop only the exact workflow-owned attempt identified by its owner. */
  abortOwned(id: string, owner: AgentOwner): boolean {
    const record = this.agents.get(id);
    if (!record || record.parentAgentId || !record.owner) return false;
    if (
      record.owner.extension !== owner.extension ||
      record.owner.runId !== owner.runId ||
      record.owner.nodeId !== owner.nodeId ||
      record.owner.attemptId !== owner.attemptId
    ) {
      return false;
    }
    return this.abort(id);
  }

  private descendantsOf(rootId: string): AgentRecord[] {
    return [...this.agents.values()]
      .filter((record) => record.id !== rootId && record.ancestorAgentIds?.includes(rootId) === true);
  }

  private hasIncompleteRepoDependency(record: AgentRecord): boolean {
    const worktreePath = record.worktree?.path;
    if (!worktreePath) return false;
    return this.descendantsOf(record.id).some((child) =>
      !this.isFullyCleaned(child) &&
      // Isolated children depend on the checkout they were created from. A
      // non-isolated nested child has no worktree record and may execute in any
      // ancestor checkout, so retaining the ancestor is the fail-closed choice.
      ((child.worktree !== undefined && sameFilesystemPath(child.worktree.repoRoot, worktreePath)) ||
        child.worktree === undefined),
    );
  }

  private blockedWorktreeCleanup(record: AgentRecord, diagnostic?: string): WorktreeCleanupResult | undefined {
    const worktree = record.worktree;
    if (!worktree) return undefined;
    const dependent = this.descendantsOf(record.id).find((child) =>
      !this.isFullyCleaned(child) &&
      ((child.worktree !== undefined && sameFilesystemPath(child.worktree.repoRoot, worktree.path)) ||
        child.worktree === undefined),
    );
    const result: WorktreeCleanupResult = {
      hasChanges: false,
      path: worktree.path,
      cleanupSucceeded: false,
      cleanupDiagnostic: diagnostic ?? `Worktree cleanup is pinned because descendant ${dependent?.id ?? "agent"} still depends on ${worktree.path}`,
      recoveryCommands: worktreeRecoveryCommands(worktree.repoRoot, worktree.path),
    };
    record.worktreeResult = result;
    return result;
  }

  private isFullyCleaned(record: AgentRecord): boolean {
    // A quarantined record remains non-quiescent until its provider promise,
    // worktree cleanup, transcript cleanup, and session teardown all finish.
    // Terminal status alone is never proof that the branch is safe to replace.
    return record.status !== "queued" && record.status !== "running" &&
      !this.settlingRecords.has(record.id) &&
      !this.recordSessionTeardowns.has(record.id) &&
      record.worktree === undefined && record.outputCleanup === undefined;
  }

  private abortDescendantsSynchronously(rootId: string): void {
    const descendants = this.descendantsOf(rootId)
      .sort((left, right) => this.recordDepth(right) - this.recordDepth(left));
    for (const child of descendants) this.sealNestedSpawns(child.id);
    for (const child of descendants) this.abortRecord(child.id, false);
    this.drainQueue();
  }

  private pruneNestedMetadata(): void {
    if (this.disposed) return;
    for (const id of this.nestedSpawnSeals) {
      if (this.removingRecords.has(id) || this.agents.has(id)) continue;
      const stillReferenced = [...this.agents.values()].some((record) =>
        record.ancestorAgentIds?.includes(id) === true,
      );
      if (!stillReferenced) this.nestedSpawnSeals.delete(id);
    }
    // Branch spawn budgets outlive their descendants on purpose — the count is
    // cumulative for the branch's life, so it must survive children being
    // evicted, or a slow loop would reset its own budget. It is dropped only
    // once the root itself is gone and nothing still descends from it.
    for (const rootId of this.branchSpawnCounts.keys()) {
      if (this.agents.has(rootId) || this.removingRecords.has(rootId)) continue;
      const stillReferenced = [...this.agents.values()].some(
        (record) => record.ancestorAgentIds?.includes(rootId) === true,
      );
      if (!stillReferenced) this.branchSpawnCounts.delete(rootId);
    }
  }
  private retryPinnedWorktreeCleanup(): void {
    if (this.disposed) return;
    const records = [...this.agents.values()]
      .filter((record) =>
        record.status !== "queued" && record.status !== "running" &&
        record.worktree &&
        !this.recordSessionTeardowns.has(record.id) &&
        !this.settlingRecords.has(record.id),
      )
      .sort((left, right) => this.recordDepth(right) - this.recordDepth(left));
    for (const record of records) {
      if (this.hasIncompleteRepoDependency(record)) this.blockedWorktreeCleanup(record);
      else this.cleanupDetachedWorktree(record);
    }
  }


  private retryDeferredRecordRemovals(): void {
    if (this.disposed || this.deferredRecordRemovals.size === 0) {
      this.pruneNestedMetadata();
      return;
    }
    let removed = true;
    while (removed) {
      removed = false;
      for (const id of [...this.deferredRecordRemovals]) {
        const record = this.agents.get(id);
        if (!record) {
          this.deferredRecordRemovals.delete(id);
          continue;
        }
        if (this.removeRecord(id, record)) removed = true;
      }
    }
    this.pruneNestedMetadata();
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): boolean {
    if (this.agents.get(id) !== record) {
      this.deferredRecordRemovals.delete(id);
      this.pruneNestedMetadata();
      return false;
    }

    // Seal before disposal: a session.dispose() implementation may synchronously
    // invoke extension callbacks, and those callbacks must not reopen this owner.
    this.sealNestedSpawns(id);
    this.abortDescendantsSynchronously(id);
    const blockedByDescendant = this.descendantsOf(id).some((child) => !this.isFullyCleaned(child));
    if (!this.isFullyCleaned(record) || blockedByDescendant) {
      // Synchronous cleanup cannot await provider quiescence. Leave the owner
      // visible and retry after descendant settlement or on the next interval.
      this.deferredRecordRemovals.add(id);
      return false;
    }

    this.deferredRecordRemovals.delete(id);
    record.detached = true;
    this.removingRecords.add(id);
    try {
      if (record.outputCleanup) {
        try { record.outputCleanup(); } catch { /* ignore stale transcript cleanup errors */ }
        record.outputCleanup = undefined;
      }
      this.indexResumable(record);
      if (record.session) this.trackRecordSessionTeardown(id, record.session);
      record.session = undefined;
      this.clearParentSignal(id);
      for (const [thread, threadId] of this.managedThreads) {
        if (threadId !== id) continue;
        this.managedThreads.delete(thread);
        this.managedThreadPolicies.delete(thread);
        this.managedThreadReservations.delete(thread);
      }
      this.agents.delete(id);
      return true;
    } finally {
      // The map deletion is the point at which a later continuation becomes an
      // unknown owner and fails closed. Retain its seal while lineage records
      // still reference it, then prune it once the branch is gone.
      this.removingRecords.delete(id);
      this.pruneNestedMetadata();
    }
  }

  /**
   * Preserve enough of a departing record for `@handle` to reopen its
   * conversation later. Nothing to keep unless it has a session file to reopen
   * — an in-memory session leaves no transcript, so the mention would have
   * nothing to continue from. Only top-level agents are indexed.
   */
  private indexResumable(record: AgentRecord): void {
    if (!this.rememberAgents) return;
    if (record.parentAgentId !== undefined) return;
    if (!record.sessionFile || !record.session) return;
    const entry: ResumableAgentEntry = {
      handle: record.handle ?? record.id,
      id: record.id,
      type: record.type,
      description: record.description,
      sessionFile: record.sessionFile,
      completedAt: record.completedAt ?? Date.now(),
    };
    this.resumable.set(entry.handle, entry);
    // Bound the memory a long session can accumulate. Oldest first, since the
    // agent someone still wants to reach is the one they used most recently.
    while (this.resumable.size > MAX_RESUMABLE_ENTRIES) {
      let oldest: ResumableAgentEntry | undefined;
      for (const candidate of this.resumable.values()) {
        if (!oldest || candidate.completedAt <= oldest.completedAt) oldest = candidate;
      }
      if (!oldest) break;
      this.resumable.delete(oldest.handle);
    }
  }

  /**
   * Every handle currently spoken for — live records and resumable entries
   * alike. One shared set, so a fresh spawn can never be handed the handle of
   * an evicted conversation that `@handle` can still reopen.
   */
  private takenHandles(): ReadonlySet<string> {
    const taken = new Set<string>(this.resumable.keys());
    for (const record of this.agents.values()) {
      if (record.handle) taken.add(record.handle);
    }
    return taken;
  }

  /**
   * What `@handle` currently addresses: the live record holding that handle,
   * else the resumable entry left behind when it was evicted.
   *
   * Live wins. A resumable entry is deliberately kept after its conversation is
   * reopened (the reopened record may die before establishing a session of its
   * own, and the original transcript is still the right thing to reopen next
   * time), so both can hold the same handle at once — and while a record is
   * live, it is the one the user means.
   */
  resolveMention(handle: string): { kind: "live"; record: AgentRecord } | { kind: "resumable"; entry: ResumableAgentEntry } | undefined {
    const wanted = handle.toLowerCase();
    for (const record of this.agents.values()) {
      if (record.detached) continue;
      if (record.handle?.toLowerCase() === wanted || record.id === handle) return { kind: "live", record };
    }
    const entry = this.getResumable(handle);
    return entry ? { kind: "resumable", entry } : undefined;
  }

  /** Resolve a resumable entry by handle or id. */
  getResumable(name: string): ResumableAgentEntry | undefined {
    const wanted = name.toLowerCase();
    for (const entry of this.resumable.values()) {
      if (entry.handle.toLowerCase() === wanted || entry.id === name) return entry;
    }
    return undefined;
  }

  /** Evicted agents whose conversation can still be reopened, newest first. */
  listResumable(): ResumableAgentEntry[] {
    return [...this.resumable.values()].sort((a, b) => b.completedAt - a.completedAt);
  }

  /** Forget an evicted agent, by handle or id. */
  dropResumable(name: string): boolean {
    const entry = this.getResumable(name);
    if (!entry) return false;
    this.resumable.delete(entry.handle);
    return true;
  }

  /** Cumulative descendants any one top-level agent may start. */
  getMaxSubagentSpawnsPerBranch(): number {
    return this.maxSubagentSpawnsPerBranch;
  }

  /**
   * Set the branch spawn budget. `0` is refused rather than treated as
   * "unlimited": zero reads as a limit, and silently meaning its opposite is
   * how a safety valve gets disabled by accident. Nesting is turned off with
   * `maxSubagentDepth`, which says so.
   */
  setMaxSubagentSpawnsPerBranch(n: number): void {
    if (!Number.isSafeInteger(n) || n < 1) return;
    this.maxSubagentSpawnsPerBranch = n;
  }

  /** Descendants started so far under a top-level agent (for UI and tests). */
  getBranchSpawnCount(rootAgentId: string): number {
    return this.branchSpawnCounts.get(rootAgentId) ?? 0;
  }

  /** Whether spawned agents may ask their human a question. */
  getSupervisorQuestions(): boolean {
    return this.supervisorQuestions;
  }

  setSupervisorQuestions(enabled: boolean): void {
    this.supervisorQuestions = enabled;
  }

  /** Whether evicted records are indexed for `@handle` reopen. */
  getRememberAgents(): boolean {
    return this.rememberAgents;
  }

  setRememberAgents(enabled: boolean): void {
    this.rememberAgents = enabled;
    if (!enabled) this.resumable.clear();
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
    this.retryDeferredRecordRemovals();
  }  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
   */
  clearCompleted(skipUnconsumed = false): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
    this.retryDeferredRecordRemovals();
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  /**
   * Stop the selected workflow-owned records and wait for their normal
   * terminal callbacks. The callback persists the ordinary subagents record
   * before the Agent promise settles, so a successful response is safe to use
   * before a session-tree branch is replaced.
   */
  async quiesceOwned(
    runId: string,
    agentIds: string[],
    timeoutMs: number,
    owners?: AgentOwner[],
  ): Promise<{ settled: boolean; pending: string[] }> {
    const expected = new Set(agentIds);
    const ownerById = new Map<string, AgentOwner>();
    // A run-level owner is not enough to quiesce a generation safely. Require
    // the exact node/attempt owner for every id so a stale branch cannot stop a
    // replacement attempt in the same workflow.
    if (owners === undefined || owners.length !== agentIds.length) {
      return { settled: false, pending: [...new Set(agentIds)].slice(0, 256) };
    }
    for (const [index, owner] of owners.entries()) {
      const id = agentIds[index];
      if (!id || owner.extension !== "pi-workflows" || owner.runId !== runId || !owner.attemptId) {
        return { settled: false, pending: [...new Set(agentIds)].slice(0, 256) };
      }
      ownerById.set(id, owner);
    }
    const records: AgentRecord[] = [];
    const settledIds = new Set<string>();
    for (const record of this.agents.values()) {
      if (
        record.owner?.extension !== "pi-workflows" ||
        record.owner.runId !== runId ||
        !expected.has(record.id)
      ) continue;
      const expectedOwner = ownerById.get(record.id);
      if (!expectedOwner ||
        record.owner.nodeId !== expectedOwner.nodeId ||
        record.owner.attemptId !== expectedOwner.attemptId) continue;
      if (!this.isFullyCleaned(record) || this.descendantsOf(record.id).some((child) => !this.isFullyCleaned(child))) {
        records.push(record);
      } else {
        // An exact-owner terminal record with no live descendant is already
        // quiescent. Treating it as a missing record would make a concurrent
        // terminal callback look pending.
        settledIds.add(record.id);
      }
    }
    const matched = new Set([...records.map((record) => record.id), ...settledIds]);
    const pendingOwners = agentIds.filter((id) => !matched.has(id));

    // Managed callers name only top-level attempts, but nested descendants can
    // own worktrees and ignore abort. Include the immutable-lineage branch in
    // the wait/quarantine set without exposing hidden child ids in the reply.
    const quiescenceRecords = [...records];
    const branchOwnerById = new Map<string, string>();
    for (const record of records) branchOwnerById.set(record.id, record.id);
    const branchRootIds = new Set([...agentIds, ...records.map((record) => record.id)]);
    for (const rootId of branchRootIds) {
      for (const child of this.descendantsOf(rootId)) {
        if (this.isFullyCleaned(child) || branchOwnerById.has(child.id)) continue;
        branchOwnerById.set(child.id, rootId);
        quiescenceRecords.push(child);
      }
    }
    for (const record of quiescenceRecords) this.abort(record.id);
    const result = await this.waitForTerminalRecords(quiescenceRecords, timeoutMs);
    const pendingBranchOwners = result.pending
      .map((id) => expected.has(id) ? undefined : branchOwnerById.get(id))
      .filter((id): id is string => id !== undefined);
    return {
      settled: result.settled && pendingOwners.length === 0,
      pending: [...new Set([
        ...result.pending.filter((id) => expected.has(id)),
        ...pendingOwners,
        ...pendingBranchOwners,
      ])].slice(0, 256),
    };
  }

  /** Stop every active record for session-tree preparation. */
  async quiesceAll(timeoutMs: number): Promise<{ settled: boolean; pending: string[] }> {
    const records = [...this.agents.values()].filter((record) => !this.isFullyCleaned(record));
    for (const record of records) this.abort(record.id);
    return this.waitForTerminalRecords(records, timeoutMs);
  }

  private recordDepth(record: AgentRecord): number {
    // Parent records may be gone by the time a timeout sorts cleanup work. The
    // allocation-time lineage is immutable and remains authoritative.
    return record.ancestorAgentIds?.length ?? 0;
  }

  private cleanupRecordWorktree(
    record: AgentRecord,
    cwd: string,
    description: string,
    allowDuringDispose = false,
  ): WorktreeCleanupResult | undefined {
    const worktree = record.worktree;
    if (!worktree) return undefined;

    if (this.providerPendingRecords.has(record.id)) {
      return this.blockedWorktreeCleanup(record, `Worktree cleanup is pinned because provider/tool settlement for ${record.id} is still pending`);
    }

    if (this.hasIncompleteRepoDependency(record)) {
      return this.blockedWorktreeCleanup(record);
    }
    if (this.recordSessionTeardowns.has(record.id)) {
      return this.blockedWorktreeCleanup(record, `Worktree cleanup is pinned because child session teardown for ${record.id} is still pending`);
    }
    if (this.disposed && !allowDuringDispose) return record.worktreeResult;

    let result: WorktreeCleanupResult;
    try {
      result = cleanupWorktree(cwd, worktree, description);
    } catch (error: unknown) {
      result = cleanupFailureResult(cwd, worktree, error);
    }
    if (!result.cleanupSucceeded && !result.recoveryCommands) {
      result = {
        ...result,
        cleanupDiagnostic: result.cleanupDiagnostic ?? `Worktree cleanup failed for ${worktree.path}`,
        recoveryCommands: worktreeRecoveryCommands(cwd, worktree.path),
      };
    }
    record.worktreeResult = result;
    // The reference is the recovery path. Only clear it after the helper has
    // confirmed both directory removal and Git registration cleanup.
    if (result.cleanupSucceeded === true) record.worktree = undefined;
    return result;
  }

  private async cleanupRecordWorktreeAsync(
    record: AgentRecord,
    cwd: string,
    description: string,
  ): Promise<WorktreeCleanupResult | undefined> {
    const worktree = record.worktree;
    if (!worktree) return undefined;

    if (this.providerPendingRecords.has(record.id)) {
      return this.blockedWorktreeCleanup(record, `Worktree cleanup is pinned because provider/tool settlement for ${record.id} is still pending`);
    }

    if (this.hasIncompleteRepoDependency(record)) {
      return this.blockedWorktreeCleanup(record);
    }
    if (this.recordSessionTeardowns.has(record.id)) {
      return this.blockedWorktreeCleanup(record, `Worktree cleanup is pinned because child session teardown for ${record.id} is still pending`);
    }

    let result: WorktreeCleanupResult;
    try {
      result = typeof cleanupWorktreeAsync === "function"
        ? await cleanupWorktreeAsync(cwd, worktree, description)
        : cleanupWorktree(cwd, worktree, description);
    } catch (error: unknown) {
      result = cleanupFailureResult(cwd, worktree, error);
    }
    if (!result.cleanupSucceeded && !result.recoveryCommands) {
      result = {
        ...result,
        cleanupDiagnostic: result.cleanupDiagnostic ?? `Worktree cleanup failed for ${worktree.path}`,
        recoveryCommands: worktreeRecoveryCommands(cwd, worktree.path),
      };
    }
    record.worktreeResult = result;
    if (result.cleanupSucceeded === true) record.worktree = undefined;
    return result;
  }

  private cleanupDetachedWorktree(record: AgentRecord, allowDuringDispose = false): WorktreeCleanupResult | undefined {
    if (this.disposed && !allowDuringDispose) return record.worktreeResult;
    const worktree = record.worktree;
    if (!worktree) return undefined;

    if (this.hasIncompleteRepoDependency(record)) {
      return this.blockedWorktreeCleanup(record);
    }
    return this.cleanupRecordWorktree(record, worktree.repoRoot, record.description, allowDuringDispose);
  }

  /** Quarantine a record before any late provider continuation can observe it. */
  private quarantineRecord(id: string, record: AgentRecord): void {
    record.detached = true;
    const resumeControl = this.resumeControls.get(id);
    if (resumeControl) {
      this.restoreResumeSnapshot(record, resumeControl.snapshot);
      this.cancelResumeControl(id);
    } else {
      record.abortController?.abort();
    }

    if (record.status === "queued" || record.status === "running") {
      record.status = "stopped";
      record.completedAt ??= Date.now();
    }
    record.pendingSteers = undefined;
    this.sealNestedSpawns(id);
    this.clearParentSignal(id);
    if (record.outputCleanup) {
      try { record.outputCleanup(); } catch { /* ignore stale transcript cleanup errors */ }
      record.outputCleanup = undefined;
    }
    if (record.session) {
      this.trackRecordSessionTeardown(id, record.session);
      record.session = undefined;
    }
    this.releasePoolSlot(id);
  }

  private async waitForTerminalRecords(
    records: AgentRecord[],
    timeoutMs: number,
  ): Promise<{ settled: boolean; pending: string[] }> {
    const pendingIds = new Set(
      records.filter((record) => !this.isFullyCleaned(record)).map((record) => record.id),
    );
    const recheck = (record: AgentRecord): void => {
      if (this.isFullyCleaned(record)) pendingIds.delete(record.id);
    };
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const pendingPromises = records
      .map((record) => record.promise?.then(() => recheck(record)))
      .filter((promise): promise is Promise<void> => promise !== undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const allSettled = Promise.allSettled(pendingPromises).then(() => true);
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
    });
    const completed = await Promise.race([allSettled, timedOut]);
    if (timer) clearTimeout(timer);

    let pending = [...pendingIds];
    if (!completed || pending.length > 0) {
      // Quiescence is fail-closed. A timed-out record may still settle in a
      // provider callback, so quarantine it before the caller installs the
      // replacement branch. Its initial stopped tombstone was persisted by
      // abort(); later sync/notify paths are no-ops for detached records.
      const pendingRecords: AgentRecord[] = [];
      for (const id of pending) {
        const record = this.agents.get(id);
        if (!record) continue;
        this.quarantineRecord(id, record);
        pendingRecords.push(record);
      }

      // Session shutdown must finish before a worktree can be removed: an
      // extension handler may still be using the child session's cwd.
      const teardownPromises = pendingRecords
        .map((record) => this.recordSessionTeardowns.get(record.id))
        .filter((promise): promise is Promise<void> => promise !== undefined);
      if (teardownPromises.length > 0) {
        const allTeardowns = Promise.allSettled(teardownPromises).then(() => true);
        let teardownTimer: ReturnType<typeof setTimeout> | undefined;
        const teardownTimeout = new Promise<boolean>((resolve) => {
          teardownTimer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
        });
        await Promise.race([allTeardowns, teardownTimeout]);
        if (teardownTimer) clearTimeout(teardownTimer);
      }

      // Quarantining must precede cleanup so a late provider callback cannot
      // race the worktree removal. Descendants go first while ancestor repoRoots
      // are still present, including for callers outside nested parent cleanup.
      pendingRecords
        .sort((left, right) => this.recordDepth(right) - this.recordDepth(left))
        .forEach((record) => {
          if (this.settlingRecords.has(record.id)) {
            this.blockedWorktreeCleanup(record, `Worktree cleanup is pinned because provider settlement for ${record.id} is still pending`);
          } else if (this.recordSessionTeardowns.has(record.id)) {
            this.blockedWorktreeCleanup(record, `Worktree cleanup is pinned because child session teardown for ${record.id} is still pending`);
          } else if (this.hasIncompleteRepoDependency(record)) {
            this.blockedWorktreeCleanup(record);
          } else {
            this.cleanupDetachedWorktree(record);
          }
        });
      // A resolved provider promise is not enough: worktree/session cleanup can
      // still be pending or failed. Re-check after every quarantine attempt.
      for (const record of pendingRecords) recheck(record);
      pending = [...pendingIds];
      this.drainQueue();
    }
    return { settled: completed && pending.length === 0, pending };
  }

  /**
   * Mark records detached before the new branch is installed. Any late promise
   * completion is still allowed to settle internally but cannot emit lifecycle,
   * notifications, or persistence into the replacement branch.
   */
  detachForBranchChange(): void {
    this.clearManagedPersistenceRetries();
    const records = [...this.agents.values()]
      .filter((record) => !this.isFullyCleaned(record))
      .sort((left, right) => this.recordDepth(right) - this.recordDepth(left));
    for (const record of records) this.quarantineRecord(record.id, record);
    for (const record of records) {
      if (this.settlingRecords.has(record.id)) {
        this.blockedWorktreeCleanup(record, `Worktree cleanup is pinned because provider settlement for ${record.id} is still pending`);
      } else if (this.hasIncompleteRepoDependency(record)) this.blockedWorktreeCleanup(record);
      else this.cleanupDetachedWorktree(record);
    }
    this.drainQueue();
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    // Snapshot the active set first: aborting a root also synchronously aborts
    // every immutable-lineage descendant, while the return value preserves the
    // historical count of records that were active when this call began.
    const active = [...this.agents.values()].filter(
      (record) => record.status === "running" || record.status === "queued",
    );
    // Prevent releasing a running slot from starting queued work while this
    // branch-wide stop is still traversing the active snapshot.
    this.queue = [];
    for (const record of active) this.abort(record.id);
    this.drainQueue();
    return active.length;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      const pending = [...this.agents.values()]
        .filter(r => r.status === "running" || r.status === "queued")
        .map(r => r.promise)
        .filter(Boolean);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  /**
   * Quarantine records synchronously, then finish child session and worktree
   * teardown asynchronously. Git cleanup uses callback-based execFile so root
   * session shutdown does not block the event loop.
   */
  dispose(): Promise<readonly WorktreeCleanupFailure[]> {
    this.clearManagedPersistenceRetries();
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    clearInterval(this.cleanupInterval);

    const records = [...this.agents.values()];
    const reposToPrune = new Set(this.worktreeRepos);
    for (const record of records) {
      if (record.worktree) reposToPrune.add(record.worktree.repoRoot);
    }
    try { reposToPrune.add(process.cwd()); } catch { /* ignore an invalid cwd */ }

    // Stop dispatch first. A late settlement must not start queued work while
    // the old session is being torn down.
    this.queue = [];
    for (const cleanup of this.parentSignalCleanups.values()) {
      try { cleanup(); } catch { /* ignore stale signal cleanup errors */ }
    }
    this.parentSignalCleanups.clear();
    this.heldPoolSlots.clear();
    this.runningBackground = 0;

    // Quarantine every record before invoking any abort/session-shutdown hook.
    // These callbacks are synchronous extension seams and may otherwise try to
    // allocate children or publish state while disposal is in progress.
    for (const record of records) {
      record.detached = true;
      if (record.status === "running" || record.status === "queued") {
        record.status = "stopped";
        record.completedAt ??= Date.now();
      }
      this.cancelResumeControl(record.id);
      record.pendingSteers = undefined;
      this.nestedSpawnSeals.add(record.id);
      this.removingRecords.add(record.id);
      if (record.outputCleanup) {
        try { record.outputCleanup(); } catch { /* ignore stale transcript cleanup errors */ }
        record.outputCleanup = undefined;
      }
    }
    this.resumeControls.clear();

    this.disposePromise = this.finishDispose(records, reposToPrune);
    return this.disposePromise;
  }

  private async finishDispose(
    records: AgentRecord[],
    reposToPrune: Set<string>,
  ): Promise<readonly WorktreeCleanupFailure[]> {
    // Abort every record first, then start every session teardown before awaiting
    // any one of them. A failing handler therefore cannot starve its siblings.
    for (const record of records) {
      try { await record.abortController?.abort(); } catch { /* ignore stale abort errors */ }
      if (record.session) {
        this.trackRecordSessionTeardown(record.id, record.session);
        record.session = undefined;
      }
    }
    await this.awaitSessionTeardowns();


    const providerPromises = records
      .map((record) => record.promise)
      .filter((promise): promise is Promise<string> => promise !== undefined);
    if (providerPromises.length > 0) {
      let providerTimer: ReturnType<typeof setTimeout> | undefined;
      const providerTimeout = new Promise<void>((resolve) => {
        providerTimer = setTimeout(resolve, DISPOSE_PROVIDER_QUIESCE_TIMEOUT_MS);
      });
      await Promise.race([Promise.allSettled(providerPromises).then(() => undefined), providerTimeout]);
      if (providerTimer) clearTimeout(providerTimer);
    }

    const orderedRecords = records.sort((left, right) => this.recordDepth(right) - this.recordDepth(left));
    const attemptCleanup = async (record: AgentRecord): Promise<void> => {
      if (!record.worktree) return;
      try {
        if (this.settlingRecords.has(record.id)) {
          this.blockedWorktreeCleanup(record, `Worktree cleanup is pinned because provider settlement for ${record.id} is still pending`);
          return;
        }
        if (this.hasIncompleteRepoDependency(record)) {
          this.blockedWorktreeCleanup(record);
          return;
        }
        await this.cleanupRecordWorktreeAsync(record, record.worktree.repoRoot, record.description);
      } catch (error: unknown) {
        // Keep the live worktree reference so the final diagnostic remains
        // actionable, while continuing through every sibling and ancestor.
        if (record.worktree) {
          record.worktreeResult = cleanupFailureResult(record.worktree.repoRoot, record.worktree, error);
        }
      }
    };

    // First pass is deepest-first. A single failed child must not block any
    // other descendant or sibling from receiving its own attempt.
    for (const record of orderedRecords) await attemptCleanup(record);
    const pruneRepository = async (repo: string): Promise<void> => {
      try {
        if (typeof pruneWorktreesAsync === "function") await pruneWorktreesAsync(repo);
        else pruneWorktrees(repo);
      } catch {
        // Pruning is best effort; individual cleanup results retain recovery data.
      }
    };
    const pruneRepositories = async (): Promise<void> => {
      await Promise.all([...reposToPrune].map((repo) => pruneRepository(repo)));
    };

    // Pruning after the first pass can release stale child registrations. Retry
    // only records whose worktree reference remains, still deepest-first.
    await pruneRepositories();
    for (const record of orderedRecords) {
      if (record.worktree) await attemptCleanup(record);
    }
    await pruneRepositories();

    const failures = orderedRecords
      .filter((record): record is AgentRecord & { worktree: WorktreeInfo } => record.worktree !== undefined)
      .map((record) => snapshotCleanupFailure(record.worktree, record.worktreeResult ?? {
        hasChanges: false,
        path: record.worktree.path,
        cleanupSucceeded: false,
        cleanupDiagnostic: `Worktree cleanup did not report an outcome for ${record.worktree.path}`,
        recoveryCommands: worktreeRecoveryCommands(record.worktree.repoRoot, record.worktree.path),
      }));
    this.worktreeCleanupFailures = Object.freeze(failures);
    if (failures.length > 0) {
      console.warn(
        `[pi-subagents] Worktree cleanup failures:\n${failures.map((failure) =>
          `${failure.path}: ${failure.reason} Recovery: ${failure.recoveryCommands.join(" && ")}`).join("\n")}`,
      );
    }

    // Clear authoritative and ownership metadata only after quarantine, session
    // shutdown, and all cleanup attempts. Detached continuations retain their
    // record object but cannot find it through this manager or recreate anything.
    this.agents.clear();
    this.managedSpawns.clear();
    this.managedKeysById.clear();
    this.managedThreads.clear();
    this.managedThreadPolicies.clear();
    this.managedThreadReservations.clear();
    this.nestedSpawnSeals.clear();
    this.removingRecords.clear();
    this.settlingRecords.clear();

    this.providerPendingRecords.clear();
    this.recordSessionTeardowns.clear();
    this.deferredRecordRemovals.clear();
    this.worktreeRepos.clear();
    return this.worktreeCleanupFailures;
  }
}
