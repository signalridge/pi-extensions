import { test } from "bun:test";
import assert from "node:assert/strict";
import extension from "../index.js";

test("RPC picker reports unsupported UI while explicit insert still works", async () => {
  let handler: (args: string, ctx: never) => Promise<void> = async () => {};
  extension({
    exec: async () => ({ stdout: "ran successfully", stderr: "", code: 0 }),
    registerCommand: (_name: string, command: { handler: typeof handler }) => {
      handler = command.handler;
    },
  } as never);
  const notices: string[] = [];
  let inserted = "";
  const ctx = {
    mode: "rpc",
    hasUI: true,
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          id: "a",
          timestamp: "",
          message: { role: "assistant", content: "```ts\nconst a = 1;\n```" },
        },
      ],
    },
    ui: {
      custom: () => {
        throw new Error("Unsupported RPC custom UI");
      },
      notify: (message: string) => notices.push(message),
      confirm: async () => true,
      getEditorText: () => "",
      setEditorText: (text: string) => {
        inserted = text;
      },
    },
  };
  await handler("", ctx as never);
  assert.match(notices.at(-1) ?? "", /requires TUI/);
  await handler("last insert 1", ctx as never);
  assert.equal(inserted, "const a = 1;");
  await handler("last run 1", ctx as never);
  assert.match(notices.at(-1) ?? "", /ran successfully/);
});
