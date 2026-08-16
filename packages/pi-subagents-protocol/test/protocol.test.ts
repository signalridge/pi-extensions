import assert from "node:assert/strict";
import { describe, expect, test } from "vitest";
import {
  PROTOCOL_VERSION,
  parseManagedOwner,
  parseManagedQuiescenceResponse,
  parseManagedSpawnRequest,
  parseManagedSpawnResponse,
  parseProtocolPing,
  parseRpcReply,
  replyChannel,
  requiredCapabilitiesMatch,
} from "../src/index.js";

const owner = {
  extension: "pi-workflows",
  runId: "run-1",
  nodeId: "task-1",
  attemptId: "run-1/task-1/attempt-1",
} as const;

test("keeps protocol channels and capabilities stable", () => {
  assert.equal(PROTOCOL_VERSION, 3);
  assert.equal(replyChannel("subagents:rpc:ping", "request-1"), "subagents:rpc:ping:reply:request-1");
  expect(
    requiredCapabilitiesMatch({
      managedSpawn: true,
      lifecycleOwner: true,
      ownedStop: true,
      childContext: true,
      ownedQuiescence: true,
    }),
  ).toBe(true);
});

describe("managed request validation", () => {
  test("accepts the policy-free request and requires exact owner attempt", () => {
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

    expect(() =>
      parseManagedSpawnRequest({
        requestId: "request-1",
        spawnKey: "run-1/task-1/attempt-1",
        type: "general-purpose",
        prompt: "Return the result.",
        description: "Task 1",
        owner,
        model: "should-not-cross-the-boundary",
      }),
    ).toThrow(/unsupported field/);
  });

  test("accepts only semantic workflow tiers", () => {
    expect(
      parseManagedSpawnRequest({
        requestId: "request-1",
        spawnKey: "run-1/task-1/attempt-1",
        type: "general-purpose",
        prompt: "Return the result.",
        description: "Task 1",
        tier: "small",
        owner,
      }).tier,
    ).toBe("small");
    expect(() =>
      parseManagedSpawnRequest({
        requestId: "request-1",
        spawnKey: "run-1/task-1/attempt-1",
        type: "general-purpose",
        prompt: "Return the result.",
        description: "Task 1",
        tier: "high",
        owner,
      }),
    ).toThrow(/one of small, medium, or large/);
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
      state: "completed",
      created: true,
      terminal: {
        status: "completed",
        result: "done",
        compactionCount: 1,
        completedAt: 10,
      },
    }),
  ).toEqual({
    id: "agent-1",
    state: "completed",
    created: true,
    terminal: {
      status: "completed",
      result: "done",
      compactionCount: 1,
      completedAt: 10,
    },
  });
  expect(() => parseManagedSpawnResponse({ id: "agent-1", state: "completed" })).toThrow(/terminal snapshot/);
});

test("bounds quiescence output and ping capabilities", () => {
  expect(parseManagedQuiescenceResponse({ settled: false, pending: ["agent-1"] })).toEqual({
    settled: false,
    pending: ["agent-1"],
  });
  const ping = parseProtocolPing({
    version: 3,
    capabilities: {
      managedSpawn: true,
      lifecycleOwner: true,
      ownedStop: true,
      childContext: true,
      ownedQuiescence: true,
    },
  });
  assert.equal(ping.version, 3);
  expect(() => parseProtocolPing({ version: 3, capabilities: { managedSpawn: true } })).toThrow(/capability/);
});
