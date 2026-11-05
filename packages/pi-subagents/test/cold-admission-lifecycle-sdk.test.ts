import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { AgentSession, type ExtensionAPI, type ExtensionContext, ModelRegistry, ModelRuntime, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { AGENT_RECORD_ENTRY_TYPE } from "../src/agent-record-entry.js";
import { captureAgentReopenMetadata, validateAgentReopen } from "../src/agent-reopen.js";
import subagentsExtension from "../src/index.js";

const hookKey = Symbol.for("pi-subagents:test-cold-admission");
const modelA = getBuiltinModel("anthropic", "claude-sonnet-4-6");
const modelB = getBuiltinModel("anthropic", "claude-opus-4-6");

describe("cold admission and teardown on the offline native SDK", () => {
  let root: string;
  let previous: string | undefined;
  let manager: AgentManager;
  let parent: SessionManager;
  let ctx: ExtensionContext;
  let pi: ExtensionAPI;
  let provider: ReturnType<typeof fauxProvider>;
  let call: (params: Record<string, unknown>) => ReturnType<ToolDefinition["execute"]>;
  let fire: (name: string, event?: unknown) => Promise<void>;
  let native: AgentSession | undefined;
  let onStart: (api: ExtensionAPI) => Promise<void>;
  let onShutdown: () => Promise<void>;
  let dispose: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "cold-admission-sdk-"));
    previous = process.env.PI_CODING_AGENT_DIR;
    const agentDir = join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(agentDir);
    mkdirSync(join(root, ".pi", "agents"), { recursive: true });
    writeFileSync(join(root, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, agentMentions: "direct" }));
    writeDefinition();
    provider = fauxProvider({ provider: modelA.provider, api: modelA.api, models: [modelA, modelB] });
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(createProvider({ id: modelA.provider, baseUrl: modelA.baseUrl,
      models: [modelA, modelB], auth: provider.provider.auth, api: provider.provider }));
    await runtime.refresh({ allowNetwork: false });
    parent = SessionManager.create(root, join(root, "parents"));
    parent.appendMessage({ role: "user", content: "PRIVATE_PARENT", timestamp: Date.now() });
    const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
    const tools = new Map<string, ToolDefinition>();
    const listeners = new Map<string, ((payload: unknown) => void)[]>();
    pi = {
      on: (name: string, handler: (...args: unknown[]) => unknown) => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
      events: {
        on: (name: string, handler: (payload: unknown) => void) => { const list = listeners.get(name) ?? []; list.push(handler); listeners.set(name, list); return () => { const index = list.indexOf(handler); if (index >= 0) list.splice(index, 1); }; },
        emit: vi.fn((name: string, payload: unknown) => { for (const listener of listeners.get(name) ?? []) listener(payload); }),
      },
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand: vi.fn(), registerMessageRenderer: vi.fn(),
      appendEntry: (type: string, data: unknown) => parent.appendCustomEntry(type, data), sendMessage: vi.fn(),
      exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "", killed: false })),
      setModel: vi.fn(), setThinkingLevel: vi.fn(), getThinkingLevel: () => "off",
    } as unknown as ExtensionAPI;
    ctx = { cwd: root, mode: "tui", hasUI: false, isProjectTrusted: () => true, model: modelA, thinkingLevel: "off",
      modelRegistry: new ModelRegistry(runtime), sessionManager: parent, getSystemPrompt: () => "Parent instructions",
      isIdle: () => true, hasPendingMessages: () => false, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionContext;
    fire = async (name, event = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
    const restore = AgentManager.prototype.restoreSavedAgents;
    vi.spyOn(AgentManager.prototype, "restoreSavedAgents").mockImplementation(function (this: AgentManager, context) { manager = this; restore.call(this, context); });
    const bind = AgentSession.prototype.bindExtensions;
    vi.spyOn(AgentSession.prototype, "bindExtensions").mockImplementation(async function (this: AgentSession, ...args) { native = this; return bind.apply(this, args); });
    onStart = async () => {};
    onShutdown = async () => {};
    Reflect.set(globalThis, hookKey, { start: (api: ExtensionAPI) => onStart(api), shutdown: () => onShutdown() });
    subagentsExtension(pi);
    await fire("session_start");
    call = params => tools.get("Agent")!.execute("cold-call", { subagent_type: "Admission", description: "Task", ...params }, undefined, undefined, ctx as never);
  });

  afterEach(async () => {
    await fire("session_shutdown");
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, hookKey);
    for (const key of ["manager", "manager-active", "rpc-owner"]) Reflect.deleteProperty(globalThis, Symbol.for(`pi-subagents:${key}`));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });

  function writeDefinition(extension?: string) {
    writeFileSync(join(root, ".pi", "agents", "Admission.md"), `---\ndescription: Admission\ntools: none\nskills: false\nextensions: ${extension ? JSON.stringify([extension]) : "false"}\npersist_session: true\n---\nOffline fixture\n`);
  }

  async function initial() {
    provider.setResponses([fauxAssistantMessage(fauxText("first answer"))]);
    const result = await call({ prompt: "first task" });
    const id = (result.details as { agentId: string }).agentId;
    const receipt = captureAgentReopenMetadata(manager.getRecordMutable(id)!)!;
    manager.clearCompleted();
    await new Promise<void>(resolve => setImmediate(resolve));
    const extension = join(root, "startup.js");
    writeFileSync(extension, `export default function(pi) {
      pi.on("session_start", () => globalThis[Symbol.for("pi-subagents:test-cold-admission")].start(pi));
      pi.on("session_shutdown", () => globalThis[Symbol.for("pi-subagents:test-cold-admission")].shutdown());
    }`);
    writeDefinition(extension);
    return { id, receipt, lease: `${receipt.sessionFile}.subagents-lock` };
  }

  async function immediateRetries(id: string, handle: string) {
    await call({ prompt: "ID retry MUST NOT DISPATCH", resume: id });
    await fire("input", { source: "user", text: `@${handle} mention retry MUST NOT DISPATCH` });
    expect(provider.state.callCount).toBe(1);
    expect(manager.getRecordMutable(id)?.session).toBeUndefined();
    expect(pi.setModel).not.toHaveBeenCalled();
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
    expect(ctx.model?.id).toBe(modelA.id);
  }

  it.each(["route", "opaque"])("refuses session_start %s injection and immediate public ID/mention retries without a live bypass", async kind => {
    const { id, receipt } = await initial();
    let shutdowns = 0;
    onStart = async api => {
      dispose = vi.spyOn(native!, "dispose");
      if (kind === "route") expect(await api.setModel(modelB)).toBe(true);
      else native!.sessionManager.appendMessage({ ...fauxAssistantMessage(fauxText("opaque")), content: [{ type: "text", text: "opaque", textSignature: "unqualified" }] });
    };
    onShutdown = async () => { shutdowns++; };
    await call({ prompt: "refused continuation", resume: id });
    expect(manager.getRecord(id)).toMatchObject({ status: "error", error: expect.stringMatching(kind === "route" ? /route proof/ : /opaque or unknown replay/) });
    expect(manager.getRecordMutable(id)?.reopen).toEqual(receipt);
    expect(shutdowns).toBe(1);
    expect(dispose).toHaveBeenCalledOnce();
    await immediateRetries(id, receipt.handle);
    manager.clearCompleted();
    await new Promise<void>(resolve => setImmediate(resolve));
    await expect(call({ prompt: "cold retry", resume: id })).rejects.toThrow(/stale|opaque/);
    expect(provider.state.callCount).toBe(1);
  });

  it("quarantines callback exceptions after handoff and disposes before retry becomes possible", async () => {
    const { id, receipt } = await initial();
    const handoff = vi.fn((session: AgentSession) => { dispose = vi.spyOn(session, "dispose"); throw new Error("handoff observer failed"); });
    // Manager direct continuation exercises callback-exception ownership without
    // exposing the callback as a public Agent parameter.
    manager.reopen(pi, ctx, id, "refused", { description: "Task", onSessionCreated: handoff });
    await manager.getRecordMutable(id)!.promise;
    expect(handoff).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(manager.getRecord(id)?.error).toBe("handoff observer failed");
    await immediateRetries(id, receipt.handle);
    expect(manager.getRecordMutable(id)?.reopen?.route).toEqual(receipt.route);
  });

  it("keeps a rejected setup's lease through delayed shutdown and bounded manager disposal, disposing only once", async () => {
    const { id, receipt, lease } = await initial();
    let started!: () => void;
    const shutdownStarted = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    onStart = async api => { dispose = vi.spyOn(native!, "dispose"); await api.setModel(modelB); };
    onShutdown = async () => { started(); await held; native!.sessionManager.appendCustomEntry("late-shutdown", { settled: true }); };
    const attempt = call({ prompt: "rejected setup", resume: id });
    await shutdownStarted;
    const settled = manager.getRecordMutable(id)!.promise;
    try {
      await immediateRetries(id, receipt.handle);
      await manager.dispose();
      expect(existsSync(lease)).toBe(true);
      expect(dispose).not.toHaveBeenCalled();
      expect(() => manager.reopen(pi, ctx, id, "retry", { description: "Task" })).toThrow();
    } finally {
      release();
      await attempt;
      await settled;
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(dispose).toHaveBeenCalledOnce();
    expect(existsSync(lease)).toBe(false);
    expect(provider.state.callCount).toBe(1);
    expect(readFileSync(receipt.sessionFile, "utf8")).not.toContain("ID retry MUST NOT DISPATCH");
  });

  it("refreshes a cancelled A setup only after shutdown and only with valid original replay proof", async () => {
    const { id, receipt } = await initial();
    onStart = async () => { manager.abort(id); };
    onShutdown = async () => { native!.sessionManager.appendCustomEntry("closed-A", { settled: true }); };
    await call({ prompt: "cancelled", resume: id });
    expect(manager.getRecordMutable(id)?.session).toBeUndefined();
    const refreshed = manager.getRecordMutable(id)!.reopen!;
    expect(refreshed.route).toEqual(receipt.route);
    expect(refreshed.leafId).not.toBe(receipt.leafId);
    expect(() => validateAgentReopen({ ...manager.getResumable(id)!, reopen: refreshed }, ctx)).not.toThrow();
    manager.clearCompleted();
    await new Promise<void>(resolve => setImmediate(resolve));
    onStart = async () => {};
    provider.setResponses([fauxAssistantMessage(fauxText("after cancellation"))]);
    await call({ prompt: "after cancellation", resume: id });
    expect(manager.getRecord(id)?.result).toBe("after cancellation");
    expect(provider.state.callCount).toBe(2);
  });

  it("does not finalize teardown receipts into a replaced branch", async () => {
    const { id, receipt } = await initial();
    // Reopen without a startup mutation, then hold eviction's shutdown.
    provider.setResponses([fauxAssistantMessage(fauxText("second"))]);
    await call({ prompt: "second", resume: id });
    let release!: () => void;
    onShutdown = () => new Promise<void>(resolve => { release = resolve; });
    manager.clearCompleted();
    parent.branch(parent.getBranch()[0]!.id);
    manager.detachForBranchChange();
    manager.restoreSavedAgents(ctx);
    const before = JSON.stringify(parent.getBranch());
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(JSON.stringify(parent.getBranch())).toBe(before);
    expect(manager.getResumable(id)).toBeUndefined();
    expect(existsSync(`${receipt.sessionFile}.subagents-lock`)).toBe(false);
    expect(parent.getBranch().some(entry => entry.type === "custom" && entry.customType === AGENT_RECORD_ENTRY_TYPE)).toBe(false);
  });
});
