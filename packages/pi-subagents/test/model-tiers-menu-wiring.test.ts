/**
 * model-tiers-menu-wiring.test.ts — drives `/agents → Model tiers` through the
 * REAL registered command, with only the dialogs stubbed.
 *
 * The pure edit helpers are covered in agent-tiers.test.ts. What is only
 * checkable here is the wiring: that a menu answer reaches the tier catalogue,
 * that the catalogue reaches `<cwd>/.pi/subagents.json`, and that the pickers
 * are populated from pi's own model registry rather than from a list this
 * package maintains by hand.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { setDefaultModel } from "../src/agent-runner.js";
import { setAgentTiersSettings } from "../src/agent-tiers.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";

/** `null` marks an unsupported level, so this model tops out below `high`. */
const fast = {
  id: "fast",
  name: "Fast",
  provider: "test",
  reasoning: true,
  thinkingLevelMap: { high: null, xhigh: null, max: null },
};
const big = { id: "big", name: "Big", provider: "test", reasoning: true };
const models = [fast, big];

function makePi() {
  const commands = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, def: any) => commands.set(name, def)),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, commands, lifecycle };
}

/**
 * One scripted dialog answer. A function receives the prompt title and the
 * offered options, so a test can both choose an answer and assert on what it
 * was offered without hardcoding menu strings that carry live counts.
 */
type Answer = string | ((title: string, options: string[]) => string | undefined);

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

/** Pick the first option starting with `prefix`; fail loudly when absent. */
const byPrefix = (prefix: string): Answer => (title, options) => {
  const found = options.find(o => o.startsWith(prefix));
  if (!found) throw new Error(`no option starting with "${prefix}" in ${title}: ${options.join(" | ")}`);
  return found;
};

function makeCtx(script: Answer[]) {
  /** Every set of options a `select` was offered, in order, for assertions. */
  const offered: { title: string; options: string[] }[] = [];
  const notices: string[] = [];
  const next = (title: string, options: string[]): string | undefined => {
    const answer = script.shift();
    if (answer === undefined) return undefined; // script exhausted → Esc, unwinding the menus
    return typeof answer === "function" ? answer(title, options) : answer;
  };

  return {
    ctx: {
      hasUI: true,
      cwd,
      model: undefined,
      modelRegistry: {
        find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id),
        getAll: () => models,
        getAvailable: () => models,
      },
      scopedModels: [],
      sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
      getSystemPrompt: vi.fn(() => "parent"),
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn((message: string) => { notices.push(message); }),
        select: vi.fn(async (title: string, options: string[]) => {
          offered.push({ title, options });
          return next(title, options);
        }),
        input: vi.fn(async (title: string) => next(title, [])),
        confirm: vi.fn(async (title: string) => next(title, []) !== undefined),
      },
    } as any,
    offered,
    notices,
  };
}

/** Boot the extension against the temp cwd and return the `/agents` handler. */
function boot() {
  const { pi, commands, lifecycle } = makePi();
  subagentsExtension(pi);
  const activation = makeCtx([]).ctx;
  activation.sessionManager.getSessionId = vi.fn(() => undefined);
  void lifecycle.get("session_start")?.({}, activation);
  return commands.get("agents").handler;
}

const readProjectSettings = () =>
  JSON.parse(readFileSync(join(cwd, ".pi", "subagents.json"), "utf-8"));

function writeProjectSettings(obj: unknown) {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify(obj));
}

