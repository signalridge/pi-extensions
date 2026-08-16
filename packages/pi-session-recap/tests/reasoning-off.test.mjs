// Recaps must never spend reasoning tokens. `completeSimple` disables thinking
// for every API by omitting `reasoning`, except openai-codex-responses, which
// then inherits the server-side default — that api must get an explicit
// `reasoningEffort: "none"` through `complete`.
import assert from "node:assert/strict";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import sessionRecap from "../index.ts";

const calls = [];

function stubStream(kind, api) {
  return (_model, _context, options) => {
    calls.push({ kind, api, options });
    return {
      result: async () => ({
        role: "assistant",
        content: [{ type: "text", text: "Recap text." }],
      }),
    };
  };
}

for (const api of ["openai-codex-responses", "anthropic-messages"]) {
  registerApiProvider({
    api,
    stream: stubStream("stream", api),
    streamSimple: stubStream("streamSimple", api),
  });
}

function makePi() {
  const commands = new Map();
  const flags = new Map();
  return {
    commands,
    on() {},
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
  { type: "message", message: { role: "user", content: "Please fix the bridge integration." } },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "I inspected the integration and prepared the next change." }],
    },
  },
];

const auth = {
  apiKey: undefined,
  headers: { "x-test-header": "present" },
  env: { TEST_AUTH_MODE: "ambient" },
};

function makeCtx(model) {
  return {
    mode: "tui",
    hasUI: true,
    model,
    modelRegistry: {
      find: () => undefined,
      getAvailable: () => [],
      getApiKeyAndHeaders: async () => ({ ok: true, ...auth }),
    },
    sessionManager: {
      getBranch: () => branch,
      buildContextEntries: () => branch,
    },
    ui: {
      setStatus() {},
      setWidget(_key, content) {
        if (typeof content === "function") content({ mode: "regular", children: [] }, this.theme);
      },
      theme: { fg: (_n, t) => t, bold: (t) => t },
    },
  };
}

function makeModel(api, id) {
  return {
    id,
    name: id,
    api,
    provider: api === "anthropic-messages" ? "anthropic" : "openai-codex",
    baseUrl: "http://localhost.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4096,
  };
}

const pi = makePi();
sessionRecap(pi);
const recap = pi.commands.get("recap").handler;

await recap("", makeCtx(makeModel("openai-codex-responses", "gpt-5.6-luna")));
await recap("", makeCtx(makeModel("anthropic-messages", "claude-haiku-4-5")));

const codex = calls.find((call) => call.api === "openai-codex-responses");
const nonCodex = calls.find((call) => call.api === "anthropic-messages");

assert.ok(codex, "codex recap should have issued a request");
assert.equal(codex.kind, "stream", "codex recaps must use complete(), not completeSimple()");
assert.equal(codex.options.reasoningEffort, "none", "codex recaps must disable reasoning explicitly");

assert.ok(nonCodex, "non-Codex recap should have issued a request");
assert.equal(nonCodex.kind, "streamSimple", "other apis keep using completeSimple()");
assert.equal(nonCodex.options.reasoning, undefined, "non-Codex recaps omit reasoning");
assert.equal(nonCodex.options.reasoningEffort, undefined, "completeSimple receives no reasoningEffort");

for (const call of [codex, nonCodex]) {
  assert.equal(call.options.apiKey, undefined, "ambient auth may omit an API key");
  assert.deepEqual(call.options.headers, auth.headers);
  assert.deepEqual(call.options.env, auth.env);
  assert.equal(call.options.cacheRetention, "none");
  assert.equal(call.options.maxTokens, 256);
  assert.ok(call.options.signal instanceof AbortSignal);
}

console.log("reasoning-off test passed");
