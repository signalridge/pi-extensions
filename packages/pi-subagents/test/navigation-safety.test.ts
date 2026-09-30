import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { mockParentRuntime } from "./helpers/model-runtime.js";

class Bus {
  private handlers = new Map<string, Set<(value: unknown) => void>>();
  on(name: string, handler: (value: unknown) => void): () => void {
    const listeners = this.handlers.get(name) ?? new Set();
    listeners.add(handler);
    this.handlers.set(name, listeners);
    return () => listeners.delete(handler);
  }
  emit(name: string, value: unknown): void {
    for (const handler of this.handlers.get(name) ?? []) handler(value);
  }
}

function fixture(cwd: string) {
  const bus = new Bus();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const notices: string[] = [];
  const pi = {
    events: bus,
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    sendMessage: vi.fn(),
  };
  subagentsExtension(pi as never);
  const sessionManager = {
    getSessionId: () => "navigation-safety",
    getBranch: () => entries,
    getLeafId: () => entries.length === 0 ? null : String(entries.length),
  };
  const modelRegistry = { find: vi.fn(), getAvailable: vi.fn(() => []), runtime: mockParentRuntime };
  const runner = new ExtensionRunner(
    [{ path: "subagents", handlers }] as never,
    {} as never,
    cwd,
    sessionManager as never,
    modelRegistry as never,
  );
  runner.setUIContext({ notify: (message: string) => notices.push(message), setWidget: vi.fn(), setStatus: vi.fn() } as never, "rpc");
  const spawn = () => tools.get("Agent")?.execute(
    "navigation-spawn",
    { prompt: "work", description: "navigation child", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    runner.createContext(),
  );
  return { bus, handlers, tools, entries, notices, runner, spawn };
}

function deferredRun() {
  let finish!: (value: Awaited<ReturnType<typeof runAgent>>) => void;
  let signal: AbortSignal | undefined;
  vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
    signal = options.signal;
    return new Promise((resolve) => { finish = resolve; });
  });
  return {
    resolve: () => finish({
      responseText: "result from old branch",
      session: { dispose: vi.fn() } as never,
      aborted: false,
      steered: false,
    }),
    get signal() { return signal; },
  };
}

