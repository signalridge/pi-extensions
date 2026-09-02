/**
 * Cross-extension RPC handlers for the subagents extension.
 *
 * v2 ping/spawn/stop remain available for existing callers. Workflow
 * orchestration uses the additive managed-spawn method, whose deliberately
 * small request is the only surface that can create workflow-owned agents.
 */

import {
  CHILD_CONTEXT_CAPABILITY,
  type ManagedRoutingPolicySnapshot,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_VERSION,
  parseManagedSpawnRequest,
  parsePingIncludes,
} from "@signalridge/pi-subagents-protocol";

export { CHILD_CONTEXT_CAPABILITY, PROTOCOL_CAPABILITIES, PROTOCOL_VERSION };

import type { ManagedSpawnPolicy, ManagedSpawnRequest, ManagedSpawnResult } from "./agent-manager.js";
import { getRoutingPolicySnapshot } from "./agent-tiers.js";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import type { AgentOwner } from "./types.js";

/** Minimal event bus interface needed by the RPC handlers. */
export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

/** RPC reply envelope — matches pi-mono's RpcResponse shape. */
export type RpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

/** Factory-time context query. It is intentionally safe to answer in a child
 * session even when pi filters this extension out of lifecycle activation. */
export const CHILD_CONTEXT_RPC = "subagents:rpc:context";

/** Minimal AgentManager interface needed by the spawn/stop RPCs. */
export interface SpawnCapable {
  spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: Record<string, unknown>): string;
  spawnManaged?(pi: unknown, ctx: unknown, request: ManagedSpawnRequest, policy: ManagedSpawnPolicy): ManagedSpawnResult;
  abort(id: string): boolean;
  abortOwned?(id: string, owner: AgentOwner): boolean;
  quiesceOwned?(runId: string, agentIds: string[], timeoutMs: number, owners?: AgentOwner[]): Promise<{ settled: boolean; pending: string[] }>;
  reconcileManaged?(spawnKey: string, owner: AgentOwner): ManagedSpawnResult | undefined;
  /**
   * Live background-agent pool size, published to a peer that asks for it.
   *
   * Required, unlike the capability members above. Those are advertised in the
   * ping's `capabilities` and a peer missing one is rejected outright, so a
   * bridge that forgets to forward one fails loudly. A missing pool size has no
   * capability bit and no failure: the caller would silently fall back to its
   * own guess and run at the wrong width. Making it required is what stops a
   * bridge from omitting it by accident.
   */
  getMaxConcurrent(): number;
}

export interface RpcDeps {
  events: EventBus;
  pi: unknown;
  getCtx: () => unknown | undefined;
  manager: SpawnCapable;
  /** Override for focused consumers/tests; production reads live policy state. */
  getRoutingPolicy?: () => ManagedRoutingPolicySnapshot;
}

export interface RpcHandle {
  unsubPing: () => void;
  unsubSpawn: () => void;
  unsubStop: () => void;
  unsubStopOwned: () => void;
  unsubSpawnManaged: () => void;
  unsubReconcile: () => void;
  unsubQuiesce: () => void;
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return normalized;
}

function requestIdFrom(raw: unknown): string {
  return boundedString(asRecord(raw, "RPC request").requestId, "requestId", 128);
}

