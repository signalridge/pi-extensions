import assert from "node:assert/strict";
import { describe, expect, test } from "vitest";
import {
  agentTierPolicyIdentity,
  type ManagedProtocolCapabilities,
  type ManagedRoutingPolicy,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_VERSION,
  parseManagedOwner,
  parseManagedQuiescenceResponse,
  parseManagedSpawnRequest,
  parseManagedSpawnResponse,
  parseProtocolPing,
  parseRpcReply,
  replyChannel,
  requiredCapabilitiesMatch,
  routingPolicyFingerprint,
} from "../src/index.js";

const owner = {
  extension: "pi-workflows",
  runId: "run-1",
  nodeId: "task-1",
  attemptId: "run-1/task-1/attempt-1",
} as const;

const capabilities: ManagedProtocolCapabilities = { ...PROTOCOL_CAPABILITIES };

const policy: ManagedRoutingPolicy = {
  defaultTier: "medium",
  profiles: {
    low: { model: "inherit", thinking: "low" },
    medium: { model: "inherit", thinking: "medium" },
    strong: { model: "provider/model", thinking: "high" },
  },
  blockedProfiles: [],
  blockedDefaultTier: false,
};
const snapshot = { policy, fingerprint: routingPolicyFingerprint(policy) };

/** A well-formed snapshot for a variant policy, so a test fails on its own point. */
function snapshotOf(value: ManagedRoutingPolicy): Record<string, unknown> {
  return { policy: value, fingerprint: routingPolicyFingerprint(value) };
}

function ping(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: PROTOCOL_VERSION, capabilities, routingPolicy: snapshot, ...overrides };
}

test("keeps protocol channels and capabilities stable", () => {
  assert.equal(PROTOCOL_VERSION, 4);
  assert.equal(replyChannel("subagents:rpc:ping", "request-1"), "subagents:rpc:ping:reply:request-1");
  expect(requiredCapabilitiesMatch(capabilities)).toBe(true);
});

test("requires every v4 capability rather than negotiating a partial peer", () => {
  for (const key of Object.keys(capabilities) as (keyof ManagedProtocolCapabilities)[]) {
    const { [key]: _dropped, ...partial } = capabilities;
    expect(() => parseProtocolPing(ping({ capabilities: partial }))).toThrow(/capability/);
    expect(requiredCapabilitiesMatch({ ...capabilities, [key]: false })).toBe(false);
  }
});

test("requires routing-policy metadata on every ping", () => {
  expect(parseProtocolPing(ping())).toMatchObject({ version: PROTOCOL_VERSION, routingPolicy: snapshot });
  const { routingPolicy: _dropped, ...withoutPolicy } = ping();
  expect(() => parseProtocolPing(withoutPolicy)).toThrow(/routing policy/);
});

describe("managed request validation", () => {
  test("accepts managed identity and optional policy fields, and requires exact owner attempt", () => {
    expect(
      parseManagedSpawnRequest({
        requestId: "request-1",
        spawnKey: "run-1/task-1/attempt-1",
        type: "general-purpose",
        prompt: "Return the result.",
        description: "Task 1",
        owner,
      }),
    ).toEqual({
      requestId: "request-1",
      spawnKey: "run-1/task-1/attempt-1",
      type: "general-purpose",
      prompt: "Return the result.",
      description: "Task 1",
      owner,
    });

    expect(
      parseManagedSpawnRequest({
        requestId: "request-1",
        spawnKey: "run-1/task-1/attempt-1",
        type: "general-purpose",
        prompt: "Return the result.",
        description: "Task 1",
        tier: "low",
        toolset: "web-research",
        excludeTools: ["workflow"],
        isolation: "worktree",
        thread: "review",
        owner,
      }),
    ).toMatchObject({
      tier: "low",
      toolset: "web-research",
      isolation: "worktree",
      thread: "review",
    });
  });

  test("carries an open Agent-tier key and rejects a malformed one", () => {
    const base = {
      requestId: "request-1",
      spawnKey: "run-1/task-1/attempt-1",
      type: "general-purpose",
      prompt: "Return the result.",
      description: "Task 1",
      owner,
    };
    expect(parseManagedSpawnRequest({ ...base, tier: "my-cheap-tier" }).tier).toBe("my-cheap-tier");
    expect(() => parseManagedSpawnRequest({ ...base, tier: "bad tier" })).toThrow(/tier/);
    expect(() => parseManagedSpawnRequest({ ...base, tier: "" })).toThrow(/tier/);
    expect(() => parseManagedSpawnRequest({ ...base, tier: "x".repeat(65) })).toThrow(/tier/);
  });

  test("rejects a per-call model or thinking selector", () => {
    const base = {
      requestId: "request-1",
      spawnKey: "run-1/task-1/attempt-1",
      type: "general-purpose",
      prompt: "Return the result.",
      description: "Task 1",
      owner,
    };
    expect(() => parseManagedSpawnRequest({ ...base, model: "provider/model" })).toThrow(/unsupported field "model"/);
    expect(() => parseManagedSpawnRequest({ ...base, thinking: "high" })).toThrow(/unsupported field "thinking"/);
  });

  test("rejects wrong owners and malformed attempts", () => {
    expect(() => parseManagedOwner({ ...owner, extension: "other" }, true)).toThrow(/owner.extension/);
    expect(() => parseManagedOwner({ ...owner, attemptId: "" }, true)).toThrow(/attemptId/);
  });
});

