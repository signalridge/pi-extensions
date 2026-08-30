/** The managed RPC must reload and resolve custom agent policy exactly like Agent. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { NO_FALLBACK, registerAgents, setFallbackSubagent } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";

class Bus {
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();

  on(event: string, handler: (data: unknown) => void): () => void {
    const handlers = this.listeners.get(event) ?? new Set<(data: unknown) => void>();
    handlers.add(handler);
    this.listeners.set(event, handlers);
    return () => handlers.delete(handler);
  }

  emit(event: string, data: unknown): void {
    for (const handler of this.listeners.get(event) ?? []) handler(data);
  }
}

function context(cwd: string) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getEntries: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as never;
}

describe("managed spawn fallback and reload wiring", () => {
  let cwd = "";
  let globalDir = "";
  let originalCwd = "";
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    cwd = mkdtempSync(join(tmpdir(), "managed-fallback-"));
    globalDir = mkdtempSync(join(tmpdir(), "managed-fallback-global-"));
    process.env.PI_CODING_AGENT_DIR = globalDir;
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "retired.md"),
      "---\ndescription: Retired\ntools: read\nenabled: false\n---\nRetired.\n",
    );
    process.chdir(cwd);
    vi.mocked(runAgent).mockReset();
    setFallbackSubagent(undefined);
  });

  afterEach(() => {
    setFallbackSubagent(undefined);
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
    registerAgents(new Map());
    process.chdir(originalCwd);
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("reloads disabled custom agents and applies fail-closed/fallback policy", async () => {
    const bus = new Bus();
    const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
    const lifecycle = new Map<string, (event: unknown, ctx: never) => Promise<void> | void>();
    const pi = {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: { name: string; execute: (...args: never[]) => Promise<unknown> }) => tools.set(tool.name, tool)),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: (event: unknown, ctx: never) => Promise<void> | void) => lifecycle.set(event, handler)),
      events: bus,
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as never;
    subagentsExtension(pi);
    const ctx = context(cwd);
    await lifecycle.get("session_start")?.({}, ctx);

    const reply = (requestId: string): Promise<unknown> => new Promise((resolve) => {
      bus.on(`subagents:rpc:spawn-managed:reply:${requestId}`, resolve);
    });

    setFallbackSubagent(NO_FALLBACK);
    const disabledReply = reply("managed-disabled");
    bus.emit("subagents:rpc:spawn-managed", {
      requestId: "managed-disabled",
      spawnKey: "managed-disabled",
      type: "retired",
      prompt: "do it",
      description: "disabled",
      owner: { extension: "pi-workflows", runId: "run-1", nodeId: "a", attemptId: "run-1/a/attempt-1" },
    });
    await expect(disabledReply).resolves.toEqual(expect.objectContaining({ success: false, error: expect.stringContaining("Unknown or disabled") }));
    expect(runAgent).not.toHaveBeenCalled();

    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}) as never);
    setFallbackSubagent("general-purpose");
    const fallbackReply = reply("managed-fallback");
    bus.emit("subagents:rpc:spawn-managed", {
      requestId: "managed-fallback",
      spawnKey: "managed-fallback",
      type: "missing-type",
      prompt: "do it",
      description: "fallback",
      owner: { extension: "pi-workflows", runId: "run-2", nodeId: "a", attemptId: "run-2/a/attempt-1" },
    });
    await expect(fallbackReply).resolves.toEqual(expect.objectContaining({ success: true }));
    const managedCall = vi.mocked(runAgent).mock.calls.at(-1);
    if (!managedCall) throw new Error("managed fallback did not reach runAgent");
    expect(managedCall[1]).toBe("general-purpose");
    expect(managedCall[3]).toHaveProperty("model", undefined);
    expect(managedCall[3]).toHaveProperty("maxTurns", undefined);
    expect(managedCall[3]).toEqual(expect.objectContaining({
      isolated: false,
      inheritContext: false,
    }));
    expect(managedCall[3]).toHaveProperty("thinkingLevel");
    await lifecycle.get("session_shutdown")?.({}, ctx);
  });
});
