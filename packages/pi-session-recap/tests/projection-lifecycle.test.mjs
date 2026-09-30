import assert from "node:assert/strict";
import test from "node:test";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import sessionRecap, { buildRecapContext, hasMeaningfulActivity } from "../index.ts";

function makePi() {
  const events = new Map();
  const commands = new Map();
  const flags = new Map();
  const pi = {
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerFlag: (name, options) => flags.set(name, options.default),
    getFlag: (name) => flags.get(name),
  };
  sessionRecap(pi);
  flags.set("recap-idle-seconds", "5");
  flags.set("recap-allow-raw-history", true);
  flags.set("recap-model", "recap-test/recap-test");
  return { events, commands };
}

function makeContext(branch, api, widgets) {
  const ctx = {
    mode: "rpc",
    hasUI: true,
    model: {
      id: "recap-test",
      name: "Recap test",
      api,
      provider: "recap-test",
      baseUrl: "http://localhost.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4096,
    },
    modelRegistry: {
      find: (provider, id) => (provider === "recap-test" && id === "recap-test" ? ctx.model : undefined),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
    sessionManager: {
      getBranch: () => branch,
      buildSessionProjection: () => buildSessionProjection(branch),
    },
    ui: {
      setStatus() {},
      setWidget(_key, content) {
        if (Array.isArray(content)) widgets.push(content);
      },
    },
  };
  return ctx;
}

function meaningfulAssistant(id, parentId) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            "I completed the requested investigation and traced the failure through the active code path. " +
            "The next step is to update the implementation, validate the changed behavior with focused tests, " +
            "and check the full result before reporting back to the user.",
        },
      ],
      timestamp: Date.now(),
    },
  };
}

test("idle fallback waits for settlement through intermediate retry and uses the final projection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  registerApiProvider({
    api: "recap-settlement-test",
    stream: () => {
      throw new Error("unexpected stream path");
    },
    streamSimple: (_model, context) => {
      calls.push(context);
      return { result: async () => ({ role: "assistant", content: [{ type: "text", text: "Current recap." }] }) };
    },
  });

  const branch = [
    {
      type: "message",
      id: "initial",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Obsolete secret request", timestamp: 1 },
    },
    meaningfulAssistant("first-attempt", "initial"),
  ];
  const widgets = [];
  const ctx = makeContext(branch, "recap-settlement-test", widgets);
  const { events } = makePi();

  await events.get("agent_start")({}, ctx);
  await events.get("turn_end")?.({}, ctx);
  await events.get("agent_end")?.({ willRetry: true }, ctx);
  t.mock.timers.tick(6_000);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.length, 0, "retrying agent_end must not start the idle fallback");

  branch.push(
    {
      type: "context_edit",
      id: "edit-task",
      parentId: "first-attempt",
      timestamp: new Date().toISOString(),
      targetId: "initial",
      replacement: { content: "Corrected task after retry" },
    },
    {
      type: "context_edit",
      id: "edit-attempt",
      parentId: "edit-task",
      timestamp: new Date().toISOString(),
      targetId: "first-attempt",
      replacement: null,
    },
    meaningfulAssistant("final-attempt", "edit-attempt"),
  );
  await events.get("agent_settled")({}, ctx);
  t.mock.timers.tick(5_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(calls[0]), /Obsolete secret request/);
  assert.match(JSON.stringify(calls[0]), /Corrected task after retry/);
  assert.equal(widgets.length, 1);
});

test("automatic settlement skips incomplete final turns but keeps earlier completed work", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  registerApiProvider({
    api: "recap-incomplete-settlement-test",
    stream: () => {
      throw new Error("unexpected stream path");
    },
    streamSimple: (_model, context) => {
      calls.push(context);
      return { result: async () => ({ role: "assistant", content: [{ type: "text", text: "Completed recap." }] }) };
    },
  });

  const initial = {
    type: "message",
    id: "initial",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "Fix the build.", timestamp: 1 },
  };
  for (const stopReason of ["aborted", "error"]) {
    const incomplete = meaningfulAssistant("final", "initial");
    incomplete.message.stopReason = stopReason;
    incomplete.message.content.push({ type: "toolCall", id: "partial-call", name: "read", arguments: {} });
    const branch = [initial, incomplete];
    const { events } = makePi();
    const widgets = [];
    const ctx = makeContext(branch, "recap-incomplete-settlement-test", widgets);
    await events.get("agent_start")({}, ctx);
    await events.get("agent_settled")({}, ctx);
    t.mock.timers.tick(5_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 0, `no automatic recap after ${stopReason}`);
    assert.equal(widgets.length, 0);
  }

  const branch = [initial, meaningfulAssistant("completed", "initial")];
  const incomplete = meaningfulAssistant("final", "completed");
  incomplete.message.stopReason = "aborted";
  branch.push(incomplete);
  const widgets = [];
  const ctx = makeContext(branch, "recap-incomplete-settlement-test", widgets);
  const { events } = makePi();
  await events.get("agent_start")({}, ctx);
  await events.get("agent_settled")({}, ctx);
  t.mock.timers.tick(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, "earlier completed work still triggers a recap");
  assert.equal(widgets.length, 1);
});