describe("/agents → Model tiers", () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "tier-menu-wiring-"));
    process.chdir(cwd);
    // A developer's real ~/.pi/subagents.json would otherwise supply a tier
    // catalogue underneath these tests.
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    originalHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
    process.env.HOME = cwd;
  });

  afterEach(() => {
    setAgentTiersSettings({});
    setDefaultModel(undefined);
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    delete (globalThis as any)[Symbol.for("pi-subagents:manager-active")];
    delete (globalThis as any)[Symbol.for("pi-subagents:rpc-owner")];
    process.chdir(originalCwd);
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    registerAgents(new Map());
    rmSync(cwd, { recursive: true, force: true });
  });

  it("creates a tier and persists it to the project settings file", async () => {
    const handler = boot();
    const { ctx } = makeCtx([
      byPrefix("Model tiers ("),
      byPrefix("+ New tier"),
      "cheap",
      "test/fast",
      "low",
      "quick exploration",
    ]);

    await handler(undefined, ctx);

    expect(readProjectSettings().agentTiers).toEqual({
      profiles: { cheap: { model: "test/fast", thinking: "low", description: "quick exploration" } },
    });
  });

  it("offers the model picker from pi's registry, not from a hardcoded list", async () => {
    const handler = boot();
    const { ctx, offered } = makeCtx([
      byPrefix("Model tiers ("),
      byPrefix("+ New tier"),
      "cheap",
      "test/big",
      "max",
      "",
    ]);

    await handler(undefined, ctx);

    const modelPrompt = offered.find(o => o.title.startsWith("Model for"));
    expect(modelPrompt?.options).toEqual(["inherit", "test/big", "test/fast", "custom..."]);
    // Empty description falls back to the key rather than persisting a blank.
    expect(readProjectSettings().agentTiers.profiles.cheap).toEqual({
      model: "test/big",
      thinking: "max",
    });
  });

  it("offers only the thinking levels the chosen model actually supports", async () => {
    const handler = boot();
    const { ctx, offered } = makeCtx([
      byPrefix("Model tiers ("),
      byPrefix("+ New tier"),
      "cheap",
      "test/fast",
      "medium",
      "",
    ]);

    await handler(undefined, ctx);

    // `fast` maps high/xhigh/max to null. Offering them would promise a level
    // that resolveAgentTier silently clamps down at spawn time.
    const thinkingPrompt = offered.find(o => o.title.startsWith("Thinking level"));
    expect(thinkingPrompt?.options).toEqual(["inherit", "minimal", "low", "medium"]);
  });

  it("clears the default tier when the tier it names is deleted, and persists both", async () => {
    writeProjectSettings({
      agentTiers: {
        defaultTier: "cheap",
        profiles: {
          cheap: { model: "test/fast", thinking: "low" },
          heavy: { model: "test/big", thinking: "max" },
        },
      },
    });
    const handler = boot();
    const { ctx } = makeCtx([
      byPrefix("Model tiers ("),
      byPrefix("cheap"),
      "Delete tier",
      "yes", // confirm() resolves true for any non-undefined answer
    ]);

    await handler(undefined, ctx);

    expect(readProjectSettings().agentTiers).toEqual({
      profiles: { heavy: { model: "test/big", thinking: "max" } },
    });
  });

  it("lists a tier dropped as malformed so it can be redefined in place", async () => {
    writeProjectSettings({
      agentTiers: { profiles: { broken: { model: "test/fast" } } }, // no thinking → blocked
    });
    const handler = boot();
    const { ctx, offered } = makeCtx([
      byPrefix("Model tiers ("),
      byPrefix("broken"),
      "yes", // confirm the redefine prompt
      // No tier-name prompt: the blocked key is reused, so the next answer is
      // the model. A name prompt here would consume "test/big" as the key.
      "test/big",
      "max",
      "",
    ]);

    await handler(undefined, ctx);

    const tierMenu = offered.find(o => o.title === "Model tiers");
    // The shipped ladder is present (editable) alongside the blocked key. None
    // is marked "(default)": the shipped fallback is scoped to managed calls
    // and is not the catalogue's default tier.
    expect(tierMenu?.options).toEqual([
      "broken — blocked (malformed profile in subagents.json)",
      "high — inherit · thinking high",
      "low — inherit · thinking low",
      "medium — inherit · thinking medium",
      "+ New tier...",
    ]);
    // Redefining retires the tombstone in the same write.
    expect(readProjectSettings().agentTiers).toEqual({
      profiles: { broken: { model: "test/big", thinking: "max" } },
    });
  });
});
