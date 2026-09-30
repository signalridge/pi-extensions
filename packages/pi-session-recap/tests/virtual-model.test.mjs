import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import sessionRecap from "../index.ts";

async function makeModels(suffix) {
  const faux = fauxProvider({ provider: `faux-recap-${suffix}` });
  const sourceId = `recap-virtual-${suffix}`;
  registerApiProvider(
    { api: faux.api, stream: faux.provider.stream, streamSimple: faux.provider.streamSimple },
    sourceId,
  );
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  runtime.registerVirtualModel({
    provider: "router",
    id: "auto",
    name: "Auto",
    thinkingLevels: ["off", "high"],
    route: () => ({ model: faux.getModel(), thinkingLevel: "high" }),
  });
  const registry = new ModelRegistry(runtime);
  return {
    faux,
    registry,
    physical: registry.find(faux.provider.id, faux.getModel().id),
    virtual: registry.find("router", "auto"),
    unregister: () => unregisterApiProviders(sourceId),
  };
}

function makeHarness(physical, virtual, registry, override, consent = false) {
  const commands = new Map();
  const handlers = new Map();
  const flags = new Map();
  sessionRecap({
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerFlag: (name, options) => flags.set(name, options.default),
    getFlag: (name) => flags.get(name),
  });
  if (override) flags.set("recap-model", override);
  if (consent) flags.set("recap-allow-raw-history", true);

  const manager = SessionManager.inMemory();
  manager.appendMessage({
    role: "system",
    content: "Private parent instructions",
    toolsAdded: [
      { name: "private-parent-tool", description: "Internal", parameters: { type: "object", properties: {} } },
    ],
    timestamp: 1,
  });
  manager.appendMessage({ role: "user", content: "Build the preview safely.", timestamp: 2 });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "I inspected the preview and identified the next step. ".repeat(5) }],
    api: physical.api,
    provider: physical.provider,
    model: physical.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "stop",
    timestamp: 3,
  });

  const notices = [];
  const widgets = [];
  const authModels = [];
  const ctx = {
    mode: "rpc",
    hasUI: true,
    model: virtual,
    modelRegistry: {
      find: (provider, id) => registry.find(provider, id),
      getAvailable: () => registry.getAvailable(),
      getApiKeyAndHeaders: async (model) => {
        authModels.push(model);
        return {
          ok: true,
          apiKey: "test-key",
          headers: { "x-recap-test": "yes" },
          env: { RECAP_TEST: "ambient" },
          baseUrl: physical.baseUrl,
        };
      },
    },
    sessionManager: manager,
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      setStatus() {},
      setWidget: (_key, content) => widgets.push(content),
    },
  };
  return { commands, handlers, ctx, notices, widgets, authModels, virtual, flags };
}

test("virtual selection skips manual and automatic recaps without an override", async () => {
  const { faux, registry, physical, virtual, unregister } = await makeModels("skip");
  try {
    assert.equal(virtual.api, "pi-virtual", "fixture is a real Pi 0.99 virtual catalog model");
    const harness = makeHarness(physical, virtual, registry);
    await harness.commands.get("recap").handler("", harness.ctx);
    assert.equal(harness.notices.length, 1);
    assert.match(harness.notices[0].message, /--recap-model "provider\/model-id"/);
    assert.equal(harness.notices[0].level, "warning");
    assert.deepEqual(harness.authModels, [], "do not authenticate the unroutable virtual model");
    assert.deepEqual(harness.widgets, []);

    harness.handlers.get("session_start")({ reason: "resume" }, harness.ctx);
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(harness.notices.length, 1, "automatic recaps must not spam notices");
    assert.equal(faux.state.callCount, 0, "never dispatch the virtual selection to pi-ai");
    assert.deepEqual(harness.authModels, []);
  } finally {
    unregister();
  }
});

test("a valid physical override completes through the Pi 0.99 faux provider without leaking parent instructions", async () => {
  const { faux, registry, physical, virtual, unregister } = await makeModels("override");
  try {
    const harness = makeHarness(physical, virtual, registry, `${physical.provider}/${physical.id}`, true);
    const requests = [];
    faux.setResponses([
      (context, options, _state, model) => {
        requests.push({ context, options, model });
        return fauxAssistantMessage("The preview is ready. Check mobile layout next.");
      },
    ]);
    await harness.commands.get("recap").handler("", harness.ctx);

    assert.equal(faux.state.callCount, 1);
    assert.equal(requests.length, 1);
    assert.deepEqual(harness.authModels, [physical]);
    assert.equal(requests[0].model.provider, physical.provider);
    assert.equal(requests[0].model.baseUrl, physical.baseUrl);
    assert.equal(requests[0].options.apiKey, "test-key");
    assert.deepEqual(requests[0].options.headers, { "x-recap-test": "yes" });
    assert.deepEqual(requests[0].options.env, { RECAP_TEST: "ambient" });
    assert.equal(requests[0].options.reasoning, undefined);
    assert.equal(requests[0].options.cacheRetention, "none");
    assert.equal(requests[0].options.maxTokens, 256);
    assert.ok(!requests[0].context.systemPrompt);
    assert.equal(requests[0].context.messages[0].role, "user");
    assert.doesNotMatch(JSON.stringify(requests[0].context), /Private parent instructions|private-parent-tool/);
    assert.deepEqual(harness.widgets.at(-1), ["✦ recap", "The preview is ready. Check mobile layout next."]);
    assert.deepEqual(harness.notices, []);
  } finally {
    unregister();
  }
});

test("missing or virtual overrides cannot fall back to a virtual selection", async () => {
  const { faux, registry, physical, virtual, unregister } = await makeModels("invalid");
  try {
    const harness = makeHarness(physical, virtual, registry, undefined, true);
    for (const override of ["missing/not-found", "router/auto"]) {
      harness.flags.set("recap-model", override);
      await harness.commands.get("recap").handler("", harness.ctx);
    }
    assert.equal(harness.notices.length, 2);
    assert.deepEqual(harness.authModels, []);
    assert.equal(faux.state.callCount, 0);
  } finally {
    unregister();
  }
});
