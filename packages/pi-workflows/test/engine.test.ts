import { describe, expect, it, vi } from "vitest";
import { WorkflowEngine } from "../src/engine.js";
import type { JournalEvent, SessionEntryLike } from "../src/journal.js";
import type { ManagedSpawnClient, ManagedSpawnResponse, WorkflowEventBus } from "../src/rpc-client.js";

class Bus implements WorkflowEventBus {
  private listeners = new Map<string, Set<(data: unknown) => void>>();
  constructor(private readonly fillAttemptIds = true) {}
  on(event: string, handler: (data: unknown) => void): () => void {
    const handlers = this.listeners.get(event) ?? new Set<(data: unknown) => void>();
    handlers.add(handler);
    this.listeners.set(event, handlers);
    return () => handlers.delete(handler);
  }
  emit(event: string, data: unknown): void {
    const value = data as Record<string, unknown> | null;
    const owner = value && typeof value === "object" ? (value.owner as Record<string, unknown> | undefined) : undefined;
    const enriched =
      this.fillAttemptIds &&
      owner &&
      typeof owner.runId === "string" &&
      typeof owner.nodeId === "string" &&
      owner.attemptId === undefined
        ? { ...value, owner: { ...owner, attemptId: `${owner.runId}/${owner.nodeId}/attempt-1` } }
        : data;
    for (const handler of this.listeners.get(event) ?? []) handler(enriched);
  }
}

class FaultJournal {
  readonly events: JournalEvent[] = [];
  private failed = false;
  private armed = false;

  constructor(private readonly failKind: JournalEvent["kind"]) {}

  arm(): void {
    this.armed = true;
  }

  append(event: JournalEvent): void {
    if (this.armed && !this.failed && event.kind === this.failKind) {
      this.failed = true;
      throw new Error(`injected ${event.kind} append failure`);
    }
    this.events.push(event);
  }
}
const ctx = {} as never;
const definition = {
  name: "parallel",
  phases: [],
  tasks: [
    { id: "a", subagent_type: "Explore", description: "A", prompt: "A", depends_on: [] },
    { id: "b", subagent_type: "Explore", description: "B", prompt: "B", depends_on: [] },
    { id: "c", subagent_type: "Explore", description: "C", prompt: "C", depends_on: ["a", "b"] },
  ],
  synthesis: { subagent_type: "general-purpose", prompt: "Synthesize" },
  background: false,
};
const firstDefinitionTask = definition.tasks[0];
if (!firstDefinitionTask) throw new Error("definition has no tasks");

