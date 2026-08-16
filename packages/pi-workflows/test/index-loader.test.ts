import { describe, expect, it } from "vitest";
import piWorkflows from "../src/index.js";

const PROTOCOL_VERSION = 3;
const PROTOCOL_CAPABILITIES = {
  managedSpawn: true,
  lifecycleOwner: true,
  ownedStop: true,
  childContext: true,
  ownedQuiescence: true,
  workflowTiers: true,
};

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

function createPi(child: boolean, appendFailures = 0, branch: unknown[] = []) {
  const bus = new Bus();
  const lifecycle = new Map<string, (...args: never[]) => unknown>();
  const tools: string[] = [];
  const commands: string[] = [];
  const entries: unknown[] = [...branch];
  bus.on("subagents:rpc:context", (raw) => {
    const request = raw as { requestId: string };
    bus.emit(`subagents:rpc:context:reply:${request.requestId}`, {
      success: true,
      data: { child, capability: "childContext" },
    });
  });
  bus.on("subagents:rpc:ping", (raw) => {
    const request = raw as { requestId: string };
    bus.emit(`subagents:rpc:ping:reply:${request.requestId}`, {
      success: true,
      data: { version: PROTOCOL_VERSION, capabilities: PROTOCOL_CAPABILITIES },
    });
  });
  const pi = {
    events: bus,
    appendEntry: (_type: string, data: unknown) => {
      if (appendFailures > 0) {
        appendFailures -= 1;
        throw new Error("transient append failure");
      }
      entries.push(data);
    },
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerCommand: (name: string) => commands.push(name),
    on: (event: string, handler: (...args: never[]) => unknown) => {
      lifecycle.set(event, handler);
      return () => lifecycle.delete(event);
    },
  };
  const ctx = {
    hasUI: false,
    mode: "print" as const,
    sessionManager: { getBranch: () => entries },
  };
  return { bus, lifecycle, tools, commands, entries, pi, ctx };
}

describe("pi-workflows loader context isolation", () => {
  it("does not register tools, commands, ping, or journal state in a child session", async () => {
    const fixture = createPi(true);
    let pinged = false;
    fixture.bus.on("subagents:rpc:ping", () => {
      pinged = true;
    });
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    expect(fixture.tools).toEqual([]);
    expect(fixture.commands).toEqual([]);
    expect(pinged).toBe(false);
    expect(fixture.entries).toEqual([]);
  });

  it("retains the root workflow surface and protocol diagnostic path", async () => {
    const fixture = createPi(false);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fixture.tools).toEqual(["workflow", "workflow_control"]);
    expect(fixture.commands).toEqual(["workflows"]);
    await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
  });

  it("retries initial active-run recovery before exposing the workflow surface", async () => {
    const runId = "recovery-loader-run";
    const attemptId = `${runId}/a/attempt-1`;
    const definition = {
      name: "recovery",
      phases: [],
      tasks: [{ id: "a", subagent_type: "Explore", description: "A", prompt: "A", depends_on: [] }],
      background: true,
    };
    const branch = [
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: { kind: "run_created", schemaVersion: 2, runId, definition, timestamp: 1 },
      },
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: { kind: "workflow_transition", schemaVersion: 2, runId, status: "running", timestamp: 2 },
      },
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: {
          kind: "task_transition",
          schemaVersion: 2,
          runId,
          nodeId: "a",
          status: "running",
          agentId: "old-agent",
          attemptId,
          owner: { extension: "pi-workflows", runId, nodeId: "a", attemptId },
          timestamp: 3,
        },
      },
    ];
    const fixture = createPi(false, 1, branch);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    expect(fixture.tools).toEqual(["workflow", "workflow_control"]);
    expect(fixture.entries.some((entry) => (entry as { kind?: string }).kind === "run_recovery")).toBe(true);
    await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
  });
});
