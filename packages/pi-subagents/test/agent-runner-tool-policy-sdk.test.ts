import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { streamSimple as compatStreamSimple } from "@earendil-works/pi-ai/compat";
import { type ExtensionAPI, type ExtensionContext, type ModelRuntime, VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent, setDefaultToolTimeoutMs } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { clearGateCache } from "../src/gate.js";
import type { AgentConfig } from "../src/types.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

// Tool exposure and nested ctx.executeTool are public Pi 0.99 APIs. The older
// supported loaders are exercised by agent-runner.test.ts and loader-sdk.test.ts.
describe.skipIf(VERSION !== "1.5.0")("child tool policy on real Pi", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let oldAgentDir: string | undefined;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    clearGateCache();
    root = mkdtempSync(join(tmpdir(), "subagent-tool-policy-"));
    cwd = join(root, "project");
    agentDir = join(root, "agent");
    mkdirSync(cwd);
    mkdirSync(agentDir);
    oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    faux = registerFauxProvider({ provider: "policy-faux", models: [{ id: "policy", contextWindow: 200_000 }] });
  });

  afterEach(() => {
    setDefaultToolTimeoutMs(0);
    faux.unregister();
    registerAgents(new Map());
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  function extension(name: string, body: string): string {
    const path = join(root, `${name}.mjs`);
    writeFileSync(path, body);
    return path;
  }

  async function runChild(
    paths: string[],
    calls: string[],
    onCreated?: (session: Awaited<ReturnType<typeof runAgent>>["session"]) => void,
    approval?: { tool: string; confirm: () => Promise<boolean> },
    gate?: { command: string; exec: ExtensionAPI["exec"] },
  ) {
    registerAgents(new Map([["policy", {
      name: "policy", description: "policy", builtinToolNames: [],
      extensions: paths, skills: false, systemPrompt: "Use the requested tools.",
      ...(approval ? { askTools: [approval.tool] } : {}),
      ...(gate ? { gate: gate.command } : {}),
      promptMode: "replace", inheritContext: false, runInBackground: false, isolated: false,
    } as AgentConfig]]));
    const model = faux.getModel();
    const runtime = {
      getAuth: async () => ({ ok: true, apiKey: "faux", headers: {} }),
      stream: () => { throw new Error("Fixture uses streamSimple"); },
      streamSimple: (m: typeof model, context: Parameters<typeof compatStreamSimple>[1], options: Parameters<typeof compatStreamSimple>[2]) =>
        compatStreamSimple(m, context, { ...options, apiKey: "faux" }),
      getModel: () => model, getModels: () => [model], getAvailable: async () => [model],
      hasConfiguredAuth: () => true, isUsingOAuth: () => false,
      getProviders: () => [], getProvider: () => undefined,
    } as unknown as ModelRuntime;
    faux.setResponses([
      ...calls.map((name) => () => fauxAssistantMessage(fauxToolCall(name, {}), { stopReason: "toolUse" })),
      () => fauxAssistantMessage(fauxText("done")),
    ]);
    const modelRegistry = {
      runtime, find: () => model, getAll: () => [model], getAvailable: () => [model],
      hasConfiguredAuth: () => true, isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
      registerProvider: () => {}, unregisterProvider: () => {},
    } as unknown as ExtensionContext["modelRegistry"];
    const ctx = {
      cwd, model, modelRegistry, isProjectTrusted: () => true, getSystemPrompt: () => "parent",
      hasUI: Boolean(approval), ui: { confirm: approval?.confirm },
    } as unknown as ExtensionContext;
    return runAgent(ctx, "policy", "go", {
      pi: { exec: gate?.exec ?? (async () => ({ code: 1, killed: false, stdout: "", stderr: "" })) } as unknown as ExtensionAPI,
      model, supervisorQuestions: false, onSessionCreated: onCreated,
    });
  }

  function resultTexts(session: Awaited<ReturnType<typeof runAgent>>["session"], name: string): Array<{ isError: boolean; text: string }> {
    return session.messages.filter((m) => m.role === "toolResult" && m.toolName === name)
      .map((m) => ({ isError: m.isError, text: m.content.map((c) => c.type === "text" ? c.text : "").join("") }));
  }

  it.each([
    { code: 0, killed: false, status: "PASSED" },
    { code: 7, killed: false, status: "FAILED" },
    { code: 0, killed: true, status: "FAILED" },
  ])("translates host exec results for gates ($code, killed=$killed)", async ({ code, killed, status }) => {
    const exec = vi.fn<ExtensionAPI["exec"]>(async (file, args) => ({
      stdout: file === "git" && args[0] === "rev-parse" ? "head\n" : "",
      stderr: "", code: file === "git" ? 0 : code, killed: file === "git" ? false : killed,
    }));
    const first = await runChild([], [], undefined, undefined, { command: `check-${code}-${killed}`, exec });
    expect(first.responseText).toContain(`Acceptance gate \`check-${code}-${killed}\`: ${status}`);
    expect(exec.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ["git", ["rev-parse", "--is-inside-work-tree"]],
      ["git", ["rev-parse", "HEAD"]], ["git", ["status", "--porcelain", "--untracked-files=all"]],
      ["git", ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "HEAD"]], ["sh", ["-c", `check-${code}-${killed}`]],
    ]);
    // A successful host-shaped git inspection establishes a reusable fingerprint.
    const second = await runChild([], [], undefined, undefined, { command: `check-${code}-${killed}`, exec });
    expect(second.responseText).toContain(`${status} (cached`);
    expect(exec.mock.calls.filter(([file]) => file === "sh")).toHaveLength(1);
  });

  it("does not cache a gate when a host-shaped git inspection was killed with code zero", async () => {
    const exec = vi.fn<ExtensionAPI["exec"]>(async (file) => ({
      stdout: "", stderr: "", code: 0, killed: file === "git",
    }));
    for (let i = 0; i < 2; i++) {
      const result = await runChild([], [], undefined, undefined, { command: "check-killed-fingerprint", exec });
      expect(result.responseText).toContain("Acceptance gate `check-killed-fingerprint`: PASSED");
      expect(result.responseText).not.toContain("(cached");
    }
    expect(exec.mock.calls.filter(([file]) => file === "sh")).toHaveLength(2);
  });

  it("preserves Pi exposure and defaultActive, including after a turn and deliberate deactivation", async () => {
    const path = extension("exposure", `
      export default function(pi) {
      const p = { type: "object", properties: {}, additionalProperties: false };
      for (const [name, extra] of [
        ["direct_probe", {}],
        ["model_probe", { exposure: "model-only" }],
        ["deferred_probe", { exposure: "deferred" }],
        ["codemode_probe", { exposure: "codemode" }],
        ["inactive_probe", { defaultActive: false }],
      ]) pi.registerTool({ name, label: name, description: name, parameters: p, ...extra,
        async execute() { return { content: [{ type: "text", text: name }] }; },
      });
      }
    `);
    let atStart: string[] = [];
    const { session } = await runChild([path], [], (created) => {
      atStart = created.getActiveToolNames();
      created.setActiveToolsByName(atStart.filter((name) => name !== "direct_probe"));
    });
    expect(atStart).toEqual(expect.arrayContaining(["direct_probe", "model_probe"]));
    for (const name of ["deferred_probe", "codemode_probe", "inactive_probe"]) {
      expect(atStart).not.toContain(name);
      expect(session.getActiveToolNames()).not.toContain(name);
    }
    expect(session.getActiveToolNames()).not.toContain("direct_probe");
    expect(session.getActiveToolNames()).toContain("model_probe");
  });

  it.each(["hang_probe", "gateway"])("blocks a hanging selected hook on %s before tool execution", async (callName) => {
    setDefaultToolTimeoutMs(20);
    const marker = join(root, "executed");
    const path = extension("hang", `
      import { writeFileSync } from "node:fs";
      const p = { type: "object", properties: {}, additionalProperties: false };
      export default function(pi) {
        pi.on("tool_call", async (event) => {
          if (event.toolName === "hang_probe") await new Promise(() => {});
        });
        pi.registerTool({ name: "hang_probe", label: "hang", description: "hang", parameters: p,
          async execute() {
            writeFileSync(${JSON.stringify(marker)}, "executed");
            return { content: [{ type: "text", text: "bad" }] };
          },
        });
        pi.registerTool({ name: "gateway", label: "gateway", description: "nested caller", parameters: p,
          async execute(_id, _args, _signal, _onUpdate, ctx) {
            const outcome = await ctx.executeTool("hang_probe", {});
            return { content: [{ type: "text", text: JSON.stringify({
              isError: outcome.isError,
              text: outcome.result.content.map((part) => part.text ?? "").join("")
            }) }] };
          },
        });
      }
    `);
    const { session } = await runChild([path], [callName]);
    const results = resultTexts(session, callName);
    expect(results).toHaveLength(1);
    if (callName === "hang_probe") {
      expect(results[0]).toMatchObject({ isError: true, text: expect.stringContaining("timed out") });
    } else {
      expect(results[0]?.isError).toBe(false);
      expect(JSON.parse(results[0]?.text ?? "")).toMatchObject({ isError: true, text: expect.stringContaining("timed out") });
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("does not charge a nested human approval to either tool execution timer", async () => {
    setDefaultToolTimeoutMs(20);
    const path = extension("approval", `
      export default function(pi) {
        const p = { type: "object", properties: {}, additionalProperties: false };
        pi.registerTool({ name: "approved_probe", label: "approved", description: "approved", parameters: p,
          async execute() { return { content: [{ type: "text", text: "approved" }] }; },
        });
        pi.registerTool({ name: "gateway", label: "gateway", description: "nested caller", parameters: p,
          async execute(_id, _args, _signal, _onUpdate, ctx) {
            const outcome = await ctx.executeTool("approved_probe", {});
            return { content: [{ type: "text", text: JSON.stringify({
              isError: outcome.isError,
              text: outcome.result.content.map((part) => part.text ?? "").join("")
            }) }] };
          },
        });
      }
    `);
    const confirm = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 70));
      return true;
    });
    const { session } = await runChild([path], ["gateway"], undefined, { tool: "approved_probe", confirm });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(resultTexts(session, "gateway")).toEqual([{
      isError: false,
      text: JSON.stringify({ isError: false, text: "approved" }),
    }]);
  });

  it("times a tool_call handler registered during session_start", async () => {
    setDefaultToolTimeoutMs(20);
    const path = extension("late-hang", `
      export default function(pi) {
        const p = { type: "object", properties: {}, additionalProperties: false };
        pi.on("session_start", () => pi.on("tool_call", async (event) => {
          if (event.toolName === "late_probe") await new Promise(() => {});
        }));
        pi.registerTool({ name: "late_probe", label: "late", description: "late", parameters: p,
          async execute() { return { content: [{ type: "text", text: "bad" }] }; },
        });
      }
    `);
    const { session } = await runChild([path], ["late_probe"]);
    expect(resultTexts(session, "late_probe")).toEqual([{
      isError: true, text: expect.stringContaining("timed out"),
    }]);
  });

  it("wraps a late pi.on registration and respects its unsubscribe on the next call", async () => {
    const path = extension("late", `
      const p = { type: "object", properties: {}, additionalProperties: false };
      export default function(pi) {
        pi.on("session_start", () => {
          const unsubscribe = pi.on("tool_call", (event) => {
            if (event.toolName !== "late_probe") return;
            unsubscribe();
            return { block: true, reason: "late hook blocked once" };
          });
        });
        pi.registerTool({ name: "late_probe", label: "late", description: "late", parameters: p,
          async execute() { return { content: [{ type: "text", text: "executed" }] }; },
        });
      }
    `);
    const { session } = await runChild([path], ["late_probe", "late_probe"]);
    expect(resultTexts(session, "late_probe")).toEqual([
      { isError: true, text: "late hook blocked once" },
      { isError: false, text: "executed" },
    ]);
  });
});
