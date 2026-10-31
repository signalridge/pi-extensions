import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { PROTOCOL_CAPABILITIES, PROTOCOL_VERSION, routingPolicyFingerprint } from "@signalridge/pi-subagents-protocol";
import { describe, expect, it, vi } from "vitest";
import piWorkflows from "../src/index.js";

class Bus {
  private handlers = new Map<string, Array<(value: unknown) => void>>();
  on(name: string, handler: (value: unknown) => void): () => void {
    const listeners = this.handlers.get(name) ?? [];
    listeners.push(handler);
    this.handlers.set(name, listeners);
    return () =>
      this.handlers.set(
        name,
        listeners.filter((listener) => listener !== handler),
      );
  }
  emit(name: string, value: unknown): void {
    for (const handler of this.handlers.get(name) ?? []) handler(value);
  }
}

function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function fixture(
  beforeRegister?: (on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => void) => void,
) {
  const bus = new Bus();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const on = (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
    const list = handlers.get(name) ?? [];
    list.push(handler);
    handlers.set(name, list);
  };
  beforeRegister?.(on);
  const policy = {
    defaultTier: "default",
    profiles: { default: { model: "inherit" as const, thinking: "medium" as const } },
    blockedProfiles: [],
    blockedDefaultTier: false,
  };
  bus.on("subagents:rpc:context", (raw) => {
    const { requestId } = raw as { requestId: string };
    bus.emit(`subagents:rpc:context:reply:${requestId}`, { success: true, data: { child: false } });
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
  for (const name of ["stop-owned", "quiesce-owned"]) {
    bus.on(`subagents:rpc:${name}`, (raw) => {
      const { requestId } = raw as { requestId: string };
      bus.emit(`subagents:rpc:${name}:reply:${requestId}`, { success: true, data: { settled: true, pending: [] } });
    });
  }
  type Entry = {
    id: string;
    parentId: string | null;
    type: string;
    customType: string;
    data?: unknown;
    content?: string;
  };
  const entries: Entry[] = [];
  let leaf: string | null = null;
  let idle = true;
  let queued = false;
  let persistMessages = true;
  const append = (entry: Omit<Entry, "id" | "parentId">) => {
    leaf = `entry-${entries.push({ ...entry, id: `entry-${entries.length + 1}`, parentId: leaf })}`;
  };
  const branch = () => {
    const result: Entry[] = [];
    let id = leaf;
    while (id) {
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry) break;
      result.unshift(entry);
      id = entry.parentId;
    }
    return result;
  };
  const ctx = {
    cwd: process.cwd(),
    mode: "rpc",
    hasUI: false,
    ui: { notify: vi.fn(), setWidget: vi.fn() },
    isIdle: () => idle,
    hasPendingMessages: () => queued,
    sessionManager: { getBranch: branch, getLeafId: () => leaf, getSessionId: () => "delivery-session" },
  };
  const emit = async (name: string, event: unknown = { type: name }) => {
    let input = name === "input" ? (event as { text: string; source: string }) : undefined;
    for (const handler of handlers.get(name) ?? []) {
      const result = (await handler(input ?? event, ctx)) as { action?: string; text?: string } | undefined;
      // Match Pi's sequential input pipeline: transforms chain, handled stops
      // dispatch and prevents before_agent_start / model admission entirely.
      if (input && result?.action === "handled") return { action: "handled" as const };
      if (input && result?.action === "transform" && result.text !== undefined) input = { ...input, text: result.text };
    }
    return input ? { action: "continue" as const, text: input.text } : undefined;
  };
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ details: { runId: string } }> }>();
  const wakes: Promise<void>[] = [];
  const pi = {
    events: bus,
    on,
    registerCommand: vi.fn(),
    getCommands: () => [],
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<{ details: { runId: string } }> }) =>
      tools.set(tool.name, tool),
    appendEntry: (customType: string, data: unknown) => append({ type: "custom", customType, data }),
    sendMessage: vi.fn((message: { customType: string; content: string }, options: { triggerTurn?: boolean }) => {
      if (options.triggerTurn) throw new Error("Custom messages must not wake the model");
      if (persistMessages) append({ type: "custom_message", ...message });
    }),
    sendUserMessage: vi.fn((text: string, _options?: { deliverAs?: string; expandPromptTemplates?: boolean }) => {
      wakes.push(
        (async () => {
          const input = await emit("input", { text, source: "extension" });
          if (input?.action === "handled") return;
          await emit("before_agent_start");
          idle = false;
          await emit("agent_start");
          idle = true;
          await emit("agent_settled");
        })(),
      );
    }),
  };
  piWorkflows(pi as never);
  const pending = () => entries.filter((entry) => entry.customType === "pi-workflows:pending-delivery");
  const acks = () => entries.filter((entry) => entry.customType === "pi-workflows:pending-delivery-ack");
  return {
    bus,
    pi,
    tools,
    ctx,
    on,
    emit,
    entries,
    pending,
    acks,
    setIdle: (value: boolean) => {
      idle = value;
    },
    setQueued: (value: boolean) => {
      queued = value;
    },
    setPersistence: (value: boolean) => {
      persistMessages = value;
    },
    navigate: () => {
      leaf = null;
    },
    start: () => emit("session_start"),
    shutdown: () => emit("session_shutdown"),
    drain: async () => {
      await Promise.all(wakes);
    },
    run: async (script = 'export const meta = { name: "delivery", description: "test" }; return "finished";') => {
      const count = pending().length;
      const result = await tools.get("workflow")?.execute(
        "delivery",
        {
          script,
          background: true,
        },
        undefined,
        undefined,
        ctx,
      );
      await vi.waitFor(() => expect(pending()).toHaveLength(count + 1));
      return result?.details.runId;
    },
    admit: () =>
      tools.get("workflow")?.execute(
        "retired",
        {
          script: 'export const meta = { name: "retired", description: "test" }; return 1;',
          background: true,
        },
        undefined,
        undefined,
        ctx,
      ),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("settled workflow result delivery", () => {
  it("explicit terminal-result consumption prevents a later duplicate wake and survives rebind", async () => {
    const f = fixture();
    await f.start();
    f.setIdle(false);
    const runId = await f.run();
    const read = await f.tools
      .get("workflow_control")
      ?.execute("read", { action: "get", runId, consume: true }, undefined, undefined, f.ctx);
    expect(read?.details).toMatchObject({ notificationConsumed: true });
    expect(f.acks()).toHaveLength(1);
    await f.tools
      .get("workflow_control")
      ?.execute("read-again", { action: "get", runId, consume: true }, undefined, undefined, f.ctx);
    expect(f.acks()).toHaveLength(1);
    f.setIdle(true);
    await f.emit("agent_settled");
    await tick();
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    await f.emit("session_tree");
    await tick();
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    await f.shutdown();
  });
  it.each([false, true])("consumes a stopped result across a slow terminal append (restore=%s)", async (restore) => {
    const f = fixture();
    await f.start();
    f.setIdle(false);
    let started = false;
    f.bus.on("subagents:rpc:spawn-managed", (raw) => {
      const { requestId } = raw as { requestId: string };
      started = true;
      f.bus.emit(`subagents:rpc:spawn-managed:reply:${requestId}`, {
        success: true,
        data: { id: "stopped-child", state: "running" },
      });
    });
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const append = f.pi.appendEntry;
    const appendSpy = vi.spyOn(f.pi, "appendEntry").mockImplementation((type, data) => {
      append(type, data);
      if (
        type === "pi-workflows:journal" &&
        typeof data === "object" &&
        data !== null &&
        (data as { kind?: string }).kind === "terminal_recovery"
      )
        now += 1;
    });
    try {
      const run = await f.tools.get("workflow")?.execute(
        "start",
        {
          script: 'export const meta={name:"stop",description:"test"};return await agent("wait");',
          background: true,
        },
        undefined,
        undefined,
        f.ctx,
      );
      const runId = run?.details.runId;
      await vi.waitFor(() => expect(started).toBe(true));
      await f.tools.get("workflow_control")?.execute("stop", { action: "stop", runId }, undefined, undefined, f.ctx);
      await vi.waitFor(() => expect(f.pending()).toHaveLength(1));
      expect((f.pending()[0].data as { completionId?: string }).completionId).toEqual(expect.any(String));
      if (restore) await f.emit("session_tree");
      const read = await f.tools
        .get("workflow_control")
        ?.execute("read", { action: "get", runId, consume: true }, undefined, undefined, f.ctx);
      expect(read?.details).toMatchObject({ notificationConsumed: true, run: { status: "stopped" } });
      expect(f.acks()).toHaveLength(1);
      await f.emit("session_tree");
      f.setIdle(true);
      await f.emit("agent_settled");
      await tick();
      expect(f.pi.sendMessage).not.toHaveBeenCalled();
      expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await f.shutdown();
      appendSpy.mockRestore();
      clock.mockRestore();
    }
  });
  it("a persisted read receipt cannot suppress a new execution after engine restore", async () => {
    const f = fixture();
    await f.start();
    f.setIdle(false);
    const runId = await f.run('export const meta={name:"first",description:"test"};throw new Error("first failed");');
    await f.tools
      .get("workflow_control")
      ?.execute("read", { action: "get", runId, consume: true }, undefined, undefined, f.ctx);
    expect(f.acks()).toHaveLength(1);
    const oldReceipt = f.acks()[0].data as Record<string, unknown>;
    await f.emit("session_tree");
    const before = f.pending().length;
    const resumed = await f.tools.get("workflow")?.execute(
      "resume",
      {
        script: 'export const meta={name:"second",description:"test"};return "new result";',
        resumeFromRunId: runId,
        background: true,
      },
      undefined,
      undefined,
      f.ctx,
    );
    expect(resumed?.details.runId, JSON.stringify(resumed)).toBe(runId);
    await vi.waitFor(() => expect(f.pending()).toHaveLength(before + 1));
    const current = f.pending().at(-1)?.data as Record<string, unknown>;
    expect(current.executionGeneration).toBe(oldReceipt.executionGeneration);
    expect(current.completionId).not.toBe(oldReceipt.completionId);
    // Even a delayed old receipt with the same runtime generation cannot
    // acknowledge this execution when the branch is replayed.
    f.pi.appendEntry("pi-workflows:pending-delivery-ack", oldReceipt);
    await f.emit("session_tree");
    f.setIdle(true);
    await f.emit("agent_settled");
    await vi.waitFor(() => expect(f.pi.sendUserMessage).toHaveBeenCalledOnce());
    expect(f.pi.sendMessage.mock.calls[0]?.[0]?.content).toContain("new result");
    await f.drain();
    await f.shutdown();
  });
  it("does not claim consumption without a branch-visible acknowledgement receipt", async () => {
    const f = fixture();
    await f.start();
    f.setIdle(false);
    const runId = await f.run();
    vi.spyOn(f.pi, "appendEntry").mockImplementationOnce(() => {});
    const read = await f.tools
      .get("workflow_control")
      ?.execute("read", { action: "get", runId, consume: true }, undefined, undefined, f.ctx);
    expect(read?.details).toMatchObject({ notificationConsumed: false });
    expect(f.acks()).toHaveLength(0);
    f.setIdle(true);
    await f.emit("agent_settled");
    await vi.waitFor(() => expect(f.pi.sendUserMessage).toHaveBeenCalledOnce());
    await f.drain();
    await f.shutdown();
  });
  it("ordinary terminal inspections do not silently consume unread completion", async () => {
    const f = fixture();
    await f.start();
    f.setIdle(false);
    const runId = await f.run();
    await f.tools.get("workflow_control")?.execute("inspect", { action: "get", runId }, undefined, undefined, f.ctx);
    expect(f.acks()).toHaveLength(0);
    f.setIdle(true);
    await f.emit("agent_settled");
    await vi.waitFor(() => expect(f.pi.sendUserMessage).toHaveBeenCalledOnce());
    await f.drain();
    await f.shutdown();
  });
  it("consuming a running inspection does not acknowledge its future result", async () => {
    const f = fixture();
    await f.start();
    f.setIdle(false);
    f.bus.on("subagents:rpc:spawn-managed", (raw) => {
      const { requestId } = raw as { requestId: string };
      f.bus.emit(`subagents:rpc:spawn-managed:reply:${requestId}`, {
        success: true,
        data: { id: "waiting-child", state: "running" },
      });
    });
    const started = await f.tools.get("workflow")?.execute(
      "running",
      {
        script: 'export const meta={name:"pending",description:"test"};return await agent("wait");',
        background: true,
      },
      undefined,
      undefined,
      f.ctx,
    );
    const read = await f.tools
      .get("workflow_control")
      ?.execute(
        "inspect",
        { action: "get", runId: started?.details.runId, consume: true },
        undefined,
        undefined,
        f.ctx,
      );
    expect(read?.details).toMatchObject({ notificationConsumed: false });
    expect(f.acks()).toHaveLength(0);
    await f.shutdown();
  });
  it("keeps workflow/control and per-call bash/write denials at the actual tool/RPC boundary", async () => {
    const f = fixture();
    await f.start();
    let denied: unknown;
    f.bus.on("subagents:rpc:spawn-managed", (raw) => {
      const request = raw as { requestId: string; excludeTools: unknown };
      denied = request.excludeTools;
      f.bus.emit(`subagents:rpc:spawn-managed:reply:${request.requestId}`, {
        success: true,
        data: {
          id: "denied-tools",
          terminal: { status: "completed", result: "done", compactionCount: 0, completedAt: Date.now() },
        },
      });
    });
    await f.tools.get("workflow")?.execute(
      "denials",
      {
        script:
          'export const meta = {name:"denials",description:"test"}; return await agent("review",{excludeTools:["bash","write"]});',
        background: false,
      },
      undefined,
      undefined,
      f.ctx,
    );
    expect(denied).toEqual(["workflow", "workflow_control", "bash", "write"]);
    await f.shutdown();
  });
  it("does not resend a batch member when the second durable acknowledgement throws", async () => {
    const f = fixture();
    await f.start();
    f.setIdle(false);
    const first = await f.run();
    const second = await f.run();
    const append = f.pi.appendEntry.bind(f.pi);
    let ack = 0;
    vi.spyOn(f.pi, "appendEntry").mockImplementation((type, data) => {
      if (type === "pi-workflows:pending-delivery-ack" && ++ack === 2) throw new Error("transient ACK append");
      append(type, data);
    });
    f.setIdle(true);
    await f.emit("agent_settled");
    await vi.waitFor(() => expect(f.acks()).toHaveLength(1));
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    await f.emit("agent_settled");
    await vi.waitFor(() => expect(f.acks()).toHaveLength(2));
    expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.pi.sendMessage.mock.calls[0]?.[0]).toMatchObject({ details: { runIds: [first, second] } });
    await f.drain();
    await f.shutdown();
  });

  it.each(["tool", "navigator", "provider"] as const)(
    "rearms final delivery after %s-owned resume, not at suspension",
    async (path) => {
      const f = fixture();
      await f.start();
      let finish = path === "provider";
      let attempts = 0;
      f.bus.on("subagents:rpc:spawn-managed", (raw) => {
        const { requestId } = raw as { requestId: string };
        attempts++;
        const terminal =
          path === "provider" && attempts === 1
            ? {
                status: "failed",
                error: "rate limit; try again in 1 seconds",
                compactionCount: 0,
                completedAt: Date.now(),
              }
            : finish
              ? { status: "completed", result: "resumed result", compactionCount: 0, completedAt: Date.now() }
              : undefined;
        f.bus.emit(`subagents:rpc:spawn-managed:reply:${requestId}`, {
          success: true,
          data: { id: `resume-${attempts}`, ...(terminal ? { terminal } : { state: "running" }) },
        });
      });
      const start = await f.tools.get("workflow")?.execute(
        "resume-delivery",
        {
          script: 'export const meta = { name: "resumed", description: "test" }; return await agent("work");',
          background: true,
        },
        undefined,
        undefined,
        f.ctx,
      );
      if (!start) throw new Error("workflow tool missing");
      await vi.waitFor(() => expect(attempts).toBe(1));
      if (path !== "provider") {
        await f.tools
          .get("workflow_control")
          ?.execute("pause-delivery", { action: "pause", runId: start.details.runId }, undefined, undefined, f.ctx);
        expect(f.pi.sendMessage).not.toHaveBeenCalled();
        finish = true;
        if (path === "tool")
          await f.tools
            .get("workflow_control")
            ?.execute("resume-delivery", { action: "resume", runId: start.details.runId }, undefined, undefined, f.ctx);
        else {
          f.ctx.mode = "tui";
          f.ctx.hasUI = true;
          let mounts = 0;
          Object.assign(f.ctx.ui, {
            custom: async (
              factory: (
                tui: unknown,
                theme: unknown,
                keys: unknown,
                done: (value: unknown) => void,
              ) => { handleInput(key: string): void; render(width: number): string[]; dispose?(): void },
            ) => {
              mounts++;
              let closed = false;
              const component = factory(
                { terminal: { rows: 24 }, requestRender() {} },
                { fg: (_name: string, text: string) => text, bold: (text: string) => text },
                new KeybindingsManager(TUI_KEYBINDINGS),
                () => {
                  closed = true;
                },
              );
              component.render(80);
              component.handleInput("\r"); // Drill into the current run, in the same live mount.
              expect(component.render(80).join("\n")).toContain("Resume");
              component.handleInput("r");
              component.handleInput("\u001b"); // Return to runs, even while resume settles.
              component.handleInput("\u001b"); // Close and release the mount's timer.
              component.dispose?.();
              expect(closed).toBe(true);
            },
          });
          const command = f.pi.registerCommand.mock.calls.find(([name]) => name === "workflows")?.[1] as {
            handler: (args: string, ctx: unknown) => Promise<void>;
          };
          await command.handler("", f.ctx);
          expect(mounts).toBe(1);
        }
      }
      await vi.waitFor(() => expect(f.pi.sendUserMessage).toHaveBeenCalledTimes(1), { timeout: 3000 });
      expect(attempts).toBe(2);
      expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
      expect(f.pi.sendMessage.mock.calls[0]?.[0].content).toContain("resumed result");
      await f.drain();
      await f.shutdown();
    },
  );
  for (const workflowsFirst of [true, false]) {
    it(`buffers completion across awaited before_agent_start (${workflowsFirst ? "workflows" : "peer"} first)`, async () => {
      const gate = barrier();
      const peer = () => gate.promise;
      const f = fixture(workflowsFirst ? undefined : (on) => on("before_agent_start", peer));
      await f.start();
      if (workflowsFirst) f.on("before_agent_start", peer);
      await f.emit("input", { text: "original input", source: "interactive" });
      const preparing = f.emit("before_agent_start");
      await f.run();
      await tick();
      expect(f.pi.sendMessage).not.toHaveBeenCalled();
      expect(f.acks()).toEqual([]);
      gate.release();
      await preparing;
      f.setIdle(false);
      await f.emit("agent_start");
      f.setIdle(true);
      await f.emit("agent_settled");
      await vi.waitFor(() => expect(f.pi.sendUserMessage).toHaveBeenCalledOnce());
      await f.drain();
      expect(f.acks()).toHaveLength(1);
      await f.shutdown();
    });

    it(`buffers completion across manual compaction (${workflowsFirst ? "workflows" : "peer"} first)`, async () => {
      const gate = barrier();
      const peer = () => gate.promise;
      const f = fixture(workflowsFirst ? undefined : (on) => on("session_before_compact", peer));
      await f.start();
      if (workflowsFirst) f.on("session_before_compact", peer);
      f.setIdle(false); // public isIdle includes the host compaction controller
      const compact = f.emit("session_before_compact", { reason: "manual" });
      await f.run();
      await tick();
      expect(f.pi.sendMessage).not.toHaveBeenCalled();
      gate.release();
      await compact;
      await f.emit("session_compact");
      f.setIdle(true); // controller clears only after notification dispatch
      await vi.waitFor(() => expect(f.pi.sendUserMessage).toHaveBeenCalledOnce());
      await f.drain();
      await f.shutdown();
    });

    it(`fences timer delivery when another settled handler navigates (${workflowsFirst ? "workflows" : "peer"} first)`, async () => {
      let f: ReturnType<typeof fixture>;
      const navigate = async () => {
        await f.emit("session_before_tree");
        f.navigate();
        const event = { type: "session_tree" };
        if (!workflowsFirst) f.bus.emit("subagents:session_tree_committed", { event });
        await f.emit("session_tree", event);
        if (workflowsFirst) f.bus.emit("subagents:session_tree_committed", { event });
      };
      f = fixture(workflowsFirst ? undefined : (on) => on("agent_settled", navigate));
      await f.start();
      if (workflowsFirst) f.on("agent_settled", navigate);
      f.setIdle(false);
      await f.run();
      f.setIdle(true);
      await f.emit("agent_settled");
      await tick();
      expect(f.pi.sendMessage).not.toHaveBeenCalled();
      expect(f.ctx.sessionManager.getBranch()).toEqual([]);
      expect(f.acks()).toEqual([]);
      await f.shutdown();
    });
  }

  it.each(["tree bus-first", "tree workflows-first", "switch", "bus quiesce", "native shutdown"])(
    "consumes a retired wake after an earlier awaited input hook (%s)",
    async (retirement) => {
      const gate = barrier();
      const entered = vi.fn();
      const f = fixture((on) =>
        on("input", (event) => {
          if ((event as { source?: string }).source !== "extension") return;
          entered();
          return gate.promise;
        }),
      );
      const laterInput = vi.fn();
      const preparation = vi.fn();
      await f.start();
      f.on("input", laterInput);
      f.on("before_agent_start", preparation);
      f.setIdle(false);
      await f.run();
      f.setIdle(true);
      await f.emit("agent_settled");
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
      const wake = f.pi.sendUserMessage.mock.calls[0]?.[0];
      expect(wake).toMatch(/^\[pi-workflows:wake:[^\]]+\] /);
      expect(f.acks()).toHaveLength(1); // acknowledgement owns persisted context, not a model turn
      const manager = f.ctx.sessionManager;
      if (retirement.startsWith("tree")) {
        await f.emit("session_before_tree");
        f.navigate(); // same-manager commit while extension input preflight awaits
        const event = { type: "session_tree" };
        if (retirement === "tree bus-first") f.bus.emit("subagents:session_tree_committed", { event });
        await f.emit("session_tree", event);
        if (retirement === "tree workflows-first") f.bus.emit("subagents:session_tree_committed", { event });
      } else if (retirement === "bus quiesce") {
        f.bus.emit("pi-workflows:shutdown-quiesce", { respond: () => {} });
      } else {
        if (retirement === "switch") await f.emit("session_before_switch");
        await f.shutdown();
        if (retirement === "switch") await f.start();
      }
      expect(f.ctx.sessionManager).toBe(manager);
      gate.release();
      await f.drain();
      expect(preparation).not.toHaveBeenCalled();
      expect(laterInput).not.toHaveBeenCalled(); // handled stops Pi's input pipeline
      if (retirement.startsWith("tree")) expect(manager.getBranch()).toEqual([]);
      expect(f.acks()).toHaveLength(1); // no new-branch replay or acknowledgement

      expect(await f.emit("input", { text: wake, source: "extension" })).toEqual({ action: "handled" });
      for (const source of ["interactive", "rpc"]) {
        expect(await f.emit("input", { text: wake, source })).toMatchObject({ action: "continue" });
      }
      expect(await f.emit("input", { text: "Another extension's message", source: "extension" })).toEqual({
        action: "continue",
        text: "Another extension's message",
      });
      await f.shutdown();
    },
  );

  it("coalesces completed results into context plus one ordinary notification hook path", async () => {
    const f = fixture();
    const preparation = vi.fn();
    const receivedInput = vi.fn();
    await f.start();
    f.on("before_agent_start", preparation);
    f.on("input", receivedInput);
    f.setIdle(false);
    const first = await f.run();
    const second = await f.run();
    f.setIdle(true);
    f.setQueued(true);
    await f.emit("agent_settled");
    await tick();
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    f.setQueued(false);
    await f.emit("agent_settled");
    expect(f.pi.sendMessage).not.toHaveBeenCalled(); // still inside settled dispatch
    await vi.waitFor(() => expect(f.pi.sendUserMessage).toHaveBeenCalledOnce());
    await f.drain();
    expect(f.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(
      {
        customType: "pi-workflows:delivery",
        details: { runIds: [first, second] },
        display: true,
        content: expect.stringContaining(String(first)),
      },
      { triggerTurn: false },
    );
    expect(f.pi.sendMessage.mock.calls[0]?.[0].content).toContain(String(second));
    expect(preparation).toHaveBeenCalledOnce();
    expect(f.pi.sendUserMessage.mock.calls[0]?.[1]).toEqual({ deliverAs: "followUp", expandPromptTemplates: false });
    expect(f.acks()).toHaveLength(2);
    expect(receivedInput.mock.calls[0]?.[0]).toMatchObject({
      text: "Workflow results are ready in the preceding context.",
      source: "extension",
    });
    const consumed = f.pi.sendUserMessage.mock.calls[0]?.[0];
    expect(await f.emit("input", { text: consumed, source: "extension" })).toEqual({ action: "handled" });
    expect(await f.emit("input", { text: "Unrelated extension input", source: "extension" })).toEqual({
      action: "continue",
      text: "Unrelated extension input",
    });
    await f.shutdown();
  });

  it("does not acknowledge a void send that never persisted; recovers pending markers on rebind", async () => {
    const f = fixture();
    await f.start();
    f.setIdle(false);
    await f.run();
    f.setPersistence(false);
    f.setIdle(true);
    await f.emit("agent_settled");
    await tick();
    expect(f.pi.sendMessage).toHaveBeenCalledOnce();
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(f.acks()).toEqual([]);
    await tick();
    expect(f.pi.sendMessage).toHaveBeenCalledOnce(); // no timer/model polling
    await f.shutdown();
    f.setPersistence(true);
    await f.start();
    await vi.waitFor(() => expect(f.pi.sendUserMessage).toHaveBeenCalledOnce());
    await f.drain();
    expect(f.acks()).toHaveLength(1);
    await f.shutdown();
    await f.start();
    await tick();
    expect(f.pi.sendUserMessage).toHaveBeenCalledOnce(); // acknowledged result stays delivered
    await f.shutdown();
  });

  for (const busFirst of [true, false]) {
    it(`retires admission and late delivery synchronously (${busFirst ? "bus" : "native"} shutdown first)`, async () => {
      const f = fixture();
      await f.start();
      // Completion is buffered, and a handoff timer is about to run.
      f.setIdle(false);
      await f.run();
      f.setIdle(true);
      await f.emit("agent_settled");
      let quiescence: Promise<unknown> | undefined;
      const handshake = () =>
        f.bus.emit("pi-workflows:shutdown-quiesce", {
          respond: (promise: Promise<unknown>) => {
            quiescence = promise;
          },
        });
      let shutdown: ReturnType<typeof f.shutdown> | undefined;
      if (busFirst) handshake();
      else shutdown = f.shutdown();
      const admitted = await f.admit();
      expect(admitted?.details.runId).toBeUndefined();
      if (busFirst) {
        handshake(); // idempotent, including after admission has retired
        await quiescence;
        await tick(); // retiring peer can await its own cleanup before native hook
        shutdown = f.shutdown();
      } else handshake();
      await shutdown;
      await tick();
      expect(f.pi.sendMessage).not.toHaveBeenCalled();
      expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
      expect(f.acks()).toEqual([]);
    });
  }
});