describe("workflow engine", () => {
  it("dispatches all ready tasks, waits for dependencies, then synthesizes", async () => {
    const bus = new Bus();
    const journal: JournalEvent[] = [];
    const spawned: string[] = [];
    const spawnedTiers = new Map<string, string | undefined>();
    const client: ManagedSpawnClient = {
      async spawn(task, runId, nodeId) {
        const id = `${nodeId}-agent`;
        spawned.push(id);
        spawnedTiers.set(nodeId, task.tier);
        bus.emit("subagents:created", { id, owner: { extension: "pi-workflows", runId, nodeId } });
        bus.emit("subagents:started", { id, owner: { extension: "pi-workflows", runId, nodeId } });
        return id;
      },
      async stop() {},
    };
    const engine = new WorkflowEngine(bus, client, { append: (event) => journal.push(event) });
    const tieredDefinition = {
      ...definition,
      tier: "large" as const,
      tasks: definition.tasks.map((task) => ({
        ...task,
        tier: task.id === "a" ? "small" : task.id === "b" ? "medium" : undefined,
      })),
      synthesis: { ...definition.synthesis },
    };
    const start = engine.start(tieredDefinition, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawned).toEqual(["a-agent", "b-agent"]);
    expect(spawnedTiers).toEqual(
      new Map([
        ["a", "small"],
        ["b", "medium"],
      ]),
    );
    const runId = engine.list()[0]?.runId;

    bus.emit("subagents:completed", {
      id: "a-agent",
      result: "A result",
      owner: { extension: "pi-workflows", runId, nodeId: "a" },
    });
    bus.emit("subagents:completed", {
      id: "b-agent",
      result: "B result",
      owner: { extension: "pi-workflows", runId, nodeId: "b" },
    });
    const taskResultsBeforeDuplicate = journal.filter((event) => event.kind === "task_result").length;
    bus.emit("subagents:completed", {
      id: "a-agent",
      result: "late duplicate",
      owner: { extension: "pi-workflows", runId, nodeId: "a" },
    });
    expect(journal.filter((event) => event.kind === "task_result")).toHaveLength(taskResultsBeforeDuplicate);
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawned).toContain("c-agent");
    expect(spawnedTiers.get("c")).toBe("large");
    bus.emit("subagents:completed", {
      id: "c-agent",
      result: "C result",
      owner: { extension: "pi-workflows", runId, nodeId: "c" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawned).toContain("__synthesis__-agent");
    expect(spawnedTiers.get("__synthesis__")).toBe("large");
    bus.emit("subagents:completed", {
      id: "__synthesis__-agent",
      result: "final",
      owner: { extension: "pi-workflows", runId, nodeId: "__synthesis__" },
    });

    const result = await start;
    expect(result.status).toBe("completed");
    expect(result.result).toBe("final");
    expect(journal.some((event) => event.kind === "task_result")).toBe(true);
    engine.dispose();
  });

  it("retries a terminal task lifecycle after task-result append failure", async () => {
    const bus = new Bus();
    const journal = new FaultJournal("task_result");
    const oneTask = { ...definition, tasks: [firstDefinitionTask], synthesis: undefined, background: true };
    const client: ManagedSpawnClient = {
      spawn: async () => "a-agent",
      stop: async () => {},
      stopOwned: async () => {},
    };
    const engine = new WorkflowEngine(bus, client, journal);
    await engine.start(oneTask, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    const run = engine.list()[0];
    if (!run) throw new Error("workflow did not start");
    journal.arm();
    const completed = {
      id: "a-agent",
      result: "done",
      owner: { extension: "pi-workflows", runId: run.runId, nodeId: "a" },
    };
    expect(() => bus.emit("subagents:completed", completed)).not.toThrow();
    expect(engine.getRun(run.runId)?.taskResults.a).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(engine.waitFor(run.runId)).resolves.toMatchObject({ status: "completed" });
    expect(engine.getRun(run.runId)?.taskResults.a?.text).toBe("done");
    engine.dispose();
  });

  it("does not synthesize stop over a terminal lifecycle retry", async () => {
    const bus = new Bus();
    const journal = new FaultJournal("task_result");
    const oneTask = { ...definition, tasks: [firstDefinitionTask], synthesis: undefined, background: true };
    const client: ManagedSpawnClient = {
      spawn: async () => "a-agent",
      stop: async () => {},
      stopOwned: async () => {},
      quiesceOwned: async () => ({ settled: true, pending: [] }),
    };
    const engine = new WorkflowEngine(bus, client, journal);
    await engine.start(oneTask, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    const run = engine.list()[0];
    if (!run) throw new Error("workflow did not start");

    const stopPromise = engine.control("stop", run.runId);
    journal.arm();
    bus.emit("subagents:completed", {
      id: "a-agent",
      result: "observed completion",
      owner: { extension: "pi-workflows", runId: run.runId, nodeId: "a" },
    });

    await stopPromise;
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(engine.getRun(run.runId)?.status).toBe("stopped");
    expect(engine.getRun(run.runId)?.taskResults.a?.text).toBe("observed completion");
    expect(journal.events.filter((event) => event.kind === "task_result")).toHaveLength(1);
    engine.dispose();
  });

  it("resumes a partially appended terminal batch without duplicating its durable prefix", async () => {
    const bus = new Bus();
    const journal = new FaultJournal("task_transition");
    const oneTask = { ...definition, tasks: [firstDefinitionTask], synthesis: undefined, background: true };
    const client: ManagedSpawnClient = {
      spawn: async () => "a-agent",
      stop: async () => {},
      stopOwned: async () => {},
    };
    const engine = new WorkflowEngine(bus, client, journal);
    await engine.start(oneTask, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    const run = engine.list()[0];
    if (!run) throw new Error("workflow did not start");
    journal.arm();
    bus.emit("subagents:completed", {
      id: "a-agent",
      result: "done",
      owner: { extension: "pi-workflows", runId: run.runId, nodeId: "a" },
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    await expect(engine.waitFor(run.runId)).resolves.toMatchObject({ status: "completed" });
    expect(journal.events.filter((event) => event.kind === "task_result")).toHaveLength(1);
    expect(
      journal.events.filter(
        (event) => event.kind === "task_transition" && event.nodeId === "a" && event.status === "completed",
      ),
    ).toHaveLength(1);
    engine.dispose();
  });

  it("retries compaction journaling after an append failure without lowering the count", async () => {
    const bus = new Bus();
    const journal = new FaultJournal("task_compacted");
    const oneTask = { ...definition, tasks: [firstDefinitionTask], synthesis: undefined, background: true };
    const client: ManagedSpawnClient = {
      spawn: async () => "a-agent",
      stop: async () => {},
      stopOwned: async () => {},
    };
    const engine = new WorkflowEngine(bus, client, journal);
    await engine.start(oneTask, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    const run = engine.list()[0];
    if (!run) throw new Error("workflow did not start");
    const owner = { extension: "pi-workflows", runId: run.runId, nodeId: "a" };
    journal.arm();
    expect(() => bus.emit("subagents:compacted", { id: "a-agent", compactionCount: 2, owner })).not.toThrow();
    expect(engine.getRun(run.runId)?.compactions.a).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(engine.getRun(run.runId)?.compactions.a).toBe(2);
    bus.emit("subagents:compacted", { id: "a-agent", compactionCount: 1, owner });
    expect(engine.getRun(run.runId)?.compactions.a).toBe(2);
    bus.emit("subagents:completed", { id: "a-agent", result: "done", owner });
    await expect(engine.waitFor(run.runId)).resolves.toMatchObject({ status: "completed" });
    engine.dispose();
  });

  it("retries a task status transition after compaction/status append failure", async () => {
    const bus = new Bus();
    const journal = new FaultJournal("task_transition");
    const oneTask = { ...definition, tasks: [firstDefinitionTask], synthesis: undefined, background: true };
    const client: ManagedSpawnClient = {
      spawn: async () => ({ id: "a-agent", state: "queued" as const }),
      stop: async () => {},
      stopOwned: async () => {},
    };
    const engine = new WorkflowEngine(bus, client, journal);
    await engine.start(oneTask, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    const run = engine.list()[0];
    if (!run) throw new Error("workflow did not start");
    const owner = { extension: "pi-workflows", runId: run.runId, nodeId: "a" };
    journal.arm();
    expect(() => bus.emit("subagents:started", { id: "a-agent", owner })).not.toThrow();
    expect(engine.getRun(run.runId)?.taskStatus.a).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(engine.getRun(run.runId)?.taskStatus.a).toBe("running");
    bus.emit("subagents:completed", { id: "a-agent", result: "done", owner });
    await expect(engine.waitFor(run.runId)).resolves.toMatchObject({ status: "completed" });
    expect(engine.getRun(run.runId)?.taskStatus.a).toBe("completed");
    engine.dispose();
  });

  it("retries failure cleanup after its workflow-transition append fails", async () => {
    const bus = new Bus();
    const journal = new FaultJournal("workflow_transition");
    const oneTask = { ...definition, tasks: [firstDefinitionTask], synthesis: undefined, background: true };
    const client: ManagedSpawnClient = {
      spawn: async () => "a-agent",
      stop: async () => {},
      stopOwned: async () => {},
      quiesceOwned: async () => ({ settled: true, pending: [] }),
    };
    const engine = new WorkflowEngine(bus, client, journal);
    await engine.start(oneTask, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    const run = engine.list()[0];
    if (!run) throw new Error("workflow did not start");
    const failed = {
      id: "a-agent",
      status: "error",
      error: "task failed",
      owner: { extension: "pi-workflows", runId: run.runId, nodeId: "a" },
    };
    journal.arm();
    expect(() => bus.emit("subagents:failed", failed)).not.toThrow();
    expect(engine.getRun(run.runId)?.status).toBe("running");
    expect(engine.getRun(run.runId)?.taskResults.a).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(engine.waitFor(run.runId)).resolves.toMatchObject({ status: "failed" });
    expect(engine.getRun(run.runId)?.taskResults.a?.status).toBe("failed");
    engine.dispose();
  });

  it("retries a workflow transition after append failure without losing the waiter", async () => {
    const bus = new Bus();
    const journal = new FaultJournal("workflow_transition");
    const oneTask = { ...definition, tasks: [firstDefinitionTask], synthesis: undefined, background: true };
    const client: ManagedSpawnClient = {
      spawn: async () => "a-agent",
      stop: async () => {},
      stopOwned: async () => {},
    };
    const engine = new WorkflowEngine(bus, client, journal);
    await engine.start(oneTask, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    const run = engine.list()[0];
    if (!run) throw new Error("workflow did not start");
    journal.arm();
    await expect(engine.control("pause", run.runId)).rejects.toThrow(/workflow_transition append failure/);
    expect(engine.getRun(run.runId)?.status).toBe("running");
    await expect(engine.control("pause", run.runId)).resolves.toMatchObject({ run: { status: "pausing" } });
    bus.emit("subagents:completed", {
      id: "a-agent",
      result: "done",
      owner: { extension: "pi-workflows", runId: run.runId, nodeId: "a" },
    });
    expect(engine.getRun(run.runId)?.status).toBe("paused");
    engine.dispose();
  });

  it("retries a synthesis terminal after synthesis-result append failure", async () => {
    const bus = new Bus();
    const journal = new FaultJournal("synthesis_result");
    const synthesisDefinition = { ...definition, tasks: [firstDefinitionTask], background: true };
    const client: ManagedSpawnClient = {
      spawn: async (_task, _runId, nodeId) => (nodeId === "a" ? "a-agent" : "synthesis-agent"),
      stop: async () => {},
      stopOwned: async () => {},
    };
    const engine = new WorkflowEngine(bus, client, journal);
    await engine.start(synthesisDefinition, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    const run = engine.list()[0];
    if (!run) throw new Error("workflow did not start");
    bus.emit("subagents:completed", {
      id: "a-agent",
      result: "done",
      owner: { extension: "pi-workflows", runId: run.runId, nodeId: "a" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const current = engine.getRun(run.runId);
    if (!current) throw new Error("workflow disappeared");
    expect(current.status).toBe("synthesizing");
    journal.arm();
    const synthesisOwner = {
      extension: "pi-workflows",
      runId: run.runId,
      nodeId: "__synthesis__",
      attemptId: current.attemptIds.__synthesis__,
    };
    expect(() =>
      bus.emit("subagents:completed", { id: "synthesis-agent", result: "final", owner: synthesisOwner }),
    ).not.toThrow();
    expect(engine.getRun(run.runId)?.synthesisResult).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(engine.waitFor(run.runId)).resolves.toMatchObject({ status: "completed" });
    expect(engine.getRun(run.runId)?.synthesisResult?.text).toBe("final");
    engine.dispose();
  });
  it("pauses after active tasks settle and resumes without redispatching completed tasks", async () => {
    const bus = new Bus();
    const spawned: string[] = [];
    const client: ManagedSpawnClient = {
      async spawn(_task, runId, nodeId) {
        const id = `${nodeId}-agent`;
        spawned.push(id);
        bus.emit("subagents:created", { id, owner: { extension: "pi-workflows", runId, nodeId } });
        bus.emit("subagents:started", { id, owner: { extension: "pi-workflows", runId, nodeId } });
        return id;
      },
      async stop() {},
    };
    const engine = new WorkflowEngine(bus, client, { append: () => {} });
    const start = engine.start({ ...definition, synthesis: undefined, background: true }, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    const first = engine.list()[0];
    if (!first) throw new Error("workflow did not start");
    const runId = first.runId;

    await engine.control("pause", runId);
    expect(engine.get(runId)?.status).toBe("pausing");
    for (const nodeId of ["a", "b"] as const) {
      bus.emit("subagents:completed", {
        id: `${nodeId}-agent`,
        result: `${nodeId} result`,
        owner: { extension: "pi-workflows", runId, nodeId },
      });
    }
    expect(engine.get(runId)?.status).toBe("paused");
    expect(spawned).toEqual(["a-agent", "b-agent"]);

    await engine.control("resume", runId);
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawned).toContain("c-agent");
    bus.emit("subagents:completed", {
      id: "c-agent",
      result: "c result",
      owner: { extension: "pi-workflows", runId, nodeId: "c" },
    });
    expect(engine.get(runId)?.status).toBe("completed");
    await start;
    engine.dispose();
  });

  it("stops pending and active tasks and marks the run non-resumable", async () => {
    const bus = new Bus();
    const stopped: string[] = [];
    const client: ManagedSpawnClient = {
      async spawn(_task, runId, nodeId) {
        const id = `${nodeId}-agent`;
        bus.emit("subagents:created", { id, owner: { extension: "pi-workflows", runId, nodeId } });
        return id;
      },
      async stop(agentId) {
        stopped.push(agentId);
      },
      async stopOwned(agentId) {
        stopped.push(agentId);
      },
      async quiesceOwned(_runId, agentIds) {
        stopped.push(...agentIds);
        return { settled: true, pending: [] };
      },
    };
    const engine = new WorkflowEngine(bus, client, { append: () => {} });
    const first = await engine.start({ ...definition, synthesis: undefined, background: true }, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    const result = await engine.control("stop", first.runId);
    expect(result.run?.status).toBe("stopped");
    expect(result.run?.nonResumable).toBe(true);
    expect(stopped.length).toBeGreaterThan(0);
    await expect(engine.control("resume", first.runId)).rejects.toThrow(/non-resumable/);
    engine.dispose();
  });

  it("keeps stopping until a late managed spawn response is quiescent", async () => {
    const bus = new Bus();
    let resolveSpawn: ((response: ManagedSpawnResponse) => void) | undefined;
    const spawnResponse = new Promise<ManagedSpawnResponse>((resolve) => {
      resolveSpawn = resolve;
    });
    let sessionSettled = false;
    const quiescedIds: string[][] = [];
    const client: ManagedSpawnClient = {
      spawn: async () => spawnResponse,
      stop: async () => {},
      stopOwned: async () => {},
      quiesceOwned: async (_runId, agentIds) => {
        quiescedIds.push([...agentIds]);
        if (agentIds.length === 0 || sessionSettled) return { settled: true, pending: [] };
        return { settled: false, pending: agentIds };
      },
    };
    const journal: JournalEvent[] = [];
    const engine = new WorkflowEngine(bus, client, { append: (event) => journal.push(event) });
    const first = await engine.start(
      { ...definition, tasks: [firstDefinitionTask], synthesis: undefined, background: true },
      ctx,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const stopping = engine.control("stop", first.runId);
    await new Promise((resolve) => setImmediate(resolve));
    expect(engine.get(first.runId)?.status).toBe("stopping");

    resolveSpawn?.({ id: "late-agent", state: "running" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(engine.get(first.runId)?.status).toBe("stopping");
    expect(engine.getRun(first.runId)?.taskResults.a).toBeUndefined();
    expect(journal.some((event) => event.kind === "workflow_transition" && event.status === "stopped")).toBe(false);
    expect(journal.some((event) => event.kind === "task_result")).toBe(false);
    expect(quiescedIds).toContainEqual(["late-agent"]);

    sessionSettled = true;
    await expect(stopping).resolves.toMatchObject({ run: { status: "stopped" } });
    engine.dispose();
  });

  it("retains a terminal lifecycle target until owned quiescence settles", async () => {
    const bus = new Bus();
    const journal: JournalEvent[] = [];
    let quiesceCalls = 0;
    const client: ManagedSpawnClient = {
      spawn: async () => "a-agent",
      stop: async () => {},
      stopOwned: async () => {},
      quiesceOwned: async (_runId, agentIds, _timeoutMs, owners) => {
        quiesceCalls += 1;
        if (quiesceCalls === 1) {
          const owner = owners?.[0];
          if (!owner) throw new Error("missing cleanup owner");
          bus.emit("subagents:completed", {
            id: "a-agent",
            result: "completed before session settled",
            owner,
          });
          return { settled: false, pending: [...agentIds] };
        }
        return { settled: true, pending: [] };
      },
    };
    const engine = new WorkflowEngine(bus, client, { append: (event) => journal.push(event) });
    const started = await engine.start(
      { ...definition, tasks: [firstDefinitionTask], synthesis: undefined, background: true },
      ctx,
    );
    await new Promise((resolve) => setImmediate(resolve));

    const stopping = engine.control("stop", started.runId);
    await new Promise((resolve) => setImmediate(resolve));
    expect(quiesceCalls).toBe(1);
    expect(engine.getRun(started.runId)?.status).toBe("stopping");
    expect(engine.getRun(started.runId)?.taskStatus.a).toBe("completed");
    expect(journal.some((event) => event.kind === "workflow_transition" && event.status === "stopped")).toBe(false);
    expect(
      journal.some((event) => event.kind === "task_transition" && event.nodeId === "a" && event.status === "stopped"),
    ).toBe(false);

    await expect(stopping).resolves.toMatchObject({ run: { status: "stopped" } });
    expect(quiesceCalls).toBeGreaterThanOrEqual(2);
    engine.dispose();
  });

  it("does not publish terminal records when owned quiescence is unavailable", async () => {
    const bus = new Bus();
    const journal: JournalEvent[] = [];
    const client: ManagedSpawnClient = {
      spawn: async () => "a-agent",
      stop: async () => {},
      stopOwned: async () => {},
    };
    const engine = new WorkflowEngine(bus, client, { append: (event) => journal.push(event) });
    const started = await engine.start(
      { ...definition, tasks: [firstDefinitionTask], synthesis: undefined, background: true },
      ctx,
    );
    await new Promise((resolve) => setImmediate(resolve));

    const stopping = engine.control("stop", started.runId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(engine.getRun(started.runId)?.status).toBe("stopping");
    expect(engine.getRun(started.runId)?.taskResults.a).toBeUndefined();
    expect(journal.some((event) => event.kind === "workflow_transition" && event.status === "stopped")).toBe(false);
    expect(journal.some((event) => event.kind === "task_result")).toBe(false);

    engine.dispose();
    await expect(stopping).resolves.toMatchObject({ run: { status: "stopping" } });
  });

  it("replays journal state and marks in-flight runs interrupted", () => {
    const bus = new Bus();
    const client: ManagedSpawnClient = { spawn: async () => "unused", stop: async () => {} };
    const journal: JournalEvent[] = [];
    const engine = new WorkflowEngine(bus, client, { append: (event) => journal.push(event) });
    const entries: SessionEntryLike[] = [
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: {
          kind: "run_created",
          schemaVersion: 1,
          runId: "r",
          definition: { ...definition, background: true },
          timestamp: 1,
        },
      },
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: { kind: "workflow_transition", schemaVersion: 1, runId: "r", status: "running", timestamp: 2 },
      },
    ];
    engine.restore(entries);
    expect(engine.get("r")?.status).toBe("interrupted");
    expect(journal.some((event) => event.kind === "run_recovery" && event.status === "interrupted")).toBe(true);
    engine.dispose();
  });

  it("replays missing terminal records into ready tasks and resumes with a fresh managed attempt", async () => {
    const bus = new Bus(false);
    const spawned: string[] = [];
    const firstTask = definition.tasks[0];
    if (!firstTask) throw new Error("test definition has no first task");
    const oneTaskDefinition = {
      ...definition,
      tasks: [firstTask],
      synthesis: undefined,
      background: true,
    };
    const client: ManagedSpawnClient = {
      async spawn(_task, runId, nodeId, _ctx, attemptId) {
        spawned.push(`${runId}:${nodeId}:${attemptId}`);
        bus.emit("subagents:created", {
          id: "a-agent",
          owner: { extension: "pi-workflows", runId, nodeId, attemptId },
        });
        queueMicrotask(() =>
          bus.emit("subagents:completed", {
            id: "a-agent",
            result: "recovered",
            owner: { extension: "pi-workflows", runId, nodeId, attemptId },
          }),
        );
        return "a-agent";
      },
      async stop() {},
    };
    const journal: JournalEvent[] = [];
    const engine = new WorkflowEngine(bus, client, { append: (event) => journal.push(event) });
    const entries: SessionEntryLike[] = [
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: {
          kind: "run_created",
          schemaVersion: 1,
          runId: "recovered-run",
          definition: oneTaskDefinition,
          timestamp: 1,
        },
      },
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: {
          kind: "workflow_transition",
          schemaVersion: 1,
          runId: "recovered-run",
          status: "running",
          timestamp: 2,
        },
      },
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: {
          kind: "task_transition",
          schemaVersion: 1,
          runId: "recovered-run",
          nodeId: "a",
          status: "running",
          agentId: "a-agent",
          timestamp: 3,
        },
      },
    ];
    engine.restore(entries);
    expect(engine.getRun("recovered-run")?.taskStatus.a).toBe("ready");
    expect(engine.getRun("recovered-run")?.attempts.a).toBe(2);
    expect(
      journal.some(
        (event) => event.kind === "run_recovery" && event.rotations.some((rotation) => rotation.nodeId === "a"),
      ),
    ).toBe(true);

    await engine.control("resume", "recovered-run");
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawned).toEqual(["recovered-run:a:recovered-run/a/attempt-2"]);
    expect(engine.getRun("recovered-run")?.taskStatus.a).toBe("completed");
    expect(engine.getRun("recovered-run")?.taskResults.a?.text).toBe("recovered");
    engine.dispose();
  });

  it("stops parallel owned agents after one task fails and settles cleanup before failed", async () => {
    const bus = new Bus();
    const stopped: string[] = [];
    const cleanupDefinition = {
      ...definition,
      tasks: definition.tasks.slice(0, 2),
      synthesis: undefined,
      background: true,
    };
    const client: ManagedSpawnClient = {
      async spawn(_task, runId, nodeId) {
        const id = `${nodeId}-agent`;
        bus.emit("subagents:created", { id, owner: { extension: "pi-workflows", runId, nodeId } });
        bus.emit("subagents:started", { id, owner: { extension: "pi-workflows", runId, nodeId } });
        return id;
      },
      async stop(agentId) {
        stopped.push(agentId);
        const nodeId = agentId.replace(/-agent$/, "");
        const runId = engineRunId;
        bus.emit("subagents:failed", {
          id: agentId,
          status: "stopped",
          error: "cleanup stop",
          owner: { extension: "pi-workflows", runId, nodeId },
        });
      },
      async stopOwned(agentId) {
        stopped.push(agentId);
        const nodeId = agentId.replace(/-agent$/, "");
        const runId = engineRunId;
        bus.emit("subagents:failed", {
          id: agentId,
          status: "stopped",
          error: "cleanup stop",
          owner: { extension: "pi-workflows", runId, nodeId },
        });
      },
      async quiesceOwned(_runId, agentIds) {
        for (const agentId of agentIds) {
          stopped.push(agentId);
          const nodeId = agentId.replace(/-agent$/, "");
          bus.emit("subagents:failed", {
            id: agentId,
            status: "stopped",
            error: "cleanup stop",
            owner: { extension: "pi-workflows", runId: engineRunId, nodeId },
          });
        }
        return { settled: true, pending: [] };
      },
    };
    let engineRunId = "";
    const journal: JournalEvent[] = [];
    const engine = new WorkflowEngine(bus, client, { append: (event) => journal.push(event) });
    const started = await engine.start(cleanupDefinition, ctx);
    engineRunId = started.runId;
    await new Promise((resolve) => setImmediate(resolve));
    bus.emit("subagents:failed", {
      id: "a-agent",
      status: "error",
      error: "task failed",
      owner: { extension: "pi-workflows", runId: engineRunId, nodeId: "a" },
    });
    const settled = await engine.waitFor(engineRunId);
    expect(settled.status).toBe("failed");
    expect(stopped).toEqual(["b-agent"]);
    expect(settled.taskStatus.b).toBe("stopped");
    expect(journal.some((event) => event.kind === "task_result" && event.nodeId === "b")).toBe(true);
    engine.dispose();
  });

  it("reconciles a persisted terminal subagent record and skips redispatch on resume", async () => {
    const bus = new Bus();
    const spawned: string[] = [];
    const firstTask = definition.tasks[0];
    if (!firstTask) throw new Error("test definition has no first task");
    const oneTaskDefinition = {
      ...definition,
      tasks: [firstTask],
      synthesis: undefined,
      background: true,
    };
    const client: ManagedSpawnClient = {
      async spawn(_task, runId, nodeId) {
        spawned.push(`${runId}:${nodeId}`);
        return "unexpected";
      },
      async stop() {},
    };
    const reconciledJournal: JournalEvent[] = [];
    const engine = new WorkflowEngine(bus, client, { append: (event) => reconciledJournal.push(event) });
    const entries: SessionEntryLike[] = [
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: {
          kind: "run_created",
          schemaVersion: 1,
          runId: "recorded-run",
          definition: oneTaskDefinition,
          timestamp: 1,
        },
      },
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: { kind: "workflow_transition", schemaVersion: 1, runId: "recorded-run", status: "running", timestamp: 2 },
      },
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: {
          kind: "task_transition",
          schemaVersion: 1,
          runId: "recorded-run",
          nodeId: "a",
          status: "running",
          agentId: "a-agent",
          timestamp: 3,
        },
      },
      {
        type: "custom",
        customType: "subagents:record",
        data: {
          id: "a-agent",
          status: "completed",
          result: "persisted",
          owner: { extension: "pi-workflows", runId: "recorded-run", nodeId: "a" },
        },
      },
    ];
    engine.restore(entries);
    expect(engine.getRun("recorded-run")?.taskStatus.a).toBe("completed");
    await engine.control("resume", "recorded-run");
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawned).toEqual([]);
    expect(engine.getRun("recorded-run")?.status).toBe("completed");
    expect(engine.getRun("recorded-run")?.taskResults.a?.text).toBe("persisted");
    const recovery = reconciledJournal.find((event) => event.kind === "run_recovery");
    if (recovery?.kind !== "run_recovery") throw new Error("missing terminal reconciliation recovery");
    expect(recovery.rotations).toHaveLength(0);
    expect(recovery.terminalResults?.[0]?.result.text).toBe("persisted");
    const beforeStaleRestore = reconciledJournal.length;
    engine.restore(entries);
    expect(reconciledJournal).toHaveLength(beforeStaleRestore);
    expect(engine.getRun("recorded-run")?.taskResults.a?.text).toBe("persisted");
    const replay = new WorkflowEngine(bus, client, { append: () => {} });
    replay.restore([...entries, { type: "custom", customType: "pi-workflows:journal", data: recovery }]);
    expect(replay.getRun("recorded-run")?.taskStatus.a).toBe("completed");
    expect(replay.getRun("recorded-run")?.taskResults.a?.text).toBe("persisted");
    replay.dispose();
    engine.dispose();
  });

  it("applies a terminal managed-spawn response immediately during reload recovery", async () => {
    const firstBus = new Bus();
    const journal: JournalEvent[] = [];
    const firstClient: ManagedSpawnClient = {
      async spawn() {
        return "a-agent";
      },
      async stop() {},
    };
    const firstTask = definition.tasks[0];
    if (!firstTask) throw new Error("test definition has no first task");
    const oneTaskDefinition = {
      ...definition,
      tasks: [firstTask],
      synthesis: undefined,
      background: true,
    };
    const firstEngine = new WorkflowEngine(firstBus, firstClient, { append: (event) => journal.push(event) });
    const started = await firstEngine.start(oneTaskDefinition, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    expect(firstEngine.getRun(started.runId)?.taskStatus.a).toBe("running");
    firstEngine.dispose();

    const secondBus = new Bus();
    let spawnCount = 0;
    const secondClient: ManagedSpawnClient = {
      async spawn(_task, _runId, _nodeId) {
        spawnCount += 1;
        return {
          id: "a-agent",
          state: "completed",
          terminal: {
            status: "completed",
            result: "replayed after cleanup",
            compactionCount: 2,
            completedAt: 20,
          },
        };
      },
      async stop() {},
    };
    const secondJournal: JournalEvent[] = [];
    const secondEngine = new WorkflowEngine(secondBus, secondClient, { append: (event) => secondJournal.push(event) });
    secondEngine.restore(
      journal.map((data) => ({
        type: "custom" as const,
        customType: "pi-workflows:journal",
        data,
      })),
    );
    expect(secondEngine.getRun(started.runId)?.taskStatus.a).toBe("ready");
    await secondEngine.control("resume", started.runId);
    const recovered = await secondEngine.waitFor(started.runId);
    expect(recovered.status).toBe("completed");
    expect(recovered.taskStatus.a).toBe("completed");
    expect(recovered.taskResults.a?.text).toBe("replayed after cleanup");
    expect(spawnCount).toBe(1);
    expect(secondJournal.some((event) => event.kind === "task_result" && event.nodeId === "a")).toBe(true);
    secondEngine.dispose();
  });

  it("journals synchronous stop callbacks and finishes exactly stopped", async () => {
    const bus = new Bus();
    const journal: JournalEvent[] = [];
    const client: ManagedSpawnClient = {
      async spawn(_task, runId, nodeId) {
        const id = `${nodeId}-agent`;
        bus.emit("subagents:created", { id, owner: { extension: "pi-workflows", runId, nodeId } });
        if (nodeId === "a") bus.emit("subagents:started", { id, owner: { extension: "pi-workflows", runId, nodeId } });
        return id;
      },
      async stop(agentId) {
        const [nodeId] = agentId.split("-");
        bus.emit("subagents:failed", {
          id: agentId,
          status: "stopped",
          error: "stop requested",
          owner: { extension: "pi-workflows", runId: stopRunId, nodeId },
        });
      },
      async stopOwned(agentId) {
        const [nodeId] = agentId.split("-");
        bus.emit("subagents:failed", {
          id: agentId,
          status: "stopped",
          error: "stop requested",
          owner: { extension: "pi-workflows", runId: stopRunId, nodeId },
        });
      },
      async quiesceOwned() {
        return { settled: true, pending: [] };
      },
    };
    let stopRunId = "";
    const engine = new WorkflowEngine(bus, client, { append: (event) => journal.push(event) });
    const started = await engine.start({ ...definition, synthesis: undefined, background: true }, ctx);
    stopRunId = started.runId;
    await new Promise((resolve) => setImmediate(resolve));
    const stopped = await engine.control("stop", stopRunId);
    expect(stopped.run?.status).toBe("stopped");
    expect(engine.getRun(stopRunId)?.taskStatus.a).toBe("stopped");
    expect(engine.getRun(stopRunId)?.taskStatus.b).toBe("stopped");
    expect(journal.filter((event) => event.kind === "task_result")).toHaveLength(3);
    bus.emit("subagents:completed", {
      id: "a-agent",
      result: "late result must be ignored",
      owner: { extension: "pi-workflows", runId: stopRunId, nodeId: "a" },
    });
    expect(engine.getRun(stopRunId)?.taskResults.a?.status).toBe("stopped");
    expect(journal.filter((event) => event.kind === "task_result")).toHaveLength(3);
    const detail = await engine.control("get", stopRunId);
    expect(detail.run?.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "a", status: "stopped", agentId: "a-agent" }),
        expect.objectContaining({ id: "b", status: "stopped", agentId: "b-agent" }),
      ]),
    );
    engine.dispose();
  });

  it("bounds retries when recovery repeatedly returns an interrupted terminal snapshot", async () => {
    const bus = new Bus();
    const firstTask = definition.tasks[0];
    if (!firstTask) throw new Error("test definition has no first task");
    const oneTaskDefinition = {
      ...definition,
      tasks: [firstTask],
      synthesis: undefined,
      background: true,
    };
    const client: ManagedSpawnClient = {
      async spawn() {
        return {
          id: "stale-agent",
          state: "interrupted",
          terminal: {
            status: "interrupted",
            error: "no live AgentSession after reload",
            compactionCount: 0,
            completedAt: 30,
          },
        };
      },
      async stop() {},
    };
    const engine = new WorkflowEngine(bus, client, { append: () => {} });
    const started = await engine.start(oneTaskDefinition, ctx);
    const result = await engine.waitFor(started.runId);
    expect(result.status).toBe("failed");
    expect(result.taskStatus.a).toBe("failed");
    expect(result.taskResults.a?.error).toMatch(/exceeded interrupted-attempt limit/);
    engine.dispose();
  });

  it("aborts only the foreground wait and leaves the workflow retrievable", async () => {
    const bus = new Bus();
    const client: ManagedSpawnClient = {
      async spawn(_task, runId, nodeId) {
        const id = "waiting-agent";
        bus.emit("subagents:created", { id, owner: { extension: "pi-workflows", runId, nodeId } });
        bus.emit("subagents:started", { id, owner: { extension: "pi-workflows", runId, nodeId } });
        return id;
      },
      async stop() {},
    };
    const engine = new WorkflowEngine(bus, client, { append: () => {} });
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const started = engine.start(
      { ...definition, tasks: definition.tasks.slice(0, 1), synthesis: undefined },
      ctx,
      controller.signal,
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const result = await started;
    expect(result.waitAborted).toBe(true);
    expect(result.status).toBe("running");
    expect(engine.get(result.runId)?.status).toBe("running");
    expect(removeListener).toHaveBeenCalled();
    await expect(engine.control("get", result.runId)).resolves.toEqual(expect.objectContaining({ action: "get" }));
    engine.dispose();
  });

  it("handles an already-aborted foreground signal without stopping the owned run", async () => {
    const bus = new Bus();
    const client: ManagedSpawnClient = { spawn: async () => "not-yet", stop: async () => {} };
    const engine = new WorkflowEngine(bus, client, { append: () => {} });
    const controller = new AbortController();
    controller.abort();
    const result = await engine.start(
      { ...definition, tasks: definition.tasks.slice(0, 1), synthesis: undefined },
      ctx,
      controller.signal,
    );
    expect(result.waitAborted).toBe(true);
    expect(result.error).toMatch(/foreground workflow wait aborted/);
    expect(engine.get(result.runId)?.nonResumable).toBeUndefined();
    engine.dispose();
  });

  it("rejects foreground waiters when restoring a replacement session branch", async () => {
    const bus = new Bus();
    const client: ManagedSpawnClient = {
      async spawn(_task, runId, nodeId) {
        bus.emit("subagents:created", { id: "branch-agent", owner: { extension: "pi-workflows", runId, nodeId } });
        bus.emit("subagents:started", { id: "branch-agent", owner: { extension: "pi-workflows", runId, nodeId } });
        return "branch-agent";
      },
      async stop() {},
    };
    const engine = new WorkflowEngine(bus, client, { append: () => {} });
    const started = engine.start({ ...definition, tasks: definition.tasks.slice(0, 1), synthesis: undefined }, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    engine.restore([]);
    await expect(started).rejects.toThrow(/session branch changed/);
    engine.dispose();
  });

  it("wins the completion-versus-abort race when completion is observed first", async () => {
    const bus = new Bus();
    const client: ManagedSpawnClient = {
      async spawn(_task, runId, nodeId) {
        const id = "race-agent";
        bus.emit("subagents:created", { id, owner: { extension: "pi-workflows", runId, nodeId } });
        bus.emit("subagents:completed", { id, result: "done", owner: { extension: "pi-workflows", runId, nodeId } });
        return id;
      },
      async stop() {},
    };
    const engine = new WorkflowEngine(bus, client, { append: () => {} });
    const controller = new AbortController();
    const result = await engine.start(
      { ...definition, tasks: definition.tasks.slice(0, 1), synthesis: undefined },
      ctx,
      controller.signal,
    );
    controller.abort();
    expect(result.waitAborted).toBeUndefined();
    expect(result.status).toBe("completed");
    engine.dispose();
  });

  it("recovers a completed managed tombstone from a crash prefix without rotating or redispatching", () => {
    const runId = "managed-terminal-crash-prefix";
    const attemptId = `${runId}/a/attempt-1`;
    const replayDefinition = {
      ...definition,
      tasks: definition.tasks.slice(0, 1),
      synthesis: undefined,
      background: true,
    };
    const custom = (customType: string, data: unknown): SessionEntryLike => ({
      type: "custom",
      customType,
      data,
    });
    const entries: SessionEntryLike[] = [
      custom("pi-workflows:journal", {
        kind: "run_created",
        schemaVersion: 2,
        runId,
        definition: replayDefinition,
        attempts: { a: 1, __synthesis__: 1 },
        attemptIds: { a: attemptId, __synthesis__: `${runId}/__synthesis__/attempt-1` },
        timestamp: 1,
      }),
      custom("pi-workflows:journal", {
        kind: "workflow_transition",
        schemaVersion: 2,
        runId,
        status: "running",
        timestamp: 2,
      }),
      custom("pi-workflows:journal", {
        kind: "task_transition",
        schemaVersion: 2,
        runId,
        nodeId: "a",
        status: "running",
        agentId: "a-agent",
        attemptId,
        owner: { extension: "pi-workflows", runId, nodeId: "a", attemptId },
        timestamp: 3,
      }),
      custom("subagents:managed-spawn", {
        schemaVersion: 1,
        spawnKey: attemptId,
        fingerprint: "crash-prefix-fingerprint",
        id: "a-agent",
        requestId: "request-1",
        type: "Explore",
        description: "A",
        tier: "medium",
        tierSnapshot: {
          tier: "medium",
          model: "test/fast",
          thinking: "medium",
          configuredThinking: "medium",
          requestedThinking: "medium",
          modelSource: "tier",
          thinkingSource: "tier",
        },
        owner: { extension: "pi-workflows", runId, nodeId: "a", attemptId },
        state: "completed",
        createdAt: 3,
        updatedAt: 6,
        compactionCount: 1,
        terminal: { status: "completed", result: "durable result", compactionCount: 1, completedAt: 6 },
      }),
    ];
    const journal: JournalEvent[] = [];
    let spawned = 0;
    const engine = new WorkflowEngine(
      new Bus(),
      {
        spawn: async () => {
          spawned += 1;
          return "unexpected";
        },
        stop: async () => {},
        stopOwned: async () => {},
      },
      { append: (event) => journal.push(event) },
    );

    engine.restore(entries, 0);
    const recovered = engine.getRun(runId);
    expect(spawned).toBe(0);
    expect(recovered?.taskResults.a?.text).toBe("durable result");
    expect(recovered?.taskStatus.a).toBe("completed");
    const recovery = journal.find(
      (event): event is Extract<JournalEvent, { kind: "run_recovery" }> => event.kind === "run_recovery",
    );
    expect(recovery?.rotations).toHaveLength(0);
    expect(recovery?.terminalResults?.map((result) => result.nodeId)).toEqual(["a"]);
    const appendCount = journal.length;

    engine.restore(entries, 0);
    expect(journal).toHaveLength(appendCount);
    expect(engine.getRun(runId)?.taskResults.a?.text).toBe("durable result");
    expect(spawned).toBe(0);
    engine.dispose();
  });
  it("replays a managed interrupted record as one new attempt and preserves completed facts", async () => {
    const runId = "cross-extension-replay";
    const attemptOne = `${runId}/a/attempt-1`;
    const attemptTwo = `${runId}/a/attempt-2`;
    const bus = new Bus();
    const journal: JournalEvent[] = [];
    const spawnedAttempts: string[] = [];
    const replayDefinition = {
      ...definition,
      tasks: definition.tasks.slice(0, 2),
      synthesis: undefined,
      background: true,
    };
    const baseEntries: SessionEntryLike[] = [
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: {
          kind: "run_created",
          schemaVersion: 2,
          runId,
          definition: replayDefinition,
          attempts: { a: 1, b: 1, __synthesis__: 1 },
          attemptIds: {
            a: attemptOne,
            b: `${runId}/b/attempt-1`,
            __synthesis__: `${runId}/__synthesis__/attempt-1`,
          },
          timestamp: 1,
        },
      },
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: { kind: "workflow_transition", schemaVersion: 2, runId, status: "running", timestamp: 2 },
      },
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: {
          kind: "task_transition",
          schemaVersion: 2,
          runId,
          nodeId: "a",
          status: "running",
          agentId: "a-old",
          attemptId: attemptOne,
          owner: { extension: "pi-workflows", runId, nodeId: "a", attemptId: attemptOne },
          timestamp: 3,
        },
      },
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: {
          kind: "task_transition",
          schemaVersion: 2,
          runId,
          nodeId: "b",
          status: "running",
          agentId: "b-completed",
          attemptId: `${runId}/b/attempt-1`,
          owner: { extension: "pi-workflows", runId, nodeId: "b", attemptId: `${runId}/b/attempt-1` },
          timestamp: 4,
        },
      },
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: {
          kind: "task_result",
          schemaVersion: 2,
          runId,
          nodeId: "b",
          attemptId: `${runId}/b/attempt-1`,
          owner: { extension: "pi-workflows", runId, nodeId: "b", attemptId: `${runId}/b/attempt-1` },
          result: {
            attemptId: `${runId}/b/attempt-1`,
            status: "completed",
            agentId: "b-completed",
            text: "already complete",
            compactionCount: 0,
            updatedAt: 5,
          },
          timestamp: 5,
        },
      },
      {
        type: "custom",
        customType: "subagents:managed-spawn",
        data: {
          schemaVersion: 1,
          spawnKey: `${runId}/a/attempt-1`,
          fingerprint: "replay-fingerprint",
          id: "a-old",
          requestId: "request-1",
          type: "Explore",
          description: "A",
          owner: { extension: "pi-workflows", runId, nodeId: "a", attemptId: attemptOne },
          state: "interrupted",
          createdAt: 3,
          updatedAt: 6,
          compactionCount: 0,
          terminal: { status: "interrupted", error: "reload", compactionCount: 0, completedAt: 6 },
        },
      },
      {
        type: "custom",
        customType: "subagents:record",
        data: {
          id: "a-old",
          status: "interrupted",
          error: "reload",
          owner: { extension: "pi-workflows", runId, nodeId: "a", attemptId: attemptOne },
        },
      },
    ];
    const client: ManagedSpawnClient = {
      async spawn(_task, spawnedRunId, nodeId, _ctx, attemptId) {
        if (nodeId !== "a") throw new Error(`unexpected node ${nodeId}`);
        spawnedAttempts.push(attemptId ?? "missing-attempt");
        queueMicrotask(() => {
          bus.emit("subagents:created", {
            id: "a-new",
            owner: { extension: "pi-workflows", runId: spawnedRunId, nodeId, attemptId: attemptTwo },
          });
          bus.emit("subagents:completed", {
            id: "a-new",
            result: "recovered",
            owner: { extension: "pi-workflows", runId: spawnedRunId, nodeId, attemptId: attemptTwo },
          });
        });
        return { id: "a-new", state: "running" };
      },
      async stop() {},
    };

    const first = new WorkflowEngine(bus, client, { append: (event) => journal.push(event) });
    first.restore(baseEntries);
    const recovered = first.getRun(runId);
    expect(recovered?.status).toBe("interrupted");
    expect(recovered?.attempts.a).toBe(2);
    expect(recovered?.attemptIds.a).toBe(attemptTwo);
    expect(recovered?.agentIds.a).toBeUndefined();
    expect(recovered?.taskStatus.a).toBe("ready");
    expect(recovered?.taskResults.a).toBeUndefined();
    expect(recovered?.taskStatus.b).toBe("completed");
    expect(journal.filter((event) => event.kind === "run_recovery")).toHaveLength(1);
    first.dispose();

    const replayedEntries = [
      ...baseEntries,
      ...journal.map((data) => ({ type: "custom", customType: "pi-workflows:journal", data })),
    ];
    const second = new WorkflowEngine(bus, client, { append: () => {} });
    second.restore(replayedEntries);
    second.restore(replayedEntries);
    expect(second.getRun(runId)?.attempts.a).toBe(2);
    expect(second.getRun(runId)?.taskResults.a).toBeUndefined();
    await second.control("resume", runId);
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawnedAttempts).toEqual([attemptTwo]);
    expect(second.getRun(runId)?.taskResults.a?.status).toBe("completed");
    expect(second.getRun(runId)?.taskResults.a?.error).toBeUndefined();
    second.dispose();
  });

  it("fails instead of synthesizing when a running workflow contains a stopped task", async () => {
    const bus = new Bus();
    const client: ManagedSpawnClient = {
      async spawn() {
        return "stopped-agent";
      },
      async stop() {},
    };
    const engine = new WorkflowEngine(bus, client, { append: () => {} });
    const started = await engine.start(
      { ...definition, tasks: definition.tasks.slice(0, 1), synthesis: definition.synthesis, background: true },
      ctx,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const run = engine.getRun(started.runId);
    if (!run) throw new Error("workflow did not start");
    run.taskStatus.a = "stopped";
    await (engine as unknown as { pump: (value: typeof run, context: never) => Promise<void> }).pump(
      run,
      undefined as never,
    );
    expect(engine.getRun(started.runId)?.status).toBe("failed");
    expect(engine.getRun(started.runId)?.synthesisResult).toBeUndefined();
    engine.dispose();
  });

  it("reports incomplete branch quiescence and rejects late lifecycle events", async () => {
    const bus = new Bus();
    let quiesceCalls = 0;
    const client: ManagedSpawnClient = {
      async spawn(_task, runId, nodeId) {
        bus.emit("subagents:created", { id: "late-agent", owner: { extension: "pi-workflows", runId, nodeId } });
        bus.emit("subagents:started", { id: "late-agent", owner: { extension: "pi-workflows", runId, nodeId } });
        return "late-agent";
      },
      async stop() {},
      async quiesceOwned() {
        quiesceCalls += 1;
        return { settled: false, pending: ["late-agent"] };
      },
    };
    const engine = new WorkflowEngine(bus, client, { append: () => {} });
    const started = await engine.start(
      { ...definition, tasks: definition.tasks.slice(0, 1), synthesis: undefined, background: true },
      ctx,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const result = await engine.quiesceForBranchChange();
    expect(result.settled).toBe(false);
    expect(result.pending).toEqual(["late-agent"]);
    expect(result.diagnostic).toMatch(/branch quiescence incomplete/);
    expect(quiesceCalls).toBe(1);
    bus.emit("subagents:completed", {
      id: "late-agent",
      result: "must be ignored",
      owner: { extension: "pi-workflows", runId: started.runId, nodeId: "a" },
    });
    expect(engine.getRun(started.runId)?.taskResults.a).toBeUndefined();
    expect(engine.getRun(started.runId)?.error).toMatch(/branch quiescence incomplete/);
    engine.dispose();
  });

  it("stops a managed spawn reply that arrives after branch replacement", async () => {
    const bus = new Bus();
    const journal: JournalEvent[] = [];
    const stopped: string[] = [];
    const quiescedAgents: string[] = [];
    let resolveSpawn!: (response: ManagedSpawnResponse) => void;
    const client: ManagedSpawnClient = {
      spawn: async () =>
        new Promise((resolve) => {
          resolveSpawn = resolve as typeof resolveSpawn;
        }),
      async stop(agentId) {
        stopped.push(agentId);
      },
      async stopOwned(agentId) {
        stopped.push(agentId);
      },
      async quiesceOwned(_runId, agentIds) {
        quiescedAgents.push(...agentIds);
        return { settled: true, pending: [] };
      },
    };
    const engine = new WorkflowEngine(bus, client, { append: (event) => journal.push(event) });
    const started = await engine.start(
      { ...definition, tasks: definition.tasks.slice(0, 1), synthesis: undefined, background: true },
      ctx,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const quiescing = engine.quiesceForBranchChange();
    await new Promise((resolve) => setImmediate(resolve));
    resolveSpawn({
      id: "late-spawn",
      state: "running",
    });
    const quiesced = await quiescing;
    expect(quiesced).toMatchObject({ settled: true, pending: [] });
    engine.restore([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toEqual(["late-spawn"]);
    expect(quiescedAgents).toEqual(["late-spawn"]);
    expect(engine.get(started.runId)).toBeUndefined();
    expect(journal.filter((event) => event.kind === "task_result")).toHaveLength(0);
    engine.dispose();
  });

  it("supersedes an unresolved task dispatch before accepting late matching-attempt events", async () => {
    const bus = new Bus(false);
    const journal: JournalEvent[] = [];
    const spawnedAttempts: string[] = [];
    const stopped: string[] = [];
    let spawnCount = 0;
    let resolveOldSpawn!: (response: ManagedSpawnResponse) => void;
    const oneTask = {
      ...definition,
      tasks: [firstDefinitionTask],
      synthesis: undefined,
      background: true,
    };
    const client: ManagedSpawnClient = {
      async spawn(_task, runId, nodeId, _ctx, attemptId) {
        spawnedAttempts.push(attemptId ?? "missing-attempt");
        spawnCount += 1;
        if (spawnCount === 1) {
          return new Promise<ManagedSpawnResponse>((resolve) => {
            resolveOldSpawn = resolve;
          });
        }
        bus.emit("subagents:created", {
          id: "new-task-agent",
          owner: { extension: "pi-workflows", runId, nodeId, attemptId },
        });
        bus.emit("subagents:started", {
          id: "new-task-agent",
          owner: { extension: "pi-workflows", runId, nodeId, attemptId },
        });
        bus.emit("subagents:compacted", {
          id: "new-task-agent",
          compactionCount: 1,
          owner: { extension: "pi-workflows", runId, nodeId, attemptId },
        });
        setImmediate(() =>
          bus.emit("subagents:completed", {
            id: "new-task-agent",
            result: "new task result",
            owner: { extension: "pi-workflows", runId, nodeId, attemptId },
          }),
        );
        return { id: "new-task-agent", state: "running" };
      },
      async stop(agentId) {
        stopped.push(agentId);
      },
      async stopOwned(agentId) {
        stopped.push(agentId);
      },
      async quiesceOwned() {
        return { settled: true, pending: [] };
      },
    };
    const engine = new WorkflowEngine(bus, client, { append: (event) => journal.push(event) });
    const started = await engine.start(oneTask, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    const oldAttemptId = `${started.runId}/a/attempt-1`;
    const quiescing = engine.quiesceForBranchChange();
    await new Promise((resolve) => setImmediate(resolve));
    resolveOldSpawn({ id: "old-task-agent", state: "running" });
    await expect(quiescing).resolves.toMatchObject({ settled: true, pending: [] });

    const entries: SessionEntryLike[] = journal.map((data) => ({
      type: "custom",
      customType: "pi-workflows:journal",
      data,
    }));
    engine.restore(entries);
    engine.resumeLifecycle();
    const restored = engine.getRun(started.runId);
    if (!restored) throw new Error("workflow was not restored");
    expect(restored.status).toBe("interrupted");
    expect(restored.taskStatus.a).toBe("ready");
    expect(restored.attemptIds.a).toBe(`${started.runId}/a/attempt-2`);
    const before = JSON.stringify({
      status: restored.status,
      taskStatus: restored.taskStatus,
      taskResults: restored.taskResults,
      compactions: restored.compactions,
      attemptId: restored.attemptIds.a,
    });
    const journalCount = journal.length;

    for (const eventName of [
      "subagents:created",
      "subagents:started",
      "subagents:compacted",
      "subagents:completed",
      "subagents:failed",
    ]) {
      bus.emit(eventName, {
        id: "old-task-agent",
        result: "stale task result",
        compactionCount: 99,
        owner: { extension: "pi-workflows", runId: started.runId, nodeId: "a", attemptId: oldAttemptId },
      });
    }
    expect(
      JSON.stringify({
        status: restored.status,
        taskStatus: restored.taskStatus,
        taskResults: restored.taskResults,
        compactions: restored.compactions,
        attemptId: restored.attemptIds.a,
      }),
    ).toBe(before);
    expect(journal).toHaveLength(journalCount);

    resolveOldSpawn({ id: "old-task-agent", state: "running" });
    await new Promise((resolve) => setImmediate(resolve));
    await engine.control("resume", started.runId);
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toEqual(["old-task-agent"]);
    expect(spawnedAttempts).toEqual([oldAttemptId, `${started.runId}/a/attempt-2`]);
    expect(engine.getRun(started.runId)?.taskStatus.a).toBe("completed");
    expect(engine.getRun(started.runId)?.taskResults.a?.text).toBe("new task result");
    engine.dispose();
  });

  it("supersedes an unresolved synthesis dispatch before accepting stale output", async () => {
    const bus = new Bus(false);
    const journal: JournalEvent[] = [];
    const synthesisAttempts: string[] = [];
    const stopped: string[] = [];
    let synthesisSpawnCount = 0;
    let resolveOldSynthesis!: (response: ManagedSpawnResponse) => void;
    const oneTask = { ...definition, tasks: [firstDefinitionTask], background: true };
    const client: ManagedSpawnClient = {
      async spawn(_task, runId, nodeId, _ctx, attemptId) {
        if (nodeId === "a") return { id: "task-agent", state: "running" };
        synthesisAttempts.push(attemptId ?? "missing-attempt");
        synthesisSpawnCount += 1;
        if (synthesisSpawnCount === 1) {
          return new Promise<ManagedSpawnResponse>((resolve) => {
            resolveOldSynthesis = resolve;
          });
        }
        bus.emit("subagents:created", {
          id: "new-synthesis-agent",
          owner: { extension: "pi-workflows", runId, nodeId, attemptId },
        });
        bus.emit("subagents:started", {
          id: "new-synthesis-agent",
          owner: { extension: "pi-workflows", runId, nodeId, attemptId },
        });
        bus.emit("subagents:compacted", {
          id: "new-synthesis-agent",
          compactionCount: 2,
          owner: { extension: "pi-workflows", runId, nodeId, attemptId },
        });
        setImmediate(() =>
          bus.emit("subagents:completed", {
            id: "new-synthesis-agent",
            result: "new synthesis result",
            owner: { extension: "pi-workflows", runId, nodeId, attemptId },
          }),
        );
        return { id: "new-synthesis-agent", state: "running" };
      },
      async stop(agentId) {
        stopped.push(agentId);
      },
      async stopOwned(agentId) {
        stopped.push(agentId);
      },
      async quiesceOwned() {
        return { settled: true, pending: [] };
      },
    };
    const engine = new WorkflowEngine(bus, client, { append: (event) => journal.push(event) });
    const started = await engine.start(oneTask, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    const running = engine.getRun(started.runId);
    if (!running) throw new Error("workflow did not start");
    const taskAttemptId = running.attemptIds.a;
    bus.emit("subagents:completed", {
      id: "task-agent",
      result: "task result",
      owner: { extension: "pi-workflows", runId: started.runId, nodeId: "a", attemptId: taskAttemptId },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(engine.getRun(started.runId)?.status).toBe("synthesizing");

    const oldAttemptId = `${started.runId}/__synthesis__/attempt-1`;
    const quiescing = engine.quiesceForBranchChange();
    await new Promise((resolve) => setImmediate(resolve));
    resolveOldSynthesis({ id: "old-synthesis-agent", state: "running" });
    await expect(quiescing).resolves.toMatchObject({ settled: true, pending: [] });
    const entries: SessionEntryLike[] = journal.map((data) => ({
      type: "custom",
      customType: "pi-workflows:journal",
      data,
    }));
    engine.restore(entries);
    engine.resumeLifecycle();
    const restored = engine.getRun(started.runId);
    if (!restored) throw new Error("workflow was not restored");
    expect(restored.status).toBe("interrupted");
    expect(restored.synthesisAgentId).toBeUndefined();
    expect(restored.attemptIds.__synthesis__).toBe(`${started.runId}/__synthesis__/attempt-2`);
    const before = JSON.stringify({
      status: restored.status,
      synthesisAgentId: restored.synthesisAgentId,
      synthesisResult: restored.synthesisResult,
      compactions: restored.compactions,
      attemptId: restored.attemptIds.__synthesis__,
    });
    const journalCount = journal.length;

    for (const eventName of [
      "subagents:created",
      "subagents:started",
      "subagents:compacted",
      "subagents:completed",
      "subagents:failed",
    ]) {
      bus.emit(eventName, {
        id: "old-synthesis-agent",
        result: "stale synthesis result",
        compactionCount: 77,
        owner: { extension: "pi-workflows", runId: started.runId, nodeId: "__synthesis__", attemptId: oldAttemptId },
      });
    }
    expect(
      JSON.stringify({
        status: restored.status,
        synthesisAgentId: restored.synthesisAgentId,
        synthesisResult: restored.synthesisResult,
        compactions: restored.compactions,
        attemptId: restored.attemptIds.__synthesis__,
      }),
    ).toBe(before);
    expect(journal).toHaveLength(journalCount);

    resolveOldSynthesis({ id: "old-synthesis-agent", state: "running" });
    await new Promise((resolve) => setImmediate(resolve));
    await engine.control("resume", started.runId);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toEqual(["old-synthesis-agent"]);
    expect(synthesisAttempts).toEqual([oldAttemptId, `${started.runId}/__synthesis__/attempt-2`]);
    expect(engine.getRun(started.runId)?.status).toBe("completed");
    expect(engine.getRun(started.runId)?.synthesisResult?.text).toBe("new synthesis result");
    engine.dispose();
  });

  it("reuses a durable task recovery across stale restores and rotates a newer attempt once", () => {
    const bus = new Bus();
    const runId = "restore-idempotent-task";
    const oneTaskDefinition = { ...definition, tasks: [firstDefinitionTask], synthesis: undefined, background: true };
    const attemptOne = `${runId}/a/attempt-1`;
    const attemptTwo = `${runId}/a/attempt-2`;
    const custom = (data: unknown): SessionEntryLike => ({
      type: "custom",
      customType: "pi-workflows:journal",
      data,
    });
    const staleEntries: SessionEntryLike[] = [
      custom({
        kind: "run_created",
        schemaVersion: 2,
        runId,
        definition: oneTaskDefinition,
        attempts: { a: 1, __synthesis__: 1 },
        attemptIds: { a: attemptOne, __synthesis__: `${runId}/__synthesis__/attempt-1` },
        timestamp: 1,
      }),
      custom({ kind: "workflow_transition", schemaVersion: 2, runId, status: "running", timestamp: 2 }),
      custom({
        kind: "task_transition",
        schemaVersion: 2,
        runId,
        nodeId: "a",
        status: "running",
        agentId: "old-task-agent",
        attemptId: attemptOne,
        owner: { extension: "pi-workflows", runId, nodeId: "a", attemptId: attemptOne },
        timestamp: 3,
      }),
    ];
    const journal: JournalEvent[] = [];
    const engine = new WorkflowEngine(
      bus,
      { spawn: async () => "unused", stop: async () => {} },
      { append: (event) => journal.push(event) },
    );

    engine.restore(staleEntries, 0);
    expect(engine.getRun(runId)?.status).toBe("interrupted");
    expect(engine.getRun(runId)?.attempts.a).toBe(2);
    expect(journal.filter((event) => event.kind === "run_recovery")).toHaveLength(1);
    const firstRestoreJournalLength = journal.length;

    engine.restore(staleEntries, 0);
    expect(journal).toHaveLength(firstRestoreJournalLength);
    expect(engine.getRun(runId)?.attempts.a).toBe(2);

    const replayedEntries = [
      ...staleEntries,
      ...journal.map((data) => ({ type: "custom" as const, customType: "pi-workflows:journal", data })),
    ];
    const replay = new WorkflowEngine(bus, { spawn: async () => "unused", stop: async () => {} }, { append: () => {} });
    replay.restore(replayedEntries, 0);
    expect(replay.getRun(runId)?.status).toBe("interrupted");
    expect(replay.getRun(runId)?.attempts.a).toBe(2);
    expect(replay.getRun(runId)?.attemptIds.a).toBe(attemptTwo);

    const newerAttemptEntries = [
      ...replayedEntries,
      custom({ kind: "workflow_transition", schemaVersion: 2, runId, status: "running", timestamp: 10 }),
      custom({
        kind: "task_transition",
        schemaVersion: 2,
        runId,
        nodeId: "a",
        status: "dispatching",
        attemptId: attemptTwo,
        owner: { extension: "pi-workflows", runId, nodeId: "a", attemptId: attemptTwo },
        timestamp: 11,
      }),
      custom({
        kind: "task_transition",
        schemaVersion: 2,
        runId,
        nodeId: "a",
        status: "running",
        agentId: "new-task-agent",
        attemptId: attemptTwo,
        owner: { extension: "pi-workflows", runId, nodeId: "a", attemptId: attemptTwo },
        timestamp: 12,
      }),
    ];
    const beforeNewerRecovery = journal.length;
    engine.restore(newerAttemptEntries, 0);
    expect(engine.getRun(runId)?.attempts.a).toBe(3);
    expect(journal.length).toBeGreaterThan(beforeNewerRecovery);
    expect(
      journal
        .filter((event) => event.kind === "run_recovery")
        .flatMap((event) => event.rotations)
        .map((rotation) => rotation.generation),
    ).toEqual([2, 3]);
    const afterNewerRecovery = journal.length;
    engine.restore(newerAttemptEntries, 0);
    expect(journal).toHaveLength(afterNewerRecovery);
    expect(engine.getRun(runId)?.attempts.a).toBe(3);

    const branchJournal: JournalEvent[] = [];
    const branchEngine = new WorkflowEngine(
      bus,
      { spawn: async () => "unused", stop: async () => {} },
      { append: (event) => branchJournal.push(event) },
    );
    branchEngine.restore(staleEntries, 41);
    const firstBranchLength = branchJournal.length;
    branchEngine.restore(staleEntries, 42);
    expect(branchJournal.length).toBeGreaterThan(firstBranchLength);
    expect(branchJournal.filter((event) => event.kind === "run_recovery")).toHaveLength(2);
    branchEngine.dispose();
    replay.dispose();
    engine.dispose();
  });

  it("makes synthesis recovery idempotent and retries after an append failure", () => {
    const runId = "restore-idempotent-synthesis";
    const synthesisDefinition = { ...definition, tasks: [firstDefinitionTask], background: true };
    const attemptOne = `${runId}/__synthesis__/attempt-1`;
    const attemptTwo = `${runId}/__synthesis__/attempt-2`;
    const custom = (data: unknown): SessionEntryLike => ({
      type: "custom",
      customType: "pi-workflows:journal",
      data,
    });
    const staleEntries: SessionEntryLike[] = [
      custom({
        kind: "run_created",
        schemaVersion: 2,
        runId,
        definition: synthesisDefinition,
        attempts: { a: 1, __synthesis__: 1 },
        attemptIds: { a: `${runId}/a/attempt-1`, __synthesis__: attemptOne },
        timestamp: 1,
      }),
      custom({ kind: "workflow_transition", schemaVersion: 2, runId, status: "running", timestamp: 2 }),
      custom({
        kind: "task_result",
        schemaVersion: 2,
        runId,
        nodeId: "a",
        attemptId: `${runId}/a/attempt-1`,
        owner: { extension: "pi-workflows", runId, nodeId: "a", attemptId: `${runId}/a/attempt-1` },
        result: {
          status: "completed",
          attemptId: `${runId}/a/attempt-1`,
          text: "task result",
          compactionCount: 0,
          updatedAt: 3,
        },
        timestamp: 3,
      }),
      custom({ kind: "workflow_transition", schemaVersion: 2, runId, status: "synthesizing", timestamp: 4 }),
    ];
    const journal: JournalEvent[] = [];
    const engine = new WorkflowEngine(
      new Bus(),
      { spawn: async () => "unused", stop: async () => {} },
      { append: (event) => journal.push(event) },
    );

    engine.restore(staleEntries, 0);
    expect(engine.getRun(runId)?.status).toBe("interrupted");
    expect(engine.getRun(runId)?.attempts.__synthesis__).toBe(2);
    expect(journal.filter((event) => event.kind === "run_recovery")).toHaveLength(1);
    const firstRestoreJournalLength = journal.length;
    engine.restore(staleEntries, 0);
    expect(journal).toHaveLength(firstRestoreJournalLength);
    expect(engine.getRun(runId)?.attemptIds.__synthesis__).toBe(attemptTwo);

    const replayedEntries = [
      ...staleEntries,
      ...journal.map((data) => ({ type: "custom" as const, customType: "pi-workflows:journal", data })),
    ];
    const replay = new WorkflowEngine(
      new Bus(),
      { spawn: async () => "unused", stop: async () => {} },
      { append: () => {} },
    );
    replay.restore(replayedEntries, 0);
    expect(replay.getRun(runId)?.attempts.__synthesis__).toBe(2);
    expect(replay.getRun(runId)?.status).toBe("interrupted");

    const newerAttemptEntries = [
      ...replayedEntries,
      custom({ kind: "workflow_transition", schemaVersion: 2, runId, status: "running", timestamp: 10 }),
      custom({ kind: "workflow_transition", schemaVersion: 2, runId, status: "synthesizing", timestamp: 11 }),
    ];
    const beforeNewerRecovery = journal.length;
    engine.restore(newerAttemptEntries, 0);
    expect(engine.getRun(runId)?.attempts.__synthesis__).toBe(3);
    expect(journal.length).toBeGreaterThan(beforeNewerRecovery);
    const afterNewerRecovery = journal.length;
    engine.restore(newerAttemptEntries, 0);
    expect(journal).toHaveLength(afterNewerRecovery);

    let failAttemptAppend = true;
    const retryJournal: JournalEvent[] = [];
    const retryEngine = new WorkflowEngine(
      new Bus(),
      { spawn: async () => "unused", stop: async () => {} },
      {
        append: (event) => {
          if (event.kind === "run_recovery" && failAttemptAppend) {
            failAttemptAppend = false;
            // Simulate a durable append whose acknowledgement is lost.
            retryJournal.push(event);
            throw new Error("injected task+synthesis recovery append failure");
          }
          retryJournal.push(event);
        },
      },
    );
    expect(() => retryEngine.restore(staleEntries, 0)).toThrow(/append failure/);
    expect(retryEngine.getRun(runId)?.status).toBe("synthesizing");
    expect(retryEngine.getRun(runId)?.attempts.__synthesis__).toBe(1);
    expect(retryJournal.filter((event) => event.kind === "run_recovery")).toHaveLength(1);
    retryEngine.restore(staleEntries, 0);
    const retryRecoveries = retryJournal.filter(
      (event): event is Extract<JournalEvent, { kind: "run_recovery" }> => event.kind === "run_recovery",
    );
    expect(retryRecoveries).toHaveLength(2);
    expect(retryRecoveries[0]?.recoveryId).toBe(retryRecoveries[1]?.recoveryId);
    expect(retryEngine.getRun(runId)?.attempts.__synthesis__).toBe(2);

    const durableReplay = new WorkflowEngine(
      new Bus(),
      { spawn: async () => "unused", stop: async () => {} },
      { append: () => {} },
    );
    durableReplay.restore(
      [
        ...staleEntries,
        ...retryJournal.map((data) => ({ type: "custom" as const, customType: "pi-workflows:journal", data })),
      ],
      0,
    );
    expect(durableReplay.getRun(runId)?.attempts.__synthesis__).toBe(2);
    expect(durableReplay.getRun(runId)?.status).toBe("interrupted");
    durableReplay.dispose();

    retryEngine.dispose();
    replay.dispose();
    engine.dispose();
  });

  it("persists multiple active rotations as one atomic run recovery and retries after append failure", () => {
    const runId = "atomic-multi-recovery";
    const multiDefinition = {
      ...definition,
      tasks: definition.tasks.slice(0, 2),
      synthesis: undefined,
      background: true,
    };
    const custom = (data: unknown): SessionEntryLike => ({
      type: "custom",
      customType: "pi-workflows:journal",
      data,
    });
    const entries: SessionEntryLike[] = [
      custom({
        kind: "run_created",
        schemaVersion: 2,
        runId,
        definition: multiDefinition,
        attempts: { a: 1, b: 1, __synthesis__: 1 },
        attemptIds: {
          a: `${runId}/a/attempt-1`,
          b: `${runId}/b/attempt-1`,
          __synthesis__: `${runId}/__synthesis__/attempt-1`,
        },
        timestamp: 1,
      }),
      custom({ kind: "workflow_transition", schemaVersion: 2, runId, status: "running", timestamp: 2 }),
      custom({
        kind: "task_transition",
        schemaVersion: 2,
        runId,
        nodeId: "a",
        status: "running",
        attemptId: `${runId}/a/attempt-1`,
        agentId: "a-old",
        owner: { extension: "pi-workflows", runId, nodeId: "a", attemptId: `${runId}/a/attempt-1` },
        timestamp: 3,
      }),
      custom({
        kind: "task_transition",
        schemaVersion: 2,
        runId,
        nodeId: "b",
        status: "running",
        attemptId: `${runId}/b/attempt-1`,
        agentId: "b-old",
        owner: { extension: "pi-workflows", runId, nodeId: "b", attemptId: `${runId}/b/attempt-1` },
        timestamp: 4,
      }),
    ];
    let failNext = true;
    let appendCalls = 0;
    const journal: JournalEvent[] = [];
    const engine = new WorkflowEngine(
      new Bus(),
      { spawn: async () => "unused", stop: async () => {} },
      {
        append: (event) => {
          appendCalls += 1;
          if (failNext) {
            failNext = false;
            // Simulate a durable append whose acknowledgement is lost.
            journal.push(event);
            throw new Error("injected atomic recovery failure");
          }
          journal.push(event);
        },
      },
    );

    expect(() => engine.restore(entries, 7)).toThrow(/atomic recovery failure/);
    expect(engine.getRun(runId)?.status).toBe("running");
    expect(engine.getRun(runId)?.attempts).toMatchObject({ a: 1, b: 1 });
    expect(engine.getRun(runId)?.taskStatus).toMatchObject({ a: "running", b: "running" });
    expect(journal).toHaveLength(1);

    engine.restore(entries, 7);
    expect(appendCalls).toBe(2);
    expect(journal).toHaveLength(2);
    const recoveries = journal.filter(
      (event): event is Extract<JournalEvent, { kind: "run_recovery" }> => event.kind === "run_recovery",
    );
    expect(recoveries).toHaveLength(2);
    expect(recoveries[0]?.recoveryId).toBe(recoveries[1]?.recoveryId);
    const recovery = recoveries[0];
    if (!recovery) throw new Error("missing atomic recovery event");
    expect(recovery.rotations.map((rotation) => rotation.nodeId)).toEqual(["a", "b"]);
    expect(recovery.branchGeneration).toBe(7);
    expect(engine.getRun(runId)?.status).toBe("interrupted");
    expect(engine.getRun(runId)?.taskStatus).toMatchObject({ a: "ready", b: "ready" });
    expect(engine.getRun(runId)?.attempts).toMatchObject({ a: 2, b: 2 });

    // Replaying both durable copies is one rotation, not corruption.
    const replay = new WorkflowEngine(
      new Bus(),
      { spawn: async () => "unused", stop: async () => {} },
      { append: () => {} },
    );
    replay.restore([...entries, ...journal.map((data) => custom(data))], 7);
    expect(replay.getRun(runId)?.status).toBe("interrupted");
    expect(replay.getRun(runId)?.taskStatus).toMatchObject({ a: "ready", b: "ready" });
    expect(replay.getRun(runId)?.attemptIds.a).toBe(`${runId}/a/attempt-2`);

    const prewriteJournal: JournalEvent[] = [];
    const prewriteEngine = new WorkflowEngine(
      new Bus(),
      { spawn: async () => "unused", stop: async () => {} },
      {
        append: () => {
          throw new Error("injected pre-write failure");
        },
      },
    );
    expect(() => prewriteEngine.restore(entries, 7)).toThrow(/pre-write failure/);
    expect(prewriteJournal).toHaveLength(0);
    expect(prewriteEngine.getRun(runId)?.attempts).toMatchObject({ a: 1, b: 1 });
    prewriteEngine.dispose();
    // The exact stale snapshot is memoized only after append succeeds.
    engine.restore(entries, 7);
    expect(appendCalls).toBe(2);
    replay.dispose();
    engine.dispose();
  });

  it("migrates a legacy interruption prefix with independent valid attempt recovery", () => {
    const runId = "legacy-recovery-prefix";
    const task = firstDefinitionTask;
    const legacyDefinition = { ...definition, tasks: [task], synthesis: undefined, background: true };
    const attemptOne = `${runId}/a/attempt-1`;
    const entries: SessionEntryLike[] = [
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: {
          kind: "run_created",
          schemaVersion: 2,
          runId,
          definition: legacyDefinition,
          attempts: { a: 1, __synthesis__: 1 },
          attemptIds: { a: attemptOne, __synthesis__: `${runId}/__synthesis__/attempt-1` },
          timestamp: 1,
        },
      },
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: { kind: "workflow_transition", schemaVersion: 2, runId, status: "running", timestamp: 2 },
      },
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: {
          kind: "task_transition",
          schemaVersion: 2,
          runId,
          nodeId: "a",
          status: "running",
          attemptId: attemptOne,
          owner: { extension: "pi-workflows", runId, nodeId: "a", attemptId: attemptOne },
          timestamp: 3,
        },
      },
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: { kind: "workflow_transition", schemaVersion: 2, runId, status: "interrupted", timestamp: 4 },
      },
    ];
    const journal: JournalEvent[] = [];
    const engine = new WorkflowEngine(
      new Bus(),
      { spawn: async () => "unused", stop: async () => {} },
      { append: (event) => journal.push(event) },
    );
    engine.restore(entries, 3);
    expect(engine.getRun(runId)?.status).toBe("interrupted");
    expect(engine.getRun(runId)?.taskStatus.a).toBe("ready");
    expect(engine.getRun(runId)?.attempts.a).toBe(2);
    expect(journal).toHaveLength(1);
    const migration = journal[0];
    if (migration?.kind !== "attempt_recovery") throw new Error("missing legacy migration event");
    expect(migration.legacyMigration).toBe(true);

    const replay = new WorkflowEngine(
      new Bus(),
      { spawn: async () => "unused", stop: async () => {} },
      { append: () => {} },
    );
    replay.restore([...entries, { type: "custom", customType: "pi-workflows:journal", data: migration }], 3);
    expect(replay.getRun(runId)?.status).toBe("interrupted");
    expect(replay.getRun(runId)?.taskStatus.a).toBe("ready");
    expect(replay.getRun(runId)?.attempts.a).toBe(2);
    replay.dispose();
    engine.dispose();
  });

  it("recovers terminal-intent branches with terminal task facts and no duplicate append", () => {
    const runId = "terminal-recovery";
    const taskDefinition = {
      ...definition,
      tasks: definition.tasks.slice(0, 2),
      synthesis: undefined,
      background: true,
    };
    const attemptA = `${runId}/a/attempt-1`;
    const attemptB = `${runId}/b/attempt-1`;
    const custom = (data: unknown): SessionEntryLike => ({
      type: "custom",
      customType: "pi-workflows:journal",
      data,
    });
    const entries: SessionEntryLike[] = [
      custom({
        kind: "run_created",
        schemaVersion: 2,
        runId,
        definition: taskDefinition,
        attempts: { a: 1, b: 1, __synthesis__: 1 },
        attemptIds: {
          a: attemptA,
          b: attemptB,
          __synthesis__: `${runId}/__synthesis__/attempt-1`,
        },
        timestamp: 1,
      }),
      custom({ kind: "workflow_transition", schemaVersion: 2, runId, status: "running", timestamp: 2 }),
      custom({
        kind: "task_transition",
        schemaVersion: 2,
        runId,
        nodeId: "a",
        status: "running",
        agentId: "a-agent",
        attemptId: attemptA,
        owner: { extension: "pi-workflows", runId, nodeId: "a", attemptId: attemptA },
        timestamp: 3,
      }),
      custom({
        kind: "task_transition",
        schemaVersion: 2,
        runId,
        nodeId: "b",
        status: "running",
        agentId: "b-agent",
        attemptId: attemptB,
        owner: { extension: "pi-workflows", runId, nodeId: "b", attemptId: attemptB },
        timestamp: 4,
      }),
      custom({
        kind: "workflow_transition",
        schemaVersion: 2,
        runId,
        status: "stopping",
        error: "task failed",
        terminalIntent: "failure",
        timestamp: 5,
      }),
    ];
    const journal: JournalEvent[] = [];
    const engine = new WorkflowEngine(
      new Bus(),
      { spawn: async () => "unused", stop: async () => {} },
      { append: (event) => journal.push(event) },
    );

    engine.restore(entries, 0);
    const recovered = engine.getRun(runId);
    expect(recovered?.status).toBe("failed");
    expect(recovered?.taskStatus).toMatchObject({ a: "stopped", b: "stopped" });
    expect(recovered?.taskResults.a?.status).toBe("stopped");
    expect(recovered?.taskResults.b?.status).toBe("stopped");
    const terminalRecovery = journal.filter((event) => event.kind === "terminal_recovery");
    expect(terminalRecovery).toHaveLength(1);
    expect(terminalRecovery[0]?.terminalResults.map((fact) => fact.nodeId)).toEqual(["a", "b"]);
    const firstAppendCount = journal.length;

    engine.restore(entries, 0);
    expect(journal).toHaveLength(firstAppendCount);
    expect(engine.getRun(runId)?.status).toBe("failed");

    const replay = new WorkflowEngine(
      new Bus(),
      { spawn: async () => "unexpected", stop: async () => {} },
      { append: () => {} },
    );
    replay.restore([...entries, ...journal.map((data) => custom(data))], 0);
    expect(replay.getRun(runId)?.status).toBe("failed");
    expect(replay.getRun(runId)?.taskStatus).toMatchObject({ a: "stopped", b: "stopped" });
    replay.dispose();
    engine.dispose();
  });

  it("atomically recovers mixed terminal records, retries an append boundary, and stays terminal across restores", () => {
    const runId = "mixed-terminal-recovery";
    const mixedDefinition = {
      ...definition,
      tasks: [
        { ...definition.tasks[0], id: "a", depends_on: [] },
        { ...definition.tasks[1], id: "b", depends_on: [] },
        { ...definition.tasks[2], id: "c", depends_on: ["a"] },
      ],
      synthesis: definition.synthesis,
      background: true,
    };
    const attempt = (nodeId: string): string => `${runId}/${nodeId}/attempt-1`;
    const custom = (data: unknown): SessionEntryLike => ({
      type: "custom",
      customType: "pi-workflows:journal",
      data,
    });
    const entries: SessionEntryLike[] = [
      custom({
        kind: "run_created",
        schemaVersion: 2,
        runId,
        definition: mixedDefinition,
        attempts: { a: 1, b: 1, c: 1, __synthesis__: 1 },
        attemptIds: {
          a: attempt("a"),
          b: attempt("b"),
          c: attempt("c"),
          __synthesis__: attempt("__synthesis__"),
        },
        timestamp: 1,
      }),
      custom({ kind: "workflow_transition", schemaVersion: 2, runId, status: "running", timestamp: 2 }),
      custom({
        kind: "task_transition",
        schemaVersion: 2,
        runId,
        nodeId: "a",
        status: "running",
        attemptId: attempt("a"),
        owner: { extension: "pi-workflows", runId, nodeId: "a", attemptId: attempt("a") },
        timestamp: 3,
      }),
      custom({
        kind: "task_result",
        schemaVersion: 2,
        runId,
        nodeId: "a",
        attemptId: attempt("a"),
        owner: { extension: "pi-workflows", runId, nodeId: "a", attemptId: attempt("a") },
        result: { status: "failed", attemptId: attempt("a"), error: "boom", compactionCount: 0, updatedAt: 4 },
        timestamp: 4,
      }),
      custom({
        kind: "task_transition",
        schemaVersion: 2,
        runId,
        nodeId: "b",
        status: "running",
        attemptId: attempt("b"),
        owner: { extension: "pi-workflows", runId, nodeId: "b", attemptId: attempt("b") },
        agentId: "b-agent",
        timestamp: 3,
      }),
      custom({
        kind: "task_transition",
        schemaVersion: 2,
        runId,
        nodeId: "c",
        status: "ready",
        attemptId: attempt("c"),
        owner: { extension: "pi-workflows", runId, nodeId: "c", attemptId: attempt("c") },
        timestamp: 3,
      }),
      custom({
        kind: "workflow_transition",
        schemaVersion: 2,
        runId,
        status: "stopping",
        terminalIntent: "failure",
        error: "boom",
        timestamp: 5,
      }),
      {
        type: "custom",
        customType: "subagents:record",
        data: {
          runId,
          id: "b-agent",
          status: "stopped",
          error: "cleanup stop",
          owner: { extension: "pi-workflows", runId, nodeId: "b", attemptId: attempt("b") },
        },
      },
    ];
    let failOnce = true;
    const journal: JournalEvent[] = [];
    const engine = new WorkflowEngine(
      new Bus(),
      { spawn: async () => "unused", stop: async () => {} },
      {
        append: (event) => {
          journal.push(event);
          if (failOnce && event.kind === "terminal_recovery") {
            failOnce = false;
            throw new Error("terminal append boundary");
          }
        },
      },
    );

    expect(() => engine.restore(entries, 0)).toThrow(/terminal append boundary/);
    expect(engine.getRun(runId)?.status).toBe("stopping");
    expect(engine.getRun(runId)?.taskStatus).toMatchObject({ a: "failed", b: "running", c: "ready" });
    expect(journal.filter((event) => event.kind === "terminal_recovery")).toHaveLength(1);

    engine.restore(entries, 0);
    const recoveries = journal.filter(
      (event): event is Extract<JournalEvent, { kind: "terminal_recovery" }> => event.kind === "terminal_recovery",
    );
    expect(recoveries).toHaveLength(2);
    expect(recoveries[0]?.recoveryId).toBe(recoveries[1]?.recoveryId);
    expect(recoveries[0]?.blockedNodeIds).toEqual(["c"]);
    expect(recoveries[0]?.terminalResults.map((fact) => fact.nodeId)).toEqual(["b", "__synthesis__"]);
    expect(engine.getRun(runId)?.status).toBe("failed");
    expect(engine.getRun(runId)?.taskStatus).toMatchObject({ a: "failed", b: "stopped", c: "blocked" });
    expect(
      Object.values(engine.getRun(runId)?.taskStatus ?? {}).every((status) =>
        ["completed", "failed", "stopped", "blocked"].includes(status),
      ),
    ).toBe(true);

    const appendCount = journal.length;
    engine.restore(entries, 0);
    engine.restore(entries, 0);
    expect(journal).toHaveLength(appendCount);
    expect(engine.getRun(runId)?.taskStatus).toMatchObject({ a: "failed", b: "stopped", c: "blocked" });

    const replay = new WorkflowEngine(
      new Bus(),
      { spawn: async () => "unexpected", stop: async () => {} },
      { append: () => {} },
    );
    replay.restore([...entries, ...journal.map((event) => custom(event))], 0);
    expect(replay.getRun(runId)?.status).toBe("failed");
    expect(replay.getRun(runId)?.taskStatus).toMatchObject({ a: "failed", b: "stopped", c: "blocked" });
    expect(replay.getRun(runId)?.synthesisResult?.status).toBe("stopped");
    replay.dispose();
    engine.dispose();
  });
});
