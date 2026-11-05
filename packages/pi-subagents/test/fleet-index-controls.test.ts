import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { replyChannel, WORKFLOW_UI_CHANNELS } from "@signalridge/pi-subagents-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { mockParentRegistry } from "./helpers/model-runtime.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
class Bus {
  listeners = new Map<string, Set<(data: unknown) => void>>();
  on(event: string, handler: (data: unknown) => void) {
    const set = this.listeners.get(event) ?? new Set(); set.add(handler); this.listeners.set(event, set);
    return () => { set.delete(handler); if (!set.size) this.listeners.delete(event); };
  }
  emit(event: string, data: unknown) { for (const handler of [...this.listeners.get(event) ?? []]) handler(data); }
}
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const owner = { extension: "pi-workflows" as const, runId: "run", nodeId: "call-1", attemptId: "attempt-1" };
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
type Result = { content: Array<{ text: string }>; details?: { status: string; agentId?: string; tokens?: string } };
type Tool = { name: string; execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, update: ((result: unknown) => void) | undefined, ctx: ExtensionContext) => Promise<Result> };

function harness(cwd: string, mode = "tui") {
  const bus = new Bus(); const tools = new Map<string, Tool>();
  const lifecycle = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  let input: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let widget: Component | undefined;
  let viewer: (Component & { dispose?(): void }) | undefined;
  let close: (() => void) | undefined;
  let focus: unknown = { getText: () => "", setText: () => {} };
  const host = { mode: undefined as string | undefined, terminal: { rows: 40, columns: 120 }, getFocusedComponent: () => focus, requestRender: vi.fn() };
  const tui = host as unknown as TUI;
  const ui = {
    setStatus: vi.fn(), notify: vi.fn(), getEditorText: vi.fn(() => ""),
    setWidget: vi.fn((_: string, factory: ((tui: TUI, theme: typeof theme) => Component) | undefined) => { widget = factory?.(tui, theme); }),
    onTerminalInput: vi.fn((handler: typeof input) => { input = handler; return () => { input = undefined; }; }),
    custom: vi.fn((factory: (tui: TUI, theme: typeof theme, keys: undefined, done: (result: undefined) => void) => Component, _options?: unknown) => new Promise<undefined>(resolve => {
      close = () => { viewer?.dispose?.(); resolve(undefined); close = undefined; focus = { getText: () => "", setText: () => {} }; };
      viewer = factory(tui, theme, undefined, close); focus = viewer;
    })),
    select: vi.fn(async (_title: string, _options: string[]): Promise<string | undefined> => undefined),
    confirm: vi.fn(async (): Promise<boolean> => false),
  };
  const ctx = { cwd, mode, hasUI: mode === "tui", isProjectTrusted: () => true, ui,
    modelRegistry: { ...mockParentRegistry, find: vi.fn(), getAvailable: () => [] },
    sessionManager: { getSessionId: () => "root", getBranch: () => [] }, getSystemPrompt: () => "parent",
  } as unknown as ExtensionCommandContext;
  const pi = { events: bus, registerMessageRenderer: vi.fn(), registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, command),
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => lifecycle.set(name, handler),
    appendEntry: vi.fn(), sendMessage: vi.fn(),
  };
  subagentsExtension(pi as never);
  return { bus, tools, lifecycle, commands, ctx, ui, pi, input: (key: string) => input?.(key), widget: () => widget, viewer: () => viewer,
    close: () => close?.(), focus: (next: unknown) => { focus = next; }, mode: (mode: string) => { host.mode = mode; } };
}

