import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const override of [false, true]) {
  test(`loads global configuration and guidance with ${override ? "PI_CODING_AGENT_DIR" : "normal fallback"}`, () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-guidance-"));
    try {
      const agentDir = join(root, override ? "custom-agent" : ".pi/agent");
      const project = join(root, "project");
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(project);
      writeFileSync(join(agentDir, "agent-guidance.json"), JSON.stringify({ models: { "gpt-*": ["SPECIAL.md"] } }));
      writeFileSync(join(agentDir, "SPECIAL.md"), "global guidance\n");
      writeFileSync(join(project, "SPECIAL.md"), "project guidance\n");
      writeFileSync(join(project, "AGENTS.md"), "shared instructions\n");
      writeFileSync(join(project, "CLAUDE.md"), "provider instructions\n");
      // Bun caches homedir. Set HOME before starting the isolated process, not
      // after imports, so fallback coverage never accesses the real agent dir.
      const env = { ...process.env, HOME: root };
      delete env.PI_CODING_AGENT_DIR;
      if (override) env.PI_CODING_AGENT_DIR = agentDir;
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          `
        import assert from "node:assert/strict";
        import { writeFileSync } from "node:fs";
        import { join } from "node:path";
        import { getAgentDir } from "@earendil-works/pi-coding-agent";
        import agentGuidance from ${JSON.stringify(new URL("../agent-guidance.ts", import.meta.url).href)};
        assert.equal(getAgentDir(), ${JSON.stringify(agentDir)});
        let handler;
        agentGuidance({ on: (_name, callback) => { handler = callback; } });
        const cwd = ${JSON.stringify(project)};
        const run = (provider, id) => handler({ systemPrompt: "base" }, { cwd, model: { provider, id } });
        const prompt = (await run("openai", "gpt-test")).systemPrompt;
        assert.match(prompt, /global guidance/);
        assert.match(prompt, /project guidance/);
        assert.equal(prompt.split("global guidance").length, 2);
        assert.ok(prompt.indexOf("global guidance") < prompt.indexOf("project guidance"));
        assert.match((await run("anthropic", "claude")).systemPrompt, /provider instructions/);
        writeFileSync(join(cwd, "CLAUDE.md"), "shared instructions\\n");
        assert.equal(await run("anthropic", "claude"), undefined);
        writeFileSync(join(cwd, "AGENTS.md"), "project guidance\\n");
        assert.doesNotMatch((await run("openai", "gpt-test")).systemPrompt, /project guidance/);
        assert.equal(await run("unknown", "other"), undefined);
      `,
        ],
        { env, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
