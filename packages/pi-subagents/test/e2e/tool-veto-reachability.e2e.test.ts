import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { streamSimple as compatStreamSimple } from "@earendil-works/pi-ai/compat";
import { type ExtensionContext, type ModelRuntime, VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumeAgent, runAgent, setDefaultToolTimeoutMs } from "../../src/agent-runner.js";
import { registerAgents } from "../../src/agent-types.js";
import type { AgentConfig } from "../../src/types.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

// Nested ctx.executeTool was added in Pi 0.99. Older hosts are covered by the
// mocked loader/policy tests in agent-runner.test.ts.
describe.skipIf(!VERSION.startsWith("0.99."))("child tool policy through real Pi nested calls", () => {
  let root: string;
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;
  let previousAgentDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "subagents-nested-policy-"));
    cwd = join(root, "project");
    mkdirSync(cwd);
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent-dir");
    mkdirSync(process.env.PI_CODING_AGENT_DIR);
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "policy-test", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    setDefaultToolTimeoutMs(0);
    faux.unregister();
    registerAgents(new Map());
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  function fixture(mutateToolName = false) {
    const alpha = join(root, "alpha.mjs");
    const beta = join(root, "beta.mjs");
    const sideEffect = join(root, "forbidden-side-effect");
    writeFileSync(alpha, `
      import { writeFileSync } from "node:fs";
      const parameters = { type: "object", properties: {}, additionalProperties: false };
      export default function (pi) {
        ${mutateToolName ? `pi.on("tool_call", (event) => {
          if (event.parentToolCallId && event.toolName === "sibling") event.toolName = "allowed";
        });` : ""}
        for (const name of ["allowed", "sibling", "approval"]) {
          pi.registerTool({ name, label: name, description: name, parameters,
            exposure: name === "sibling" ? "codemode" : "direct",
            async execute() {
              if (name === "sibling") writeFileSync(${JSON.stringify(sideEffect)}, "executed");
              return { content: [{ type: "text", text: name + "-ok" }] };
            },
          });
        }
        pi.registerTool({ name: "gateway", label: "gateway", description: "nested caller", parameters,
          async execute(_id, _args, _signal, _onUpdate, ctx) {
            const results = [];
            for (const name of ["allowed", "sibling", "foreign", "approval", "approval", "approval"]) {
              const outcome = await ctx.executeTool(name, {});
              results.push({ name, isError: outcome.isError,
                text: outcome.result.content.map((part) => part.text ?? "").join("") });
            }
            return { content: [{ type: "text", text: JSON.stringify(results) }] };
          },
        });
      }
    `);
    writeFileSync(beta, `
      import { writeFileSync } from "node:fs";
      export default function (pi) {
        pi.registerTool({ name: "foreign", label: "foreign", description: "unselected tool",
          exposure: "codemode",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            writeFileSync(${JSON.stringify(sideEffect)}, "executed");
            return { content: [{ type: "text", text: "foreign-ok" }] };
          },
        });
      }
    `);
    return { alpha, beta, sideEffect };
  }

  function collisionFixture() {
    const alpha = join(root, "selected-alpha.mjs");
    const beta = join(root, "shadow-beta.mjs");
    const sideEffect = join(root, "shadow-executed");
    writeFileSync(alpha, `
      const parameters = { type: "object", properties: {}, additionalProperties: false };
      export default function (pi) {
        // Force a turn-1 direct call to be available even when the runner's
        // post-bind active-set pass selected a different extension's tool.
        pi.on("before_agent_start", () => pi.setActiveTools([...pi.getActiveTools(), "same"]));
        pi.registerTool({ name: "same", label: "same", description: "selected same", parameters,
          async execute() { return { content: [{ type: "text", text: "alpha-ok" }] }; },
        });
        pi.registerTool({ name: "gateway", label: "gateway", description: "nested caller", parameters,
          async execute(_id, _args, _signal, _onUpdate, ctx) {
            const outcome = await ctx.executeTool("same", {});
            return { content: [{ type: "text", text: JSON.stringify({
              isError: outcome.isError,
              text: outcome.result.content.map((part) => part.text ?? "").join(""),
            }) }] };
          },
        });
      }
    `);
    writeFileSync(beta, `
      import { writeFileSync } from "node:fs";
      export default function (pi) {
        pi.registerTool({ name: "same", label: "same", description: "unselected same",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            writeFileSync(${JSON.stringify(sideEffect)}, "executed");
            return { content: [{ type: "text", text: "beta-ok" }] };
          },
        });
      }
    `);
    return { alpha, beta, sideEffect };
  }

  function hangingHandlerFixture(late = false) {
    const path = join(root, late ? "late-handler.mjs" : "hanging-handler.mjs");
    const outcomeFile = join(root, "nested-timeout-outcomes.json");
    writeFileSync(path, `
      import { writeFileSync } from "node:fs";
      const parameters = { type: "object", properties: {}, additionalProperties: false };
      export default function (pi) {
        let unsubscribe;
        const hanging = (event) => event.toolName === "target"
          ? new Promise(() => {}) : undefined;
        ${late
          ? 'pi.on("before_agent_start", () => { unsubscribe ??= pi.on("tool_call", hanging); });'
          : 'unsubscribe = pi.on("tool_call", hanging);'}
        pi.registerTool({ name: "target", label: "target", description: "target", parameters,
          async execute() { return { content: [{ type: "text", text: "target-ok" }] }; },
        });
        pi.registerTool({ name: "gateway", label: "gateway", description: "nested caller", parameters,
          async execute(_id, _args, _signal, _onUpdate, ctx) {
            const first = await ctx.executeTool("target", {});
            unsubscribe?.();
            const second = await ctx.executeTool("target", {});
            ${late ? "await new Promise((resolve) => setTimeout(resolve, 35));" : ""}
            const outcomes = [first, second].map((outcome) => ({ isError: outcome.isError,
              text: outcome.result.content.map((part) => part.text ?? "").join("") }));
            writeFileSync(${JSON.stringify(outcomeFile)}, JSON.stringify(outcomes));
            return { content: [{ type: "text", text: JSON.stringify(outcomes) }] };
          },
        });
      }
    `);
    return { path, outcomeFile };
  }

  function exposureFixture() {
    const path = join(root, "exposure-fixture.mjs");
    writeFileSync(path, `
      const parameters = { type: "object", properties: {}, additionalProperties: false };
      export default function (pi) {
        function add(name, options = {}) {
          pi.registerTool({ name, label: name, description: name, parameters, ...options,
            async execute() { return { content: [{ type: "text", text: name + "-ok" }] }; },
          });
        }
        add("direct_probe", { exposure: "direct", defaultActive: true });
        add("deferred_probe", { exposure: "deferred" });
        add("inactive_probe", { exposure: "direct", defaultActive: false });
        add("model_probe", { exposure: "model-only" });
        add("gateway");
        pi.on("session_start", () => {
          add("late_direct", { exposure: "direct", defaultActive: true });
          add("late_deferred", { exposure: "deferred" });
          add("late_inactive", { exposure: "direct", defaultActive: false });
        });
      }
    `);
    return path;
  }

  async function runChild(config: Partial<AgentConfig>, confirm?: (title: string, message: string) => Promise<boolean>, callName = "gateway") {
    registerAgents(new Map([["policy-test", {
      name: "policy-test", description: "policy test", builtinToolNames: [],
      extensions: false, skills: false, systemPrompt: "Call gateway once.",
      promptMode: "replace", inheritContext: false, runInBackground: false, isolated: false,
      ...config,
    } as AgentConfig]]));
    const model = faux.getModel();
    const runtime = {
      getAuth: async () => ({ ok: true, apiKey: "faux", headers: {} }),
      stream: () => { throw new Error("fixture uses streamSimple"); },
      streamSimple: (fauxModel: typeof model, context: Parameters<typeof compatStreamSimple>[1], options: Parameters<typeof compatStreamSimple>[2]) =>
        compatStreamSimple(fauxModel, context, { ...options, apiKey: "faux" }),
      getModel: () => model, getModels: () => [model], getAvailable: async () => [model],
      hasConfiguredAuth: () => true, isUsingOAuth: () => false,
      getProviders: () => [], getProvider: () => undefined,
    } as unknown as ModelRuntime;
    faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall(callName, {}), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxText("done")),
    ]);
    const modelRegistry = {
      runtime,
      find: () => model, getAll: () => [model], getAvailable: () => [model],
      hasConfiguredAuth: () => true, isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
      registerProvider: () => {}, unregisterProvider: () => {},
    };
    const ctx = {
      cwd, model, modelRegistry, getSystemPrompt: () => "parent",
      hasUI: Boolean(confirm),
      ui: { confirm },
    } as unknown as ExtensionContext;
    return runAgent(ctx, "policy-test", "go", {
      pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as never,
      model, supervisorQuestions: false,
    });
  }

  it("blocks narrowed and unselected nested tools, permits allowed tools, and applies ask_tools consent", async () => {
    const { alpha, beta, sideEffect } = fixture();
    const confirm = vi.fn(async () => true).mockResolvedValueOnce(false);
    const { session } = await runChild({
      extensions: [alpha, beta],
      extSelectors: ["ext:alpha.mjs/gateway", "ext:alpha.mjs/allowed", "ext:alpha.mjs/approval"],
      askTools: ["approval"],
    }, confirm);

    const outer = session.messages.find((m) => m.role === "toolResult" && m.toolName === "gateway");
    expect(outer).toBeDefined();
    if (outer?.role !== "toolResult") throw new Error("gateway result missing");
    const results = JSON.parse(outer.content.map((part) => part.type === "text" ? part.text : "").join(""));
    expect(results).toEqual([
      { name: "allowed", isError: false, text: "allowed-ok" },
      { name: "sibling", isError: true, text: "Tool \"sibling\" is not available to this subagent." },
      { name: "foreign", isError: true, text: "Tool \"foreign\" is not available to this subagent." },
      { name: "approval", isError: true, text: "The user declined the \"approval\" call. Do not retry it; continue without that tool or explain what you cannot do." },
      { name: "approval", isError: false, text: "approval-ok" },
      { name: "approval", isError: false, text: "approval-ok" },
    ]);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(existsSync(sideEffect)).toBe(false);
  });

  it("checks the original nested tool name before an earlier file extension can mutate the event", async () => {
    const { alpha, beta, sideEffect } = fixture(true);
    const confirm = vi.fn(async () => true);
    const { session } = await runChild({
      extensions: [alpha, beta],
      extSelectors: ["ext:alpha.mjs/gateway", "ext:alpha.mjs/allowed", "ext:alpha.mjs/approval"],
      askTools: ["sibling"],
    }, confirm);

    expect(session.resourceLoader.getExtensions().extensions[0]?.path).toBe("<inline:pi-subagents-tool-policy>");
    const outer = session.messages.find((m) => m.role === "toolResult" && m.toolName === "gateway");
    if (outer?.role !== "toolResult") throw new Error("gateway result missing");
    const results = JSON.parse(outer.content.map((part) => part.type === "text" ? part.text : "").join(""));
    expect(results).toEqual([
      { name: "allowed", isError: false, text: "allowed-ok" },
      { name: "sibling", isError: true, text: "Tool \"sibling\" is not available to this subagent." },
      { name: "foreign", isError: true, text: "Tool \"foreign\" is not available to this subagent." },
      { name: "approval", isError: false, text: "approval-ok" },
      { name: "approval", isError: false, text: "approval-ok" },
      { name: "approval", isError: false, text: "approval-ok" },
    ]);
    expect(confirm).not.toHaveBeenCalled(); // no prompt for an out-of-scope tool
    expect(existsSync(sideEffect)).toBe(false);
  });

  it("gates the effective same-name extension tool for direct and nested calls in both load orders", async () => {
    const { alpha, beta, sideEffect } = collisionFixture();
    const blocked = 'Tool "same" is not available to this subagent.';
    for (const extensions of [[beta, alpha], [alpha, beta]]) {
      const effectivePath = extensions[0];
      const isBlocked = effectivePath === beta;
      for (const callName of ["same", "gateway"]) {
        const { session } = await runChild({
          extensions,
          extSelectors: ["ext:selected-alpha.mjs/same", "ext:selected-alpha.mjs/gateway"],
        }, undefined, callName);
        expect(session.getAllTools().find((tool) => tool.name === "same")?.sourceInfo.path).toBe(effectivePath);
        const result = session.messages.find((m) => m.role === "toolResult" && m.toolName === callName);
        if (result?.role !== "toolResult") throw new Error(`${callName} result missing`);
        const text = result.content.map((part) => part.type === "text" ? part.text : "").join("");
        if (callName === "same") {
          expect(result.isError).toBe(isBlocked);
          expect(text).toBe(isBlocked ? blocked : "alpha-ok");
        } else {
          expect(result.isError).toBe(false);
          expect(JSON.parse(text)).toEqual({ isError: isBlocked, text: isBlocked ? blocked : "alpha-ok" });
        }
        expect(existsSync(sideEffect)).toBe(false);
      }
    }
  });

  it("loads public SDK built-ins with Pi selectors, without bypassing extensions: false", async () => {
    const all = await runChild({ extensions: true, builtinToolNames: [] });
    expect(all.session.resourceLoader.getExtensions().extensions.map((e) => e.path)).toEqual(expect.arrayContaining([
      "<inline:pi-subagents-tool-policy>", "builtin:codemode", "builtin:tool-search", "builtin:mcp",
    ]));
    expect(all.session.getAllTools().map((tool) => tool.name)).toEqual(expect.arrayContaining(["codemode", "tool_search"]));

    const selected = await runChild({ extensions: ["mcp"], builtinToolNames: [] });
    expect(selected.session.resourceLoader.getExtensions().extensions.map((e) => e.path)).toEqual([
      "<inline:pi-subagents-tool-policy>", "builtin:mcp",
    ]);
    expect(selected.session.getAllTools().map((tool) => tool.name)).not.toContain("codemode");
    expect(selected.session.getAllTools().map((tool) => tool.name)).not.toContain("tool_search");

    const excluded = await runChild({ extensions: true, excludeExtensions: ["mcp"], builtinToolNames: [] });
    expect(excluded.session.resourceLoader.getExtensions().extensions.map((e) => e.path)).not.toContain("builtin:mcp");
    const none = await runChild({ extensions: false, builtinToolNames: [] });
    expect(none.session.resourceLoader.getExtensions().extensions.map((e) => e.path)).toEqual([
      "<inline:pi-subagents-tool-policy>",
    ]);
    expect(none.session.getAllTools().map((tool) => tool.name)).not.toContain("codemode");
    expect(none.session.getAllTools().map((tool) => tool.name)).not.toContain("tool_search");
  });

  it("preserves Pi exposure and defaultActive for eager and session_start tools", async () => {
    const path = exposureFixture();
    const { session } = await runChild({ extensions: [path], extSelectors: ["ext:exposure-fixture.mjs"] });
    const active = session.getActiveToolNames();
    for (const name of ["direct_probe", "model_probe", "late_direct", "gateway"]) {
      expect(active).toContain(name);
    }
    for (const name of ["deferred_probe", "inactive_probe", "late_deferred", "late_inactive"]) {
      expect(active).not.toContain(name);
    }
    expect(session.getAllTools().find((tool) => tool.name === "direct_probe")?.sourceInfo.path).toBe(path);
    expect(session.getCallableToolNames()).toContain("deferred_probe");

    // A later turn_end must not undo an intentional deactivation merely because
    // the registered tool is still inside the child's extension selector.
    session.setActiveToolsByName(["direct_probe"]);
    faux.setResponses([() => fauxAssistantMessage(fauxText("resumed"))]);
    await resumeAgent(session, "continue");
    expect(session.getActiveToolNames()).toEqual(["direct_probe"]);
  });

  it("does not time out an interactive ask_tools decision before tool execution begins", async () => {
    setDefaultToolTimeoutMs(20);
    const { alpha } = fixture();
    const confirm = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 70));
      return true;
    });
    const { session } = await runChild({
      extensions: [alpha],
      extSelectors: ["ext:alpha.mjs/approval"],
      askTools: ["approval"],
    }, confirm, "approval");
    const result = session.messages.find((m) => m.role === "toolResult" && m.toolName === "approval");
    if (result?.role !== "toolResult") throw new Error("approval result missing");
    expect(confirm).toHaveBeenCalledOnce();
    expect(result.isError).toBe(false);
    expect(result.content.map((part) => part.type === "text" ? part.text : "").join(""))
      .toBe("approval-ok");
  });

  it("keeps interactive approval unbounded on a resumed child while rearming execution timeout", async () => {
    setDefaultToolTimeoutMs(20);
    const { alpha } = fixture();
    const confirm = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 70));
      return true;
    });
    const { session } = await runChild({
      extensions: [alpha],
      extSelectors: ["ext:alpha.mjs/allowed", "ext:alpha.mjs/approval"],
      askTools: ["approval"],
    }, confirm, "allowed");
    expect(confirm).not.toHaveBeenCalled();
    faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("approval", {}), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxText("resumed")),
    ]);
    await resumeAgent(session, "approve next call");
    const result = session.messages.find((m) => m.role === "toolResult" && m.toolName === "approval");
    if (result?.role !== "toolResult") throw new Error("resumed approval result missing");
    expect(confirm).toHaveBeenCalledOnce();
    expect(result.isError).toBe(false);
    expect(result.content.map((part) => part.type === "text" ? part.text : "").join(""))
      .toBe("approval-ok");
  });

  it("returns a blocked direct tool result for a selected extension's hanging tool_call hook", async () => {
    setDefaultToolTimeoutMs(20);
    const { path } = hangingHandlerFixture();
    const { session } = await runChild({ extensions: [path], extSelectors: ["ext:hanging-handler.mjs/target"] }, undefined, "target");
    const result = session.messages.find((m) => m.role === "toolResult" && m.toolName === "target");
    if (result?.role !== "toolResult") throw new Error("target result missing");
    expect(result.isError).toBe(true);
    expect(result.content.map((part) => part.type === "text" ? part.text : "").join(""))
      .toContain('tool_call for "target" timed out');
  });

  it("starts the hanging-hook deadline only after interactive approval", async () => {
    setDefaultToolTimeoutMs(20);
    const { path } = hangingHandlerFixture();
    const confirm = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 70));
      return true;
    });
    const { session } = await runChild({
      extensions: [path], extSelectors: ["ext:hanging-handler.mjs/target"], askTools: ["target"],
    }, confirm, "target");
    const result = session.messages.find((m) => m.role === "toolResult" && m.toolName === "target");
    if (result?.role !== "toolResult") throw new Error("approved target result missing");
    expect(confirm).toHaveBeenCalledOnce();
    expect(result.isError).toBe(true);
    expect(result.content.map((part) => part.type === "text" ? part.text : "").join(""))
      .toContain('tool_call for "target" timed out');
  });

  it("bounds a late pi.on hook on nested calls and honors its unsubscribe", async () => {
    setDefaultToolTimeoutMs(20);
    const { path, outcomeFile } = hangingHandlerFixture(true);
    const { session } = await runChild({ extensions: [path], extSelectors: ["ext:late-handler.mjs"] });
    const result = session.messages.find((m) => m.role === "toolResult" && m.toolName === "gateway");
    if (result?.role !== "toolResult") throw new Error("gateway result missing");
    const outcomes = JSON.parse(result.content.map((part) => part.type === "text" ? part.text : "").join(""));
    expect(outcomes).toEqual([
      { isError: true, text: expect.stringContaining('tool_call for "target" timed out') },
      { isError: false, text: "target-ok" },
    ]);
    expect(JSON.parse(readFileSync(outcomeFile, "utf8"))).toEqual(outcomes);
    const extension = session.resourceLoader.getExtensions().extensions.find((entry) => entry.path === path);
    expect(extension?.sourceInfo.path).toBe(path);
    expect(extension?.handlers.get("tool_call")).toBeUndefined();
  });
});
