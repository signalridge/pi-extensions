import { test } from "bun:test";
import assert from "node:assert/strict";
import welcome, { collectResources } from "../src/index.js";

test("registers the welcome entry renderer and startup hook", () => {
  const renderers: string[] = [];
  const events: string[] = [];
  welcome({
    registerEntryRenderer: (name: string) => renderers.push(name),
    on: (event: string) => events.push(event),
  } as never);
  assert.deepEqual(renderers, ["welcome-card"]);
  assert.deepEqual(events, ["session_start"]);
});

test("summarizes resources without reloading the active resource loader", async () => {
  let reloadCalled = false;
  const entries: unknown[] = [];
  const lifecycle: string[] = [];
  let sessionStart: ((event: unknown, context: unknown) => Promise<void>) | undefined;
  const pi = {
    registerEntryRenderer: () => {},
    on: (event: string, handler: (event: unknown, context: unknown) => Promise<void>) => {
      lifecycle.push(event);
      if (event === "session_start") sessionStart = handler;
    },
    appendEntry: (_type: string, data: unknown) => entries.push(data),
    getAllTools: () => [{ name: "read" }, { name: "bash" }],
    getActiveTools: () => ["read"],
    getCommands: () => [
      { name: "commit", source: "skill" },
      { name: "plan", source: "prompt" },
      { name: "agents", source: "extension" },
      { name: "statusline", source: "extension" },
    ],
    getSessionName: () => "new",
  };
  const ctx = {
    mode: "tui",
    cwd: process.cwd(),
    hasUI: false,
    sessionManager: { getEntries: () => [] },
    isProjectTrusted: () => true,
    model: undefined,
    thinkingLevel: undefined,
    reload: async () => {
      reloadCalled = true;
      throw new Error("resource reload must not be requested by the welcome card");
    },
  };
  welcome(pi as never);
  await sessionStart?.({}, ctx);
  assert.equal(reloadCalled, false);
  assert.deepEqual(lifecycle, ["session_start"]);

  // Counted through pi's public surfaces, so the card can say what loaded
  // without constructing a second resource loader (whose reload() would
  // execute every extension factory again).
  const resources = new Map(collectResources(pi as never, ctx.cwd));
  assert.equal(resources.get("Tools"), "1 active of 2");
  // Named, not counted: with quietStartup on, this card is the only place the
  // inventory pi loaded appears at all.
  assert.equal(resources.get("Skills"), "commit");
  assert.equal(resources.get("Prompts"), "/plan");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(entries.length, 1);
});
