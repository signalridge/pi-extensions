import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import tabStatus, { formatIdleTabTitle, formatTabTitle } from "../tab-status.js";

const PINNED_ENV = [
  "PI_TAB_STATUS_NOTIFY",
  "PI_TAB_STATUS_STYLE",
  "TMUX",
  "KITTY_WINDOW_ID",
  "TERM_PROGRAM",
  "ITERM_SESSION_ID",
  "LC_TERMINAL",
];

/** One settled run per call, with notifications enabled and the terminal pinned to OSC 777. */
async function withTab(style: "legacy" | "ridgeline", body: (tab: ReturnType<typeof createTab>) => Promise<void>) {
  const saved = new Map(PINNED_ENV.map((name) => [name, process.env[name]]));
  for (const name of PINNED_ENV) delete process.env[name];
  process.env.PI_TAB_STATUS_NOTIFY = "1";
  process.env.PI_TAB_STATUS_STYLE = style;
  const notifications: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    notifications.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const tab = createTab(notifications);
  try {
    await tab.emit("session_start");
    await body(tab);
  } finally {
    await tab.emit("session_shutdown");
    write.mockRestore();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function createTab(notifications: string[]) {
  const handlers = new Map<string, (event: never, ctx: never) => Promise<void>>();
  const titles: string[] = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp/demo",
    isIdle: () => true,
    ui: { setTitle: (title: string) => titles.push(title) },
  };
  tabStatus({
    on: (name: string, handler: (event: never, ctx: never) => Promise<void>) => handlers.set(name, handler),
  } as never);
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event as never, ctx as never);
  return {
    cwd: ctx.cwd,
    titles,
    notifications,
    emit,
    /** A run ending with `stopReason`, settled with the host's payload (`{}` is a pre-1.1 host). */
    settle: async (stopReason: string, settled: object) => {
      await emit("agent_start");
      await emit("agent_end", {
        messages: [{ role: "assistant", stopReason }],
      });
      await emit("agent_settled", settled);
    },
  };
}

test("the host's aborted flag shows a cancelled run as the bare title, whatever its stop reason", async () => {
  for (const stopReason of ["aborted", "stop", "error"]) {
    await withTab("ridgeline", async (tab) => {
      await tab.settle(stopReason, { aborted: true });
      assert.equal(tab.titles.at(-1), "pi · demo", stopReason);
      assert.deepEqual(tab.notifications, [], stopReason);
    });
  }
});

test("the host's flag is preferred over the stop reason when it says the run was not aborted", async () => {
  await withTab("legacy", async (tab) => {
    await tab.settle("aborted", { aborted: false });
    assert.equal(tab.titles.at(-1), formatTabTitle(tab.cwd, "doneNoCommit"));
    assert.deepEqual(tab.notifications, ["\x1b]777;notify;pi - demo;Finished, ready for review\x07"]);
  });
});

test("without the host's flag an aborted stop reason still cancels", async () => {
  for (const settled of [{}, { aborted: "yes" }]) {
    await withTab("legacy", async (tab) => {
      await tab.settle("aborted", settled);
      assert.equal(tab.titles.at(-1), formatIdleTabTitle(tab.cwd), JSON.stringify(settled));
      assert.deepEqual(tab.notifications, []);

      await tab.settle("stop", settled);
      assert.equal(tab.titles.at(-1), formatTabTitle(tab.cwd, "doneNoCommit"));
      await tab.settle("error", settled);
      assert.equal(tab.titles.at(-1), formatTabTitle(tab.cwd, "timeout"));
      assert.deepEqual(tab.notifications, [
        "\x1b]777;notify;pi - demo;Finished, ready for review\x07",
        "\x1b]777;notify;pi - demo;Run ended with an error\x07",
      ]);
    });
  }
});

test("a cancelled run keeps no commit evidence and the next run reports normally", async () => {
  await withTab("legacy", async (tab) => {
    await tab.emit("agent_start");
    await tab.emit("tool_result", {
      toolName: "bash",
      toolCallId: "commit",
      input: { command: "git commit -m wip" },
      isError: false,
    });
    await tab.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "aborted" }],
    });
    await tab.emit("agent_settled", { aborted: true });
    assert.equal(tab.titles.at(-1), formatIdleTabTitle(tab.cwd));
    // Title refreshes keep the cancelled state rather than reviving a label.
    await tab.emit("session_info_changed");
    assert.equal(tab.titles.at(-1), formatIdleTabTitle(tab.cwd));

    await tab.settle("stop", { aborted: false });
    assert.equal(tab.titles.at(-1), formatTabTitle(tab.cwd, "doneNoCommit"));
    assert.equal(tab.notifications.length, 1);
  });
});
