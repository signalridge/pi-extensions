import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentConfig, registerAgents } from "../src/agent-types.js";
import { CHILD_CONTEXT_RPC } from "../src/cross-extension-rpc.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const events = {
    emit: vi.fn((event: string, data: unknown) => {
      for (const handler of listeners.get(event) ?? []) handler(data);
    }),
    on: vi.fn((event: string, handler: (data: unknown) => void) => {
      const handlers = listeners.get(event) ?? new Set<(data: unknown) => void>();
      handlers.add(handler);
      listeners.set(event, handlers);
      return () => handlers.delete(handler);
    }),
  };
  return {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events,
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    tools,
    commands,
    lifecycle,
  } as any;
}

function sessionCtx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => undefined), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const BROKEN = "---\ndescription: Use this: that\n---\n\nBroken.\n";

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

function writeSettings(settings: Record<string, unknown>): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify(settings));
}

function writeBrokenAgent(): string {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "broken.md");
  writeFileSync(path, BROKEN);
  return path;
}

describe("strictAgentFiles activation wiring", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "strict-agent-files-"));
    process.chdir(cwd);
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    originalHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
    process.env.HOME = cwd;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
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

  it("fails startup with the path when strict mode is enabled", async () => {
    const path = writeBrokenAgent();
    writeSettings({ strictAgentFiles: true });

    const pi = makePi();
    subagentsExtension(pi);
    await expect(pi.lifecycle.get("session_start")?.({}, sessionCtx())).rejects.toThrow(path);
  });

  it("validates the session cwd rather than process.cwd", async () => {
    const sessionCwd = mkdtempSync(join(tmpdir(), "strict-agent-session-cwd-"));
    try {
      const agentsDir = join(sessionCwd, ".pi", "agents");
      mkdirSync(agentsDir, { recursive: true });
      const path = join(agentsDir, "broken.md");
      writeFileSync(path, BROKEN);
      writeFileSync(join(sessionCwd, ".pi", "subagents.json"), JSON.stringify({ strictAgentFiles: true }));

      const pi = makePi();
      subagentsExtension(pi);
      const activation = sessionCtx();
      activation.cwd = sessionCwd;
      await expect(pi.lifecycle.get("session_start")?.({}, activation)).rejects.toThrow(path);
    } finally {
      rmSync(sessionCwd, { recursive: true, force: true });
    }
  });

  it("does not leave the child-context responder after strict validation fails", async () => {
    const path = writeBrokenAgent();
    writeSettings({ strictAgentFiles: true });
    const pi = makePi();
    subagentsExtension(pi);
    await expect(pi.lifecycle.get("session_start")?.({}, sessionCtx())).rejects.toThrow(path);
    expect(getAgentConfig("broken")).toBeUndefined();
    expect(pi.events.on).toHaveBeenCalledWith(CHILD_CONTEXT_RPC, expect.any(Function));

    pi.events.emit(CHILD_CONTEXT_RPC, { requestId: "strict-failure" });
    expect(pi.events.emit.mock.calls.some(([event]: [string]) => event === `${CHILD_CONTEXT_RPC}:reply:strict-failure`)).toBe(false);
  });

  it("skips malformed files with a warning by default", async () => {
    writeBrokenAgent();

    const pi = makePi();
    subagentsExtension(pi);
    await pi.lifecycle.get("session_start")?.({}, sessionCtx());
    expect(String(warn.mock.calls[0]?.[0])).toContain("Skipping agent file");
  });

  it("uses strict mode only for startup, not later reloads", async () => {
    const path = writeBrokenAgent();
    writeSettings({ strictAgentFiles: true });
    writeFileSync(path, "---\ndescription: Fixed\n---\n\nFixed.\n");

    const pi = makePi();
    subagentsExtension(pi);
    await pi.lifecycle.get("session_start")?.({}, sessionCtx());
    writeFileSync(path, BROKEN);

    const agentTool = [...pi.tools.values()].find((tool: any) => tool.name === "Agent");
    expect(agentTool).toBeDefined();
    const result = await agentTool.execute(
      "call-1",
      { subagent_type: "nope", prompt: "x" },
      undefined,
      vi.fn(),
      {
        hasUI: false,
        ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
        cwd,
        model: undefined,
        modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
        sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
        getSystemPrompt: vi.fn(() => "parent"),
      },
    );
    expect(JSON.stringify(result)).not.toContain("Nested mappings");
  });

  it("routes /agents disable to the active lower-priority source after a higher file is skipped", async () => {
    const malformedProject = join(cwd, ".pi", "agents", "fallback.md");
    const activeWorkspace = join(cwd, ".agents", "agents", "fallback.md");
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    mkdirSync(join(cwd, ".agents", "agents"), { recursive: true });
    writeFileSync(malformedProject, BROKEN);
    writeFileSync(activeWorkspace, "---\ndescription: Workspace fallback\n---\n\nWorkspace body.\n");

    const pi = makePi();
    subagentsExtension(pi);
    await pi.lifecycle.get("session_start")?.({}, sessionCtx());
    const command = pi.commands.get("agents");
    expect(command).toBeDefined();

    let agentMenuShown = 0;
    const ui = {
      select: vi.fn(async (title: string) => {
        if (title === "Agents") return agentMenuShown++ === 0 ? "Agent types (4)" : undefined;
        if (title === "fallback") return "Disable";
        return undefined;
      }),
      custom: vi.fn()
        .mockResolvedValueOnce("fallback")
        .mockResolvedValueOnce(undefined),
      confirm: vi.fn(async () => true),
      editor: vi.fn(),
      input: vi.fn(),
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };

    await command.handler("", {
      ui,
      cwd,
      model: undefined,
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
      sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
      getSystemPrompt: vi.fn(() => "parent"),
    });

    expect(readFileSync(malformedProject, "utf-8")).toBe(BROKEN);
    expect(readFileSync(activeWorkspace, "utf-8")).toContain("enabled: false");
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining(activeWorkspace), "info");
  });

  it("ejects a default and then resets the active exported file", async () => {
    const pi = makePi();
    subagentsExtension(pi);
    await pi.lifecycle.get("session_start")?.({}, sessionCtx());
    const command = pi.commands.get("agents");
    expect(command).toBeDefined();
    const projectPath = join(cwd, ".pi", "agents", "general-purpose.md");

    const runMenu = async (action: string, location?: string) => {
      let agentMenuShown = 0;
      const ui = {
        select: vi.fn(async (title: string) => {
          if (title === "Agents") return agentMenuShown++ === 0 ? "Agent types (3)" : undefined;
          if (title === "general-purpose") return action;
          if (title === "Choose location") return location;
          return undefined;
        }),
        custom: vi.fn()
          .mockResolvedValueOnce("general-purpose")
          .mockResolvedValueOnce(undefined),
        confirm: vi.fn(async () => true),
        editor: vi.fn(),
        input: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn(),
      };
      await command.handler("", {
        ui,
        cwd,
        model: undefined,
        modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
        sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
        getSystemPrompt: vi.fn(() => "parent"),
      });
      return ui;
    };

    await runMenu("Eject (export as .md)", "Project (.pi/agents/)");
    expect(readFileSync(projectPath, "utf-8")).toContain("description:");

    const ui = await runMenu("Reset to default");
    expect(existsSync(projectPath)).toBe(false);
    expect(ui.notify).toHaveBeenCalledWith("Restored default general-purpose", "info");
  });
});