function nativeSeam() {
  const messages: AgentSession["messages"] = [];
  const subscribers = new Set<(event: AgentSessionEvent) => void>();
  const session = { messages, state: { messages }, subscribe: (handler: (event: AgentSessionEvent) => void) => { subscribers.add(handler); return () => subscribers.delete(handler); },
    steer: vi.fn(async () => "handled"), getSteeringMessages: () => [], dispose: vi.fn(),
  } as unknown as AgentSession;
  function append(prompt: string, text: string) {
    messages.push({ role: "user", content: prompt, timestamp: 0 });
    messages.push({ role: "assistant", content: [{ type: "text", text }], timestamp: 1 } as never);
    for (const subscriber of [...subscribers]) subscriber({ type: "turn_end" } as AgentSessionEvent);
  }
  return { session, append, subscribers };
}

describe("real index UI controls and managed thread transcript wiring", () => {
  let root: string; let cwd: string; let previousAgentDir: string | undefined;
  let h: ReturnType<typeof harness>;
  let seam: ReturnType<typeof nativeSeam>;
  let running: ReturnType<typeof deferred<Awaited<ReturnType<typeof runAgent>>>>;
  let manager: AgentManager;
  let options: Parameters<typeof runAgent>[3];
  let resumeOptions: Parameters<typeof resumeAgent>[2];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "fleet-index-controls-")); cwd = join(root, "project"); mkdirSync(join(cwd, ".pi"), { recursive: true });
    const agentDir = join(root, "agent"); mkdirSync(agentDir); previousAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, defaultJoinMode: "async", maxConcurrent: 1 }));
    seam = nativeSeam(); running = deferred();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, callbacks) => { options = callbacks; await Promise.resolve(); callbacks.onSessionCreated?.(seam.session); return running.promise; });
    vi.mocked(resumeAgent).mockImplementation(async (_session, _prompt, callbacks) => { resumeOptions = callbacks; return { text: "B" }; });
    const spy = vi.spyOn(AgentManager.prototype, "spawnManaged");
    h = harness(cwd); await h.lifecycle.get("session_start")?.({}, h.ctx);
    // Only used by managed tests. The manager stays real; capture its receiver.
    manager = undefined as unknown as AgentManager;
    const capture = () => { manager = spy.mock.contexts.at(-1)!; };
    h.bus.on("test:capture", capture);
  });
  afterEach(async () => {
    running.resolve({ responseText: "done", session: seam.session, aborted: false, steered: false });
    h.close(); await h.lifecycle.get("session_shutdown")?.({}, h.ctx);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.clearAllMocks();
  });

  async function managed(attemptId = "attempt-1", nodeId = "call-1") {
    const requestId = `${nodeId}-${attemptId}`;
    const reply = deferred<{ success: boolean; data: { id: string }; error?: string }>();
    const off = h.bus.on(`subagents:rpc:spawn-managed:reply:${requestId}`, raw => reply.resolve(raw as never));
    h.bus.emit("subagents:rpc:spawn-managed", { requestId, spawnKey: requestId, type: "Explore", prompt: attemptId === "attempt-1" ? "A" : "B", description: "thread", thread: "thread", owner: { ...owner, nodeId, attemptId } });
    const response = await reply.promise; off(); h.bus.emit("test:capture", {});
    expect(response.success, response.error).toBe(true); await flush(); return manager.getRecordMutable(response.data.id)!;
  }
  async function openOwned(record: AgentRecord, requestedOwner = { ...owner }) {
    const requestId = "open"; const reply = deferred<unknown>();
    const off = h.bus.on(replyChannel(WORKFLOW_UI_CHANNELS.openConversation, requestId), reply.resolve);
    h.bus.emit(WORKFLOW_UI_CHANNELS.openConversation, { requestId, agentId: record.id, owner: requestedOwner });
    const result = await reply.promise; off(); return result;
  }
  async function completeA() {
    options.onToolActivity?.({ type: "end", toolName: "read" }); options.onAssistantUsage?.({ input: 10, output: 5, cacheWrite: 2 });
    seam.append("A", "A answer"); running.resolve({ responseText: "A answer", session: seam.session, aborted: false, steered: false });
    await flush();
  }

  it("reuses a managed A+B thread without truncation/replay or resetting lifetime tools/tokens; emits per-attempt accounting", async () => {
    const events: Array<Record<string, unknown>> = []; h.bus.on("subagents:completed", raw => events.push(raw as Record<string, unknown>));
    const record = await managed(); options.onCompaction?.({ reason: "manual", tokensBefore: 100 }); await completeA();
    const path = record.outputFile!; const prefix = readFileSync(path, "utf-8");
    const resume = deferred<{ text: string }>();
    vi.mocked(resumeAgent).mockImplementation(async (_session, _prompt, callbacks) => { resumeOptions = callbacks; return resume.promise; });
    const beforeSubscribers = seam.subscribers.size;
    const next = await managed("attempt-2", "call-2"); expect(next).toBe(record); expect(next.session).toBe(seam.session);
    expect(readFileSync(path, "utf-8")).toBe(prefix); expect(seam.subscribers.size).toBe(beforeSubscribers + 1);
    expect(h.widget()).toBeUndefined(); // Managed children do not duplicate the workflow overview.
    // Idempotent retry must not subscribe, reset tracking or touch the file.
    await managed("attempt-2", "call-2"); expect(seam.subscribers.size).toBe(beforeSubscribers + 1); expect(readFileSync(path, "utf-8")).toBe(prefix);
    await openOwned(next, { ...owner, nodeId: "call-2", attemptId: "attempt-2" }); await flush();
    expect(h.viewer()!.render(200).join("\n")).toContain("17 tokens");
    expect(record.compactionCount).toBe(1); expect(h.viewer()!.render(200).join("\n")).toContain("compactions 1");
    resumeOptions?.onToolActivity?.({ type: "end", toolName: "read" }); resumeOptions?.onAssistantUsage?.({ input: 3, output: 2, cacheWrite: 1 });
    seam.append("B", "B answer");
    expect(h.viewer()!.render(200).join("\n")).toContain("23 tokens");
    resume.resolve({ text: "B answer" }); await flush();
    const transcript = readFileSync(path, "utf-8").trim().split("\n").map(line => JSON.parse(line));
    expect(transcript).toHaveLength(4); expect(transcript.map(row => row.message.content)).toEqual(["A", [{ type: "text", text: "A answer" }], "B", [{ type: "text", text: "B answer" }]]);
    expect(record.toolUses).toBe(2); expect(record.lifetimeUsage).toEqual({ input: 13, output: 7, cacheWrite: 3 });
    expect(events[0].tokens).toEqual({ input: 10, output: 5, total: 17 }); expect(events[0].managedTokens).toEqual({ input: 10, output: 5, total: 17 });
    expect(events[1].tokens).toEqual({ input: 13, output: 7, total: 23 }); expect(events[1].managedTokens).toEqual({ input: 3, output: 2, total: 6 });
    expect(seam.subscribers.size).toBe(1); // only the open viewer, not old/new output subscriptions
  });

  it("acknowledges owned admission before dialog construction, denies stale/incomplete owners, and keeps old attempt controls read-only", async () => {
    const record = await managed();
    const before = h.ui.custom.mock.calls.length;
    expect(await openOwned(record, { ...owner, attemptId: "wrong" })).toMatchObject({ success: false }); expect(h.ui.custom.mock.calls).toHaveLength(before);
    let customAtReply = -1;
    const off = h.bus.on(replyChannel(WORKFLOW_UI_CHANNELS.openConversation, "open"), () => { customAtReply = h.ui.custom.mock.calls.length; });
    expect(await openOwned(record)).toEqual({ success: true, data: { accepted: true } }); off(); expect(customAtReply).toBe(before);
    await flush(); const oldViewer = h.viewer()!; oldViewer.handleInput!("\r"); for (const char of "draft") oldViewer.handleInput!(char);
    await completeA(); await managed("attempt-2", "call-2");
    oldViewer.handleInput!("\r"); oldViewer.handleInput!("s"); oldViewer.handleInput!("s");
    expect(seam.session.steer).not.toHaveBeenCalled(); expect(oldViewer.render(200).join("\n")).toContain("draft retained");
    h.close(); await flush(); expect(await openOwned(record)).toMatchObject({ success: false });
    record.session = undefined; expect(await openOwned(record, { ...owner, nodeId: "call-2", attemptId: "attempt-2" })).toMatchObject({ success: false });
  });

  it("uses the fullscreen viewer without an extra shared border in the existing /agents menu", async () => {
    await managed(); h.mode("fullscreen");
    const seen = new Set<string>();
    h.ui.select.mockImplementation(async (title, rows) => { if (seen.has(title)) return undefined; seen.add(title); return rows[0]; });
    const command = h.commands.get("agents")!.handler("", h.ctx); await flush();
    const options = h.ui.custom.mock.calls[0][1] as { overlay: boolean; overlayOptions: () => unknown };
    expect(options.overlay).toBe(true);
    expect(options.overlayOptions()).toEqual({ anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 });
    expect(h.viewer()!.render(120).length).toBeLessThanOrEqual(40);
    h.close(); await command;
  });

  it("keeps the explicit retained-child fallback reachable from /agents without Fleet rows or an owner peer", async () => {
    await managed();
    const offered = new Set<string>();
    h.ui.select.mockImplementation(async (title, rows) => {
      if (offered.has(title)) return undefined;
      offered.add(title);
      if (title === "Agents") return rows.find(row => row.startsWith("Retained workflow children ("));
      if (title === "Workflow child access") return "Inspect retained children";
      return rows[0];
    });
    const command = h.commands.get("agents")!.handler("", h.ctx); await flush();
    expect(h.widget()).toBeUndefined();
    expect(h.viewer()!.render(120).join("\n")).toContain("1 retained children");
    h.viewer()!.handleInput!("\r");
    expect(h.viewer()!.render(120).join("\n")).toContain("thread");
    h.close(); await command;
  });

  it("fences menu selections captured before await and queued stop confirmations", async () => {
    const record = await managed();
    const selection = deferred<string | undefined>(); let menuRow = "";
    let menuOffered = false;
    h.ui.select.mockImplementation(async (title, rows) => { if (title === "Agents") { if (menuOffered) return undefined; menuOffered = true; return rows[0]; } if (title === "Agent runs") { menuRow = rows[0]; return selection.promise; } return undefined; });
    const command = h.commands.get("agents")!.handler("", h.ctx); await flush();
    expect(menuRow).toContain("thread"); await completeA(); await managed("attempt-2", "call-2");
    selection.resolve(menuRow); await command; expect(h.ui.custom).not.toHaveBeenCalled();
    const current = manager.getRecordMutable(record.id)!;
    current.session = undefined; current.status = "queued";
    const confirmation = deferred<boolean>();
    h.ui.confirm.mockImplementation(() => confirmation.promise);
    let selected = false;
    h.ui.select.mockImplementation(async (title, rows) => { if (title === "Agents") return selected ? undefined : rows[0]; if (title === "Agent runs") { if (selected) return undefined; selected = true; return rows[0]; } return undefined; });
    const queuedCommand = h.commands.get("agents")!.handler("", h.ctx); await flush();
    expect(h.ui.confirm).toHaveBeenCalledOnce();
    current.owner = { ...owner, nodeId: "call-3", attemptId: "attempt-3" }; confirmation.resolve(true); await queuedCommand;
    expect(current.status).toBe("queued"); expect(h.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Stopped queued"), "info");
  });

  it("retires metadata, admission and Fleet listeners on committed tree/root changes even with the same UI object; rejects headless admission", async () => {
    const record = await managed();
    const oldSnapshot = { version: 1, surfaceId: "old-surface", runs: [{ version: 1, surfaceId: "old-surface", runId: "meta-run", name: "old branch metadata", status: "running", callCount: 0, runningCalls: 0, completedCalls: 0, failedCalls: 0, elapsedMs: 0, restored: false }] };
    h.bus.emit(WORKFLOW_UI_CHANNELS.changed, oldSnapshot);
    expect(h.widget()).toBeUndefined(); // Metadata remains usable for explicit owner delegation only.
    const oldInputCleanup = h.ui.onTerminalInput.mock.results[0].value;
    expect(typeof oldInputCleanup).toBe("function");
    await h.lifecycle.get("session_tree")?.({}, h.ctx);
    expect(h.ui.onTerminalInput).toHaveBeenCalledTimes(2);
    h.bus.emit(WORKFLOW_UI_CHANNELS.changed, oldSnapshot);
    expect(h.widget()?.render(200).join("\n") ?? "").not.toContain("old branch metadata");
    expect(h.bus.listeners.get(WORKFLOW_UI_CHANNELS.changed)?.size).toBe(1);
    expect(h.bus.listeners.get(WORKFLOW_UI_CHANNELS.openConversation)?.size).toBe(1);
    expect(await openOwned(record)).toMatchObject({ success: false });
    const headless = { ...h.ctx, mode: "print", hasUI: false } as ExtensionCommandContext;
    await h.lifecycle.get("session_start")?.({}, headless);
    expect(h.widget()).toBeUndefined(); expect(h.bus.listeners.has(WORKFLOW_UI_CHANNELS.changed)).toBe(false);
    expect(await openOwned(record)).toMatchObject({ success: false });
    await h.lifecycle.get("session_shutdown")?.({}, headless);
    expect(h.bus.listeners.has(WORKFLOW_UI_CHANNELS.openConversation)).toBe(false);
    expect([...h.bus.listeners.keys()].filter(key => key.includes(":ui:") || key.includes(":reply:"))).toEqual([]);
  });

  it("Ctrl+B hands off a live foreground tool, stops only spinner updates and retains activity/transcript through final completion", async () => {
    const updates = vi.fn(); const parent = new AbortController();
    const waiter = h.tools.get("Agent")!.execute("foreground", { prompt: "A", description: "foreground", subagent_type: "Explore" }, parent.signal, updates, h.ctx);
    await flush();
    expect(h.input("\x1b[98;5:3u")).toBeUndefined(); // kitty release
    h.focus({ render: () => [] }); expect(h.input("\x02")).toBeUndefined();
    h.focus({ getText: () => "", setText: () => {} }); h.ui.getEditorText.mockReturnValue("draft"); expect(h.input("\x02")).toBeUndefined();
    h.ui.getEditorText.mockReturnValue(""); expect(h.input("\x02")).toEqual({ consume: true });
    const result = await waiter; expect(result.content[0].text).toContain("continues in background"); expect(result.content[0].text).not.toContain("completed");
    expect(result.details?.status).toBe("background"); expect(result.content[0].text).toContain(result.details!.agentId!);
    const count = updates.mock.calls.length; parent.abort(); expect(options.signal?.aborted).toBe(false);
    options.onTextDelta?.("working", "working after handoff"); options.onAssistantUsage?.({ input: 100, output: 2, cacheWrite: 0 });
    expect(updates).toHaveBeenCalledTimes(count); expect(h.widget()!.render(200).join("\n")).toContain("102 tokens");
    const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as { getRecord(id: string): AgentRecord };
    const record = registry.getRecord(result.details!.agentId!); const path = record.outputFile!;
    const prefix = readFileSync(path, "utf-8"); seam.append("A", "final after handoff");
    running.resolve({ responseText: "final after handoff", session: seam.session, aborted: false, steered: false }); await flush();
    expect(readFileSync(path, "utf-8").startsWith(prefix)).toBe(true); expect(readFileSync(path, "utf-8")).toContain("final after handoff");
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(0); // held for the normal bounded nudge delay
    expect(registry.getRecord(result.details!.agentId!).resultConsumed).toBe(false);
  });
});
