import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { type ExtensionAPI, type ExtensionContext, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { AGENT_RECORD_ENTRY_TYPE, savedResumableAgents } from "../src/agent-record-entry.js";
import { captureAgentReopenMetadata, validateAgentReopen } from "../src/agent-reopen.js";
import { runAgent } from "../src/agent-runner.js";
import { setAgentTiersSettings } from "../src/agent-tiers.js";
import { registerAgents } from "../src/agent-types.js";
import { INTERNAL_REOPEN_ROUTE } from "../src/internal-run.js";

const builtin = getBuiltinModel("anthropic", "claude-sonnet-4-6");

describe("cold catalog-route continuation on the offline native SDK", () => {
  let root: string;
  let previous: string | undefined;
  let manager: AgentManager;
  let parent: SessionManager;
  let ctx: ExtensionContext;
  let pi: ExtensionAPI;
  let child: ReturnType<typeof fauxProvider>;
  let runtime: ModelRuntime;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "cold-route-sdk-"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    setAgentTiersSettings({});
    registerAgents(new Map([["RouteTest", { name: "RouteTest", description: "Route test", systemPrompt: "Test", promptMode: "replace",
      builtinToolNames: [], extensions: false, skills: false, persistSession: true }]]));
    child = fauxProvider({ provider: builtin.provider, api: builtin.api, models: [builtin] });
    runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    // Public scripted transport, with real built-in catalog metadata; never
    // mutate the SDK catalog or dispatch the built-in network implementation.
    runtime.registerNativeProvider(createProvider({ id: builtin.provider, baseUrl: builtin.baseUrl,
      models: [builtin], auth: child.provider.auth, api: child.provider }));
    await runtime.refresh({ allowNetwork: false });
    parent = SessionManager.create(root, join(root, "parents"));
    parent.appendMessage({ role: "user", content: "PRIVATE_PARENT", timestamp: Date.now() });
    pi = { appendEntry: (type: string, data: unknown) => parent.appendCustomEntry(type, data),
      exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "", killed: false })),
      setModel: vi.fn(), setThinkingLevel: vi.fn(), getThinkingLevel: () => "off" } as unknown as ExtensionAPI;
    ctx = { cwd: root, mode: "print", hasUI: false, isProjectTrusted: () => true, model: builtin, thinkingLevel: "off",
      modelRegistry: new ModelRegistry(runtime), sessionManager: parent, getSystemPrompt: () => "Parent instructions" } as unknown as ExtensionContext;
    manager = new AgentManager(record => parent.appendCustomEntry(AGENT_RECORD_ENTRY_TYPE, {
      id: record.id, type: record.type, description: record.description, status: record.status, startedAt: record.startedAt,
      completedAt: record.completedAt, reopen: captureAgentReopenMetadata(record),
    }));
  });

  afterEach(async () => {
    await manager.dispose();
    vi.restoreAllMocks();
    registerAgents(new Map());
    setAgentTiersSettings({});
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });

  async function initial() {
    child.setResponses([fauxAssistantMessage(fauxText("first answer"))]);
    const { id } = await manager.spawnAndWait(pi, ctx, "RouteTest", "first task", { description: "Task" });
    const receipt = captureAgentReopenMetadata(manager.getRecordMutable(id)!)!;
    expect(receipt.route).toMatchObject({ provider: builtin.provider, api: builtin.api, modelId: builtin.id, baseUrl: builtin.baseUrl });
    manager.clearCompleted();
    await new Promise<void>(resolve => setImmediate(resolve));
    manager.restoreSavedAgents(ctx);
    return { id, receipt };
  }

  it("continues a proven plain catalog route repeatedly with no main model/thinking mutation", async () => {
    const { id, receipt } = await initial();
    const originalModel = ctx.model;
    for (const task of ["second task", "third task"]) {
      child.setResponses([(context, _options, _state, model) => {
        expect(model).toMatchObject({ provider: receipt.route!.provider, id: receipt.route!.modelId, api: receipt.route!.api, baseUrl: receipt.route!.baseUrl });
        expect(JSON.stringify(context)).toContain("first task");
        expect(JSON.stringify(context)).not.toContain("PRIVATE_PARENT");
        return fauxAssistantMessage(fauxText(task));
      }]);
      manager.reopen(pi, ctx, id, task, { description: "Task" });
      await manager.getRecordMutable(id)!.promise;
      expect(manager.getRecord(id)).toMatchObject({ status: "completed", result: task });
      expect(manager.getRecordMutable(id)!.session!.thinkingLevel).toBe("off");
      manager.clearCompleted();
      await new Promise<void>(resolve => setImmediate(resolve));
      manager.restoreSavedAgents(ctx);
    }
    expect(child.state.callCount).toBe(3);
    expect(ctx.model).toBe(originalModel);
    expect(ctx.thinkingLevel).toBe("off");
    expect(pi.setModel).not.toHaveBeenCalled();
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  it.each(["eviction", "shutdown"])("finalizes the saved leaf after %s journal writes before reload", async mode => {
    child.setResponses([fauxAssistantMessage(fauxText("first answer"))]);
    const { id } = await manager.spawnAndWait(pi, ctx, "RouteTest", "first task", { description: "Task" });
    const session = manager.getRecordMutable(id)!.session!;
    const runner = session.extensionRunner!;
    const emit = runner.emit.bind(runner);
    vi.spyOn(runner, "emit").mockImplementation(async event => {
      if (event.type === "session_shutdown") session.sessionManager.appendCustomEntry("shutdown-state", { closed: true });
      return emit(event);
    });
    if (mode === "eviction") manager.clearCompleted();
    else await manager.dispose();
    await new Promise<void>(resolve => setImmediate(resolve));
    const entry = mode === "eviction" ? manager.getResumable(id)!
      : savedResumableAgents(parent.getBranch(), parent.getSessionId()).find(item => item.id === id)!;
    expect(() => validateAgentReopen(entry, ctx)).not.toThrow();
    await manager.dispose();
    manager = new AgentManager();
    manager.restoreSavedAgents(ctx);
    expect(() => validateAgentReopen(manager.getResumable(id)!, ctx)).not.toThrow();
    expect(manager.getResumable(id)?.reopen?.leafId).toBe(SessionManager.open(entry.sessionFile).getLeafId());
  });

  it("holds the native lease while a foreground live resume ignores abort after disposal returns", async () => {
    child.setResponses([fauxAssistantMessage(fauxText("first answer"))]);
    const { id } = await manager.spawnAndWait(pi, ctx, "RouteTest", "first task", { description: "Task" });
    const session = manager.getRecordMutable(id)!.session!;
    const lease = `${session.sessionManager.getSessionFile()}.subagents-lock`;
    let release!: () => void;
    vi.spyOn(session, "prompt").mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    vi.spyOn(session, "abort").mockResolvedValue();
    const resumed = manager.resume(id, "held foreground");
    expect(session.prompt).toHaveBeenCalledOnce();
    await manager.dispose();
    await new Promise<void>(resolve => setImmediate(resolve));
    try {
      expect(existsSync(lease)).toBe(true);
    } finally {
      release();
      await resumed;
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(existsSync(lease)).toBe(false);
  });

  it.each(["provider", "api", "endpoint", "secret-path", "model", "virtual", "missing"])("refuses unknown %s before native cold allocation, lease or dispatch", async kind => {
    const { id, receipt } = await initial();
    const secretUrl = `${builtin.baseUrl}/tenant/SECRET-PATH-CREDENTIAL`;
    ctx.model = kind === "missing" ? undefined : { ...builtin,
      ...(kind === "provider" ? { provider: "unknown-provider" } : {}),
      ...(kind === "api" ? { api: "unknown-api" } : {}),
      ...(kind === "virtual" ? { api: "pi-virtual" } : {}),
      ...(kind === "model" ? { id: "uncatalogued-model" } : {}),
      ...(kind === "endpoint" ? { baseUrl: "https://unknown.example/v1" } : {}),
      ...(kind === "secret-path" ? { baseUrl: secretUrl } : {}),
    };
    const journal = readFileSync(receipt.sessionFile, "utf8");
    const parentBefore = JSON.stringify(parent.getEntries());
    const onSpawned = vi.fn();
    expect(() => manager.reopen(pi, ctx, id, "MUST NOT SEND", { description: "Task", onSpawned })).toThrow(/route proof.*fresh Agent.*sanitized task summary/);
    try { manager.reopen(pi, ctx, id, "MUST NOT SEND", { description: "Task" }); } catch (error) {
      expect(String(error)).not.toContain(secretUrl);
      expect(String(error)).not.toContain("SECRET-PATH-CREDENTIAL");
    }
    expect(onSpawned).not.toHaveBeenCalled();
    expect(manager.listAgents()).toEqual([]);
    expect(existsSync(`${receipt.sessionFile}.subagents-lock`)).toBe(false);
    expect(readFileSync(receipt.sessionFile, "utf8")).toBe(journal);
    expect(JSON.stringify(parent.getEntries())).toBe(parentBefore);
    expect(child.state.callCount).toBe(1);
    expect(pi.setModel).not.toHaveBeenCalled();
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  it.each(["builtin-override", "custom-provider"])("runs fresh %s normally without retaining its secret-path endpoint in receipts or native ownership", async kind => {
    const secretUrl = `${builtin.baseUrl}/tenant/SECRET-PATH-CREDENTIAL`;
    const custom = { ...builtin, baseUrl: secretUrl,
      ...(kind === "custom-provider" ? { provider: "custom-provider", api: "custom-scripted-api" } : {}) };
    const scripted = fauxProvider({ provider: custom.provider, api: custom.api, models: [custom] });
    runtime.registerNativeProvider(createProvider({ id: custom.provider, baseUrl: custom.baseUrl,
      models: [custom], auth: scripted.provider.auth, api: scripted.provider }));
    await runtime.refresh({ allowNetwork: false });
    ctx.model = custom;
    scripted.setResponses([fauxAssistantMessage(fauxText("custom works"))]);
    const { id } = await manager.spawnAndWait(pi, ctx, "RouteTest", "fresh custom task", { description: "Task" });
    expect(manager.getRecord(id)).toMatchObject({ status: "completed", result: "custom works" });
    expect(scripted.state.callCount).toBe(1);
    const receipt = captureAgentReopenMetadata(manager.getRecordMutable(id)!)!;
    expect(receipt.route).toBeUndefined();
    const native = SessionManager.open(receipt.sessionFile);
    const marker = native.getEntries().find(entry => entry.type === "custom" && entry.customType === "subagents:identity");
    expect(marker?.type === "custom" && marker.data).not.toHaveProperty("route");
    const failed = await manager.spawnAndWait(pi, ctx, "RouteTest", "failed fresh setup", { description: "Task",
      onSessionCreated: () => { throw new Error("fresh handoff failed"); } });
    expect(failed.record.status).toBe("error");
    const failedReceipt = captureAgentReopenMetadata(failed.record)!;
    expect(failedReceipt.route).toBeUndefined();
    // Before a first prompt, the native journal may still be buffered in memory.
    const failedEntries = failed.record.session!.sessionManager.getEntries();
    const failedMarker = failedEntries.find(entry => entry.type === "custom" && entry.customType === "subagents:identity");
    expect(failedMarker?.type === "custom" && failedMarker.data).not.toHaveProperty("route");
    expect(JSON.stringify([failedReceipt, failedEntries])).not.toContain("SECRET-PATH-CREDENTIAL");
    // A custom queued spawn cancelled before setup must not synthesize proof.
    manager.setMaxConcurrent(1);
    const session = manager.getRecordMutable(id)!.session!;
    let release!: () => void;
    vi.spyOn(session, "prompt").mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    await manager.resume(id, "held", undefined, { isBackground: true });
    try {
      const queued = manager.spawn(pi, ctx, "RouteTest", "queued custom task", { description: "Task", isBackground: true });
      expect(manager.getRecord(queued)?.status).toBe("queued");
      expect(manager.abort(queued)).toBe(true);
      expect(captureAgentReopenMetadata(manager.getRecordMutable(queued)!)).toBeUndefined();
    } finally {
      release();
      await manager.waitForAll();
    }
    manager.clearCompleted();
    await new Promise<void>(resolve => setImmediate(resolve));
    manager.restoreSavedAgents(ctx);
    expect(manager.getResumable(id)?.reopen?.route).toBeUndefined();
    const serialized = JSON.stringify([parent.getEntries(), manager.getResumable(id), receipt]) + readFileSync(receipt.sessionFile, "utf8");
    expect(serialized).not.toContain(secretUrl);
    expect(serialized).not.toContain("SECRET-PATH-CREDENTIAL");
    expect(() => manager.reopen(pi, ctx, id, "cold refused", { description: "Task" })).toThrow(/route proof.*fresh Agent.*sanitized task summary/);
    expect(scripted.state.callCount).toBe(1);
    expect(manager.listAgents()).toEqual([]);
    expect(existsSync(`${receipt.sessionFile}.subagents-lock`)).toBe(false);
  });

  it("the real runner refuses a changed catalog endpoint before environment/resources/session/provider setup", async () => {
    const { receipt } = await initial();
    ctx.model = { ...builtin, baseUrl: "https://changed.example/v1" };
    vi.mocked(pi.exec).mockClear();
    await expect(runAgent(ctx, "RouteTest", "must not send", { pi, resumeSessionFile: receipt.sessionFile,
      [INTERNAL_REOPEN_ROUTE]: { route: receipt.route! } })).rejects.toThrow(/route proof/);
    expect(pi.exec).not.toHaveBeenCalled();
    expect(child.state.callCount).toBe(1);
    expect(pi.setModel).not.toHaveBeenCalled();
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
  });
});
