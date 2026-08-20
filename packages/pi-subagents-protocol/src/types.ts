/** Pure wire types shared by managed Pi extension peers. */

export type WorkflowTier = "small" | "medium" | "large";
export type ManagedThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
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
  /** Semantic workflow profile; model and thinking are resolved by pi-subagents. */
  tier?: WorkflowTier;
  /** Optional exact provider/model reference, optionally suffixed with `:thinking`. */
  model?: string;
  /** Optional thinking override; `off` omits a thinking-level override. */
  thinking?: ManagedThinking;
  /** Optional named toolset hint owned by pi-subagents/host configuration. */
  toolset?: string;
  /** Additional tool names to deny for this managed child. */
  excludeTools?: string[];
  /** Per-call worktree request; creation and cleanup remain owned by pi-subagents. */
  isolation?: "worktree";
  /** Named sequential-thread hint; session reuse policy remains owned by pi-subagents. */
  thread?: string;
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
  /** True when managed model/tool/isolation overrides are accepted. */
  managedPolicy?: boolean;
}

export interface ManagedProtocolPing {
  version: number;
  capabilities: ManagedProtocolCapabilities;
}

export interface ChildContextReply {
  child: boolean;
  capability: "childContext";
}
