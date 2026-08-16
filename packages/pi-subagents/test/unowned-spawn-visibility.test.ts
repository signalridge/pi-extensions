/**
 * unowned-spawn-visibility.test.ts — the FleetView list must draw runs that
 * nobody asked for interactively, through the REAL extension (src/index.ts).
 *
 * The Agent tool and the managed RPC refresh the list from their own
 * handlers. Two paths do not: the legacy unowned RPC registry spawn and every
 * scheduler fire enter through the manager directly, and `onCreated` used to skip
 * them because they carry no owner. Those are exactly the runs nobody is watching,
 * so they are the ones that most need a row. runAgent is mocked (no LLM); the
 * manager, settings load, scheduler and lifecycle handlers are real.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

const SESSION_ID = "s1";
/** Short enough that a fire lands inside the poll window, long enough to arm first. */
const FIRE_INTERVAL_MS = 50;

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

/** The minimum a session needs to be for the fleet to consider an agent viewable. */
function fakeSession() {
  return {
    subscribe: () => () => {},
    messages: [],
    dispose: () => {},
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
  } as any;
}

function uiCtx() {
  return {
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    notify: vi.fn(),
    onTerminalInput: vi.fn(() => vi.fn()),
    getEditorText: vi.fn(() => ""),
    custom: vi.fn(),
    select: vi.fn(async () => undefined),
  };
}

function ctxWith(ui: ReturnType<typeof uiCtx>, hasUI = true) {
  return {
    mode: "tui",
    hasUI,
    ui,
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => SESSION_ID, getBranch: () => [] },
    getSystemPrompt: () => "parent",
  } as any;
}

/** Did anything register (or clear) this widget key? */
const touched = (ui: ReturnType<typeof uiCtx>, key: string): boolean =>
  ui.setWidget.mock.calls.some(call => call[0] === key);

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return predicate();
}

describe("unowned spawn visibility (real extension lifecycle)", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let shutdown: (() => Promise<void>) | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-unowned-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-unowned-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi", "subagent-schedules"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: true, defaultJoinMode: "async", maxConcurrent: 1 }),
    );
    writeFileSync(
      join(tmpDir, ".pi", "subagent-schedules", `${SESSION_ID}.json`),
      JSON.stringify({
        jobs: [{
          id: "job-1",
          name: "tick",
          description: "scheduled sweep",
          schedule: `${FIRE_INTERVAL_MS}ms`,
          scheduleType: "interval",
          intervalMs: FIRE_INTERVAL_MS,
          subagent_type: "general-purpose",
          prompt: "go",
          enabled: true,
          createdAt: new Date(0).toISOString(),
          runCount: 0,
        }],
      }),
    );
    process.chdir(tmpDir);
    // Creates a session, then never resolves: the record stays running with the
    // session the fleet requires, so both surfaces have something to draw for the
    // whole assertion window.
    vi.mocked(runAgent).mockImplementation(((_ctx: unknown, _type: unknown, _prompt: unknown, options: any) => {
      options.onSessionCreated?.(fakeSession());
      return new Promise(() => {});
    }) as any);
  });

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("draws both surfaces when a scheduler job fires", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    await lifecycle.get("session_start")?.({}, ctxWith(ui));
    shutdown = () => lifecycle.get("session_shutdown")?.({}, ctxWith(ui));
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));
    ui.setWidget.mockClear();

    const drawn = await waitFor(() => touched(ui, "fleet"));

    expect(drawn, "a scheduler fire must reach the agent list").toBe(true);
  });

  it("draws nothing when the session has no UI", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    await lifecycle.get("session_start")?.({}, ctxWith(ui, false));
    shutdown = () => lifecycle.get("session_shutdown")?.({}, ctxWith(ui, false));
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui, false));
    ui.setWidget.mockClear();

    const fired = await waitFor(() =>
      pi.events.emit.mock.calls.some((call: unknown[]) => call[0] === "subagents:started"),
    );

    expect(fired, "the scheduler must still have fired").toBe(true);
    expect(touched(ui, "fleet")).toBe(false);
  });

  it("draws into the live session's list after a session switch", async () => {
    // Scheduling off: this exercises the other unowned path (the legacy registry
    // spawn), and leaves nothing running for the switch to wait on.
    writeFileSync(
      join(tmpDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, defaultJoinMode: "async", maxConcurrent: 1 }),
    );
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const retired = uiCtx();
    const live = uiCtx();
    await lifecycle.get("session_start")?.({}, ctxWith(retired));
    shutdown = () => lifecycle.get("session_shutdown")?.({}, ctxWith(live));
    // Only tool_execution_start seeds the surfaces, and it belongs to the session
    // that is about to be retired.
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(retired));
    await lifecycle.get("session_before_switch")?.({}, ctxWith(retired));
    await lifecycle.get("session_start")?.({}, ctxWith(live));
    retired.setWidget.mockClear();

    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    registry.spawn(pi, ctxWith(live), "general-purpose", "go", {
      description: "unowned run",
      isBackground: true,
      bypassQueue: true,
    });
    const drawn = await waitFor(() => touched(live, "fleet"));

    expect(drawn, "the refresh must draw into the session that is actually on screen").toBe(true);
    expect(touched(retired, "fleet"), "the retired session must not be painted").toBe(false);
  });

  it("clears the list surface on shutdown", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    await lifecycle.get("session_start")?.({}, ctxWith(ui));
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));
    await waitFor(() => touched(ui, "fleet"));
    ui.setWidget.mockClear();

    await lifecycle.get("session_shutdown")?.({}, ctxWith(ui));

    // Only dispose() clears a list still showing a finished agent, and it is
    // also the only thing that stops its ticker.
    expect(ui.setWidget.mock.calls.some((call: unknown[]) => call[0] === "fleet" && call[1] === undefined))
      .toBe(true);
  });

  it("never draws for a nested child", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    await lifecycle.get("session_start")?.({}, ctxWith(ui));
    shutdown = () => lifecycle.get("session_shutdown")?.({}, ctxWith(ui));
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));

    // The parent's nested runtime is the only handle on a real nested spawn:
    // its `manager` is the extension's own, wired to the lifecycle callbacks
    // under test. runAgent is mocked, so the test plays the child session's part.
    let nested: { manager: any; parentAgentId: string; depth: number } | undefined;
    vi.mocked(runAgent).mockImplementation(((_ctx: unknown, _type: unknown, _prompt: unknown, options: any) => {
      nested = options.nestedRuntime;
      options.onSessionCreated?.(fakeSession());
      return new Promise(() => {});
    }) as any);

    await tools.get("Agent").execute(
      "tc-parent",
      { prompt: "go", description: "parent run", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctxWith(ui),
    );
    expect(nested?.parentAgentId, "parent must expose a nested runtime").toBeTruthy();

    // Assert synchronously: spawn() runs onCreated and onStart inline, so nothing
    // the refresh would do can arrive later than this call returning.
    ui.setWidget.mockClear();
    nested?.manager.spawn(pi, ctxWith(ui), "general-purpose", "child work", {
      description: "nested child",
      parentAgentId: nested.parentAgentId,
      depth: (nested.depth ?? 1) + 1,
      isBackground: true,
      bypassQueue: true,
    });

    expect(ui.setWidget).not.toHaveBeenCalled();
  });
});