describe("Pi 0.99.1 cancellable navigation", () => {
  let cwd: string;
  let agentDir: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-navigation-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-navigation-agent-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
  });
  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(cwd, { force: true, recursive: true });
    rmSync(agentDir, { force: true, recursive: true });
    vi.restoreAllMocks();
    for (const name of ["pi-subagents:manager", "pi-subagents:manager-active", "pi-subagents:rpc-owner"]) {
      delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(name)];
    }
  });

  for (const kind of ["session_before_switch", "session_before_tree"]) {
    it(`${kind} vetoes active work without aborting or detaching it`, async () => {
      const f = fixture(cwd);
      const run = deferredRun();
      await f.runner.emit({ type: "session_start", reason: "startup" } as never);
      await f.spawn();
      expect(run.signal?.aborted).toBe(false);
      const result = await f.runner.emit({ type: kind, signal: new AbortController().signal } as never);
      expect(result).toMatchObject({ cancel: true });
      expect(f.notices.join(" ")).toMatch(/wait.*stop/i);
      expect(run.signal?.aborted).toBe(false);
      run.resolve();
      await vi.waitFor(() => expect(f.entries.some((entry) => entry.customType === "subagents:record")).toBe(true));
      await f.runner.emit({ type: "session_shutdown", reason: "quit" } as never);
    });
  }

  it("prints actionable guidance when headless navigation is vetoed", async () => {
    const f = fixture(cwd);
    const run = deferredRun();
    await f.runner.emit({ type: "session_start", reason: "startup" } as never);
    await f.spawn();
    f.runner.setUIContext(undefined, "print");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await f.runner.emit({ type: "session_before_switch" } as never)).toMatchObject({ cancel: true });
      expect(warning.mock.calls.map(([message]) => String(message)).join(" ")).toMatch(/wait.*stop/i);
      expect(run.signal?.aborted).toBe(false);
    } finally {
      warning.mockRestore();
      run.resolve();
      await f.runner.emit({ type: "session_shutdown", reason: "quit" } as never);
    }
  });

  it("leaves work live when a later real Pi handler vetoes after our preflight", async () => {
    const f = fixture(cwd);
    const run = deferredRun();
    await f.runner.emit({ type: "session_start", reason: "startup" } as never);
    // ExtensionRunner is the host's real sequential event reducer. This second
    // extension admits a child after the first preflight, then vetoes navigation.
    f.runner.extensions.push({
      path: "later-veto",
      handlers: new Map([["session_before_tree", [async () => {
        await f.spawn();
        return { cancel: true };
      }]]]),
    } as never);
    const result = await f.runner.emit({ type: "session_before_tree", signal: new AbortController().signal } as never);
    expect(result).toMatchObject({ cancel: true });
    expect(run.signal?.aborted).toBe(false);
    run.resolve();
    await vi.waitFor(() => expect(f.entries.some((entry) => entry.customType === "subagents:record")).toBe(true));
    await f.runner.emit({ type: "session_shutdown", reason: "quit" } as never);
  });

  it.each(["summary aborted", "summary error"])("does not quiesce on %s after all before-tree hooks", async () => {
    const f = fixture(cwd);
    const run = deferredRun();
    await f.runner.emit({ type: "session_start", reason: "startup" } as never);
    const controller = new AbortController();
    expect(await f.runner.emit({ type: "session_before_tree", signal: controller.signal } as never)).toBeUndefined();
    // Pi may still abort or throw during branch summarization, without emitting
    // session_tree. New work after the last hook remains attached to the old leaf.
    await f.spawn();
    expect(run.signal?.aborted).toBe(false);
    controller.abort();
    expect(run.signal?.aborted).toBe(false);
    run.resolve();
    await vi.waitFor(() => expect(f.entries.some((entry) => entry.customType === "subagents:record")).toBe(true));
    await f.runner.emit({ type: "session_shutdown", reason: "quit" } as never);
  });

  it("quarantines a child admitted after preflight when the tree actually commits", async () => {
    const f = fixture(cwd);
    const run = deferredRun();
    await f.runner.emit({ type: "session_start", reason: "startup" } as never);
    expect(await f.runner.emit({ type: "session_before_tree", signal: new AbortController().signal } as never)).toBeUndefined();
    await f.spawn(); // admitted during Pi's summarization window
    const entriesAtCommit = f.entries.length;
    await f.runner.emit({ type: "session_tree", oldLeafId: "old", newLeafId: "target" } as never);
    expect(run.signal?.aborted).toBe(true);
    run.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.entries.slice(entriesAtCommit).some((entry) => entry.customType === "subagents:record")).toBe(false);
    await f.runner.emit({ type: "session_shutdown", reason: "quit" } as never);
  });

  it("keeps the owned cleanup RPC alive while awaiting workflow shutdown quiescence", async () => {
    const f = fixture(cwd);
    await f.runner.emit({ type: "session_start", reason: "startup" } as never);
    let finish!: (result: { settled: boolean; pending: string[] }) => void;
    f.bus.on("pi-workflows:shutdown-quiesce", (raw) => {
      const { respond } = raw as { respond: (promise: Promise<{ settled: boolean; pending: string[] }>) => void };
      respond(new Promise((resolve) => { finish = resolve; }));
    });
    const shutting = f.runner.emit({ type: "session_shutdown", reason: "quit" } as never);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    let rpcReply: unknown;
    f.bus.on("subagents:rpc:quiesce-owned:reply:navigation-probe", (reply) => { rpcReply = reply; });
    f.bus.emit("subagents:rpc:quiesce-owned", {
      requestId: "navigation-probe",
      owner: { extension: "pi-workflows", runId: "pending-workflow" },
      agentIds: [],
      owners: [],
      timeoutMs: 100,
    });
    await vi.waitFor(() => expect(rpcReply).toMatchObject({ success: true, data: { settled: true } }));
    finish({ settled: true, pending: [] });
    await shutting;
  });

  it("finishes a confirmed host switch even when a child session_shutdown hangs", async () => {
    const f = fixture(cwd);
    let release!: () => void;
    let started!: () => void;
    const shutdownStarted = new Promise<void>((resolve) => { started = resolve; });
    const childGate = new Promise<void>((resolve) => { release = resolve; });
    const child = {
      extensionRunner: { emit: vi.fn(async () => { started(); await childGate; }) },
      dispose: vi.fn(),
    };
    vi.mocked(runAgent).mockResolvedValue({ responseText: "old result", session: child as never, aborted: false, steered: false });
    await f.runner.emit({ type: "session_start", reason: "startup" } as never);
    await f.spawn();
    await vi.waitFor(() => expect(f.entries.some((entry) => entry.customType === "subagents:record")).toBe(true));
    const oldEntryCount = f.entries.length;
    expect(await f.runner.emit({ type: "session_before_switch" } as never)).toBeUndefined();
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const switching = f.runner.emit({ type: "session_shutdown", reason: "switch" } as never);
      await shutdownStarted;
      await vi.advanceTimersByTimeAsync(1_050);
      await switching;
      expect(child.dispose).not.toHaveBeenCalled();
      expect(warning.mock.calls.map(([message]) => String(message)).join(" ")).toMatch(/child session shutdown timed out/);
      release();
      vi.useRealTimers();
      await vi.waitFor(() => expect(child.dispose).toHaveBeenCalledOnce());
      expect(f.entries).toHaveLength(oldEntryCount);
    } finally {
      release();
      vi.useRealTimers();
      warning.mockRestore();
    }
  });

  it("reports workflow shutdown timeout and finishes without waiting forever", async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const f = fixture(cwd);
      await f.runner.emit({ type: "session_start", reason: "startup" } as never);
      f.bus.on("pi-workflows:shutdown-quiesce", (raw) => {
        (raw as { respond: (promise: Promise<never>) => void }).respond(new Promise(() => {}));
      });
      const shutting = f.runner.emit({ type: "session_shutdown", reason: "quit" } as never);
      await vi.advanceTimersByTimeAsync(6_001);
      await shutting;
      expect(warn.mock.calls.map(([message]) => String(message)).join(" ")).toMatch(/quiescence timed out.*quarantined/);
    } finally {
      vi.useRealTimers();
    }
  });
});
