import { test } from "bun:test";
import assert from "node:assert/strict";
import tabStatus, { formatTabTitle } from "../tab-status.js";

for (const [shell, failed] of [
  ["powershell", false],
  ["bash", true],
] as const) {
  test(`${shell} commit title requires its own successful result`, async () => {
    const handlers = new Map<string, (event: never, ctx: never) => Promise<void>>();
    const titles: string[] = [];
    const ctx = {
      cwd: "/tmp/demo",
      isIdle: () => true,
      hasUI: true,
      ui: { setTitle: (title: string) => titles.push(title) },
    };
    tabStatus({
      on: (name: string, handler: (event: never, ctx: never) => Promise<void>) => handlers.set(name, handler),
    } as never);
    const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event as never, ctx as never);
    await emit("agent_start");
    await emit("tool_call", { toolName: shell, toolCallId: "commit", input: { command: "git commit -m done" } });
    await emit("tool_call", { toolName: "bash", toolCallId: "other", input: { command: "pwd" } });
    await emit("tool_result", { toolCallId: "other", isError: false });
    await emit("tool_result", { toolCallId: "commit", isError: failed });
    await emit("tool_result", { toolCallId: "other", isError: true });
    await emit("agent_end", { messages: [] });
    await emit("agent_settled");
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, failed ? "doneNoCommit" : "doneCommitted"));
    await emit("session_shutdown");
  });
}
