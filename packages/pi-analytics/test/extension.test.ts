import assert from "node:assert/strict";
import { test } from "vitest";
import { type AnalyticsStorePort, createAnalyticsExtension, isBuiltinReadTool } from "../src/analytics.js";
import { SkillTracker } from "../src/skills.js";
import { decodeStoredRun, encodeStoredRun } from "../src/storage/format.js";
import type { AnalyticsSnapshot, TimeRange } from "../src/storage/queries.js";
import type { SettledRun } from "../src/types.js";
import { createMockContext, createMockPi } from "./support.js";

const emptySnapshot: AnalyticsSnapshot = {
  overview: {
    responseCycles: 0,
    llmCalls: 0,
    callsPerResponse: 0,
    p95CallsPerResponse: 0,
    toolCalls: 0,
    toolErrors: 0,
    skillActivations: 0,
    providerErrors: 0,
    recoveredErrors: 0,
  },
  skills: [],
  tools: [],
  reliability: {
    http429: 0,
    http5xx: 0,
    recovered: 0,
    terminal: 0,
    categories: {
      dns: 0,
      timeout: 0,
      connection_refused: 0,
      connection_reset: 0,
      tls: 0,
      network_other: 0,
      provider_other: 0,
    },
  },
  responses: {
    modelPairs: [],
    count: 0,
    llmCalls: 0,
    average: 0,
    median: 0,
    p95: 0,
    maximum: 0,
    distribution: { one: 0, twoToThree: 0, fourToSix: 0, sevenPlus: 0 },
  },
};

class FakeStore implements AnalyticsStorePort {
  readonly path = "/tmp/pi-analytics";
  readonly runs: SettledRun[] = [];
  readonly signals: Array<AbortSignal | undefined> = [];
  closed = 0;
  clears = 0;
  failWrites = false;

