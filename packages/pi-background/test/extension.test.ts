import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobEvent, JobManager, JobSnapshot, StartOptions } from "../src/contracts.js";
import extension from "../src/extension.js";
import { MESSAGE_TYPE } from "../src/notifications.js";
import { nativeUIFixture } from "./tui-fixture.js";

const fake = vi.hoisted(() => ({
  managers: [] as Array<{
    manager: JobManager;
    emit: (event: JobEvent) => void;
    changes: () => void;
    listeners: Set<() => void>;
  }>,
}));
vi.mock("../src/manager.js", () => ({
  createJobManager: (emit: (event: JobEvent) => void): JobManager => {
    const jobs: JobSnapshot[] = [];
    const listeners = new Set<() => void>();
    const changes = () => {
      for (const listener of [...listeners]) listener();
    };
    const manager: JobManager = {
      subscribe: vi.fn((listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }),
      start: vi.fn(async (options: StartOptions) => {
        const job: JobSnapshot = {
          id: `job-${jobs.length}`,
          command: options.command,
          cwd: options.cwd,
          description: options.description ?? "job",
          status: "running",
          startedAt: 1,
          attention: options.attention ?? "turn",
          droppedBytes: 0,
        };
        jobs.push(job);
        changes();
        return job;
      }),
      watch: vi.fn((id, watch) => {
        const job = manager.get(id);
        job.watch = watch;
        return job;
      }),
      list: vi.fn(() => jobs),
      get: (id) => {
        const job = jobs.find((entry) => entry.id === id);
        if (!job) throw new Error("unknown job");
        return job;
      },
      logs: () => ({ text: "hello", droppedBytes: 0 }),
      stop: vi.fn(async (id) => {
        const job = manager.get(id);
        job.status = "stopped";
        job.endedAt = 2;
        changes();
        return job;
      }),
      clear: vi.fn((id) => {
        const index = jobs.findIndex((job) => job.id === id && job.endedAt !== undefined);
        if (index < 0) throw new Error("Cannot clear a running job");
        jobs.splice(index, 1);
        changes();
        return 1;
      }),
      shutdown: vi.fn(async () => {
        jobs.length = 0;
      }),
    };
    fake.managers.push({ manager, emit, changes, listeners });
    return manager;
  },
}));

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
interface Tool {
  name: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  outputSchema?: unknown;
  execute(
    id: string,
    input: unknown,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: ExtensionContext,
  ): Promise<{
    details: { jobs: JobSnapshot[]; pendingNotifications: number };
    structuredContent?: unknown;
  }>;
}

function harness(mode = "tui") {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
  const shortcuts = new Map<string, { description: string; handler(ctx: ExtensionContext): Promise<void> }>();
  let idle = true;
  let pending = false;
  let sessionId = "session-a";
  let acceptWake = true;
  let branch: string[] = ["root"];
  let waitForIdle: () => Promise<void> = async () => {};
  let onMessage: () => void = () => {};
  const userMessages: string[] = [];
  const status = vi.fn();
  const notify = vi.fn();
  const custom = vi.fn();
  const messages: Array<{
    customType: string;
    content: string;
    details: { wakeId: string };
    options: { triggerTurn: boolean };
  }> = [];
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: process.cwd(),
    model: {},
    ui: { setStatus: status, notify, custom },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [
        ...branch.map((id) => ({ id, type: "custom" })),
        ...messages.map((message, index) => ({
          id: `message-${index}`,
          type: "custom_message",
          customType: message.customType,
          details: message.details,
        })),
      ],
    },
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    waitForIdle: () => waitForIdle(),
  } as unknown as ExtensionContext;
  const pi = {
    getAllTools: () => [],
    getCommands: () => [],
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) =>
      commands.set(name, command),
    registerShortcut: (key: string, shortcut: { description: string; handler(ctx: ExtensionContext): Promise<void> }) =>
      shortcuts.set(key, shortcut),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    sendUserMessage: (text: string) => {
      userMessages.push(text);
      if (acceptWake) handlers.get("message_end")?.({ message: { role: "user", content: text } }, ctx);
    },
    sendMessage: (
      message: { customType: string; content: string; details: { wakeId: string } },
      options: { triggerTurn: boolean },
    ) => {
      messages.push({ ...message, options });
      onMessage();
      // Prompt delivery reaches extension message_end; idle context appends do not.
      if (options.triggerTurn) handlers.get("message_end")?.({ message: { ...message, role: "custom" } }, ctx);
    },
  } as unknown as ExtensionAPI;
  extension(pi);
  return {
    pi,
    ctx,
    tools,
    commands,
    shortcuts,
    messages,
    userMessages,
    setBranch: (ids: string[]) => {
      branch = ids;
    },
    setWaitForIdle: (wait: () => Promise<void>) => {
      waitForIdle = wait;
    },
    setOnMessage: (callback: () => void) => {
      onMessage = callback;
    },
    setAcceptWake: (value: boolean) => {
      acceptWake = value;
    },
    status,
    notify,
    custom,
    emit: async (name: string, data: Record<string, unknown> = {}) => handlers.get(name)?.(data, ctx),
    setIdle: (value: boolean) => {
      idle = value;
    },
    setPending: (value: boolean) => {
      pending = value;
    },
    setSession: (value: string) => {
      sessionId = value;
    },
  };
}

