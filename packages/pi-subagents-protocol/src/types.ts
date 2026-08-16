/** Pure wire types shared by managed Pi extension peers. */

export type WorkflowTier = "small" | "medium" | "large";
export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

export type RpcReply<T = unknown> = { success: true; data?: T } | { success: false; error: string };

export interface ManagedOwner {
  extension: "pi-workflows";
  runId: string;
  nodeId: string;
  attemptId?: string;
}

export interface ManagedRunOwner {
  extension: "pi-workflows";
  runId: string;
}

export interface ManagedSpawnRequest {
  requestId: string;
  spawnKey: string;
  type: string;
  prompt: string;
  description: string;
  /** Semantic workflow profile; model and thinking stay owned by pi-subagents. */
  tier?: WorkflowTier;
  owner: ManagedOwner & { attemptId: string };
}

export type ManagedSpawnState = "queued" | "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface ManagedTerminalSnapshot {
  status: Exclude<ManagedSpawnState, "queued" | "running">;
  result?: string;
  error?: string;
  outputFile?: string;
  tokenCount?: number;
  compactionCount: number;
  completedAt: number;
}

export interface ManagedSpawnResponse {
  id: string;
  state?: ManagedSpawnState;
  created?: boolean;
  terminal?: ManagedTerminalSnapshot;
}

export interface ManagedQuiescenceResponse {
  settled: boolean;
  pending: string[];
  diagnostic?: string;
}

export interface ManagedProtocolCapabilities {
  managedSpawn: boolean;
  lifecycleOwner: boolean;
  ownedStop: boolean;
  /** Optional in v3 for peers that do not expose the factory-time child marker. */
  childContext?: boolean;
  ownedQuiescence: boolean;
  /** Optional in v3 for older peers; required before sending tiered requests. */
  workflowTiers?: boolean;
}

export interface ManagedProtocolPing {
  version: number;
  capabilities: ManagedProtocolCapabilities;
}

export interface ChildContextReply {
  child: boolean;
  capability: "childContext";
}
