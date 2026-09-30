// Recaps must never spend reasoning tokens. `completeSimple` disables thinking
// for every API by omitting `reasoning`, except openai-codex-responses, which
// then inherits the server-side default — that api must get an explicit
// `reasoningEffort: "none"` through `complete`.
import assert from "node:assert/strict";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import sessionRecap from "../index.ts";

const calls = [];

function stubStream(kind, api) {
  return (model, _context, options) => {
    calls.push({ kind, api, model, options });
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
    flags,
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
  baseUrl: "https://enterprise.example",
};

function makeCtx(model) {
  return {
    mode: "tui",
    hasUI: true,
    model,
    modelRegistry: {
      find: (provider, id) => (provider === model.provider && id === model.id ? model : undefined),
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
    baseUrl: auth.baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4096,
  };
}

const pi = makePi();
sessionRecap(pi);
pi.flags.set("recap-allow-raw-history", true);
const recap = pi.commands.get("recap").handler;

pi.flags.set("recap-model", "openai-codex/gpt-5.6-luna");
await recap("", makeCtx(makeModel("openai-codex-responses", "gpt-5.6-luna")));
pi.flags.set("recap-model", "anthropic/claude-haiku-4-5");
await recap("", makeCtx(makeModel("anthropic-messages", "claude-haiku-4-5")));

const physicalCodex = makeModel("openai-codex-responses", "gpt-5.6-luna");
const virtualPi = makePi();
sessionRecap(virtualPi);
virtualPi.flags.set("recap-allow-raw-history", true);
virtualPi.flags.set("recap-model", "openai-codex/gpt-5.6-luna");
const virtualCtx = makeCtx({ ...physicalCodex, api: "pi-virtual", provider: "router", id: "auto" });
virtualCtx.modelRegistry.find = (provider, id) =>
  provider === physicalCodex.provider && id === physicalCodex.id ? physicalCodex : undefined;
await virtualPi.commands.get("recap").handler("", virtualCtx);

const codexCalls = calls.filter((call) => call.api === "openai-codex-responses");
assert.equal(codexCalls.length, 2, "a physical Codex override from a virtual selection must issue a recap");
assert.equal(codexCalls[1].kind, "stream");
assert.equal(codexCalls[1].options.reasoningEffort, "none");
const codex = codexCalls[0];
const nonCodex = calls.find((call) => call.api === "anthropic-messages");

assert.ok(codex, "codex recap should have issued a request");
assert.equal(codex.kind, "stream", "codex recaps must use complete(), not completeSimple()");
assert.equal(codex.model.baseUrl, auth.baseUrl, "codex recaps must retain their named endpoint");
assert.equal(codex.options.reasoningEffort, "none", "codex recaps must disable reasoning explicitly");

assert.ok(nonCodex, "non-Codex recap should have issued a request");
assert.equal(nonCodex.kind, "streamSimple", "other apis keep using completeSimple()");
assert.equal(nonCodex.model.baseUrl, auth.baseUrl, "simple recaps must retain their named endpoint");
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
