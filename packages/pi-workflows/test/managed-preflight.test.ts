import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowEngine } from "../src/engine.js";
import { WorkflowErrorCode } from "../src/errors.js";
import { buildResumeJournal, JOURNAL_ENTRY_TYPE, type JournalEvent } from "../src/journal.js";
import {
  createManagedSpawnClient,
  type DispatchTask,
  type ManagedSpawnClient,
  prepareManagedSpawnRequest,
  type WorkflowEventBus,
} from "../src/rpc-client.js";
import { buildWorkflowUiSnapshot } from "../src/ui-bus.js";
import { workflowOverviewLines } from "../src/ui-overview.js";

const META = 'export const meta={name:"preflight",description:"test"};';
const TASK: DispatchTask = { subagent_type: "general-purpose", prompt: "work", description: "test" };
function makeBus(): WorkflowEventBus {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(name, handler) {
      const set = handlers.get(name) ?? new Set();
      handlers.set(name, set);
      set.add(handler);
      return () => set.delete(handler);
    },
    emit(name, data) {
      for (const handler of handlers.get(name) ?? []) handler(data);
    },
  };
}
const engines: WorkflowEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});
function harness() {
  const events = makeBus();
  const facts: JournalEvent[] = [];
  const spawn = vi.fn<ManagedSpawnClient["spawn"]>(async () => ({
    id: "child",
    terminal: { status: "completed", result: '{"ok":true}', compactionCount: 0, completedAt: 1 },
  }));
  const client = {
    spawn,
    stop: vi.fn(async () => {}),
    stopOwned: vi.fn(async () => {}),
    reconcileManaged: vi.fn<NonNullable<ManagedSpawnClient["reconcileManaged"]>>(async () => undefined),
    quiesceOwned: vi.fn(async () => ({ settled: true, pending: [] as string[] })),
  };
  const session = () => facts.map((data) => ({ type: "custom", customType: JOURNAL_ENTRY_TYPE, data }));
  const engine = new WorkflowEngine(
    events,
    client,
    { append: (event) => facts.push(structuredClone(event)) },
    session,
    async () => ({
      routingPolicyFingerprint: "test",
      routingPolicy: { defaultTier: null, profiles: {}, blockedProfiles: [], blockedDefaultTier: false },
    }),
  );
  engines.push(engine);
  return { engine, client, facts, session, events };
}
function expectNoCleanup(h: ReturnType<typeof harness>, runId: string) {
  expect(h.client.reconcileManaged).not.toHaveBeenCalled();
  expect(h.client.stopOwned).not.toHaveBeenCalled();
  expect(h.client.quiesceOwned).not.toHaveBeenCalled();
  expect(h.engine.hasPendingCleanup(runId)).toBe(false);
  expect(h.engine.getState(runId)?.pendingSpawns.size).toBe(0);
  expect(h.engine.getRun(runId)?.nonResumable).not.toBe(true);
}

function expectFailedProjection(h: ReturnType<typeof harness>, runId: string, tokenCount: number) {
  expect(h.engine.getRun(runId)?.callStatus["0"]).toBe("failed");
  expect(h.engine.getInspection(runId)?.calls[0]).toMatchObject({ status: "failed", tokenCount });
  const snapshot = buildWorkflowUiSnapshot(h.engine, "surface");
  expect(snapshot.runs[0]).toMatchObject({
    callCount: 1,
    runningCalls: 0,
    completedCalls: 0,
    failedCalls: 1,
    tokenCount,
  });
  const run = h.engine.getRun(runId);
  if (!run) throw new Error("missing run");
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const text = stripVTControlCharacters(workflowOverviewLines([run], snapshot.runs, theme, 240, 8).join("\n"));
  expect(text).toContain("0/1 in flight · 0 done · 1 failed");
  expect(text).toContain(`${tokenCount} settled tokens`);
  expect(buildResumeJournal(h.session()).has(`${runId}:0`)).toBe(false);
}

