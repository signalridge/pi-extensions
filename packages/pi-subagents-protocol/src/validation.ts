import { createHash } from "node:crypto";
import { CHILD_CONTEXT_CAPABILITY, PROTOCOL_CAPABILITIES, PROTOCOL_VERSION } from "./channels.js";
import type {
  ChildContextReply,
  ManagedAgentTierProfile,
  ManagedOwner,
  ManagedProtocolCapabilities,
  ManagedProtocolPing,
  ManagedQuiescenceResponse,
  ManagedRoutingPolicy,
  ManagedRoutingPolicySnapshot,
  ManagedSpawnRequest,
  ManagedSpawnResponse,
  ManagedTerminalSnapshot,
  ManagedTierThinking,
  RpcReply,
} from "./types.js";

export type RecordValue = Record<string, unknown>;

export function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

export function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return normalized;
}

export function rejectUnknownKeys(value: RecordValue, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field "${key}"`);
  }
}

/**
 * The single definition of a tier key's bound, for the wire and for its peers.
 *
 * pi-subagents re-exports this rather than restating it: a key it accepted but
 * the wire rejected could never reach a managed peer, so a second copy could
 * only ever be a way for the two to disagree.
 */
export const MAX_AGENT_TIER_KEY_LENGTH = 64;
/** Bounds a hand-edited catalogue; far above any realistic number of tiers. */
export const MAX_AGENT_TIER_PROFILES = 64;

const OWNER_KEYS = new Set(["extension", "runId", "nodeId", "attemptId"]);
const MANAGED_REQUEST_KEYS = new Set([
  "requestId",
  "spawnKey",
  "type",
  "prompt",
  "description",
  "tier",
  "toolset",
  "excludeTools",
  "isolation",
  "thread",
  "owner",
]);
const TERMINAL_KEYS = new Set([
  "status",
  "result",
  "error",
  "outputFile",
  "tokenCount",
  "compactionCount",
  "completedAt",
]);
const SPAWN_RESPONSE_KEYS = new Set(["id", "tier", "state", "created", "terminal"]);
const QUIESCENCE_KEYS = new Set(["settled", "pending", "diagnostic"]);
const CAPABILITY_KEYS = new Set([
  "managedSpawn",
  "lifecycleOwner",
  "ownedStop",
  "childContext",
  "ownedQuiescence",
  "agentTiers",
  "managedPolicy",
]);
const ROUTING_POLICY_KEYS = new Set(["defaultTier", "profiles", "blockedProfiles", "blockedDefaultTier"]);
const AGENT_PROFILE_KEYS = new Set(["model", "thinking"]);

/**
 * Agent-tier names are open to users but remain bounded, whitespace-free keys.
 *
 * The single definition, shared with pi-subagents for the reason given on
 * {@link MAX_AGENT_TIER_KEY_LENGTH}. Whitespace is excluded because the key is
 * rendered as a bare token in tool descriptions and error messages, where a key
 * containing a space would read as two keys.
 */
export function isManagedAgentTier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_AGENT_TIER_KEY_LENGTH &&
    value.trim() === value &&
    !/\s/u.test(value)
  );
}

export function isManagedTierThinking(value: unknown): value is ManagedTierThinking {
  return (
    value === "inherit" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

export function parseRpcRequestId(raw: unknown): string {
  return boundedString(asRecord(raw, "RPC request").requestId, "requestId", 128);
}

export function parseRpcReply<T = unknown>(value: unknown): RpcReply<T> {
  const record = asRecord(value, "RPC reply");
  const success = record.success;
  if (success === true) {
    rejectUnknownKeys(record, new Set(["success", "data"]), "RPC success reply");
    return {
      success: true,
      ...(Object.hasOwn(record, "data") ? { data: record.data as T } : {}),
    };
  }
  if (success === false) {
    rejectUnknownKeys(record, new Set(["success", "error"]), "RPC failure reply");
    return { success: false, error: boundedString(record.error, "RPC error", 2_000) };
  }
  throw new Error("RPC reply success flag is invalid");
}

export function parseManagedOwner(raw: unknown, requireAttempt = false): ManagedOwner {
  const value = asRecord(raw, "owner");
  rejectUnknownKeys(value, OWNER_KEYS, "owner");
  const extension = boundedString(value.extension, "owner.extension", 64);
  if (extension !== "pi-workflows") throw new Error('owner.extension must be "pi-workflows"');
  const attemptId = value.attemptId === undefined ? undefined : boundedString(value.attemptId, "owner.attemptId", 256);
  if (requireAttempt && attemptId === undefined) throw new Error("owner.attemptId is required");
  return {
    extension: "pi-workflows",
    runId: boundedString(value.runId, "owner.runId", 256),
    nodeId: boundedString(value.nodeId, "owner.nodeId", 256),
    ...(attemptId === undefined ? {} : { attemptId }),
  };
}

const TIER_KEY_DIAGNOSTIC = `must be a non-empty whitespace-free key of at most ${MAX_AGENT_TIER_KEY_LENGTH} characters`;

export function parseManagedSpawnRequest(raw: unknown): ManagedSpawnRequest {
  const value = asRecord(raw, "managed spawn request");
  rejectUnknownKeys(value, MANAGED_REQUEST_KEYS, "managed spawn request");
  const owner = parseManagedOwner(value.owner, true);
  if (owner.attemptId === undefined) throw new Error("owner.attemptId is required");
  const tier = value.tier;
  if (tier !== undefined && !isManagedAgentTier(tier)) {
    throw new Error(`managed spawn tier ${TIER_KEY_DIAGNOSTIC}`);
  }
  const toolset = value.toolset === undefined ? undefined : boundedString(value.toolset, "toolset", 128);
  const thread = value.thread === undefined ? undefined : boundedString(value.thread, "thread", 128);
  const excludeTools =
    value.excludeTools === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(value.excludeTools) || value.excludeTools.length > 64)
            throw new Error("excludeTools must contain at most 64 names");
          return value.excludeTools.map((name, index) => boundedString(name, `excludeTools[${index}]`, 128));
        })();
  const isolation = value.isolation === undefined ? undefined : value.isolation;
  if (isolation !== undefined && isolation !== "worktree") throw new Error("managed spawn isolation must be worktree");
  return {
    requestId: boundedString(value.requestId, "requestId", 128),
    spawnKey: boundedString(value.spawnKey, "spawnKey", 256),
    type: boundedString(value.type, "type", 128),
    prompt: boundedString(value.prompt, "prompt", 100_000),
    description: boundedString(value.description, "description", 512),
    ...(tier === undefined ? {} : { tier }),
    ...(toolset === undefined ? {} : { toolset }),
    ...(excludeTools === undefined ? {} : { excludeTools }),
    ...(isolation === undefined ? {} : { isolation }),
    ...(thread === undefined ? {} : { thread }),
    owner: { ...owner, attemptId: owner.attemptId },
  };
}

export function parseManagedTerminalSnapshot(raw: unknown): ManagedTerminalSnapshot {
  const value = asRecord(raw, "managed terminal snapshot");
  rejectUnknownKeys(value, TERMINAL_KEYS, "managed terminal snapshot");
  const status = value.status;
  if (status !== "completed" && status !== "failed" && status !== "stopped" && status !== "interrupted") {
    throw new Error("managed terminal snapshot status is invalid");
  }
  const compactionCount = value.compactionCount;
  const completedAt = value.completedAt;
  if (
    typeof compactionCount !== "number" ||
    !Number.isInteger(compactionCount) ||
    compactionCount < 0 ||
    typeof completedAt !== "number" ||
    !Number.isFinite(completedAt) ||
    completedAt < 0
  ) {
    throw new Error("managed terminal snapshot accounting is invalid");
  }
  const result = value.result === undefined ? undefined : boundedString(value.result, "managed terminal result", 8_000);
  const error = value.error === undefined ? undefined : boundedString(value.error, "managed terminal error", 2_000);
  const outputFile =
    value.outputFile === undefined ? undefined : boundedString(value.outputFile, "managed transcript pointer", 2_000);
  const tokenCount = value.tokenCount;
  if (tokenCount !== undefined && (typeof tokenCount !== "number" || !Number.isInteger(tokenCount) || tokenCount < 0)) {
    throw new Error("managed terminal token accounting is invalid");
  }
  return {
    status,
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
    ...(outputFile === undefined ? {} : { outputFile }),
    ...(tokenCount === undefined ? {} : { tokenCount }),
    compactionCount,
    completedAt,
  };
}

export function parseManagedSpawnResponse(raw: unknown): ManagedSpawnResponse {
  const value = asRecord(raw, "managed spawn response");
  rejectUnknownKeys(value, SPAWN_RESPONSE_KEYS, "managed spawn response");
  const id = boundedString(value.id, "managed spawn id", 128);
  const tier = value.tier;
  if (tier !== undefined && !isManagedAgentTier(tier))
    throw new Error(`managed spawn response tier ${TIER_KEY_DIAGNOSTIC}`);
  const state = value.state;
  if (
    state !== undefined &&
    state !== "queued" &&
    state !== "running" &&
    state !== "completed" &&
    state !== "failed" &&
    state !== "stopped" &&
    state !== "interrupted"
  ) {
    throw new Error("managed spawn state is invalid");
  }
  if (value.created !== undefined && typeof value.created !== "boolean") {
    throw new Error("managed spawn creation status is invalid");
  }
  const terminal = value.terminal === undefined ? undefined : parseManagedTerminalSnapshot(value.terminal);
  if (state !== undefined && state !== "queued" && state !== "running" && terminal === undefined) {
    throw new Error("managed spawn response omitted the terminal snapshot");
  }
  if (terminal !== undefined && state !== undefined && terminal.status !== state) {
    throw new Error("managed spawn response terminal state does not match state");
  }
  return {
    id,
    ...(tier === undefined ? {} : { tier }),
    ...(state === undefined ? {} : { state }),
    ...(value.created === undefined ? {} : { created: value.created }),
    ...(terminal === undefined ? {} : { terminal }),
  };
}

export function parseManagedQuiescenceResponse(raw: unknown): ManagedQuiescenceResponse {
  const value = asRecord(raw, "managed quiescence response");
  rejectUnknownKeys(value, QUIESCENCE_KEYS, "managed quiescence response");
  if (typeof value.settled !== "boolean") throw new Error("managed quiescence settled flag is invalid");
  if (!Array.isArray(value.pending) || value.pending.length > 256) {
    throw new Error("managed quiescence pending list is invalid");
  }
  const pending = value.pending.map((id, index) => boundedString(id, `managed quiescence pending[${index}]`, 128));
  const diagnostic =
    value.diagnostic === undefined
      ? undefined
      : boundedString(value.diagnostic, "managed quiescence diagnostic", 2_000);
  return { settled: value.settled, pending, ...(diagnostic === undefined ? {} : { diagnostic }) };
}

function parseCapabilities(raw: unknown): ManagedProtocolCapabilities {
  const value = asRecord(raw, "protocol capabilities");
  rejectUnknownKeys(value, CAPABILITY_KEYS, "protocol capabilities");
  for (const key of CAPABILITY_KEYS) {
    if (typeof value[key] !== "boolean") throw new Error(`protocol capability ${key} is invalid`);
  }
  return {
    managedSpawn: value.managedSpawn as boolean,
    lifecycleOwner: value.lifecycleOwner as boolean,
    ownedStop: value.ownedStop as boolean,
    childContext: value.childContext as boolean,
    ownedQuiescence: value.ownedQuiescence as boolean,
    agentTiers: value.agentTiers as boolean,
    managedPolicy: value.managedPolicy as boolean,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("routing policy contains an unsupported value");
}

/** Canonical JSON used by both the provider and the workflow peer. */
export function canonicalizeRoutingPolicy(policy: ManagedRoutingPolicy): string {
  return canonicalJson(policy);
}

/** Stable policy identity; object key ordering never changes the result. */
export function routingPolicyFingerprint(policy: ManagedRoutingPolicy): string {
  return createHash("sha256").update(canonicalizeRoutingPolicy(policy)).digest("hex");
}

/**
 * Everything about the host's policy that can change how ONE tier resolves.
 *
 * A caller's replay cache keys on this rather than on the whole-catalogue
 * fingerprint, so defining or editing an unrelated tier does not invalidate
 * work that never used it.
 *
 * The tier is required, and deliberately so. There is no honest per-tier
 * identity for a call that named none: the host resolves those against the
 * agent's own frontmatter tier *before* `defaultTier`, and frontmatter is not
 * on this wire — an agent is represented to a managed caller by its name only.
 * Folding in `defaultTier` for an omitted tier would therefore be wrong in both
 * directions, replaying work whose real tier had changed while invalidating
 * work that never touched the default. A caller with no tier to name has to
 * fall back to {@link routingPolicyFingerprint}.
 */
export function agentTierPolicyIdentity(policy: ManagedRoutingPolicy | undefined, tier: string): unknown {
  if (!policy) return null;
  const profile = policy.profiles[tier];
  return {
    tier,
    model: profile?.model ?? null,
    thinking: profile?.thinking ?? null,
    blocked: policy.blockedProfiles.includes(tier),
  };
}

/**
 * Reject, never normalize. `boundedString` trims, which would have quietly
 * turned `" low"` into `"low"` here while a profile key or `defaultTier`
 * carrying the same whitespace is refused outright — one validator disagreeing
 * with its own siblings about what a tier key is.
 */
function parseTierKeyList(raw: unknown, label: string, max: number): string[] {
  if (!Array.isArray(raw) || raw.length > max) throw new Error(`${label} is invalid`);
  const values = raw.map((value, index) => {
    if (!isManagedAgentTier(value)) throw new Error(`${label}[${index}] ${TIER_KEY_DIAGNOSTIC}`);
    return value;
  });
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
  return values;
}

function parseAgentTierProfile(raw: unknown, label: string): ManagedAgentTierProfile {
  const value = asRecord(raw, label);
  rejectUnknownKeys(value, AGENT_PROFILE_KEYS, label);
  const model = boundedString(value.model, `${label}.model`, 512);
  if (model !== "inherit" && /\s/u.test(model)) throw new Error(`${label}.model must not contain whitespace`);
  if (!isManagedTierThinking(value.thinking)) throw new Error(`${label}.thinking is invalid`);
  return { model, thinking: value.thinking };
}

function parseRoutingPolicy(raw: unknown): ManagedRoutingPolicy {
  const value = asRecord(raw, "routing policy");
  rejectUnknownKeys(value, ROUTING_POLICY_KEYS, "routing policy");
  const defaultTier = value.defaultTier;
  if (defaultTier !== null && !isManagedAgentTier(defaultTier)) {
    throw new Error("routing policy defaultTier is invalid");
  }
  const profiles = asRecord(value.profiles, "routing policy.profiles");
  if (Object.keys(profiles).length > MAX_AGENT_TIER_PROFILES) {
    throw new Error("routing policy has too many profiles");
  }
  const normalizedProfiles: Record<string, ManagedAgentTierProfile> = {};
  for (const [key, profile] of Object.entries(profiles)) {
    if (!isManagedAgentTier(key)) throw new Error("routing policy profile key is invalid");
    normalizedProfiles[key] = parseAgentTierProfile(profile, `Agent-tier profile ${key}`);
  }
  const blockedProfiles = parseTierKeyList(
    value.blockedProfiles,
    "routing policy.blockedProfiles",
    MAX_AGENT_TIER_PROFILES,
  );
  if (typeof value.blockedDefaultTier !== "boolean") throw new Error("routing policy blockedDefaultTier is invalid");
  return {
    defaultTier,
    profiles: normalizedProfiles,
    blockedProfiles,
    blockedDefaultTier: value.blockedDefaultTier,
  };
}

/**
 * The fingerprint on the wire is redundant by construction — the receiver has
 * the policy and recomputes it here — and that is exactly what it is for. A
 * peer whose canonicalization has drifted from ours would otherwise agree about
 * every field and disagree only about replay identity, which surfaces much
 * later as a run that re-executes work it should have replayed. Comparing the
 * two makes that a startup failure with a name instead.
 */
function parseRoutingPolicySnapshot(raw: unknown): ManagedRoutingPolicySnapshot {
  const value = asRecord(raw, "routing policy snapshot");
  rejectUnknownKeys(value, new Set(["policy", "fingerprint"]), "routing policy snapshot");
  const policy = parseRoutingPolicy(value.policy);
  const fingerprint = boundedString(value.fingerprint, "routing policy fingerprint", 64);
  if (!/^[0-9a-f]{64}$/u.test(fingerprint) || routingPolicyFingerprint(policy) !== fingerprint) {
    throw new Error("routing policy fingerprint is invalid");
  }
  return { policy, fingerprint };
}

export function parseProtocolPing(raw: unknown): ManagedProtocolPing {
  const value = asRecord(raw, "protocol ping");
  rejectUnknownKeys(value, new Set(["version", "capabilities", "routingPolicy", "maxConcurrent"]), "protocol ping");
  if (typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 1) {
    throw new Error("protocol version is invalid");
  }
  // Optional in both directions: an older peer sends no pool size, and a caller
  // that did not request one is not sent it. Absent is a fact the caller can
  // act on (fall back to its own default), so it is not an error here.
  if (
    value.maxConcurrent !== undefined &&
    (typeof value.maxConcurrent !== "number" || !Number.isInteger(value.maxConcurrent) || value.maxConcurrent < 1)
  ) {
    throw new Error("protocol ping maxConcurrent is invalid");
  }
  return {
    version: value.version,
    capabilities: parseCapabilities(value.capabilities),
    routingPolicy: parseRoutingPolicySnapshot(value.routingPolicy),
    ...(value.maxConcurrent === undefined ? {} : { maxConcurrent: value.maxConcurrent as number }),
  };
}

/**
 * Field names a ping request may ask the peer to include in its reply.
 *
 * The reply envelope is strictly validated, so a peer may only add a field a
 * caller asked for by name; anything else it volunteers breaks callers that
 * predate the field.
 */
export function parsePingIncludes(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set();
  const out = new Set<string>();
  for (const entry of raw.slice(0, 8)) if (typeof entry === "string" && entry.length <= 64) out.add(entry);
  return out;
}

export function parseChildContextReply(raw: unknown): ChildContextReply {
  const value = asRecord(raw, "child context reply");
  rejectUnknownKeys(value, new Set(["child", "capability"]), "child context reply");
  if (typeof value.child !== "boolean" || value.capability !== CHILD_CONTEXT_CAPABILITY) {
    throw new Error("child context reply is invalid");
  }
  return { child: value.child, capability: CHILD_CONTEXT_CAPABILITY };
}

/** Every v4 capability is required; there is no partial peer to negotiate with. */
export function requiredCapabilitiesMatch(capabilities: ManagedProtocolCapabilities): boolean {
  return (Object.keys(PROTOCOL_CAPABILITIES) as (keyof ManagedProtocolCapabilities)[]).every(
    (key) => capabilities[key] === PROTOCOL_CAPABILITIES[key],
  );
}

export function isCurrentProtocolVersion(version: number): boolean {
  return version === PROTOCOL_VERSION;
}
