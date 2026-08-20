/** Stable event-bus channel names for the managed subagent protocol. */

export const PROTOCOL_VERSION = 3;

export const PROTOCOL_CAPABILITIES = {
  managedSpawn: true,
  lifecycleOwner: true,
  ownedStop: true,
  childContext: true,
  ownedQuiescence: true,
  workflowTiers: true,
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
