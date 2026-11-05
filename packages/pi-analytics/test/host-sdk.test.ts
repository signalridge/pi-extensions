import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { test, vi } from "vitest";
import { type AnalyticsStorePort, createAnalyticsExtension } from "../src/analytics.js";
import { decodeStoredRun, encodeStoredRun } from "../src/storage/format.js";
import type { SettledRun } from "../src/types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Intercept the installed ModelRuntime boundary, not extension events: the real
// SDK owns the cache timer, replayed hooks, agent loop and sequential tool batch.
for (const phase of ["tools", "streaming"] as const) {
  test(`host streaming warmer HTTP failure during ${phase} does not affect assistant accounting`, async () => {
    const root = mkdtempSync(join(tmpdir(), "analytics-warming-host-"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    const skillPath = join(root, "SKILL.md");
    writeFileSync(skillPath, "---\nname: warming-test\ndescription: Test skill\n---\nTest instructions\n");
    const runs: SettledRun[] = [];
    const store: AnalyticsStorePort = {
      path: join(agentDir, "analytics"),
      async recordRun(run) {
        runs.push(decodeStoredRun(encodeStoredRun(run)));
      },
      async getSnapshot() {
        throw new Error("dashboard is not used");
      },
      async clearAll() {
        return { cleanupIncomplete: false };
      },
      async close() {},
    };
    const toolReached = deferred();
    const streamReached = deferred();
    const releaseTool = deferred();
    const releaseStream = deferred();
    const warmed = deferred();
    const order: string[] = [];
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let interception: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(agentDir, "models-cache.json"),
        allowModelNetwork: false,
      });
      const faux = fauxProvider({
        provider: "analytics-warming-faux",
        models: [{ id: "physical", cost: { input: 10, output: 10, cacheRead: 1, cacheWrite: 10 } }],
      });
      runtime.registerNativeProvider(faux.provider);
      await runtime.refresh({ allowNetwork: false });
      const registry = new ModelRegistry(runtime);
      const model = registry.find("analytics-warming-faux", "physical");
      assert.ok(model);
      model.promptCache = { short: 300, long: 300 };
      let realRequests = 0;
      let warmRequests = 0;
      interception = vi.spyOn(runtime, "streamSimple").mockImplementation((requestModel, _context, options) => {
        const stream = createAssistantMessageEventStream();
        const warm = options?.maxTokens === 1;
        const index = warm ? ++warmRequests : ++realRequests;
        const message = fauxAssistantMessage(
          warm
            ? ""
            : index === 1
              ? [
                  fauxToolCall("slow", {}, { id: "slow-1" }),
                  fauxToolCall("read", { path: skillPath }, { id: "read-1" }),
                ]
              : "done",
          {
            stopReason: warm ? "error" : index === 1 ? "toolUse" : "stop",
            errorMessage: warm ? "HTTP 503 warm failed" : undefined,
          },
        );
        Object.assign(message, {
          provider: requestModel.provider,
          model: requestModel.id,
          api: requestModel.api,
          responseModel: warm ? "warm-only" : `reported-${index}`,
        });
        message.usage.cacheRead = 100_000; // Enough cached context for real warming economics.
        void (async () => {
          await options?.onPayload?.({ warm, index }, requestModel);
          await options?.onResponse?.({ status: warm ? 503 : 200, headers: {} }, requestModel);
          if (warm) {
            stream.push({ type: "error", reason: "error", error: message });
            stream.end(message);
            warmed.resolve();
            return;
          }
          stream.push({ type: "start", partial: { ...message, stopReason: "pending" } });
          if (index === 1 && phase === "streaming") await releaseStream.promise;
          stream.push({ type: "done", reason: index === 1 ? "toolUse" : "stop", message });
          stream.end(message);
        })();
        return stream;
      });
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
        skillsOverride: () => ({
          skills: [
            {
              name: "warming-test",
              description: "Test skill",
              filePath: skillPath,
              baseDir: root,
              source: "test",
              disableModelInvocation: false,
            },
          ],
          diagnostics: [],
        }),
        extensionFactories: [
          {
            name: "analytics",
            factory: createAnalyticsExtension({ createStore: () => store, getAgentDir: () => agentDir }),
          },
          {
            name: "probe",
            factory: (pi) => {
              pi.registerTool({
                name: "slow",
                label: "Slow test tool",
                description: "Wait for the test",
                parameters: Type.Object({}),
                executionMode: "sequential",
                async execute() {
                  order.push("slow-start");
                  toolReached.resolve();
                  await releaseTool.promise;
                  order.push("slow-end");
                  return { content: [{ type: "text", text: "finished" }], details: undefined };
                },
              });
              pi.on("before_provider_request", (event, ctx) => {
                const warm = (event.payload as { warm: boolean }).warm;
                if (warm) assert.equal(ctx.isIdle(), false, "warming must overlap nonidle agent work");
                order.push(warm ? "warm-request" : "request");
              });
              pi.on("after_provider_response", (event) => {
                order.push(`http-${event.status}`);
              });
              pi.on("message_start", (event) => {
                if (event.message.role === "assistant") {
                  order.push("assistant-start");
                  streamReached.resolve();
                }
              });
              pi.on("message_end", (event) => {
                if (event.message.role === "assistant") order.push("assistant-end");
              });
              pi.on("tool_execution_start", (event) => {
                if (event.toolName === "read") order.push("read-start");
              });
            },
          },
        ],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      ({ session } = await createAgentSession({
        cwd: root,
        agentDir,
        model,
        modelRuntime: runtime,
        modelRegistry: registry,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(root),
        tools: ["read", "slow"],
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
          cacheWarming: "streaming",
        }),
      }));
      await session.bindExtensions({});
      // Seed prior prompt usage so warming is economical even during streaming.
      session.sessionManager.appendMessage({
        ...fauxAssistantMessage("prior"),
        provider: model.provider,
        model: model.id,
        api: model.api,
        usage: { ...fauxAssistantMessage("").usage, cacheRead: 100_000 },
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const prompting = session.prompt("run the slow tool, then read the skill");
      if (phase === "streaming") await streamReached.promise;
      else await toolReached.promise;
      assert.equal(session.cacheWarmingStatus?.state, "scheduled");
      await vi.advanceTimersByTimeAsync(270_000);
      await warmed.promise;
      assert.equal(warmRequests, 1, "the actual installed warmer fired after 90% of the five-minute TTL");
      if (phase === "streaming") {
        releaseStream.resolve();
        await toolReached.promise;
      }
      releaseTool.resolve();
      await prompting;
      assert.equal(faux.state.callCount, 0, "all provider requests are intercepted; no network");
      assert.equal(realRequests, 2);
      assert.deepEqual(order.slice(0, 3), ["request", "http-200", "assistant-start"]);
      assert.ok(
        order.indexOf("slow-end") < order.indexOf("read-start"),
        "the skill read follows the slow tool sequentially",
      );
      assert.equal(runs.length, 1);
      const run = runs[0];
      assert.ok(run);
      assert.equal(run.outcome, "success");
      assert.equal(run.providerErrorCount, 0);
      assert.deepEqual(run.providerErrors, []);
      assert.equal(run.generations.length, 2, "no phantom warming generation");
      assert.deepEqual(
        run.generations.map(({ responseModel }) => responseModel),
        ["reported-1", "reported-2"],
      );
      assert.doesNotMatch(JSON.stringify(run), /warm-only/);
      for (const message of session.messages) {
        if (message.role === "assistant" && message.responseModel?.startsWith("reported-")) {
          assert.equal(message.usage.cacheRead, 100_000, "metadata collection never changes native usage");
        }
      }
      assert.deepEqual(
        run.generations.flatMap((generation) => generation.responses.map((response) => response.status)),
        [200],
      );
      for (const record of [...run.generations, ...run.tools, ...run.skills]) {
        assert.equal(record.provider, model.provider);
        assert.equal(record.model, model.id);
      }
      assert.deepEqual(
        run.tools.map((tool) => tool.name),
        ["slow", "read"],
      );
      assert.deepEqual(
        run.skills.map((skill) => skill.name),
        ["warming-test"],
      );
    } finally {
      releaseStream.resolve();
      releaseTool.resolve();
      session?.dispose();
      interception?.mockRestore();
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
}

// Reload replaces extension factories, but the SDK retains the warmer and its
// provider callbacks. Delay its payload as if ModelRuntime were async preparing,
// then deliver those old hooks into a fresh runner while a new route is pending.
test("host reload ignores deferred old idle warmer hooks during new route failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "analytics-reload-host-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const runs: SettledRun[] = [];
  const store: AnalyticsStorePort = {
    path: join(agentDir, "analytics"),
    async recordRun(run) {
      runs.push(decodeStoredRun(encodeStoredRun(run)));
    },
    async getSnapshot() {
      throw new Error("dashboard is not used");
    },
    async clearAll() {
      return { cleanupIncomplete: false };
    },
    async close() {},
  };
  const warmReached = deferred();
  const releaseWarmHooks = deferred();
  const warmHooksDelivered = deferred();
  const routeReached = deferred();
  const releaseRoute = deferred();
  const order: string[] = [];
  const extensionErrors: string[] = [];
  let analyticsFactories = 0;
  let probeFactories = 0;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let interception: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models-cache.json"),
      allowModelNetwork: false,
    });
    const faux = fauxProvider({
      provider: "analytics-reload-faux",
      models: [{ id: "physical", cost: { input: 10, output: 10, cacheRead: 1, cacheWrite: 10 } }],
    });
    runtime.registerNativeProvider(faux.provider);
    runtime.registerVirtualModel({
      provider: "analytics-reload-router",
      id: "router",
      name: "Test router",
      async route() {
        order.push("route-pending");
        routeReached.resolve();
        await releaseRoute.promise;
        throw new Error("resolver failed");
      },
    });
    await runtime.refresh({ allowNetwork: false });
    const registry = new ModelRegistry(runtime);
    const physical = registry.find("analytics-reload-faux", "physical");
    const router = registry.find("analytics-reload-router", "router");
    assert.ok(physical);
    assert.ok(router);
    physical.promptCache = { short: 300, long: 300 };
    let realRequests = 0;
    let warmRequests = 0;
    let warmSignal: AbortSignal | undefined;
    interception = vi.spyOn(runtime, "streamSimple").mockImplementation((requestModel, _context, options) => {
      const stream = createAssistantMessageEventStream();
      const warm = options?.maxTokens === 1;
      const index = warm ? ++warmRequests : ++realRequests;
      const toolUse = !warm && index === 2;
      const message = fauxAssistantMessage(toolUse ? fauxToolCall("step", {}, { id: "step-1" }) : warm ? "" : "done", {
        stopReason: warm ? "error" : toolUse ? "toolUse" : "stop",
        errorMessage: warm ? "HTTP 503 old warm failed" : undefined,
      });
      Object.assign(message, { provider: requestModel.provider, model: requestModel.id, api: requestModel.api });
      message.usage.cacheRead = 200_000; // Idle continuation economics must permit warming.
      if (warm) {
        warmSignal = options?.signal;
        order.push("old-warm-preparing");
        warmReached.resolve();
      }
      void (async () => {
        if (warm) await releaseWarmHooks.promise;
        await options?.onPayload?.({ warm, index }, requestModel);
        await options?.onResponse?.({ status: warm ? 503 : 200, headers: {} }, requestModel);
        if (warm) {
          stream.push({ type: "error", reason: "error", error: message });
          stream.end(message);
          warmHooksDelivered.resolve();
          return;
        }
        stream.push({ type: "start", partial: { ...message, stopReason: "pending" } });
        stream.push({ type: "done", reason: toolUse ? "toolUse" : "stop", message });
        stream.end(message);
      })();
      return stream;
    });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        {
          name: "analytics",
          factory: (pi) => {
            analyticsFactories += 1;
            createAnalyticsExtension({ createStore: () => store, getAgentDir: () => agentDir })(pi);
          },
        },
        {
          name: "probe",
          factory: (pi) => {
            const factory = ++probeFactories;
            pi.registerTool({
              name: "step",
              label: "Step",
              description: "Finish one step",
              parameters: Type.Object({}),
              async execute() {
                return { content: [{ type: "text", text: "finished" }], details: undefined };
              },
            });
            pi.on("session_start", (event) => {
              order.push(`${factory}:${event.reason}`);
            });
            pi.on("cache_warming_decision", (event, ctx) => {
              assert.equal(ctx.isIdle(), true);
              assert.equal(event.action, "warm");
              order.push(`${factory}:warm-decision`);
            });
            pi.on("turn_start", () => {
              order.push(`${factory}:turn`);
            });
            pi.on("before_provider_request", (event, ctx) => {
              const warm = (event.payload as { warm: boolean }).warm;
              if (warm) assert.equal(ctx.isIdle(), false);
              order.push(`${factory}:${warm ? "old-warm-request" : "request"}`);
            });
            pi.on("after_provider_response", (event) => {
              order.push(`${factory}:http-${event.status}`);
            });
            pi.on("message_start", (event) => {
              if (event.message.role === "assistant") order.push(`${factory}:assistant-start`);
            });
          },
        },
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd: root,
      agentDir,
      model: physical,
      modelRuntime: runtime,
      modelRegistry: registry,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root),
      tools: ["step"],
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
        cacheWarming: "idle",
      }),
    }));
    // A real binding makes SDK.reload emit session_start into the fresh runner.
    await session.bindExtensions({ onError: (error) => extensionErrors.push(error.error) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await session.prompt("prime the idle cache");
    assert.equal(runs[0]?.generations.length, 1);
    assert.equal(runs[0]?.generations[0]?.responses[0]?.status, 200, "startup accepts unambiguous hooks");
    assert.equal(session.cacheWarmingStatus?.state, "scheduled");
    await vi.advanceTimersByTimeAsync(270_000);
    await warmReached.promise;
    assert.equal(warmRequests, 1);
    assert.equal(session.cacheWarmingStatus?.state, "refreshing");
    await session.reload(); // Actual SDK shutdown, resource reload, fresh factories and session_start.
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(analyticsFactories, 2);
    assert.equal(probeFactories, 2);
    assert.equal(warmSignal?.aborted, false, "reload did not cancel the old in-flight warm");
    await session.setModel(router);
    const prompting = session.prompt("fail in the new route");
    await routeReached.promise;
    assert.equal(realRequests, 1, "the new turn has not reached a real stream/cancel-warm boundary");
    assert.equal(warmSignal?.aborted, false);
    releaseWarmHooks.resolve();
    await warmHooksDelivered.promise;
    assert.deepEqual(order, [
      "1:startup",
      "1:turn",
      "1:request",
      "1:http-200",
      "1:assistant-start",
      "1:warm-decision",
      "old-warm-preparing",
      "2:reload",
      "2:turn",
      "route-pending",
      "2:old-warm-request",
      "2:http-503",
    ]);
    releaseRoute.resolve();
    await prompting;
    assert.equal(realRequests, 1, "resolver failure never dispatched a new physical request");
    assert.equal(faux.state.callCount, 0, "all provider requests are intercepted; no network");
    assert.deepEqual(extensionErrors, []);
    assert.equal(runs.length, 2);
    const failed = runs[1];
    assert.ok(failed);
    assert.equal(failed.initialProvider, router.provider);
    assert.equal(failed.initialModel, router.id);
    assert.equal(failed.outcome, "error");
    assert.deepEqual(
      {
        generations: failed.generations.length,
        httpStatuses: failed.generations.flatMap((generation) => generation.responses.map(({ status }) => status)),
        providerErrorCount: failed.providerErrorCount,
        errors: failed.providerErrors.map(({ provider, model, generationId, terminal }) => ({
          provider,
          model,
          hasGeneration: generationId !== undefined,
          terminal,
        })),
      },
      {
        generations: 0,
        httpStatuses: [],
        providerErrorCount: 1,
        errors: [{ provider: undefined, model: undefined, hasGeneration: false, terminal: true }],
      },
    );
    // Conservatism after reload must not lose successful physical generations or tools.
    await session.setModel(physical);
    await session.prompt("run one step successfully");
    assert.equal(realRequests, 3);
    assert.deepEqual(extensionErrors, []);
    assert.equal(runs.length, 3);
    const success = runs[2];
    assert.ok(success);
    assert.equal(success.outcome, "success");
    assert.equal(success.providerErrorCount, 0);
    assert.equal(success.generations.length, 2);
    assert.deepEqual(
      success.generations.flatMap((generation) => generation.responses),
      [],
    );
    assert.deepEqual(
      success.tools.map(({ name }) => name),
      ["step"],
    );
    for (const record of [...success.generations, ...success.tools]) {
      assert.equal(record.provider, physical.provider);
      assert.equal(record.model, physical.id);
    }
  } finally {
    releaseWarmHooks.resolve();
    releaseRoute.resolve();
    session?.dispose();
    interception?.mockRestore();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

// Real SDK/Agent failure synthesis: a resolver exception precedes the provider
// hook, but Agent.handleRunFailure still stamps the selected router on the message.
for (const earlierSuccess of [false, true]) {
  test(`host ${earlierSuccess ? "post-tool" : "initial"} resolver failure keeps selected router metadata without physical error attribution`, async () => {
    const root = mkdtempSync(join(tmpdir(), "analytics-host-"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    const runs: SettledRun[] = [];
    const store: AnalyticsStorePort = {
      path: join(agentDir, "analytics"),
      async recordRun(run) {
        runs.push(decodeStoredRun(encodeStoredRun(run)));
      },
      async getSnapshot() {
        throw new Error("dashboard is not used");
      },
      async clearAll() {
        return { cleanupIncomplete: false };
      },
      async close() {},
    };
    const faux = fauxProvider({ provider: "analytics-faux", models: [{ id: "physical" }] });
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(agentDir, "models-cache.json"),
        allowModelNetwork: false,
      });
      runtime.registerNativeProvider(faux.provider);
      let routes = 0;
      if (earlierSuccess) {
        faux.setResponses(
          [1, 2].map((id) =>
            fauxAssistantMessage(fauxToolCall("step", {}, { id: `step-${id}` }), { stopReason: "toolUse" }),
          ),
        );
      }
      runtime.registerVirtualModel({
        provider: "analytics-router",
        id: "router",
        name: "Test router",
        route() {
          routes += 1;
          if (earlierSuccess && routes % 2 === 1) return { model: faux.getModel(), thinkingLevel: "off" };
          throw new Error("resolver failed");
        },
      });
      await runtime.refresh({ allowNetwork: false });
      const registry = new ModelRegistry(runtime);
      const model = registry.find("analytics-router", "router");
      assert.ok(model);
      let providerRequests = 0;
      const lifecycle: string[] = [];
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
          {
            name: "analytics",
            factory: createAnalyticsExtension({ createStore: () => store, getAgentDir: () => agentDir }),
          },
          {
            name: "probe",
            factory: (pi) => {
              pi.registerTool({
                name: "step",
                label: "Step",
                description: "Finish one step",
                parameters: Type.Object({}),
                async execute() {
                  return { content: [{ type: "text", text: "finished" }], details: undefined };
                },
              });
              pi.on("before_provider_request", () => {
                providerRequests += 1;
                lifecycle.push("request");
              });
              pi.on("turn_start", () => {
                lifecycle.push("turn");
              });
              pi.on("message_start", (event) => {
                if (event.message.role === "assistant") lifecycle.push("assistant-start");
              });
              pi.on("message_end", (event) => {
                if (event.message.role === "assistant") lifecycle.push("assistant-end");
              });
            },
          },
        ],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      ({ session } = await createAgentSession({
        cwd: root,
        agentDir,
        model,
        modelRuntime: runtime,
        modelRegistry: registry,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(root),
        noTools: !earlierSuccess,
        tools: earlierSuccess ? ["step"] : undefined,
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
          cacheWarming: "off",
        }),
      }));
      await session.bindExtensions({});
      // Two settled runs also prove dispatch evidence cannot leak across cycles.
      for (const prompt of ["first", "second"]) await session.prompt(prompt);
      assert.equal(routes, earlierSuccess ? 4 : 2);
      assert.equal(faux.state.callCount, earlierSuccess ? 2 : 0);
      assert.equal(providerRequests, 0);
      assert.deepEqual(
        lifecycle,
        Array.from({ length: earlierSuccess ? 4 : 2 }, () => ["turn", "assistant-start", "assistant-end"]).flat(),
      );
      const failures = session.messages.filter(
        (message) => message.role === "assistant" && message.stopReason === "error",
      );
      assert.equal(failures.length, 2);
      for (const message of failures) {
        assert.equal(message.stopReason, "error");
        assert.equal(message.provider, "analytics-router");
        assert.equal(message.model, "router");
      }
      assert.equal(runs.length, 2);
      for (const run of runs) {
        assert.equal(run.initialProvider, "analytics-router");
        assert.equal(run.initialModel, "router");
        assert.equal(run.outcome, "error");
        assert.equal(run.generations.length, earlierSuccess ? 1 : 0);
        if (earlierSuccess) {
          assert.equal(run.generations[0]?.provider, "analytics-faux");
          assert.equal(run.generations[0]?.model, "physical");
          assert.equal(run.tools[0]?.model, "physical");
        }
        assert.equal(run.providerErrorCount, 1);
        assert.equal(run.providerErrors[0]?.generationId, undefined);
        assert.equal(run.providerErrors[0]?.provider, undefined);
        assert.equal(run.providerErrors[0]?.model, undefined);
        assert.equal(run.providerErrors[0]?.terminal, true);
      }
    } finally {
      session?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
