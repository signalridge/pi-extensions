import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentTiersSettings, resolveAgentTier, setAgentTiersSettings } from "../src/agent-tiers.js";
import { getAgentConfig } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import subagentsExtension from "../src/index.js";
import { loadSettings } from "../src/settings.js";
import { mockParentRegistry } from "./helpers/model-runtime.js";

let cwd: string;
let previousAgentDir: string | undefined;
let shutdown: (() => Promise<void>) | undefined;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-manual-tier-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
});

afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  for (const key of ["manager", "manager-active", "rpc-owner"]) Reflect.deleteProperty(globalThis, Symbol.for(`pi-subagents:${key}`));
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(cwd, { recursive: true, force: true });
});

async function wizard(options: { policy?: string; thinking?: string; approve?: boolean; key?: string; model?: string; changeDuringApproval?: boolean } = {}) {
  const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const events = { on: vi.fn(() => vi.fn()), emit: vi.fn() };
  const pi = {
    on: (name: string, handler: (...args: unknown[]) => unknown) => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, command),
    registerTool: vi.fn(), registerMessageRenderer: vi.fn(), events, appendEntry: vi.fn(), sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  let menuShown = false;
  const ui = {
    notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn(), onTerminalInput: vi.fn(() => vi.fn()), editor: vi.fn(async () => "Specialized instructions"),
    select: vi.fn(async (title: string, choices: string[]) => {
      if (title === "Agents") { if (menuShown) return undefined; menuShown = true; return "Create new agent"; }
      if (title === "Choose location") return "Project (.pi/agents/)";
      if (title === "Creation method") return "Manual configuration";
      if (title === "Tools") return "read-only (read, bash, grep, find, ls)";
      if (title === "Model policy") return options.policy ?? "Choose model and thinking...";
      if (title === "Model") return options.model ?? "inherit";
      if (title === "Thinking level") return options.thinking ?? "xhigh";
      if (title === "Use matching tier") return choices[0];
      return undefined;
    }),
    input: vi.fn(async (title: string) => {
      if (title.startsWith("Agent name")) return "reviewer";
      if (title.startsWith("Description")) return "Review changes";
      if (title.startsWith("New tier name")) return options.key ?? "review-effort";
      return undefined;
    }),
    confirm: vi.fn(async (title: string) => {
      if (title === "Add model tier?" && options.changeDuringApproval) setAgentTiersSettings({ profiles: { concurrent: { model: "inherit", thinking: "low" } } });
      return options.approve ?? true;
    }),
  };
  const ctx = {
    cwd, mode: "tui", hasUI: true, isProjectTrusted: () => true, ui,
    scopedModels: [], modelRegistry: { ...mockParentRegistry, find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => "wizard-parent", getBranch: () => [] }, getSystemPrompt: () => "parent",
  } as unknown as ExtensionCommandContext;
  subagentsExtension(pi);
  for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx as ExtensionContext);
  shutdown = async () => { for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx); };
  await commands.get("agents")!.handler("", ctx);
  return { ui, events, ctx, target: join(cwd, ".pi", "agents", "reviewer.md") };
}

describe("manual wizard model/thinking policy round trip", () => {
  it("saves a human-approved new named tier and reloads its effective child policy", async () => {
    const a = await wizard();
    const content = readFileSync(a.target, "utf8");
    expect(content).toContain("tier: review-effort\n");
    expect(content).not.toMatch(/^model:|^thinking:/m);
    expect(a.ui.confirm).toHaveBeenCalledWith("Add model tier?", expect.stringContaining("thinking: xhigh"));
    const loaded = loadSettings(cwd, true);
    expect(loaded.agentTiers?.profiles?.["review-effort"]).toMatchObject({ model: "inherit", thinking: "xhigh" });
    setAgentTiersSettings(loaded.agentTiers ?? {});
    const definition = loadCustomAgents(cwd, true, true).get("reviewer")!;
    expect(definition.agentTier).toBe("review-effort");
    expect(resolveAgentTier({ agentConfig: definition, modelRegistry: a.ctx.modelRegistry, parentThinking: "low" }).thinkingLevel).toBe("xhigh");
    expect(getAgentConfig("reviewer")?.agentTier).toBe("review-effort");
  });

  it.each(["inherit", "minimal", "low", "medium", "high", "xhigh", "max"] as const)("round-trips supported manual thinking %s through a tier", async thinking => {
    const a = await wizard({ thinking });
    const loaded = loadSettings(cwd, true);
    setAgentTiersSettings(loaded.agentTiers ?? {});
    const definition = loadCustomAgents(cwd, true, true).get("reviewer")!;
    expect(definition.agentTier).toBeDefined();
    const policy = resolveAgentTier({ agentConfig: definition, modelRegistry: a.ctx.modelRegistry, parentThinking: "low" });
    expect(policy.snapshot?.configuredThinking).toBe(thinking);
    expect(policy.thinkingLevel).toBe(thinking === "inherit" ? "low" : thinking);
    expect(readFileSync(a.target, "utf8")).not.toMatch(/^model:|^thinking:/m);
  });

  it("references an existing selected tier without mutating the catalogue", async () => {
    const before = readFileSync(join(cwd, ".pi", "subagents.json"), "utf8");
    const a = await wizard({ policy: "Tier: high" });
    expect(readFileSync(a.target, "utf8")).toContain("tier: high\n");
    expect(readFileSync(join(cwd, ".pi", "subagents.json"), "utf8")).toBe(before);
    expect(a.ui.confirm).not.toHaveBeenCalled();
  });

  it("reuses an exact existing pair without silently editing that tier", async () => {
    const a = await wizard({ thinking: "high" });
    expect(readFileSync(a.target, "utf8")).toContain("tier: high\n");
    expect(a.ui.select).toHaveBeenCalledWith("Use matching tier", ["high"]);
    expect(a.ui.confirm).not.toHaveBeenCalled();
    expect(loadSettings(cwd, true).agentTiers).toBeUndefined();
  });

  it("does not save either file when catalogue mutation is declined", async () => {
    const before = readFileSync(join(cwd, ".pi", "subagents.json"), "utf8");
    const a = await wizard({ approve: false });
    expect(existsSync(a.target)).toBe(false);
    expect(readFileSync(join(cwd, ".pi", "subagents.json"), "utf8")).toBe(before);
  });

  it("never replaces an existing tier to preserve a new model/thinking choice", async () => {
    const a = await wizard({ key: "high" });
    expect(existsSync(a.target)).toBe(false);
    expect(getAgentTiersSettings().profiles?.high).toMatchObject({ model: "inherit", thinking: "high" });
    expect(a.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Existing or blocked tiers are never edited"), "warning");
  });

  it("keeps explicit off visible but refuses an unrepresentable policy without converting it", async () => {
    const a = await wizard({ thinking: "off" });
    expect(a.ui.select).toHaveBeenCalledWith("Thinking level", expect.arrayContaining(["off", "inherit", "high"]));
    expect(existsSync(a.target)).toBe(false);
    expect(a.ui.confirm).not.toHaveBeenCalled();
    expect(a.ui.notify).toHaveBeenCalledWith(expect.stringContaining("requires a separate tier/protocol product decision"), "warning");
    expect(loadSettings(cwd, true).agentTiers).toBeUndefined();
  });

  it("refuses catalogue changes during approval instead of overwriting another edit", async () => {
    const a = await wizard({ changeDuringApproval: true });
    expect(existsSync(a.target)).toBe(false);
    expect(getAgentTiersSettings().profiles?.concurrent).toBeDefined();
    expect(getAgentTiersSettings().profiles?.["review-effort"]).toBeUndefined();
  });
});
