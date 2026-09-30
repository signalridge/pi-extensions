import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { streamSimple as compatStreamSimple } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { MENTION_SPAWNED, runMentionClone } from "../src/mention-clone.js";
import type { AgentConfig } from "../src/types.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

// Real createAgentSession + real SessionManager projection, with a scripted
// provider. Inspect the provider request, not the mutable agent.state array.
vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("mention clone provider context (Pi SDK)", () => {
  it("refuses an inherited stale model before any hidden provider request", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mention-clone-stale-"));
    dirs.push(cwd);
    process.env.PI_CODING_AGENT_DIR = cwd;
    const faux = fauxProvider({ provider: "faux-stale-parent", models: [{ id: "physical", contextWindow: 65_000 }] });
    const runtime = await ModelRuntime.create({
      authPath: join(cwd, "auth.json"), modelsPath: null, allowModelNetwork: false,
    });
    runtime.registerNativeProvider(faux.provider);
    await runtime.refresh({ allowNetwork: false });
    const model = runtime.getModel("faux-stale-parent", "physical");
    if (!model) throw new Error("Physical model was not registered in real Pi runtime");
    const stale = { ...model, id: "retired" };
    expect(runtime.getModel(stale.provider, stale.id)).toBeUndefined();
    const providerCall = vi.fn(() => fauxAssistantMessage(fauxText("unexpected")));
    faux.setResponses([providerCall]);
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "unexpected" }] }));
    const agentTool: ToolDefinition = {
      name: "Agent", label: "Agent", description: "Start an agent",
      parameters: Type.Object({ subagent_type: Type.String(), prompt: Type.String() }), execute,
    };
    const ctx = {
      cwd, model: stale, modelRegistry: new ModelRegistry(runtime),
      sessionManager: SessionManager.inMemory(cwd), getSystemPrompt: () => "parent",
    } as unknown as ExtensionContext;
    try {
      const outcome = await runMentionClone({ ctx, type: "Explore", message: "find it", agentTool, isOriginCurrent: () => true });
      expect(outcome).toMatchObject({ spawned: false, error: expect.stringContaining("parent's model runtime") });
      expect(providerCall).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      faux.setResponses([]);
    }
  });

  it("makes zero provider calls if the parent switches during resource loading", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mention-clone-loading-"));
    dirs.push(cwd);
    process.env.PI_CODING_AGENT_DIR = cwd;
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-loading", contextWindow: 65_000 }] });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const loading = new Promise<void>((resolve) => { entered = resolve; });
    const originalReload = DefaultResourceLoader.prototype.reload;
    const reload = vi.spyOn(DefaultResourceLoader.prototype, "reload").mockImplementation(async function () {
      entered();
      await pending;
      return originalReload.call(this);
    });
    const providerCall = vi.fn(() => fauxAssistantMessage(fauxText("unexpected")));
    faux.setResponses([providerCall]);
    try {
      const runtime = {
        streamSimple: (requestModel, context, options) =>
          compatStreamSimple(requestModel, context, { ...options, apiKey: "faux" }),
        stream: () => { throw new Error("fixture uses streamSimple"); },
        getAuth: async () => ({ apiKey: "faux" }),
        getModel: (provider: string, id: string) => {
          const selected = faux.getModel();
          return provider === selected.provider && id === selected.id ? selected : undefined;
        },
        resolveModel: async () => ({ model: faux.getModel(), thinkingLevel: "off" }),
        hasConfiguredAuth: () => true,
        isUsingOAuth: () => false,
      } as ModelRuntime;
      const ctx = {
        cwd, model: faux.getModel(), modelRegistry: { runtime },
        sessionManager: SessionManager.inMemory(cwd), getSystemPrompt: () => "parent",
      } as unknown as ExtensionContext;
      const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "unexpected" }] }));
      const agentTool: ToolDefinition = {
        name: "Agent", label: "Agent", description: "Start an agent",
        parameters: Type.Object({ subagent_type: Type.String(), prompt: Type.String() }), execute,
      };
      let originCurrent = true;
      const result = runMentionClone({ ctx, type: "Explore", message: "find it", agentTool, isOriginCurrent: () => originCurrent });
      await loading;
      originCurrent = false;
      release();
      expect(await result).toMatchObject({ spawned: false });
      expect(providerCall).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      release();
      reload.mockRestore();
      faux.unregister();
    }
  });

  it("cannot execute a deferred provider tool call after its parent switches", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mention-clone-switch-"));
    dirs.push(cwd);
    process.env.PI_CODING_AGENT_DIR = cwd;
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-switch", contextWindow: 200_000 }] });
    try {
      const runtime = {
        streamSimple: (requestModel, context, options) =>
          compatStreamSimple(requestModel, context, { ...options, apiKey: "faux" }),
        stream: () => { throw new Error("fixture uses streamSimple"); },
        getAuth: async () => ({ apiKey: "faux" }),
        getModel: (provider: string, id: string) => {
          const selected = faux.getModel();
          return provider === selected.provider && id === selected.id ? selected : undefined;
        },
        resolveModel: async () => ({ model: faux.getModel(), thinkingLevel: "off" }),
        hasConfiguredAuth: () => true,
        isUsingOAuth: () => false,
      } as ModelRuntime;
      const parent = SessionManager.inMemory(cwd);
      const ctx = {
        cwd,
        model: faux.getModel(),
        modelRegistry: { runtime },
        sessionManager: parent,
        getSystemPrompt: () => "parent",
      } as unknown as ExtensionContext;
      const execute = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "Agent ID: unexpected" }],
        details: { agentId: "unexpected", status: "background" },
      }));
      const agentTool: ToolDefinition = {
        name: "Agent", label: "Agent", description: "Start an agent",
        parameters: Type.Object({ subagent_type: Type.String(), prompt: Type.String() }),
        execute,
      };
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      let originCurrent = true;
      faux.setResponses([
        async () => {
          entered();
          await pending;
          return fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "Explore", prompt: "go" }), { stopReason: "toolUse" });
        },
        fauxAssistantMessage(fauxText("stopped")),
      ]);

      const result = runMentionClone({ ctx, type: "Explore", message: "find it", agentTool, isOriginCurrent: () => originCurrent });
      await started;
      originCurrent = false;
      release();

      expect((await result).spawned).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      faux.unregister();
    }
  });

  it("aborts a hidden provider stream when its originating session changes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mention-clone-stream-"));
    dirs.push(cwd);
    process.env.PI_CODING_AGENT_DIR = cwd;
    const faux = registerFauxProvider({
      provider: "faux",
      models: [{ id: "faux-stream", contextWindow: 200_000 }],
      tokensPerSecond: 30,
      tokenSize: { min: 1, max: 1 },
    });
    try {
      const runtime = {
        streamSimple: (requestModel, context, options) =>
          compatStreamSimple(requestModel, context, { ...options, apiKey: "faux" }),
        stream: () => { throw new Error("fixture uses streamSimple"); },
        getAuth: async () => ({ apiKey: "faux" }),
        getModel: (provider: string, id: string) => {
          const selected = faux.getModel();
          return provider === selected.provider && id === selected.id ? selected : undefined;
        },
        resolveModel: async () => ({ model: faux.getModel(), thinkingLevel: "off" }),
        hasConfiguredAuth: () => true,
        isUsingOAuth: () => false,
      } as ModelRuntime;
      const ctx = {
        cwd, model: faux.getModel(), modelRegistry: { runtime },
        sessionManager: SessionManager.inMemory(cwd), getSystemPrompt: () => "parent",
      } as unknown as ExtensionContext;
      const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "unexpected" }] }));
      const agentTool: ToolDefinition = {
        name: "Agent", label: "Agent", description: "Start an agent",
        parameters: Type.Object({ subagent_type: Type.String(), prompt: Type.String() }), execute,
      };
      let providerSignal: AbortSignal | undefined;
      faux.setResponses([
        (_context, options) => {
          providerSignal = options?.signal;
          return fauxAssistantMessage(fauxText("streaming".repeat(100)));
        },
      ]);
      let originCurrent = true;
      const result = runMentionClone({ ctx, type: "Explore", message: "find it", agentTool, isOriginCurrent: () => originCurrent });
      await vi.waitFor(() => expect(providerSignal).toBeDefined());
      expect(providerSignal?.aborted).toBe(false);
      originCurrent = false;

      await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
      expect((await result).spawned).toBe(false);
      expect(execute).not.toHaveBeenCalled();
      expect(faux.state.callCount).toBe(1);
    } finally {
      faux.unregister();
    }
  });

  it("retains the spawn witness when a real Pi turn receives a post-spawn tool error", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mention-clone-postspawn-"));
    dirs.push(cwd);
    process.env.PI_CODING_AGENT_DIR = cwd;
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-postspawn", contextWindow: 200_000 }] });
    try {
      const runtime = {
        streamSimple: (requestModel, context, options) =>
          compatStreamSimple(requestModel, context, { ...options, apiKey: "faux" }),
        stream: () => { throw new Error("fixture uses streamSimple"); },
        getAuth: async () => ({ apiKey: "faux" }),
        getModel: (provider: string, id: string) => {
          const selected = faux.getModel();
          return provider === selected.provider && id === selected.id ? selected : undefined;
        },
        resolveModel: async () => ({ model: faux.getModel(), thinkingLevel: "off" }),
        hasConfiguredAuth: () => true,
        isUsingOAuth: () => false,
      } as ModelRuntime;
      const ctx = {
        cwd,
        model: faux.getModel(),
        modelRegistry: { runtime },
        sessionManager: SessionManager.inMemory(cwd),
        getSystemPrompt: () => "parent",
      } as unknown as ExtensionContext;
      const execute = vi.fn(async (_id: unknown, params: { [MENTION_SPAWNED]?: (id: string) => void }) => {
        params[MENTION_SPAWNED]?.("started-agent");
        throw new Error("fleet update failed");
      });
      const agentTool: ToolDefinition = {
        name: "Agent", label: "Agent", description: "Start an agent",
        parameters: Type.Object({ subagent_type: Type.String(), prompt: Type.String() }),
        execute,
      };
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "Explore", prompt: "go" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxText("stopped")),
      ]);

      const result = await runMentionClone({ ctx, type: "Explore", message: "find it", agentTool, isOriginCurrent: () => true });
      expect(result.spawned).toBe(true);
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      faux.unregister();
    }
  });

  it("delivers the mention while omitting parent turns, summaries, edits and prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mention-clone-sdk-"));
    dirs.push(cwd);
    process.env.PI_CODING_AGENT_DIR = cwd;
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    try {
      const model = faux.getModel();
      const runtime = {
        streamSimple: (requestModel, context, options) =>
          compatStreamSimple(requestModel, context, { ...options, apiKey: "faux" }),
        stream: () => { throw new Error("fixture uses streamSimple"); },
        getAuth: async () => ({ apiKey: "faux" }),
        getModel: (provider: string, id: string) => {
          const selected = faux.getModel();
          return provider === selected.provider && id === selected.id ? selected : undefined;
        },
        resolveModel: async () => ({ model: faux.getModel(), thinkingLevel: "off" }),
        hasConfiguredAuth: () => true,
        isUsingOAuth: () => false,
      } as ModelRuntime;
      const parent = SessionManager.inMemory(cwd);
      parent.appendMessage({ role: "system", content: "", sections: { preamble: "STALE_PARENT_PROMPT" }, timestamp: Date.now() });
      parent.appendMessage({ role: "user", content: "COMPACTED_PRIVATE_TURN", timestamp: Date.now() });
      const keptId = parent.appendMessage({ role: "user", content: "ORIGINAL_KEPT_TURN", timestamp: Date.now() });
      parent.appendCompaction("COMPACTED_SUMMARY", keptId, 1000);
      const editId = parent.appendContextEdit(keptId, { content: "EDITED_KEPT_TURN" });
      parent.appendMessage({ role: "user", content: "ABANDONED_BRANCH_TURN", timestamp: Date.now() });
      parent.branchWithSummary(editId, "BRANCH_SUMMARY");
      const branchBefore = parent.getBranch().map((entry) => entry.id);
      const entriesBefore = parent.getEntries().map((entry) => entry.id);

      const ctx = {
        cwd,
        model,
        thinkingLevel: "high",
        modelRegistry: { runtime },
        sessionManager: parent,
        getSystemPrompt: () => "LIVE_PARENT_PROMPT",
      } as unknown as ExtensionContext;
      const execute = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "Agent ID: a1" }],
        details: { agentId: "a1", status: "background" },
      }));
      const agentTool: ToolDefinition = {
        name: "Agent",
        label: "Agent",
        description: "Start an agent",
        parameters: Type.Object({
          subagent_type: Type.String(),
          prompt: Type.String(),
          run_in_background: Type.Optional(Type.Boolean()),
        }),
        execute,
      };
      const requests: Context[] = [];
      faux.setResponses([
        (context) => {
          requests.push(context);
          return fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "Explore", prompt: "find it with tests" }), { stopReason: "toolUse" });
        },
        (context) => {
          requests.push(context);
          return fauxAssistantMessage(fauxText("started"));
        },
      ]);

      expect(await runMentionClone({ ctx, type: "Explore", message: "find it", agentTool, isOriginCurrent: () => true })).toEqual({ spawned: true });
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]?.[0]).toBeUndefined();
      expect(execute.mock.calls[0]?.[1]).toMatchObject({
        subagent_type: "Explore", prompt: "find it with tests", run_in_background: true,
      });
      const toolCtx = execute.mock.calls[0]?.[4];
      expect(toolCtx).not.toBe(ctx);
      expect(toolCtx.sessionManager).toBe(parent);
      expect(toolCtx.model).toBe(model);
      expect(toolCtx.cwd).toBe(cwd);
      expect(toolCtx.tools.map((tool: { name: string }) => tool.name)).toEqual(["Agent"]);
      expect(toolCtx.executeTool).toEqual(expect.any(Function));
      expect(requests).toHaveLength(2);
      // Executing Agent above proves the SDK admitted the one-tool allowlist.
      expect(requests[0]?.messages.filter((entry) => entry.role === "user")).toEqual([
        expect.objectContaining({ content: [{ type: "text", text: "find it" }] }),
      ]);
      expect(getCurrentSystemPrompt(requests[0].messages)).toContain("only the user's current message");
      expect(getCurrentTools(requests[0].messages).map((tool) => tool.name)).toEqual(["Agent"]);
      for (const hidden of ["STALE_PARENT_PROMPT", "LIVE_PARENT_PROMPT", "COMPACTED_PRIVATE_TURN",
        "ORIGINAL_KEPT_TURN", "EDITED_KEPT_TURN", "COMPACTED_SUMMARY", "BRANCH_SUMMARY",
        "ABANDONED_BRANCH_TURN"]) {
        expect(JSON.stringify(requests[0])).not.toContain(hidden);
      }
      expect(parent.getBranch().map((entry) => entry.id)).toEqual(branchBefore);
      expect(parent.getEntries().map((entry) => entry.id)).toEqual(entriesBefore);
    } finally {
      faux.unregister();
    }
  });

  it("routes a virtual-model parent through the clone and a streamed child", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mention-clone-virtual-"));
    dirs.push(cwd);
    process.env.PI_CODING_AGENT_DIR = cwd;
    registerAgents(new Map([["VirtualTest", {
      name: "VirtualTest", description: "Virtual child test", builtinToolNames: [],
      extensions: false, skills: false, systemPrompt: "You are a test child.", promptMode: "replace",
    } satisfies AgentConfig]]));
    const faux = fauxProvider({ provider: "faux-virtual-child", models: [{ id: "physical", contextWindow: 200_000 }] });
    const runtime = await ModelRuntime.create({
      authPath: join(cwd, "auth.json"), modelsPath: null, allowModelNetwork: false,
    });
    runtime.registerNativeProvider(faux.provider);
    const routed: string[] = [];
    runtime.registerVirtualModel({
      provider: "test-router", id: "virtual", name: "Virtual test model",
      route: (request) => {
        routed.push(request.reason);
        return { model: faux.getModel(), thinkingLevel: "off" };
      },
    });
    await runtime.refresh({ allowNetwork: false });
    const virtual = runtime.getModel("test-router", "virtual");
    expect(virtual).toBeDefined();
    if (!virtual) throw new Error("virtual model not registered");
    const registry = new ModelRegistry(runtime);
    const parentManager = SessionManager.inMemory(cwd);
    const { session: parent } = await createAgentSession({
      cwd, model: virtual, modelRuntime: runtime, sessionManager: parentManager, noTools: "all",
    });
    try {
      const physicalRequests: string[] = [];
      faux.setResponses([
        (_context, _options, _state, model) => {
          physicalRequests.push(model.id);
          return fauxAssistantMessage(fauxText("parent is ready"));
        },
        (_context, _options, _state, model) => {
          physicalRequests.push(model.id);
          return fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "VirtualTest", prompt: "child task" }), { stopReason: "toolUse" });
        },
        (_context, _options, _state, model) => {
          physicalRequests.push(model.id);
          return fauxAssistantMessage(fauxText("CHILD_STREAMED_RESULT"));
        },
        (_context, _options, _state, model) => {
          physicalRequests.push(model.id);
          return fauxAssistantMessage(fauxText("clone completed"));
        },
      ]);
      await parent.prompt("Prepare the parent session");
      expect(parent.model).toEqual(virtual);
      const ctx = {
        cwd, model: parent.model, modelRegistry: registry, sessionManager: parentManager,
        getSystemPrompt: () => parent.agent.state.systemPrompt,
      } as unknown as ExtensionContext;
      const deltas: string[] = [];
      const spawn = vi.fn(async (_id: string, params: { prompt: string }, _signal: AbortSignal | undefined,
        _update: unknown, toolCtx: ExtensionContext) => {
        // This is the real child runner, not a stub for createAgentSession. It
        // must inherit the selected virtual model and the parent's runtime.
        const child = await runAgent(toolCtx, "VirtualTest", params.prompt, {
          pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as Parameters<typeof runAgent>[3]["pi"],
          model: toolCtx.model,
          isolated: true,
          onTextDelta: (delta) => { deltas.push(delta); },
        });
        expect(child.failure).toBeUndefined();
        expect(child.responseText).toContain("CHILD_STREAMED_RESULT");
        return { content: [{ type: "text" as const, text: "Agent ID: child" }], details: { agentId: "child", status: "background" } };
      });
      const agentTool: ToolDefinition = {
        name: "Agent", label: "Agent", description: "Start child",
        parameters: Type.Object({ subagent_type: Type.String(), prompt: Type.String() }), execute: spawn,
      };
      const outcome = await runMentionClone({ ctx, type: "VirtualTest", message: "child task", agentTool, isOriginCurrent: () => true });
      expect(outcome).toEqual({ spawned: true });
      expect(spawn).toHaveBeenCalledOnce();
      expect(spawn.mock.calls[0]?.[4].sessionManager).toBe(parentManager);
      expect(deltas.join("")).toContain("CHILD_STREAMED_RESULT");
      expect(physicalRequests).toEqual(["physical", "physical", "physical", "physical"]);
      expect(routed).toEqual(["user", "user", "user", "continuation"]);
      expect(registry.find("test-router", "virtual")).toEqual(virtual);
    } finally {
      parent.dispose();
      registerAgents(new Map());
    }
  });

  it("keeps a programmatic parent context hook's private input out of the clone provider request", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mention-clone-hooks-"));
    dirs.push(cwd);
    process.env.PI_CODING_AGENT_DIR = cwd;
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-redact", contextWindow: 200_000 }] });
    let parentSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const runtime = {
        streamSimple: (requestModel, context, options) =>
          compatStreamSimple(requestModel, context, { ...options, apiKey: "faux" }),
        stream: () => { throw new Error("fixture uses streamSimple"); },
        getAuth: async () => ({ apiKey: "faux" }),
        getModel: (provider: string, id: string) => {
          const selected = faux.getModel();
          return provider === selected.provider && id === selected.id ? selected : undefined;
        },
        resolveModel: async () => ({ model: faux.getModel(), thinkingLevel: "off" }),
        hasConfiguredAuth: () => true,
        isUsingOAuth: () => false,
      } as ModelRuntime;
      const parent = SessionManager.inMemory(cwd);
      parent.appendMessage({ role: "user", content: "PRIVATE_PARENT_SECRET", timestamp: Date.now() });
      const loader = new DefaultResourceLoader({
        cwd, agentDir: cwd, noExtensions: true, noContextFiles: true,
        systemPromptOverride: () => "PARENT_ONLY_SYSTEM_PROMPT",
        extensionFactories: [{ name: "inline-parent-redactor", factory: (pi) => {
          pi.on("context", (event) => ({
            messages: event.messages.map((entry) => entry.role === "user"
              ? { ...entry, content: "REDACTED_BY_PARENT_HOOK" } : entry),
          }));
        } }],
      });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const parentTool: ToolDefinition = {
        name: "ParentOnly", label: "ParentOnly", description: "PRIVATE_PARENT_TOOL_DECLARATION",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text" as const, text: "unused" }] }),
      };
      const created = await createAgentSession({
        cwd, model: faux.getModel(), modelRuntime: runtime, resourceLoader: loader,
        sessionManager: parent, tools: ["ParentOnly"], customTools: [parentTool],
      });
      parentSession = created.session;
      const requests: Context[] = [];
      faux.setResponses([
        (context) => {
          requests.push(context);
          return fauxAssistantMessage(fauxText("parent ready"));
        },
        (context) => {
          requests.push(context);
          return fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "Explore", prompt: "find the flaky test" }), { stopReason: "toolUse" });
        },
        (context) => {
          requests.push(context);
          return fauxAssistantMessage(fauxText("agent started"));
        },
      ]);
      await parentSession.prompt("verify parent policy");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.messages.filter((entry) => entry.role === "user")).toEqual([
        expect.objectContaining({ content: "REDACTED_BY_PARENT_HOOK" }),
        expect.objectContaining({ content: "REDACTED_BY_PARENT_HOOK" }),
      ]);
      expect(JSON.stringify(requests[0])).not.toContain("PRIVATE_PARENT_SECRET");
      expect(JSON.stringify(parent.getBranch())).toContain("PRIVATE_PARENT_SECRET");
      expect(getCurrentTools(requests[0].messages).map((tool) => tool.name)).toEqual(["ParentOnly"]);
      // Pi 0.99's public ExtensionContext cannot enumerate or replay this inline
      // hook. Sending the raw parent branch to an independent clone would leak it.
      const getSystemPrompt = vi.fn(() => "PARENT_ONLY_SYSTEM_PROMPT");
      const ctx = {
        cwd, model: faux.getModel(), modelRegistry: { runtime },
        sessionManager: parent, getSystemPrompt,
      } as unknown as ExtensionContext;
      const execute = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "Agent ID: a2" }],
        details: { agentId: "a2", status: "background" },
      }));
      const agentTool: ToolDefinition = {
        name: "Agent", label: "Agent", description: "Start an agent",
        parameters: Type.Object({ subagent_type: Type.String(), prompt: Type.String() }),
        execute,
      };
      expect(await runMentionClone({ ctx, type: "Explore", message: "find the flaky test", agentTool, isOriginCurrent: () => true })).toEqual({ spawned: true });
      expect(requests).toHaveLength(3);
      expect(requests[1]?.messages.filter((entry) => entry.role === "user")).toEqual([
        expect.objectContaining({ content: [{ type: "text", text: "find the flaky test" }] }),
      ]);
      expect(getCurrentSystemPrompt(requests[1].messages)).toContain("only the user's current message");
      expect(getCurrentTools(requests[1].messages).map((tool) => tool.name)).toEqual(["Agent"]);
      expect(getSystemPrompt).not.toHaveBeenCalled();
      for (const request of requests.slice(1)) {
        expect(JSON.stringify(request)).not.toContain("PRIVATE_PARENT_SECRET");
        expect(JSON.stringify(request)).not.toContain("REDACTED_BY_PARENT_HOOK");
        expect(JSON.stringify(request)).not.toContain("PARENT_ONLY_SYSTEM_PROMPT");
        expect(JSON.stringify(request)).not.toContain("PRIVATE_PARENT_TOOL_DECLARATION");
      }
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]?.[1]).toMatchObject({
        subagent_type: "Explore", prompt: "find the flaky test", run_in_background: true,
      });
    } finally {
      parentSession?.dispose();
      faux.unregister();
    }
  });
});
