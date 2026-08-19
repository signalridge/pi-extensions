/**
 * agents-menu-diagnostics.test.ts — drives `/agents → Diagnostics` and
 * `/agents → Usage` through the REAL registered command, with only the dialogs
 * stubbed.
 *
 * Both surfaces exist to answer a question after the fact: "why isn't my agent
 * here?" and "what did this session spend?". Load-time warnings and fleet rows
 * have both scrolled away by then, so what matters is that these read live
 * state rather than a snapshot taken when the menu was built.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent, setDefaultModel } from "../src/agent-runner.js";
import { setAgentTiersSettings } from "../src/agent-tiers.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";

const fast = { id: "fast", name: "Fast", provider: "test", reasoning: true };
const models = [fast];

function makePi() {
  const commands = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const tools = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, def: any) => commands.set(name, def)),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, commands, lifecycle, tools };
}

type Answer = string | ((title: string, options: string[]) => string | undefined);

const byPrefix =
  (prefix: string): Answer =>
  (title, options) => {
    const found = options.find((o) => o.startsWith(prefix));
    if (!found) throw new Error(`no option starting with "${prefix}" in ${title}: ${options.join(" | ")}`);
    return found;
  };

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

function makeCtx(script: Answer[]) {
  const offered: { title: string; options: string[] }[] = [];
  const notices: string[] = [];
  const next = (title: string, options: string[]): string | undefined => {
    const answer = script.shift();
    if (answer === undefined) return undefined;
    return typeof answer === "function" ? answer(title, options) : answer;
  };

  return {
    ctx: {
      hasUI: true,
      cwd,
      model: undefined,
      modelRegistry: {
        find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
        getAll: () => models,
        getAvailable: () => models,
      },
      scopedModels: [],
      sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
      getSystemPrompt: vi.fn(() => "parent"),
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn((message: string) => {
          notices.push(message);
        }),
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

function boot() {
  const { pi, commands, lifecycle, tools } = makePi();
  subagentsExtension(pi);
  const activation = makeCtx([]).ctx;
  activation.sessionManager.getSessionId = vi.fn(() => undefined);
  void lifecycle.get("session_start")?.({}, activation);
  return { handler: commands.get("agents").handler, tools, lifecycle };
}

function writeAgentFile(name: string, contents: string) {
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "agents", `${name}.md`), contents);
}

function writeProjectSettings(obj: unknown) {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify(obj));
}

/** The notice a menu action produced — the last one, since the menu re-opens. */
const noticeContaining = (notices: string[], needle: string) =>
  notices.find((n) => n.includes(needle));

beforeEach(() => {
  originalCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), "agents-menu-diag-"));
  process.chdir(cwd);
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

