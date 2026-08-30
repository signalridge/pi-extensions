import { randomUUID } from "node:crypto";
import type {
  ManagedRoutingPolicy,
  ManagedSpawnResponse as ProtocolManagedSpawnResponse,
  ManagedTerminalSnapshot as ProtocolManagedTerminalSnapshot,
} from "@signalridge/pi-subagents-protocol";
import {
  PROTOCOL_VERSION,
  parseManagedSpawnResponse,
  parseProtocolPing,
  requiredCapabilitiesMatch,
} from "@signalridge/pi-subagents-protocol";
import type { WorkflowOwner } from "./journal.js";

/** Minimal dispatch task for a script-run agent() call. */
export interface DispatchTask {
  subagent_type: string;
  prompt: string;
  description: string;
  /** Agent-tier key, from the host's own catalogue. The only model policy here. */
  tier?: string;
  /** Per-call worktree request owned by pi-subagents. */
  isolation?: "worktree";
  /** Forwarded toolset hint (e.g. "web-research") for pi-subagents to augment tools. */
  toolset?: string;
  /** Thread hint for sequential same-thread calls within one run. */
  thread?: string;
  /** Denied tools — prevents recursive workflow fan-out. */
  excludeTools?: string[];
}

export interface WorkflowEventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

type RpcSuccess<T> = { success: true; data?: T };
type RpcFailure = { success: false; error: string };
type RpcReply<T> = RpcSuccess<T> | RpcFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReply<T>(value: unknown): value is RpcReply<T> {
  return isRecord(value) && typeof value.success === "boolean";
}

function requestId(): string {
  return randomUUID();
}

function callRpc<T>(
  events: WorkflowEventBus,
  channel: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const id = typeof payload.requestId === "string" ? payload.requestId : requestId();
  const replyChannel = `${channel}:reply:${id}`;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve(value as T);
    };
    const onAbort = () => finish(new Error(`${channel} request aborted`));
    try {
      unsubscribe = events.on(replyChannel, (raw: unknown) => {
        if (!isReply<T>(raw)) {
          finish(new Error("Invalid subagents RPC reply"));
          return;
        }
        if (!raw.success) finish(new Error(raw.error));
        else finish(undefined, raw.data as T);
      });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => finish(new Error(`${channel} timed out after ${timeoutMs}ms`)), timeoutMs);
      events.emit(channel, { ...payload, requestId: id });
    } catch (error: unknown) {
      finish(error);
    }
  });
}

export const REQUIRED_SUBAGENTS_PROTOCOL = PROTOCOL_VERSION;
export const PROTOCOL_DIAGNOSTIC =
  `@signalridge/pi-workflows requires @signalridge/pi-subagents protocol v${PROTOCOL_VERSION} with managedSpawn, lifecycleOwner, ownedStop, childContext, ownedQuiescence, agentTiers, and managedPolicy, plus its Agent-tier routing policy. ` +
  "Install @signalridge/pi-subagents and @signalridge/pi-workflows exactly once; Pi loads both from their configured pi.extensions manifests.";

const CAPABILITY_DIAGNOSTIC = `subagents protocol v${PROTOCOL_VERSION} is required, with every capability and an Agent-tier routing policy`;

export const CHILD_CONTEXT_QUERY_TIMEOUT_MS = 250;

/**
 * Query the factory-time child-session marker owned by pi-subagents. A missing
 * reply means the companion extension is absent; callers must retain the root
 * surface and let the normal protocol diagnostic explain that configuration.
 */
export async function queryChildSessionContext(
  events: WorkflowEventBus,
  timeoutMs = CHILD_CONTEXT_QUERY_TIMEOUT_MS,
): Promise<boolean | undefined> {
  const id = requestId();
  const channel = "subagents:rpc:context";
  return new Promise<boolean | undefined>((resolve) => {
    let settled = false;
    const replyChannel = `${channel}:reply:${id}`;
    let unsubscribe = () => {};
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const finish = (child: boolean | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(child);
    };
    unsubscribe = events.on(replyChannel, (raw: unknown) => {
      if (!isReply(raw) || !raw.success || !isRecord(raw.data)) {
        finish(undefined);
        return;
      }
      finish(typeof raw.data.child === "boolean" ? raw.data.child : undefined);
    });
    try {
      events.emit(channel, { requestId: id });
    } catch {
      finish(undefined);
    }
  });
}
/**
 * Synchronous companion to the bounded async query. Pi's event bus dispatches
 * handlers synchronously, so a child marker can be consumed before lifecycle
 * registration without blocking a later extension's session_start.
 */
