import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentManager,
  MANAGED_SPAWN_ENTRY_TYPE,
  type ManagedSpawnPolicy,
  type ManagedSpawnTombstone,
} from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { validateManagedSpawnRequest } from "../src/cross-extension-rpc.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

const owner = {
  extension: "pi-workflows" as const,
  runId: "run-1",
  nodeId: "a",
  attemptId: "attempt-1",
};
const request = {
  requestId: "request-1",
  spawnKey: "run-1:a",
  type: "Explore",
  prompt: "inspect files",
  description: "Inspect files",
  owner,
};

const pi = {} as never;
const ctx = { cwd: "/tmp" } as never;

const managedPolicy: ManagedSpawnPolicy = {};

describe("managed spawn protocol", () => {
  let manager: AgentManager | undefined;
  let restoredManager: AgentManager | undefined;
  afterEach(async () => {
    await manager?.dispose();
    await restoredManager?.dispose();
  });

  it("rejects execution policy fields and invalid owners", () => {
    expect(() => validateManagedSpawnRequest({ ...request, model: "provider/model" })).toThrow(/unsupported field/);
    expect(() => validateManagedSpawnRequest({ ...request, owner: { ...owner, extension: "other" } })).toThrow(/owner.extension/);
    expect(() => validateManagedSpawnRequest({ ...request, prompt: "" })).toThrow(/prompt/);
  });

  it("publishes a synchronous managed startup failure exactly once", () => {
    const entries: ManagedSpawnTombstone[] = [];
    const complete = vi.fn();
    vi.mocked(runAgent).mockImplementation(() => {
      throw new Error("runner startup failed");
    });
    manager = new AgentManager(complete, 1, undefined, undefined, undefined, {
      append: (tombstone) => entries.push(tombstone),
    });

    const result = manager.spawnManaged(pi, ctx, request, managedPolicy);

    expect(result).toEqual(expect.objectContaining({ id: result.id, state: "failed", created: true }));
    expect(result.terminal?.error).toBe("runner startup failed");
    expect(complete).toHaveBeenCalledOnce();
    expect(entries.filter((entry) => entry.state === "failed")).toHaveLength(1);
    expect(manager.getRecord(result.id)).toBeUndefined();
  });

  it("fails closed when managed allocation has no persistence seam", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockClear();
    expect(() => manager.spawnManaged(pi, ctx, request, managedPolicy)).toThrow(/persistence is unavailable/);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("is idempotent for the same key and rejects conflicting requests", () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as never);
    manager = new AgentManager(undefined, 1, undefined, undefined, undefined, { append: () => {} });
    const first = manager.spawnManaged(pi, ctx, request, managedPolicy);
    expect(manager.spawnManaged(pi, ctx, request, managedPolicy).id).toBe(first.id);
    expect(() => manager.spawnManaged(pi, ctx, { ...request, prompt: "different" }, managedPolicy)).toThrow(/conflict/);
    expect(manager.getRecord(first.id)?.owner).toEqual(owner);
  });


  it("passes the required execution policy to runAgent", () => {
    const policy: ManagedSpawnPolicy = {
      maxTurns: 7,
      isolated: true,
      inheritContext: true,
    };
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as never);
    manager = new AgentManager(undefined, 1, undefined, undefined, undefined, { append: () => {} });

    const id = manager.spawnManaged(pi, ctx, { ...request, spawnKey: "run-1:policy" }, policy).id;
    const call = vi.mocked(runAgent).mock.calls.at(-1);
    if (!call) throw new Error("managed spawn did not start an agent");

    expect(call[3]).toEqual(expect.objectContaining({
      maxTurns: 7,
      isolated: true,
      inheritContext: true,
    }));
    manager.abort(id);
  });

  it("persists and restores the resolved workflow tier snapshot", () => {
    const entries: ManagedSpawnTombstone[] = [];
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      options.onTierResolved?.({
        tier: "medium",
        model: "test/fast",
        thinking: "medium",
        configuredModel: "test/fast",
        configuredThinking: "max",
        requestedThinking: "max",
        modelSource: "tier",
        thinkingSource: "tier",
        clamped: true,
        diagnostic: "clamped for test",
      });
      return new Promise(() => {}) as never;
    });
    manager = new AgentManager(undefined, 1, undefined, undefined, undefined, {
      append: (tombstone) => entries.push(tombstone),
    });

    const tieredRequest = { ...request, tier: "medium" as const, spawnKey: "run-1:snapshot" };
    const first = manager.spawnManaged(pi, ctx, tieredRequest, managedPolicy);
    const persisted = entries.at(-1);
    if (!persisted) throw new Error("workflow tombstone was not persisted");
    expect(first.id).toBe(persisted.id);
    expect(persisted.tier).toBe("medium");
    expect(persisted.tierSnapshot).toEqual(expect.objectContaining({
      tier: "medium",
      model: "test/fast",
      thinking: "medium",
      configuredThinking: "max",
      clamped: true,
    }));

    restoredManager = new AgentManager(undefined, 1, undefined, undefined, undefined, {
      append: () => {},
    });
    const recovered = restoredManager.restoreManagedSpawns([
      { type: "custom", customType: MANAGED_SPAWN_ENTRY_TYPE, data: persisted },
    ]);
    expect(recovered[0]?.tierSnapshot).toEqual(persisted.tierSnapshot);
    expect(restoredManager.getManagedSpawn(tieredRequest.spawnKey)?.tierSnapshot).toEqual(persisted.tierSnapshot);
  });

  it("restores a terminal tombstone across a manager reload without spawning again", async () => {
    const entries: ManagedSpawnTombstone[] = [];
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "persisted result",
      session: { dispose: vi.fn() } as never,
      aborted: false,
      steered: false,
    });
    manager = new AgentManager(undefined, 1, undefined, undefined, undefined, {
      append: (tombstone) => entries.push(tombstone),
    });
    const first = manager.spawnManaged(pi, ctx, request, managedPolicy);
    await manager.getRecordMutable(first.id)?.promise;
    const persisted = entries.at(-1);
    if (!persisted) throw new Error("managed tombstone was not persisted");
    manager.clearCompleted();
    vi.mocked(runAgent).mockClear();

    restoredManager = new AgentManager(undefined, 1, undefined, undefined, undefined, {
      append: (tombstone) => entries.push(tombstone),
    });
    restoredManager.restoreManagedSpawns([
      { type: "custom", customType: MANAGED_SPAWN_ENTRY_TYPE, data: persisted },
    ]);
    const restored = restoredManager.spawnManaged(pi, ctx, request, managedPolicy);
    expect(restored).toEqual(expect.objectContaining({ id: first.id, state: "completed" }));
    expect(restored.terminal?.result).toBe("persisted result");
    expect(runAgent).not.toHaveBeenCalled();
    expect(() => restoredManager.spawnManaged(pi, ctx, { ...request, requestId: "retry", prompt: "changed" }, managedPolicy)).toThrow(/conflict/);
  });

  it("settles an active restored tombstone as interrupted instead of hanging or duplicating", async () => {
    const entries: ManagedSpawnTombstone[] = [];
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as never);
    manager = new AgentManager(undefined, 1, undefined, undefined, undefined, {
      append: (tombstone) => entries.push(tombstone),
    });
    const first = manager.spawnManaged(pi, ctx, request, managedPolicy);
    const call = vi.mocked(runAgent).mock.calls.at(-1);
    if (!call) throw new Error("managed spawn did not start an agent");
    call[3]?.onCompaction?.({ reason: "manual", tokensBefore: 1 });
    const active = entries.at(-1);
    if (!active) throw new Error("active managed tombstone was not persisted");
    expect(active.compactionCount).toBe(1);
    await manager.dispose();
    vi.mocked(runAgent).mockClear();

    restoredManager = new AgentManager(undefined, 1, undefined, undefined, undefined, {
      append: (tombstone) => entries.push(tombstone),
    });
    const recovered = restoredManager.restoreManagedSpawns([
      { type: "custom", customType: MANAGED_SPAWN_ENTRY_TYPE, data: active },
    ]);
    expect(recovered[0]?.state).toBe("interrupted");
    expect(recovered[0]?.terminal?.compactionCount).toBe(1);
    const result = restoredManager.spawnManaged(pi, ctx, request, managedPolicy);
    expect(result).toEqual(expect.objectContaining({ id: first.id, state: "interrupted" }));
    expect(result.terminal?.error).toMatch(/no live AgentSession/);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("does not let public spawn options assign owner metadata", () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as never);
    manager = new AgentManager(undefined, 1);
    const id = manager.spawn(pi, ctx, "Explore", "public", {
      description: "public",
      isBackground: true,
      ...({ owner } as unknown as Record<string, unknown>),
    });
    expect(manager.getRecord(id)?.owner).toBeUndefined();
    manager.abort(id);
  });

  it("returns frozen record snapshots without exposing mutable owner state", async () => {
    let completedOwner: typeof owner | undefined;
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as never,
      aborted: false,
      steered: false,
    });
    manager = new AgentManager((record) => {
      completedOwner = record.owner;
    }, 1, undefined, undefined, undefined, { append: () => {} });

    const id = manager.spawnManaged(pi, ctx, request, managedPolicy).id;
    const exposed = manager.getRecord(id);
    if (!exposed?.owner) throw new Error("managed record owner was not exposed");
    expect(Object.isFrozen(exposed)).toBe(true);
    expect(Object.isFrozen(exposed.owner)).toBe(true);

    try {
      (exposed as unknown as { owner: { runId: string } }).owner.runId = "tampered";
    } catch {
      // Frozen snapshots may reject mutation in strict mode.
    }
    try {
      (exposed as unknown as { owner?: unknown }).owner = undefined;
    } catch {
      // Frozen snapshots may reject mutation in strict mode.
    }

    await manager.getRecordMutable(id)?.promise;
    const completedSnapshot = manager.getRecord(id);
    expect(completedSnapshot?.owner).toEqual(owner);
    expect(completedSnapshot).not.toHaveProperty("session");
    expect(manager.getRecordMutable(id)?.session).toBeDefined();
    expect(completedOwner).toEqual(owner);
  });

  it("uses spawnKey for the whole root session and preserves tombstones after record cleanup", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as never,
      aborted: false,
      steered: false,
    });
    manager = new AgentManager(undefined, 1, undefined, undefined, undefined, { append: () => {} });
    const first = manager.spawnManaged(pi, ctx, request, managedPolicy);
    await new Promise((resolve) => setImmediate(resolve));
    const record = manager.getRecordMutable(first.id);
    if (!record) throw new Error("managed record was not created");
    record.resultConsumed = true;
    manager.clearCompleted();
    expect(manager.getRecord(first.id)).toBeUndefined();
    expect(manager.spawnManaged(pi, ctx, request, managedPolicy).id).toBe(first.id);
    expect(() => manager.spawnManaged(pi, ctx, {
      ...request,
      owner: { ...owner, runId: "run-2" },
    }, managedPolicy)).toThrow(/conflict/);
  });

  it("forwards activity, session, usage, and compaction callbacks", () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as never);
    const callbacks = {
      onToolActivity: vi.fn(),
      onTextDelta: vi.fn(),
      onSessionCreated: vi.fn(),
      onTurnEnd: vi.fn(),
      onAssistantUsage: vi.fn(),
      onCompaction: vi.fn(),
    };
    manager = new AgentManager(undefined, 1, undefined, undefined, undefined, { append: () => {} });
    manager.spawnManaged(pi, ctx, request, managedPolicy, callbacks);
    const call = vi.mocked(runAgent).mock.calls.at(-1);
    if (!call) throw new Error("managed spawn did not start an agent");
    const options = call[3];
    expect(options?.onToolActivity).toEqual(expect.any(Function));
    expect(options?.onTextDelta).toEqual(expect.any(Function));
    expect(options?.onSessionCreated).toEqual(expect.any(Function));
    expect(options?.onTurnEnd).toEqual(expect.any(Function));
    expect(options?.onAssistantUsage).toEqual(expect.any(Function));
    expect(options?.onCompaction).toEqual(expect.any(Function));
    options?.onToolActivity?.({ type: "start", toolName: "read" });
    options?.onTextDelta?.("done", "done");
    options?.onTurnEnd?.(1);
    options?.onAssistantUsage?.({ input: 1, output: 2, cacheWrite: 0 });
    options?.onCompaction?.({ reason: "manual", tokensBefore: 10 });
    expect(callbacks.onToolActivity).toHaveBeenCalled();
    expect(callbacks.onTextDelta).toHaveBeenCalledWith("done", "done");
    expect(callbacks.onTurnEnd).toHaveBeenCalledWith(1);
    expect(callbacks.onAssistantUsage).toHaveBeenCalledWith({ input: 1, output: 2, cacheWrite: 0 });
    expect(callbacks.onCompaction).toHaveBeenCalledWith({ reason: "manual", tokensBefore: 10 });
  });

  it("quarantines a timed-out running agent before its late completion", async () => {
    let finish!: (value: {
      responseText: string;
      session: never;
      aborted: boolean;
      steered: boolean;
    }) => void;
    vi.mocked(runAgent).mockImplementation(
      () => new Promise((resolve) => {
        finish = resolve as typeof finish;
      }) as never,
    );
    const complete = vi.fn();
    const entries: ManagedSpawnTombstone[] = [];
    manager = new AgentManager(complete, 1, undefined, undefined, undefined, {
      append: (entry) => entries.push(entry),
    });
    const id = manager.spawnManaged(pi, ctx, request, managedPolicy).id;
    expect(await manager.quiesceOwned(owner.runId, [id], 1)).toEqual({ settled: false, pending: [id] });
    expect(await manager.quiesceOwned(owner.runId, [id], 1, [{ ...owner, attemptId: "attempt-2" }])).toEqual({ settled: false, pending: [id] });
    expect(manager.getRecord(id)?.detached).toBeUndefined();
    const quiesced = await manager.quiesceOwned(owner.runId, [id], 1, [owner]);
    expect(quiesced).toEqual({ settled: false, pending: [id] });
    expect(manager.getRecord(id)?.detached).toBe(true);
    const persistedCount = entries.length;

    finish({ responseText: "late result", session: { dispose: vi.fn() } as never, aborted: false, steered: false });
    await manager.getRecordMutable(id)?.promise;
    expect(complete).not.toHaveBeenCalled();
    expect(entries).toHaveLength(persistedCount);
  });

  it("suppresses every late callback after running and queued records detach", async () => {
    let finish!: (value: {
      responseText: string;
      session: never;
      aborted: boolean;
      steered: boolean;
    }) => void;
    let runOptions: Parameters<typeof runAgent>[3] | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      runOptions = options;
      return new Promise((resolve) => {
        finish = resolve as typeof finish;
      }) as never;
    });

    const complete = vi.fn();
    const started = vi.fn();
    const compacted = vi.fn();
    const created = vi.fn();
    const entries: ManagedSpawnTombstone[] = [];
    const callbacks = {
      onToolActivity: vi.fn(),
      onTextDelta: vi.fn(),
      onSessionCreated: vi.fn(),
      onTurnEnd: vi.fn(),
      onAssistantUsage: vi.fn(),
      onCompaction: vi.fn(),
      onSpawned: vi.fn(),
    };
    manager = new AgentManager(complete, 1, started, compacted, created, {
      append: (entry) => entries.push(entry),
    });

    const runningId = manager.spawnManaged(pi, ctx, request, managedPolicy, callbacks).id;
    const queuedId = manager.spawnManaged(pi, ctx, {
      ...request,
      spawnKey: "run-1:__synthesis__",
      owner: { ...owner, nodeId: "__synthesis__" },
      requestId: "request-synthesis",
    }, managedPolicy).id;
    expect(manager.getRecord(queuedId)?.status).toBe("queued");
    expect(started).toHaveBeenCalledTimes(1);
    expect(created).toHaveBeenCalledTimes(2);
    expect(callbacks.onSpawned).toHaveBeenCalledTimes(1);
    if (!runOptions) throw new Error("managed run did not expose callbacks");

    manager.detachForBranchChange();
    expect(manager.getRecord(runningId)?.detached).toBe(true);
    expect(manager.getRecord(queuedId)?.detached).toBe(true);
    manager.abortAll();
    const persistedCount = entries.length;

    runOptions.onToolActivity?.({ type: "end", toolName: "read" });
    runOptions.onTextDelta?.("late", "late");
    runOptions.onTurnEnd?.(2);
    runOptions.onAssistantUsage?.({ input: 1, output: 2, cacheWrite: 3 });
    runOptions.onSessionCreated?.({ dispose: vi.fn() } as never);
    runOptions.onCompaction?.({ reason: "manual", tokensBefore: 10 });
    finish({ responseText: "late result", session: { dispose: vi.fn() } as never, aborted: false, steered: false });
    await manager.getRecordMutable(runningId)?.promise;

    expect(complete).not.toHaveBeenCalled();
    expect(started).toHaveBeenCalledTimes(1);
    expect(compacted).not.toHaveBeenCalled();
    expect(created).toHaveBeenCalledTimes(2);
    expect(callbacks.onToolActivity).not.toHaveBeenCalled();
    expect(callbacks.onTextDelta).not.toHaveBeenCalled();
    expect(callbacks.onTurnEnd).not.toHaveBeenCalled();
    expect(callbacks.onAssistantUsage).not.toHaveBeenCalled();
    expect(callbacks.onSessionCreated).not.toHaveBeenCalled();
    expect(callbacks.onCompaction).not.toHaveBeenCalled();
    expect(entries).toHaveLength(persistedCount);
    expect(manager.getRecord(runningId)?.status).toBe("stopped");
    expect(manager.getRecord(queuedId)?.status).toBe("stopped");
  });
});
