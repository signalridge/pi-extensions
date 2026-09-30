import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, ExtensionRunner, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { mockParentRuntime } from "./helpers/model-runtime.js";

class Bus {
  private listeners = new Map<string, Set<(data: unknown) => void>>();
  on(name: string, handler: (data: unknown) => void): () => void {
    const listeners = this.listeners.get(name) ?? new Set<(data: unknown) => void>();
    listeners.add(handler);
    this.listeners.set(name, listeners);
    return () => listeners.delete(handler);
  }
  emit(name: string, data: unknown): void {
    for (const handler of this.listeners.get(name) ?? []) handler(data);
  }
}

type Handler = (event: unknown, ctx: unknown) => unknown;

function fixture(cwd: string) {
  const manager = SessionManager.inMemory(cwd);
  const target = manager.appendCustomEntry("target", { value: "ancestor" });
  manager.appendMessage({ role: "user", content: "old branch", timestamp: Date.now() });
  const oldLeaf = manager.getLeafId();
  const bus = new Bus();
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
  const entries = () => manager.getBranch();
  const pi = {
    events: bus,
    on: (name: string, handler: Handler) => { handlers.set(name, handler); },
    appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
    registerTool: (tool: { name: string; execute: (...args: never[]) => Promise<unknown> }) => { tools.set(tool.name, tool); },
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    sendMessage: () => {},
  };
  subagentsExtension(pi as never);
  const ctx = {
    cwd,
    hasUI: false,
    mode: "print",
    ui: { setStatus: () => {}, setWidget: () => {}, notify: vi.fn() },
    model: undefined,
    modelRegistry: { find: () => undefined, getAvailable: () => [], runtime: mockParentRuntime },
    sessionManager: manager,
    getSystemPrompt: () => "parent",
  };
  const extension = (name: string, before?: Handler) => ({
    path: name,
    resolvedPath: name,
    sourceInfo: {},
    handlers: new Map<string, Handler[]>([
      ["session_before_tree", before ? [before] : []],
      ["session_before_switch", before ? [before] : []],
      ["session_tree", name === "subagents" ? [handlers.get("session_tree")!] : []],
    ]),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  });
  const host = (extensions: Array<ReturnType<typeof extension>>, streamFunction?: unknown) => {
    const runner = new ExtensionRunner(extensions as never, {} as never, cwd, manager, ctx.modelRegistry as never);
    // Navigate through Pi 0.99's real host method, with only unrelated model,
    // rendering, and context machinery replaced by inert test dependencies.
    const session = Object.create(AgentSession.prototype) as AgentSession;
    Object.assign(session, {
      agent: { state: { model: { id: "test", provider: "test", contextWindow: 128_000, maxTokens: 4096 } }, streamFunction },
      sessionManager: manager,
      settingsManager: { getBranchSummarySettings: () => ({ reserveTokens: 8192 }), getRetrySettings: () => ({ maxRetries: 0 }) },
      _extensionRunner: runner,
      _isAgentRunActive: false,
      _refreshFinalizedContext: () => {},
      _restoreToolsFromTranscript: () => {},
      _resolveIdleWaitIfIdle: () => {},
      _getSummarizationRequestAuth: async () => ({ model: session.model, apiKey: "test" }),
    });
    return session;
  };
  return { manager, target, oldLeaf, bus, handlers, tools, entries, pi, ctx, extension, host };
}

const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); };

