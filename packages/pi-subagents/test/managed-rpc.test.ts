import { describe, expect, it, vi } from "vitest";
import { type EventBus, registerRpcHandlers } from "../src/cross-extension-rpc.js";

function bus(): EventBus {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(event, handler) {
      const set = listeners.get(event) ?? new Set<(data: unknown) => void>();
      set.add(handler);
      listeners.set(event, set);
      return () => set.delete(handler);
    },
    emit(event, data) {
      for (const handler of listeners.get(event) ?? []) handler(data);
    },
  };
}

describe("managed spawn RPC", () => {
  it("forwards only the policy-free request and returns an id", async () => {
    const events = bus();
    const spawnManaged = vi.fn().mockReturnValue("agent-managed");
    const manager = {
      spawn: vi.fn(),
      spawnManaged,
      abort: vi.fn(),
    };
    registerRpcHandlers({ events, pi: {}, getCtx: () => ({}), manager });
    const reply = vi.fn();
    events.on("subagents:rpc:spawn-managed:reply:req-1", reply);
    events.emit("subagents:rpc:spawn-managed", {
      requestId: "req-1",
      spawnKey: "run-1:a",
      type: "Explore",
      prompt: "find files",
      description: "Find files",
      owner: { extension: "pi-workflows", runId: "run-1", nodeId: "a", attemptId: "attempt-1" },
    });
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply).toHaveBeenCalledWith({ success: true, data: { id: "agent-managed", state: "running" } });
    expect(spawnManaged).toHaveBeenCalledWith(
      {},
      {},
      expect.objectContaining({ spawnKey: "run-1:a", owner: { extension: "pi-workflows", runId: "run-1", nodeId: "a", attemptId: "attempt-1" } }),
      {},
    );
  });

  it("advertises protocol v3 capabilities through ping", async () => {
    const events = bus();
    registerRpcHandlers({ events, pi: {}, getCtx: () => ({}), manager: { spawn: vi.fn(), spawnManaged: vi.fn(), abort: vi.fn() } });
    const reply = vi.fn();
    events.on("subagents:rpc:ping:reply:ping-1", reply);
    events.emit("subagents:rpc:ping", { requestId: "ping-1" });
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({
      success: true,
      data: {
        version: 3,
        capabilities: { managedSpawn: true, lifecycleOwner: true, ownedStop: true, childContext: true, ownedQuiescence: true, workflowTiers: true },
      },
    }));
  });

  it("rejects arbitrary execution options", async () => {
    const events = bus();
    const spawnManaged = vi.fn();
    registerRpcHandlers({ events, pi: {}, getCtx: () => ({}), manager: { spawn: vi.fn(), spawnManaged, abort: vi.fn() } });
    const reply = vi.fn();
    events.on("subagents:rpc:spawn-managed:reply:req-2", reply);
    events.emit("subagents:rpc:spawn-managed", {
      requestId: "req-2",
      spawnKey: "run-1:a",
      type: "Explore",
      prompt: "find files",
      description: "Find files",
      owner: { extension: "pi-workflows", runId: "run-1", nodeId: "a", attemptId: "attempt-1" },
      maxTurns: 3,
    });
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply.mock.calls[0]?.[0]).toEqual({ success: false, error: expect.stringContaining("unsupported field") });
    expect(spawnManaged).not.toHaveBeenCalled();
  });

  it("strips owner metadata from legacy spawn without changing its options contract", async () => {
    const events = bus();
    const spawn = vi.fn().mockReturnValue("legacy-agent");
    registerRpcHandlers({ events, pi: {}, getCtx: () => ({}), manager: { spawn, spawnManaged: vi.fn(), abort: vi.fn() } });
    const reply = vi.fn();
    events.on("subagents:rpc:spawn:reply:legacy-1", reply);
    events.emit("subagents:rpc:spawn", {
      requestId: "legacy-1",
      type: "Explore",
      prompt: "find files",
      options: {
        description: "legacy",
        isBackground: true,
        owner: { extension: "pi-workflows", runId: "run-1", nodeId: "a", attemptId: "attempt-1" },
      },
    });
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(spawn).toHaveBeenCalledWith({}, {}, "Explore", "find files", {
      description: "legacy",
      isBackground: true,
    });
    expect(spawn.mock.calls[0]?.[4]).not.toHaveProperty("owner");
  });

  it("requires attempt-scoped owners for lifecycle controls", async () => {
    const events = bus();
    const abortOwned = vi.fn();
    const quiesceOwned = vi.fn().mockResolvedValue({ settled: true, pending: [] });
    registerRpcHandlers({
      events,
      pi: {},
      getCtx: () => ({}),
      manager: { spawn: vi.fn(), spawnManaged: vi.fn(), abort: vi.fn(), abortOwned, quiesceOwned },
    });

    const stopReply = vi.fn();
    events.on("subagents:rpc:stop-owned:reply:owner-1", stopReply);
    events.emit("subagents:rpc:stop-owned", {
      requestId: "owner-1",
      agentId: "agent-1",
      owner: { extension: "pi-workflows", runId: "run-1", nodeId: "a" },
    });
    await vi.waitFor(() => expect(stopReply).toHaveBeenCalled());
    expect(stopReply.mock.calls[0]?.[0]).toEqual({ success: false, error: expect.stringContaining("attemptId") });
    expect(abortOwned).not.toHaveBeenCalled();

    const quiesceReply = vi.fn();
    events.on("subagents:rpc:quiesce-owned:reply:owner-2", quiesceReply);
    events.emit("subagents:rpc:quiesce-owned", {
      requestId: "owner-2",
      owner: { extension: "pi-workflows", runId: "run-1" },
      agentIds: ["agent-1"],
      timeoutMs: 10,
    });
    await vi.waitFor(() => expect(quiesceReply).toHaveBeenCalled());
    expect(quiesceReply.mock.calls[0]?.[0]).toEqual({ success: false, error: "owners must match agentIds" });
    expect(quiesceOwned).not.toHaveBeenCalled();
  });
});
