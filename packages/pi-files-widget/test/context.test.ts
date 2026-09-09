import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import * as browser from "../browser.js";
import extension from "../index.js";
import * as utils from "../utils.js";

test("browser and modified paths follow command/session cwd; RPC never creates terminal UI", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "files-context-"));
  const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
  const events = new Map<string, (event: never, ctx: never) => Promise<void>>();
  const notices: string[] = [];
  const deps = spyOn(utils, "hasCommand").mockReturnValue(true);
  const create = spyOn(browser, "createFileBrowser").mockReturnValue({
    render: () => [],
    handleInput: () => {},
    invalidate: () => {},
  } as never);
  let customCalls = 0;
  let cleanup: (() => void) | undefined;
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (text: string) => notices.push(text),
      custom: async (factory: (...args: unknown[]) => unknown) => {
        customCalls++;
        factory({ requestRender: () => {} }, {}, {}, () => {});
        cleanup = create.mock.calls.at(-1)?.[3];
        cleanup?.();
      },
    },
  };
  try {
    assert.notEqual(cwd, process.cwd());
    extension({
      registerCommand: (name: string, command: never) => commands.set(name, command),
      on: (name: string, handler: never) => events.set(name, handler),
    } as never);
    for (const file of [
      "@local.ts",
      join(cwd, "absolute.ts"),
      "~/home.ts",
      pathToFileURL(join(cwd, "url.ts")).href,
      "space\u00a0name.ts",
    ]) {
      await events.get("tool_result")?.(
        { toolName: "edit", input: { path: file }, isError: false } as never,
        ctx as never,
      );
    }
    await commands.get("readfiles")?.handler("@.", ctx as never);
    const args = create.mock.calls[0];
    assert.ok(args);
    assert.equal(args[0], cwd);
    assert.equal(args[6], cwd);
    assert.deepEqual(
      [...args[1]],
      [
        join(cwd, "local.ts"),
        join(cwd, "absolute.ts"),
        join(homedir(), "home.ts"),
        join(cwd, "url.ts"),
        join(cwd, "space name.ts"),
      ],
    );
    const cancelledPath = join(cwd, "cancelled.ts");
    for (const [id, mutate] of [
      ["cancelled", true],
      ["unchanged", false],
    ] as const) {
      const path = mutate ? "cancelled.ts" : "unchanged.ts";
      await events.get("tool_call")?.({ toolName: "write", toolCallId: id, input: { path } } as never, ctx as never);
      const controller = new AbortController();
      const tool = createWriteTool(cwd, {
        operations: {
          mkdir: async () => {},
          writeFile: async (absolutePath, content) => {
            writeFileSync(absolutePath, content);
            controller.abort();
          },
        },
      });
      if (!mutate) controller.abort();
      await assert.rejects(
        tool.execute(id, { path, content: "written before cancellation" }, controller.signal),
        /aborted/,
      );
      await events.get("tool_result")?.(
        { toolName: "write", toolCallId: id, input: { path }, isError: true } as never,
        { ...ctx, cwd: "/different" } as never,
      );
      await events.get("tool_execution_end")?.(
        { toolName: "write", toolCallId: id, args: { path }, isError: true } as never,
        ctx as never,
      );
    }
    assert.equal(args[1].has(cancelledPath), false);
    const observed = args[7];
    assert.ok(observed);
    assert.equal(observed.has(cancelledPath), true);

    // A later permission/tool_call handler can rewrite the same mutable input.
    for (const isError of [false, true]) {
      const id = `rewrite-${isError}`;
      const input = { path: `${id}-a.ts`, content: "written" };
      await events.get("tool_call")?.({ toolName: "write", toolCallId: id, input } as never, ctx as never);
      writeFileSync(join(cwd, input.path), "unrelated save");
      input.path = `${id}-b.ts`;
      if (!isError) await createWriteTool(cwd).execute(id, input);
      await events.get("tool_result")?.(
        { toolName: "write", toolCallId: id, input, isError } as never,
        { ...ctx, cwd: "/different" } as never,
      );
      assert.equal(args[1].has(join(cwd, `${id}-a.ts`)), false);
      assert.equal(observed.has(join(cwd, `${id}-a.ts`)), false);
      assert.equal(args[1].has(join(cwd, input.path)), !isError);
      assert.equal(observed.has(join(cwd, input.path)), false);
    }

    const humanPath = join(cwd, "human.ts");
    writeFileSync(humanPath, "original");
    const editInput = { path: "human.ts", edits: [{ oldText: "original", newText: "agent edit" }] };
    await events.get("tool_call")?.({ toolName: "edit", toolCallId: "human", input: editInput } as never, ctx as never);
    writeFileSync(humanPath, "saved by user during permission confirmation");
    await assert.rejects(createEditTool(cwd).execute("human", editInput), /Could not find/);
    await events.get("tool_result")?.(
      { toolName: "edit", toolCallId: "human", input: editInput, isError: true } as never,
      ctx as never,
    );
    assert.equal(args[1].has(humanPath), false);
    assert.equal(observed.has(humanPath), true);
    // A later successful write confirms agent authorship and removes uncertainty.
    await events.get("tool_result")?.(
      { toolName: "write", toolCallId: "promoted", input: { path: "human.ts" }, isError: false } as never,
      ctx as never,
    );
    assert.equal(args[1].has(humanPath), true);
    assert.equal(observed.has(humanPath), false);
    assert.equal(args[1].has(join(cwd, "unchanged.ts")), false);
    ctx.mode = "rpc";
    await commands.get("readfiles")?.handler("", ctx as never);
    assert.equal(customCalls, 1);
    assert.match(notices.at(-1) ?? "", /requires TUI/);
    await events.get("session_before_switch")?.({} as never, ctx as never);
    assert.equal(args[1].size, 0);
    assert.equal(observed.size, 0);
  } finally {
    cleanup?.();
    create.mockRestore();
    deps.mockRestore();
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const outcome of ["permission-blocked", "preparation-aborted"] as const) {
  test(`${outcome} drops preflight evidence without a tool_result event`, async () => {
    const events = new Map<string, (event: never, ctx: never) => unknown>();
    const ctx = { cwd: tmpdir(), mode: "print", hasUI: false };
    extension({ registerCommand() {}, on: (name: string, handler: never) => events.set(name, handler) } as never);
    // Observe ownership without exporting extension-internal state for tests.
    const sets = spyOn(Map.prototype, "set");
    try {
      const id = `candidate-${outcome}`;
      const input = { path: `${id}.ts` };
      await events.get("tool_execution_start")?.(
        { toolName: "write", toolCallId: id, args: input } as never,
        ctx as never,
      );
      await events.get("tool_call")?.({ toolName: "write", toolCallId: id, input } as never, ctx as never);
      const index = sets.mock.calls.findIndex(([key]) => key === id);
      assert.notEqual(index, -1);
      const candidates = sets.mock.contexts[index] as Map<string, unknown>;
      assert.equal(candidates.has(id), true);
      // A later permission handler blocks, or preflight is aborted before execute.
      // AgentLoop's immediate-outcome path bypasses afterToolCall/tool_result.
      await events.get("tool_execution_end")?.(
        {
          toolName: "write",
          toolCallId: id,
          args: input,
          isError: true,
          result: { content: [{ type: "text", text: outcome }] },
        } as never,
        ctx as never,
      );
      assert.equal(candidates.size, 0);
      // Duplicate terminal delivery is harmless.
      await events.get("tool_execution_end")?.({ toolCallId: id } as never, ctx as never);
      assert.equal(candidates.size, 0);
    } finally {
      sets.mockRestore();
    }
  });
}
