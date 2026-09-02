/** Pure wire types shared by managed Pi extension peers. */

/**
 * Thinking policy an Agent-tier profile may declare.
 *
 * `inherit` keeps the parent session's level. `off` is deliberately absent: a
 * profile that wants no thinking says so through the model it names, and the
 * host's `clampThinkingLevel` handles a model that supports none.
 */
export type ManagedTierThinking = "inherit" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
  /**
   * Agent-tier key. This is the host's own tier vocabulary, not a separate
   * workflow one: the host resolves it with the same resolver, precedence, and
   * fail-closed errors that an ordinary Agent spawn gets. Omitted means "use
   * the agent's own tier, else `agentTiers.defaultTier`".
   *
   * Model and thinking are deliberately not on this request. A tier is the only
   * model policy a managed caller can express, so there is no second selector
   * that could silently win or be silently ignored.
   */
  tier?: string;
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
  /** Agent tier the host actually selected, including one it defaulted to. */
  tier?: string;
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
  childContext: boolean;
  ownedQuiescence: boolean;
  agentTiers: boolean;
  managedPolicy: boolean;
}

export interface ManagedAgentTierProfile {
  /** Profile model reference, including the provider-neutral "inherit" value. */
  model: string;
  /** Profile thinking policy before model-specific clamping. */
  thinking: ManagedTierThinking;
}

/**
 * The host's Agent-tier catalogue as a caller needs to see it.
 *
 * A managed caller does not resolve policy — it uses this to decide whether a
 * previously journaled call would still resolve the same way, so a resume can
 * replay it. Descriptions and other host-only UI fields are excluded.
 */
export interface ManagedRoutingPolicy {
  defaultTier: string | null;
  profiles: Record<string, ManagedAgentTierProfile>;
  blockedProfiles: string[];
  blockedDefaultTier: boolean;
}

export interface ManagedRoutingPolicySnapshot {
  policy: ManagedRoutingPolicy;
  fingerprint: string;
}

export interface ManagedProtocolPing {
  version: number;
  capabilities: ManagedProtocolCapabilities;
  routingPolicy: ManagedRoutingPolicySnapshot;
  /**
   * The peer's live background-agent pool size, present only when the request
   * asked for it (`include: ["maxConcurrent"]`).
   *
   * Requested rather than always sent, because a ping envelope is parsed with
   * `rejectUnknownKeys`: a field a peer never asked for would make every
   * already-published client reject the handshake outright. A caller that does
   * not ask gets the v4 envelope unchanged, and a caller that asks an older
   * peer gets no field and falls back to its own default.
   */
  maxConcurrent?: number;
}

export interface ChildContextReply {
  child: boolean;
  capability: "childContext";
}