  async recordRun(run: SettledRun, signal?: AbortSignal): Promise<void> {
    this.signals.push(signal);
    if (this.failWrites) throw new Error("write failed with /private/path");
    this.runs.push(run);
  }
  async getSnapshot(_range: TimeRange): Promise<AnalyticsSnapshot> {
    return emptySnapshot;
  }
  async clearAll(): Promise<{ cleanupIncomplete: boolean }> {
    this.clears += 1;
    return { cleanupIncomplete: false };
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
}

function lifecycleContext(overrides: Record<string, unknown> = {}) {
  return createMockContext({
    hasUI: true,
    mode: "rpc",
    cwd: "/workspace",
    model: { provider: "openai", id: "gpt-test" },
    isIdle: () => false,
    ...overrides,
  });
}

async function emit(
  mock: ReturnType<typeof createMockPi>,
  name: string,
  event: Record<string, unknown>,
  ctx: unknown,
): Promise<void> {
  for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
}

async function settleOneRun(mock: ReturnType<typeof createMockPi>, ctx: unknown, prompt = "run"): Promise<void> {
  await emit(mock, "before_agent_start", { prompt, systemPromptOptions: { skills: [] } }, ctx);
  await emit(mock, "agent_start", {}, ctx);
  await emit(mock, "turn_start", {}, ctx);
  await emit(mock, "before_provider_request", { payload: {} }, ctx);
  await emit(mock, "message_start", { message: { role: "assistant" } }, ctx);
  await emit(mock, "message_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
  await emit(mock, "agent_settled", {}, ctx);
}

test("skill read attribution requires Pi's built-in read tool", () => {
  assert.equal(
    isBuiltinReadTool(createMockPi({ allTools: [{ name: "read", sourceInfo: { source: "builtin" } }] }).pi),
    true,
  );
  assert.equal(
    isBuiltinReadTool(
      createMockPi({
        allTools: [{ name: "read", sourceInfo: { source: "custom-extension" } }],
      }).pi,
    ),
    false,
  );
});

test("factory registers lifecycle hooks without constructing or opening storage", () => {
  let creates = 0;
  const mock = createMockPi();
  createAnalyticsExtension({
    createStore: () => {
      creates += 1;
      return new FakeStore();
    },
  })(mock.pi);
  assert.equal(creates, 0);
  assert.ok(mock.commands.has("analytics"));
  assert.deepEqual([...mock.events.keys()].sort(), [
    "after_provider_response",
    "agent_settled",
    "agent_start",
    "before_agent_start",
    "before_provider_request",
    "cache_warming_decision",
    "input",
    "message_end",
    "message_start",
    "session_shutdown",
    "session_start",
    "tool_execution_end",
    "tool_execution_start",
    "tool_result",
    "turn_end",
    "turn_start",
  ]);
});

test("session start synchronously installs a lazy store without a routine warning", async () => {
  const store = new FakeStore();
  let path = "";
  const mock = createMockPi();
  createAnalyticsExtension({
    createStore: (value) => {
      path = value;
      return store;
    },
    getAgentDir: () => "/agent",
  })(mock.pi);
  const started = lifecycleContext();
  await emit(mock, "session_start", { reason: "startup" }, started.ctx);
  assert.equal(path, "/agent/pi-analytics");
  assert.deepEqual(started.notifications, []);
});

test("healthy startup, reload, resume and new sessions stay quiet in every mode", async () => {
  for (const mode of ["tui", "rpc", "print", "json"] as const) {
    const mock = createMockPi();
    createAnalyticsExtension({ createStore: () => new FakeStore(), getAgentDir: () => "/agent" })(mock.pi);
    const current = lifecycleContext({ mode, hasUI: mode === "tui" || mode === "rpc" });
    for (const reason of ["startup", "reload", "resume", "new"] as const) {
      await emit(mock, "session_start", { reason }, current.ctx);
      assert.deepEqual(current.notifications, [], `${mode}/${reason}`);
    }
    await emit(mock, "session_shutdown", { reason: "quit" }, current.ctx);
  }
});

test("a repeated session start aborts and closes the previous lazy store", async () => {
  const first = new FakeStore();
  const second = new FakeStore();
  let creates = 0;
  const mock = createMockPi();
  createAnalyticsExtension({ createStore: () => (++creates === 1 ? first : second) })(mock.pi);
  const started = lifecycleContext();
  await emit(mock, "session_start", { reason: "startup" }, started.ctx);
  await emit(mock, "session_start", { reason: "reload" }, started.ctx);
  await Promise.resolve();
  assert.equal(first.closed, 1);
  assert.equal(second.closed, 0);
  await emit(mock, "session_shutdown", { reason: "quit" }, started.ctx);
  assert.equal(second.closed, 1);
});

test("non-reload session starts restore unambiguous raw-hook accounting", async () => {
  const stores: FakeStore[] = [];
  const mock = createMockPi();
  createAnalyticsExtension({
    createStore: () => {
      const store = new FakeStore();
      stores.push(store);
      return store;
    },
  })(mock.pi);
  const started = lifecycleContext();
  for (const reason of ["reload", "startup", "reload", "new"] as const) {
    await emit(mock, "session_start", { reason }, started.ctx);
    await emit(mock, "before_agent_start", { systemPromptOptions: { skills: [] } }, started.ctx);
    await emit(mock, "agent_start", {}, started.ctx);
    await emit(mock, "turn_start", {}, started.ctx);
    await emit(mock, "before_provider_request", { payload: {} }, started.ctx);
    await emit(mock, "after_provider_response", { status: 200 }, started.ctx);
    const message = { role: "assistant", stopReason: "stop", provider: "openai", model: "gpt-test" };
    await emit(mock, "message_start", { message }, started.ctx);
    await emit(mock, "message_end", { message }, started.ctx);
    await emit(mock, "agent_settled", {}, started.ctx);
    const run = stores.at(-1)?.runs[0];
    assert.ok(run);
    assert.equal(run.outcome, "success");
    assert.equal(run.generations.length, 1);
    assert.equal(run.generations[0]?.provider, "openai");
    assert.equal(run.generations[0]?.model, "gpt-test");
    assert.deepEqual(
      run.generations[0]?.responses.map(({ status }) => status),
      reason === "reload" ? [] : [200],
    );
  }
});

test("native reported models never use selected identity, trigger catalog lookups or prove failed dispatch", async () => {
  for (const [responseModel, expected] of [
    [undefined, undefined],
    ["physical", "physical"],
    ["snapshot", "snapshot"],
    [42, undefined],
  ] as const) {
    const store = new FakeStore();
    const mock = createMockPi();
    createAnalyticsExtension({ createStore: () => store })(mock.pi);
    const started = lifecycleContext({
      model: { provider: "virtual", id: "selected" },
      modelRegistry: new Proxy({}, { get: () => assert.fail("analytics must not query models or providers") }),
    });
    await emit(mock, "session_start", { reason: "startup" }, started.ctx);
    await emit(mock, "before_agent_start", { systemPromptOptions: { skills: [] } }, started.ctx);
    await emit(mock, "turn_start", {}, started.ctx);
    await emit(
      mock,
      "message_end",
      {
        message: { role: "assistant", provider: "provider", model: "physical", stopReason: "stop", responseModel },
      },
      started.ctx,
    );
    await emit(mock, "agent_settled", {}, started.ctx);
    const run = store.runs[0];
    assert.equal(run?.initialModel, "selected");
    assert.equal(run?.generations[0]?.model, "physical");
    assert.equal(run?.generations[0]?.responseModel, expected);
    assert.deepEqual(mock.setModels, []);
    assert.deepEqual(mock.thinkingLevels, []);

    await emit(mock, "before_agent_start", { systemPromptOptions: { skills: [] } }, started.ctx);
    await emit(mock, "turn_start", {}, started.ctx);
    await emit(
      mock,
      "message_end",
      {
        message: {
          role: "assistant",
          provider: "virtual",
          model: "selected",
          stopReason: "error",
          responseModel: "not-proof",
        },
      },
      started.ctx,
    );
    await emit(mock, "agent_settled", {}, started.ctx);
    assert.deepEqual(store.runs[1]?.generations, []);
    assert.doesNotMatch(JSON.stringify(store.runs[1]), /not-proof/);
  }
});

test("a settled response is written once with the current session signal", async () => {
  const store = new FakeStore();
  const mock = createMockPi();
  createAnalyticsExtension({ createStore: () => store })(mock.pi);
  const started = lifecycleContext();
  await emit(mock, "session_start", { reason: "startup" }, started.ctx);
  await settleOneRun(mock, started.ctx);
  assert.equal(store.runs.length, 1);
  assert.equal(store.runs[0]?.outcome, "success");
  assert.equal(store.runs[0]?.generations[0]?.provider, undefined);
  assert.equal(store.runs[0]?.generations[0]?.model, undefined);
  assert.equal(store.signals[0]?.aborted, false);
});

for (const source of ["extension", "interactive", "rpc"] as const) {
  for (const text of ["continue", "/skill:reviewing-code"]) {
    test(`a ${source} input (${text}) after settlement retains its trigger and skill attribution`, async () => {
      const store = new FakeStore();
      const mock = createMockPi();
      createAnalyticsExtension({
        createStore: () => store,
        createSkillTracker: (cwd) => new SkillTracker(cwd, async (filePath) => filePath),
      })(mock.pi);
      const started = lifecycleContext({ mode: source === "interactive" ? "tui" : "rpc" });
      await emit(mock, "session_start", { reason: "startup" }, started.ctx);
      await emit(mock, "input", { text: "initial run", source: "interactive" }, started.ctx);
      await settleOneRun(mock, started.ctx);
      assert.equal(store.runs.length, 1);
      assert.equal(store.runs[0]?.triggerSource, "interactive");

      await emit(mock, "input", { text, source }, started.ctx);
      await emit(
        mock,
        "before_agent_start",
        {
          prompt: text,
          systemPromptOptions: {
            skills: [{ name: "reviewing-code", filePath: "/workspace/SKILL.md" }],
          },
        },
        started.ctx,
      );
      await emit(mock, "agent_start", {}, started.ctx);
      await emit(mock, "turn_start", {}, started.ctx);
      const message = { role: "assistant", stopReason: "stop", provider: "openai", model: "gpt-test" };
      await emit(mock, "message_start", { message }, started.ctx);
      await emit(mock, "message_end", { message }, started.ctx);
      await emit(mock, "agent_settled", {}, started.ctx);

      assert.equal(store.runs.length, 2);
      const recorded = store.runs[1];
      assert.ok(recorded);
      const run = decodeStoredRun(encodeStoredRun(recorded));
      assert.equal(run.triggerSource, source);
      assert.equal(run.outcome, "success");
      assert.equal(run.attemptCount, 1);
      assert.equal(run.generations.length, 1);
      assert.deepEqual(
        run.skills.map(({ name, initiatedBy }) => ({ name, initiatedBy })),
        source !== "extension" && text.startsWith("/skill:") ? [{ name: "reviewing-code", initiatedBy: "user" }] : [],
      );
    });
  }
}

test("finalized physical dispatch owns generations, errors, tools and model skill reads, not the selected router", async () => {
  const store = new FakeStore();
  const mock = createMockPi({ allTools: [{ name: "read", sourceInfo: { source: "builtin" } }] });
  createAnalyticsExtension({
    createStore: () => store,
    createSkillTracker: (cwd) => new SkillTracker(cwd, async (value) => value),
  })(mock.pi);
  const started = lifecycleContext({ model: { provider: "virtual", id: "router" } });
  const skills = [
    { name: "first", filePath: "/workspace/first.md" },
    { name: "second", filePath: "/workspace/second.md" },
  ];
  await emit(mock, "session_start", { reason: "startup" }, started.ctx);
  await emit(mock, "before_agent_start", { systemPromptOptions: { skills } }, started.ctx);
  const dispatches = [
    { provider: "anthropic", model: "physical-a", thinkingLevel: "high" },
    { provider: "openai", model: "physical-b", thinkingLevel: "medium" },
  ];
  for (const [index, physical] of dispatches.entries()) {
    await emit(mock, "turn_start", {}, started.ctx);
    await emit(mock, "before_provider_request", { payload: {} }, started.ctx);
    await emit(
      mock,
      "message_end",
      { message: { role: "assistant", stopReason: "toolUse", ...physical } },
      started.ctx,
    );
    const name = index === 0 ? "first" : "second";
    await emit(mock, "tool_execution_start", { toolCallId: name, toolName: "read" }, started.ctx);
    await emit(
      mock,
      "tool_result",
      { toolName: "read", input: { path: `/workspace/${name}.md` }, isError: false },
      started.ctx,
    );
    await emit(mock, "tool_execution_end", { toolCallId: name, isError: false }, started.ctx);
  }
  await emit(mock, "turn_start", {}, started.ctx);
  await emit(mock, "before_provider_request", { payload: {} }, started.ctx);
  await emit(
    mock,
    "message_end",
    { message: { role: "assistant", stopReason: "error", ...dispatches[1] } },
    started.ctx,
  );
  await emit(mock, "agent_settled", {}, started.ctx);
  const run = store.runs[0];
  assert.ok(run);
  assert.equal(run.initialProvider, "virtual");
  assert.equal(run.initialModel, "router");
  const identity = ({ provider, model, thinkingLevel }) => ({ provider, model, thinkingLevel });
  assert.deepEqual(run.generations.map(identity), [...dispatches, dispatches[1]]);
  assert.deepEqual(run.tools.map(identity), dispatches);
  assert.deepEqual(run.skills.map(identity), dispatches);
  assert.deepEqual(run.providerErrors.map(identity), [dispatches[1]]);
  const persisted = decodeStoredRun(encodeStoredRun(run));
  assert.deepEqual(persisted.tools.map(identity), dispatches);
  assert.deepEqual(persisted.skills.map(identity), dispatches);
  assert.deepEqual(persisted.providerErrors.map(identity), [dispatches[1]]);
});

test("initial and post-tool pre-request route failures persist terminal failures without physical attribution", async () => {
  for (const earlierSuccess of [false, true]) {
    const store = new FakeStore();
    const mock = createMockPi();
    createAnalyticsExtension({ createStore: () => store })(mock.pi);
    const started = lifecycleContext({ model: { provider: "virtual", id: "router" } });
    await emit(mock, "session_start", { reason: "startup" }, started.ctx);
    await emit(mock, "before_agent_start", { systemPromptOptions: { skills: [] } }, started.ctx);
    if (earlierSuccess) {
      await emit(mock, "turn_start", {}, started.ctx);
      await emit(mock, "before_provider_request", { payload: {} }, started.ctx);
      await emit(
        mock,
        "message_end",
        { message: { role: "assistant", stopReason: "toolUse", provider: "physical", model: "m" } },
        started.ctx,
      );
      await emit(mock, "tool_execution_start", { toolCallId: "tool", toolName: "read" }, started.ctx);
      await emit(mock, "tool_execution_end", { toolCallId: "tool", isError: false }, started.ctx);
    }
    await emit(mock, "turn_start", {}, started.ctx);
    await emit(
      mock,
      "message_end",
      {
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "route failed",
          provider: "virtual",
          model: "router",
        },
      },
      started.ctx,
    );
    await emit(mock, "agent_settled", {}, started.ctx);
    const recorded = store.runs[0];
    assert.ok(recorded);
    const run = decodeStoredRun(encodeStoredRun(recorded));
    assert.equal(run.outcome, "error");
    assert.equal(run.generations.length, earlierSuccess ? 1 : 0);
    assert.equal(run.providerErrors[0]?.generationId, undefined);
    assert.equal(run.providerErrors[0]?.provider, undefined);
    assert.equal(run.providerErrors[0]?.model, undefined);
    assert.equal(run.providerErrors[0]?.terminal, true);
  }
});

test("idle provider warming followed by real work does not create a phantom response cycle", async () => {
  const store = new FakeStore();
  const mock = createMockPi();
  createAnalyticsExtension({ createStore: () => store })(mock.pi);
  let idle = true;
  const started = lifecycleContext({ isIdle: () => idle });
  await emit(mock, "session_start", { reason: "startup" }, started.ctx);
  const warm = async () => {
    await emit(mock, "before_provider_request", { payload: {} }, started.ctx);
    await emit(mock, "after_provider_response", { status: 503, headers: {} }, started.ctx);
  };
  await warm();
  assert.equal(store.runs.length, 0);
  idle = false;
  await emit(mock, "before_agent_start", { systemPromptOptions: { skills: [] } }, started.ctx);
  for (const stopReason of ["error", "stop"]) {
    await emit(mock, "agent_start", {}, started.ctx);
    await emit(mock, "turn_start", {}, started.ctx);
    await emit(mock, "before_provider_request", { payload: {} }, started.ctx);
    await emit(mock, "after_provider_response", { status: 200, headers: {} }, started.ctx);
    await emit(
      mock,
      "message_end",
      { message: { role: "assistant", stopReason, provider: "physical", model: "m" } },
      started.ctx,
    );
  }
  idle = true;
  await emit(mock, "agent_settled", {}, started.ctx);
  await warm();
  idle = false;
  await settleOneRun(mock, started.ctx);
  assert.equal(store.runs.length, 2);
  assert.deepEqual(
    store.runs.map((run) => run.outcome),
    ["recovered_success", "success"],
  );
  assert.deepEqual(
    store.runs.map((run) => run.generations.length),
    [2, 1],
  );
  assert.deepEqual(
    store.runs.map((run) => run.attemptCount),
    [2, 1],
  );
  assert.deepEqual(
    store.runs.map((run) => run.providerErrorCount),
    [1, 0],
  );
  assert.equal(store.runs[0]?.providerErrors[0]?.provider, "physical");
  assert.deepEqual(
    store.runs
      .flatMap((run) => run.generations.flatMap((generation) => generation.responses))
      .map((response) => response.status),
    [200, 200],
  );
});

test("warming in a pre-stream window cannot confirm a synthesized resolver failure", async () => {
  const store = new FakeStore();
  const mock = createMockPi();
  createAnalyticsExtension({ createStore: () => store })(mock.pi);
  const started = lifecycleContext({ model: { provider: "virtual", id: "router" } });
  await emit(mock, "session_start", {}, started.ctx);
  await emit(mock, "before_agent_start", { systemPromptOptions: { skills: [] } }, started.ctx);
  await emit(mock, "agent_start", {}, started.ctx);
  await emit(mock, "turn_start", {}, started.ctx);
  // The host can replay warming hooks while the new turn is still resolving.
  await emit(mock, "cache_warming_decision", { action: "warm" }, started.ctx);
  await emit(mock, "before_provider_request", { payload: {} }, started.ctx);
  await emit(mock, "after_provider_response", { status: 503 }, started.ctx);
  await emit(mock, "message_start", { message: { role: "assistant", stopReason: "error" } }, started.ctx);
  await emit(
    mock,
    "message_end",
    { message: { role: "assistant", stopReason: "error", provider: "virtual", model: "router" } },
    started.ctx,
  );
  // A retry succeeds, even though untagged hooks remain ambiguous.
  await emit(mock, "agent_start", {}, started.ctx);
  await emit(mock, "turn_start", {}, started.ctx);
  await emit(mock, "before_provider_request", { payload: {} }, started.ctx);
  await emit(mock, "message_start", { message: { role: "assistant" } }, started.ctx);
  await emit(
    mock,
    "message_end",
    { message: { role: "assistant", stopReason: "toolUse", provider: "physical", model: "m" } },
    started.ctx,
  );
  await emit(mock, "tool_execution_start", { toolCallId: "tool", toolName: "read" }, started.ctx);
  await emit(mock, "tool_execution_end", { toolCallId: "tool", isError: false }, started.ctx);
  await emit(mock, "agent_settled", {}, started.ctx);
  const run = store.runs[0];
  assert.ok(run);
  assert.equal(run.outcome, "recovered_success");
  assert.equal(run.attemptCount, 2);
  assert.equal(run.generations.length, 1);
  assert.equal(run.generations[0]?.model, "m");
  assert.deepEqual(run.generations[0]?.responses, []);
  assert.equal(run.tools[0]?.model, "m");
  assert.equal(run.providerErrorCount, 1, "only the synthesized assistant failure counts, not warm HTTP 503");
  assert.equal(run.providerErrors[0]?.generationId, undefined);
  assert.equal(run.providerErrors[0]?.provider, undefined);
  assert.equal(run.providerErrors[0]?.model, undefined);
  assert.equal(run.providerErrors[0]?.recovered, true);
});

test("a delayed skill read cannot attach to a later response cycle", async () => {
  const store = new FakeStore();
  let canonicalCalls = 0;
  let reached!: () => void;
  const matching = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = createMockPi({
    allTools: [{ name: "read", sourceInfo: { source: "builtin" } }],
  });
  createAnalyticsExtension({
    createStore: () => store,
    createSkillTracker: (cwd) =>
      new SkillTracker(cwd, async (filePath) => {
        canonicalCalls += 1;
        if (canonicalCalls === 2) {
          reached();
          await blocked;
        }
        return filePath;
      }),
  })(mock.pi);
  const started = lifecycleContext();
  await emit(mock, "session_start", { reason: "startup" }, started.ctx);
  const skills = [{ name: "reviewing-code", filePath: "/workspace/SKILL.md" }];
  await emit(mock, "before_agent_start", { prompt: "first", systemPromptOptions: { skills } }, started.ctx);
  await emit(mock, "turn_start", {}, started.ctx);
  await emit(mock, "before_provider_request", { payload: {} }, started.ctx);
  const reading = emit(
    mock,
    "tool_result",
    {
      toolName: "read",
      input: { path: "/workspace/SKILL.md" },
      isError: false,
    },
    started.ctx,
  );
  await matching;
  await emit(mock, "message_end", { message: { role: "assistant", stopReason: "stop" } }, started.ctx);
  await emit(mock, "agent_settled", {}, started.ctx);
  await emit(mock, "before_agent_start", { prompt: "second", systemPromptOptions: { skills } }, started.ctx);
  await emit(mock, "turn_start", {}, started.ctx);
  release();
  await reading;
  await emit(mock, "before_provider_request", { payload: {} }, started.ctx);
  await emit(mock, "message_end", { message: { role: "assistant", stopReason: "stop" } }, started.ctx);
  await emit(mock, "agent_settled", {}, started.ctx);
  assert.deepEqual(
    store.runs.map(({ skills: runSkills }) => runSkills),
    [[], []],
  );
});

test("shutdown drops an active interrupted response and only closes storage", async () => {
  const store = new FakeStore();
  const mock = createMockPi();
  createAnalyticsExtension({ createStore: () => store })(mock.pi);
  const started = lifecycleContext();
  await emit(mock, "session_start", { reason: "startup" }, started.ctx);
  await emit(mock, "before_agent_start", { prompt: "run", systemPromptOptions: { skills: [] } }, started.ctx);
  await emit(mock, "before_provider_request", { payload: {} }, started.ctx);
  await emit(mock, "session_shutdown", { reason: "quit" }, started.ctx);
  assert.equal(store.runs.length, 0);
  assert.equal(store.closed, 1);
});

test("session shutdown aborts a delayed write and suppresses stale failure feedback", async () => {
  const store = new FakeStore();
  store.recordRun = async (_run, signal) => {
    store.signals.push(signal);
    await new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const mock = createMockPi();
  createAnalyticsExtension({ createStore: () => store })(mock.pi);
  const started = lifecycleContext();
  await emit(mock, "session_start", { reason: "startup" }, started.ctx);
  await emit(mock, "before_agent_start", { prompt: "run", systemPromptOptions: { skills: [] } }, started.ctx);
  await emit(mock, "before_provider_request", { payload: {} }, started.ctx);
  await emit(mock, "message_end", { message: { role: "assistant", stopReason: "stop" } }, started.ctx);
  const settling = emit(mock, "agent_settled", {}, started.ctx);
  await Promise.resolve();
  const shutdown = emit(mock, "session_shutdown", { reason: "quit" }, started.ctx);
  await Promise.all([settling, shutdown]);
  assert.equal(store.signals[0]?.aborted, true);
  assert.equal(store.closed, 1);
  assert.equal(started.notifications.filter(({ message }) => message.includes("could not save")).length, 0);
});

test("write failure notifies once and a later success reports recovery without leaking paths", async () => {
  const store = new FakeStore();
  store.failWrites = true;
  const mock = createMockPi();
  createAnalyticsExtension({ createStore: () => store })(mock.pi);
  const started = lifecycleContext();
  await emit(mock, "session_start", { reason: "startup" }, started.ctx);
  await settleOneRun(mock, started.ctx, "first");
  await settleOneRun(mock, started.ctx, "second");
  assert.equal(started.notifications.filter(({ message }) => message.includes("could not save")).length, 1);
  store.failWrites = false;
  await settleOneRun(mock, started.ctx, "third");
  assert.ok(started.notifications.some(({ message }) => message.includes("storage recovered")));
  assert.doesNotMatch(started.notifications.map(({ message }) => message).join("\n"), /private\/path/);
});

test("arguments and noninteractive command modes reject before querying", async () => {
  const store = new FakeStore();
  let loads = 0;
  store.getSnapshot = async () => {
    loads += 1;
    return emptySnapshot;
  };
  const mock = createMockPi();
  createAnalyticsExtension({ createStore: () => store })(mock.pi);
  const command = mock.commands.get("analytics");
  assert.ok(command);
  const interactive = lifecycleContext();
  await emit(mock, "session_start", { reason: "startup" }, interactive.ctx);
  await command.handler("trailing", interactive.ctx);
  assert.ok(interactive.notifications.some(({ message }) => message.includes("does not accept arguments")));
  for (const mode of ["print", "json"] as const) {
    const noninteractive = lifecycleContext({ hasUI: false, mode });
    await assert.rejects(async () => command.handler("", noninteractive.ctx), /TUI or RPC/);
    await assert.rejects(async () => command.handler("trailing", noninteractive.ctx), /does not accept arguments/);
  }
  assert.equal(loads, 0);
});

test("store construction failures are content-free and keep the command available", async () => {
  const mock = createMockPi();
  createAnalyticsExtension({
    createStore: () => {
      throw new Error("failed at /home/private/user");
    },
  })(mock.pi);
  const started = lifecycleContext();
  await emit(mock, "session_start", { reason: "startup" }, started.ctx);
  const message = started.notifications.find(({ message }) => message.includes("could not be initialized"))?.message;
  assert.match(message ?? "", /No analytics are being collected/);
  assert.doesNotMatch(message ?? "", /private\/user/);
  assert.ok(mock.commands.has("analytics"));
});

for (const reason of ["startup", "reload"]) {
  test(`first custom run after ${reason} discovers skill reads without consuming explicit user input`, async () => {
    const store = new FakeStore();
    const mock = createMockPi({ allTools: [{ name: "read", sourceInfo: { source: "builtin" } }] });
    createAnalyticsExtension({
      createStore: () => store,
      createSkillTracker: (cwd) => new SkillTracker(cwd, async (value) => value),
    })(mock.pi);
    const started = lifecycleContext();
    await emit(mock, "session_start", { reason }, started.ctx);
    await emit(mock, "input", { text: "/skill:reviewing-code", source: "interactive" }, started.ctx);
    const systemPromptOptions = { skills: [{ name: "reviewing-code", filePath: "/workspace/SKILL.md" }] };
    await emit(
      mock,
      "before_agent_start",
      { messageType: "custom", message: { customType: "wake" }, systemPromptOptions },
      started.ctx,
    );
    await emit(mock, "agent_start", {}, started.ctx);
    await emit(mock, "turn_start", {}, started.ctx);
    await emit(
      mock,
      "tool_result",
      { toolName: "read", input: { path: "/workspace/SKILL.md" }, isError: false },
      started.ctx,
    );
    await emit(mock, "message_end", { message: { role: "assistant", stopReason: "stop" } }, started.ctx);
    await emit(mock, "agent_settled", {}, started.ctx);
    // Pending user preflight survives both the custom hook AND its settlement.
    await emit(mock, "before_agent_start", { messageType: "user", prompt: "skill", systemPromptOptions }, started.ctx);
    await emit(mock, "agent_start", {}, started.ctx);
    await emit(mock, "turn_start", {}, started.ctx);
    await emit(mock, "message_end", { message: { role: "assistant", stopReason: "stop" } }, started.ctx);
    await emit(mock, "agent_settled", {}, started.ctx);
    assert.equal(store.runs[0]?.triggerSource, "extension");
    assert.deepEqual(
      store.runs[0]?.skills.map(({ name, initiatedBy }) => ({ name, initiatedBy })),
      [{ name: "reviewing-code", initiatedBy: "model" }],
    );
    assert.equal(store.runs[1]?.triggerSource, "interactive");
    assert.deepEqual(
      store.runs[1]?.skills.map(({ initiatedBy }) => initiatedBy),
      ["user"],
    );
  });
}

test("stale async custom discovery cannot consume the replacement session's explicit skill", async () => {
  const store = new FakeStore();
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = createMockPi({ allTools: [{ name: "read", sourceInfo: { source: "builtin" } }] });
  createAnalyticsExtension({
    createStore: () => store,
    createSkillTracker: (cwd) =>
      new SkillTracker(cwd, async (path) => {
        if (path.endsWith("old.md")) {
          entered();
          await held;
        }
        return path;
      }),
  })(mock.pi);
  const started = lifecycleContext();
  await emit(mock, "session_start", { reason: "startup" }, started.ctx);
  const stale = emit(
    mock,
    "before_agent_start",
    {
      messageType: "custom",
      message: { customType: "wake" },
      systemPromptOptions: { skills: [{ name: "old", filePath: "/workspace/old.md" }] },
    },
    started.ctx,
  );
  await reached;
  await emit(mock, "session_start", { reason: "reload" }, started.ctx);
  await emit(mock, "input", { text: "/skill:new", source: "interactive" }, started.ctx);
  release();
  await stale;
  await emit(
    mock,
    "before_agent_start",
    {
      messageType: "user",
      prompt: "new",
      systemPromptOptions: { skills: [{ name: "new", filePath: "/workspace/new.md" }] },
    },
    started.ctx,
  );
  await emit(mock, "turn_start", {}, started.ctx);
  await emit(
    mock,
    "tool_result",
    { toolName: "read", input: { path: "/workspace/old.md" }, isError: false },
    started.ctx,
  );
  await emit(mock, "message_end", { message: { role: "assistant", stopReason: "stop" } }, started.ctx);
  await emit(mock, "agent_settled", {}, started.ctx);
  assert.equal(store.runs[0]?.triggerSource, "interactive");
  assert.deepEqual(
    store.runs[0]?.skills.map(({ name, initiatedBy }) => ({ name, initiatedBy })),
    [{ name: "new", initiatedBy: "user" }],
  );
});

test("an idle custom-message run is recorded as extension-triggered", async () => {
  const store = new FakeStore();
  const mock = createMockPi();
  createAnalyticsExtension({ createStore: () => store })(mock.pi);
  const started = lifecycleContext();
  await emit(mock, "session_start", { reason: "startup" }, started.ctx);
  // Pi 1.2+ announces a run started by pi.sendMessage(..., { triggerTurn: true }) here too.
  const custom = { messageType: "custom", message: { customType: "wake" }, systemPromptOptions: { skills: [] } };
  for (const [event, payload] of [
    ["before_agent_start", custom],
    ["agent_start", {}],
    ["turn_start", {}],
    ["message_end", { message: { role: "assistant", stopReason: "stop" } }],
    ["agent_settled", {}],
    ["input", { text: "follow up", source: "interactive" }],
    ["before_agent_start", { messageType: "user", prompt: "follow up", systemPromptOptions: { skills: [] } }],
    ["agent_start", {}],
    ["turn_start", {}],
    ["message_end", { message: { role: "assistant", stopReason: "stop" } }],
    ["agent_settled", {}],
  ] as const) {
    await emit(mock, event, payload, started.ctx);
  }
  assert.deepEqual(
    store.runs.map(({ triggerSource }) => triggerSource),
    ["extension", "interactive"],
  );
});
