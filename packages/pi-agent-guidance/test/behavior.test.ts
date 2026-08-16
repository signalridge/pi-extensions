import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import agentGuidance from "../agent-guidance.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-guidance-"));
  mkdirSync(join(root, ".pi", "agent"), { recursive: true });
  return root;
}

test("loads provider guidance from the active project and avoids core duplicates", async () => {
  const root = fixture();
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  try {
    process.chdir(root);
    process.env.HOME = root;
    writeFileSync(join(root, "AGENTS.md"), "shared instructions\n");
    writeFileSync(join(root, "CLAUDE.md"), "provider instructions\n");
    let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
    agentGuidance({
      on: (_event: string, callback: (event: unknown, ctx: unknown) => Promise<unknown>) => {
        handler = callback;
      },
    } as never);
    if (!handler) throw new Error("before_agent_start handler was not registered");
    const result = await handler(
      { systemPrompt: "base" },
      { cwd: root, model: { provider: "anthropic", id: "claude-sonnet" } },
    );
    assert.match((result as { systemPrompt: string }).systemPrompt, /provider instructions/);
    assert.doesNotMatch((result as { systemPrompt: string }).systemPrompt, /shared instructions/);

    writeFileSync(join(root, "CLAUDE.md"), "shared instructions\n");
    const duplicate = await handler(
      { systemPrompt: "base" },
      { cwd: root, model: { provider: "anthropic", id: "claude-sonnet" } },
    );
    assert.equal(duplicate, undefined);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("selects provider files by model and does not duplicate a parent file", async () => {
  const root = fixture();
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  try {
    process.chdir(root);
    process.env.HOME = root;
    writeFileSync(
      join(root, ".pi", "agent", "agent-guidance.json"),
      JSON.stringify({ models: { "gpt-*": ["CODEX.md"] } }),
    );
    writeFileSync(join(root, "CODEX.md"), "codex instructions\n");
    let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
    agentGuidance({
      on: (_event: string, callback: (event: unknown, ctx: unknown) => Promise<unknown>) => {
        handler = callback;
      },
    } as never);
    if (!handler) throw new Error("before_agent_start handler was not registered");
    const result = await handler({ systemPrompt: "base" }, { cwd: root, model: { provider: "openai", id: "gpt-5" } });
    assert.match((result as { systemPrompt: string }).systemPrompt, /codex instructions/);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
