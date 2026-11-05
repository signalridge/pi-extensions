import assert from "node:assert/strict";
import test from "node:test";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import sessionRecap, { showRecap } from "../index.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(t, mode = "tui") {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  registerApiProvider({
    api: "recap-terminal-input-test",
    stream: () => {
      throw new Error("unexpected stream");
    },
    streamSimple: () => {
      calls.push("provider");
      return {
        result: async () => ({
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Completed work." }],
        }),
      };
    },
  });
  const events = new Map();
  const commands = new Map();
  const flags = new Map();
  sessionRecap({
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerFlag: (name, options) => flags.set(name, options.default),
    getFlag: (name) => flags.get(name),
  });
  flags.set("recap-disable-focus", true);
  flags.set("recap-idle-seconds", "5");
  flags.set("recap-model", "test/test");
  flags.set("recap-allow-raw-history", true);
  const branch = [
    { type: "message", message: { role: "user", content: "Fix the failure." } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "I investigated the failure and prepared a corrective change with regression coverage. The completed work includes validating the affected behavior and checking the resulting integration without sending session history to any destination other than the explicitly configured physical model.",
          },
        ],
      },
    },
  ];
  const model = {
    id: "test",
    name: "Test",
    provider: "test",
    api: "recap-terminal-input-test",
    baseUrl: "http://localhost.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4096,
  };
  const widgets = new Map();
  let input;
  let subscriptions = 0;
  let unsubscribes = 0;
  const ctx = {
    mode,
    hasUI: true,
    model,
    modelRegistry: {
      find: () => model,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
    sessionManager: { getSessionId: () => "recap-test", getBranch: () => branch, buildContextEntries: () => branch },
    ui: {
      onTerminalInput(handler) {
        subscriptions++;
        input = handler;
        return () => {
          unsubscribes++;
        };
      },
      setStatus() {},
      setWidget(key, content) {
        if (content === undefined) widgets.delete(key);
        else widgets.set(key, content);
      },
    },
  };
  const emit = (name, event = {}) => events.get(name)?.(event, ctx);
  t.after(() => emit("session_shutdown"));
  return {
    calls,
    flags,
    commands,
    widgets,
    ctx,
    emit,
    type: (data) => input(data),
    get subscriptions() {
      return subscriptions;
    },
    get unsubscribes() {
      return unsubscribes;
    },
  };
}

for (const input of ["x", "\x1b[A", "\x1b[200~pasted text\x1b[201~"]) {
  test(`terminal input ${JSON.stringify(input)} cancels idle without submitting and clears the widget`, async (t) => {
    const h = harness(t);
    await h.emit("session_start", { reason: "new" });
    showRecap(h.ctx, "Previously displayed recap.");
    assert.equal(h.widgets.size, 1);
    await h.emit("agent_settled");
    t.mock.timers.tick(4_000);
    assert.equal(h.type(input), undefined, "Pi must still receive the input");
    assert.equal(h.widgets.size, 0);
    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(h.calls.length, 0);
  });
}

test("focus reports and terminal replies do not cancel a pending idle recap", async (t) => {
  const h = harness(t);
  await h.emit("session_start", { reason: "new" });
  await h.emit("agent_settled");
  for (const data of [
    "\x1b[I",
    "\x1b[O",
    "\x1b[?1;2c",
    "\x1b[12;34R",
    "\x1b[?1u",
    "\x1b]10;rgb:ffff/ffff/ffff\x07",
    "\x1bP1+r544e=787465726d\x1b\\",
  ]) {
    assert.equal(h.type(data), undefined);
  }
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.widgets.size, 1);
});

