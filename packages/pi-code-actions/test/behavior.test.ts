import { test } from "bun:test";
import assert from "node:assert/strict";
import codeActions from "../index.js";

function commandFixture() {
  let command: ((args: string, ctx: never) => Promise<void>) | undefined;
  const editor: { value: string } = { value: "existing" };
  const notifications: string[] = [];
  const pi = {
    registerCommand: (_name: string, definition: { handler: (args: string, ctx: never) => Promise<void> }) => {
      command = definition.handler;
    },
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  };
  const ctx = {
    hasUI: true,
    cwd: "/tmp",
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          id: "assistant-1",
          timestamp: new Date(0).toISOString(),
          message: { role: "assistant", content: "```ts\nconst answer = 42;\n```" },
        },
      ],
    },
    ui: {
      getEditorText: () => editor.value,
      setEditorText: (value: string) => {
        editor.value = value;
      },
      notify: (message: string) => notifications.push(message),
    },
  };
  codeActions(pi as never);
  if (!command) throw new Error("code command was not registered");
  return { command, ctx: ctx as never, editor, notifications };
}

test("registers /code and inserts a selected fenced block", async () => {
  const fixture = commandFixture();
  await fixture.command("last insert 1", fixture.ctx);
  assert.equal(fixture.editor.value, "existing\nconst answer = 42;");
  assert.deepEqual(fixture.notifications, ["Inserted snippet into editor."]);
});

test("does not execute a command action without a UI context", async () => {
  const fixture = commandFixture();
  const noUi = { ...fixture.ctx, hasUI: false } as never;
  await fixture.command("last run 1", noUi);
  assert.equal(fixture.notifications.length, 0);
});
