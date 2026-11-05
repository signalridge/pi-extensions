import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentSession, type AgentSessionEvent, discoverAndLoadExtensions, type ExtensionCommandContext, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { replyChannel, WORKFLOW_UI_CHANNELS } from "@signalridge/pi-subagents-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import * as runner from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { FleetList } from "../src/ui/fleet-list.js";
import { mockParentRegistry } from "./helpers/model-runtime.js";

vi.mock("../src/agent-runner.js", async importOriginal => ({ ...await importOriginal<typeof runner>(), runAgent: vi.fn(), resumeAgent: vi.fn() }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
class Bus {
  listeners = new Map<string, Set<(raw: unknown) => void>>();
  on(channel: string, handler: (raw: unknown) => void) {
    const handlers = this.listeners.get(channel) ?? new Set(); handlers.add(handler); this.listeners.set(channel, handlers);
    return () => { handlers.delete(handler); if (!handlers.size) this.listeners.delete(channel); };
  }
  emit(channel: string, raw: unknown) { for (const handler of [...this.listeners.get(channel) ?? []]) handler(raw); }
}
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const owner = { extension: "pi-workflows" as const, runId: "run", nodeId: "call-1", attemptId: "attempt-1" };
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
type Command = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
type Tool = { execute: (id: string, params: Record<string, unknown>, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<unknown> };
function harness(cwd: string, bus = new Bus()) {
  const lifecycle = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, Command>();
  const widgets = new Map<string, { component: Component; placement?: string }>();
  let widget: Component | undefined; let viewer: (Component & { dispose?(): void }) | undefined;
  let close: (() => void) | undefined; let input: ((data: string) => unknown) | undefined;
  const tui = { terminal: { rows: 40, columns: 120 }, requestRender: vi.fn() } as unknown as TUI;
  const ui = {
    notify: vi.fn(), setStatus: vi.fn(), getEditorText: () => "",
    setWidget: vi.fn((key: string, factory: ((host: TUI, theme: typeof theme) => Component) | undefined, options?: { placement?: string }) => {
      const component = factory?.(tui, theme);
      if (key === "fleet") widget = component;
      if (component) widgets.set(key, { component, placement: options?.placement }); else widgets.delete(key);
    }),
    onTerminalInput: vi.fn((handler: typeof input) => { input = handler; return () => { input = undefined; }; }),
    custom: vi.fn((factory: (host: TUI, theme: typeof theme, keys: never, done: (result: undefined) => void) => Component) => new Promise<undefined>(resolve => {
      close = () => { viewer?.dispose?.(); resolve(undefined); close = undefined; };
      viewer = factory(tui, theme, { matches: () => false, getKeys: () => [] } as never, close);
    })),
    select: vi.fn(async (_title: string, _rows: string[]): Promise<string | undefined> => undefined),
  };
  const ctx = { cwd, mode: "tui", hasUI: true, isProjectTrusted: () => true, ui, modelRegistry: mockParentRegistry,
    sessionManager: SessionManager.inMemory(cwd), getSystemPrompt: () => "parent" } as unknown as ExtensionCommandContext;
  const pi = { events: bus, on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => lifecycle.set(name, handler),
    registerTool: vi.fn(), registerCommand: (name: string, command: Command) => commands.set(name, command),
    registerMessageRenderer: vi.fn(), appendEntry: vi.fn(), sendMessage: vi.fn() };
  subagentsExtension(pi as never);
  return { bus, lifecycle, commands, ctx, ui, pi, widgets, widget: () => widget, viewer: () => viewer, close: () => close?.(), input: (key: string) => input?.(key) };
}
function nativeSeam() {
  const messages: AgentSession["messages"] = [];
  const subscribers = new Set<(event: AgentSessionEvent) => void>();
  const session = { messages, state: { messages }, subscribe: (handler: (event: AgentSessionEvent) => void) => { subscribers.add(handler); return () => subscribers.delete(handler); },
    dispose: vi.fn(), steer: vi.fn(async () => "handled"), getSteeringMessages: () => [] } as unknown as AgentSession;
  return { session, subscribers, append: (text: string) => {
    messages.push({ role: "assistant", content: [{ type: "text", text }], timestamp: 0 } as never);
    for (const subscriber of [...subscribers]) subscriber({ type: "turn_end" } as AgentSessionEvent);
  } };
}

describe("Fleet real-index accounting, reservation and native peer lifecycle regressions", () => {
  let root: string; let cwd: string; let priorAgentDir: string | undefined;
  let h: ReturnType<typeof harness>; let seam: ReturnType<typeof nativeSeam>;
  let running: ReturnType<typeof deferred<Awaited<ReturnType<typeof runner.runAgent>>>>;
  let options: Parameters<typeof runner.runAgent>[3]; let manager: AgentManager;
  const cleanup: Array<() => Promise<void>> = [];
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "fleet-index-regression-")); cwd = join(root, "project");
    mkdirSync(join(cwd, ".pi"), { recursive: true }); mkdirSync(join(root, "agent"));
    priorAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, defaultJoinMode: "async", maxConcurrent: 1 }));
    seam = nativeSeam(); running = deferred();
    vi.mocked(runner.runAgent).mockImplementation(async (_ctx, _type, _prompt, callbacks) => {
      options = callbacks; await Promise.resolve(); callbacks.onSessionCreated?.(seam.session); return running.promise;
    });
    vi.mocked(runner.resumeAgent).mockImplementation(async () => ({ text: "B" }));
    const capture = vi.spyOn(AgentManager.prototype, "spawnManaged");
    h = harness(cwd); await h.lifecycle.get("session_start")?.({}, h.ctx);
    h.bus.on("test:capture", () => { manager = capture.mock.contexts.at(-1)!; });
  });
  afterEach(async () => {
    running.resolve({ responseText: "done", session: seam.session, aborted: false, steered: false }); h.close();
    for (const finish of cleanup.splice(0).reverse()) await finish();
    await h.lifecycle.get("session_shutdown")?.({}, h.ctx);
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.clearAllMocks();
  });
  async function managed(attempt = 1) {
    const requestId = `spawn-${attempt}`; let result: { success: boolean; data: { id: string }; error?: string } | undefined;
    const off = h.bus.on(`subagents:rpc:spawn-managed:reply:${requestId}`, raw => { result = raw as typeof result; });
    h.bus.emit("subagents:rpc:spawn-managed", { requestId, spawnKey: requestId, type: "Explore", prompt: String(attempt), description: "thread", thread: "thread",
      owner: { ...owner, nodeId: `call-${attempt}`, attemptId: `attempt-${attempt}` } });
    await flush(); off(); expect(result?.success, result?.error).toBe(true); h.bus.emit("test:capture", {});
    return manager.getRecordMutable(result!.data.id)!;
  }
  function request(record: AgentRecord, id: string, afterReply?: () => void) {
    let response: unknown;
    const off = h.bus.on(replyChannel(WORKFLOW_UI_CHANNELS.openConversation, id), raw => { response = raw; afterReply?.(); });
    h.bus.emit(WORKFLOW_UI_CHANNELS.openConversation, { requestId: id, agentId: record.id, owner: record.owner }); off(); return response;
  }
  async function completeA(usage = { input: 10, output: 5, cacheWrite: 2 }) {
    options.onAssistantUsage?.(usage); seam.append("A");
    running.resolve({ responseText: "A", session: seam.session, aborted: false, steered: false }); await flush();
  }
  async function usageText() {
    let selected = false;
    h.ui.select.mockImplementation(async (_title, rows) => { if (selected) return undefined; selected = true; return rows.find(row => row.startsWith("Usage (")); });
    await h.commands.get("agents")!.handler("", h.ctx);
    return h.ui.notify.mock.calls.at(-1)?.[0] as string;
  }

  it("A+B yields User Usage 23, lifecycle lifetime 23 and managedTokens 6 without transcript/Fleet regression", async () => {
    const events: Array<Record<string, unknown>> = []; h.bus.on("subagents:completed", raw => events.push(raw as Record<string, unknown>));
    const record = await managed(); await completeA(); const prefix = readFileSync(record.outputFile!, "utf8");
    const done = deferred<{ text: string }>(); let resumeOptions: Parameters<typeof runner.resumeAgent>[2];
    vi.mocked(runner.resumeAgent).mockImplementation(async (_session, _prompt, callbacks) => { resumeOptions = callbacks; return done.promise; });
    expect(await managed(2)).toBe(record); await managed(2);
    expect(request(record, "open")).toEqual({ success: true, data: { accepted: true } }); await flush();
    expect(h.viewer()!.render(200).join("\n")).toContain("17 tokens");
    resumeOptions!.onAssistantUsage?.({ input: 3, output: 2, cacheWrite: 1 }); seam.append("B");
    expect(h.viewer()!.render(200).join("\n")).toContain("23 tokens"); done.resolve({ text: "B" }); await flush();
    expect(events[1].tokens).toEqual({ input: 13, output: 7, total: 23 }); expect(events[1].managedTokens).toEqual({ input: 3, output: 2, total: 6 });
    expect(readFileSync(record.outputFile!, "utf8").startsWith(prefix)).toBe(true); expect(seam.subscribers.size).toBe(1);
    expect(await usageText()).toContain("Total · 2 run(s) · 23"); expect(await usageText()).not.toContain("40");
  });

  it("credits duplicate callbacks once, and counts failed, zero and cache-write-only attempts without resetting root totals", async () => {
    const record = await managed(); await completeA({ input: 0, output: 0, cacheWrite: 7 });
    // Exercise the real index completion callback, independently of the manager's delivery deduplication.
    const callback = Reflect.get(manager, "onComplete") as (record: AgentRecord) => void;
    callback(record); callback(record);
    vi.mocked(runner.resumeAgent).mockImplementation(async (_session, _prompt, callbacks) => {
      callbacks.onAssistantUsage?.({ input: 0, output: 0, cacheWrite: 3 }); return { text: "partial", failure: "failed" };
    });
    await managed(2); callback(record); expect(record.status).toBe("error");
    vi.mocked(runner.resumeAgent).mockImplementation(async () => ({ text: "zero" })); await managed(3); callback(record);
    expect(await usageText()).toContain("Total · 3 run(s) · 10");
    await h.lifecycle.get("session_tree")?.({ type: "session_tree" }, h.ctx);
    expect(await usageText()).toContain("Total · 3 run(s) · 10");
    record.lifetimeUsage.cacheWrite += 99; callback(record);
    expect(await usageText()).toContain("Total · 3 run(s) · 10");
  });

  it.each([false, true])("reserves before reply and refuses the second same-turn request (reentrant=%s)", async reentrant => {
    const record = await managed(); let second: unknown;
    const first = request(record, "first", () => {
      expect(h.ui.custom).not.toHaveBeenCalled();
      if (reentrant) second = request(record, "second");
    });
    if (!reentrant) second = request(record, "second");
    expect(first).toEqual({ success: true, data: { accepted: true } }); expect(second).toMatchObject({ success: false });
    expect(h.ui.custom).not.toHaveBeenCalled(); await flush(); expect(h.ui.custom).toHaveBeenCalledOnce();
    h.close(); await flush(); expect(request(record, "third")).toMatchObject({ success: true }); await flush();
    expect(h.ui.custom).toHaveBeenCalledTimes(2);
  });

  it.each(["attempt", "tree", "new-root"])("fences %s retirement between synchronous reservation and the deferred factory", async kind => {
    const record = await managed();
    expect(request(record, "first", () => {
      if (kind === "attempt") record.owner = { ...owner, attemptId: "new-attempt" };
      else if (kind === "tree") void h.lifecycle.get("session_tree")?.({}, h.ctx);
      else void h.lifecycle.get("session_start")?.({}, { ...h.ctx, sessionManager: SessionManager.inMemory(cwd) });
    })).toMatchObject({ success: true });
    await flush(); expect(seam.subscribers.size).toBeLessThanOrEqual(1);
    if (kind === "attempt") {
      expect(h.ui.custom).toHaveBeenCalledOnce(); expect(h.viewer()!.render(120).join("\n")).not.toContain("thread");
      expect(request(record, "current")).toMatchObject({ success: true }); await flush();
      expect(h.ui.custom).toHaveBeenCalledTimes(2);
    } else expect(h.ui.custom).not.toHaveBeenCalled();
  });

  it("does not acknowledge a refused synchronous opener", async () => {
    const record = await managed();
    vi.spyOn(FleetList.prototype, "openConversation").mockReturnValueOnce(false);
    expect(request(record, "refused")).toMatchObject({ success: false });
    await flush(); expect(h.ui.custom).not.toHaveBeenCalled();
  });

  it("a late old UI factory cannot construct on a new tree or clear its new reservation", async () => {
    const record = await managed(); await completeA();
    let lateFactory: (() => Component) | undefined;
    h.ui.custom.mockImplementationOnce(factory => new Promise<undefined>(resolve => {
      lateFactory = () => factory({ terminal: { rows: 40, columns: 120 }, requestRender: vi.fn() } as unknown as TUI,
        theme, undefined as never, resolve);
    }));
    expect(request(record, "old")).toMatchObject({ success: true }); await flush(); expect(lateFactory).toBeDefined();
    await h.lifecycle.get("session_tree")?.({}, h.ctx);
    const next = await managed(2); expect(request(next, "new")).toMatchObject({ success: true }); await flush();
    const newViewer = h.viewer(); expect(lateFactory!().render(120)).toEqual([]); await flush();
    expect(h.viewer()).toBe(newViewer); expect(request(next, "busy")).toMatchObject({ success: false });
    h.close(); await flush(); expect(request(next, "reopened")).toMatchObject({ success: true }); await flush();
  });

  it("releases admission after a factory failure; headless refusal and absent endpoint remain unchanged", async () => {
    const record = await managed();
    vi.spyOn(FleetList.prototype, "conversation").mockImplementationOnce(() => { throw new Error("factory failed"); });
    expect(request(record, "first")).toMatchObject({ success: true }); await flush();
    expect(h.ui.notify).toHaveBeenCalledWith("Cannot open conversation; try again.", "error");
    expect(request(record, "retry")).toMatchObject({ success: true }); await flush(); h.close();
    await h.lifecycle.get("session_start")?.({}, { ...h.ctx, mode: "print", hasUI: false });
    expect(request(record, "headless")).toMatchObject({ success: false });
    await h.lifecycle.get("session_shutdown")?.({}, h.ctx);
    expect(request(record, "absent")).toBeUndefined(); expect(h.bus.listeners.has(WORKFLOW_UI_CHANNELS.changed)).toBe(false);
  });

  it.each(["subagents-first", "workflows-first"])("uses native workflow handlers through committed tree and replacement roots in %s order", async order => {
    await h.lifecycle.get("session_shutdown")?.({}, h.ctx);
    h = harness(cwd);
    // Native loader owns package boundaries; no source imports from another extension.
    const loaded = await discoverAndLoadExtensions([fileURLToPath(new URL("../../pi-workflows/src/index.ts", import.meta.url))], cwd, join(root, "agent"), h.bus as never);
    expect(loaded.errors).toEqual([]); const extension = loaded.extensions[0];
    loaded.runtime.appendEntry = (type, data) => { h.ctx.sessionManager.appendCustomEntry(type, data); };
    loaded.runtime.sendMessage = vi.fn(); loaded.runtime.getActiveTools = () => []; loaded.runtime.getCommands = () => [];
    const emit = async (name: string, event: unknown, ctx: ExtensionContext = h.ctx) => {
      for (const handler of extension.handlers.get(name) ?? []) await (handler as (event: unknown, ctx: ExtensionContext) => unknown)(event, ctx);
    };
    cleanup.push(async () => { h.close(); await emit("session_shutdown", {}); });
    if (order === "subagents-first") { await h.lifecycle.get("session_start")?.({}, h.ctx); await emit("session_start", {}); }
    else { await emit("session_start", {}); await h.lifecycle.get("session_start")?.({}, h.ctx); }
    const workflow = extension.tools.get("workflow")!.definition as unknown as Tool;
    const execute = async (name: string) => workflow.execute(name, { script: `export const meta = { name: ${JSON.stringify(name)}, description: "test" }; return 1;`, background: false }, undefined, undefined, h.ctx);
    let workflowCommands = extension.commands;
    const openFromOverview = async (name: string) => {
      expect(h.widget()).toBeUndefined();
      expect([...h.widgets.keys()]).toEqual(["pi-workflows"]);
      const overview = h.widgets.get("pi-workflows")!;
      expect(overview.placement).toBe("belowEditor");
      expect(overview.component.render(200).join("\n")).toContain(`▸ ${name}`);
      expect(h.input("\x1b[B")).toBeUndefined(); // No competing workflow arrow owner.
      const opening = workflowCommands.get("workflows")!.handler("", h.ctx);
      await flush();
      expect(h.viewer()!.render(200).join("\n")).toContain(name); h.close(); await opening; await flush();
    };
    await execute("before tree"); await flush(); await openFromOverview("before tree");
    const event = { type: "session_tree", oldLeafId: h.ctx.sessionManager.getLeafId(), newLeafId: null };
    h.ctx.sessionManager.resetLeaf();
    if (order === "subagents-first") { await h.lifecycle.get("session_tree")?.(event, h.ctx); await emit("session_tree", event); }
    else { await emit("session_tree", event); await h.lifecycle.get("session_tree")?.(event, h.ctx); }
    await execute("after tree"); await flush(); await openFromOverview("after tree");
    const previous = h;
    await emit("session_shutdown", {}); await previous.lifecycle.get("session_shutdown")?.({}, previous.ctx);
    const replacement = harness(cwd, previous.bus);
    replacement.ctx = { ...replacement.ctx, sessionManager: previous.ctx.sessionManager };
    h = replacement;
    const reloaded = await discoverAndLoadExtensions([extension.resolvedPath], cwd, join(root, "agent"), h.bus as never);
    expect(reloaded.errors).toEqual([]);
    reloaded.runtime.appendEntry = (type, data) => { h.ctx.sessionManager.appendCustomEntry(type, data); };
    reloaded.runtime.sendMessage = vi.fn(); reloaded.runtime.getActiveTools = () => []; reloaded.runtime.getCommands = () => [];
    const emitReload = async (name: string) => {
      for (const handler of reloaded.extensions[0].handlers.get(name) ?? []) await (handler as (event: unknown, ctx: ExtensionContext) => unknown)({ reason: "reload" }, h.ctx);
    };
    cleanup.push(async () => { h.close(); await emitReload("session_shutdown"); });
    if (order === "subagents-first") { await h.lifecycle.get("session_start")?.({ reason: "reload" }, h.ctx); await emitReload("session_start"); }
    else { await emitReload("session_start"); await h.lifecycle.get("session_start")?.({ reason: "reload" }, h.ctx); }
    workflowCommands = reloaded.extensions[0].commands;
    const reloadedTool = reloaded.extensions[0].tools.get("workflow")!.definition as unknown as Tool;
    await reloadedTool.execute("after reload", { script: 'export const meta = { name: "after reload", description: "test" }; return 1;', background: false }, undefined, undefined, h.ctx);
    await flush(); await openFromOverview("after reload");
    expect(h.bus.listeners.get(WORKFLOW_UI_CHANNELS.changed)?.size).toBe(1);
  });
});