function event(jobId = "job-0"): JobEvent {
  return { jobId, description: "job", kind: "exit", attention: "turn", text: "exited 0" };
}

afterEach(() => {
  fake.managers.length = 0;
  vi.useRealTimers();
});

describe("extension lifecycle", () => {
  it("registers tools without starting resources in the factory", () => {
    const h = harness();
    expect(fake.managers).toHaveLength(0);
    expect([...h.tools.keys()]).toEqual([
      "bash_background",
      "monitor",
      "background_list",
      "background_logs",
      "background_stop",
      "background_clear",
    ]);
    expect(h.tools.get("bash_background")?.annotations.readOnlyHint).toBe(false);
    expect(h.tools.get("background_logs")?.annotations.readOnlyHint).toBe(true);
    expect([...h.tools.values()].every((tool) => tool.outputSchema)).toBe(true);
  });

  it("coalesces notifications until fully settled and queues are drained", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.emit("session_start");
    await h.emit("agent_start");
    h.setIdle(false);
    fake.managers[0].emit(event());
    vi.advanceTimersByTime(2000);
    expect(h.messages).toHaveLength(0);
    h.setIdle(true);
    h.setPending(true);
    await h.emit("agent_settled");
    vi.advanceTimersByTime(0);
    expect(h.messages).toHaveLength(0);
    h.setPending(false);
    await h.emit("agent_settled");
    vi.advanceTimersByTime(0);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0].customType).toBe(MESSAGE_TYPE);
    await h.emit("agent_settled");
    expect(h.messages).toHaveLength(1);
    await h.emit("session_shutdown");
  });

  it("does not race pre-prompt or manual compaction", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.emit("session_start");
    await h.emit("input");
    await h.emit("session_before_compact");
    fake.managers[0].emit(event());
    vi.advanceTimersByTime(2000);
    await h.emit("session_compact");
    vi.advanceTimersByTime(2000);
    expect(h.messages).toHaveLength(0);
    await h.emit("agent_start");
    await h.emit("agent_settled");
    vi.advanceTimersByTime(0);
    expect(h.messages).toHaveLength(1);
    await h.emit("session_shutdown");
  });

  it("kills jobs and drops stale callbacks across tree navigation or reload", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.emit("session_start");
    const old = fake.managers[0];
    old.emit(event());
    await h.emit("session_tree");
    expect(old.manager.shutdown).toHaveBeenCalledTimes(1);
    old.emit(event());
    vi.advanceTimersByTime(2000);
    expect(h.messages).toHaveLength(0);
    await h.emit("session_shutdown");
    await h.emit("session_start");
    const listed = await h.tools.get("background_list")?.execute("call", {}, undefined, undefined, h.ctx);
    expect(listed?.details.jobs).toEqual([]);
    await h.emit("session_shutdown");
  });

  it("does not hand off a settled wake before a later navigation handler", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.emit("session_start");
    h.setIdle(false);
    fake.managers[0].emit(event());
    vi.advanceTimersByTime(2000);
    h.setIdle(true);
    await h.emit("agent_settled");
    expect(h.messages).toHaveLength(0);
    await h.emit("session_before_tree");
    await h.emit("session_tree");
    vi.advanceTimersByTime(2000);
    expect(h.messages).toHaveLength(0);
    await h.emit("session_shutdown");
  });

  it("acknowledges persisted idle context events without message_end", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.emit("session_start");
    for (let index = 0; index < 2; index++) {
      fake.managers[0].emit({ ...event(`job-${index}`), attention: "context" });
      vi.advanceTimersByTime(2000);
    }
    expect(h.messages).toHaveLength(2);
    expect(h.messages.every((message) => !message.options.triggerTurn)).toBe(true);
    const result = await h.tools.get("background_list")?.execute("call", {}, undefined, undefined, h.ctx);
    expect(result?.details.pendingNotifications).toBe(0);
    await h.emit("session_shutdown");
  });

  it("keeps persisted events pending until the exact user wake is acknowledged", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.setAcceptWake(false);
    await h.emit("session_start");
    fake.managers[0].emit(event());
    vi.advanceTimersByTime(2000);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0].options.triggerTurn).toBe(false);
    expect(h.userMessages).toHaveLength(1);
    await h.emit("message_end", {
      message: { role: "user", content: "Background process wake [unrelated]\nignored" },
    });
    const list = () => h.tools.get("background_list")?.execute("call", {}, undefined, undefined, h.ctx);
    expect((await list())?.details.pendingNotifications).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect((await list())?.details).toMatchObject({ pendingNotifications: 1, deliveryPaused: true });
    expect(h.userMessages).toHaveLength(1);
    await h.emit("message_end", { message: { role: "user", content: h.userMessages[0] } });
    expect((await list())?.details).toMatchObject({ pendingNotifications: 0, deliveryPaused: false });
    await h.emit("session_shutdown");
  });

  it("consumes a host-queued wake after its branch owner retires, not real user input", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.setAcceptWake(false);
    await h.emit("session_start");
    fake.managers[0].emit(event());
    vi.advanceTimersByTime(2000);
    const text = h.userMessages[0];
    expect(await h.emit("input", { text, source: "extension" })).toBeUndefined();
    await h.emit("session_tree");
    expect(await h.emit("input", { text, source: "extension" })).toEqual({ action: "handled" });
    expect(await h.emit("input", { text, source: "interactive" })).toBeUndefined();
    expect(
      await h.emit("input", { text: "Background process wake [foreign]\\nkeep", source: "extension" }),
    ).toBeUndefined();
    await h.emit("session_shutdown");
    expect(await h.emit("input", { text, source: "extension" })).toEqual({ action: "handled" });
  });

  it("preserves appends but retires monotonically on live divergence before tree callbacks", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.emit("session_start");
    const old = fake.managers[0];
    const tool = h.tools.get("background_list");
    h.setBranch(["root", "append"]);
    await expect(tool?.execute("call", {}, undefined, undefined, h.ctx)).resolves.toBeDefined();
    h.setAcceptWake(false);
    old.emit(event());
    vi.advanceTimersByTime(2000);
    const wake = h.userMessages[0];
    h.setBranch(["root", "different"]);
    h.status.mockClear();
    expect(await h.emit("input", { text: wake, source: "extension" })).toEqual({ action: "handled" });
    expect(old.manager.shutdown).toHaveBeenCalledOnce();
    vi.mocked(old.manager.list).mockClear();
    old.emit(event());
    await h.emit("message_end", { message: { role: "user", content: wake } });
    await h.emit("agent_settled");
    h.setBranch(["root", "append"]); // Returning cannot resurrect the old owner.
    await expect(tool?.execute("call", {}, undefined, undefined, h.ctx)).rejects.toThrow("No active");
    expect(old.manager.list).not.toHaveBeenCalled();
    expect(h.status).not.toHaveBeenCalled();
    await h.emit("session_shutdown");
  });

  it("rechecks delivery and UI ownership after a synchronous transcript listener navigates", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.emit("session_start");
    h.setOnMessage(() => {
      h.setBranch(["new-root"]);
      h.status.mockClear();
    });
    fake.managers[0].emit(event());
    vi.advanceTimersByTime(2000);
    expect(h.messages).toHaveLength(1); // Already persisted messages cannot be retracted.
    expect(h.userMessages).toHaveLength(0);
    expect(h.status).not.toHaveBeenCalled();
    expect(fake.managers[0].manager.shutdown).toHaveBeenCalledOnce();
    await h.emit("session_shutdown");
  });

  it("captures the session manager object, not only its ID and branch IDs", async () => {
    const h = harness();
    await h.emit("session_start");
    Object.defineProperty(h.ctx, "sessionManager", { value: { ...h.ctx.sessionManager } });
    await expect(h.tools.get("background_list")?.execute("call", {}, undefined, undefined, h.ctx)).rejects.toThrow(
      "No active",
    );
    expect(fake.managers[0].manager.shutdown).toHaveBeenCalledOnce();
    await h.emit("session_shutdown");
  });

  it("rejects async tool results and retry updates after their captured owner diverges", async () => {
    const h = harness();
    await h.emit("session_start");
    const old = fake.managers[0];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job: JobSnapshot = {
      id: "late",
      command: "true",
      cwd: process.cwd(),
      description: "late",
      status: "running",
      startedAt: 1,
      attention: "off",
      droppedBytes: 0,
    };
    vi.mocked(old.manager.start).mockImplementationOnce(async () => {
      await gate;
      return job;
    });
    h.setWaitForIdle(() => gate);
    const tool = h.tools.get("bash_background")?.execute("call", { command: "true" }, undefined, undefined, h.ctx);
    const retry = h.commands.get("background")?.handler("retry", h.ctx);
    h.setBranch(["other"]);
    h.status.mockClear();
    release();
    await expect(tool).rejects.toThrow("No active");
    await expect(retry).rejects.toThrow("No active");
    expect(h.status).not.toHaveBeenCalled();
    await h.emit("session_shutdown");
  });

  it("does not reopen an older intent after awaiting cleanup", async () => {
    const h = harness();
    await h.emit("session_start");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(fake.managers[0].manager.shutdown).mockImplementationOnce(() => gate);
    const opening = h.emit("session_tree");
    const closing = h.emit("session_shutdown");
    release();
    await Promise.all([opening, closing]);
    expect(fake.managers).toHaveLength(1);
    await expect(h.tools.get("background_list")?.execute("call", {}, undefined, undefined, h.ctx)).rejects.toThrow(
      "No active",
    );
    await h.emit("session_start");
    expect(fake.managers).toHaveLength(2);
    await h.emit("session_shutdown");
  });

  it("keeps only the latest opening intent and rejects divergence during its cleanup await", async () => {
    const h = harness();
    await h.emit("session_start");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(fake.managers[0].manager.shutdown).mockImplementationOnce(() => gate);
    const older = h.emit("session_tree");
    h.setBranch(["new-root"]);
    const newer = h.emit("session_tree");
    release();
    await Promise.all([older, newer]);
    expect(fake.managers).toHaveLength(2);
    await expect(
      h.tools.get("background_list")?.execute("call", {}, undefined, undefined, h.ctx),
    ).resolves.toBeDefined();
    let releaseAgain!: () => void;
    const gateAgain = new Promise<void>((resolve) => {
      releaseAgain = resolve;
    });
    vi.mocked(fake.managers[1].manager.shutdown).mockImplementationOnce(() => gateAgain);
    const opening = h.emit("session_tree");
    h.setBranch(["diverged-during-await"]);
    releaseAgain();
    await opening;
    expect(fake.managers).toHaveLength(2);
    await expect(h.tools.get("background_list")?.execute("call", {}, undefined, undefined, h.ctx)).rejects.toThrow(
      "No active",
    );
    await h.emit("session_shutdown");
  });

  it("gates cancelled fork preflight without dropping jobs or the outbox; retry resumes once", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.emit("session_start");
    await h.tools.get("bash_background")?.execute("call", { command: "true" }, undefined, undefined, h.ctx);
    await h.emit("session_before_fork");
    fake.managers[0].emit(event());
    vi.advanceTimersByTime(2000);
    expect(h.messages).toHaveLength(0);
    expect(fake.managers[0].manager.shutdown).not.toHaveBeenCalled();
    const before = await h.tools.get("background_list")?.execute("call", {}, undefined, undefined, h.ctx);
    expect(before?.details).toMatchObject({
      jobs: [expect.objectContaining({ id: "job-0" })],
      pendingNotifications: 1,
    });
    await h.commands.get("background")?.handler("retry", h.ctx);
    expect(h.userMessages).toHaveLength(1);
    await h.commands.get("background")?.handler("retry", h.ctx);
    expect(h.userMessages).toHaveLength(1);
    await h.emit("session_shutdown");
  });

  it("opens only explicit commands, cancels owned notices and releases UI subscriptions", async () => {
    const native = nativeUIFixture();
    const h = harness();
    Object.defineProperty(h.ctx, "ui", { value: native.ui });
    try {
      await h.emit("session_start");
      await h.tools.get("bash_background")?.execute("call", { command: "sleep 1" }, undefined, undefined, h.ctx);
      h.setIdle(false);
      fake.managers[0].emit(event());
      expect(native.custom).not.toHaveBeenCalled();
      await h.commands.get("background")?.handler("status", h.ctx);
      expect(native.custom).not.toHaveBeenCalled();
      const opening = h.commands.get("background")?.handler("", h.ctx);
      await vi.waitFor(() => expect(native.component()).toBeDefined());
      expect(fake.managers[0].listeners.size).toBe(1);
      native.key("x");
      native.key("y");
      await vi.waitFor(() => expect(fake.managers[0].manager.stop).toHaveBeenCalledWith("job-0"));
      const list = await h.tools.get("background_list")?.execute("inspect", {}, undefined, undefined, h.ctx);
      expect(list?.details.pendingNotifications).toBe(0);
      native.key("\x1b");
      await opening;
      expect(fake.managers[0].listeners.size).toBe(0);
    } finally {
      await h.emit("session_shutdown");
      native.dispose();
    }
  });

  it("refreshes status after an idle UI stop without a later tool or lifecycle event", async () => {
    const native = nativeUIFixture();
    const h = harness();
    Object.defineProperty(h.ctx, "ui", { value: native.ui });
    try {
      await h.emit("session_start");
      await h.tools.get("bash_background")?.execute("call", { command: "sleep 1" }, undefined, undefined, h.ctx);
      expect(native.ui.setStatus).toHaveBeenLastCalledWith("pi-background", "Ctrl+Alt+B tasks · R1 F0");
      const opening = h.commands.get("background")?.handler("", h.ctx);
      await vi.waitFor(() => expect(native.component()).toBeDefined());
      native.key("x");
      native.key("y");
      await vi.waitFor(() => expect(fake.managers[0].manager.get("job-0").endedAt).toBeDefined());
      await vi.waitFor(() =>
        expect(native.ui.setStatus).toHaveBeenLastCalledWith("pi-background", "Ctrl+Alt+B tasks · R0 F1"),
      );
      native.key("\x1b");
      await opening;
      expect(native.ui.setStatus).toHaveBeenLastCalledWith("pi-background", "Ctrl+Alt+B tasks · R0 F1");
    } finally {
      await h.emit("session_shutdown");
      native.dispose();
    }
  });

  it("retires an old same-ID view before late IO and prevents wrong-branch controls before tree callbacks", async () => {
    const native = nativeUIFixture();
    const h = harness();
    Object.defineProperty(h.ctx, "ui", { value: native.ui });
    try {
      await h.emit("session_start");
      await h.tools.get("bash_background")?.execute("call", { command: "sleep 1" }, undefined, undefined, h.ctx);
      const opening = h.commands.get("background")?.handler("view job-0", h.ctx);
      await vi.waitFor(() => expect(native.component()).toBeDefined());
      const old = fake.managers[0];
      const oldView = native.component();
      const late = [...old.listeners][0];
      h.setBranch(["diverged"]);
      late();
      await opening;
      expect(native.component()).toBeUndefined();
      expect(old.manager.shutdown).toHaveBeenCalledOnce();
      expect(old.listeners.size).toBe(0);
      await h.emit("session_tree");
      await h.tools.get("bash_background")?.execute("call", { command: "sleep 1" }, undefined, undefined, h.ctx);
      const newer = h.commands.get("background")?.handler("view job-0", h.ctx);
      await vi.waitFor(() => expect(native.component()).toBeDefined());
      oldView?.handleInput?.("x");
      oldView?.handleInput?.("y");
      late();
      expect(old.manager.stop).not.toHaveBeenCalled();
      expect(fake.managers[1].manager.stop).not.toHaveBeenCalled();
      native.key("\x1b");
      native.key("\x1b");
      await newer;
    } finally {
      await h.emit("session_shutdown");
      native.dispose();
    }
  });

  it("opens an empty selector from the shortcut and ignores repeated entry during construction or viewing", async () => {
    const native = nativeUIFixture();
    const h = harness();
    Object.defineProperty(h.ctx, "ui", { value: native.ui });
    const shortcut = h.shortcuts.get("ctrl+alt+b");
    expect(shortcut?.description).toBe("Open background task selector");
    try {
      await shortcut?.handler(h.ctx); // No session owner yet.
      expect(native.custom).not.toHaveBeenCalled();
      await h.emit("session_start");
      expect(native.ui.setStatus).toHaveBeenLastCalledWith("pi-background", undefined);
      h.setWaitForIdle(() => {
        throw new Error("Navigation must not wait for idle");
      });
      h.setIdle(false); // Opening is still safe during independent agent work.
      const opening = shortcut?.handler(h.ctx);
      await shortcut?.handler(h.ctx); // Deferred import not mounted yet.
      await vi.waitFor(() => expect(native.component()).toBeDefined());
      const view = native.component();
      expect(native.render().join("\n")).toContain("No background jobs");
      await shortcut?.handler(h.ctx);
      expect(native.component()).toBe(view);
      expect(native.custom).toHaveBeenCalledOnce();
      expect(fake.managers[0].manager.start).not.toHaveBeenCalled();
      expect(h.messages).toEqual([]);
      expect(h.userMessages).toEqual([]);
      native.key("\x1b");
      await opening;
      expect(fake.managers[0].listeners.size).toBe(0);
      // Both entrypoints keep the same owned stop/cancel/status/retirement path.
      await h.tools.get("bash_background")?.execute("start", { command: "sleep 1" }, undefined, undefined, h.ctx);
      fake.managers[0].emit(event());
      const second = shortcut?.handler(h.ctx);
      await vi.waitFor(() => expect(native.component()).toBeDefined());
      native.key("x");
      native.key("y");
      await vi.waitFor(() => expect(fake.managers[0].manager.get("job-0").endedAt).toBeDefined());
      await vi.waitFor(() =>
        expect(native.ui.setStatus).toHaveBeenLastCalledWith("pi-background", "Ctrl+Alt+B tasks · R0 F1"),
      );
      expect(
        (await h.tools.get("background_list")?.execute("list", {}, undefined, undefined, h.ctx))?.details
          .pendingNotifications,
      ).toBe(0);
      await h.emit("session_tree");
      await second;
      expect(native.component()).toBeUndefined();
      expect(fake.managers[0].listeners.size).toBe(0);
      h.setBranch(["diverged"]);
      await shortcut?.handler(h.ctx);
      expect(native.custom).toHaveBeenCalledTimes(2);
    } finally {
      await h.emit("session_shutdown");
      native.dispose();
    }
  });

  it("shows a bounded plain keyboard hint for pending-only status, but keeps the empty owner quiet", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.emit("session_start");
    expect(h.status).toHaveBeenLastCalledWith("pi-background", undefined);
    h.setIdle(false);
    fake.managers[0].emit({ ...event(), description: "\x1b]52;c;untrusted\x07\n" });
    expect(h.status).toHaveBeenLastCalledWith("pi-background", "Ctrl+Alt+B tasks · R0 F0 P1");
    expect(String(h.status.mock.lastCall?.[1])).not.toContain("\x1b");
    expect(String(h.status.mock.lastCall?.[1])).not.toContain("\n");
    expect(truncateToWidth(String(h.status.mock.lastCall?.[1]), 40)).toContain("P1");
    h.setAcceptWake(false);
    h.setIdle(true);
    await h.emit("agent_settled");
    vi.advanceTimersByTime(2000); // Deliver the debounced wake before its ACK deadline.
    vi.advanceTimersByTime(30_000);
    const visible = truncateToWidth(String(h.status.mock.lastCall?.[1]), 40);
    expect(visible).toContain("P1");
    expect(visible).toContain("PAUSED");
    await h.emit("session_shutdown");
    expect(h.status).toHaveBeenLastCalledWith("pi-background", undefined);
  });

  it.each(["rpc", "json", "print", "tui"])("shortcut is inert without terminal UI (%s)", async (mode) => {
    const h = harness(mode);
    if (mode === "tui") Object.defineProperty(h.ctx, "hasUI", { value: false });
    await h.emit("session_start");
    await h.shortcuts.get("ctrl+alt+b")?.handler(h.ctx);
    expect(h.custom).not.toHaveBeenCalled();
    expect(h.messages).toEqual([]);
    expect(fake.managers.at(-1)?.manager.start).not.toHaveBeenCalled();
    await h.emit("session_shutdown");
  });

  it("does not call custom UI in TUI mode without hasUI", async () => {
    const h = harness();
    Object.defineProperty(h.ctx, "hasUI", { value: false });
    await h.emit("session_start");
    await h.commands.get("background")?.handler("", h.ctx);
    expect(h.custom).not.toHaveBeenCalled();
    expect(h.status).not.toHaveBeenCalled();
    await h.emit("session_shutdown");
  });

  it("never draws terminal status in RPC/headless modes", async () => {
    for (const mode of ["rpc", "json", "print"]) {
      const h = harness(mode);
      await h.emit("session_start");
      fake.managers.at(-1)?.emit(event());
      await h.commands.get("background")?.handler("", h.ctx);
      await h.commands.get("background")?.handler("status", h.ctx);
      await h.tools.get("bash_background")?.execute("call", { command: "true" }, undefined, undefined, h.ctx);
      await h.commands.get("background")?.handler("view job-0", h.ctx);
      expect(h.custom).not.toHaveBeenCalled();
      expect(h.status).not.toHaveBeenCalled();
      await h.emit("session_shutdown");
    }
  });

  it("isolates extension factories and rejects foreign session access", async () => {
    const a = harness();
    const b = harness();
    await a.emit("session_start");
    await b.emit("session_start");
    expect(fake.managers[0].manager).not.toBe(fake.managers[1].manager);
    await a.tools.get("bash_background")?.execute("call", { command: "sleep 1" }, undefined, undefined, a.ctx);
    expect(fake.managers[0].manager.list()).toHaveLength(1);
    expect(fake.managers[1].manager.list()).toHaveLength(0);
    a.setSession("another");
    await expect(a.tools.get("background_list")?.execute("call", {}, undefined, undefined, a.ctx)).rejects.toThrow(
      "No active",
    );
    await a.emit("session_shutdown");
    await b.emit("session_shutdown");
  });

  it("validates monitor ownership before doing work", async () => {
    const h = harness();
    await h.emit("session_start");
    const tool = h.tools.get("monitor");
    await expect(tool?.execute("call", { patterns: ["ready"] }, undefined, undefined, h.ctx)).rejects.toThrow(
      "exactly one",
    );
    await expect(
      tool?.execute("call", { id: "job", command: "sleep 1", patterns: ["ready"] }, undefined, undefined, h.ctx),
    ).rejects.toThrow("exactly one");
    await expect(
      tool?.execute("call", { id: "job", cwd: ".", patterns: ["ready"] }, undefined, undefined, h.ctx),
    ).rejects.toThrow("apply only");
    expect(fake.managers[0].manager.start).not.toHaveBeenCalled();
    await h.emit("session_shutdown");
  });

  it("clears pending notices when the model intentionally stops a job", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.emit("session_start");
    await h.tools.get("bash_background")?.execute("call", { command: "sleep 1" }, undefined, undefined, h.ctx);
    fake.managers[0].emit(event());
    await h.tools.get("background_stop")?.execute("call", { id: "job-0" }, undefined, undefined, h.ctx);
    vi.advanceTimersByTime(2000);
    expect(h.messages).toHaveLength(0);
    await h.emit("session_shutdown");
  });
});
