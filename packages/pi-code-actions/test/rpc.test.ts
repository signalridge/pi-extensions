import { test } from "bun:test";
import assert from "node:assert/strict";
import extension from "../index.js";

test("RPC insertion confirms replacement without reading the client draft; cancel leaves it untouched", async () => {
  let handler: (args: string, ctx: never) => Promise<void> = async () => {};
  extension({
    on: () => () => {},
    exec: async () => ({ stdout: "ran successfully", stderr: "", code: 0 }),
    registerCommand: (_name: string, command: { handler: typeof handler }) => {
      handler = command.handler;
    },
  } as never);
  const notices: string[] = [];
  const snippet = process.platform === "win32" ? "Write-Output 'ran successfully'" : "printf 'ran successfully'";
  let inserted = "client draft";
  let confirmed = false;
  let replacements = 0;
  const confirmations: string[] = [];
  const ctx = {
    mode: "rpc",
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
          message: { role: "assistant", content: `\`\`\`sh\n${snippet}\n\`\`\`` },
        },
      ],
    },
    ui: {
      custom: () => {
        throw new Error("Unsupported RPC custom UI");
      },
      notify: (message: string) => notices.push(message),
      confirm: async (title: string, message: string) => {
        confirmations.push(`${title}\n${message}`);
        return confirmed;
      },
      // Faithful RPC host: reads always return empty and writes replace, never append.
      getEditorText: () => "",
      setEditorText: (text: string) => {
        replacements += 1;
        inserted = text;
      },
    },
  };
  await handler("", ctx as never);
  assert.match(notices.at(-1) ?? "", /requires TUI/);
  // Copy must reject before Pi's terminal writer: OSC52 on server stderr
  // cannot copy into this RPC client's clipboard.
  const originalWrite = process.stderr.write;
  let writes = 0;
  process.stderr.write = (() => {
    writes++;
    return true;
  }) as typeof process.stderr.write;
  try {
    await handler("last copy 1", ctx as never);
    assert.match(notices.at(-1) ?? "", /Clipboard copying is unavailable outside TUI mode/);
    assert.ok(!notices.some((message) => message === "Copied to clipboard."));
    assert.equal(writes, 0);
  } finally {
    process.stderr.write = originalWrite;
  }
  await handler("last insert 1", ctx as never);
  assert.equal(inserted, "client draft");
  assert.equal(replacements, 0);
  assert.match(confirmations[0] ?? "", /replace the entire draft/i);
  assert.match(confirmations[0] ?? "", /cannot read or append/i);
  confirmed = true;
  await handler("last insert 1", ctx as never);
  assert.equal(inserted, snippet);
  assert.equal(replacements, 1);
  await handler("last run 1", ctx as never);
  assert.match(notices.at(-1) ?? "", /ran successfully/);
});
