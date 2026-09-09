import { test } from "bun:test";
import assert from "node:assert/strict";
import { createReporter, normalizeSessionStartSource, sessionRefFromValues, socketEndpointFor } from "../src/index.js";

type Request = Record<string, unknown>;
type Handler = (...args: unknown[]) => void | Promise<void>;

type FakePi = {
  on: (event: string, handler: Handler) => void;
  events: { on: (event: string, handler: (data: unknown) => void) => void };
  emit: (event: string, ...args: unknown[]) => Promise<void>;
};

function fakePi(): FakePi {
  const handlers = new Map<string, Handler>();
  const eventHandlers = new Map<string, (data: unknown) => void>();
  return {
    on(event, handler) {
      handlers.set(event, handler);
    },
    events: {
      on(event, handler) {
        eventHandlers.set(event, handler);
      },
    },
    async emit(event, ...args) {
      await handlers.get(event)?.(...args);
      eventHandlers.get(event)?.(args[0]);
    },
  };
}

function context(mode: "tui" | "rpc" | "print", sessionFile: string | undefined, sessionId: string | undefined) {
  return {
    mode,
    hasUI: true,
    isIdle: () => true,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => sessionId,
    },
  };
}

async function flushRequests(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

test("agent_end stays working through retry and settles only after the full run", async () => {
  const pi = fakePi();
  const requests: Request[] = [];
  createReporter(pi, async (request) => {
    requests.push(request as Request);
  });
  let idle = false;
  const ctx = { ...context("tui", "/tmp/retry.jsonl", "retry"), isIdle: () => idle };
  try {
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await pi.emit("agent_end", {}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      requests.some((r) => (r.params as Request).state === "idle"),
      false,
    );
    await pi.emit("agent_start", {}, ctx);
    idle = true;
    await pi.emit("agent_settled", {}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((requests.at(-1)?.params as Request | undefined)?.state, "idle");
    idle = false;
    await pi.emit("agent_start", {}, ctx);
    idle = true;
    await pi.emit("agent_end", {}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((requests.at(-1)?.params as Request | undefined)?.state, "idle");
  } finally {
    await pi.emit("session_shutdown", { reason: "reload" });
  }
});

test("native UI spans coalesce without titles and do not release bus-owned waits", async () => {
  const pi = fakePi();
  const requests: Request[] = [];
  createReporter(pi, async (request) => {
    requests.push(request as Request);
  });
  const ctx = { ...context("tui", "/tmp/wait.jsonl", "wait"), isIdle: () => false };
  const state = () => (requests.at(-1)?.params as Request | undefined)?.state;
  try {
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await flushRequests();
    await pi.emit("ui_prompt_start", { title: "private title" }, ctx);
    await flushRequests();
    assert.equal(state(), "blocked");
    await pi.emit("herdr:blocked", { active: true, label: "external" });
    await pi.emit("ui_prompt_end", {}, ctx);
    await flushRequests();
    assert.equal(state(), "blocked");
    await pi.emit("ui_prompt_start", {}, ctx);
    await pi.emit("herdr:blocked", { active: false });
    await flushRequests();
    assert.equal(state(), "blocked");
    assert.equal((requests.at(-1)?.params as Request | undefined)?.message, undefined);
    await pi.emit("ui_prompt_end", {}, ctx);
    await flushRequests();
    assert.equal(state(), "working");
    assert.equal(JSON.stringify(requests).includes("title"), false);
    await pi.emit("ui_prompt_start", {}, ctx);
    await flushRequests();
    await pi.emit("session_shutdown", { reason: "reload" });
    const shutdownCount = requests.length;
    await pi.emit("ui_prompt_end", {}, ctx);
    await flushRequests();
    assert.equal(requests.length, shutdownCount);
  } finally {
    await pi.emit("session_shutdown", { reason: "reload" });
  }
});

test("session ownership changes clear unmatched native end debt and manual ownership", async () => {
  const pi = fakePi();
  const requests: Request[] = [];
  createReporter(pi, async (request) => {
    requests.push(request as Request);
  });
  const first = context("tui", "/tmp/first.jsonl", "first");
  const second = context("tui", "/tmp/second.jsonl", "second");
  try {
    await pi.emit("session_start", { reason: "startup" }, first);
    await pi.emit("ui_prompt_end", {}, first);
    await pi.emit("herdr:blocked", { active: true });
    await pi.emit("session_start", { reason: "resume" }, second);
    await flushRequests();
    assert.equal((requests.at(-1)?.params as Request | undefined)?.state, "idle");
    await pi.emit("ui_prompt_start", {}, second);
    await flushRequests();
    assert.equal((requests.at(-1)?.params as Request | undefined)?.state, "blocked");
    await pi.emit("ui_prompt_end", {}, second);
    await flushRequests();
    assert.equal((requests.at(-1)?.params as Request | undefined)?.state, "idle");
  } finally {
    await pi.emit("session_shutdown", { reason: "reload" });
  }
});

test("settling while a native prompt is open stays blocked until its end", async () => {
  const pi = fakePi();
  const requests: Request[] = [];
  createReporter(pi, async (request) => {
    requests.push(request as Request);
  });
  let idle = false;
  const ctx = { ...context("tui", "/tmp/settled-wait.jsonl", "wait"), isIdle: () => idle };
  try {
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await pi.emit("ui_prompt_start", {}, ctx);
    idle = true;
    await pi.emit("agent_settled", {}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((requests.at(-1)?.params as Request | undefined)?.state, "blocked");
    await pi.emit("ui_prompt_end", {}, ctx);
    await flushRequests();
    assert.equal((requests.at(-1)?.params as Request | undefined)?.state, "idle");
  } finally {
    await pi.emit("session_shutdown", { reason: "reload" });
  }
});

test("uses an absolute session path, falls back to an ID, and clears empty identities", () => {
  assert.deepEqual(sessionRefFromValues("/tmp/pi/session.jsonl", "session-id"), {
    agent_session_path: "/tmp/pi/session.jsonl",
  });
  assert.deepEqual(sessionRefFromValues("relative/session.jsonl", "session-id"), { agent_session_id: "session-id" });
  assert.deepEqual(sessionRefFromValues("C:\\Users\\pi\\session.jsonl", "session-id"), {
    agent_session_path: "C:\\Users\\pi\\session.jsonl",
  });
  assert.equal(sessionRefFromValues(undefined, ""), undefined);
  assert.equal(sessionRefFromValues(undefined, undefined), undefined);
});

test("normalizes only supported Herdr session-start sources", () => {
  for (const source of ["startup", "resume", "clear", "compact", "branch", "new", "fork", "select"]) {
    assert.equal(normalizeSessionStartSource(` ${source.toUpperCase()} `), source);
  }
  assert.equal(normalizeSessionStartSource("reload"), undefined);
  assert.equal(normalizeSessionStartSource("unknown"), undefined);
  assert.equal(normalizeSessionStartSource(undefined), undefined);
});

test("uses the Windows named-pipe endpoint form", () => {
  assert.equal(socketEndpointFor("herdr.sock", "win32"), "\\\\.\\pipe\\herdr.sock");
  assert.equal(socketEndpointFor("\\\\.\\pipe\\already", "win32"), "\\\\.\\pipe\\already");
  assert.equal(socketEndpointFor("/tmp/herdr.sock", "darwin"), "/tmp/herdr.sock");
});

test("gates reporting on TUI mode rather than hasUI", async () => {
  const pi = fakePi();
  const requests: Request[] = [];
  createReporter(pi, async (request) => {
    requests.push(request as Request);
  });

  await pi.emit("session_start", { reason: "startup" }, context("rpc", "/tmp/rpc.jsonl", "rpc-id"));
  await pi.emit("agent_start", {}, context("rpc", "/tmp/rpc.jsonl", "rpc-id"));
  await flushRequests();

  assert.deepEqual(requests, []);
});

test("orders session binding before state and attaches the same ref", async () => {
  const pi = fakePi();
  const requests: Request[] = [];
  createReporter(pi, async (request) => {
    requests.push(request as Request);
  });
  const tuiContext = context("tui", "/tmp/tui.jsonl", "tui-id");

  await pi.emit("session_start", { reason: "reload" }, tuiContext);
  await flushRequests();

  assert.deepEqual(
    requests.map((request) => request.method),
    ["pane.report_agent_session", "pane.report_agent"],
  );
  const sessionParams = requests[0]?.params as Request;
  const stateParams = requests[1]?.params as Request;
  assert.equal(sessionParams.session_start_source, undefined);
  assert.equal(sessionParams.agent_session_path, "/tmp/tui.jsonl");
  assert.equal(stateParams.agent_session_path, "/tmp/tui.jsonl");
});

test("orders a changed session binding before the first agent-start state", async () => {
  const pi = fakePi();
  const requests: Request[] = [];
  createReporter(pi, async (request) => {
    requests.push(request as Request);
  });
  await pi.emit("session_start", { reason: "startup" }, context("tui", "/tmp/old.jsonl", "old-id"));
  await flushRequests();
  requests.length = 0;

  await pi.emit("agent_start", {}, context("tui", "/tmp/new.jsonl", "new-id"));
  await flushRequests();

  assert.deepEqual(
    requests.map((request) => request.method),
    ["pane.report_agent_session", "pane.report_agent"],
  );
  const sessionParams = requests[0]?.params as Request;
  const stateParams = requests[1]?.params as Request;
  assert.equal(sessionParams.agent_session_path, "/tmp/new.jsonl");
  assert.equal(stateParams.agent_session_path, "/tmp/new.jsonl");
});

test("disposes the old reporter after session replacement", async () => {
  const pi = fakePi();
  const requests: Request[] = [];
  createReporter(pi, async (request) => {
    requests.push(request as Request);
  });

  await pi.emit("session_start", { reason: "startup" }, context("tui", "/tmp/old.jsonl", "old-id"));
  await flushRequests();
  requests.length = 0;

  await pi.emit("session_shutdown", { reason: "resume" }, context("tui", "/tmp/old.jsonl", "old-id"));
  await pi.emit("agent_start", {}, context("tui", "/tmp/new.jsonl", "new-id"));
  await flushRequests();

  assert.deepEqual(requests, []);
});
