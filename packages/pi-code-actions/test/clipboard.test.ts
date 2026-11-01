import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../index.js";
import { copySnippet } from "../src/actions.js";
import { fakeClipboard } from "./clipboard-host.js";

function ownership() {
  const controller = new AbortController();
  return {
    controller,
    signal: controller.signal,
    isCurrent: () => !controller.signal.aborted,
  };
}

function codeCommand(snippet: string, mode = "tui") {
  const handlers = new Map<string, () => unknown>();
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const notices: Array<{ message: string; level: string }> = [];
  extension({
    on: (name: string, handler: () => unknown) => handlers.set(name, handler),
    registerCommand: (_name: string, definition: { handler: typeof command }) => {
      command = definition.handler;
    },
  } as never);
  const ctx = {
    mode,
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: {
      getSessionId: () => "session",
      getLeafId: () => "a",
      getBranch: () => [
        {
          type: "message",
          id: "a",
          timestamp: "",
          message: {
            role: "assistant",
            content: `\`\`\`sh\n${snippet}\n\`\`\``,
          },
        },
      ],
    },
    ui: {
      notify: (message: string, level: string) => notices.push({ message, level }),
    },
  } as unknown as ExtensionCommandContext;
  return {
    notices,
    copy: () => command("last copy 1", ctx),
    emit: (event: string) => handlers.get(event)?.(),
  };
}

let clipboard: ReturnType<typeof fakeClipboard> | undefined;
afterEach(() => {
  clipboard?.dispose();
  clipboard = undefined;
});

test.skipIf(process.platform === "win32")("RPC copy warns without invoking the clipboard writer", async () => {
  clipboard = fakeClipboard("copy");
  const host = codeCommand("echo private", "rpc");
  await host.copy();
  assert.deepEqual(clipboard.received(), {});
  assert.deepEqual(host.notices, [{ message: "Clipboard copying is unavailable outside TUI mode.", level: "warning" }]);
});

test.skipIf(process.platform === "win32")("/code copy writes through Pi's clipboard writer", async () => {
  clipboard = fakeClipboard("copy");
  const host = codeCommand("echo 'private' \"$(quoted)\"");
  await host.copy();
  const received = Object.entries(clipboard.received());
  assert.equal(received.length, 1);
  assert.ok(["pbcopy", "wl-copy"].includes(received[0]?.[0] ?? ""));
  assert.equal(received[0]?.[1], "echo 'private' \"$(quoted)\"");
  assert.deepEqual(host.notices, [{ message: "Copied to clipboard.", level: "info" }]);
});

test.skipIf(process.platform === "win32")("/code copy reports Pi's clipboard failure reason", async () => {
  clipboard = fakeClipboard("fail");
  const host = codeCommand("echo hi");
  await host.copy();
  assert.equal(host.notices.length, 1);
  assert.equal(host.notices[0]?.level, "error");
  assert.match(host.notices[0]?.message ?? "", /^Failed to copy to clipboard: Clipboard unavailable/);
});

for (const event of [
  "session_before_switch",
  "session_before_fork",
  "session_before_tree",
  "session_tree",
  "session_start",
  "session_shutdown",
]) {
  test.skipIf(process.platform === "win32")(
    `${event} settles a stalled copy without reporting it`,
    async () => {
      clipboard = fakeClipboard("stall");
      const host = codeCommand("echo hi");
      const pending = host.copy();
      const deadline = Date.now() + 3000;
      while (Object.keys(clipboard.received()).length === 0) {
        assert.ok(Date.now() < deadline, "clipboard utility did not start");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      host.emit(event);
      await pending;
      assert.deepEqual(host.notices, []);
    },
    2000,
  );
}

test("copySnippet reports the writer's rejection reason, including non-Error values", async () => {
  assert.deepEqual(
    await copySnippet("x", ownership(), async () => {
      throw new Error("no display");
    }),
    { copied: false, reason: "no display" },
  );
  assert.deepEqual(
    await copySnippet("x", ownership(), () => {
      throw "sync failure";
    }),
    { copied: false, reason: "sync failure" },
  );
});

test("already retired ownership never starts a copy", async () => {
  const owner = ownership();
  owner.controller.abort();
  const result = await copySnippet("old", owner, () => assert.fail("unexpected clipboard write"));
  assert.deepEqual(result, { copied: false, reason: "cancelled" });
});

test("a copy that succeeds after retirement is reported as cancelled", async () => {
  const owner = ownership();
  let finish!: () => void;
  const pending = copySnippet(
    "old",
    owner,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  owner.controller.abort();
  assert.deepEqual(await pending, { copied: false, reason: "cancelled" });
  finish();
});
