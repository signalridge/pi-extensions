import { describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import subagentsExtension, { summarizeAgentRuns } from "../src/index.js";
import type { AgentDetails } from "../src/ui/agent-display.js";
import { getAgentStatusColor, getAgentStatusLabel } from "../src/ui/status-label.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

type TestPi = {
  pi: any;
  tools: Map<string, any>;
  renderers: Map<string, any>;
  lifecycle: Map<string, any>;
};

function makePi(): TestPi {
  const tools = new Map<string, any>();
  const renderers = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn((name: string, renderer: unknown) => renderers.set(name, renderer)),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: unknown) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, renderers, lifecycle };
}

function sessionCtx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => undefined), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

function renderText(component: { render(width: number): string[] }): string {
  return component.render(120).join("\n");
}

function baseDetails(status: AgentDetails["status"]): AgentDetails {
  return {
    displayName: "Explore",
    description: "inspect files",
    subagentType: "Explore",
    toolUses: 2,
    tokens: "",
    durationMs: 100,
    status,
    agentId: "agent-1",
  };
}

describe("agent status labels", () => {
  it("keeps steered, completed, stopped, aborted, error, queued, and running distinct", () => {
    expect(getAgentStatusLabel("steered")).toBe("wrapped up · turn limit");
    expect(getAgentStatusLabel("completed")).toBe("completed");
    expect(getAgentStatusLabel("stopped")).toBe("stopped");
    expect(getAgentStatusLabel("aborted")).toBe("aborted");
    expect(getAgentStatusLabel("error")).toBe("failed");
    expect(getAgentStatusLabel("queued")).toBe("queued");
    expect(getAgentStatusLabel("running")).toBe("running");
    expect(getAgentStatusColor("steered")).toBe("warning");
    expect(getAgentStatusColor("completed")).toBe("dim");
  });

  it("summarizes every retained run bucket and never calls wrapped up completed", () => {
    const summary = summarizeAgentRuns([
      { status: "running" },
      { status: "queued" },
      { status: "completed" },
      { status: "steered" },
      { status: "stopped" },
      { status: "aborted" },
      { status: "error" },
    ]);
    expect(summary).toBe(
      "Agent runs (7) · 1 running · 1 queued · 1 completed · 1 wrapped up · 1 stopped · 1 aborted · 1 failed",
    );
    expect(summary).not.toContain("Running agents");
    expect(summary).not.toContain("done");
  });
});

describe("Agent tool and notification renderers", () => {
  it("reports queued background results as queued, never running", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")?.({}, sessionCtx());
    const agentTool = tools.get("Agent");
    const queued = {
      content: [{ type: "text", text: "Agent queued" }],
      details: baseDetails("queued"),
    };
    const output = renderText(agentTool.renderResult(queued, { expanded: false, isPartial: true }, theme));
    expect(output).toContain("queued · background");
    expect(output).not.toContain("running");
    await lifecycle.get("session_shutdown")?.({}, { sessionManager: { getBranch: () => [] } });
  });

  it("labels steered tool results and notifications as wrapped up with warning styling", async () => {
    const { pi, tools, renderers, lifecycle } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")?.({}, sessionCtx());
    const details = baseDetails("steered");
    const toolOutput = renderText(
      tools.get("Agent").renderResult(
        { content: [{ type: "text", text: "partial output" }], details },
        { expanded: false, isPartial: false },
        theme,
      ),
    );
    expect(toolOutput).toContain("wrapped up · turn limit");
    expect(toolOutput).not.toContain("completed · turn limit");

    const renderer = renderers.get("subagent-notification");
    const notificationOutput = renderText(renderer(
      {
        details: {
          id: "agent-1",
          description: "inspect files",
          status: "steered",
          toolUses: 2,
          turnCount: 2,
          totalTokens: 0,
          durationMs: 100,
          resultPreview: "partial output",
        },
      },
      { expanded: false },
      theme,
    ));
    expect(notificationOutput).toContain("wrapped up · turn limit");
    expect(notificationOutput).not.toContain("completed · turn limit");
    await lifecycle.get("session_shutdown")?.({}, { sessionManager: { getBranch: () => [] } });
  });

  it("clears the foreground spinner when startup throws before an agent id exists", async () => {
    vi.useFakeTimers();
    const startup = vi.spyOn(AgentManager.prototype, "spawnAndWait").mockRejectedValue(new Error("startup failed"));
    const { pi, tools, lifecycle } = makePi();
    try {
      subagentsExtension(pi);
      await lifecycle.get("session_start")?.({}, sessionCtx());
      const before = vi.getTimerCount();
      const context = {
        hasUI: true,
        ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
        cwd: "/tmp",
        model: undefined,
        modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
        sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
        getSystemPrompt: vi.fn(() => "parent"),
      };

      await expect(tools.get("Agent").execute(
        "startup-call",
        { subagent_type: "general-purpose", prompt: "go", description: "startup" },
        undefined,
        vi.fn(),
        context,
      )).rejects.toThrow("startup failed");
      expect(startup).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      await lifecycle.get("session_shutdown")?.({}, { sessionManager: { getBranch: () => [] } });
      startup.mockRestore();
      vi.useRealTimers();
    }
  });

  it("propagates background startup errors as failed tool calls", async () => {
    const startup = vi.spyOn(AgentManager.prototype, "spawn").mockImplementation(() => {
      throw new Error("background startup failed");
    });
    const { pi, tools, lifecycle } = makePi();
    try {
      subagentsExtension(pi);
      await lifecycle.get("session_start")?.({}, sessionCtx());
      await expect(tools.get("Agent").execute(
        "background-startup-call",
        { subagent_type: "general-purpose", prompt: "go", description: "background", run_in_background: true },
        undefined,
        vi.fn(),
        {
          hasUI: true,
          ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
          cwd: "/tmp",
          model: undefined,
          modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
          sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
          getSystemPrompt: vi.fn(() => "parent"),
        },
      )).rejects.toThrow("background startup failed");
      expect(startup).toHaveBeenCalledOnce();
    } finally {
      await lifecycle.get("session_shutdown")?.({}, { sessionManager: { getBranch: () => [] } });
      startup.mockRestore();
    }
  });

  it("preserves pre-execution error text when Pi marks a tool result as an error", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")?.({}, sessionCtx());
    const output = renderText(
      tools.get("Agent").renderResult(
        { content: [{ type: "text", text: "extension denied" }], details: {} },
        { expanded: false, isPartial: false },
        theme,
        { isError: true },
      ),
    );
    expect(output.trimEnd()).toBe("extension denied");
    await lifecycle.get("session_shutdown")?.({}, { sessionManager: { getBranch: () => [] } });
  });
});
