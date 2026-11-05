import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionContext, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import {
  type ManagedRoutingPolicy,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_VERSION,
  routingPolicyFingerprint,
  WORKFLOW_UI_CHANNELS,
} from "@signalridge/pi-subagents-protocol";
import { describe, expect, it, vi } from "vitest";
import { WORKFLOW_ARMED_DIRECTIVE } from "../src/arming.js";
import { WorkflowEngine } from "../src/engine.js";
import piWorkflows from "../src/index.js";
import { STATUS_OPEN, STATUS_QUERY } from "../src/status-actions.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

// Deliberately none of the names the built-in workflows use: a host is free to
// call its tiers whatever it likes, and a shipped command must still run.
const ROUTING_POLICY: ManagedRoutingPolicy = {
  defaultTier: "standard",
  profiles: {
    cheap: { model: "inherit", thinking: "low" },
    standard: { model: "inherit", thinking: "medium" },
  },
  blockedProfiles: [],
  blockedDefaultTier: false,
};
const ROUTING_POLICY_SNAPSHOT = {
  policy: ROUTING_POLICY,
  fingerprint: routingPolicyFingerprint(ROUTING_POLICY),
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

function createPi(child: boolean, appendFailures = 0, branch: unknown[] = [], protocolAvailable = true) {
  const bus = new Bus();
  // Mutable so a test can change the host catalogue between runs the way
  // `/agents → Model tiers` does mid-session.
  const routing = { snapshot: ROUTING_POLICY_SNAPSHOT, pings: 0 };
  const lifecycle = new Map<string, (...args: never[]) => unknown>();
  const tools: string[] = [];
  const toolDefinitions: unknown[] = [];
  const commands: string[] = [];
  const commandDefinitions = new Map<string, unknown>();
  const widgetUpdates: Array<string[] | undefined> = [];
  const widgetRegistrations: Array<{
    key: string;
    content: Parameters<ExtensionContext["ui"]["setWidget"]>[1];
    options: Parameters<ExtensionContext["ui"]["setWidget"]>[2];
  }> = [];
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
    routing.pings += 1;
    bus.emit(`subagents:rpc:ping:reply:${request.requestId}`, {
      success: true,
      data: protocolAvailable
        ? {
            version: PROTOCOL_VERSION,
            capabilities: PROTOCOL_CAPABILITIES,
            routingPolicy: routing.snapshot,
          }
        : { version: PROTOCOL_VERSION - 1, capabilities: {} },
    });
  });
  const pi = {
    events: bus,
    registerMessageRenderer: vi.fn(),
    appendEntry: (_type: string, data: unknown) => {
      if (appendFailures > 0) {
        appendFailures -= 1;
        throw new Error("transient append failure");
      }
      entries.push(data);
    },
    registerTool: (tool: { name: string }) => {
      tools.push(tool.name);
      toolDefinitions.push(tool);
    },
    registerCommand: (name: string, descriptor: unknown) => {
      commands.push(name);
      commandDefinitions.set(name, descriptor);
    },
    on: (event: string, handler: (...args: never[]) => unknown) => {
      lifecycle.set(event, handler);
      return () => lifecycle.delete(event);
    },
  };
  const ctx = {
    hasUI: false,
    mode: "print" as "print" | "rpc" | "tui",
    ui: {
      setStatus: vi.fn(),
      setWidget: (
        key: string,
        content: Parameters<ExtensionContext["ui"]["setWidget"]>[1],
        options?: Parameters<ExtensionContext["ui"]["setWidget"]>[2],
      ) => {
        widgetRegistrations.push({ key, content, options });
        if (typeof content === "function") {
          const component = content(
            { terminal: { rows: 24, columns: 80 }, requestRender() {} } as never,
            { fg: (_token: string, text: string) => text, bold: (text: string) => text } as never,
          );
          widgetUpdates.push(component.render(80));
        } else widgetUpdates.push(content);
      },
      notify: vi.fn(),
      confirm: vi.fn(async () => true),
      input: vi.fn(async () => "input"),
      select: vi.fn(async () => "choice"),
    },
    sessionManager: {
      getSessionId: () => "workflow-fixture-session",
      getLeafId: () => (entries.length ? `entry-${entries.length}` : null),
      getBranch: () =>
        entries.map((entry, index) => {
          const shaped = entry as { type?: unknown; id?: string };
          const id = shaped.id ?? `entry-${index + 1}`;
          return shaped.type
            ? { ...shaped, id }
            : { id, type: "custom", customType: "pi-workflows:journal", data: entry };
        }),
    },
  };
  return {
    bus,
    lifecycle,
    tools,
    toolDefinitions,
    commands,
    commandDefinitions,
    entries,
    widgetUpdates,
    widgetRegistrations,
    routing,
    pi,
    ctx,
  };
}

type WorkflowTool = {
  execute: (
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: { runId: string; status: string; result?: string };
  }>;
};

function workflowTool(fixture: ReturnType<typeof createPi>): WorkflowTool {
  return fixture.toolDefinitions.find((tool) => (tool as { name: string }).name === "workflow") as WorkflowTool;
}