function rejectUnknownKeys(value: RecordValue, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field "${key}"`);
  }
}

/** Register the only event-bus surface that is allowed before session_start. */
export function registerChildContextHandler(events: EventBus, child: boolean): () => void {
  return events.on(CHILD_CONTEXT_RPC, (raw: unknown) => {
    if (!isRecord(raw) || typeof raw.requestId !== "string") return;
    const requestId = raw.requestId.trim();
    if (requestId.length === 0 || requestId.length > 128) return;
    events.emit(`${CHILD_CONTEXT_RPC}:reply:${requestId}`, {
      success: true,
      data: { child, capability: CHILD_CONTEXT_CAPABILITY },
    });
  });
}

const OWNER_KEYS = new Set(["extension", "runId", "nodeId", "attemptId"]);

export function validateManagedOwner(raw: unknown, requireAttempt = false): AgentOwner {
  const ownerValue = asRecord(raw, "owner");
  rejectUnknownKeys(ownerValue, OWNER_KEYS, "owner");
  const extension = boundedString(ownerValue.extension, "owner.extension", 64);
  if (extension !== "pi-workflows") throw new Error('owner.extension must be "pi-workflows"');
  const attemptId = ownerValue.attemptId === undefined
    ? undefined
    : boundedString(ownerValue.attemptId, "owner.attemptId", 256);
  if (requireAttempt && attemptId === undefined) throw new Error("owner.attemptId is required");
  return {
    extension,
    runId: boundedString(ownerValue.runId, "owner.runId", 256),
    nodeId: boundedString(ownerValue.nodeId, "owner.nodeId", 256),
    ...(attemptId === undefined ? {} : { attemptId }),
  };
}

/** Validate and normalize the intentionally policy-free managed spawn contract. */
export function validateManagedSpawnRequest(raw: unknown): ManagedSpawnRequest {
  return parseManagedSpawnRequest(raw);
}

/**
 * Wire one RPC handler: listen on `channel`, run `fn`, and emit a scoped reply.
 * Invalid requests with a usable requestId still receive an error envelope.
 */
function handleRpc(
  events: EventBus,
  channel: string,
  fn: (params: RecordValue) => unknown | Promise<unknown>,
): () => void {
  return events.on(channel, async (raw: unknown) => {
    let requestId: string;
    try {
      requestId = requestIdFrom(raw);
    } catch {
      return;
    }
    try {
      const data = await fn(asRecord(raw, "RPC request"));
      const reply: RpcReply<unknown> = data === undefined
        ? { success: true }
        : { success: true, data };
      events.emit(`${channel}:reply:${requestId}`, reply);
    } catch (error: unknown) {
      events.emit(`${channel}:reply:${requestId}`, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/**
 * Register ping, legacy spawn/stop, and managed workflow spawn/reconciliation handlers.
 * Returns unsubscribe functions for cleanup.
 */
export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
  const { events, pi, getCtx, manager } = deps;
  const getRoutingPolicy = deps.getRoutingPolicy ?? getRoutingPolicySnapshot;

  const unsubPing = handleRpc(events, "subagents:rpc:ping", (params) => {
    // Additive fields are opt-in by name. The reply envelope is parsed with
    // rejectUnknownKeys on the caller's side, so volunteering a field would
    // make every already-published peer reject the handshake; a peer that asks
    // for one is by construction a peer that knows how to parse it.
    const include = parsePingIncludes(params.include);
    const maxConcurrent = include.has("maxConcurrent") ? manager.getMaxConcurrent() : undefined;
    return {
      version: PROTOCOL_VERSION,
      capabilities: PROTOCOL_CAPABILITIES,
      routingPolicy: getRoutingPolicy(),
      ...(typeof maxConcurrent === "number" && Number.isInteger(maxConcurrent) && maxConcurrent >= 1
        ? { maxConcurrent }
        : {}),
    };
  });

  const unsubSpawn = handleRpc(events, "subagents:rpc:spawn", (params) => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active session");
    const type = boundedString(params.type, "type", 256);
    const prompt = boundedString(params.prompt, "prompt", 100_000);
    const rawOptions = params.options;
    if (rawOptions !== undefined && !isRecord(rawOptions)) {
      throw new Error("options must be an object");
    }

    // Legacy callers may still provide the full spawn options surface. Resolve
    // serializable model strings here, exactly as before; managed callers must
    // use spawn-managed and cannot reach this branch with policy fields.
    let normalizedOptions: Record<string, unknown> = { ...(rawOptions ?? {}) };
    // Legacy spawn is intentionally unowned; owner metadata is accepted only
    // by validateManagedSpawnRequest on the additive managed channel.
    delete normalizedOptions.owner;
    if (typeof normalizedOptions.model === "string") {
      const registry = (ctx as { modelRegistry?: ModelRegistry }).modelRegistry;
      if (!registry) {
        throw new Error(
          `Model override "${normalizedOptions.model}" provided but ctx.modelRegistry is unavailable`,
        );
      }
      const resolved = resolveModel(normalizedOptions.model, registry);
      if (typeof resolved === "string") throw new Error(resolved);
      normalizedOptions = { ...normalizedOptions, model: resolved };
    }
    return { id: manager.spawn(pi, ctx, type, prompt, normalizedOptions) };
  });

  const unsubSpawnManaged = handleRpc(events, "subagents:rpc:spawn-managed", (params) => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active session");
    if (!manager.spawnManaged) throw new Error("Managed spawn is unavailable");
    const request = validateManagedSpawnRequest(params);
    // Policy hints are validated at the protocol boundary, then resolved by the
    // production wrapper and AgentManager so the peer never bypasses local policy.
    const result = manager.spawnManaged(pi, ctx, request, {}) as ManagedSpawnResult | string;
    // Keep the additive handler tolerant of an older in-process manager fixture
    // while protocol-v3 managers return the richer state snapshot.
    if (typeof result === "string") return { id: result, state: "running" };
    return result;
  });

  const unsubReconcile = handleRpc(events, "subagents:rpc:reconcile-managed", (params) => {
    if (!manager.reconcileManaged) throw new Error("Managed reconciliation is unavailable");
    rejectUnknownKeys(params, new Set(["requestId", "spawnKey", "owner"]), "managed reconciliation request");
    const spawnKey = boundedString(params.spawnKey, "spawnKey", 256);
    const owner = validateManagedOwner(params.owner, true);
    const result = manager.reconcileManaged(spawnKey, owner);
    if (!result) throw new Error("Managed spawn key not found or owner mismatch");
    return result;
  });

  const unsubStop = handleRpc(events, "subagents:rpc:stop", (params) => {
    const agentId = boundedString(params.agentId, "agentId", 128);
    if (!manager.abort(agentId)) throw new Error("Agent not found");
  });

  const unsubStopOwned = handleRpc(events, "subagents:rpc:stop-owned", (params) => {
    rejectUnknownKeys(params, new Set(["requestId", "agentId", "owner"]), "owned stop request");
    const agentId = boundedString(params.agentId, "agentId", 128);
    const owner = validateManagedOwner(params.owner, true);
    if (!manager.abortOwned?.(agentId, owner)) {
      throw new Error("Owned agent not found");
    }
  });

  const unsubQuiesce = handleRpc(events, "subagents:rpc:quiesce-owned", async (params) => {
    if (!manager.quiesceOwned) throw new Error("Owned quiescence is unavailable");
    rejectUnknownKeys(params, new Set(["requestId", "owner", "agentIds", "owners", "timeoutMs"]), "owned quiescence request");
    const owner = asRecord(params.owner, "owner");
    rejectUnknownKeys(owner, new Set(["extension", "runId"]), "owner");
    if (owner.extension !== "pi-workflows") throw new Error('owner.extension must be "pi-workflows"');
    const runId = boundedString(owner.runId, "owner.runId", 256);
    if (!Array.isArray(params.agentIds) || params.agentIds.length > 256) {
      throw new Error("agentIds must be an array with at most 256 entries");
    }
    const agentIds = params.agentIds.map((id, index) => boundedString(id, `agentIds[${index}]`, 128));
    if (!Array.isArray(params.owners) || params.owners.length !== agentIds.length) {
      throw new Error("owners must match agentIds");
    }
    const owners = params.owners.map((value, index) => {
      const parsed = validateManagedOwner(value, true);
      if (parsed.runId !== runId) throw new Error(`owners[${index}] has a different runId`);
      return parsed;
    });
    const rawTimeout = params.timeoutMs;
    if (typeof rawTimeout !== "number" || !Number.isInteger(rawTimeout) || rawTimeout < 1 || rawTimeout > 30_000) {
      throw new Error("timeoutMs must be an integer between 1 and 30000");
    }
    return manager.quiesceOwned(runId, agentIds, rawTimeout, owners);
  });

  return { unsubPing, unsubSpawn, unsubStop, unsubStopOwned, unsubSpawnManaged, unsubQuiesce, unsubReconcile };
}
