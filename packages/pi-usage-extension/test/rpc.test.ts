import { test } from "bun:test";
import assert from "node:assert/strict";
import extension from "../index.js";

test("RPC usage reports unsupported dashboard without invoking custom UI", async () => {
  let handler: (args: string, ctx: never) => Promise<void> = async () => {};
  extension({
    registerCommand: (_name: string, command: { handler: typeof handler }) => {
      handler = command.handler;
    },
  } as never);
  const notices: string[] = [];
  const ctx = {
    mode: "rpc",
    hasUI: true,
    ui: {
      notify: (message: string) => notices.push(message),
      custom: () => {
        throw new Error("Unsupported RPC custom UI");
      },
    },
  };
  await handler("", ctx as never);
  assert.match(notices.at(-1) ?? "", /requires TUI/);
  await handler("", { ...ctx, mode: "print", hasUI: false } as never);
  assert.equal(notices.length, 1);
});
