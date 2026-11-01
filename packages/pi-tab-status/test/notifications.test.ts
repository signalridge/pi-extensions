import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import tabStatus, { formatIdleTabTitle, formatTabTitle } from "../tab-status.js";

const NOTIFY_ENV = [
  "PI_TAB_STATUS_NOTIFY",
  "PI_TAB_STATUS_STYLE",
  "TMUX",
  "KITTY_WINDOW_ID",
  "TERM_PROGRAM",
  "ITERM_SESSION_ID",
  "LC_TERMINAL",
];

/**
 * Drive the extension with manually advanced timers and a captured terminal.
 *
 * The notification setting and the terminal-detection variables are runtime
 * inputs, so they are pinned here instead of inherited from the developer's
 * shell, which may run inside tmux or iTerm2.
 */
function createHarness(options: { notify?: string; mode?: string } = {}) {
  const saved = new Map(NOTIFY_ENV.map((name) => [name, process.env[name]]));
  for (const name of NOTIFY_ENV) delete process.env[name];
  if (options.notify !== undefined) process.env.PI_TAB_STATUS_NOTIFY = options.notify;
  process.env.PI_TAB_STATUS_STYLE = "legacy";

  let now = 0;
  let nextTimerId = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    timers.set(++nextTimerId, { due: now + delay, callback });
    return nextTimerId;
  }) as unknown as typeof setTimeout);
  const cancel = spyOn(globalThis, "clearTimeout").mockImplementation(((timer: number) => {
    timers.delete(timer);
  }) as unknown as typeof clearTimeout);
  const notifications: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    notifications.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);

  const handlers = new Map<string, (event: never, ctx: never) => Promise<void>>();
  const titles: string[] = [];
  let idle = true;
  const ctx = {
    mode: options.mode ?? "tui",
    hasUI: true,
    cwd: "/tmp/demo",
    isIdle: () => idle,
    ui: { setTitle: (title: string) => titles.push(title) },
  };
  tabStatus({
    on: (name: string, handler: (event: never, ctx: never) => Promise<void>) => handlers.set(name, handler),
  } as never);
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event as never, ctx as never);

  return {
    ctx,
    titles,
    notifications,
    emit,
    setIdle: (value: boolean) => {
      idle = value;
    },
    run: async (stopReason = "stop") => {
      await emit("agent_start");
      await emit("agent_end", {
        messages: [{ role: "assistant", stopReason }],
      });
    },
    advance: (ms: number) => {
      now += ms;
      for (const [timerId, { due, callback }] of timers) {
        if (due > now) continue;
        timers.delete(timerId);
        callback();
      }
    },
    restore: async () => {
      await emit("session_shutdown");
      write.mockRestore();
      schedule.mockRestore();
      cancel.mockRestore();
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

const notification = (body: string) => `\x1b]777;notify;pi - demo;${body}\x07`;

test("each settled run raises one notification naming its outcome", async () => {
  const harness = createHarness({ notify: "1" });
  try {
    await harness.emit("session_start");
    await harness.run();
    await harness.emit("agent_settled", { aborted: false });
    assert.deepEqual(harness.notifications, [notification("Finished, ready for review")]);

    await harness.emit("agent_start");
    await harness.emit("tool_result", {
      toolName: "bash",
      toolCallId: "commit",
      input: { command: "git commit -m done" },
      isError: false,
    });
    await harness.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    await harness.emit("agent_settled", { aborted: false });

    await harness.run("error");
    await harness.emit("agent_settled", { aborted: false });
    assert.equal(harness.titles.at(-1), formatTabTitle(harness.ctx.cwd, "timeout"));
    assert.deepEqual(harness.notifications, [
      notification("Finished, ready for review"),
      notification("Finished with a commit"),
      notification("Run ended with an error"),
    ]);
  } finally {
    await harness.restore();
  }
});

test("an aborted run settles to the bare title without a notification, even when settlement is deferred", async () => {
  const harness = createHarness({ notify: "1" });
  try {
    await harness.run("aborted");
    await harness.emit("agent_settled", { aborted: true });
    assert.equal(harness.titles.at(-1), formatIdleTabTitle(harness.ctx.cwd));

    await harness.run("error");
    harness.setIdle(false);
    await harness.emit("agent_settled", { aborted: true });
    harness.setIdle(true);
    harness.advance(25);
    // The host's flag wins over an error stop reason that the abort produced.
    assert.equal(harness.titles.at(-1), formatIdleTabTitle(harness.ctx.cwd));
    assert.deepEqual(harness.notifications, []);
  } finally {
    await harness.restore();
  }
});

test("entering the stalled state notifies once per entry", async () => {
  const harness = createHarness({ notify: "1" });
  try {
    await harness.emit("agent_start");
    harness.advance(180_000);
    assert.equal(harness.titles.at(-1), formatTabTitle(harness.ctx.cwd, "timeout"));
    assert.deepEqual(harness.notifications, [notification("No activity for 3 minutes")]);

    // Continued silence and title refreshes are the same entry, not a new one.
    harness.advance(360_000);
    await harness.emit("session_info_changed");
    assert.equal(harness.notifications.length, 1);

    // Activity leaves the state; a second stall is a second entry.
    await harness.emit("message_update");
    assert.equal(harness.titles.at(-1), formatTabTitle(harness.ctx.cwd, "running"));
    harness.advance(180_000);
    assert.deepEqual(harness.notifications, [
      notification("No activity for 3 minutes"),
      notification("No activity for 3 minutes"),
    ]);
  } finally {
    await harness.restore();
  }
});

test("notifications stay silent when unset or outside the TUI", async () => {
  for (const options of [{}, { notify: "0" }, { notify: "1", mode: "print" }, { notify: "1", mode: "rpc" }]) {
    const harness = createHarness(options);
    try {
      await harness.run();
      await harness.emit("agent_settled", { aborted: false });
      await harness.emit("agent_start");
      harness.advance(180_000);
      assert.deepEqual(harness.notifications, [], JSON.stringify(options));
    } finally {
      await harness.restore();
    }
  }
});

test("a forced protocol is used inside tmux with passthrough", async () => {
  const harness = createHarness({ notify: "osc9" });
  process.env.TMUX = "/tmp/tmux-501/default,1,0";
  try {
    await harness.run();
    await harness.emit("agent_settled", { aborted: false });
    assert.deepEqual(harness.notifications, ["\x1bPtmux;\x1b\x1b]9;pi - demo: Finished, ready for review\x07\x1b\\"]);
  } finally {
    await harness.restore();
  }
});
