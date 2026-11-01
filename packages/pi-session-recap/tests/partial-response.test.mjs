// pi-ai resolves instead of throwing when a stream is cut short, so a recap
// must accept only a cleanly stopped response. Session usage must not size the
// recap request either: it describes the whole session, not the recap.
import assert from "node:assert/strict";
import test from "node:test";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import sessionRecap, { buildRecapContext } from "../index.ts";

let nextResponse;
registerApiProvider({
  api: "anthropic-messages",
  stream: () => ({ result: async () => nextResponse }),
  streamSimple: () => ({ result: async () => nextResponse }),
});

const branch = [
  { type: "message", message: { role: "user", content: "Please fix the bridge integration." } },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "I inspected the integration and prepared the next change." }],
    },
  },
];

const model = {
  id: "claude-haiku-4-5",
  name: "claude-haiku-4-5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.example",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4096,
};

function harness() {
  const commands = new Map();
  const flags = new Map();
  const pi = {
    on() {},
    registerCommand: (name, command) => commands.set(name, command),
    registerFlag: (name, options) => flags.set(name, options.default),
    getFlag: (name) => flags.get(name),
  };
  sessionRecap(pi);
  flags.set("recap-allow-raw-history", true);
  flags.set("recap-model", "anthropic/claude-haiku-4-5");
  const widgets = [];
  const notifications = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    model,
    modelRegistry: {
      find: (provider, id) => (provider === model.provider && id === model.id ? model : undefined),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {}, baseUrl: model.baseUrl }),
    },
    sessionManager: { getBranch: () => branch, buildContextEntries: () => branch },
    ui: {
      setStatus() {},
      setWidget(_key, content) {
        if (Array.isArray(content)) widgets.push(content);
      },
      notify: (message, level) => notifications.push({ message, level }),
      theme: { fg: (_name, text) => text, bold: (text) => text },
    },
  };
  return { recap: () => commands.get("recap").handler("", ctx), widgets, notifications };
}

function response(stopReason, extra = {}) {
  return { role: "assistant", stopReason, content: [{ type: "text", text: "The" }], ...extra };
}

test("a clean stop is rendered as the recap", async () => {
  const { recap, widgets } = harness();
  nextResponse = { ...response("stop"), content: [{ type: "text", text: "Fixing the bridge. Next: rerun it." }] };
  await recap();
  assert.deepEqual(widgets, [["✦ recap", "Fixing the bridge. Next: rerun it."]]);
});

for (const stopReason of ["length", "aborted"]) {
  test(`a ${stopReason} response is dropped quietly instead of rendering its fragment`, async () => {
    const { recap, widgets, notifications } = harness();
    nextResponse = response(stopReason);
    await recap();
    assert.deepEqual(widgets, []);
    assert.deepEqual(notifications, []);
  });
}

test("a stream failure is reported through the UI, not rendered or written to the console", async (t) => {
  const consoleError = t.mock.method(console, "error", () => {});
  const { recap, widgets, notifications } = harness();
  nextResponse = response("error", { errorMessage: "overloaded" });
  await recap();
  assert.deepEqual(widgets, []);
  assert.deepEqual(notifications, [{ message: "session-recap: overloaded", level: "error" }]);
  assert.equal(consoleError.mock.callCount(), 0);
});

test("assistant copies carry no session usage into the recap request", () => {
  const usage = { input: 900_000, output: 4_000, cacheRead: 800_000, cacheWrite: 2_000, totalTokens: 1_706_000 };
  const entries = [
    {
      sourceEntry: { type: "message", id: "a" },
      messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }], usage, timestamp: 1 }],
    },
  ];
  const assistant = buildRecapContext(entries, []).messages.find((message) => message.role === "assistant");
  assert.ok(assistant);
  assert.deepEqual(
    { ...assistant.usage },
    { ...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  );
});