describe("/agents → Diagnostics", () => {
  it("reports a healthy workspace", async () => {
    const { handler } = boot();
    const { ctx, notices } = makeCtx([byPrefix("Diagnostics")]);
    await handler(undefined, ctx);

    const report = noticeContaining(notices, "agent directories");
    expect(report).toBeDefined();
    expect(report).toContain("✓ agent directories");
    expect(report).toContain("✓ agent files");
    expect(report).toContain("✓ tier references");
  });

  // Regression: a tier can name a model that resolves to an error STRING —
  // the registry has no such entry, or it has no auth configured. The
  // reference check passes (the tier exists), so without a liveness probe the
  // failure first appears at the spawn that uses it, minutes into a task.
  it("catches a tier whose model does not resolve, which reference checks miss", async () => {
    writeProjectSettings({
      agentTiers: { profiles: { cheap: { model: "test/does-not-exist", thinking: "low" } } },
    });
    const { handler } = boot();
    const { ctx, notices } = makeCtx([byPrefix("Diagnostics")]);
    await handler(undefined, ctx);

    const report = noticeContaining(notices, "tier models");
    expect(report).toContain("✗ tier models");
    expect(report).toContain("cheap → test/does-not-exist");
  });

  it("passes the liveness probe for a tier naming a real model", async () => {
    writeProjectSettings({ agentTiers: { profiles: { cheap: { model: "test/fast", thinking: "low" } } } });
    const { handler } = boot();
    const { ctx, notices } = makeCtx([byPrefix("Diagnostics")]);
    await handler(undefined, ctx);

    expect(noticeContaining(notices, "tier models")).toContain("✓ tier models");
  });

  // `inherit` is the point of a provider-neutral default: it resolves to the
  // parent's model, so there is no model reference to probe and it must not be
  // reported as dead.
  it("does not report an `inherit` tier as dead", async () => {
    writeProjectSettings({ agentTiers: { profiles: { same: { model: "inherit", thinking: "low" } } } });
    const { handler } = boot();
    const { ctx, notices } = makeCtx([byPrefix("Diagnostics")]);
    await handler(undefined, ctx);

    expect(noticeContaining(notices, "tier models")).toContain("✓ tier models");
  });

  it("reports an agent file that did not load", async () => {
    // A colon in `name:` is reserved for plugin scopes, so this file is refused
    // rather than registered under its filename.
    writeAgentFile("broken", "---\nname: plugin:thing\ndescription: nope\n---\nbody");
    const { handler } = boot();
    const { ctx, notices } = makeCtx([byPrefix("Diagnostics")]);
    await handler(undefined, ctx);

    const report = noticeContaining(notices, "agent files");
    expect(report).toContain("✗ agent files");
    expect(report).toContain("did not load");
  });

  it("counts a well-formed agent file as loaded", async () => {
    writeAgentFile("reviewer", "---\nname: reviewer\ndescription: reviews code\n---\nbody");
    const { handler } = boot();
    const { ctx, notices } = makeCtx([byPrefix("Diagnostics")]);
    await handler(undefined, ctx);

    expect(noticeContaining(notices, "agent files")).toContain("✓ agent files");
  });
});

describe("/agents → Usage", () => {
  it("says so plainly when nothing has run", async () => {
    const { handler } = boot();
    const { ctx, notices } = makeCtx([byPrefix("Usage (")]);
    await handler(undefined, ctx);

    expect(noticeContaining(notices, "No subagents have run")).toBeDefined();
  });

  it("accumulates a finished agent's tokens under its type", async () => {
    vi.mocked(runAgent).mockImplementation((async (_c: any, _t: any, _p: any, options: any) => {
      options.onAssistantUsage?.({ input: 1_000, output: 500, cacheWrite: 100 });
      return { responseText: "done", session: { dispose: vi.fn() }, aborted: false, steered: false };
    }) as any);

    const { handler, tools } = boot();
    await tools.get("Agent").execute("call-1", {
      subagent_type: "general-purpose",
      description: "d",
      prompt: "p",
    }, undefined, undefined, makeCtx([]).ctx);

    const { ctx, notices } = makeCtx([byPrefix("Usage (")]);
    await handler(undefined, ctx);

    const report = noticeContaining(notices, "run(s)");
    expect(report).toContain("1 run(s)");
    expect(report).toContain("Total");
  });

  // The reason this is accumulated on the terminal callback rather than
  // scanned from live records: records are evicted after they finish, and the
  // expensive agents are exactly the long-finished ones a scan would drop.
  // `session_before_switch` is the real eviction path (it calls
  // `clearCompleted`), so driving it proves the accumulator outlives records
  // rather than merely reading them faster.
  it("survives eviction of the record it came from", async () => {
    vi.mocked(runAgent).mockImplementation((async (_c: any, _t: any, _p: any, options: any) => {
      options.onAssistantUsage?.({ input: 2_000, output: 1_000, cacheWrite: 0 });
      return { responseText: "done", session: { dispose: vi.fn() }, aborted: false, steered: false };
    }) as any);

    const { handler, tools, lifecycle } = boot();
    await tools.get("Agent").execute("call-1", {
      subagent_type: "general-purpose",
      description: "d",
      prompt: "p",
    }, undefined, undefined, makeCtx([]).ctx);

    await lifecycle.get("session_before_switch")?.({}, makeCtx([]).ctx);

    const { ctx, notices } = makeCtx([byPrefix("Usage (")]);
    await handler(undefined, ctx);
    // The agent-runs entry is gone (its record was cleared) but usage remains.
    expect(noticeContaining(notices, "run(s)")).toContain("1 run(s)");
  });
});
