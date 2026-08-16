import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import statusline from "../src/index.js";
import { createMockContext, createMockPi } from "./support.js";

async function emit(
  events: ReadonlyMap<string, Array<(...args: unknown[]) => unknown>>,
  name: string,
  ...args: unknown[]
) {
  for (const handler of events.get(name) ?? []) await handler(...args);
}

test("declared source entry preserves registration and lifecycle behavior", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-statusline-generated-entry-"));
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const mock = createMockPi();
    statusline(mock.pi);
    assert.ok(mock.commands.has("statusline"));
    assert.ok(mock.events.has("session_start"));
    assert.ok(mock.events.has("session_shutdown"));

    const context = createMockContext({ mode: "tui", cwd: root });
    await emit(mock.events, "session_start", {}, context.ctx);
    assert.equal(existsSync(agentDir), false);
    assert.equal(typeof context.footer, "function");

    await emit(mock.events, "session_shutdown", {}, context.ctx);
    assert.equal(context.footer, undefined);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { force: true, recursive: true });
  }
});
