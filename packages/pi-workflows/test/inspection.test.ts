import { setTimeout as realDelay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { WorkflowEngine } from "../src/engine.js";
import { INSPECTION_LIMITS, type WorkflowInspection, WorkflowPresentation } from "../src/inspection.js";
import { JOURNAL_ENTRY_TYPE, type JournalEvent } from "../src/journal.js";
import type { ManagedSpawnClient, WorkflowEventBus } from "../src/rpc-client.js";
import * as runtime from "../src/runtime.js";

const META =
  'export const meta = {name:"inspection",description:"test",phases:[{title:"declared"},{title:"entered"}]};';
function harness() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const bus: WorkflowEventBus = {
    on(name, handler) {
      const listeners = handlers.get(name) ?? new Set();
      listeners.add(handler);
      handlers.set(name, listeners);
      return () => listeners.delete(handler);
    },
    emit(name, data) {
      for (const handler of handlers.get(name) ?? []) handler(data);
    },
  };
  const entries: JournalEvent[] = [];
  const spawns: Array<{ id: string; runId: string; nodeId: string; attemptId: string }> = [];
  let manual = false;
  let spawnError: string | undefined;
  let answer = "result";
  let onSpawn: ((spawn: (typeof spawns)[number]) => void) | undefined;
  let rejectAppend: ((event: JournalEvent) => boolean) | undefined;
  const client: ManagedSpawnClient = {
    async spawn(_task, runId, nodeId, attemptId) {
      const id = `managed-${spawns.length}`;
      const spawn = { id, runId, nodeId, attemptId: attemptId ?? "" };
      spawns.push(spawn);
      onSpawn?.(spawn);
      if (spawnError) throw new Error(spawnError);
      return manual
        ? { id, state: "queued" }
        : {
            id,
            tier: "medium",
            terminal: {
              status: "completed",
              result: answer,
              outputFile: "output-reference",
              tokenCount: 12,
              compactionCount: 2,
              completedAt: Date.now(),
            },
          };
    },
    async stop() {},
    async stopOwned() {},
    async quiesceOwned() {
      return { settled: true, pending: [] };
    },
    async reconcileManaged(spawnKey, owner) {
      const spawn = spawns.find(
        (item) =>
          `${item.runId}/${item.nodeId}/${item.attemptId}` === spawnKey &&
          item.runId === owner.runId &&
          item.nodeId === owner.nodeId &&
          item.attemptId === owner.attemptId,
      );
      // Allocation survives a lost/rejected reply; the owned quiescence check
      // above, not this snapshot, supplies positive cleanup confirmation.
      return spawn ? { id: spawn.id, state: "queued" } : undefined;
    },
    async checkProtocol() {
      return {
        routingPolicyFingerprint: "test",
        routingPolicy: {
          defaultTier: "medium",
          profiles: { medium: { model: "inherit", thinking: "medium" } },
          blockedProfiles: [],
          blockedDefaultTier: false,
        },
      };
    },
  };
  const sessionEntries = () =>
    entries.map((data) => ({ type: "custom" as const, customType: JOURNAL_ENTRY_TYPE, data }));
  const engine = new WorkflowEngine(
    bus,
    client,
    {
      append: (entry) => {
        if (rejectAppend?.(entry)) throw new Error("journal unavailable");
        entries.push(entry);
      },
    },
    sessionEntries,
  );
  return {
    engine,
    bus,
    spawns,
    entries,
    sessionEntries,
    client,
    setAnswer: (value: string) => {
      answer = value;
    },
    setOnSpawn: (value: typeof onSpawn) => {
      onSpawn = value;
    },
    setRejectAppend: (value: typeof rejectAppend) => {
      rejectAppend = value;
    },
    setManual: (value: boolean) => {
      manual = value;
    },
    setSpawnError: (value?: string) => {
      spawnError = value;
    },
  };
}
const snapshot = (engine: WorkflowEngine, runId: string): WorkflowInspection => {
  const inspection = engine.getInspection(runId);
  expect(inspection).toBeDefined();
  return inspection as WorkflowInspection;
};