describe("workflow status lifecycle", () => {
  function query(fixture: ReturnType<typeof createPi>) {
    const replies: Array<{ data: { surfaceId: string; providerId: string; sessionId: string } }> = [];
    const off = fixture.bus.on(`${STATUS_QUERY}:reply:q`, (raw) => replies.push(raw as (typeof replies)[number]));
    fixture.bus.emit(STATUS_QUERY, { version: 1, requestId: "q", sessionId: "workflow-fixture-session" });
    off();
    const data = replies[0]?.data;
    return data && { surfaceId: data.surfaceId, providerId: data.providerId, sessionId: data.sessionId };
  }

  it("opens the owned navigator only after admission without starting work, then clears only its status", async () => {
    const f = createPi(false);
    const screens: string[] = [];
    let close: (() => void) | undefined;
    const custom = vi.fn(async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
      await new Promise<void>((resolve) => {
        void Promise.resolve(
          factory(
            { terminal: { rows: 24, columns: 80 }, requestRender() {} } as never,
            { fg: (_token: string, text: string) => text, bold: (text: string) => text } as never,
            { matches: () => false, getKeys: () => [] } as never,
            resolve,
          ),
        ).then((component) => {
          screens.push(component.render(80).join("\n"));
          close = () => {
            component.handleInput?.("\u001b");
            component.handleInput?.("\u001b");
          };
        });
      });
    });
    const ctx = { ...f.ctx, mode: "tui" as const, hasUI: true, ui: { ...f.ctx.ui, custom } };
    const start = vi.spyOn(WorkflowEngine.prototype, "start");
    piWorkflows(f.pi as never);
    expect(query(f)).toBeUndefined();
    await f.lifecycle.get("session_start")?.({}, ctx);
    const selected = query(f);
    expect(selected).toMatchObject({ providerId: "pi-workflows", sessionId: "workflow-fixture-session" });
    expect(custom).not.toHaveBeenCalled();
    const reply = vi.fn();
    const off = f.bus.on(`${STATUS_OPEN}:reply:o`, reply);
    try {
      f.bus.emit(STATUS_OPEN, { version: 1, requestId: "o", ...selected, actionId: "runs" });
      expect(reply).toHaveBeenCalledExactlyOnceWith({ success: true, data: { accepted: true } });
      expect(custom).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(screens).toHaveLength(1));
      f.bus.emit(STATUS_OPEN, { version: 1, requestId: "o", ...selected, actionId: "runs" });
      expect(reply).toHaveBeenLastCalledWith({ success: false, error: "Status action is unavailable." });
      expect(custom).toHaveBeenCalledOnce();
      expect(start).not.toHaveBeenCalled();
      expect(f.entries).toEqual([]);
      close?.();
    } finally {
      off();
      close?.();
      await f.lifecycle.get("session_shutdown")?.({}, ctx);
      expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-workflows", undefined);
      expect(f.ctx.ui.setStatus.mock.calls.every(([key]) => key === "pi-workflows")).toBe(true);
      expect(query(f)).toBeUndefined();
      start.mockRestore();
    }
  });

  it("keeps ordinary appends but retires live divergence permanently and rotates before late tree/reload callbacks", async () => {
    const f = createPi(false, 0, [{ id: "root", type: "custom" }]);
    const custom = vi.fn();
    const ctx = {
      ...f.ctx,
      mode: "tui" as const,
      hasUI: true,
      ui: { ...f.ctx.ui, custom },
      sessionManager: {
        ...f.ctx.sessionManager,
        getLeafId: () => f.ctx.sessionManager.getBranch().at(-1)?.id ?? null,
      },
    };
    piWorkflows(f.pi as never);
    await f.lifecycle.get("session_start")?.({}, ctx);
    const first = query(f);
    f.entries.push({ id: "append", type: "custom" });
    expect(query(f)).toEqual(first);
    f.bus.emit(STATUS_OPEN, { version: 1, requestId: "late", ...first, actionId: "runs" });
    f.entries.splice(1, 1, { id: "sibling", type: "custom" });
    expect(query(f)).toBeUndefined();
    f.entries.splice(1, 1, { id: "append", type: "custom" });
    expect(query(f)).toBeUndefined();
    await Promise.resolve();
    expect(custom).not.toHaveBeenCalled();
    await f.lifecycle.get("session_tree")?.({}, ctx);
    const second = query(f);
    expect(second?.surfaceId).not.toBe(first?.surfaceId);
    f.bus.emit(STATUS_OPEN, { version: 1, requestId: "before-tree", ...second, actionId: "runs" });
    f.bus.emit("subagents:session_tree_committed", { event: {} });
    await Promise.resolve();
    expect(custom).not.toHaveBeenCalled();
    await f.lifecycle.get("session_tree")?.({}, ctx);
    const third = query(f);
    expect(third?.surfaceId).not.toBe(second?.surfaceId);
    f.bus.emit(STATUS_OPEN, { version: 1, requestId: "shutdown", ...third, actionId: "runs" });
    await f.lifecycle.get("session_shutdown")?.({}, ctx);
    await Promise.resolve();
    expect(custom).not.toHaveBeenCalled();
    await f.lifecycle.get("session_start")?.({}, ctx);
    expect(query(f)?.surfaceId).not.toBe(third?.surfaceId);
    await f.lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it.each(["rpc", "print", "tui"] as const)(
    "does not advertise or set footer status without terminal UI in %s",
    async (mode) => {
      const f = createPi(false);
      f.ctx.mode = mode;
      f.ctx.hasUI = mode === "rpc";
      piWorkflows(f.pi as never);
      await f.lifecycle.get("session_start")?.({}, f.ctx);
      expect(query(f)).toBeUndefined();
      await f.lifecycle.get("session_shutdown")?.({}, f.ctx);
      expect(f.ctx.ui.setStatus).not.toHaveBeenCalled();
    },
  );

  it("rechecks the exact source when the host defers custom construction past retirement", async () => {
    const f = createPi(false);
    let mount: (() => Promise<unknown>) | undefined;
    const custom = vi.fn(
      (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) =>
        new Promise<void>((resolve, reject) => {
          mount = async () => {
            try {
              const component = await factory(
                { terminal: { rows: 24, columns: 80 }, requestRender() {} } as never,
                { fg: (_token: string, text: string) => text, bold: (text: string) => text } as never,
                { matches: () => false, getKeys: () => [] } as never,
                resolve,
              );
              return component;
            } catch (error) {
              reject(error);
              throw error;
            }
          };
        }),
    );
    const ctx = { ...f.ctx, mode: "tui" as const, hasUI: true, ui: { ...f.ctx.ui, custom } };
    piWorkflows(f.pi as never);
    await f.lifecycle.get("session_start")?.({}, ctx);
    const selected = query(f);
    f.bus.emit(STATUS_OPEN, { version: 1, requestId: "deferred", ...selected, actionId: "runs" });
    await vi.waitFor(() => expect(mount).toBeDefined());
    await f.lifecycle.get("session_tree")?.({}, ctx);
    const current = query(f);
    expect(current?.surfaceId).not.toBe(selected?.surfaceId);
    await expect(mount?.()).rejects.toThrow("retired");
    await Promise.resolve();
    expect(query(f)).toEqual(current);
    expect(custom).toHaveBeenCalledOnce();
    expect(f.entries).toEqual([]);
    await f.lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("admits a replacement surface before the retired factory settles and keeps its reservation independent", async () => {
    const f = createPi(false);
    const mounts: Array<() => Promise<{ handleInput?(data: string): void; dispose?(): void }>> = [];
    const custom = vi.fn(
      (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) =>
        new Promise<void>((resolve, reject) => {
          mounts.push(async () => {
            try {
              return await factory(
                { terminal: { rows: 24, columns: 80 }, requestRender() {} } as never,
                { fg: (_token: string, text: string) => text, bold: (text: string) => text } as never,
                { matches: () => false, getKeys: () => [] } as never,
                resolve,
              );
            } catch (error) {
              reject(error);
              throw error;
            }
          });
        }),
    );
    const ctx = { ...f.ctx, mode: "tui" as const, hasUI: true, ui: { ...f.ctx.ui, custom } };
    piWorkflows(f.pi as never);
    await f.lifecycle.get("session_start")?.({}, ctx);
    const old = query(f);
    f.bus.emit(STATUS_OPEN, { version: 1, requestId: "old", ...old, actionId: "runs" });
    await vi.waitFor(() => expect(mounts).toHaveLength(1));
    await f.lifecycle.get("session_tree")?.({}, ctx);
    const current = query(f);
    const reply = vi.fn();
    const off = f.bus.on(`${STATUS_OPEN}:reply:new`, reply);
    const offProbe = f.bus.on(`${STATUS_OPEN}:reply:probe`, reply);
    let directOpening: Promise<void> | undefined;
    let component: Awaited<ReturnType<(typeof mounts)[number]>> | undefined;
    try {
      f.bus.emit(STATUS_OPEN, { version: 1, requestId: "new", ...current, actionId: "runs" });
      expect(reply).toHaveBeenLastCalledWith({ success: true, data: { accepted: true } });
      await vi.waitFor(() => expect(mounts).toHaveLength(2));
      component = await mounts[1]();
      component.handleInput?.("\u001b");
      component.dispose?.();
      component = undefined;
      for (let index = 0; index < 8; index++) await Promise.resolve();
      // Open directly so StatusActions.opening cannot mask a broken map slot.
      const command = f.commandDefinitions.get("workflows") as {
        handler(args: string, context: unknown): Promise<void>;
      };
      directOpening = command.handler("", ctx);
      await vi.waitFor(() => expect(mounts).toHaveLength(3));
      component = await mounts[2]();
      await expect(mounts[0]()).rejects.toThrow("retired");
      for (let index = 0; index < 8; index++) await Promise.resolve();
      // A fresh request ID also avoids duplicate-request rejection as a false positive.
      f.bus.emit(STATUS_OPEN, { version: 1, requestId: "probe", ...current, actionId: "runs" });
      expect(reply).toHaveBeenLastCalledWith({ success: false, error: "Status action is unavailable." });
      expect(custom).toHaveBeenCalledTimes(3);
    } finally {
      off();
      offProbe();
      component?.handleInput?.("\u001b");
      component?.dispose?.();
      await directOpening;
      await f.lifecycle.get("session_shutdown")?.({}, ctx);
    }
  });

  it("publishes active, paused, stopped and empty run authority on the existing refresh cadence", async () => {
    const f = createPi(false);
    f.ctx.mode = "tui";
    f.ctx.hasUI = true;
    piWorkflows(f.pi as never);
    await f.lifecycle.get("session_start")?.({}, f.ctx);
    const pending = workflowTool(f).execute(
      "footer",
      {
        script: 'export const meta = { name: "footer", description: "test" }; await checkpoint("wait");',
        background: false,
      },
      undefined,
      undefined,
      f.ctx,
    );
    f.ctx.ui.confirm.mockImplementation(() => new Promise<boolean>(() => {}));
    const control = f.toolDefinitions.find(
      (tool) => (tool as { name: string }).name === "workflow_control",
    ) as WorkflowTool;
    try {
      await vi.waitFor(() => expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-workflows", "Workflows · A1 P0"));
      const runId = (f.entries.find((raw) => (raw as { kind?: string }).kind === "run_created") as { runId: string })
        .runId;
      await control.execute("pause", { action: "pause", run_id: runId }, undefined, undefined, f.ctx);
      await pending;
      await vi.waitFor(() => expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-workflows", "Workflows · A0 P1"));
      await control.execute("stop", { action: "stop", run_id: runId }, undefined, undefined, f.ctx);
      await vi.waitFor(() =>
        expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-workflows", "Workflows · C0 F0 S1"),
      );
      await control.execute("rm", { action: "rm", run_id: runId }, undefined, undefined, f.ctx);
      await vi.waitFor(() => expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-workflows", undefined));
    } finally {
      await f.lifecycle.get("session_shutdown")?.({}, f.ctx);
      await pending;
    }
  });
});

describe("owned workflow overview lifecycle", () => {
  it("keeps periodic projection/footer updates without children, expires terminal rows, and fences old factories", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const run = {
      runId: "overview",
      status: "paused",
      startedAt: now - 3000,
      updatedAt: now,
      meta: { name: "childless", description: "test" },
      callStatus: {},
      callResults: {},
      agentIds: {},
    };
    const list = vi
      .spyOn(WorkflowEngine.prototype, "list")
      .mockImplementation(() => [{ runId: run.runId, status: run.status }] as never);
    const get = vi.spyOn(WorkflowEngine.prototype, "getRun").mockImplementation(() => run as never);
    const header = vi
      .spyOn(WorkflowEngine.prototype, "getInspectionHeader")
      .mockReturnValue({ restored: true } as never);
    const f = createPi(false);
    f.ctx.mode = "tui";
    f.ctx.hasUI = true;
    const updates: Array<{ runs: Array<{ elapsedMs: number; status: string }> }> = [];
    f.bus.on(WORKFLOW_UI_CHANNELS.changed, (raw) => updates.push(raw as (typeof updates)[number]));
    piWorkflows(f.pi as never);
    try {
      await f.lifecycle.get("session_start")?.({}, f.ctx);
      expect(f.widgetUpdates.at(-1)?.join("\n")).toContain("childless · paused");
      expect(f.widgetUpdates.at(-1)?.join("\n")).toContain("0/0 in flight");
      expect(f.widgetUpdates.at(-1)?.join("\n")).toContain("restored");
      const old = f.widgetRegistrations.find((item) => typeof item.content === "function")?.content;
      if (typeof old !== "function") throw new Error("Overview factory missing");
      const mounted = old(
        { terminal: { rows: 24 }, requestRender() {} } as never,
        { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(updates.at(-1)?.runs[0].elapsedMs).toBe(5000);
      expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-workflows", "Workflows · A0 P1");
      await f.lifecycle.get("session_tree")?.({}, f.ctx);
      expect(mounted.render(120)).toEqual([]);
      run.status = "stopping";
      await vi.advanceTimersByTimeAsync(2000);
      expect(updates.at(-1)?.runs[0].status).toBe("stopping");
      expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-workflows", "Workflows · A1 P0");
      run.status = "completed";
      run.updatedAt = Date.now();
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.widgetUpdates.at(-1)?.join("\n")).toContain("childless · completed");
      await vi.advanceTimersByTimeAsync(4000);
      expect(f.widgetUpdates.at(-1)).toBeUndefined();
      expect(updates.at(-1)?.runs[0].status).toBe("completed"); // History remains observable.
      expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-workflows", "Workflows · C1 F0 S0");
      const count = f.widgetUpdates.length;
      await vi.advanceTimersByTimeAsync(10000);
      expect(f.widgetUpdates).toHaveLength(count); // No terminal relinger or polling loop.
      expect(
        f.widgetRegistrations
          .filter((item) => typeof item.content === "function")
          .every((item) => item.options?.placement === "belowEditor"),
      ).toBe(true);
    } finally {
      await f.lifecycle.get("session_shutdown")?.({}, f.ctx);
      list.mockRestore();
      get.mockRestore();
      header.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("pi-workflows loader context isolation", () => {
  it("sanitizes command notifications without changing stored workflow names and reports missing watches", async () => {
    const fixture = createPi(false);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    try {
      const name = "unsafe\u001b[2J\u009b\u202e\u0000";
      const result = await workflowTool(fixture).execute(
        "unsafe-name",
        {
          script: `export const meta = { name: ${JSON.stringify(name)}, description: "test" }; return true;`,
          background: false,
        },
        undefined,
        undefined,
        fixture.ctx,
      );
      expect(result.details.status).toBe("completed");
      const command = fixture.commandDefinitions.get("workflows") as {
        handler: (args: string, ctx: unknown) => Promise<void>;
      };
      for (const args of ["status", `status ${result.details.runId}`, "watch missing-id", "unknown\u001b[2J"]) {
        await command.handler(args, fixture.ctx);
      }
      const notices = fixture.ctx.ui.notify.mock.calls.map(([message]) => String(message)).join("\n");
      for (const byte of ["\u001b", "\u009b", "\u202e", "\u0000"]) expect(notices).not.toContain(byte);
      expect(notices).toContain("\\u001b[2J");
      expect(notices).toContain("Workflow run not found: missing-id");
      expect(fixture.entries.find((entry) => (entry as { kind?: string }).kind === "run_created")).toMatchObject({
        meta: { name },
      });
    } finally {
      await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
    }
  });

  it("watch opens the selected live TUI inspector and retains checkpoint presentation", async () => {
    const fixture = createPi(false);
    const screens: string[] = [];
    const custom = vi.fn(async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
      let closed = false;
      const component = await factory(
        { terminal: { rows: 24, columns: 80 }, requestRender() {} } as never,
        { fg: (_token: string, text: string) => text, bold: (text: string) => text } as never,
        { matches: () => false, getKeys: () => [] } as never,
        () => {
          closed = true;
        },
      );
      screens.push(component.render(80).join("\n"));
      component.handleInput?.("\u001b");
      component.handleInput?.("\u001b");
      expect(closed).toBe(true);
    });
    const ctx = { ...fixture.ctx, mode: "tui" as const, hasUI: true, ui: { ...fixture.ctx.ui, custom } };
    const inspection = vi.spyOn(WorkflowEngine.prototype, "getInspection");
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, ctx);
    try {
      const result = await workflowTool(fixture).execute(
        "checkpoint-inspection",
        {
          script:
            'export const meta = { name: "watch-checkpoint", description: "test", phases: [{ title: "Verify" }] }; phase("Verify"); return await checkpoint("Continue?", { default: true });',
          background: false,
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.status).toBe("completed");
      const command = fixture.commandDefinitions.get("workflows") as {
        handler: (args: string, ctx: unknown) => Promise<void>;
      };
      await command.handler(`watch ${result.details.runId}`, ctx);
      expect(custom).toHaveBeenCalledOnce();
      expect(screens[0]).toContain("watch-checkpoint");
      expect(screens[0]).toContain("entered");
      expect(screens[0]).not.toContain("Invalid presentation");
      expect(
        inspection.mock.results.some(
          (entry) => entry.type === "return" && entry.value?.calls.some((call) => call.kind === "checkpoint"),
        ),
      ).toBe(true);
    } finally {
      await fixture.lifecycle.get("session_shutdown")?.({}, ctx);
      inspection.mockRestore();
    }
  });

  it("encodes delivery display copies without changing persisted content or membership", async () => {
    const fixture = createPi(false);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    const render = fixture.pi.registerMessageRenderer.mock.calls.find(
      ([type]) => type === "pi-workflows:delivery",
    )?.[1] as (message: unknown, options: unknown, theme: unknown) => { render(width: number): string[] };
    const message = { content: "raw\u001b[2J\u009b\u202e result", details: { runIds: ["raw-run"] } };
    const before = structuredClone(message);
    const displayed = render(message, { expanded: true }, { fg: (_token: string, text: string) => text })
      .render(120)
      .join("\n");
    for (const control of ["\u001b", "\u009b", "\u202e"]) expect(displayed).not.toContain(control);
    expect(displayed).toContain("raw\\u001b[2J\\u009b\\u202e result");
    expect(message).toEqual(before);
    await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
  });
  it("binds every code-review git/gh discovery command to the command session cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "workflows-review-cwd-"));
    const a = join(root, "a");
    const b = join(root, "b");
    const originalCwd = process.cwd();
    const { execFileSync: exec } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const fixture = createPi(false);
    try {
      for (const cwd of [a, b]) {
        mkdirSync(cwd);
        exec("git", ["init", "--quiet"], { cwd });
        writeFileSync(join(cwd, "review.txt"), "before\n");
        exec("git", ["add", "."], { cwd });
        exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"], {
          cwd,
        });
        writeFileSync(join(cwd, "review.txt"), cwd === a ? "process-only\n" : "session-only\n");
      }
      process.chdir(a);
      const ctx = { ...fixture.ctx, cwd: b };
      piWorkflows(fixture.pi as never);
      await fixture.lifecycle.get("session_start")?.({}, ctx);
      const start = vi.spyOn(WorkflowEngine.prototype, "start").mockResolvedValue({
        runId: "scope-test",
        status: "completed",
        background: true,
      });
      const commands = vi.mocked(execFileSync).mockImplementation((file, args, options) => {
        if (file === "gh") return "PR diff from session";
        return exec(file, args, options);
      });
      const review = fixture.commandDefinitions.get("code-review") as {
        handler: (args: string, ctx: unknown) => Promise<void>;
      };
      for (const scope of ["", "review.txt", "HEAD..HEAD", "123"]) await review.handler(scope, ctx);
      // The empty range executes successfully but deliberately has no review to start.
      expect(start.mock.calls.map(([, options]) => options?.args)).toEqual([
        { diff: expect.stringContaining("session-only"), diffSource: "working tree vs HEAD" },
        { diff: expect.stringContaining("session-only"), diffSource: "path review.txt" },
        { diff: "PR diff from session", diffSource: "PR #123" },
      ]);
      expect(commands.mock.calls.map(([file]) => file)).toEqual(["git", "git", "git", "gh"]);
      for (const [, , options] of commands.mock.calls) expect(options).toMatchObject({ cwd: b });
      // An empty auto scope also invokes the unscoped fallback in the same cwd.
      writeFileSync(join(b, "review.txt"), "before\n");
      await review.handler("", ctx);
      expect(commands.mock.calls.slice(-2).map(([, , options]) => options)).toEqual([
        expect.objectContaining({ cwd: b }),
        expect.objectContaining({ cwd: b }),
      ]);
    } finally {
      await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("captures script cwd at session start for initial, replay and nested executions", async () => {
    const root = mkdtempSync(join(tmpdir(), "workflows-script-cwd-"));
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(a);
    mkdirSync(b);
    const originalCwd = process.cwd();
    const fixture = createPi(false);
    try {
      process.chdir(a);
      const ctx = { ...fixture.ctx, cwd: b };
      piWorkflows(fixture.pi as never);
      await fixture.lifecycle.get("session_start")?.({}, ctx);
      const child = 'export const meta = { name: "child-cwd", description: "test" }; return [cwd, process.cwd()];';
      const script = `export const meta = { name: "session-cwd", description: "test" };
return { local: [cwd, process.cwd()], nested: await workflow(${JSON.stringify(child)}) };`;
      const first = await workflowTool(fixture).execute(
        "initial",
        { script, background: false },
        undefined,
        undefined,
        ctx,
      );
      expect(first.details.status, JSON.stringify(first.content)).toBe("completed");
      expect(JSON.parse(first.details.result ?? "null")).toEqual({ local: [b, b], nested: [b, b] });
      const controller = new AbortController();
      const dialog = vi.fn(() => new Promise<boolean>(() => {}));
      const rpcCtx = { ...ctx, mode: "rpc", hasUI: true, ui: { ...ctx.ui, confirm: dialog } };
      const pending = workflowTool(fixture).execute(
        "retryable",
        {
          script: 'export const meta = { name: "retryable-cwd", description: "test" }; await checkpoint("wait");',
          background: false,
        },
        controller.signal,
        undefined,
        rpcCtx,
      );
      await vi.waitFor(() => expect(dialog).toHaveBeenCalledOnce());
      controller.abort();
      const interrupted = await pending;
      expect(interrupted.details.status).toBe("interrupted");
      const resumed = await workflowTool(fixture).execute(
        "replay",
        {
          script: script.replace(
            "return { local:",
            `const fresh = await workflow(${JSON.stringify(child)}); return { fresh, local:`,
          ),
          resumeFromRunId: interrupted.details.runId,
          background: false,
        },
        undefined,
        undefined,
        ctx,
      );
      expect(resumed.details.status, JSON.stringify(resumed.content)).toBe("completed");
      expect(fixture.entries.at(-1)).toMatchObject({
        kind: "workflow_transition",
        status: "completed",
        finalResult: { fresh: [b, b], local: [b, b], nested: [b, b] },
      });
    } finally {
      await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
  for (const kind of ["confirm", "input", "select"] as const) {
    for (const action of ["tool-abort", "pause", "stop", "dispose", "fatal"] as const) {
      it(`${action} closes an unanswered ${kind} checkpoint and pairs Pi prompt lifecycle`, async () => {
        const fixture = createPi(false);
        const controller = new AbortController();
        let dialogSignal: AbortSignal | undefined;
        let pendingDialogs = 0;
        let markDialogOpened!: () => void;
        const dialogOpened = new Promise<void>((resolve) => {
          markDialogOpened = resolve;
        });
        if (action === "fatal") {
          // Gate the sibling on the actual unanswered public UI dialog, not
          // transport admission: an immediate script throw can beat UI mounting.
          fixture.bus.on("subagents:rpc:spawn-managed", (raw) => {
            const { requestId } = raw as { requestId: string };
            void dialogOpened.then(() => {
              fixture.bus.emit(`subagents:rpc:spawn-managed:reply:${requestId}`, {
                success: true,
                data: {
                  id: "fatal-trigger",
                  state: "completed",
                  terminal: { status: "completed", result: "ready", compactionCount: 0, completedAt: Date.now() },
                },
              });
            });
          });
        }
        const dialog = vi.fn(async (_title: string, _value: unknown, options?: { signal?: AbortSignal }) => {
          dialogSignal = options?.signal;
          pendingDialogs++;
          try {
            return await new Promise<false | undefined>((resolve) => {
              const close = () => {
                dialogSignal?.removeEventListener("abort", close);
                resolve(kind === "confirm" ? false : undefined);
              };
              dialogSignal?.addEventListener("abort", close, { once: true });
              if (dialogSignal?.aborted) close();
              markDialogOpened();
            });
          } finally {
            pendingDialogs--;
          }
        });
        // Use Pi's real public UI wrapper: lifecycle pairing must happen on
        // automatic cancellation, without a synthetic/manual UI response.
        const runner = new ExtensionRunner([], {} as never, ".", {} as never, {} as never);
        const emitted = vi.spyOn(runner, "emit").mockResolvedValue(undefined);
        runner.setUIContext({ ...fixture.ctx.ui, [kind]: dialog } as never, "rpc");
        const ctx = { ...fixture.ctx, mode: "rpc", hasUI: true, ui: runner.getUIContext() };
        piWorkflows(fixture.pi as never);
        await fixture.lifecycle.get("session_start")?.({}, ctx);
        const checkpoint = `checkpoint("wait", { kind: "${kind}", choices: ["yes"], default: "fallback" })`;
        const body =
          action === "fatal"
            ? `return await Promise.all([${checkpoint}, agent("release fatal").then(() => { throw new Error("fatal"); })]);`
            : `return await ${checkpoint};`;
        const pending = workflowTool(fixture).execute(
          "cancel-checkpoint",
          { script: `export const meta = { name: "cancel-dialog", description: "test" }; ${body}`, background: false },
          controller.signal,
          undefined,
          ctx,
        );
        await vi.waitFor(() => expect(dialog).toHaveBeenCalledOnce());
        const runId = (
          fixture.entries.find((entry) => (entry as { kind?: string }).kind === "run_created") as { runId: string }
        ).runId;
        if (action === "tool-abort") controller.abort();
        else if (action === "dispose") await fixture.lifecycle.get("session_shutdown")?.({}, ctx);
        else if (action !== "fatal") {
          const control = fixture.toolDefinitions.find(
            (tool) => (tool as { name: string }).name === "workflow_control",
          ) as WorkflowTool;
          await control.execute(action, { action, run_id: runId }, undefined, undefined, ctx);
        }
        const cancelled = await pending;
        if (action === "tool-abort") {
          expect(cancelled.details.status).toBe("interrupted");
          expect(cancelled.content.map((part) => part.text).join(" ")).not.toContain("run continues");
          expect(pendingDialogs).toBe(0);
        }
        await vi.waitFor(() => {
          expect(dialogSignal?.aborted).toBe(true);
          expect(pendingDialogs).toBe(0);
          expect(emitted.mock.calls.map(([event]) => event.type)).toEqual(["ui_prompt_start", "ui_prompt_end"]);
        });
        const callResults = fixture.entries.filter((entry) => (entry as { kind?: string }).kind === "call_result");
        // Checkpoint call 0 never commits; only the gated sibling call 1 may.
        if (action === "fatal") {
          expect(cancelled.details.status).toBe("failed");
          expect(cancelled.content.map((part) => part.text).join(" ")).toContain("fatal");
          expect(callResults).toHaveLength(1);
          expect(callResults[0]).toMatchObject({ nodeId: "1", result: { status: "completed", result: "ready" } });
        } else expect(callResults).toEqual([]);
        if (action === "tool-abort") {
          const control = fixture.toolDefinitions.find(
            (tool) => (tool as { name: string }).name === "workflow_control",
          ) as WorkflowTool;
          await control.execute(
            "resume",
            { action: "resume", run_id: runId },
            new AbortController().signal,
            undefined,
            ctx,
          );
          await vi.waitFor(() =>
            expect(
              fixture.entries.some((entry) => {
                const fact = entry as { kind?: string; status?: string };
                return fact.kind === "workflow_transition" && fact.status === "completed";
              }),
            ).toBe(true),
          );
        }
        await fixture.lifecycle.get("session_shutdown")?.({}, ctx);
      });
    }
  }

  for (const mode of ["rpc", "print"] as const) {
    it(`foreground checkpoints use ${mode === "rpc" ? "RPC dialogs" : "print defaults"}`, async () => {
      const fixture = createPi(false);
      fixture.ctx.mode = mode;
      fixture.ctx.hasUI = mode === "rpc";
      piWorkflows(fixture.pi as never);
      await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
      const result = await workflowTool(fixture).execute(
        "checkpoint",
        {
          script:
            'export const meta = { name: "dialog", description: "test" }; return await checkpoint("proceed?", { default: "fallback" });',
          background: false,
        },
        undefined,
        undefined,
        fixture.ctx,
      );
      expect(result.details.status).toBe("completed");
      expect(result.details.result).toContain(mode === "rpc" ? "true" : "fallback");
      expect(fixture.ctx.ui.confirm).toHaveBeenCalledTimes(mode === "rpc" ? 1 : 0);
      expect(fixture.widgetUpdates).toEqual([]);
      await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
    });
  }

  it("replays checkpoint answers from the executing context's real branch", async () => {
    const fixture = createPi(false);
    fixture.ctx.mode = "rpc";
    fixture.ctx.hasUI = true;
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    const tool = workflowTool(fixture);
    let releaseCheckpoint: (value: boolean) => void = () => {};
    fixture.ctx.ui.confirm.mockResolvedValueOnce(true).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseCheckpoint = resolve;
        }),
    );
    const firstPending = tool.execute(
      "first",
      {
        script:
          'export const meta = { name: "replay", description: "test" }; const answer = await checkpoint("proceed?", { default: false }); await checkpoint("wait"); return answer;',
        background: false,
      },
      undefined,
      undefined,
      fixture.ctx,
    );
    await vi.waitFor(() => expect(fixture.ctx.ui.confirm).toHaveBeenCalledTimes(2));
    const runId = (
      fixture.entries.find((entry) => (entry as { kind?: string }).kind === "run_created") as { runId: string }
    ).runId;
    const control = fixture.toolDefinitions.find(
      (tool) => (tool as { name: string }).name === "workflow_control",
    ) as WorkflowTool;
    await control.execute("pause", { action: "pause", run_id: runId }, undefined, undefined, fixture.ctx);
    const first = await firstPending;
    releaseCheckpoint(false);
    await new Promise((resolve) => setImmediate(resolve));
    // Rebind like a restored session, so replay must come from durable entries.
    await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    const getBranch = vi.fn(fixture.ctx.sessionManager.getBranch);
    const resumed = await tool.execute(
      "second",
      {
        resumeFromRunId: first.details.runId,
        script:
          'export const meta = { name: "replay", description: "test" }; const answer = await checkpoint("proceed?", { default: false }); return answer;',
        background: false,
      },
      undefined,
      undefined,
      {
        ...fixture.ctx,
        sessionManager: { getBranch },
      },
    );
    expect(getBranch).toHaveBeenCalled();
    expect(resumed.details.status).toBe("completed");
    expect(first.details.status).toBe("interrupted");
    expect(fixture.ctx.ui.confirm).toHaveBeenCalledTimes(2);
    await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
  });

  it("renders a live TUI run through ctx.ui and releases that UI on shutdown", async () => {
    const fixture = createPi(false);
    fixture.ctx.mode = "tui";
    fixture.ctx.hasUI = true;
    const controller = new AbortController();
    let resolveConfirm: ((value: boolean) => void) | undefined;
    fixture.ctx.ui.confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    const pending = workflowTool(fixture).execute(
      "live",
      {
        script: 'export const meta = { name: "live", description: "test" }; return await checkpoint("wait");',
        background: false,
      },
      controller.signal,
      undefined,
      fixture.ctx,
    );
    try {
      await vi.waitFor(() => expect(fixture.widgetUpdates.some((lines) => lines && lines.length > 0)).toBe(true));
      // The live widget is published before the VM reaches its checkpoint.
      // Wait for the actual dialog; resolving a placeholder here loses the answer.
      await vi.waitFor(() => expect(fixture.ctx.ui.confirm).toHaveBeenCalledOnce());
      if (!resolveConfirm) throw new Error("Checkpoint confirmation is not ready");
      resolveConfirm(true);
      expect((await pending).details.status).toBe("completed");
      await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
      expect(fixture.widgetUpdates.at(-1)).toBeUndefined();
      const registrations = fixture.widgetRegistrations.filter(({ content }) => typeof content === "function");
      expect(registrations.length).toBeGreaterThan(0);
      expect(
        registrations.every(({ key, options }) => key === "pi-workflows" && options?.placement === "belowEditor"),
      ).toBe(true);
      const updates = fixture.widgetUpdates.length;
      await Promise.resolve();
      expect(fixture.widgetUpdates).toHaveLength(updates);
    } finally {
      controller.abort();
      await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
      await pending;
    }
  });
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
    expect(fixture.commands).toContain("workflows");
    expect(fixture.commands).toContain("deep-research");
    expect(fixture.commands).toContain("code-review");
    expect(fixture.commands).toContain("effort");
    await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
  });

  it("preserves literal workflow markers at the final context boundary", async () => {
    const fixture = createPi(false);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);

    const handler = fixture.lifecycle.get("context");
    if (!handler) throw new Error("workflow context handler is missing");
    const duplicate = `keep this\n\n${WORKFLOW_ARMED_DIRECTIVE}\nOther plugin guidance\n\n${WORKFLOW_ARMED_DIRECTIVE}`;
    const result = (await handler(
      {
        messages: [
          { role: "user", content: duplicate },
          { role: "assistant", content: [] },
        ],
      },
      fixture.ctx,
    )) as { messages?: Array<{ content?: unknown }> } | undefined;

    expect(result).toBeUndefined(); // No transform: native input/context is opaque.
    await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
  });

  it("preserves every text part and image, including repeated exact directives", async () => {
    const fixture = createPi(false);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    const image = { type: "image", mimeType: "image/png", data: "base64-image" };
    const unrelated = "<system-reminder>Other plugin guidance</system-reminder>";
    const parts = [
      { type: "text", text: `first ${WORKFLOW_ARMED_DIRECTIVE} ${unrelated}` },
      image,
      { type: "text", text: `second ${WORKFLOW_ARMED_DIRECTIVE} ${unrelated} ${WORKFLOW_ARMED_DIRECTIVE}` },
      { type: "text", text: WORKFLOW_ARMED_DIRECTIVE },
    ];
    const older = { role: "user", content: parts };
    const result = (await fixture.lifecycle.get("context")?.(
      { messages: [older, { role: "user", content: parts }] },
      fixture.ctx,
    )) as {
      messages: Array<{ content: unknown }>;
    };
    expect(result).toBeUndefined();
    expect(parts[1]).toBe(image);
    expect(parts[2]?.text).toContain(WORKFLOW_ARMED_DIRECTIVE);
    expect(older.content).toBe(parts);
    await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
  });

  it("re-reads the host tier catalogue on every start rather than pinning the one seen at session start", async () => {
    // The catalogue lives on the peer and the user can edit it mid-session. A
    // start that replayed the activation-time snapshot would reject a tier
    // defined since then as unknown, before ever dispatching it.
    const fixture = createPi(false);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    await new Promise((resolve) => setImmediate(resolve));
    const activationPings = fixture.routing.pings;
    expect(activationPings).toBeGreaterThan(0);

    const workflow = fixture.toolDefinitions.find((tool) => (tool as { name: string }).name === "workflow") as {
      execute: (id: string, params: unknown, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<unknown>;
    };
    const script = "export const meta = { name: 'probe', description: 'no agents' }\nreturn 1";
    await workflow.execute("call-1", { script, background: false }, undefined, undefined, fixture.ctx);
    expect(fixture.routing.pings).toBe(activationPings + 1);

    // A tier the activation snapshot did not contain must be usable now.
    const extended: ManagedRoutingPolicy = {
      ...ROUTING_POLICY,
      profiles: { ...ROUTING_POLICY.profiles, added: { model: "inherit", thinking: "high" } },
    };
    fixture.routing.snapshot = { policy: extended, fingerprint: routingPolicyFingerprint(extended) };
    await workflow.execute("call-2", { script, background: false }, undefined, undefined, fixture.ctx);
    expect(fixture.routing.pings).toBe(activationPings + 2);

    await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
  });

  it("does not start a built-in workflow when protocol negotiation fails", async () => {
    const fixture = createPi(false, 0, [], false);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    const command = fixture.commandDefinitions.get("deep-research") as {
      handler: (args: string, ctx: { ui: { notify: (message: string) => void } }) => Promise<void>;
    };
    const notices: string[] = [];
    await command.handler("question", {
      ...fixture.ctx,
      ui: { notify: (message: string) => notices.push(message) },
    });

    expect(notices.join("\n")).toContain("@signalridge/pi-workflows requires");
    expect(fixture.entries.some((entry) => (entry as { kind?: string }).kind === "run_created")).toBe(false);
    await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
  });

  it("refreshes the widget for a replacement session and clears it on shutdown", async () => {
    const fixture = createPi(false);
    fixture.ctx.mode = "tui";
    fixture.ctx.hasUI = true;
    piWorkflows(fixture.pi as never);
    const sessionStart = fixture.lifecycle.get("session_start");
    const sessionShutdown = fixture.lifecycle.get("session_shutdown");
    if (!sessionStart || !sessionShutdown) throw new Error("workflow lifecycle handlers are missing");
    await sessionStart({}, fixture.ctx);
    fixture.widgetUpdates.length = 0;
    await sessionShutdown({}, fixture.ctx);
    expect(fixture.widgetUpdates).toEqual([undefined]);

    fixture.widgetUpdates.length = 0;
    await sessionStart({}, fixture.ctx);
    expect(fixture.widgetUpdates).toEqual([undefined]);
    await sessionShutdown({}, fixture.ctx);
  });

  it("does not let a built-in command retain a disposed session engine", async () => {
    const fixture = createPi(false);
    // A live managed peer acknowledges the built-in's background spawn during
    // shutdown; otherwise the mock waits for the protocol's five-second timeout.
    fixture.bus.on("subagents:rpc:spawn-managed", (raw) => {
      const { requestId } = raw as { requestId: string };
      fixture.bus.emit(`subagents:rpc:spawn-managed:reply:${requestId}`, {
        success: true,
        data: {
          id: "instant-child",
          state: "completed",
          terminal: { status: "completed", result: "{}", compactionCount: 0, completedAt: Date.now() },
        },
      });
    });
    fixture.bus.on("subagents:rpc:quiesce-owned", (raw) => {
      const { requestId } = raw as { requestId: string };
      fixture.bus.emit(`subagents:rpc:quiesce-owned:reply:${requestId}`, {
        success: true,
        data: { settled: true, pending: [] },
      });
    });
    fixture.bus.on("subagents:rpc:reconcile-managed", (raw) => {
      const { requestId } = raw as { requestId: string };
      fixture.bus.emit(`subagents:rpc:reconcile-managed:reply:${requestId}`, { success: true, data: null });
    });
    piWorkflows(fixture.pi as never);
    const sessionStart = fixture.lifecycle.get("session_start");
    const sessionShutdown = fixture.lifecycle.get("session_shutdown");
    if (!sessionStart || !sessionShutdown) throw new Error("workflow lifecycle handlers are missing");
    await sessionStart({}, fixture.ctx);
    const command = fixture.commandDefinitions.get("deep-research") as {
      handler: (args: string, ctx: { ui: { notify: (message: string) => void } }) => Promise<void>;
    };
    if (!command) throw new Error("built-in command was not registered");
    await sessionShutdown({}, fixture.ctx);

    await sessionStart({}, fixture.ctx);
    const before = fixture.entries.filter((entry) => (entry as { kind?: unknown }).kind === "run_created").length;
    const notices: string[] = [];
    await command.handler("question", {
      ...fixture.ctx,
      ui: { notify: (message: string) => notices.push(message) },
    });
    const after = fixture.entries.filter((entry) => (entry as { kind?: unknown }).kind === "run_created").length;
    expect(after).toBe(before + 1);
    expect(notices.join("\n")).toContain("started in background");

    await sessionShutdown({}, fixture.ctx);
    const shutdownNotices: string[] = [];
    await command.handler("question", {
      ...fixture.ctx,
      ui: { notify: (message: string) => shutdownNotices.push(message) },
    });
    expect(shutdownNotices.join("\n")).toContain("not active in this session context");
    expect(fixture.entries.filter((entry) => (entry as { kind?: unknown }).kind === "run_created")).toHaveLength(after);
  });

  it("does not quiesce on either a native or bus before-tree attempt", async () => {
    const fixture = createPi(false);
    const quiesce = vi.spyOn(WorkflowEngine.prototype, "quiesceForBranchChange");
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    try {
      const first = new AbortController().signal;
      const second = new AbortController().signal;
      fixture.bus.emit("subagents:session_before_tree", { signal: first });
      await fixture.lifecycle.get("session_before_tree")?.({ type: "session_before_tree", signal: first }, fixture.ctx);
      fixture.bus.emit("subagents:session_before_tree", { signal: second });
      await fixture.lifecycle.get("session_before_tree")?.(
        { type: "session_before_tree", signal: second },
        fixture.ctx,
      );
      expect(quiesce).not.toHaveBeenCalled();
    } finally {
      await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
      quiesce.mockRestore();
    }
  });

  it("vetoes a running workflow with a managed child without stopping the child", async () => {
    const fixture = createPi(false);
    fixture.ctx.hasUI = true;
    let childOwner: Record<string, string> | undefined;
    let stopCalls = 0;
    fixture.bus.on("subagents:rpc:spawn-managed", (raw) => {
      const request = raw as { requestId: string; owner: Record<string, string> };
      childOwner = request.owner;
      fixture.bus.emit(`subagents:rpc:spawn-managed:reply:${request.requestId}`, {
        success: true,
        data: { id: "managed-child", state: "running" },
      });
    });
    fixture.bus.on("subagents:rpc:stop-owned", (raw) => {
      stopCalls++;
      const request = raw as { requestId: string };
      fixture.bus.emit(`subagents:rpc:stop-owned:reply:${request.requestId}`, { success: true });
    });
    fixture.bus.on("subagents:rpc:quiesce-owned", (raw) => {
      const request = raw as { requestId: string };
      fixture.bus.emit(`subagents:rpc:quiesce-owned:reply:${request.requestId}`, {
        success: true,
        data: { settled: true, pending: [] },
      });
    });
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    const started = await workflowTool(fixture).execute(
      "managed",
      {
        script: 'export const meta = { name: "managed", description: "test" }; return await agent("work");',
        background: true,
      },
      undefined,
      undefined,
      fixture.ctx,
    );
    await vi.waitFor(() => expect(childOwner).toBeDefined());
    expect(fixture.lifecycle.get("session_before_tree")?.({}, fixture.ctx)).toEqual({ cancel: true });
    expect(fixture.lifecycle.get("session_before_switch")?.({}, fixture.ctx)).toEqual({ cancel: true });
    expect(fixture.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("stop them explicitly"), "warning");
    expect(stopCalls).toBe(0);
    fixture.bus.emit("subagents:completed", {
      id: "managed-child",
      status: "completed",
      result: "finished",
      owner: childOwner,
    });
    await vi.waitFor(() =>
      expect(
        fixture.entries.some(
          (entry) =>
            (entry as { kind?: string; status?: string }).kind === "workflow_transition" &&
            (entry as { status?: string }).status === "completed",
        ),
      ).toBe(true),
    );
    expect(started.details.runId).toBeTruthy();
    await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
  });

  it.each(["subagents-first", "workflows-first"])("does not re-fence a committed tree in %s order", async (order) => {
    const fixture = createPi(false);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    const event = { type: "session_tree", oldLeafId: "old", newLeafId: "new" };
    if (order === "subagents-first") fixture.bus.emit("subagents:session_tree_committed", { event });
    fixture.lifecycle.get("session_tree")?.(event, fixture.ctx);
    if (order === "workflows-first") fixture.bus.emit("subagents:session_tree_committed", { event });
    const result = await workflowTool(fixture).execute(
      "after-tree",
      {
        script: 'export const meta = { name: "after", description: "test" }; return 1;',
        background: false,
      },
      undefined,
      undefined,
      fixture.ctx,
    );
    expect(result.details.status).toBe("completed");
    await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
  });

  it("times out shutdown quiescence with a diagnostic instead of waiting forever", async () => {
    const fixture = createPi(false);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    const quiesce = vi
      .spyOn(WorkflowEngine.prototype, "quiesceForBranchChange")
      .mockImplementation(() => new Promise(() => {}));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const shutdown = fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
      await vi.advanceTimersByTimeAsync(6_000);
      await shutdown;
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("shutdown quiescence timed out"));
      expect(quiesce).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      warning.mockRestore();
      quiesce.mockRestore();
    }
  });

  it("quarantines a pre-schema-v4 journal instead of replaying it", async () => {
    const runId = "recovery-loader-run";
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
        data: { kind: "run_created", schemaVersion: 3, runId, definition, timestamp: 1 },
      },
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: { kind: "workflow_transition", schemaVersion: 3, runId, status: "running", timestamp: 2 },
      },
    ];
    const fixture = createPi(false, 0, branch);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    expect(fixture.tools).toEqual(["workflow", "workflow_control"]);
    // No recovery event is appended for the pre-schema-v4 run — it is quarantined, not replayed.
    expect(fixture.entries.some((entry) => (entry as { kind?: string }).kind === "run_recovery")).toBe(false);
    await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
  });
});