describe.skipIf(!VERSION.startsWith("0.99."))("Pi 0.99 navigation commit boundary", () => {
  let cwd = "";
  let oldCwd = "";
  let oldAgentDir: string | undefined;
  let finish: ((result: unknown) => void) | undefined;
  let runSignal: AbortSignal | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "navigation-host-"));
    oldCwd = process.cwd();
    oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
    mkdirSync(process.env.PI_CODING_AGENT_DIR);
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(cwd);
    vi.mocked(runAgent).mockReset().mockImplementation((_ctx, _type, _prompt, options) => {
      runSignal = options.signal;
      return new Promise((resolve) => { finish = resolve; }) as ReturnType<typeof runAgent>;
    });
  });
  afterEach(() => {
    process.chdir(oldCwd);
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    for (const key of ["pi-subagents:manager", "pi-subagents:manager-active", "pi-subagents:rpc-owner"]) {
      delete (globalThis as Record<symbol, unknown>)[Symbol.for(key)];
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  async function spawn(f: ReturnType<typeof fixture>) {
    await f.tools.get("Agent")!.execute("running", {
      prompt: "work", description: "navigation candidate", subagent_type: "general-purpose", run_in_background: true,
    }, undefined, undefined, f.ctx);
    expect(runSignal).toBeDefined();
  }
  async function complete(f: ReturnType<typeof fixture>) {
    finish?.({ responseText: "finished", session: { dispose: vi.fn() }, aborted: false, steered: false });
    await settle();
    await f.handlers.get("session_shutdown")?.({}, f.ctx);
  }

  it.each(["subagents-first", "workflows-first"])("vetoes an active child in %s load order without aborting it", async (order) => {
    const f = fixture(cwd);
    await f.handlers.get("session_start")?.({}, f.ctx);
    await spawn(f);
    // Model the second package's public synchronous preflight in the runner.
    const workflowHandler: Handler = (_event, ctx) => {
      let busy = false;
      f.bus.emit("pi:navigation-preflight", { report: () => { busy = true; } });
      if (!busy) return undefined;
      (ctx as typeof f.ctx).ui.notify("Wait for active agents or stop them explicitly", "warning");
      return { cancel: true };
    };
    const own = f.extension("subagents", f.handlers.get("session_before_tree"));
    const peer = f.extension("workflows", workflowHandler);
    const host = f.host(order === "subagents-first" ? [own, peer] : [peer, own]);
    const runner = (host as unknown as { _extensionRunner: ExtensionRunner })._extensionRunner;
    expect(await runner.emit({ type: "session_before_switch", reason: "new" } as never)).toMatchObject({ cancel: true });
    const outcome = await host.navigateTree(f.target);
    expect(outcome).toMatchObject({ cancelled: true });
    expect(f.manager.getLeafId()).toBe(f.oldLeaf);
    expect(runSignal?.aborted).toBe(false);
    expect(f.entries().some((entry) => entry.type === "custom" && entry.customType === "subagents:record")).toBe(false);
    await complete(f);
  });

  it("keeps work started after preflight live when a later Pi handler vetoes", async () => {
    const f = fixture(cwd);
    await f.handlers.get("session_start")?.({}, f.ctx);
    const own = f.extension("subagents", f.handlers.get("session_before_tree"));
    const late = f.extension("later", async () => { await spawn(f); return { cancel: true }; });
    const host = f.host([own, late]);
    expect(await host.navigateTree(f.target)).toMatchObject({ cancelled: true });
    expect(runSignal?.aborted).toBe(false);
    expect(f.manager.getLeafId()).toBe(f.oldLeaf);
    await complete(f);
  });

  it.each(["abort", "error"])("leaves a child started during branch summary live on %s", async (outcome) => {
    const f = fixture(cwd);
    await f.handlers.get("session_start")?.({}, f.ctx);
    const own = f.extension("subagents", f.handlers.get("session_before_tree"));
    const streamFunction = async () => ({ result: async () => ({ stopReason: "aborted", content: [] }) });
    const host = f.host([own], streamFunction);
    const runtime = host as unknown as Record<string, unknown>;
    runtime._getSummarizationRequestAuth = async () => {
      await spawn(f);
      if (outcome === "error") throw new Error("summary auth failed");
      host.abortBranchSummary();
      return { model: host.model, apiKey: "test" };
    };
    if (outcome === "error") await expect(host.navigateTree(f.target, { summarize: true })).rejects.toThrow("summary auth failed");
    else expect(await host.navigateTree(f.target, { summarize: true })).toMatchObject({ cancelled: true, aborted: true });
    expect(f.manager.getLeafId()).toBe(f.oldLeaf);
    expect(runSignal?.aborted).toBe(false);
    await complete(f);
  });

  it.each(["subagents-first", "workflows-first"])("keeps owned RPC alive through confirmed shutdown in %s order", async (order) => {
    const f = fixture(cwd);
    await f.handlers.get("session_start")?.({}, f.ctx);
    const owner = { extension: "pi-workflows", runId: "run-1", nodeId: "call-0", attemptId: "attempt-1" };
    const spawnReply = new Promise<{ success: boolean; data: { id: string } }>((resolve) => {
      f.bus.on("subagents:rpc:spawn-managed:reply:managed", (data) => resolve(data as { success: boolean; data: { id: string } }));
    });
    f.bus.emit("subagents:rpc:spawn-managed", {
      requestId: "managed", spawnKey: "run-1/call-0/attempt-1", type: "general-purpose",
      prompt: "work", description: "owned", owner,
    });
    const allocated = await spawnReply;
    expect(allocated.success).toBe(true);
    const journalBeforeShutdown = f.manager.getEntryCount();
    let requested = false;
    const workflowShutdown = () => new Promise<{ settled: boolean; pending: string[] }>((resolve) => {
      f.bus.on("subagents:rpc:quiesce-owned:reply:closing", (data) => {
        const reply = data as { success: boolean; data: { settled: boolean; pending: string[] } };
        resolve(reply.success ? reply.data : { settled: false, pending: [allocated.data.id] });
      });
      requested = true;
      f.bus.emit("subagents:rpc:quiesce-owned", {
        requestId: "closing", owner: { extension: "pi-workflows", runId: owner.runId },
        agentIds: [allocated.data.id], owners: [owner], timeoutMs: 5_000,
      });
    });
    f.bus.on("pi-workflows:shutdown-quiesce", (raw) => {
      (raw as { respond: (promise: Promise<{ settled: boolean; pending: string[] }>) => void }).respond(workflowShutdown());
    });
    const first = order === "workflows-first" ? workflowShutdown() : undefined;
    const closing = f.handlers.get("session_shutdown")?.({}, f.ctx);
    expect(requested).toBe(true);
    expect(runSignal?.aborted).toBe(true);
    finish?.({ responseText: "stopped", session: { dispose: vi.fn() }, aborted: true, steered: false });
    if (first) expect((await first).settled).toBe(true);
    await closing;
    expect(f.manager.getEntryCount()).toBeGreaterThan(journalBeforeShutdown);
    expect(f.entries().some((entry) => entry.type === "custom" && entry.customType === "subagents:record")).toBe(true);
  });

  it("bounds a missing workflow shutdown acknowledgement and reports quarantine", async () => {
    const f = fixture(cwd);
    await f.handlers.get("session_start")?.({}, f.ctx);
    f.bus.on("pi-workflows:shutdown-quiesce", (raw) => {
      (raw as { respond: (promise: Promise<never>) => void }).respond(new Promise(() => {}));
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const closing = f.handlers.get("session_shutdown")?.({}, f.ctx);
      await vi.advanceTimersByTimeAsync(6_000);
      await closing;
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("workflow shutdown quiescence timed out"));
    } finally {
      vi.useRealTimers();
      warning.mockRestore();
    }
  });

  it("commits a new leaf without appending an old child's late terminal there", async () => {
    const f = fixture(cwd);
    await f.handlers.get("session_start")?.({}, f.ctx);
    const own = f.extension("subagents", f.handlers.get("session_before_tree"));
    const late = f.extension("late", async () => { await spawn(f); });
    const host = f.host([own, late]);
    expect(await host.navigateTree(f.target)).toMatchObject({ cancelled: false });
    expect(f.manager.getLeafId()).toBe(f.target);
    expect(runSignal?.aborted).toBe(true);
    const before = f.manager.getEntryCount();
    finish?.({ responseText: "late", session: { dispose: vi.fn() }, aborted: true, steered: false });
    await settle();
    expect(f.manager.getEntryCount()).toBe(before);
    expect(f.entries().some((entry) => entry.type === "custom" && entry.customType === "subagents:record")).toBe(false);
    await f.handlers.get("session_shutdown")?.({}, f.ctx);
  });
});