describe("workflow inspection", () => {
  it("is late-openable, entered rather than declared, detached, and observer-contained", async () => {
    const { engine } = harness();
    const seen: WorkflowInspection[] = [];
    engine.onInspectionChanged = (id) => {
      const value = engine.getInspection(id);
      if (value) seen.push(value);
      throw new Error("observer");
    };
    engine.onRuntimeEvent = () => {
      throw new Error("observer");
    };
    const started = await engine.start(
      `${META} phase("entered"); log("diagnostic"); return await agent("secret prompt", {label:"named",agentType:"Explore",phase:"explicit"});`,
    );
    const value = snapshot(engine, started.runId);
    expect(value).toMatchObject({
      status: "completed",
      currentPhase: "entered",
      logicalCalls: 1,
      physicalDispatches: 1,
      replayedCalls: 0,
      observationSource: "execution",
    });
    expect(value.phases).toMatchObject([
      { title: "declared", declared: true, entered: false },
      { title: "entered", declared: true, entered: true },
    ]);
    expect(value.calls[0]).toMatchObject({
      id: `${started.runId}:0`,
      label: "named",
      phase: "explicit",
      agentType: "Explore",
      tier: "medium",
      status: "completed",
      physicalStatus: "completed",
      agentId: "managed-0",
      compactionCount: 2,
      tokenCount: 12,
      resultPreview: "result",
    });
    expect(JSON.stringify(value)).not.toContain("secret prompt");
    expect(value.events.some((event) => event.message === "diagnostic")).toBe(true);
    const detached = value as unknown as {
      calls: Array<{ label: string }>;
      events: unknown[];
      phases: Array<{ title: string }>;
    };
    detached.calls[0].label = "mutated";
    detached.events.length = 0;
    detached.phases[0].title = "mutated";
    expect(snapshot(engine, started.runId).calls[0].label).toBe("named");
    expect(snapshot(engine, started.runId).events.length).toBeGreaterThan(0);
    expect(seen.some((entry) => entry.calls[0]?.status === "running")).toBe(true);
    engine.dispose();
  });

  it("reads detached primitive headers without cloning full inspection arrays", async () => {
    const { engine } = harness();
    const started = await engine.start(`${META} phase("entered"); return await agent("work");`);
    const state = engine.getState(started.runId);
    if (!state) throw new Error("missing state");
    const full = snapshot(engine, started.runId);
    const spy = vi.spyOn(state.presentation, "snapshot").mockImplementation(() => {
      throw new Error("must not clone arrays");
    });
    const header = engine.getInspectionHeader(started.runId);
    expect(header).toEqual({
      currentPhase: "entered",
      currentPhaseKey: full.currentPhaseKey,
      restored: false,
      revision: full.revision,
      executionId: full.executionId,
      executionGeneration: full.executionGeneration,
    });
    if (header) (header as { currentPhase: string }).currentPhase = "mutated";
    expect(engine.getInspectionHeader(started.runId)?.currentPhase).toBe("entered");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    engine.dispose();
    expect(engine.getInspectionHeader(started.runId)).toBeUndefined();
  });

  it("observes local checkpoints and their replay without fabricating managed dispatch", async () => {
    const { engine, spawns, sessionEntries } = harness();
    const prefix = `${META} const answer = await checkpoint("private human prompt",{default:false});`;
    const started = await engine.start(`${prefix} throw new Error("after checkpoint");`);
    expect(snapshot(engine, started.runId)).toMatchObject({ logicalCalls: 1, physicalDispatches: 0 });
    expect(snapshot(engine, started.runId).calls[0]).toMatchObject({
      kind: "checkpoint",
      label: "checkpoint",
      resultPreview: "false",
      physicalDispatches: 0,
      status: "completed",
    });
    expect(JSON.stringify(snapshot(engine, started.runId))).not.toContain("private human prompt");
    await engine.resume(started.runId, sessionEntries(), {}, `${prefix} return answer;`);
    expect(snapshot(engine, started.runId).calls[0]).toMatchObject({
      kind: "checkpoint",
      replayed: true,
      physicalDispatches: 0,
      resultPreview: "false",
    });
    expect(snapshot(engine, started.runId)).toMatchObject({ logicalCalls: 1, replayedCalls: 1, physicalDispatches: 0 });
    expect(spawns).toEqual([]);
    engine.dispose();
  });

  it("does not infer entry from implicit attribution or completion from a later phase", async () => {
    const { engine, spawns, bus, setManual } = harness();
    setManual(true);
    const started = await engine.start(
      `${META} const earlier = agent("one"); phase("entered"); const later = agent("two"); return await parallel([() => earlier, () => later]);`,
      { background: true },
    );
    await expect.poll(() => spawns.length, { timeout: 5_000 }).toBe(2);
    const value = snapshot(engine, started.runId);
    expect(value.currentPhase).toBe("entered");
    expect(value.phases[0].entered).toBe(false);
    expect(value.calls.map((call) => call.phase)).toEqual(["declared", "entered"]);
    expect(value.calls.map((call) => call.status)).toEqual(["running", "running"]);
    expect(value.calls.map((call) => call.physicalStatus)).toEqual(["queued", "queued"]);
    for (const spawn of spawns)
      bus.emit("subagents:completed", {
        id: spawn.id,
        result: "done",
        compactionCount: 3,
        tokens: { total: 17 },
        owner: { extension: "pi-workflows", runId: spawn.runId, nodeId: spawn.nodeId, attemptId: spawn.attemptId },
      });
    await engine.waitFor(started.runId);
    expect(snapshot(engine, started.runId).calls.every((call) => call.compactionCount === 3)).toBe(true);
    engine.dispose();
  });

  it("keeps repeated graph/task identities distinct and child phases scoped", async () => {
    const { engine } = harness();
    const child =
      'export const meta = {name:"child",description:"test"}; phase("child phase"); return await orchestrate([{id:"same",phase:"child task",run:()=>agent("child") }]);';
    const started = await engine.start(
      `${META} phase("entered");
      await parallel([
        () => orchestrate([{id:"same",phase:"a",run:()=>agent("a")}]),
        () => orchestrate([{id:"same",phase:"b",run:()=>agent("b")}]),
        () => workflow("child")
      ]); return "done";`,
      { loadSavedWorkflow: (name) => (name === "child" ? child : undefined) },
    );
    const value = snapshot(engine, started.runId);
    expect(value.currentPhase).toBe("entered");
    expect(value.tasks).toHaveLength(3);
    expect(new Set(value.tasks.map((task) => task.id)).size).toBe(3);
    expect(new Set(value.tasks.map((task) => task.graphId)).size).toBe(3);
    expect(value.tasks.every((task) => task.status === "completed")).toBe(true);
    const agents = value.calls.filter((call) => call.kind === "agent");
    expect(agents).toHaveLength(3);
    for (const call of agents) expect(value.tasks.find((task) => task.id === call.taskKey)?.phase).toBe(call.phase);
    expect(agents.filter((call) => call.frameId !== started.runId)).toHaveLength(1);
    expect(value.events.find((event) => event.title === "child phase")?.frameId).not.toBe(started.runId);
    engine.dispose();
  });

  it("preserves inherited nested task phase attribution without confusing frame identity", async () => {
    const { engine } = harness();
    const child =
      'export const meta = {name:"child",description:"test"}; phase("child phase"); return await agent("child");';
    const started = await engine.start(
      `${META} phase("entered"); return await orchestrate([{id:"parent",phase:"task phase",run:()=>workflow("child")}]);`,
      { loadSavedWorkflow: () => child },
    );
    const value = snapshot(engine, started.runId);
    expect(value.currentPhase).toBe("entered");
    const boundary = value.calls.find((call) => call.kind === "workflow");
    const agent = value.calls.find((call) => call.kind === "agent");
    expect(boundary).toMatchObject({ frameId: started.runId, phase: "task phase", taskKey: value.tasks[0].id });
    expect(agent).toMatchObject({ frameId: boundary?.childFrameId, phase: "task phase", taskKey: value.tasks[0].id });
    expect(agent?.frameId).not.toBe(started.runId);
    engine.dispose();
  });

  it("resets on resume, counts replay honestly, and restores journal-only unknown labels", async () => {
    const { engine, spawns, sessionEntries } = harness();
    const prefix = `${META} phase("entered"); const value = await agent("stable",{label:"known",phase:"entered"});`;
    const started = await engine.start(`${prefix} throw new Error("after call");`);
    const before = snapshot(engine, started.runId);
    expect(before.status).toBe("failed");
    const resumed = await engine.resume(started.runId, sessionEntries(), {}, `${prefix} return value;`);
    expect(resumed?.status).toBe("completed");
    const after = snapshot(engine, started.runId);
    expect(after.executionId).not.toBe(before.executionId);
    expect(after.executionGeneration).toBe(before.executionGeneration + 1);
    expect(after).toMatchObject({ physicalDispatches: 0, replayedCalls: 1, logicalCalls: 1 });
    expect(after.calls[0]).toMatchObject({
      replayed: true,
      physicalDispatches: 0,
      status: "completed",
      label: "known",
    });
    expect(spawns).toHaveLength(1);
    engine.restore(sessionEntries());
    const restored = snapshot(engine, started.runId);
    expect(restored).toMatchObject({
      restored: true,
      observationSource: "journal-only",
      logicalCalls: 0,
      physicalDispatches: 0,
    });
    expect(restored.executionId).not.toBe(after.executionId);
    expect(restored.currentPhase).toBeUndefined();
    expect(restored.events).toEqual([]);
    expect(restored.phases.every((phase) => !phase.entered)).toBe(true);
    expect(restored.calls[0]).toMatchObject({
      status: "completed",
      journalOnly: true,
      observed: false,
      resultPreview: "result",
    });
    expect(restored.calls[0].label).toBeUndefined();
    engine.dispose();
  });

  it("bounds events/labels/previews while retaining original durable results and unsafe text", async () => {
    const { engine } = harness();
    const unsafe = "\u001b[31munsafe\u0000";
    const label = unsafe + "x".repeat(1_000);
    // The display still clips a valid wire description; persistence/logging
    // independently retain the longer original text.
    const dispatchLabel = label.slice(0, 512);
    const started = await engine.start(
      `${META} phase("entered"); for(let i=0;i<200;i++) log(${JSON.stringify(label)}); await agent("prompt",{label:${JSON.stringify(dispatchLabel)}}); return ${JSON.stringify(label)};`,
    );
    const value = snapshot(engine, started.runId);
    expect(value.events).toHaveLength(INSPECTION_LIMITS.events);
    expect(value.truncated).toBe(true);
    expect(value.calls[0].label).toBe(label.slice(0, INSPECTION_LIMITS.text));
    expect(value.resultPreview).toBe(label.slice(0, INSPECTION_LIMITS.preview));
    expect(engine.getRun(started.runId)?.finalResult).toBe(label);
    expect(value.events.find((event) => event.type === "log")?.message?.startsWith(unsafe)).toBe(true);
    const projection = new WorkflowPresentation("frame");
    projection.reset();
    for (let index = 0; index < 300; index++) {
      projection.runtime({
        type: "task",
        frameId: "frame",
        graphId: `graph-${index}`,
        taskKey: `task-${index}`,
        taskId: "same",
        stage: "start",
      });
      projection.runtime({ type: "phase", frameId: "frame", title: `phase-${index}` });
    }
    const run = engine.getRun(started.runId);
    if (!run) throw new Error("missing run");
    const bounded = projection.snapshot(run, 1);
    expect(bounded.tasks).toHaveLength(INSPECTION_LIMITS.tasks);
    expect(bounded.phases).toHaveLength(INSPECTION_LIMITS.phases);
    for (let index = 0; index < 2_200; index++)
      projection.agentStart({
        id: `frame:${index}`,
        frameId: "frame",
        callIndex: index,
        label,
        prompt: "not retained",
      });
    expect(projection.snapshot(run, 1).calls).toHaveLength(INSPECTION_LIMITS.calls);
    expect(projection.snapshot(run, 1).logicalCalls).toBe(2_200);
    expect(projection.snapshot(run, 1).truncated).toBe(true);
    engine.dispose();
  });

  it("fences stale runtime/agent/log callbacks after replacement and new generations", async () => {
    const { engine, sessionEntries } = harness();
    const callbacks: runtime.WorkflowRunOptions[] = [];
    let resolveExecution: ((value: runtime.WorkflowRunResult) => void) | undefined;
    const spy = vi.spyOn(runtime, "runWorkflow").mockImplementation(async (_script, options) => {
      callbacks.push(options ?? {});
      return new Promise((resolve) => {
        resolveExecution = resolve;
      });
    });
    try {
      const started = await engine.start(META, { background: true });
      const old = callbacks[0];
      old.onRuntimeEvent?.({ type: "phase", frameId: started.runId, title: "old" });
      engine.fenceCommittedBranch();
      const retired = snapshot(engine, started.runId);
      old.onRuntimeEvent?.({ type: "phase", frameId: started.runId, title: "stale" });
      old.onAgentStart?.({ id: `${started.runId}:0`, label: "stale", prompt: "secret" });
      old.onLog?.("stale");
      expect(snapshot(engine, started.runId)).toEqual(retired);
      engine.restore(sessionEntries());
      engine.resumeLifecycle();
      const restored = snapshot(engine, started.runId);
      old.onRuntimeEvent?.({ type: "phase", frameId: started.runId, title: "stale" });
      expect(snapshot(engine, started.runId)).toEqual(restored);
      resolveExecution?.({
        meta: { name: "inspection", description: "test" },
        result: null,
        logs: [],
        phases: [],
        agentCount: 0,
        durationMs: 1,
      });
      await Promise.resolve();
      await engine.resume(started.runId, sessionEntries(), { background: true });
      const resumed = snapshot(engine, started.runId);
      old.onAgentEnd?.({ id: `${started.runId}:0`, label: "stale", result: "secret" });
      old.onLog?.("stale");
      expect(snapshot(engine, started.runId)).toEqual(resumed);
      resolveExecution?.({
        meta: { name: "inspection", description: "test" },
        result: null,
        logs: [],
        phases: [],
        agentCount: 0,
        durationMs: 1,
      });
      await engine.waitFor(started.runId);
      engine.dispose();
      expect(engine.getInspection(started.runId)).toBeUndefined();
    } finally {
      spy.mockRestore();
      engine.dispose();
    }
  });

  it.each(["manual", "provider"] as const)("retains named child loading for %s engine-owned resumes", async (mode) => {
    const { engine, setManual, setSpawnError, spawns } = harness();
    const child = 'export const meta = {name:"child",description:"test"}; return await agent(String(args));';
    const load = vi.fn((name: string) => (name === "child" ? child : undefined));
    engine.loadSavedWorkflow = load;
    if (mode === "manual") setManual(true);
    else setSpawnError("rate limit; try again in 1 seconds");
    const started = await engine.start(`${META} return await workflow("child", args);`, {
      background: true,
      loadSavedWorkflow: load,
      args: "frozen",
      tokenBudget: 100,
      maxAgents: 3,
    });
    await expect.poll(() => spawns.length, { timeout: 5_000 }).toBe(1);
    if (mode === "manual") {
      await engine.control("pause", started.runId);
      setManual(false);
      await engine.control("resume", started.runId);
    } else {
      await expect.poll(() => engine.getRun(started.runId)?.status, { timeout: 5_000 }).toBe("paused");
      setSpawnError();
    }
    await expect.poll(() => engine.getRun(started.runId)?.status, { timeout: 5_000 }).toBe("completed");
    expect(load.mock.calls.filter(([name]) => name === "child")).toHaveLength(2);
    expect(engine.getState(started.runId)?.frozenOptions).toMatchObject({ tokenBudget: 100, maxAgents: 3 });
    expect(engine.getRun(started.runId)?.args).toBe("frozen");
    expect(snapshot(engine, started.runId).executionGeneration).toBe(2);
    engine.dispose();
  });

  it.each(["normal", "immediate", "buffered"] as const)(
    "preserves exact terminal metadata once for %s schema results and restores it",
    async (mode) => {
      const { engine, bus, entries, spawns, sessionEntries, setManual, setAnswer, setOnSpawn } = harness();
      setAnswer('{"ok":true}');
      if (mode !== "immediate") setManual(true);
      const complete = (spawn: (typeof spawns)[number]) =>
        bus.emit("subagents:completed", {
          id: spawn.id,
          result: '{"ok":true}',
          outputFile: "output-reference",
          tokenCount: 12,
          compactionCount: 2,
          owner: { extension: "pi-workflows", runId: spawn.runId, nodeId: spawn.nodeId, attemptId: spawn.attemptId },
        });
      setOnSpawn((spawn) => {
        const owner = {
          extension: "pi-workflows",
          runId: spawn.runId,
          nodeId: spawn.nodeId,
          attemptId: spawn.attemptId,
        };
        bus.emit("subagents:created", { id: spawn.id, owner });
        bus.emit("subagents:compacted", {
          id: spawn.id,
          compactionCount: 100,
          owner: { ...owner, attemptId: "attempt-0" },
        });
        bus.emit("subagents:compacted", { id: spawn.id, compactionCount: 5, owner });
        if (mode === "buffered") complete(spawn);
      });
      const started = await engine.start(
        `${META} return await agent("schema",{schema:{type:"object",properties:{ok:{type:"boolean"}},required:["ok"]}});`,
        { background: true },
      );
      if (mode === "normal") {
        await expect.poll(() => spawns.length, { timeout: 5_000 }).toBe(1);
        expect(engine.getRun(started.runId)?.agentIds["0"]).toBe("managed-0");
        expect(engine.getRun(started.runId)?.compactions["0"]).toBe(5);
        complete(spawns[0]);
      }
      await engine.waitFor(started.runId);
      const facts = entries.filter((entry) => entry.kind === "call_result");
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        nodeId: "0",
        result: {
          status: "completed",
          agentId: "managed-0",
          tokenCount: 12,
          outputFile: "output-reference",
          compactionCount: 5,
          result: { ok: true },
          attemptId: `${started.runId}/0/attempt-1`,
        },
      });
      expect(snapshot(engine, started.runId).calls[0]).toMatchObject({
        compactionCount: 5,
        physicalStatus: "completed",
        outputFile: "output-reference",
        resultPreview: '{"ok":true}',
      });
      engine.restore(sessionEntries());
      expect(engine.getRun(started.runId)?.callResults["0"]).toMatchObject({
        agentId: "managed-0",
        compactionCount: 5,
        tokenCount: 12,
        outputFile: "output-reference",
        result: { ok: true },
      });
      expect(snapshot(engine, started.runId).calls[0]).toMatchObject({
        agentId: "managed-0",
        compactionCount: 5,
        tokenCount: 12,
        outputFile: "output-reference",
        journalOnly: true,
      });
      engine.dispose();
    },
  );

  it("keeps stop busy until execution and exact cleanup drain, then notifies terminal once", async () => {
    const { engine, client, setManual, spawns, entries } = harness();
    setManual(true);
    let release: (() => void) | undefined;
    let quiesceCalls = 0;
    client.quiesceOwned = async () => {
      quiesceCalls++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { settled: true, pending: [] };
    };
    const notified: string[] = [];
    engine.onRunSettled = () => {
      notified.push(String(engine.list()[0]?.status));
    };
    const started = await engine.start(`${META} return await agent("work");`, { background: true });
    await expect.poll(() => spawns.length, { timeout: 5_000 }).toBe(1);
    let returned = false;
    const stopping = engine.control("stop", started.runId).then(() => {
      returned = true;
    });
    const duplicate = engine.control("stop", started.runId);
    await expect.poll(() => release, { timeout: 5_000 }).toBeTypeOf("function");
    expect(snapshot(engine, started.runId).status).toBe("stopping");
    expect(engine.hasUnsettledWork()).toBe(true);
    expect(returned).toBe(false);
    expect(notified).toEqual([]);
    await expect(engine.control("rm", started.runId)).rejects.toThrow(/running/);
    expect(entries.some((entry) => entry.kind === "terminal_recovery")).toBe(false);
    release?.();
    await Promise.all([stopping, duplicate]);
    expect(quiesceCalls).toBe(1);
    expect(snapshot(engine, started.runId).status).toBe("stopped");
    expect(engine.hasUnsettledWork()).toBe(false);
    expect(notified).toEqual(["stopped"]);
    expect(entries.filter((entry) => entry.kind === "terminal_recovery")).toHaveLength(1);
    engine.dispose();
  });

  it("fences failed exact cleanup rather than reporting a clean stop", async () => {
    const { engine, client, setManual, spawns } = harness();
    setManual(true);
    client.quiesceOwned = async () => ({ settled: false, pending: ["managed-0"] });
    const started = await engine.start(`${META} return await agent("work");`, { background: true });
    await expect.poll(() => spawns.length, { timeout: 5_000 }).toBe(1);
    await engine.control("stop", started.runId);
    expect(engine.getRun(started.runId)).toMatchObject({ status: "stopped", nonResumable: true });
    expect(engine.getRun(started.runId)?.error).toContain("Owned cleanup unconfirmed");
    engine.dispose();
  });

  it("keeps timed-out owned cleanup busy and non-removable until its actual promise settles", async () => {
    const { engine, client, setManual, spawns } = harness();
    setManual(true);
    let release: (() => void) | undefined;
    client.quiesceOwned = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { settled: true, pending: [] };
    };
    const started = await engine.start(`${META} return await agent("work");`, { background: true });
    await expect.poll(() => spawns.length, { timeout: 5_000 }).toBe(1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stopping = engine.control("stop", started.runId);
    await realDelay(50);
    expect(release).toBeTypeOf("function");
    await vi.advanceTimersByTimeAsync(9_000);
    await realDelay(100);
    await stopping;
    expect(engine.getRun(started.runId)).toMatchObject({ status: "stopped", nonResumable: true });
    expect(engine.hasUnsettledWork()).toBe(true);
    await expect(engine.control("rm", started.runId)).rejects.toThrow(/cleanup is pending/);
    release?.();
    await realDelay(50);
    expect(engine.hasUnsettledWork()).toBe(false);
    await engine.control("rm", started.runId);
    expect(engine.getInspection(started.runId)).toBeUndefined();
    engine.dispose();
  });

  it("requires durable removal and retains a retryable run on tombstone failure", async () => {
    const { engine, entries, sessionEntries, setRejectAppend } = harness();
    const started = await engine.start(`${META} return "done";`);
    setRejectAppend((event) => event.kind === "run_removed");
    await expect(engine.control("rm", started.runId)).rejects.toThrow(/Could not persist/);
    expect(engine.getRun(started.runId)?.status).toBe("completed");
    expect(entries.some((entry) => entry.kind === "run_removed")).toBe(false);
    setRejectAppend(undefined);
    await Promise.all([engine.control("rm", started.runId), engine.control("rm", started.runId)]);
    expect(entries.filter((entry) => entry.kind === "run_removed")).toHaveLength(1);
    expect(engine.getInspection(started.runId)).toBeUndefined();
    engine.restore(sessionEntries());
    expect(engine.getRun(started.runId)).toBeUndefined();
    engine.dispose();
  });

  it("drains queued predecessor facts before publishing a removal tombstone", async () => {
    const { engine, entries, sessionEntries, setRejectAppend } = harness();
    let blocked = true;
    setRejectAppend((event) => blocked && event.kind === "workflow_transition" && event.status === "completed");
    const started = await engine.start(`${META} return "done";`, { background: true });
    await expect.poll(() => engine.getState(started.runId)?.pendingTerminal).toBeDefined();
    expect(engine.getRun(started.runId)?.status).toBe("running");
    await expect(engine.control("rm", started.runId)).rejects.toThrow(/running/);
    expect(entries.some((entry) => entry.kind === "run_removed")).toBe(false);
    blocked = false;
    await engine.waitFor(started.runId);
    await engine.getState(started.runId)?.execution;
    await engine.control("rm", started.runId);
    expect(entries.at(-1)?.kind).toBe("run_removed");
    const completion = entries.findIndex(
      (entry) => entry.kind === "workflow_transition" && entry.status === "completed",
    );
    expect(completion).toBeGreaterThan(-1);
    expect(completion).toBeLessThan(entries.length - 1);
    engine.restore(sessionEntries());
    expect(engine.getRun(started.runId)).toBeUndefined();
    engine.dispose();
  });
});