test("resume drafts from a summary-only projection without restoring omitted history", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  registerApiProvider({
    api: "recap-summary-resume-test",
    stream: () => {
      throw new Error("unexpected stream path");
    },
    streamSimple: (_model, context) => {
      calls.push(context);
      return { result: async () => ({ role: "assistant", content: [{ type: "text", text: "Resume recap." }] }) };
    },
  });

  const timestamp = new Date().toISOString();
  const branch = [
    {
      type: "message",
      id: "initial",
      parentId: null,
      timestamp,
      message: { role: "user", content: "Omitted private request" },
    },
    meaningfulAssistant("prior-work", "initial"),
    {
      type: "compaction",
      id: "checkpoint",
      parentId: "prior-work",
      timestamp,
      summary: "Investigated the failure and identified the next fix.",
      firstKeptEntryId: "checkpoint",
      tokensBefore: 100,
    },
    {
      type: "context_edit",
      id: "omit-task",
      parentId: "checkpoint",
      timestamp,
      targetId: "initial",
      replacement: null,
    },
  ];
  const widgets = [];
  const ctx = makeContext(branch, "recap-summary-resume-test", widgets);
  const { events } = makePi();

  events.get("session_start")({ reason: "resume" }, ctx);
  t.mock.timers.tick(300);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.match(JSON.stringify(calls[0]), /Investigated the failure and identified the next fix/);
  assert.doesNotMatch(JSON.stringify(calls[0]), /Omitted private request|completed the requested investigation/);
  assert.equal(widgets.length, 1);
});

test("a context edit arriving during generation invalidates a projected recap draft", async () => {
  let releaseResponse;
  let announceStart;
  const started = new Promise((resolve) => {
    announceStart = resolve;
  });
  const response = new Promise((resolve) => {
    releaseResponse = resolve;
  });
  registerApiProvider({
    api: "recap-projection-validation-test",
    stream: () => {
      throw new Error("unexpected stream path");
    },
    streamSimple: () => ({
      result: async () => {
        announceStart();
        await response;
        return { role: "assistant", content: [{ type: "text", text: "Stale recap." }] };
      },
    }),
  });

  const branch = [
    {
      type: "message",
      id: "initial",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Original task", timestamp: 1 },
    },
  ];
  const widgets = [];
  const ctx = makeContext(branch, "recap-projection-validation-test", widgets);
  const { commands } = makePi();
  const pending = commands.get("recap").handler("", ctx);
  await started;
  branch.push({
    type: "context_edit",
    id: "edit-task",
    parentId: "initial",
    timestamp: new Date().toISOString(),
    targetId: "initial",
    replacement: { content: "Replacement task" },
  });
  releaseResponse();
  await pending;

  assert.equal(widgets.length, 0, "a stale draft must not be shown after the model-visible context changes");
});

test("automatic draft rechecks activity after an out-of-window context edit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let releaseResponse;
  let announceStart;
  const started = new Promise((resolve) => {
    announceStart = resolve;
  });
  const response = new Promise((resolve) => {
    releaseResponse = resolve;
  });
  registerApiProvider({
    api: "recap-activity-validation-test",
    stream: () => {
      throw new Error("unexpected stream path");
    },
    streamSimple: () => ({
      result: async () => {
        announceStart();
        await response;
        return { role: "assistant", content: [{ type: "text", text: "Stale recap." }] };
      },
    }),
  });

  const branch = [
    {
      type: "message",
      id: "initial",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Current task", timestamp: 1 },
    },
    {
      type: "message",
      id: "tool-work",
      parentId: "initial",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
        timestamp: 2,
      },
    },
  ];
  let parentId = "tool-work";
  for (let index = 0; index < 30; index++) {
    const id = `short-${index}`;
    branch.push({
      type: "message",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: index === 0 ? "" : "word" }],
        timestamp: index + 3,
      },
    });
    parentId = id;
  }
  const widgets = [];
  const ctx = makeContext(branch, "recap-activity-validation-test", widgets);
  const { events } = makePi();
  await events.get("session_start")({ reason: "startup" }, ctx);
  await events.get("agent_settled")({}, ctx);
  t.mock.timers.tick(5_000);
  await started;

  const before = buildRecapContext(buildSessionProjection(branch).entries, branch);
  assert.equal(hasMeaningfulActivity(buildSessionProjection(branch).entries), true);
  branch.push({
    type: "context_edit",
    id: "omit-tool-work",
    parentId,
    timestamp: new Date().toISOString(),
    targetId: "tool-work",
    replacement: null,
  });
  assert.equal(hasMeaningfulActivity(buildSessionProjection(branch).entries), false);
  assert.deepEqual(buildRecapContext(buildSessionProjection(branch).entries, branch), before);
  releaseResponse();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(widgets.length, 0, "activity below the trigger threshold invalidates the pending draft");
});

test("a superseded session's late turn cannot abort the current recap", async () => {
  let releaseResponse;
  let announceStart;
  const started = new Promise((resolve) => {
    announceStart = resolve;
  });
  const response = new Promise((resolve) => {
    releaseResponse = resolve;
  });
  registerApiProvider({
    api: "recap-session-turn-validation-test",
    stream: () => {
      throw new Error("unexpected stream path");
    },
    streamSimple: () => ({
      result: async () => {
        announceStart();
        await response;
        return { role: "assistant", content: [{ type: "text", text: "Current recap." }] };
      },
    }),
  });
  const oldContext = makeContext([], "recap-session-turn-validation-test", []);
  const widgets = [];
  const currentContext = makeContext(
    [
      {
        type: "message",
        id: "current",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "Current task", timestamp: 1 },
      },
    ],
    "recap-session-turn-validation-test",
    widgets,
  );
  const { events, commands } = makePi();
  await events.get("session_start")({ reason: "startup" }, oldContext);
  await events.get("session_start")({ reason: "startup" }, currentContext);
  const pending = commands.get("recap").handler("", currentContext);
  await started;
  await events.get("turn_start")({}, oldContext);
  releaseResponse();
  await pending;
  assert.equal(widgets.length, 1);
});
