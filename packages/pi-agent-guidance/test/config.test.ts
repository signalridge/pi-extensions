import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function isolated(config: string, script: string) {
  const root = mkdtempSync(join(tmpdir(), "pi-guidance-config-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(cwd);
  writeFileSync(join(agentDir, "agent-guidance.json"), config);
  writeFileSync(join(cwd, "CODEX.md"), "default guidance");
  writeFileSync(join(cwd, "SPECIAL.md"), "custom guidance");
  try {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `import assert from "node:assert/strict";
         import guidance from ${JSON.stringify(new URL("../agent-guidance.ts", import.meta.url).href)};
         const warnings = [];
         console.warn = (message) => warnings.push(message);
         let handler;
         guidance({ on: (event, fn) => { if (event === "before_agent_start") handler = fn; } });
         const run = (id = "gpt-5.4", provider = "openai") => handler({ systemPrompt: "base" }, { cwd: ${JSON.stringify(cwd)}, model: { provider, id } });
         ${script}`,
      ],
      { env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir }, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const config of [
  "null",
  "[]",
  "true",
  "not json",
  '{"providers":"openai"}',
  '{"providers":{"openai":"CODEX.md"}}',
  '{"providers":{"openai":[1]}}',
  '{"models":null}',
  '{"models":{"*":{"file":"SPECIAL.md"}}}',
  '{"providers":{"openai":["SPECIAL.md"]},"models":[]}',
  '{"providers":{"openai":["SPECIAL.md"]},"subdirectoryContext":"no"}',
]) {
  test(`invalid config falls back safely and warns once: ${config}`, () => {
    isolated(
      config,
      `for (let n = 0; n < 3; n++) assert.match((await run()).systemPrompt, /default guidance/);
       assert.equal(warnings.length, 1);
       assert.match(warnings[0], /agent-guidance\\.json/);
       assert.match(warnings[0], /using defaults/);
       assert.equal(await run("other", "constructor"), undefined);`,
    );
  });
}

test("empty string arrays intentionally disable provider/model loading and model mapping wins", () => {
  isolated(
    JSON.stringify({ providers: { openai: [] }, models: { "chosen-*": ["SPECIAL.md"], "disabled-*": [] } }),
    `assert.equal(await run(), undefined);
     assert.match((await run("chosen-model")).systemPrompt, /custom guidance/);
     assert.equal(await run("disabled-model"), undefined);
     assert.equal(warnings.length, 0);`,
  );
});

test("wildcard matching treats all non-star regex characters literally and keeps first-match priority", () => {
  const literal = `GPT-5.4+[x](a)?^\${b}|\\end`;
  isolated(
    JSON.stringify({ models: { [`${literal}*`]: ["SPECIAL.md"], "gpt-*": ["CODEX.md"] } }),
    `assert.match((await run(${JSON.stringify(`${literal.toLowerCase()}-suffix`)})).systemPrompt, /custom guidance/);
     assert.match((await run("gpt-5X4Zxax-b-end")).systemPrompt, /default guidance/);
     assert.equal(warnings.length, 0);`,
  );
});
