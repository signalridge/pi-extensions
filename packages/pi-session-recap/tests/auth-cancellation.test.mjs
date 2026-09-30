import assert from "node:assert/strict";
import test from "node:test";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import sessionRecap from "../index.ts";

const api = "recap-delayed-auth-cancellation-test";
const providerCalls = [];
registerApiProvider({
  api,
  stream: () => {
    throw new Error("unexpected stream path");
  },
  streamSimple: (_model, context, options) => {
    providerCalls.push({ context, options });
    return { result: async () => ({ role: "assistant", content: [{ type: "text", text: "Current recap." }] }) };
  },
});

function makeHarness() {
  const events = new Map();
  const commands = new Map();
  const flags = new Map();
  sessionRecap({
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerFlag: (name, options) => flags.set(name, options.default),
    getFlag: (name) => flags.get(name),
  });
  flags.set("recap-allow-raw-history", true);
  flags.set("recap-model", "recap-delayed-auth/recap-test");

  let resolveAuth;
  let announceAuth;
  const authStarted = new Promise((resolve) => {
    announceAuth = resolve;
  });
  const authResult = new Promise((resolve) => {
    resolveAuth = resolve;
  });
  const model = {
    id: "recap-test",
    name: "Recap test",
    api,
    provider: "recap-delayed-auth",
    baseUrl: "http://localhost.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4096,
  };
  const modelRegistry = {
    find: (provider, id) => (provider === "recap-delayed-auth" && id === "recap-test" ? model : undefined),
    getApiKeyAndHeaders: () => {
      announceAuth();
      return authResult;
    },
  };
  const widgets = [];
  function makeContext(task) {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: task, timestamp: Date.now() });
    return {
      mode: "rpc",
      hasUI: true,
      model,
      modelRegistry,
      sessionManager,
      ui: {
        setStatus() {},
        setWidget(_key, content) {
          if (Array.isArray(content)) widgets.push(content);
        },
      },
    };
  }
  return {
    events,
    recap: commands.get("recap").handler,
    makeContext,
    authStarted,
    releaseAuth: () => resolveAuth({ ok: true, apiKey: "test-key" }),
    flags,
    widgets,
  };
}

test("input during delayed auth prevents the old recap provider request", async () => {
  providerCalls.length = 0;
  const { events, recap, makeContext, authStarted, releaseAuth, widgets } = makeHarness();
  const ctx = makeContext("Original request");
  await events.get("session_start")({ reason: "startup" }, ctx);

  const pending = recap("", ctx);
  await authStarted;
  await events.get("input")({}, ctx);
  releaseAuth();
  await pending;

  assert.equal(providerCalls.length, 0);
  assert.deepEqual(widgets, []);
});

test("session replacement during delayed auth prevents the old recap provider request", async () => {
  providerCalls.length = 0;
  const { events, recap, makeContext, authStarted, releaseAuth, widgets } = makeHarness();
  const oldCtx = makeContext("Original session request");
  const nextCtx = makeContext("Replacement session request");
  await events.get("session_start")({ reason: "startup" }, oldCtx);

  const pending = recap("", oldCtx);
  await authStarted;
  await events.get("session_shutdown")({ reason: "switch" }, oldCtx);
  await events.get("session_start")({ reason: "switch" }, nextCtx);
  releaseAuth();
  await pending;

  assert.equal(providerCalls.length, 0);
  assert.deepEqual(widgets, []);
});

for (const [change, replacement] of [
  ["omission", null],
  ["replacement", { content: "Revised private request" }],
]) {
  test(`context edit ${change} during delayed auth prevents the old recap provider request`, async () => {
    providerCalls.length = 0;
    const { events, recap, makeContext, authStarted, releaseAuth, widgets } = makeHarness();
    const ctx = makeContext("Original private request");
    await events.get("session_start")({ reason: "startup" }, ctx);

    const pending = recap("", ctx);
    await authStarted;
    const userId = ctx.sessionManager.getBranch()[0].id;
    ctx.sessionManager.appendContextEdit(userId, replacement);
    releaseAuth();
    await pending;

    assert.equal(providerCalls.length, 0);
    assert.deepEqual(widgets, []);
  });
}

for (const [change, mutate] of [
  ["raw-history consent revoked", (_ctx, flags) => flags.set("recap-allow-raw-history", false)],
  ["physical destination changed", (_ctx, flags) => flags.set("recap-model", "another/physical-model")],
  ["active model changed", (ctx) => (ctx.model = { ...ctx.model, id: "switched-model" })],
]) {
  test(`${change} during delayed auth prevents the old recap provider request`, async () => {
    providerCalls.length = 0;
    const { events, recap, makeContext, authStarted, releaseAuth, flags, widgets } = makeHarness();
    const ctx = makeContext("Private session request");
    await events.get("session_start")({ reason: "startup" }, ctx);

    const pending = recap("", ctx);
    await authStarted;
    mutate(ctx, flags);
    releaseAuth();
    await pending;

    assert.equal(providerCalls.length, 0);
    assert.deepEqual(widgets, []);
  });
}

test("recap provider is called after auth when the session is still current", async () => {
  providerCalls.length = 0;
  const { events, recap, makeContext, authStarted, releaseAuth, widgets } = makeHarness();
  const ctx = makeContext("Current session request");
  await events.get("session_start")({ reason: "startup" }, ctx);

  const pending = recap("", ctx);
  await authStarted;
  releaseAuth();
  await pending;

  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].options.signal.aborted, false);
  assert.match(JSON.stringify(providerCalls[0].context), /Current session request/);
  assert.deepEqual(widgets, [["✦ recap", "Current recap."]]);
});