describe("complete managed dispatch preflight", () => {
  it("a caught allocation-free rejection spends no cap, tokens or phase allowance and keeps lexical identity", async () => {
    const h = harness();
    const result = await h.engine.start(
      `${META}
      phase("bounded", {budget:10});
      try { await agent('x'.repeat(100001)); } catch {}
      const before = budget.spent();
      const value = await agent('valid');
      return {before,value,spent:budget.spent()};`,
      { maxAgents: 1, tokenBudget: 10_000, agentRetries: 3 },
    );
    expect(result.status).toBe("completed");
    expect(h.engine.getRun(result.runId)?.finalResult).toEqual({ before: 0, value: '{"ok":true}', spent: 6 });
    expect(h.client.spawn).toHaveBeenCalledOnce();
    expect(h.client.spawn.mock.calls[0].slice(1, 4)).toEqual([result.runId, "call-1", "attempt-1"]);
    expect(h.facts.filter((fact) => fact.kind === "call_attempt")).toMatchObject([{ nodeId: "1" }]);
    expectNoCleanup(h, result.runId);
  });

  it.each([0, 2].flatMap((retries) => ["snapshot", "buffered"].map((delivery) => ({ retries, delivery }))))(
    "finalizes schema exhaustion with exact settled facts, never a success cache ($delivery, retries=$retries)",
    async ({ retries, delivery }) => {
      const h = harness();
      const schema = {
        type: "object",
        properties: { ok: { enum: [1, 2], type: "integer", minimum: 2 } },
        required: ["ok"],
      };
      h.client.spawn.mockImplementation(async (_task, runId, nodeId, attemptId) => {
        const id = `child-${attemptId}`;
        const terminal = {
          status: "completed" as const,
          result: '{"ok":1}',
          tokenCount: retries === 0 ? 0 : 37,
          outputFile: "settled-output",
          compactionCount: 2,
          completedAt: 1,
        };
        if (delivery === "buffered") {
          h.events.emit("subagents:completed", {
            id,
            ...terminal,
            owner: { extension: "pi-workflows", runId, nodeId, attemptId },
          });
          return { id, state: "running" };
        }
        return { id, terminal };
      });
      const script = `${META} return await agent('schema', {schema:${JSON.stringify(schema)}});`;
      const result = await h.engine.start(script, { agentRetries: retries });
      expect(result.status).toBe("failed");
      expect(result.error).toContain("schema-valid result");
      const tokenCount = retries === 0 ? 0 : 37;
      expectFailedProjection(h, result.runId, tokenCount);
      const generation = ((retries + 1) * (retries + 2)) / 2;
      const attemptId = `${result.runId}/0/attempt-${generation}`;
      const terminalFacts = h.facts.filter((fact) => fact.kind === "call_result");
      expect(terminalFacts).toMatchObject([
        {
          attemptId,
          owner: { extension: "pi-workflows", runId: result.runId, nodeId: "0", attemptId },
          result: { status: "failed", attemptId, tokenCount, outputFile: "settled-output", compactionCount: 2 },
        },
      ]);
      expect(terminalFacts).toHaveLength(1);
      expect(terminalFacts[0]).not.toHaveProperty("callHash");
      h.events.emit("subagents:completed", {
        id: "child-attempt-1",
        result: '{"ok":true}',
        owner: { extension: "pi-workflows", runId: result.runId, nodeId: "call-0", attemptId: "attempt-1" },
      });
      expect(h.facts.filter((fact) => fact.kind === "call_result")).toHaveLength(1);
      await h.engine.getState(result.runId)?.execution?.catch(() => {});
      h.engine.restore(h.session());
      expectFailedProjection(h, result.runId, tokenCount);
      h.client.spawn.mockResolvedValue({
        id: "valid",
        terminal: { status: "completed", result: '{"ok":2}', tokenCount: 11, compactionCount: 0, completedAt: 1 },
      });
      const resumed = await h.engine.resume(result.runId, h.session());
      expect(resumed?.status).toBe("completed");
      expect(h.client.spawn).toHaveBeenCalledTimes(retries + 2);
      expect(h.client.spawn.mock.calls.at(-1)?.slice(1, 4)).toEqual([
        result.runId,
        "call-0",
        `attempt-${generation + 1}`,
      ]);
      expect(h.facts.filter((fact) => fact.kind === "call_result")).toHaveLength(2);
      expect(h.client.stopOwned).not.toHaveBeenCalled();
      expectNoCleanup(h, result.runId);
    },
  );
  it.each([257, 2_000])("restores a schema failure with an exact %i-character transcript pointer", async (length) => {
    const h = harness();
    const outputFile = `/transcripts/${"x".repeat(length - 13)}`;
    h.client.spawn.mockResolvedValue({
      id: "invalid-schema",
      terminal: { status: "completed", result: "{}", outputFile, tokenCount: 0, compactionCount: 2, completedAt: 1 },
    });
    const result = await h.engine.start(
      `${META} return await agent('schema', {schema:{type:'object',required:['ok']}});`,
    );
    expect(result.status).toBe("failed");
    expectFailedProjection(h, result.runId, 0);
    const attemptId = `${result.runId}/0/attempt-1`;
    const terminal = h.facts.filter((fact) => fact.kind === "call_result");
    expect(terminal).toMatchObject([
      {
        owner: { extension: "pi-workflows", runId: result.runId, nodeId: "0", attemptId },
        attemptId,
        result: {
          status: "failed",
          attemptId,
          agentId: "invalid-schema",
          outputFile,
          tokenCount: 0,
          compactionCount: 2,
        },
      },
    ]);
    expect(terminal).toHaveLength(1);
    await h.engine.getState(result.runId)?.execution?.catch(() => {});
    h.engine.restore(h.session());
    expect(h.engine.getRun(result.runId)?.status).toBe("failed");
    expect(h.engine.getRun(result.runId)?.callResults["0"].outputFile).toBe(outputFile);
    expectFailedProjection(h, result.runId, 0);
    expectNoCleanup(h, result.runId);
  });

  it.each(["run", "phase"].flatMap((scope) => [false, true].map((caught) => ({ scope, caught }))))(
    "terminates the settled schema child when $scope budget denies repair (caught=$caught)",
    async ({ scope, caught }) => {
      const h = harness();
      h.client.spawn.mockResolvedValue({
        id: "invalid-schema",
        terminal: {
          status: "completed",
          result: "{}",
          tokenCount: 1,
          outputFile: "settled-output",
          compactionCount: 2,
          completedAt: 1,
        },
      });
      const call = "await agent('schema',{retries:1,schema:{type:'object',required:['ok']}})";
      const result = await h.engine.start(
        `${META}
        ${scope === "phase" ? 'phase("limited",{budget:1});' : ""}
        ${caught ? `try { ${call}; } catch(e) { return {code:e.code,spent:budget.spent()}; }` : `return ${call};`}`,
        { tokenBudget: scope === "run" ? 1 : null },
      );
      expect(result.status).toBe(caught ? "completed" : "failed");
      if (caught)
        expect(h.engine.getRun(result.runId)?.finalResult).toEqual({
          code: WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
          spent: 1,
        });
      else expect(result.error).toContain("budget exhausted");
      expect(h.client.spawn).toHaveBeenCalledOnce();
      expect(h.facts.filter((fact) => fact.kind === "call_attempt")).toHaveLength(1);
      const attemptId = `${result.runId}/0/attempt-1`;
      const terminal = h.facts.filter((fact) => fact.kind === "call_result");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({
        attemptId,
        owner: { extension: "pi-workflows", runId: result.runId, nodeId: "0", attemptId },
        result: {
          status: "failed",
          attemptId,
          agentId: "invalid-schema",
          tokenCount: 1,
          outputFile: "settled-output",
          compactionCount: 2,
        },
      });
      expect(terminal[0]).not.toHaveProperty("callHash");
      expectFailedProjection(h, result.runId, 1);
      expectNoCleanup(h, result.runId);
      await h.engine.getState(result.runId)?.execution?.catch(() => {});
      h.engine.restore(h.session());
      expect(h.engine.getRun(result.runId)?.status).toBe(caught ? "completed" : "failed");
      expectFailedProjection(h, result.runId, 1);
      expectNoCleanup(h, result.runId);
    },
  );

  it.each(["run", "phase"].flatMap((scope) => [false, true].map((caught) => ({ scope, caught }))))(
    "retains known zero when a parallel child exhausts $scope budget before repair (caught=$caught)",
    async ({ scope, caught }) => {
      const h = harness();
      h.client.spawn.mockImplementation(async (_task, _runId, nodeId) =>
        nodeId === "call-0"
          ? { id: "zero-schema", state: "running" }
          : {
              id: "spender",
              terminal: { status: "completed", result: "spent", tokenCount: 1, compactionCount: 0, completedAt: 1 },
            },
      );
      const calls = `await parallel([()=>agent('schema',{retries:1,schema:{type:'object',required:['ok']}}),()=>agent('spender')])`;
      const result = await h.engine.start(
        `${META} ${scope === "phase" ? 'phase("limited",{budget:1});' : ""}
        ${caught ? `try { ${calls}; } catch(e) { return {code:e.code,spent:budget.spent()}; }` : `return ${calls};`}`,
        { background: true, tokenBudget: scope === "run" ? 1 : null },
      );
      await vi.waitFor(() => {
        expect(h.engine.getRun(result.runId)?.callStatus["1"]).toBe("completed");
        expect(h.engine.getState(result.runId)?.agentWaiters.size).toBe(1);
      });
      h.events.emit("subagents:completed", {
        id: "zero-schema",
        result: "{}",
        tokenCount: 99,
        managedTokens: { input: 0, output: 0, total: 0 },
        outputFile: "zero-output",
        compactionCount: 2,
        owner: { extension: "pi-workflows", runId: result.runId, nodeId: "call-0", attemptId: "attempt-1" },
      });
      await h.engine.waitFor(result.runId);
      await h.engine.getState(result.runId)?.execution?.catch(() => {});
      if (caught)
        expect(h.engine.getRun(result.runId)?.finalResult).toEqual({
          code: WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
          spent: 1,
        });
      const terminal = h.facts.filter((fact) => fact.kind === "call_result" && fact.nodeId === "0");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({
        result: { status: "failed", tokenCount: 0, outputFile: "zero-output", compactionCount: 2 },
      });
      expect(h.client.spawn).toHaveBeenCalledTimes(2);
      expect(h.facts.filter((fact) => fact.kind === "call_attempt")).toHaveLength(2);
      const assertProjection = () => {
        expect(h.engine.getRun(result.runId)?.status).toBe(caught ? "completed" : "failed");
        expect(h.engine.getInspection(result.runId)?.calls).toMatchObject([
          { status: "failed", tokenCount: 0 },
          { status: "completed", tokenCount: 1 },
        ]);
        expect(buildWorkflowUiSnapshot(h.engine, "surface").runs[0]).toMatchObject({
          runningCalls: 0,
          failedCalls: 1,
          completedCalls: 1,
          tokenCount: 1,
        });
        expect(buildResumeJournal(h.session()).has(`${result.runId}:0`)).toBe(false);
        expectNoCleanup(h, result.runId);
      };
      assertProjection();
      h.engine.restore(h.session());
      assertProjection();
    },
  );

  it.each([99_999, 100_000])("accepts %i prompt characters after trimming", async (length) => {
    const h = harness();
    const result = await h.engine.start(`${META} return await agent('  '+ 'x'.repeat(${length})+' \\n');`);
    expect(result.status).toBe("completed");
    expect(h.client.spawn).toHaveBeenCalledOnce();
    expectNoCleanup(h, result.runId);
  });

  it("rejects the first character over the trimmed prompt boundary without a lease", async () => {
    const h = harness();
    const result = await h.engine.start(`${META} return await agent('  '+'x'.repeat(100001)+'  ');`);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("prompt exceeds 100000 characters");
    expect(h.client.spawn).not.toHaveBeenCalled();
    expect(h.facts.some((fact) => fact.kind === "call_attempt")).toBe(false);
    expectNoCleanup(h, result.runId);
  });

  it("rejects the incident-sized aggregation after twenty successes without losing the prefix", async () => {
    const h = harness();
    const script = `${META} for(let i=0;i<20;i++) await agent('work '+i); return await agent('x'.repeat(177394));`;
    const result = await h.engine.start(script, { agentRetries: 3 });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("prompt exceeds 100000 characters");
    expect(result.error).not.toContain("cleanup");
    expect(result.waitAborted).toBeUndefined();
    expect(h.client.spawn).toHaveBeenCalledTimes(20);
    expect(Object.values(h.engine.getRun(result.runId)?.callResults ?? {})).toHaveLength(20);
    expect(h.facts.filter((fact) => fact.kind === "call_attempt")).toHaveLength(20);
    expectNoCleanup(h, result.runId);
    await vi.waitFor(() => expect(h.engine.hasUnsettledWork()).toBe(false));
    const resumed = await h.engine.resume(
      result.runId,
      h.session(),
      {},
      `${META} for(let i=0;i<20;i++) await agent('work '+i); return await agent('fixed');`,
    );
    expect(resumed?.status).toBe("completed");
    expect(h.client.spawn).toHaveBeenCalledTimes(21);
  });

  it("includes the schema instructions and accepts exactly the full wire limit", async () => {
    const schema = { type: "object", required: ["ok"] };
    const suffix = `\n\nReply with a single raw JSON value (object or array) matching exactly this JSON Schema:\n${JSON.stringify(schema)}\nDo not wrap it in prose or markdown fences.`;
    for (const excess of [0, 1]) {
      const h = harness();
      const result = await h.engine.start(
        `${META} return await agent('x'.repeat(${100_000 - suffix.length + excess}), {schema:${JSON.stringify(schema)}});`,
      );
      expect(result.status).toBe(excess ? "failed" : "completed");
      expect(h.client.spawn).toHaveBeenCalledTimes(excess ? 0 : 1);
      if (!excess) expect(h.client.spawn.mock.calls[0][0].prompt.length).toBe(100_000);
      else expect(result.error).toContain("prompt exceeds 100000 characters");
      expectNoCleanup(h, result.runId);
    }
  });

  it("validates repair feedback before submitting a second attempt", async () => {
    const h = harness();
    h.client.spawn.mockResolvedValue({
      id: "first",
      terminal: {
        status: "completed",
        result: '{"ok":false}',
        tokenCount: 37,
        outputFile: "settled-output",
        compactionCount: 2,
        completedAt: 1,
      },
    });
    const schema = { type: "object", properties: { ok: { const: true } } };
    const result = await h.engine.start(
      `${META} return await agent('x'.repeat(99700), {schema:${JSON.stringify(schema)}});`,
      { agentRetries: 3 },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("prompt exceeds 100000 characters");
    expect(h.client.spawn).toHaveBeenCalledOnce();
    expect(h.facts.filter((fact) => fact.kind === "call_attempt")).toHaveLength(1);
    expectFailedProjection(h, result.runId, 37);
    expect(h.facts.filter((fact) => fact.kind === "call_result")).toMatchObject([
      {
        attemptId: `${result.runId}/0/attempt-1`,
        result: { status: "failed", tokenCount: 37, outputFile: "settled-output", compactionCount: 2 },
      },
    ]);
    expectNoCleanup(h, result.runId);
    await h.engine.getState(result.runId)?.execution?.catch(() => {});
    h.engine.restore(h.session());
    expectFailedProjection(h, result.runId, 37);
    h.client.spawn.mockResolvedValue({
      id: "valid-repair",
      terminal: { status: "completed", result: '{"ok":true}', tokenCount: 11, compactionCount: 0, completedAt: 1 },
    });
    const resumed = await h.engine.resume(
      result.runId,
      h.session(),
      {},
      `${META} return await agent('fixed', {schema:${JSON.stringify(schema)}});`,
    );
    expect(resumed?.status).toBe("completed");
    expect(h.client.spawn).toHaveBeenCalledTimes(2);
    expect(h.client.spawn.mock.calls.at(-1)?.slice(1, 4)).toEqual([result.runId, "call-0", "attempt-2"]);
    expectNoCleanup(h, result.runId);
  });

  it("repair preflight charges only the settled attempt and cannot refund its dispatch reservation", async () => {
    const h = harness();
    h.client.spawn.mockResolvedValue({
      id: "first",
      terminal: { status: "completed", result: '{"ok":false}', tokenCount: 37, compactionCount: 0, completedAt: 1 },
    });
    const result = await h.engine.start(
      `${META}
      try { await agent('x'.repeat(99700), {schema:{type:"object",properties:{ok:{const:true}}}}); } catch {}
      const spent = budget.spent();
      try { await agent('valid'); } catch (error) { return {spent,code:error.code}; }`,
      { maxAgents: 1, tokenBudget: 100_000, agentRetries: 3 },
    );
    expect(result.status).toBe("completed");
    expect(h.engine.getRun(result.runId)?.finalResult).toEqual({
      spent: 37,
      code: WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
    });
    expect(h.client.spawn).toHaveBeenCalledOnce();
    expectFailedProjection(h, result.runId, 37);
    expectNoCleanup(h, result.runId);
  });

  it.each([
    [{ agentType: "x".repeat(129) }, "type exceeds 128"],
    [{ label: "x".repeat(513) }, "description exceeds 512"],
    [{ thread: "x".repeat(129) }, "thread exceeds 128"],
    [{ toolset: "x".repeat(129) }, "toolset exceeds 128"],
    [{ excludeTools: Array.from({ length: 65 }, (_, i) => `tool${i}`) }, "excludeTools must contain at most 64 names"],
    [{ isolation: "other" }, "managed spawn isolation must be worktree"],
  ])("validates every effective request field before even an injected client: %j", async (options, diagnostic) => {
    const h = harness();
    const result = await h.engine.start(`${META} return await agent('work',${JSON.stringify(options)});`);
    expect(result.status).toBe("failed");
    expect(result.error).toContain(diagnostic);
    expect(h.client.spawn).not.toHaveBeenCalled();
    expectNoCleanup(h, result.runId);
  });

  it("also validates bounded owner/spawn identities using the shared protocol", () => {
    expect(() => prepareManagedSpawnRequest(TASK, "x".repeat(257), "call-0")).toThrow("owner.runId exceeds 256");
    expect(() => prepareManagedSpawnRequest(TASK, "x".repeat(240), "call-0", "attempt-12345")).toThrow(
      "spawnKey exceeds 256",
    );
  });
});

describe("local rejection versus unknown remote admission", () => {
  it("never refunds or zero-charges a submitted validation-like failure, even after positive owned cleanup", async () => {
    const h = harness();
    h.client.spawn.mockRejectedValue(new Error("prompt exceeds 100000 characters"));
    h.client.reconcileManaged.mockResolvedValue({ id: "allocated" });
    const result = await h.engine.start(
      `${META}
      const value = await agent('valid work');
      const spent = budget.spent();
      try { await agent('second'); } catch (error) { return {value,spent,code:error.code}; }`,
      { maxAgents: 1, tokenBudget: 10_000 },
    );
    expect(result.status).toBe("completed");
    expect(h.engine.getRun(result.runId)?.finalResult).toEqual({
      value: null,
      spent: 4,
      code: WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
    });
    expect(h.client.spawn).toHaveBeenCalledOnce();
    expect(h.client.stopOwned).toHaveBeenCalledWith(
      "allocated",
      expect.objectContaining({ nodeId: "call-0", attemptId: "attempt-1" }),
    );
    expect(h.client.quiesceOwned).toHaveBeenCalledOnce();
    expect(h.engine.hasPendingCleanup(result.runId)).toBe(false);
  });
  it("retains uncertainty when a real RPC success reply omits the allocated identity", async () => {
    const events = makeBus();
    const reconciled = vi.fn();
    for (const operation of ["spawn-managed", "reconcile-managed"]) {
      events.on(`subagents:rpc:${operation}`, (raw) => {
        const request = raw as { requestId: string };
        if (operation === "reconcile-managed") reconciled();
        events.emit(`subagents:rpc:${operation}:reply:${request.requestId}`, { success: true, data: undefined });
      });
    }
    const engine = new WorkflowEngine(
      events,
      createManagedSpawnClient(events),
      { append() {} },
      () => [],
      async () => ({
        routingPolicyFingerprint: "test",
        routingPolicy: { defaultTier: null, profiles: {}, blockedProfiles: [], blockedDefaultTier: false },
      }),
    );
    engines.push(engine);
    const result = await engine.start(`${META} return await agent('valid');`);
    expect(reconciled).toHaveBeenCalled();
    expect(engine.hasPendingCleanup(result.runId)).toBe(true);
    expect(engine.getRun(result.runId)?.nonResumable).toBe(true);
    expect(result.status).toBe("stopped");
    expect(result.waitAborted).toBe(true);
  });

  it("client preflight never emits or reconciles a local invalid request", async () => {
    const events = makeBus();
    const emitted = vi.spyOn(events, "emit");
    const client = createManagedSpawnClient(events);
    await expect(client.spawn({ ...TASK, prompt: "x".repeat(100_001) }, "run", "call-0")).rejects.toMatchObject({
      code: WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      message: "prompt exceeds 100000 characters",
      recoverable: false,
    });
    expect(emitted).not.toHaveBeenCalled();
  });

  it("sends the shared parser's normalized boundary request", async () => {
    const events = makeBus();
    let prompt: unknown;
    events.on("subagents:rpc:spawn-managed", (raw) => {
      const request = raw as { requestId: string; prompt: string };
      prompt = request.prompt;
      events.emit(`subagents:rpc:spawn-managed:reply:${request.requestId}`, { success: true, data: { id: "child" } });
    });
    await createManagedSpawnClient(events).spawn({ ...TASK, prompt: ` \n${"x".repeat(100_000)}\t ` }, "run", "call-0");
    expect(prompt).toBe("x".repeat(100_000));
  });

  it.each([false, true])(
    "does not infer clean admission from a submitted validation-like error (known=%s)",
    async (known) => {
      const h = harness();
      // A remote/transport exception cannot borrow the local preflight guarantee,
      // even if its text happens to match a deterministic validation diagnostic.
      h.client.spawn.mockRejectedValue(new Error("prompt exceeds 100000 characters"));
      if (known) h.client.reconcileManaged.mockResolvedValue({ id: "allocated" });
      const result = await h.engine.start(`${META} return await agent('valid work');`);
      expect(h.client.spawn).toHaveBeenCalledOnce();
      expect(h.client.reconcileManaged).toHaveBeenCalled();
      if (known) {
        expect(h.client.stopOwned).toHaveBeenCalledWith(
          "allocated",
          expect.objectContaining({ nodeId: "call-0", attemptId: "attempt-1" }),
        );
        expect(h.client.quiesceOwned).toHaveBeenCalledOnce();
        expect(h.engine.hasPendingCleanup(result.runId)).toBe(false);
      } else {
        expect(h.engine.getRun(result.runId)?.nonResumable).toBe(true);
        expect(h.engine.hasPendingCleanup(result.runId)).toBe(true);
        expect(h.engine.getRun(result.runId)?.error).toContain("allocation could not be confirmed");
        expect(result.status).toBe("stopped");
        expect(result.waitAborted).toBe(true);
        expect(h.client.quiesceOwned).not.toHaveBeenCalled();
      }
    },
  );
});
