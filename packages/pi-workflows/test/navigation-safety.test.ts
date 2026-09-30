import { PROTOCOL_CAPABILITIES, PROTOCOL_VERSION, routingPolicyFingerprint } from "@signalridge/pi-subagents-protocol";
import { describe, expect, it, vi } from "vitest";
import piWorkflows from "../src/index.js";

class Bus {
  private handlers = new Map<string, Set<(value: unknown) => void>>();
  on(name: string, handler: (value: unknown) => void): () => void {
    const listeners = this.handlers.get(name) ?? new Set();
    listeners.add(handler);
    this.handlers.set(name, listeners);
    return () => listeners.delete(handler);
  }
  emit(name: string, value: unknown): void {
    for (const handler of this.handlers.get(name) ?? []) handler(value);
  }
}

function fixture(subagentsFirst: boolean, hangQuiesce = false) {
  const bus = new Bus();
  const handlers = new Map<string, (event: { type: string; signal?: AbortSignal }, ctx: unknown) => unknown>();
  const tools = new Map<
    string,
    { execute: (...args: unknown[]) => Promise<{ details: { runId: string; status: string } }> }
  >();
  const entries: Array<{ id: string; parentId: string | null; type: string; customType: string; data: unknown }> = [];
  let leaf: string | null = null;
  let subagentsBusy = false;
  const notices: string[] = [];
  const requests: Array<{ name: string; id?: string; reply?: () => void }> = [];
  const policy = {
    defaultTier: "default",
    profiles: { default: { model: "inherit" as const, thinking: "medium" as const } },
    blockedProfiles: [],
    blockedDefaultTier: false,
  };
  const subagentsPreflight = (raw: unknown) => {
    if (subagentsBusy) (raw as { report: (name: string) => void }).report("subagents");
  };
  if (subagentsFirst) bus.on("pi:navigation-preflight", subagentsPreflight);
  bus.on("subagents:rpc:context", (raw) => {
    const { requestId } = raw as { requestId: string };
    bus.emit(`subagents:rpc:context:reply:${requestId}`, {
      success: true,
      data: { child: false, capability: "childContext" },
    });
  });
  bus.on("subagents:rpc:ping", (raw) => {
    const { requestId } = raw as { requestId: string };
    bus.emit(`subagents:rpc:ping:reply:${requestId}`, {
      success: true,
      data: {
        version: PROTOCOL_VERSION,
        capabilities: PROTOCOL_CAPABILITIES,
        routingPolicy: { policy, fingerprint: routingPolicyFingerprint(policy) },
      },
    });
  });
  bus.on("subagents:rpc:spawn-managed", (raw) => {
    const { requestId } = raw as { requestId: string };
    requests.push({ name: "spawn" });
    bus.emit(`subagents:rpc:spawn-managed:reply:${requestId}`, {
      success: true,
      data: { id: "managed-child", state: "running" },
    });
  });
  bus.on("subagents:rpc:stop-owned", (raw) => {
    const { requestId } = raw as { requestId: string };
    requests.push({ name: "stop" });
    bus.emit(`subagents:rpc:stop-owned:reply:${requestId}`, { success: true });
  });
  bus.on("subagents:rpc:quiesce-owned", (raw) => {
    const { requestId } = raw as { requestId: string };
    requests.push({ name: "quiesce" });
    if (!hangQuiesce) {
      bus.emit(`subagents:rpc:quiesce-owned:reply:${requestId}`, {
        success: true,
        data: { settled: true, pending: [] },
      });
    }
  });
  const pi = {
    events: bus,
    on: (name: string, handler: (event: { type: string; signal?: AbortSignal }, ctx: unknown) => unknown) =>
      handlers.set(name, handler),
    appendEntry: (customType: string, data: unknown) => {
      const id = `entry-${entries.length + 1}`;
      entries.push({ id, parentId: leaf, type: "custom", customType, data });
      leaf = id;
    },
    sendMessage: vi.fn(),
    registerTool: (tool: {
      name: string;
      execute: (...args: unknown[]) => Promise<{ details: { runId: string; status: string } }>;
    }) => tools.set(tool.name, tool),
    registerCommand: vi.fn(),
    getCommands: () => [],
  };
  piWorkflows(pi as never);
  if (!subagentsFirst) bus.on("pi:navigation-preflight", subagentsPreflight);
  const sessionManager = {
    getLeafId: () => leaf,
    getBranch: () => {
      const branch: typeof entries = [];
      let id = leaf;
      while (id) {
        const entry = entries.find((candidate) => candidate.id === id);
        if (!entry) break;
        branch.unshift(entry);
        id = entry.parentId;
      }
      return branch;
    },
  };
  const ctx = {
    cwd: process.cwd(),
    mode: "rpc",
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message), setWidget: vi.fn() },
    sessionManager,
  };
  return {
    bus,
    handlers,
    tools,
    entries,
    requests,
    notices,
    ctx,
    set subagentsBusy(value: boolean) {
      subagentsBusy = value;
    },
    setLeaf: (id: string | null) => {
      leaf = id;
    },
    start: async () => handlers.get("session_start")?.({ type: "session_start" }, ctx),
    shutdown: async () => {
      await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    },
    run: async () => {
      const result = await tools.get("workflow")?.execute(
        "navigation-run",
        {
          script: 'export const meta = { name: "navigation", description: "test" }; return await agent("work");',
          background: true,
        },
        undefined,
        undefined,
        ctx,
      );
      await vi.waitFor(() => expect(requests.some((request) => request.name === "spawn")).toBe(true));
      await new Promise((resolve) => setImmediate(resolve));
      return result?.details.runId;
    },
  };
}

