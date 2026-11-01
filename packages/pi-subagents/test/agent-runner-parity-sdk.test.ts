import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { type AgentSession, type ExtensionAPI, type ExtensionContext, ModelRegistry, ModelRuntime, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { type RunOptions, runAgent, setDefaultModel } from "../src/agent-runner.js";
import { setAgentTiersSettings } from "../src/agent-tiers.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { AGENT_DEFINITION_GENERATION_OVERRIDE, INTERNAL_AGENT_CONFIG_OVERRIDE, INTERNAL_PARENT_POLICY_SNAPSHOT, INTERNAL_RESOLVED_ISOLATED } from "../src/internal-run.js";
import { setScopeModelsEnabled } from "../src/model-scope.js";
import { shutdownAndDisposeSession } from "../src/session-lifecycle.js";
import type { AgentConfig, AgentRecordSnapshot } from "../src/types.js";

vi.setConfig({ testTimeout: 30_000 });

describe("runner isolation and final no-tier scope (faux SDK)", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let previousAgentDir: string | undefined;
  let ctx: ExtensionContext;
  let faux: ReturnType<typeof fauxProvider>;
  const sessions: AgentSession[] = [];
  const cleanups: Array<() => Promise<void>> = [];
  let providerCall: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "subagent-runner-parity-"));
    cwd = join(root, "project");
    agentDir = join(root, "global");
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    mkdirSync(agentDir);
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    faux = fauxProvider({ provider: "parity-faux", models: [{ id: "allowed", reasoning: true }, { id: "outside", reasoning: true }] });
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.refresh({ allowNetwork: false });
    const model = runtime.getModel("parity-faux", "outside");
    if (!model) throw new Error("Missing faux model");
    ctx = {
      cwd, model, modelRegistry: new ModelRegistry(runtime), isProjectTrusted: () => true,
      hasUI: true, mode: "rpc", ui: { notify: vi.fn(), setWidget: vi.fn(), setStatus: vi.fn() },
      sessionManager: SessionManager.inMemory(cwd), getSystemPrompt: () => "parent",
    } as unknown as ExtensionContext;
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["parity-faux/allowed"] }));
    setAgentTiersSettings({});
    setScopeModelsEnabled(true);
    setDefaultModel(undefined);
    registerAgents(new Map());
    providerCall = vi.fn(() => fauxAssistantMessage(fauxText("FAUX_OK")));
    faux.setResponses([providerCall]);
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    for (const session of sessions.splice(0)) await shutdownAndDisposeSession(session);
    faux.setResponses([]);
    registerAgents(new Map());
    setAgentTiersSettings({});
    setScopeModelsEnabled(false);
    setDefaultModel(undefined);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  function config(fields: Partial<AgentConfig> = {}) {
    registerAgents(new Map([["general-purpose", {
      name: "general-purpose", description: "fixture", builtinToolNames: [], extensions: false,
      skills: false, systemPrompt: "fixture", promptMode: "replace", ...fields,
    } satisfies AgentConfig]]));
  }
  const pi = { exec: async () => ({ code: 1, killed: false, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
  async function run(options: Partial<RunOptions> = {}, parent = ctx) {
    return runAgent(parent, "general-purpose", "go", { pi, onSessionCreated: session => sessions.push(session), supervisorQuestions: false, ...options });
  }

  it("refuses explicit no-tier Model overrides before session/provider dispatch", async () => {
    config();
    await expect(run({ model: ctx.model })).rejects.toThrow("Model not in scope");
    expect(providerCall).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(0);
  });

  it.each(["omitted", "null", "default", "frontmatter"])("warns but runs standing no-tier policy: %s", async source => {
    config(source === "frontmatter" ? { model: "parity-faux/outside" } : {});
    if (source === "default") setDefaultModel("parity-faux/outside");
    const result = await run(source === "null" ? { model: null } as unknown as Partial<RunOptions> : {});
    expect(result.responseText).toBe("FAUX_OK");
    expect(result.session.model?.id).toBe("outside");
    expect(ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("out-of-scope"), "warning");
    expect(providerCall).toHaveBeenCalledOnce();
  });

  it("admits an in-scope explicit no-tier Model", async () => {
    config();
    const result = await run({ model: ctx.modelRegistry.find("parity-faux", "allowed") });
    expect(result.session.model?.id).toBe("allowed");
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it.each(["call", "frontmatter", "default"])("does not scope-check a discarded legacy Model when a %s tier wins", async source => {
    config(source === "frontmatter" ? { agentTier: "selected" } : {});
    setAgentTiersSettings({ profiles: { selected: { model: "parity-faux/allowed", thinking: "inherit" } }, ...(source === "default" ? { defaultTier: "selected" } : {}) });
    const result = await run({ model: ctx.model, ...(source === "call" ? { agentTier: "selected" } : {}) });
    expect(result.session.model?.id).toBe("allowed");
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it.each([false, true])("uses captured config authority, not execution cwd or later trust (trusted=%s)", async trusted => {
    config();
    const execution = join(root, "execution");
    mkdirSync(join(execution, ".pi"), { recursive: true });
    writeFileSync(join(execution, ".pi", "settings.json"), JSON.stringify({ enabledModels: [] }));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ enabledModels: [] }));
    let liveTrust = trusted;
    const parent = { ...ctx, isProjectTrusted: () => liveTrust };
    const work = run({ model: ctx.model, cwd: execution, configCwd: cwd, pi: { exec: async () => {
      liveTrust = !trusted;
      return { code: 1, stdout: "", stderr: "" };
    } } as unknown as ExtensionAPI }, parent);
    if (trusted) {
      expect((await work).session.model?.id).toBe("outside");
      expect(providerCall).toHaveBeenCalledOnce();
    } else {
      await expect(work).rejects.toThrow("Model not in scope");
      expect(providerCall).not.toHaveBeenCalled();
    }
  });

  it.each([
    { definition: true, caller: false, isolated: true },
    { definition: false, caller: true, isolated: false },
    { definition: undefined, caller: true, isolated: true },
  ])("direct runner honors explicit definition isolation: %j", async ({ definition, caller, isolated }) => {
    const marker = join(root, "factory-ran");
    const extension = join(root, "probe.js");
    writeFileSync(extension, `import { writeFileSync } from "node:fs"; export default function() { writeFileSync(${JSON.stringify(marker)}, "ran"); }`);
    const skill = join(cwd, ".pi", "skills", "probe");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: probe\ndescription: fixture\n---\nSKILL_PROBE");
    config({ isolated: definition, extensions: [extension], skills: ["probe"] });
    const { session } = await run({ isolated: caller });
    expect(existsSync(marker)).toBe(!isolated);
    expect(session.systemPrompt.includes("SKILL_PROBE")).toBe(!isolated);
    expect(session.resourceLoader.getExtensions().extensions.some(item => item.path === extension)).toBe(!isolated);
  });

  it.each([true, false])("keeps branch-local nested isolation when the root worker disagrees (branch=%s)", async branchIsolated => {
    const branch = join(root, "branch");
    mkdirSync(join(branch, ".pi", "agents"), { recursive: true });
    const marker = join(root, "nested-factory-ran");
    const extension = join(root, "nested-probe.js");
    writeFileSync(extension, `import { writeFileSync } from "node:fs"; export default function() { writeFileSync(${JSON.stringify(marker)}, "ran"); }`);
    const skill = join(branch, ".pi", "skills", "probe");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: probe\ndescription: fixture\n---\nBRANCH_SKILL_PROBE");
    writeFileSync(join(branch, ".pi", "agents", "worker.md"), `---\nisolated: ${branchIsolated}\n---\nbranch worker`);
    const base: AgentConfig = { name: "parent", description: "parent", builtinToolNames: [], extensions: false, skills: false, systemPrompt: "parent", promptMode: "replace" };
    registerAgents(new Map([
      ["parent", { ...base, isolated: false, allowedSubagents: ["worker"] }],
      ["worker", { ...base, name: "worker", isolated: !branchIsolated, extensions: [extension], skills: ["probe"] }],
    ]));
    const branchCtx = { ...ctx, cwd: branch, sessionManager: SessionManager.inMemory(branch) };
    const manager = new AgentManager();
    manager.setRememberAgents(false);
    manager.setSupervisorQuestions(false);
    let releaseParent!: () => void;
    let markParentStarted!: () => void;
    const parentStarted = new Promise<void>(resolve => { markParentStarted = resolve; });
    const parentGate = new Promise<void>(resolve => { releaseParent = resolve; });
    faux.setResponses([async () => { markParentStarted(); await parentGate; return fauxAssistantMessage(fauxText("PARENT_OK")); }, providerCall]);
    const parentId = manager.spawn(pi, branchCtx, "parent", "go", { description: "parent", isBackground: true });
    try {
      await parentStarted;
      const parent = manager.getRecordMutable(parentId)!;
      const tool = parent.session!.getToolDefinition("Agent")!;
      const result = await tool.execute("nested", { subagent_type: "worker", description: "worker", prompt: "go", isolated: !branchIsolated }, undefined, undefined, branchCtx);
      expect(result.isError).toBe(false);
      const worker = manager.listAgentsMutable().find(record => record.type === "worker")!;
      expect(worker.status).toBe("completed");
      expect(worker.invocation?.isolated).toBe(branchIsolated);
      expect(existsSync(marker)).toBe(!branchIsolated);
      expect(worker.session!.resourceLoader.getExtensions().extensions.some(item => item.path === extension)).toBe(!branchIsolated);
      expect(worker.session!.systemPrompt.includes("BRANCH_SKILL_PROBE")).toBe(!branchIsolated);
    } finally {
      releaseParent();
      await manager.getRecordMutable(parentId)?.promise;
      await manager.dispose();
    }
  });

  it.each(["high", "off"] as const)("nested SDK Agent tool inherits coordinator %s rather than root off", async level => {
    setScopeModelsEnabled(false);
    writeFileSync(join(cwd, ".pi", "agents", "worker.md"), "---\ntools: none\nextensions: false\nskills: false\npersist_session: false\noutput_transcript: false\n---\nworker");
    const base: AgentConfig = { name: "coordinator", description: "fixture", builtinToolNames: [], extensions: false, skills: false, systemPrompt: "fixture", promptMode: "replace" };
    registerAgents(new Map([
      ["coordinator", { ...base, allowedSubagents: ["worker"], ...(level === "high" ? { agentTier: "coordinator" } : {}) }],
      ["worker", { ...base, name: "worker" }],
    ]));
    setAgentTiersSettings({ profiles: { coordinator: { model: "inherit", thinking: "high" } } });
    const manager = new AgentManager();
    manager.setRememberAgents(false);
    manager.setSupervisorQuestions(false);
    const rootPi = { ...pi, getThinkingLevel: () => "off" } as ExtensionAPI;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "worker", description: "worker", prompt: "go" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("worker done"),
      fauxAssistantMessage("coordinator done"),
    ]);
    try {
      const { record } = await manager.spawnAndWait(rootPi, { ...ctx, thinkingLevel: "off" }, "coordinator", "go", { description: "coordinator" });
      expect(record.status).toBe("completed");
      const worker = manager.listAgentsMutable().find(item => item.type === "worker");
      expect(worker?.status).toBe("completed");
      expect(worker?.session?.thinkingLevel).toBe(level);
      expect(manager.getRecordMutable(record.id)?.session?.thinkingLevel).toBe(level);
    } finally { await manager.dispose(); }
  });

  it.each(["snapshot", "parent-option", "tier", "option", "agent"] as const)("real SDK thinking precedence remains authoritative: %s", async source => {
    setScopeModelsEnabled(false);
    config(source === "agent" ? { thinking: "low" } : {});
    setAgentTiersSettings({ profiles: { selected: { model: "inherit", thinking: "low" } } });
    const options: Partial<RunOptions> = source === "snapshot" ? {
      [INTERNAL_PARENT_POLICY_SNAPSHOT]: Object.freeze({ model: ctx.model, thinking: "medium" }), parentThinking: "low",
    } : source === "parent-option" ? { parentThinking: "medium" }
      : source === "tier" ? { agentTier: "selected", thinkingLevel: "high", [INTERNAL_PARENT_POLICY_SNAPSHOT]: Object.freeze({ model: ctx.model, thinking: "medium" }) }
        : source === "option" ? { thinkingLevel: "low", [INTERNAL_PARENT_POLICY_SNAPSHOT]: Object.freeze({ model: ctx.model, thinking: "medium" }) } : {};
    const result = await run(options, { ...ctx, thinkingLevel: "high" });
    expect(result.session.thinkingLevel).toBe(source === "snapshot" || source === "parent-option" ? "medium" : "low");
  });

  it("ordinary admission cannot forge resolved isolation with an external symbol", async () => {
    const marker = join(root, "forged-factory-ran");
    const extension = join(root, "forged-probe.js");
    writeFileSync(extension, `import { writeFileSync } from "node:fs"; export default function() { writeFileSync(${JSON.stringify(marker)}, "ran"); }`);
    config({ isolated: true, extensions: [extension] });
    const manager = new AgentManager();
    manager.setRememberAgents(false);
    try {
      const options = { description: "untrusted", isolated: false, [INTERNAL_RESOLVED_ISOLATED]: false };
      const { record } = await manager.spawnAndWait(pi, ctx, "general-purpose", "go", options);
      expect(record.status).toBe("completed");
      expect(record.session!.resourceLoader.getExtensions().extensions.map(item => item.path)).toEqual(["<inline:pi-subagents-tool-policy>"]);
      expect(existsSync(marker)).toBe(false);
    } finally { await manager.dispose(); }
  });

  it("managed resolved isolation is not reinterpreted by the root definition", async () => {
    const marker = join(root, "managed-factory-ran");
    const extension = join(root, "managed-probe.js");
    writeFileSync(extension, `import { writeFileSync } from "node:fs"; export default function() { writeFileSync(${JSON.stringify(marker)}, "ran"); }`);
    config({ isolated: true, extensions: [extension] });
    const manager = new AgentManager(undefined, undefined, undefined, undefined, undefined, { append: vi.fn() });
    manager.setRememberAgents(false);
    try {
      const result = manager.spawnManaged(pi, ctx, { requestId: "managed", spawnKey: "managed", type: "general-purpose", prompt: "go", description: "managed", owner: { extension: "pi-workflows", runId: "run", nodeId: "node", attemptId: "attempt" } }, { isolated: false });
      await manager.waitForAll();
      expect(manager.getRecord(result.id)?.status).toBe("completed");
      expect(existsSync(marker)).toBe(true);
    } finally { await manager.dispose(); }
  });

  it("internal zero-tool generation remains stronger than open definition/caller policy", async () => {
    config({ isolated: false, builtinToolNames: ["write"], extensions: true, skills: true, allowedSubagents: "all" });
    const { session } = await run({ isolated: false, [INTERNAL_RESOLVED_ISOLATED]: false, [INTERNAL_AGENT_CONFIG_OVERRIDE]: AGENT_DEFINITION_GENERATION_OVERRIDE });
    expect(session.getAllTools()).toEqual([]);
    expect(session.resourceLoader.getSkills().skills).toEqual([]);
    expect(session.resourceLoader.getExtensions().extensions.map(item => item.path)).toEqual(["<inline:pi-subagents-tool-policy>"]);
  });

  it.each(["string", "Model", "null", "tier-superseded", "Agent-inherit", "Agent-default"])("registered dispatch no-tier scope: %s", async input => {
    writeFileSync(join(cwd, ".pi", "agents", "general-purpose.md"), "---\ntools: none\nextensions: false\nskills: false\n---\nfixture");
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, outputTranscript: false, rememberAgents: false, scopeModels: true,
      ...(input === "Agent-default" ? { defaultModel: "parity-faux/outside" } : {}),
      ...(input === "tier-superseded" ? { agentTiers: { defaultTier: "selected", profiles: { selected: { model: "parity-faux/allowed", thinking: "inherit" } } } } : {}),
    }));
    if (input === "Agent-default") ctx = { ...ctx, model: ctx.modelRegistry.find("parity-faux", "allowed") };
    const tools = new Map<string, ToolDefinition>();
    const lifecycle = new Map<string, (...args: unknown[]) => unknown>();
    const bus = new Map<string, Set<(data: unknown) => unknown>>();
    const events = {
      on: (name: string, handler: (data: unknown) => unknown) => {
        const handlers = bus.get(name) ?? new Set();
        handlers.add(handler); bus.set(name, handlers);
        return () => handlers.delete(handler);
      },
      emit: (name: string, data: unknown) => { for (const handler of bus.get(name) ?? []) void handler(data); },
    };
    const extensionPi = { ...pi, events, registerMessageRenderer: vi.fn(), registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand: vi.fn(), appendEntry: vi.fn(), sendMessage: vi.fn(),
      on: (name: string, handler: (...args: unknown[]) => unknown) => lifecycle.set(name, handler),
    } as unknown as ExtensionAPI;
    subagentsExtension(extensionPi);
    await lifecycle.get("session_start")?.({}, ctx);
    cleanups.push(async () => { await lifecycle.get("session_shutdown")?.({}, ctx); });
    if (input.startsWith("Agent-")) {
      const result = await tools.get("Agent")!.execute("agent", { subagent_type: "general-purpose", prompt: "go", description: "scope", run_in_background: true }, undefined, undefined, ctx);
      const manager = Reflect.get(globalThis, Symbol.for("pi-subagents:manager")) as { waitForAll: () => Promise<void>; getRecord: (id: string) => AgentRecordSnapshot };
      await manager.waitForAll();
      expect(manager.getRecord((result.details as { agentId: string }).agentId).status).toBe("completed");
      expect(providerCall).toHaveBeenCalledOnce();
      expect(ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("out-of-scope"), "warning");
      return;
    }
    const response = new Promise<{ success: boolean; data: { id: string } }>(resolve => events.on("subagents:rpc:spawn:reply:scope", raw => resolve(raw as never)));
    events.emit("subagents:rpc:spawn", { requestId: "scope", type: "general-purpose", prompt: "go", options: { description: "scope", isBackground: true,
      model: input === "null" ? null : input === "Model" ? ctx.model : "parity-faux/outside",
    } });
    const reply = await response;
    // Legacy RPC acknowledges allocation synchronously; runner failures are
    // authoritative terminal records, not a new RPC schema/error contract.
    expect(reply.success).toBe(true);
    const manager = Reflect.get(globalThis, Symbol.for("pi-subagents:manager")) as { waitForAll: () => Promise<void>; getRecord: (id: string) => AgentRecordSnapshot };
    await manager.waitForAll();
    const record = manager.getRecord(reply.data.id);
    if (input === "string" || input === "Model") {
      expect(record.status).toBe("error");
      expect(record.error).toContain("Model not in scope");
      expect(providerCall).not.toHaveBeenCalled();
    } else {
      expect(record.status).toBe("completed");
      expect(record.result).toBe("FAUX_OK");
      expect(providerCall).toHaveBeenCalledOnce();
      expect(ctx.ui.notify).toHaveBeenCalledTimes(input === "null" ? 1 : 0);
    }
  });
});