for (const reason of ["resume", "fork"]) {
  test(`typing before the ${reason} deadline cancels recap over an unsubmitted draft`, async (t) => {
    const h = harness(t);
    await h.emit("session_start", { reason });
    showRecap(h.ctx, "Previously displayed recap.");
    assert.equal(h.widgets.size, 1);
    t.mock.timers.tick(200);
    assert.equal(h.type("continuing my draft"), undefined);
    assert.equal(h.widgets.size, 0);
    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(h.calls.length, 0, "meaningful resumed history must not dispatch after typing");
    assert.equal(h.widgets.size, 0, "recap must not reappear over the draft");
  });

  test(`terminal reports before the ${reason} deadline preserve the automatic recap`, async (t) => {
    const h = harness(t);
    await h.emit("session_start", { reason });
    t.mock.timers.tick(200);
    for (const data of ["\x1b[I", "\x1b[O", "\x1b[12;34R"]) {
      assert.equal(h.type(data), undefined);
    }
    t.mock.timers.tick(100);
    await flush();
    assert.equal(h.calls.length, 1, "fixture history is sufficient to dispatch a resume recap");
    assert.equal(h.widgets.size, 1);
  });
}

test("typing cancels an active draft waiting on auth", async (t) => {
  const h = harness(t);
  let release;
  h.ctx.modelRegistry.getApiKeyAndHeaders = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  await h.emit("session_start", { reason: "new" });
  await h.emit("agent_settled");
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(typeof release, "function");
  h.type("x");
  release({ ok: true, apiKey: "test-key" });
  await flush();
  assert.equal(h.calls.length, 0);
  assert.equal(h.widgets.size, 0);
});

function focusReporting(t, h) {
  h.flags.set("recap-disable-focus", false);
  h.flags.set("recap-away-seconds", "5");
  for (const stream of [process.stdin, process.stdout]) {
    const descriptor = Object.getOwnPropertyDescriptor(stream, "isTTY");
    Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
    t.after(() => {
      if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
      else delete stream.isTTY;
    });
  }
  let focusInput;
  t.mock.method(process.stdin, "on", (name, listener) => {
    if (name === "data") focusInput = listener;
    return process.stdin;
  });
  t.mock.method(process.stdin, "off", () => process.stdin);
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, "write", (...args) => {
    if (args[0] === "\x1b[?1004h" || args[0] === "\x1b[?1004l") return true;
    return write(...args);
  });
  return (data) => {
    focusInput(Buffer.from(data));
    assert.equal(h.type(data), undefined);
  };
}

for (const duringSettlement of [false, true]) {
  test(`typing clears the ${duringSettlement ? "post-settlement" : "away"} timer`, async (t) => {
    const h = harness(t);
    const focus = focusReporting(t, h);
    await h.emit("session_start", { reason: "new" });
    focus("\x1b[O");
    if (duringSettlement) {
      await h.emit("agent_start");
      t.mock.timers.tick(5_000);
      await h.emit("agent_settled");
    }
    h.type("x");
    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(h.calls.length, 0);
  });
}

test("refocus leaves an existing away draft intact", async (t) => {
  const h = harness(t);
  const focus = focusReporting(t, h);
  let release;
  h.ctx.modelRegistry.getApiKeyAndHeaders = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  await h.emit("session_start", { reason: "new" });
  focus("\x1b[O");
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(typeof release, "function");
  focus("\x1b[I");
  release({ ok: true, apiKey: "test-key" });
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.widgets.size, 1);
});

test("subscriptions are TUI-only and clean up once per session", async (t) => {
  const h = harness(t);
  await h.emit("session_start", { reason: "new" });
  await h.emit("session_start", { reason: "new" });
  assert.equal(h.subscriptions, 2);
  assert.equal(h.unsubscribes, 1);
  await h.emit("session_shutdown");
  await h.emit("session_shutdown");
  assert.equal(h.unsubscribes, 2);
  h.ctx.mode = "rpc";
  await h.emit("session_start", { reason: "new" });
  assert.equal(h.subscriptions, 2);
});

test("terminal activity does not alter raw-history consent", async (t) => {
  const h = harness(t);
  h.flags.set("recap-allow-raw-history", false);
  await h.emit("session_start", { reason: "new" });
  h.type("x");
  await h.emit("agent_settled");
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(h.flags.get("recap-allow-raw-history"), false);
  assert.equal(h.calls.length, 0);
});
