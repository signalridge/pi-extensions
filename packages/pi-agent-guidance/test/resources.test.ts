import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("deduplicates against actual host context selection, including override and readable files", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-guidance-resources-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
      import assert from "node:assert/strict";
      import { mkdirSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
      import { join, resolve } from "node:path";
      import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
      import guidance from ${JSON.stringify(new URL("../agent-guidance.ts", import.meta.url).href)};
      const root = ${JSON.stringify(root)};
      const agentDir = join(root, "agent");
      mkdirSync(agentDir);
      let handler;
      guidance({ on: (event, callback) => { if (event === "before_agent_start") handler = callback; } });
      let counter = 0;
      async function run(files, provider, expected, options) {
        const cwd = join(root, String(counter++));
        mkdirSync(cwd);
        for (const [name, content] of Object.entries(files)) {
          if (content === null) mkdirSync(join(cwd, name));
          else writeFileSync(join(cwd, name), content);
        }
        const contextFiles = options ?? loadProjectContextFiles({ cwd, agentDir });
        const event = { systemPrompt: "base", systemPromptOptions: { contextFiles, sections: {} } };
        assert.equal(await handler(event, { cwd, model: { provider } }), undefined);
        const section = event.systemPromptOptions.sections.provider_context;
        assert.equal(Boolean(section), expected, JSON.stringify(files));
        return { cwd, result: section ? { systemPrompt: section } : undefined };
      }
      const claude = await run({ "AGENTS.override.md": "override", "CLAUDE.md": "claude-only" }, "anthropic", true);
      assert.match(claude.result.systemPrompt, /claude-only/);
      const codex = await run({ "AGENTS.override.md": "override", "AGENTS.md": "codex", "CODEX.md": "codex" }, "openai", true);
      assert.match(codex.result.systemPrompt, /codex/);
      assert.match((await handler({ systemPrompt: "base" }, { cwd: claude.cwd, model: { provider: "anthropic" } })).systemPrompt, /claude-only/);
      assert.match((await handler({ systemPrompt: "base" }, { cwd: codex.cwd, model: { provider: "openai" } })).systemPrompt, /codex/);
      await run({ "AGENTS.override.md": "codex", "AGENTS.md": "other", "CODEX.md": "codex" }, "openai", false);
      await run({ "AGENTS.MD": "shared", "CODEX.md": "shared" }, "openai", false);
      await run({ "CLAUDE.MD": "shared", "CODEX.md": "shared" }, "openai", false);
      await run({ "AGENTS.override.md": null, "AGENTS.md": "shared", "CODEX.md": "shared" }, "openai", false);
      await run({ "CODEX.md": null }, "openai", false);
      await run({ "CLAUDE.md": "shared" }, "anthropic", false);
      // An explicitly empty current-host selection is authoritative, not a
      // request to fall back to inferred core loading.
      await run({ "AGENTS.md": "shared", "CODEX.md": "shared" }, "openai", true, []);
      await run({ "CODEX.md": "shared" }, "openai", false, [{ path: join(root, "elsewhere.md"), content: "shared" }]);
      const selected = await run({ "CODEX.md": "changed" }, "openai", true, []);
      assert.equal(await handler({ systemPrompt: "base", systemPromptOptions: { contextFiles: [{ path: resolve(selected.cwd, "..", String(counter - 1), "CODEX.md"), content: "old" }] } }, { cwd: selected.cwd, model: { provider: "openai" } }), undefined);
      const cwd = join(root, "unreadable");
      mkdirSync(cwd);
      writeFileSync(join(cwd, "AGENTS.override.md"), "blocked");
      writeFileSync(join(cwd, "AGENTS.md"), "shared");
      writeFileSync(join(cwd, "CODEX.md"), "shared");
      chmodSync(join(cwd, "AGENTS.override.md"), 0);
      const event = { systemPrompt: "base", systemPromptOptions: { contextFiles: loadProjectContextFiles({ cwd, agentDir }) } };
      if (process.getuid() !== 0) assert.equal(await handler(event, { cwd, model: { provider: "openai" } }), undefined);
      // Legacy fallback honors readability/precedence too.
      if (process.getuid() !== 0) assert.equal(await handler({ systemPrompt: "base" }, { cwd, model: { provider: "openai" } }), undefined);
      chmodSync(join(cwd, "CODEX.md"), 0);
      if (process.getuid() !== 0) assert.equal(await handler({ systemPrompt: "base", systemPromptOptions: { contextFiles: [] } }, { cwd, model: { provider: "openai" } }), undefined);
      const links = join(root, "links");
      mkdirSync(links);
      writeFileSync(join(links, "actual.md"), "new");
      symlinkSync(join(links, "actual.md"), join(links, "CODEX.md"));
      assert.equal(await handler({ systemPrompt: "base", systemPromptOptions: { contextFiles: [{ path: join(links, "actual.md"), content: "old" }] } }, { cwd: links, model: { provider: "openai" } }), undefined);
    `,
      ],
      { env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") }, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
