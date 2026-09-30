import assert from "node:assert/strict";
import test from "node:test";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import sessionRecap from "../index.ts";

test("the blur threshold cannot bypass the settlement debounce", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  t.after(() => {
    if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
    else delete process.stdin.isTTY;
    if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
    else delete process.stdout.isTTY;
  });

  let focusInput;
  t.mock.method(process.stdin, "on", (name, listener) => {
    if (name === "data") focusInput = listener;
    return process.stdin;
  });
  t.mock.method(process.stdin, "off", () => process.stdin);
  t.mock.method(process.stdout, "write", () => true);

  const calls = [];
  registerApiProvider({
    api: "recap-away-debounce-test",
    stream: () => {
      throw new Error("unexpected stream path");
    },
    streamSimple: (_model, context) => {
      calls.push(context);
      return {
        result: async () => ({ role: "assistant", content: [{ type: "text", text: "Recap after settlement." }] }),
      };
    },
  });

  const branch = [
    {
      type: "message",
      id: "user",
      parentId: null,
      timestamp: "2026-09-30T00:00:00Z",
      message: { role: "user", content: "Investigate the failure.", timestamp: 1 },
    },
    {
      type: "message",
      id: "answer",
      parentId: "user",
      timestamp: "2026-09-30T00:00:01Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "I investigated the failure, identified the affected path, and prepared the corrective change with a focused regression test for the existing behavior. The test covers the terminal blur threshold, the final settlement event, a queued continuation, and the provider request timing so the user sees a recap only after the debounce.",
          },
        ],
        timestamp: 2,
      },
    },
  ];
  const widgets = [];
  const events = new Map();
  const flags = new Map();
  sessionRecap({
    on: (name, handler) => events.set(name, handler),
    registerCommand() {},
    registerFlag: (name, options) => flags.set(name, options.default),
    getFlag: (name) => flags.get(name),
  });
  flags.set("recap-away-seconds", "5");
  flags.set("recap-allow-raw-history", true);
  flags.set("recap-model", "test/test");
  const ctx = {
    mode: "tui",
    hasUI: true,
    model: {
      id: "test",
      name: "Test",
      api: "recap-away-debounce-test",
      provider: "test",
      baseUrl: "http://localhost.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4096,
    },
    modelRegistry: {
      find: (provider, id) => (provider === "test" && id === "test" ? ctx.model : undefined),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
    sessionManager: { getBranch: () => branch, buildSessionProjection: () => buildSessionProjection(branch) },
    ui: {
      setStatus() {},
      setWidget(_key, content) {
        if (Array.isArray(content)) widgets.push(content);
      },
    },
  };

  await events.get("session_start")({ reason: "new" }, ctx);
  assert.equal(typeof focusInput, "function");
  focusInput(Buffer.from("\x1b[O"));
  await events.get("agent_start")({}, ctx);
  t.mock.timers.tick(4_000);
  await events.get("agent_settled")({}, ctx);
  t.mock.timers.tick(1_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0, "the old blur timer must not dispatch during settlement debounce");

  t.mock.timers.tick(2_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.deepEqual(widgets, [["✦ recap", "Recap after settlement."]]);
  await events.get("session_shutdown")({}, ctx);
});