describe("workflow navigation preflight", () => {
  for (const subagentsFirst of [true, false]) {
    it(`vetoes an active workflow and managed child without aborting (${subagentsFirst ? "subagents" : "workflows"} bus first)`, async () => {
      const f = fixture(subagentsFirst);
      await f.start();
      const runId = await f.run();
      f.subagentsBusy = true;
      for (const kind of ["session_before_switch", "session_before_tree"]) {
        const response = await f.handlers.get(kind)?.({ type: kind, signal: new AbortController().signal }, f.ctx);
        expect(response).toMatchObject({ cancel: true });
        expect(f.requests.filter((request) => request.name === "stop" || request.name === "quiesce")).toEqual([]);
      }
      expect(f.notices.join(" ")).toMatch(/wait.*stop/i);
      expect(
        f.entries.some(
          (entry) =>
            (entry.data as { kind?: string }).kind === "workflow_transition" &&
            (entry.data as { status?: string }).status === "interrupted",
        ),
      ).toBe(false);
      expect(runId).toBeTruthy();
      await f.shutdown();
    });
  }

  it("logs actionable headless preflight guidance without interrupting a workflow", async () => {
    const f = fixture(false);
    await f.start();
    await f.run();
    f.ctx.hasUI = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await f.handlers.get("session_before_tree")?.({ type: "session_before_tree" }, f.ctx)).toMatchObject({
        cancel: true,
      });
      expect(warn.mock.calls.map(([message]) => String(message)).join(" ")).toMatch(/wait.*stop/i);
      expect(f.requests.filter((request) => request.name === "stop" || request.name === "quiesce")).toEqual([]);
    } finally {
      warn.mockRestore();
      await f.shutdown();
    }
  });

  it.each(["later hook veto", "summary aborted", "summary error"])("keeps a new run live after %s", async () => {
    const f = fixture(false);
    await f.start();
    expect(
      await f.handlers.get("session_before_tree")?.(
        { type: "session_before_tree", signal: new AbortController().signal },
        f.ctx,
      ),
    ).toBeUndefined();
    // Work starts after preflight; neither a later veto nor a failed/aborted
    // summarizer emits session_tree, so no destructive action is permitted.
    await f.run();
    expect(f.requests.filter((request) => request.name === "stop" || request.name === "quiesce")).toEqual([]);
    await f.shutdown();
  });

  it("times out failed shutdown quiescence and fences late callbacks", async () => {
    const f = fixture(false, true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await f.start();
    await f.run();
    vi.useFakeTimers();
    try {
      const shutting = f.shutdown();
      await vi.advanceTimersByTimeAsync(6_001);
      await shutting;
      expect(f.requests.some((request) => request.name === "quiesce")).toBe(true);
      expect(warn.mock.calls.map(([message]) => String(message)).join(" ")).toMatch(
        /shutdown quiescence timed out or failed.*late callbacks fenced/,
      );
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it.each(["subagents first", "workflows first"])(
    "fences late old-branch facts on accepted navigation (%s)",
    async (order) => {
      const f = fixture(false);
      await f.start();
      const oldRunId = await f.run();
      const oldEntries = f.ctx.sessionManager.getBranch();
      expect(oldEntries.some((entry) => (entry.data as { runId?: string }).runId === oldRunId)).toBe(true);
      // Pi moves the leaf before notifying the extensions. Both load orders must
      // fence old callbacks without replaying terminal facts onto the new branch.
      f.setLeaf(null);
      const committed = { type: "session_tree" };
      const workflowTree = () => f.handlers.get("session_tree")?.(committed, f.ctx);
      const subagentsTree = () => f.bus.emit("subagents:session_tree_committed", { event: committed });
      if (order === "subagents first") {
        subagentsTree();
        await workflowTree();
      } else {
        await workflowTree();
        subagentsTree();
      }
      await new Promise((resolve) => setImmediate(resolve));
      expect(f.ctx.sessionManager.getBranch()).toEqual([]);
      expect(f.entries.some((entry) => (entry.data as { runId?: string }).runId === oldRunId)).toBe(true);
      const fresh = await f.tools
        .get("workflow")
        ?.execute(
          "fresh",
          { script: 'export const meta = { name: "fresh", description: "test" }; return 1;', background: false },
          undefined,
          undefined,
          f.ctx,
        );
      expect(fresh?.details.status).toBe("completed");
      expect(
        f.ctx.sessionManager.getBranch().some((entry) => (entry.data as { runId?: string }).runId === oldRunId),
      ).toBe(false);
      await f.shutdown();
    },
  );
});
