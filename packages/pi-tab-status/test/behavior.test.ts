import { test } from "bun:test";
import assert from "node:assert/strict";
import type { TabStatusStyle } from "../tab-status.js";
import tabStatus from "../tab-status.js";

/**
 * Drive one full run lifecycle under an explicitly pinned style. The style is a
 * runtime input, so the test must set it instead of inheriting the developer's
 * shell, where `PI_TAB_STATUS_STYLE` may already be exported.
 */
async function runLifecycle(style: TabStatusStyle, cwd = "/tmp/demo"): Promise<string[]> {
  const previous = process.env.PI_TAB_STATUS_STYLE;
  process.env.PI_TAB_STATUS_STYLE = style;
  try {
    const handlers = new Map<string, (event: never, ctx: never) => Promise<void>>();
    const titles: string[] = [];
    const ctx = {
      cwd,
      hasUI: true,
      ui: { setTitle: (title: string) => titles.push(title) },
    };
    tabStatus({
      on: (event: string, handler: (event: never, ctx: never) => Promise<void>) => {
        handlers.set(event, handler);
      },
    } as never);

    await handlers.get("session_start")?.({} as never, ctx as never);
    await handlers.get("agent_start")?.({} as never, ctx as never);
    await handlers.get("tool_call")?.(
      {
        toolName: "bash",
        input: { command: "git add . && git commit -m done" },
      } as never,
      ctx as never,
    );
    await handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] } as never, ctx as never);
    await handlers.get("session_shutdown")?.({} as never, ctx as never);

    return titles;
  } finally {
    if (previous === undefined) delete process.env.PI_TAB_STATUS_STYLE;
    else process.env.PI_TAB_STATUS_STYLE = previous;
  }
}

test("tracks run lifecycle and commit status in the terminal title", async () => {
  assert.deepEqual(await runLifecycle("legacy"), [
    "pi - demo:new",
    "pi - demo:running...",
    "pi - demo:✅",
    "pi - demo",
  ]);
});

test("tracks the same lifecycle in the ridgeline style", async () => {
  assert.deepEqual(await runLifecycle("ridgeline"), [
    "pi · demo · new",
    "pi · demo · working",
    "pi · demo · done",
    "pi · demo",
  ]);
});

test("a hostile directory name cannot terminate the title's escape sequence", async () => {
  // A clone can create this directory; the title is emitted as OSC 0/2, so the BEL
  // would close it early and hand the rest of the name to the terminal as commands.
  const hostile = "/tmp/repo\u0007\u001b]0;pwned\u0007\u001b[31mred\u202e";

  for (const style of ["legacy", "ridgeline"] as const) {
    const titles = await runLifecycle(style, hostile);
    assert.ok(titles.length > 0);
    for (const title of titles) {
      for (const character of title) {
        const codePoint = character.codePointAt(0) ?? 0;
        assert.ok(
          codePoint > 0x1f && !(codePoint >= 0x7f && codePoint <= 0x9f),
          `control U+${codePoint.toString(16)} survived in ${JSON.stringify(title)}`,
        );
      }
      assert.doesNotMatch(title, /\u202e/u);
      assert.ok(title.includes("repo"), `the readable part of the name is kept in ${JSON.stringify(title)}`);
    }
  }
});

test("does not call terminal UI APIs in headless contexts", async () => {
  const handlers = new Map<string, (event: never, ctx: never) => Promise<void>>();
  let titleCalls = 0;
  tabStatus({
    on: (event: string, handler: (event: never, ctx: never) => Promise<void>) => handlers.set(event, handler),
  } as never);
  const ctx = {
    cwd: "/tmp/demo",
    hasUI: false,
    ui: {
      setTitle: () => {
        titleCalls += 1;
      },
    },
  };
  await handlers.get("session_start")?.({} as never, ctx as never);
  await handlers.get("agent_start")?.({} as never, ctx as never);
  assert.equal(titleCalls, 0);
});
