import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  APPROVAL_ADAPTER_QUERY_CHANNEL,
  APPROVAL_QUERY_CHANNEL,
  type ApprovalOperation,
  type ApprovalRequestOptions,
  type ApprovalService,
  hashBytes,
  queryApprovalAdapter,
  validateQuery,
} from "@signalridge/pi-approval-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { JobManager, JobSnapshot, StartOptions } from "../src/contracts.js";
import { Ownership } from "../src/ownership.js";
import { registerTools } from "../src/tools.js";

function fixture() {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const events = {
    on: (name: string, handler: (value: unknown) => void) => {
      const group = listeners.get(name) ?? new Set();
      listeners.set(name, group);
      group.add(handler);
      return () => {
        group.delete(handler);
      };
    },
    emit: (name: string, value: unknown) => {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(value);
    },
  };
  type Handler = (event: never, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  let branch = ["root"];
  let retired = false;
  const context = {
    cwd: process.cwd(),
    mode: "json",
    hasUI: false,
    sessionManager: {
      getSessionId: () => "session",
      getBranch: () => branch.map((id) => ({ id })),
    },
  } as unknown as ExtensionContext;
  const owner = new Ownership(context, () => {
    retired = true;
  });
  const jobs: JobSnapshot[] = [];
  const job = (options: StartOptions): JobSnapshot => ({
    id: "job-1",
    ...options,
    description: options.description ?? options.command.slice(0, 200),
    status: "running",
    startedAt: 1,
    attention: options.attention ?? "turn",
    droppedBytes: 0,
  });
  const manager: JobManager = {
    start: vi.fn(async (options: StartOptions) => {
      const started = job(options);
      jobs.push(started);
      return started;
    }),
    list: () => [...jobs],
    get: (id) => {
      const found = jobs.find((entry) => entry.id === id);
      if (!found) throw new Error("Unknown job");
      return found;
    },
    watch: vi.fn((id, options) => ({ ...manager.get(id), watch: options })),
    logs: () => ({ text: "", droppedBytes: 0 }),
    subscribe: () => () => {},
    stop: async (id) => manager.get(id),
    clear: () => 0,
    shutdown: async () => {},
  };
  const runtime = {
    manager: () =>
      owner.guard(manager, () => {
        if (retired || !owner.live(context)) throw new Error("Stale background owner");
      }),
    pending: () => ({ pendingNotifications: 0, deliveryPaused: false }),
    cancel: vi.fn(),
  };
  const pi = {
    events,
    registerTool: (tool: ToolDefinition) => {
      tools.set(tool.name, tool);
    },
    getAllTools: () => [...tools.values()],
    on: (name: string, handler: Handler) => {
      const group = handlers.get(name) ?? [];
      handlers.set(name, group);
      group.push(handler);
    },
  } as unknown as ExtensionAPI;
  registerTools(pi, runtime);
  const emit = async (name: string) => {
    for (const handler of handlers.get(name) ?? []) await handler({} as never, context);
  };
  const execute = (name: string, parameters: unknown, signal?: AbortSignal) => {
    const tool = tools.get(name);
    if (!tool) throw new Error("Missing tool");
    return tool.execute(
      "provider|opaque-调用",
      parameters as never,
      signal,
      undefined,
      context as ExtensionToolContext,
    );
  };
  return {
    events,
    tools,
    manager,
    runtime,
    execute,
    emit,
    diverge: () => {
      branch = ["different-root"];
    },
    retire: () => {
      retired = true;
    },
  };
}

function peer(events: ReturnType<typeof fixture>["events"]) {
  let approve!: () => void;
  let deny!: (error: Error) => void;
  let operation!: ApprovalOperation;
  let options!: ApprovalRequestOptions;
  const request = vi.fn((op: ApprovalOperation, owner: ApprovalRequestOptions) => {
    operation = op;
    options = owner;
    return new Promise<void>((resolve, reject) => {
      approve = resolve;
      deny = reject;
    });
  });
  const service: ApprovalService = { version: 1, id: "root-peer", request };
  const unsubscribe = events.on(APPROVAL_QUERY_CHANNEL, (value) => validateQuery(value).respond(service));
  return {
    request,
    unsubscribe,
    approve: () => approve(),
    deny: (message: string) => deny(new Error(message)),
    operation: () => operation,
    options: () => options,
  };
}

async function denied(pending: Promise<unknown>, deny: () => void, f: ReturnType<typeof fixture>) {
  const result = expect(pending).rejects.toThrow();
  deny();
  await result;
  expect(f.manager.start).not.toHaveBeenCalled();
  expect(f.manager.watch).not.toHaveBeenCalled();
  expect(f.runtime.cancel).not.toHaveBeenCalled();
}

describe("background execution approval adapter", () => {
  it("keeps original schema identities distinct across extension instances", () => {
    const first = fixture();
    const second = fixture();
    for (const name of ["bash_background", "monitor"]) {
      expect(first.tools.get(name)?.parameters).not.toBe(second.tools.get(name)?.parameters);
    }
  });

  it("captures before yielding, freezes actual normalized final inputs and preserves opaque caller IDs", async () => {
    const f = fixture();
    const root = peer(f.events);
    const parameters = {
      command: "printf 'final\\n'",
      cwd: "relative",
      timeout_ms: 3210,
      notify: "off",
      description: "final\u202e",
    };
    const running = f.execute("bash_background", parameters);
    expect(root.request).toHaveBeenCalledOnce();
    expect(f.manager.start).not.toHaveBeenCalled();
    parameters.command = "unapproved";
    parameters.cwd = "/unapproved";
    parameters.timeout_ms = 1;
    root.approve();
    await running;
    const actual = vi.mocked(f.manager.start).mock.calls[0][0];
    expect(actual).toEqual({
      command: "printf 'final\\n'",
      cwd: resolve(process.cwd(), "relative"),
      timeoutMs: 3210,
      attention: "off",
      description: "final\u202e",
    });
    const op = root.operation();
    expect(op).toMatchObject({
      kind: "command",
      source: "background",
      toolName: "bash_background",
      toolCallId: "provider|opaque-调用",
      command: actual.command,
      cwd: actual.cwd,
    });
    expect(op.inputHash).toBe(hashBytes(JSON.stringify(actual)));
    expect(op.preview).toContain("\\u{202e}");
    expect(Object.isFrozen(op)).toBe(true);
    expect(Object.isFrozen(actual)).toBe(true);
  });

  it("approves the effective command monitor watch, deduplicates literals and freezes nested arrays", async () => {
    const f = fixture();
    const root = peer(f.events);
    const parameters = { command: "printf ready", patterns: ["ready", "ready"], notify: "context" };
    const running = f.execute("monitor", parameters);
    parameters.patterns.push("unapproved");
    root.approve();
    await running;
    const actual = vi.mocked(f.manager.start).mock.calls[0][0];
    expect(actual).toMatchObject({
      timeoutMs: undefined,
      description: "printf ready",
      attention: "context",
      watch: { patterns: ["ready"], stream: "both", repeat: false, cooldownMs: 10000, attention: "context" },
    });
    expect(Object.isFrozen(actual.watch)).toBe(true);
    expect(Object.isFrozen(actual.watch?.patterns)).toBe(true);
    expect(root.operation().inputHash).toBe(hashBytes(JSON.stringify({ ...actual, timeoutMs: null })));
    expect(root.operation().preview).toContain('"timeoutMs":null');
    expect(root.operation().preview).toContain('"patterns":["ready"]');
  });

  it.each(["decline", "timeout"])("never launches on %s", async (reason) => {
    const f = fixture();
    const root = peer(f.events);
    await denied(f.execute("bash_background", { command: "printf forbidden" }), () => root.deny(reason), f);
  });

  it.each(["abort", "branch", "retire", "replace", "remove"])("rejects a stale approval after %s", async (change) => {
    const f = fixture();
    const root = peer(f.events);
    const controller = new AbortController();
    const running = f.execute("monitor", { command: "printf forbidden", patterns: ["forbidden"] }, controller.signal);
    await denied(
      running,
      () => {
        if (change === "abort") controller.abort();
        if (change === "branch") f.diverge();
        if (change === "retire") f.retire();
        if (change === "replace" || change === "remove") root.unsubscribe();
        if (change === "replace") peer(f.events);
        root.approve();
      },
      f,
    );
  });

  it("checks ownership and cancellation before discovering a peer", async () => {
    const f = fixture();
    const root = peer(f.events);
    f.diverge();
    await expect(f.execute("bash_background", { command: "printf forbidden" })).rejects.toThrow();
    expect(root.request).not.toHaveBeenCalled();
    expect(f.manager.start).not.toHaveBeenCalled();
    const fresh = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      fresh.execute("bash_background", { command: "printf forbidden" }, controller.signal),
    ).rejects.toThrow();
    expect(fresh.manager.start).not.toHaveBeenCalled();
  });

  it.each([
    ["bash_background", { command: "printf forbidden", timeout_ms: 1.5 }],
    ["bash_background", { command: 42 }],
    ["monitor", { command: "printf forbidden", id: "job-1", patterns: ["x"] }],
    ["monitor", { patterns: ["x"] }],
    ["monitor", { id: "job-1", cwd: "/", patterns: ["x"] }],
    ["monitor", { command: "printf forbidden", patterns: [] }],
    ["monitor", { command: "printf forbidden", patterns: ["x"], cooldown_ms: 1.5 }],
  ])("revalidates final %s arguments before requesting approval", async (name, input) => {
    const f = fixture();
    const root = peer(f.events);
    await expect(f.execute(name, input)).rejects.toThrow();
    expect(root.request).not.toHaveBeenCalled();
    expect(f.manager.start).not.toHaveBeenCalled();
  });

  it("absence preserves defaults and existing-ID monitor attachment never asks launch approval", async () => {
    const f = fixture();
    await f.execute("bash_background", { command: "printf ready" });
    expect(vi.mocked(f.manager.start).mock.calls[0][0]).toMatchObject({ timeoutMs: 1800000, attention: "turn" });
    const root = peer(f.events);
    await f.execute("monitor", { id: "job-1", patterns: ["ready"] });
    expect(root.request).not.toHaveBeenCalled();
    expect(f.manager.start).toHaveBeenCalledOnce();
    expect(f.manager.watch).toHaveBeenCalledOnce();
    expect(f.runtime.cancel).toHaveBeenCalledWith("job-1");
  });

  it("existing monitors respect cancellation without gating inspection or control tools", async () => {
    const f = fixture();
    await f.execute("bash_background", { command: "printf ready" });
    const root = peer(f.events);
    const controller = new AbortController();
    controller.abort();
    await expect(f.execute("monitor", { id: "job-1", patterns: ["ready"] }, controller.signal)).rejects.toThrow();
    expect(f.manager.watch).not.toHaveBeenCalled();
    expect(f.runtime.cancel).not.toHaveBeenCalled();
    await f.execute("background_list", {});
    await f.execute("background_logs", { id: "job-1" });
    await f.execute("background_stop", { id: "job-1" });
    await f.execute("background_clear", {});
    expect(root.request).not.toHaveBeenCalled();
    expect(f.manager.start).toHaveBeenCalledOnce();
  });

  it.each(["malformed", "duplicate"])("fails closed on a %s peer", async (kind) => {
    const f = fixture();
    peer(f.events);
    if (kind === "duplicate") peer(f.events);
    else f.events.on(APPROVAL_QUERY_CHANNEL, (value) => validateQuery(value).respond({ version: 1 }));
    await expect(f.execute("bash_background", { command: "printf forbidden" })).rejects.toThrow();
    expect(f.manager.start).not.toHaveBeenCalled();
  });

  it("advertises only a live own effective schema, including headless sessions, and cleans up subscriptions", async () => {
    const f = fixture();
    const parameters = f.tools.get("bash_background")?.parameters;
    if (!parameters) throw new Error("Missing schema");
    expect(() => queryApprovalAdapter(f.events, "bash_background", parameters)).toThrow();
    await f.emit("session_start");
    expect(queryApprovalAdapter(f.events, "bash_background", parameters).parameters).toBe(parameters);
    const responses = vi.fn();
    f.events.emit(APPROVAL_ADAPTER_QUERY_CHANNEL, { version: 1, toolName: "background_list", respond: responses });
    f.events.emit(APPROVAL_ADAPTER_QUERY_CHANNEL, { version: 2, toolName: "monitor", respond: responses });
    expect(responses).not.toHaveBeenCalled();
    const own = f.tools.get("bash_background");
    if (!own) throw new Error("Missing tool");
    f.tools.set("bash_background", { ...own, parameters: Type.Object({ command: Type.String() }) });
    expect(() => queryApprovalAdapter(f.events, "bash_background", parameters)).toThrow();
    f.tools.set("bash_background", own);
    await f.emit("session_shutdown");
    expect(() => queryApprovalAdapter(f.events, "bash_background", parameters)).toThrow();
    await f.emit("session_start");
    expect(queryApprovalAdapter(f.events, "bash_background", parameters).parameters).toBe(parameters);
    f.diverge();
    expect(() => queryApprovalAdapter(f.events, "bash_background", parameters)).toThrow();
  });
});