test("validates bounded replies and terminal states", () => {
  expect(parseRpcReply({ success: true, data: { ok: true } })).toEqual({ success: true, data: { ok: true } });
  expect(() => parseRpcReply({ success: false, error: "" })).toThrow(/RPC error/);
  expect(
    parseManagedSpawnResponse({
      id: "agent-1",
      tier: "low",
      state: "completed",
      created: true,
      terminal: { status: "completed", result: "done", compactionCount: 1, completedAt: 10 },
    }),
  ).toEqual({
    id: "agent-1",
    tier: "low",
    state: "completed",
    created: true,
    terminal: { status: "completed", result: "done", compactionCount: 1, completedAt: 10 },
  });
  expect(() => parseManagedSpawnResponse({ id: "agent-1", state: "completed" })).toThrow(/terminal snapshot/);
});

test("validates canonical routing-policy fingerprints in protocol ping metadata", () => {
  const reordered: ManagedRoutingPolicy = {
    blockedDefaultTier: policy.blockedDefaultTier,
    blockedProfiles: policy.blockedProfiles,
    profiles: { strong: policy.profiles.strong, low: policy.profiles.low, medium: policy.profiles.medium },
    defaultTier: policy.defaultTier,
  };
  expect(routingPolicyFingerprint(reordered)).toBe(snapshot.fingerprint);
  expect(parseProtocolPing(ping())).toMatchObject({ routingPolicy: snapshot });
  expect(() => parseProtocolPing(ping({ routingPolicy: { ...snapshot, fingerprint: "0".repeat(64) } }))).toThrow(
    /fingerprint/,
  );
});

test("holds every tier key in the policy to the same shape rule", () => {
  // `blockedProfiles` used to be validated with a helper that trims first, so
  // `" low"` became `"low"` there while the same value in `profiles` or
  // `defaultTier` was refused. One validator, one answer: all three reject.
  const badKey = " low";
  expect(() =>
    parseProtocolPing(ping({ routingPolicy: snapshotOf({ ...policy, blockedProfiles: [badKey] }) })),
  ).toThrow(/blockedProfiles/);
  expect(() =>
    parseProtocolPing(
      ping({ routingPolicy: snapshotOf({ ...policy, profiles: { [badKey]: { model: "inherit", thinking: "low" } } }) }),
    ),
  ).toThrow(/profile key/);
  expect(() => parseProtocolPing(ping({ routingPolicy: snapshotOf({ ...policy, defaultTier: badKey }) }))).toThrow(
    /defaultTier/,
  );
});

describe("per-tier policy identity", () => {
  test("changes only when the named tier's own policy changes", () => {
    const before = agentTierPolicyIdentity(policy, "low");
    const unrelated: ManagedRoutingPolicy = {
      ...policy,
      profiles: { ...policy.profiles, strong: { model: "provider/other", thinking: "max" } },
    };
    expect(agentTierPolicyIdentity(unrelated, "low")).toEqual(before);
    expect(routingPolicyFingerprint(unrelated)).not.toBe(snapshot.fingerprint);

    const changed: ManagedRoutingPolicy = {
      ...policy,
      profiles: { ...policy.profiles, low: { model: "inherit", thinking: "high" } },
    };
    expect(agentTierPolicyIdentity(changed, "low")).not.toEqual(before);
  });

  test("reports a blocked tier, an undefined one, and no policy at all", () => {
    expect(agentTierPolicyIdentity({ ...policy, blockedProfiles: ["low"] }, "low")).toMatchObject({ blocked: true });
    // A tier the catalogue does not define still has an identity: "not defined
    // here" is itself a policy, and it has to change when the tier appears.
    expect(agentTierPolicyIdentity(policy, "absent")).toEqual({
      tier: "absent",
      model: null,
      thinking: null,
      blocked: false,
    });
    expect(agentTierPolicyIdentity(undefined, "low")).toBeNull();
  });

  test("never folds in defaultTier, because frontmatter outranks it and is invisible here", () => {
    // The host resolves an unnamed tier as `call > agent frontmatter > default`.
    // A caller that keyed such a call on `defaultTier` would be wrong twice
    // over: stale on an edit to the tier the agent actually declares, and
    // needlessly invalidated by an edit to a default it never reached. So the
    // identity is only ever asked about a tier someone actually named, and a
    // caller with none falls back to the whole-catalogue fingerprint.
    const withOtherDefault: ManagedRoutingPolicy = { ...policy, defaultTier: "low" };
    expect(agentTierPolicyIdentity(withOtherDefault, "medium")).toEqual(agentTierPolicyIdentity(policy, "medium"));
    expect(routingPolicyFingerprint(withOtherDefault)).not.toBe(snapshot.fingerprint);
  });
});

test("bounds quiescence output", () => {
  expect(parseManagedQuiescenceResponse({ settled: false, pending: ["agent-1"] })).toEqual({
    settled: false,
    pending: ["agent-1"],
  });
  expect(() => parseProtocolPing(ping({ capabilities: { managedSpawn: true } }))).toThrow(/capability/);
});