export function queryChildSessionContextImmediate(events: WorkflowEventBus): boolean | undefined {
  const id = requestId();
  const replyChannel = `subagents:rpc:context:reply:${id}`;
  let child: boolean | undefined;
  const unsubscribe = events.on(replyChannel, (raw: unknown) => {
    if (!isReply(raw) || !raw.success || !isRecord(raw.data)) return;
    if (typeof raw.data.child === "boolean") child = raw.data.child;
  });
  try {
    events.emit("subagents:rpc:context", { requestId: id });
  } finally {
    unsubscribe();
  }
  return child;
}

/** Verify the separately configured pi-subagents package before workflow execution. */
export interface ManagedProtocolCheck {
  /** The host's Agent-tier catalogue, as of this check. */
  routingPolicy: ManagedRoutingPolicy;
  /** Whole-catalogue identity; used only where a per-tier identity cannot be. */
  routingPolicyFingerprint: string;
}

export async function checkManagedSpawnProtocol(
  events: WorkflowEventBus,
  signal?: AbortSignal,
): Promise<ManagedProtocolCheck> {
  const id = requestId();
  const reply = await new Promise<unknown>((resolve, reject) => {
    const replyChannel = `subagents:rpc:ping:reply:${id}`;
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribeReply = () => {};
    let unsubscribeReady = () => {};
    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      unsubscribeReply();
      unsubscribeReady();
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => finish(undefined, new Error("subagents protocol discovery aborted"));
    const finish = (value: unknown, error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    unsubscribeReply = events.on(replyChannel, (raw: unknown) => {
      if (!isReply(raw)) {
        finish(undefined, new Error("Invalid subagents protocol ping reply"));
      } else if (!raw.success) {
        finish(undefined, new Error(raw.error));
      } else {
        finish(raw.data);
      }
    });
    unsubscribeReady = events.on("subagents:ready", (raw: unknown) => {
      if (isRecord(raw) && typeof raw.version === "number") finish(raw);
    });
    const sendPing = () => {
      try {
        events.emit("subagents:rpc:ping", { requestId: id });
      } catch (error: unknown) {
        finish(undefined, error instanceof Error ? error : new Error(String(error)));
      }
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timeoutTimer = setTimeout(
      () => finish(undefined, new Error("subagents protocol ping timed out after 2000ms")),
      2_000,
    );
    // The two extensions may register their session_start handlers in either
    // order. A synchronous ping handles the already-registered case; the
    // readiness event handles a later session_start without emitting through a
    // stale lifecycle context.
    sendPing();
  });
  let ping: ReturnType<typeof parseProtocolPing>;
  try {
    ping = parseProtocolPing(reply);
  } catch (error: unknown) {
    // Anything shaped like a ping is a peer that is present but not v4-complete,
    // and the actionable answer is the same in every such case: install a
    // matching pair. A reply that is not a ping at all gets its own message,
    // because "upgrade the peer" would be the wrong thing to go do.
    if (!isRecord(reply) || typeof reply.version !== "number") {
      throw new Error("subagents protocol ping did not return a valid version/capability envelope");
    }
    throw new Error(`${CAPABILITY_DIAGNOSTIC} (${error instanceof Error ? error.message : String(error)})`);
  }
  // Every v4 capability is required, so one check covers them all. The parser
  // has already rejected a ping without a well-formed routing policy.
  if (ping.version < REQUIRED_SUBAGENTS_PROTOCOL || !requiredCapabilitiesMatch(ping.capabilities)) {
    throw new Error(CAPABILITY_DIAGNOSTIC);
  }
  return {
    routingPolicy: ping.routingPolicy.policy,
    routingPolicyFingerprint: ping.routingPolicy.fingerprint,
  };
}

export type ManagedTerminalSnapshot = ProtocolManagedTerminalSnapshot;
export type ManagedSpawnResponse = ProtocolManagedSpawnResponse;

export interface ManagedSpawnClient {
  /** Managed spawn returns a structured response. */
  spawn(
    task: DispatchTask,
    runId: string,
    nodeId: string,
    attemptId?: string,
    signal?: AbortSignal,
  ): Promise<ManagedSpawnResponse | string>;
  /** Unscoped stop for non-managed callers. */
  stop(agentId: string): Promise<void>;
  /** Owner-scoped v3 stop used by workflow lifecycle operations. */
  stopOwned?(agentId: string, owner: WorkflowOwner): Promise<void>;
  /** Best-effort reconciliation for a spawn whose reply was lost after allocation. */
  reconcileManaged?(spawnKey: string, owner: WorkflowOwner): Promise<ManagedSpawnResponse | string | undefined>;
  quiesceOwned?(
    runId: string,
    agentIds: string[],
    timeoutMs?: number,
    owners?: WorkflowOwner[],
  ): Promise<{ settled: boolean; pending: string[] }>;
  /** Fresh capability and routing-policy check; workflow execution remains event-bus-only. */
  checkProtocol?: () => Promise<ManagedProtocolCheck>;
}

/** Event-bus-only client for the additive pi-subagents managed protocol. */
export function createManagedSpawnClient(
  events: WorkflowEventBus,
  protocolSignal?: AbortSignal,
  sessionSignal?: AbortSignal,
): ManagedSpawnClient {
  const call = <T>(
    channel: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 15_000,
  ): Promise<T> => callRpc(events, channel, payload, timeoutMs, signal);

  return {
    /**
     * Dispatch one managed agent call.
     *
     * `nodeId` is the runtime's `call-${callIndex}` and `attemptId` is
     * `attempt-${generation}`. The spawnKey is opaque to pi-subagents, so the
     * generation is the client-side rotation knob: when a resume replays a
     * changed call (local callHash differs from the journaled one), the engine
     * bumps the generation and this key changes — pi-subagents then treats the
     * new key as a fresh spawn instead of throwing its fingerprint-conflict
     * error for the same key with a different fingerprint. Same key + same
     * fingerprint still reuses the persisted tombstone (per-call cache).
     */
    async spawn(task, runId, nodeId, attemptId, signal) {
      const effectiveAttemptId = attemptId ?? `attempt-1`;
      const spawnKey = `${runId}/${nodeId}/${effectiveAttemptId}`;
      const requestSignal =
        signal && sessionSignal ? AbortSignal.any([signal, sessionSignal]) : (signal ?? sessionSignal);
      let data: unknown;
      try {
        data = await call<unknown>(
          "subagents:rpc:spawn-managed",
          {
            requestId: requestId(),
            spawnKey,
            type: task.subagent_type,
            prompt: task.prompt,
            description: task.description,
            ...(task.tier === undefined ? {} : { tier: task.tier }),
            ...(task.toolset === undefined ? {} : { toolset: task.toolset }),
            ...(task.thread === undefined ? {} : { thread: task.thread }),
            ...(task.excludeTools === undefined ? {} : { excludeTools: task.excludeTools }),
            ...(task.isolation === undefined ? {} : { isolation: task.isolation }),
            owner: { extension: "pi-workflows", runId, nodeId, attemptId: effectiveAttemptId },
          },
          requestSignal,
        );
      } catch (error: unknown) {
        // Reconciliation must not inherit the signal that caused the original
        // request to fail: shutdown/abort can happen after allocation but before
        // the reply. Fire it independently and preserve the original error.
        void call<unknown>(
          "subagents:rpc:reconcile-managed",
          {
            requestId: requestId(),
            spawnKey,
            owner: { extension: "pi-workflows", runId, nodeId, attemptId: effectiveAttemptId },
          },
          undefined,
          5_000,
        ).catch(() => undefined);
        throw error;
      }
      if (!isRecord(data) || typeof data.id !== "string" || data.id.length === 0) {
        throw new Error("subagents managed spawn returned an invalid agent id");
      }
      return parseManagedSpawnResponse(data);
    },
    async stop(agentId) {
      await call<void>("subagents:rpc:stop", { requestId: requestId(), agentId }, sessionSignal);
    },
    async stopOwned(agentId, owner) {
      await call<void>(
        "subagents:rpc:stop-owned",
        {
          requestId: requestId(),
          agentId,
          owner,
        },
        sessionSignal,
      );
    },
    async reconcileManaged(spawnKey, owner) {
      const data = await call<unknown>(
        "subagents:rpc:reconcile-managed",
        { requestId: requestId(), spawnKey, owner },
        undefined,
        5_000,
      );
      if (!isRecord(data) || typeof data.id !== "string") return undefined;
      return parseManagedSpawnResponse(data);
    },
    async quiesceOwned(runId, agentIds, timeoutMs = 5_000, owners) {
      const data = await call<unknown>(
        "subagents:rpc:quiesce-owned",
        {
          requestId: requestId(),
          owner: { extension: "pi-workflows", runId },
          agentIds,
          ...(owners ? { owners } : {}),
          timeoutMs,
        },
        sessionSignal,
        timeoutMs + 1_000,
      );
      if (!isRecord(data) || typeof data.settled !== "boolean" || !Array.isArray(data.pending)) {
        throw new Error("subagents quiescence returned an invalid response");
      }
      const pending = data.pending.filter((id): id is string => typeof id === "string");
      return { settled: data.settled, pending };
    },
    checkProtocol: () => checkManagedSpawnProtocol(events, protocolSignal),
  };
}

export function registerLifecycleListener(
  events: WorkflowEventBus,
  handler: (eventName: string, data: Record<string, unknown>) => void,
): () => void {
  const unsubs = [
    "subagents:created",
    "subagents:started",
    "subagents:completed",
    "subagents:failed",
    "subagents:compacted",
  ].map((eventName) =>
    events.on(eventName, (raw: unknown) => {
      if (isRecord(raw)) handler(eventName, raw);
    }),
  );
  return () => {
    for (const unsubscribe of unsubs) unsubscribe();
  };
}
