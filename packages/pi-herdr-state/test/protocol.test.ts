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
