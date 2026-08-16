import { parseManagedSpawnRequest } from "@signalridge/pi-subagents-protocol";
import { describe, expect, it } from "vitest";
import { WorkflowEngine } from "../src/engine.js";
import type { JournalEvent, SessionEntryLike } from "../src/journal.js";
import type { ManagedSpawnClient, WorkflowEventBus } from "../src/rpc-client.js";
import type { WorkflowDefinition, WorkflowTask } from "../src/schema.js";

class Bus implements WorkflowEventBus {
  private listeners = new Map<string, Set<(data: unknown) => void>>();
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
      owner && typeof owner.runId === "string" && typeof owner.nodeId === "string" && owner.attemptId === undefined
        ? {
            ...value,
            owner: {
              ...owner,
              attemptId: `${owner.runId}/${owner.nodeId}/attempt-1`,
            },
          }
        : data;
    for (const handler of this.listeners.get(event) ?? []) handler(enriched);
  }
}

const ctx = {} as never;
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function chained(overrides: Partial<WorkflowTask> = {}): WorkflowDefinition {
  return {
    name: "chained",
    phases: [],
    tasks: [
      {
        id: "a",
        subagent_type: "Explore",
        description: "A",
        prompt: "A",
        depends_on: [],
      },
      {
        id: "b",
        subagent_type: "Explore",
        description: "B",
        prompt: "B",
        depends_on: [],
      },
      {
        id: "c",
        subagent_type: "Explore",
        description: "C",
        prompt: "C",
        depends_on: ["a", "b"],
        ...overrides,
      },
    ],
    background: true,
  };
}

/** Spawns immediately, records every dispatched prompt, and completes only on demand. */
function recordingClient(bus: Bus): {
  client: ManagedSpawnClient;
  prompts: Map<string, string>;
} {
  const prompts = new Map<string, string>();
  const client: ManagedSpawnClient = {
    async spawn(task, runId, nodeId, attemptId) {
      prompts.set(nodeId, task.prompt);
      const id = `${nodeId}-agent`;
      const owner = { extension: "pi-workflows", runId, nodeId, attemptId };
      bus.emit("subagents:created", { id, owner });
      bus.emit("subagents:started", { id, owner });
      return id;
    },
    async stop() {},
    async stopOwned() {},
    async quiesceOwned() {
      return { settled: true, pending: [] };
    },
  };
  return { client, prompts };
}

function complete(bus: Bus, runId: string, nodeId: string, result: string): void {
  bus.emit("subagents:completed", {
    id: `${nodeId}-agent`,
    result,
    owner: { extension: "pi-workflows", runId, nodeId },
  });
}

