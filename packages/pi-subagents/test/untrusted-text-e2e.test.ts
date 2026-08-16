/**
 * untrusted-text-e2e.test.ts — poisoned text driven through the REAL loader and
 * the REAL extension renderers, not through a unit stub of the scrubber.
 *
 * Two paths the first sanitization pass missed: an agent file's `display_name`,
 * which reaches every label in the package through the agent registry, and the
 * Agent tool's own `renderCall`/`renderResult`, which draw the child's report and
 * error straight into the parent transcript. pi-tui preserves ANSI by design, so
 * whatever survives these renderers is executed by the parent's terminal.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { type AgentDetails, getDisplayName } from "../src/ui/agent-display.js";
import { FleetList, type FleetUICtx } from "../src/ui/fleet-list.js";

/** Screen erase + cursor home + an OSC title hijack, exactly as a child would emit it. */
const POISON = "\x1b[2J\x1b[1;1HPWNED\x1b]0;hijacked\x07";
/** The 8-bit CSI introducer, which reaches the terminal without ever being an ESC. */
const C1_INTRODUCER = String.fromCharCode(0x9b);

/** Marks our own styling so a leftover escape in the output can only be the payload's. */
const markerTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `*${text}*`,
};

function expectInert(output: string): void {
  expect(output).not.toContain("\x1b");
  expect(output).not.toContain("\x07");
  expect(output).not.toContain(C1_INTRODUCER);
}

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

function ctxWith(cwd: string) {
  return {
    mode: "tui",
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
      onTerminalInput: vi.fn(() => vi.fn()),
      getEditorText: vi.fn(() => ""),
      custom: vi.fn(),
    },
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    getSystemPrompt: () => "parent",
  } as any;
}

function mockRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "safe description",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...overrides,
  } as AgentRecord;
}

/** Render the live roster the way the TUI does, through the real FleetList. */
function renderFleet(records: AgentRecord[]): string {
  const fleet = new FleetList({ listAgentsMutable: () => records, abort: () => true } as any, new Map());
  let factory: any;
  fleet.setUICtx({
    setWidget: (_key: string, content: unknown) => { if (content) factory = content; },
    onTerminalInput: () => () => {},
    getEditorText: () => "",
    notify: () => {},
    custom: async () => undefined,
  } as unknown as FleetUICtx);
  fleet.update();
  if (!factory) return "";
  return factory({ terminal: { rows: 30, columns: 200 }, requestRender: () => {} }, markerTheme).render(200).join("\n");
}

function details(overrides: Partial<AgentDetails> = {}): AgentDetails {
  return {
    displayName: "Agent",
    description: "a run",
    subagentType: "general-purpose",
    toolUses: 0,
    tokens: "",
    durationMs: 1_000,
    status: "completed",
    ...overrides,
  };
}

describe("untrusted text through the real extension", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  let tools: Map<string, any>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-poison-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-poison-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    mkdirSync(join(tmpDir, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "agents", "poisoned.md"),
      `---\ndescription: ${JSON.stringify(`desc${POISON}`)}\ndisplay_name: ${JSON.stringify(POISON)}\n---\nBody.\n`,
    );

    const harness = makePi();
    tools = harness.tools;
    subagentsExtension(harness.pi);
    const ctx = ctxWith(tmpDir);
    await harness.lifecycle.get("session_start")?.({}, ctx);
    shutdown = () => harness.lifecycle.get("session_shutdown")?.({}, ctx);
  });

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    registerAgents(new Map());
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("neutralizes a poisoned display_name before it can label anything", () => {
    const name = getDisplayName("poisoned");

    expectInert(name);
    expect(name).toContain("PWNED");
  });

  it("keeps the poisoned name inert in the Agent tool's call header and the roster row", () => {
    const call = tools.get("Agent")
      .renderCall({ subagent_type: "poisoned", description: `run${POISON}` }, markerTheme)
      .render(200).join("\n");
    const roster = renderFleet([
      mockRecord({ type: "poisoned" as never, session: { subscribe: () => () => {}, messages: [] } as never }),
    ]);

    expectInert(call);
    expectInert(roster);
    expect(call).toContain("PWNED");
    expect(roster).toContain("PWNED");
  });

  it("neutralizes the child's own result text in the expanded transcript row", () => {
    const rendered = tools.get("Agent").renderResult(
      { content: [{ type: "text", text: `${POISON}the report` }], details: details() },
      { expanded: true, isPartial: false },
      markerTheme,
      undefined,
    ).render(200).join("\n");

    expectInert(rendered);
    expect(rendered).toContain("the report");
  });

  it("neutralizes a child-derived error message", () => {
    const rendered = tools.get("Agent").renderResult(
      { content: [{ type: "text", text: "" }], details: details({ status: "error", error: `${POISON}boom` }) },
      { expanded: false, isPartial: false },
      markerTheme,
      undefined,
    ).render(200).join("\n");

    expectInert(rendered);
    expect(rendered).toContain("boom");
  });

  it("neutralizes the pre-execution error path, which has no agent status", () => {
    const rendered = tools.get("Agent").renderResult(
      { content: [{ type: "text", text: `${POISON}tool failed` }], details: undefined },
      { expanded: false, isPartial: false },
      markerTheme,
      { isError: true },
    ).render(200).join("\n");

    expectInert(rendered);
    expect(rendered).toContain("tool failed");
  });
});
