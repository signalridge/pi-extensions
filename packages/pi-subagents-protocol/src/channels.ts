/** Stable event-bus channel names for the managed subagent protocol. */

/**
 * Protocol v4.
 *
 * v4 removed the `small | medium | large` workflow-tier vocabulary and its
 * mapping layer: a managed request now names an Agent tier directly and
 * `resolveAgentTier` in pi-subagents is the only resolver. Every capability is
 * required — a peer that cannot answer one is not a v4 peer.
 */
export const PROTOCOL_VERSION = 4;

export const PROTOCOL_CAPABILITIES = {
  managedSpawn: true,
  lifecycleOwner: true,
  ownedStop: true,
  childContext: true,
  ownedQuiescence: true,
  /** The peer accepts a request-level Agent tier and publishes its tier policy. */
  agentTiers: true,
  managedPolicy: true,
} as const;

export const RPC_CHANNELS = {
  context: "subagents:rpc:context",
  ping: "subagents:rpc:ping",
  spawn: "subagents:rpc:spawn",
  spawnManaged: "subagents:rpc:spawn-managed",
  stop: "subagents:rpc:stop",
  stopOwned: "subagents:rpc:stop-owned",
  quiesceOwned: "subagents:rpc:quiesce-owned",
  reconcileManaged: "subagents:rpc:reconcile-managed",
} as const;

export const LIFECYCLE_CHANNELS = [
  "subagents:created",
  "subagents:started",
  "subagents:completed",
  "subagents:failed",
  "subagents:compacted",
] as const;

export const CHILD_CONTEXT_CAPABILITY = "childContext" as const;

export function replyChannel(channel: string, requestId: string): string {
  return `${channel}:reply:${requestId}`;
}