describe("bounded dependency inputs", () => {
  it("chains a dependency result into the downstream prompt", async () => {
    const bus = new Bus();
    const { client, prompts } = recordingClient(bus);
    const engine = new WorkflowEngine(bus, client, { append: () => {} });
    const started = await engine.start(chained({ inputs: ["a"] }), ctx);
    await tick();

    complete(bus, started.runId, "a", "A result");
    complete(bus, started.runId, "b", "B result");
    await tick();

    const promptC = prompts.get("c");
    if (promptC === undefined) throw new Error("c was never dispatched");
    expect(promptC.startsWith("C\n\nDependency results (pi-workflows inputs v1):")).toBe(true);
    expect(promptC).toContain("### a — A");
    expect(promptC).toContain("status=completed");
    expect(promptC).toContain("A result");
    // b is a dependency but not an input, so nothing about it leaks in.
    expect(promptC).not.toContain("### b");
    expect(promptC).not.toContain("B result");
    // Upstream tasks are dispatched verbatim.
    expect(prompts.get("a")).toBe("A");
    expect(prompts.get("b")).toBe("B");
    engine.dispose();
  });

  it("dispatches byte-identically to today when inputs is absent", async () => {
    const bus = new Bus();
    const { client, prompts } = recordingClient(bus);
    const engine = new WorkflowEngine(bus, client, { append: () => {} });
    const started = await engine.start(chained(), ctx);
    await tick();

    complete(bus, started.runId, "a", "A result");
    complete(bus, started.runId, "b", "B result");
    await tick();

    expect(prompts.get("c")).toBe("C");
    engine.dispose();
  });

  it("composes in declared inputs order, not completion or insertion order", async () => {
    const bus = new Bus();
    const { client, prompts } = recordingClient(bus);
    const engine = new WorkflowEngine(bus, client, { append: () => {} });
    const started = await engine.start(chained({ inputs: ["b", "a"] }), ctx);
    await tick();

    // a completes first, so run.taskResults insertion order is a-then-b.
    complete(bus, started.runId, "a", "A result");
    await tick();
    complete(bus, started.runId, "b", "B result");
    await tick();

    const promptC = prompts.get("c") ?? "";
    expect(promptC.indexOf("### b — B")).toBeGreaterThan(-1);
    expect(promptC.indexOf("### b — B")).toBeLessThan(promptC.indexOf("### a — A"));
    engine.dispose();
  });

  it("recomposes an identical prompt after a replay into a fresh engine", async () => {
    const bus = new Bus();
    const journal: JournalEvent[] = [];
    const { client, prompts } = recordingClient(bus);
    const engine = new WorkflowEngine(bus, client, {
      append: (event) => journal.push(event),
    });
    const started = await engine.start(chained({ inputs: ["a", "b"] }), ctx);
    await tick();
    complete(bus, started.runId, "a", "A result");
    complete(bus, started.runId, "b", "B result");
    await tick();
    const first = prompts.get("c");
    if (first === undefined) throw new Error("c was never dispatched");
    engine.dispose();

    const entries: SessionEntryLike[] = journal.map((data) => ({
      type: "custom",
      customType: "pi-workflows:journal",
      data,
    }));
    const replayBus = new Bus();
    const replay = recordingClient(replayBus);
    const replayed = new WorkflowEngine(replayBus, replay.client, {
      append: () => {},
    });
    replayed.restore(entries);
    replayed.resumeLifecycle();
    expect(replayed.getRun(started.runId)?.status).toBe("interrupted");
    await replayed.control("resume", started.runId);
    await tick();

    // The prompt feeds pi-subagents' managed fingerprint; drift is a non-retryable spawn conflict.
    expect(replay.prompts.get("c")).toBe(first);
    replayed.dispose();
  });

  it("injects nothing rather than overflowing the protocol prompt ceiling", async () => {
    const bus = new Bus();
    const { client, prompts } = recordingClient(bus);
    const engine = new WorkflowEngine(bus, client, { append: () => {} });
    const definition = chained({ inputs: ["a"] });
    const maximal = "C".repeat(100_000);
    const [, , third] = definition.tasks;
    if (!third) throw new Error("definition lost its third task");
    third.prompt = maximal;
    const started = await engine.start(definition, ctx);
    await tick();
    complete(bus, started.runId, "a", "A result");
    complete(bus, started.runId, "b", "B result");
    await tick();

    const promptC = prompts.get("c");
    if (promptC === undefined) throw new Error("c was never dispatched");
    expect(promptC).toBe(maximal);
    expect(promptC.length).toBeLessThanOrEqual(100_000);
    // boundedString throws rather than truncating, so the request must validate as-is.
    expect(() =>
      parseManagedSpawnRequest({
        requestId: "r",
        spawnKey: `${started.runId}/c/attempt-1`,
        type: "Explore",
        prompt: promptC,
        description: "C",
        owner: {
          extension: "pi-workflows",
          runId: started.runId,
          nodeId: "c",
          attemptId: `${started.runId}/c/attempt-1`,
        },
      }),
    ).not.toThrow();
    engine.dispose();
  });

  it("still fits the ceiling when the prompt leaves only partial headroom", async () => {
    const bus = new Bus();
    const { client, prompts } = recordingClient(bus);
    const engine = new WorkflowEngine(bus, client, { append: () => {} });
    const definition = chained({ inputs: ["a"] });
    const [, , third] = definition.tasks;
    if (!third) throw new Error("definition lost its third task");
    third.prompt = "C".repeat(99_000);
    const started = await engine.start(definition, ctx);
    await tick();
    complete(bus, started.runId, "a", "A result");
    complete(bus, started.runId, "b", "B result");
    await tick();

    const promptC = prompts.get("c") ?? "";
    expect(promptC.length).toBeGreaterThan(99_000);
    expect(promptC.length).toBeLessThanOrEqual(100_000);
    expect(promptC).toContain("### a — A");
    engine.dispose();
  });

  it("emits a deterministic placeholder instead of throwing when a result is missing", async () => {
    const bus = new Bus();
    const { client, prompts } = recordingClient(bus);
    const engine = new WorkflowEngine(bus, client, { append: () => {} });
    const started = await engine.start(chained({ inputs: ["a"] }), ctx);
    await tick();

    complete(bus, started.runId, "a", "A result");
    await tick();
    // Unreachable through normal scheduling (`readyTaskIds` gates on taskStatus, which keeps
    // `a` completed), but composition must never be the thing that throws inside dispatchTask.
    const run = engine.getRun(started.runId);
    if (!run) throw new Error("run vanished");
    delete run.taskResults.a;
    complete(bus, started.runId, "b", "B result");
    await tick();

    const promptC = prompts.get("c") ?? "";
    expect(promptC).toContain("status=missing agent_id=unknown");
    expect(promptC).toContain("(no result)");
    expect(engine.getRun(started.runId)?.taskStatus.c).not.toBe("failed");
    engine.dispose();
  });
});
