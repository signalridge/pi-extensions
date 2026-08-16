import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { isWorktimeUpdatePayload, WORKTIME_UPDATE_EVENT, type WorktimeUpdatePayload } from "../src/events.js";
import { registerWorktime, type WorktimeExtensionOptions } from "../src/index.js";

type TestMode = "tui" | "rpc" | "json" | "print";
type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type IntervalHandle = ReturnType<typeof setInterval>;
type StatusCall = { key: string; value: string | undefined };

type Command = {
  handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
};

type ContextHandle = {
  ctx: ExtensionContext;
  manager: object;
  statuses: StatusCall[];
  notifications: string[];
  statusCounter: { value: number };
  statusCalls: number;
};

type RuntimeFixture = {
  handlers: Map<string, EventHandler>;
  commands: Map<string, Command>;
  emissions: Array<{ channel: string; data: unknown }>;
  eventListeners: Array<(channel: string, data: unknown) => void>;
  intervalCallbacks: Array<() => void>;
  clearCalls: number;
  unrefCalls: number;
  now: { value: number };
};

function context(mode: TestMode, label: string, hasUI = mode === "tui" || mode === "rpc"): ContextHandle {
  const manager = { label };
  const statuses: StatusCall[] = [];
  const notifications: string[] = [];
  const statusCounter = { value: 0 };
  const ctx = {
    mode,
    hasUI,
    sessionManager: manager,
    ui: {
      setStatus(key: string, value: string | undefined): void {
        statusCounter.value += 1;
        statuses.push({ key, value });
      },
      notify(message: string): void {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;
  return {
    ctx,
    manager,
    statuses,
    notifications,
    statusCounter,
    get statusCalls() {
      return statusCounter.value;
    },
  };
}

function throwingUiContext(mode: TestMode, label: string, hasUI: boolean): ContextHandle {
  const handle = context(mode, label, hasUI);
  const ui = {
    setStatus(): never {
      handle.statusCounter.value += 1;
      throw new Error("setStatus must not be called");
    },
    notify(message: string): never {
      handle.notifications.push(message);
      throw new Error("notify must not be called");
    },
  };
  Object.assign(handle.ctx as object, { ui });
  return handle;
}

function fixture(): RuntimeFixture {
  const handlers = new Map<string, EventHandler>();
  const commands = new Map<string, Command>();
  const emissions: Array<{ channel: string; data: unknown }> = [];
  const eventListeners: Array<(channel: string, data: unknown) => void> = [];
  const intervalCallbacks: Array<() => void> = [];
  const now = { value: 0 };
  let clearCalls = 0;
  let unrefCalls = 0;

  const pi = {
    on(event: string, handler: EventHandler): void {
      handlers.set(event, handler);
    },
    registerCommand(name: string, command: Command): void {
      commands.set(name, command);
    },
    events: {
      emit(channel: string, data: unknown): void {
        emissions.push({ channel, data });
        for (const listener of eventListeners) listener(channel, data);
      },
    },
  };

  const intervalHandle = {
    unref(): void {
      unrefCalls += 1;
    },
  } as unknown as IntervalHandle;
  const options: WorktimeExtensionOptions = {
    clock: () => now.value,
    setInterval(callback: () => void): IntervalHandle {
      intervalCallbacks.push(callback);
      return intervalHandle;
    },
    clearInterval(_handle: IntervalHandle): void {
      clearCalls += 1;
    },
  };

  registerWorktime(pi as never, options);
  return {
    handlers,
    commands,
    emissions,
    eventListeners,
    intervalCallbacks,
    get clearCalls() {
      return clearCalls;
    },
    get unrefCalls() {
      return unrefCalls;
    },
    now,
  };
}

async function emit(
  fixtureValue: RuntimeFixture,
  name: string,
  ctx: ExtensionContext,
  event: unknown = {},
): Promise<unknown> {
  const result = fixtureValue.handlers.get(name)?.(event, ctx);
  return result instanceof Promise ? result : Promise.resolve(result);
}

function payloads(fixtureValue: RuntimeFixture): WorktimeUpdatePayload[] {
  return fixtureValue.emissions
    .filter((entry) => entry.channel === WORKTIME_UPDATE_EVENT)
    .map((entry) => {
      assert.equal(isWorktimeUpdatePayload(entry.data), true);
      return entry.data;
    });
}

test("registers lifecycle handlers and publishes in lifecycle order", async () => {
  const runtime = fixture();
  const current = context("tui", "current");

  assert.deepEqual(
    [...runtime.handlers.keys()],
    ["session_start", "session_tree", "message_start", "agent_start", "agent_end", "session_shutdown"],
  );
  assert.equal(runtime.commands.has("worktime"), true);

  await emit(runtime, "session_start", current.ctx);
  await emit(runtime, "message_start", current.ctx, { message: { role: "user" } });
  runtime.now.value = 0;
  await emit(runtime, "agent_start", current.ctx);
  runtime.now.value = 1_500;
  runtime.intervalCallbacks[0]?.();
  runtime.now.value = 3_000;
  await emit(runtime, "agent_end", current.ctx);

  assert.deepEqual(payloads(runtime), [
    { ms: 0, running: false },
    { ms: 0, running: false },
    { ms: 0, running: true },
    { ms: 1_500, running: true },
    { ms: 3_000, running: false },
  ]);
  assert.equal(
    runtime.emissions.every((entry) => entry.channel === WORKTIME_UPDATE_EVENT),
    true,
  );
  assert.equal(runtime.clearCalls, 1);
  assert.equal(runtime.unrefCalls, 1);
  assert.deepEqual(current.statuses, [
    { key: "worktime", value: "0s" },
    { key: "worktime", value: "0s" },
    { key: "worktime", value: "0s" },
    { key: "worktime", value: "1s" },
    { key: "worktime", value: "3s" },
  ]);
});

test("resets only after an accepted user message starts", async () => {
  const runtime = fixture();
  const current = context("tui", "current");

  await emit(runtime, "session_start", current.ctx);
  await emit(runtime, "agent_start", current.ctx);
  runtime.now.value = 500;
  runtime.intervalCallbacks[0]?.();
  const beforeRejectedInput = runtime.emissions.length;

  // A later input listener can reject this preflight without creating a message.
  runtime.handlers.set("input", () => ({ action: "handled" }));
  await emit(runtime, "input", current.ctx, { text: "rejected", source: "interactive" });
  assert.equal(runtime.emissions.length, beforeRejectedInput);
  assert.deepEqual(payloads(runtime).at(-1), { ms: 500, running: true });

  // Non-user messages do not reset the current active span.
  await emit(runtime, "message_start", current.ctx, { message: { role: "assistant" } });
  assert.deepEqual(payloads(runtime).at(-1), { ms: 500, running: true });

  // A delivered prompt/steer is accepted only once this user message starts.
  await emit(runtime, "message_start", current.ctx, { message: { role: "user" } });
  assert.deepEqual(payloads(runtime).at(-1), { ms: 0, running: true });
  runtime.now.value = 800;
  await emit(runtime, "agent_end", current.ctx);
  assert.deepEqual(payloads(runtime).at(-1), { ms: 300, running: false });
});
test("session tree navigation resets branch-local worktime and invalidates the old interval", async () => {
  const runtime = fixture();
  const current = context("tui", "current");

  await emit(runtime, "session_start", current.ctx);
  runtime.now.value = 0;
  await emit(runtime, "agent_start", current.ctx);
  const oldTimer = runtime.intervalCallbacks[0];
  runtime.now.value = 1_200;

  await emit(runtime, "session_tree", current.ctx);
  const afterTree = runtime.emissions.length;
  oldTimer?.();

  assert.deepEqual(payloads(runtime).at(-1), { ms: 0, running: false });
  assert.equal(runtime.emissions.length, afterTree);
  assert.equal(runtime.clearCalls, 1);
  assert.deepEqual(current.statuses.at(-1), { key: "worktime", value: "0s" });
});

test("a disposed context stops its stale timer without publishing more events", async () => {
  const runtime = fixture();
  const current = context("print", "disposed", false);

  await emit(runtime, "session_start", current.ctx);
  await emit(runtime, "agent_start", current.ctx);
  const emissionCount = runtime.emissions.length;
  Object.defineProperty(current.ctx as object, "sessionManager", {
    configurable: true,
    get(): never {
      throw new Error("stale extension context");
    },
  });

  runtime.intervalCallbacks[0]?.();
  runtime.intervalCallbacks[0]?.();
  assert.equal(runtime.clearCalls, 1);
  assert.equal(runtime.emissions.length, emissionCount);
  await emit(runtime, "agent_end", current.ctx);
  assert.equal(runtime.emissions.length, emissionCount);
});

test("event listeners cannot mutate the immutable snapshot or later status", async () => {
  const runtime = fixture();
  const current = context("tui", "current");
  runtime.eventListeners.push((channel, data) => {
    if (channel !== WORKTIME_UPDATE_EVENT) return;
    const payload = data as WorktimeUpdatePayload;
    try {
      payload.ms = 0;
      payload.running = false;
    } catch {
      // Frozen snapshots reject synchronous listener mutation in strict mode.
    }
  });

  await emit(runtime, "session_start", current.ctx);
  await emit(runtime, "agent_start", current.ctx);
  runtime.now.value = 1_500;
  runtime.intervalCallbacks[0]?.();
  assert.equal(Object.isFrozen(runtime.emissions.at(-1)?.data), true);
  assert.deepEqual(payloads(runtime).at(-1), { ms: 1_500, running: true });
  assert.deepEqual(current.statuses.at(-1), { key: "worktime", value: "1s" });

  runtime.now.value = 2_000;
  await emit(runtime, "agent_end", current.ctx);
  assert.deepEqual(payloads(runtime).at(-1), { ms: 2_000, running: false });
  assert.deepEqual(current.statuses.at(-1), { key: "worktime", value: "2s" });
});

test("repeated agent starts use one interval and repeated ends clean it once", async () => {
  const runtime = fixture();
  const current = context("tui", "current");

  await emit(runtime, "session_start", current.ctx);
  runtime.now.value = 100;
  await emit(runtime, "agent_start", current.ctx);
  await emit(runtime, "agent_start", current.ctx);
  assert.equal(runtime.intervalCallbacks.length, 1);

  runtime.now.value = 500;
  await emit(runtime, "agent_end", current.ctx);
  await emit(runtime, "agent_end", current.ctx);
  assert.equal(runtime.clearCalls, 1);
  assert.deepEqual(payloads(runtime).at(-1), { ms: 400, running: false });
});

test("shutdown clears the timer, publishes terminal time, and clears only owned status", async () => {
  const runtime = fixture();
  const current = context("tui", "current");

  await emit(runtime, "session_start", current.ctx);
  await emit(runtime, "agent_start", current.ctx);
  runtime.now.value = 2_500;
  await emit(runtime, "session_shutdown", current.ctx);
  const emissionCount = runtime.emissions.length;

  assert.deepEqual(payloads(runtime).at(-1), { ms: 2_500, running: false });
  assert.equal(runtime.clearCalls, 1);
  assert.deepEqual(current.statuses.at(-1), { key: "worktime", value: undefined });

  await emit(runtime, "session_shutdown", current.ctx);
  assert.equal(runtime.clearCalls, 1);
  assert.equal(runtime.emissions.length, emissionCount);
  assert.deepEqual(current.statuses.at(-1), { key: "worktime", value: undefined });
});

test("old session contexts and interval callbacks cannot affect a replacement", async () => {
  const runtime = fixture();
  const oldSession = context("tui", "old");
  const newSession = context("tui", "new");

  await emit(runtime, "session_start", oldSession.ctx);
  await emit(runtime, "agent_start", oldSession.ctx);
  const oldTimer = runtime.intervalCallbacks[0];
  runtime.now.value = 1_000;

  await emit(runtime, "session_start", newSession.ctx);
  const afterReplacement = runtime.emissions.length;
  const oldStatusCount = oldSession.statuses.length;
  oldTimer?.();
  await emit(runtime, "agent_end", oldSession.ctx);
  await emit(runtime, "session_shutdown", oldSession.ctx);

  assert.equal(runtime.emissions.length, afterReplacement);
  assert.equal(oldSession.statuses.length, oldStatusCount);
  assert.deepEqual(oldSession.notifications, []);
  assert.deepEqual(newSession.statuses.at(-1), { key: "worktime", value: "0s" });

  await emit(runtime, "agent_start", newSession.ctx);
  assert.equal(runtime.intervalCallbacks.length, 2);
  assert.equal(runtime.clearCalls, 1);
});

test("worktime command reports unavailable for a stale UI context", async () => {
  const runtime = fixture();
  const oldSession = context("tui", "old");
  const current = context("tui", "current");

  await emit(runtime, "session_start", oldSession.ctx);
  await emit(runtime, "session_start", current.ctx);
  await runtime.commands.get("worktime")?.handler("", oldSession.ctx);

  assert.deepEqual(oldSession.notifications, ["Worktime unavailable: not initialized for this session."]);
  assert.deepEqual(current.notifications, []);
});

test("headless sessions still emit events without touching TUI APIs", async () => {
  const runtime = fixture();
  const headless = throwingUiContext("print", "headless", false);

  await emit(runtime, "session_start", headless.ctx);
  await emit(runtime, "agent_start", headless.ctx);
  runtime.now.value = 1_000;
  runtime.intervalCallbacks[0]?.();
  await emit(runtime, "agent_end", headless.ctx);
  await emit(runtime, "session_shutdown", headless.ctx);
  await runtime.commands.get("worktime")?.handler("", headless.ctx);

  assert.equal(payloads(runtime).length >= 5, true);
  assert.equal(headless.statusCalls, 0);
  assert.deepEqual(headless.notifications, []);
});

test("RPC sessions do not receive terminal status calls but can notify", async () => {
  const runtime = fixture();
  const rpc = context("rpc", "rpc", true);
  Object.assign(rpc.ctx as object, {
    ui: {
      setStatus(): never {
        rpc.statusCounter.value += 1;
        throw new Error("setStatus must not be called");
      },
      notify(message: string): void {
        rpc.notifications.push(message);
      },
    },
  });

  await emit(runtime, "session_start", rpc.ctx);
  await emit(runtime, "agent_start", rpc.ctx);
  await emit(runtime, "agent_end", rpc.ctx);
  await runtime.commands.get("worktime")?.handler("", rpc.ctx);
  await emit(runtime, "session_shutdown", rpc.ctx);

  assert.equal(rpc.statusCalls, 0);
  assert.equal(rpc.notifications.length, 1);
  assert.match(rpc.notifications[0] ?? "", /Agent worked 0s on this prompt/u);
  assert.equal(
    payloads(runtime).every((payload) => isWorktimeUpdatePayload(payload)),
    true,
  );
});

test("Pi SDK disposal invalidates the captured context without session_shutdown", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-worktime-disposal-"));
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let clearCalls = 0;
  let disposeSession: (() => void) | undefined;

  try {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      extensionFactories: [
        {
          name: "pi-worktime-disposal-regression",
          factory: (pi) => registerWorktime(pi),
        },
      ],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const created = await createAgentSession({
      cwd,
      agentDir: cwd,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      noTools: "all",
    });
    assert.deepEqual(created.extensionsResult.errors, []);
    disposeSession = created.session.dispose.bind(created.session);
    await created.session.bindExtensions({});

    globalThis.setInterval = ((callback: Parameters<typeof setInterval>[0], _delay: number) =>
      originalSetInterval(callback, 5)) as typeof setInterval;
    globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
      clearCalls += 1;
      originalClearInterval(handle);
    }) as typeof clearInterval;

    await created.session.extensionRunner.emit({ type: "agent_start" });
    created.session.dispose();
    disposeSession = undefined;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(clearCalls > 0, true);
  } finally {
    disposeSession?.();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    rmSync(cwd, { recursive: true, force: true });
  }
});
