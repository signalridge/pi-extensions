import { CHILD_CONTEXT_CAPABILITY, PROTOCOL_CAPABILITIES, PROTOCOL_VERSION } from "./channels.js";
import type {
  ChildContextReply,
  ManagedOwner,
  ManagedProtocolCapabilities,
  ManagedProtocolPing,
  ManagedQuiescenceResponse,
  ManagedSpawnRequest,
  ManagedSpawnResponse,
  ManagedTerminalSnapshot,
  ManagedThinking,
  RpcReply,
  WorkflowTier,
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

const OWNER_KEYS = new Set(["extension", "runId", "nodeId", "attemptId"]);
const MANAGED_REQUEST_KEYS = new Set([
  "requestId",
  "spawnKey",
  "type",
  "prompt",
  "description",
  "tier",
  "model",
  "thinking",
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
const SPAWN_RESPONSE_KEYS = new Set(["id", "state", "created", "terminal"]);
const QUIESCENCE_KEYS = new Set(["settled", "pending", "diagnostic"]);
const CAPABILITY_KEYS = new Set([
  "managedSpawn",
  "lifecycleOwner",
  "ownedStop",
  "childContext",
  "ownedQuiescence",
  "workflowTiers",
  "managedPolicy",
]);

export function isWorkflowTier(value: unknown): value is WorkflowTier {
  return value === "small" || value === "medium" || value === "large";
}

export function isManagedThinking(value: unknown): value is ManagedThinking {
  return (
    value === "off" ||
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

export function parseManagedSpawnRequest(raw: unknown): ManagedSpawnRequest {
  const value = asRecord(raw, "managed spawn request");
  rejectUnknownKeys(value, MANAGED_REQUEST_KEYS, "managed spawn request");
  const owner = parseManagedOwner(value.owner, true);
  if (owner.attemptId === undefined) throw new Error("owner.attemptId is required");
  const tier = value.tier;
  if (tier !== undefined && !isWorkflowTier(tier)) {
    throw new Error("managed spawn tier must be one of small, medium, or large");
  }
  const model = value.model === undefined ? undefined : boundedString(value.model, "model", 512);
  const thinking = value.thinking === undefined ? undefined : value.thinking;
  if (thinking !== undefined && !isManagedThinking(thinking)) throw new Error("managed spawn thinking is invalid");
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
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
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
    if ((key === "childContext" || key === "workflowTiers" || key === "managedPolicy") && value[key] === undefined)
      continue;
    if (typeof value[key] !== "boolean") throw new Error(`protocol capability ${key} is invalid`);
  }
  return {
    managedSpawn: value.managedSpawn as boolean,
    lifecycleOwner: value.lifecycleOwner as boolean,
    ownedStop: value.ownedStop as boolean,
    ...(value.childContext === undefined ? {} : { childContext: value.childContext as boolean }),
    ownedQuiescence: value.ownedQuiescence as boolean,
    ...(value.workflowTiers === undefined ? {} : { workflowTiers: value.workflowTiers as boolean }),
    ...(value.managedPolicy === undefined ? {} : { managedPolicy: value.managedPolicy as boolean }),
  };
}

export function parseProtocolPing(raw: unknown): ManagedProtocolPing {
  const value = asRecord(raw, "protocol ping");
  rejectUnknownKeys(value, new Set(["version", "capabilities"]), "protocol ping");
  if (typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 1) {
    throw new Error("protocol version is invalid");
  }
  return { version: value.version, capabilities: parseCapabilities(value.capabilities) };
}

export function parseChildContextReply(raw: unknown): ChildContextReply {
  const value = asRecord(raw, "child context reply");
  rejectUnknownKeys(value, new Set(["child", "capability"]), "child context reply");
  if (typeof value.child !== "boolean" || value.capability !== CHILD_CONTEXT_CAPABILITY) {
    throw new Error("child context reply is invalid");
  }
  return { child: value.child, capability: CHILD_CONTEXT_CAPABILITY };
}

export function workflowTierCapabilityMatch(capabilities: ManagedProtocolCapabilities): boolean {
  return capabilities.workflowTiers === true;
}

export function requiredCapabilitiesMatch(capabilities: ManagedProtocolCapabilities): boolean {
  return (
    capabilities.managedSpawn === PROTOCOL_CAPABILITIES.managedSpawn &&
    capabilities.lifecycleOwner === PROTOCOL_CAPABILITIES.lifecycleOwner &&
    capabilities.ownedStop === PROTOCOL_CAPABILITIES.ownedStop &&
    capabilities.ownedQuiescence === PROTOCOL_CAPABILITIES.ownedQuiescence
  );
}

export function isCurrentProtocolVersion(version: number): boolean {
  return version === PROTOCOL_VERSION;
}
