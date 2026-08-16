import assert from "node:assert/strict";
import test from "node:test";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import sessionRecap from "../index.ts";

registerApiProvider({
  api: "anthropic-messages",
  stream: () => ({
    result: async () => ({ role: "assistant", content: [{ type: "text", text: "RPC recap text." }] }),
  }),
  streamSimple: () => ({
    result: async () => ({ role: "assistant", content: [{ type: "text", text: "RPC recap text." }] }),
  }),
});

function makePi() {
  const commands = new Map();
  const flags = new Map();
  const handlers = new Map();
  return {
    commands,
    flags,
    handlers,
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerFlag(name, options) {
      flags.set(name, options.default);
    },
    getFlag(name) {
      return flags.get(name);
    },
  };
}

const branch = [
  { type: "message", message: { role: "user", content: "Please fix the RPC recap integration." } },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "I inspected the integration and prepared the next concrete change. The automatic recap now has enough completed work to summarize the active session without relying on terminal focus events or terminal APIs.",
        },
      ],
    },
  },
];

const calls = [];
const ui = {
  get theme() {
    throw new Error("RPC must not inspect the TUI theme");
  },
  get custom() {
    throw new Error("RPC must not inspect custom components");
  },
  setStatus(key, text) {
    calls.push({ method: "setStatus", key, text });
  },
  setWidget(key, content, options) {
    if (content !== undefined) assert.ok(Array.isArray(content), "RPC widgets must use string arrays");
    calls.push({ method: "setWidget", key, content, options });
  },
};

const ctx = {
  mode: "rpc",
  hasUI: true,
  model: {
    id: "claude-haiku-4-5",
    name: "Claude Haiku",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "http://localhost.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4096,
  },
  modelRegistry: {
    find: () => undefined,
    getAvailable: () => [],
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
  },
  sessionManager: {
    getBranch: () => branch,
    buildContextEntries: () => branch,
  },
  ui,
};

const pi = makePi();
sessionRecap(pi);
await pi.commands.get("recap").handler("", ctx);

assert.deepEqual(
  calls.map(({ method }) => method),
  ["setStatus", "setWidget", "setStatus"],
  "RPC recap should use only status and string-array widget calls",
);
assert.equal(calls[0].text, "✦ drafting recap…");
assert.deepEqual(calls[1].content, ["✦ recap", "RPC recap text."]);
assert.equal(calls[1].options.placement, "aboveEditor");
assert.equal(calls[2].text, undefined);

console.log("RPC UI test passed");

function recapWidgets() {
  return calls.filter((call) => call.method === "setWidget" && Array.isArray(call.content));
}

async function flushRecap() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

test("RPC resume and fork sessions automatically show recaps", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  for (const reason of ["resume", "fork"]) {
    calls.length = 0;
    const handler = pi.handlers.get("session_start");
    assert.equal(typeof handler, "function");
    await handler({ reason }, ctx);

    t.mock.timers.tick(299);
    await flushRecap();
    assert.equal(recapWidgets().length, 0);

    t.mock.timers.tick(1);
    await flushRecap();
    assert.deepEqual(
      recapWidgets().map(({ content }) => content),
      [["✦ recap", "RPC recap text."]],
    );
  }
});

test("RPC turn_end automatically shows an idle recap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  pi.flags.set("recap-idle-seconds", "5");
  calls.length = 0;

  const sessionStart = pi.handlers.get("session_start");
  const turnEnd = pi.handlers.get("turn_end");
  assert.equal(typeof sessionStart, "function");
  assert.equal(typeof turnEnd, "function");
  await sessionStart({ reason: "startup" }, ctx);
  calls.length = 0;
  await turnEnd({}, ctx);

  t.mock.timers.tick(4999);
  await flushRecap();
  assert.equal(recapWidgets().length, 0);

  t.mock.timers.tick(1);
  await flushRecap();
  assert.deepEqual(
    recapWidgets().map(({ content }) => content),
    [["✦ recap", "RPC recap text."]],
  );
});
