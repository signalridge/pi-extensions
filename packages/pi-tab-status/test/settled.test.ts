import { test } from "bun:test";
import assert from "node:assert/strict";
import tabStatus, { formatIdleTabTitle, formatTabTitle } from "../tab-status.js";

test("commit evidence survives retry and continuation until truly settled", async () => {
  const handlers = new Map<string, (event: never, ctx: never) => Promise<void>>();
  const titles: string[] = [];
  let idle = false;
  const ctx = {
    cwd: "/tmp/demo",
    hasUI: true,
    isIdle: () => idle,
    ui: { setTitle: (title: string) => titles.push(title) },
  };
  tabStatus({
    on: (name: string, handler: (event: never, ctx: never) => Promise<void>) => handlers.set(name, handler),
  } as never);
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event as never, ctx as never);
  const end = (stopReason: string) => emit("agent_end", { messages: [{ role: "assistant", stopReason }] });
  try {
    await emit("session_start");
    await emit("agent_start");
    await emit("tool_call", { toolName: "bash", toolCallId: "commit", input: { command: "git commit -m done" } });
    await emit("tool_result", { toolCallId: "commit", isError: false });
    // A cancelled session switch does not start a new run or erase evidence.
    await emit("session_before_switch", { reason: "new" });
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "running"));
    await end("error");
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "running"));
    await emit("agent_start");
    await end("stop");
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "running"));
    // A follow-up started by another observer keeps this logical run alive.
    await emit("agent_start");
    await emit("agent_settled");
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "running"));
    await end("stop");
    idle = true;
    await emit("agent_settled");
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "doneCommitted"));

    idle = false;
    await emit("agent_start");
    await end("error");
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "running"));
    idle = true;
    await emit("agent_settled");
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "timeout"));

    await emit("agent_start");
    await end("stop");
    await emit("agent_settled");
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "doneNoCommit"), "new run resets commit evidence");
    idle = false;
    await emit("agent_start");
    await end("stop");
    // A previous settled observer starts manual compaction synchronously.
    await emit("agent_settled");
    await emit("session_compact", { reason: "manual", willRetry: false });
    // Pi clears its compaction controller only after these hooks return.
    idle = true;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "doneNoCommit"));

    idle = false;
    await emit("agent_start");
    await end("stop");
    await emit("agent_settled");
    await emit("session_start");
    idle = true;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "new"));
  } finally {
    await emit("session_shutdown");
  }
  assert.equal(titles.at(-1), formatIdleTabTitle(ctx.cwd));
});
