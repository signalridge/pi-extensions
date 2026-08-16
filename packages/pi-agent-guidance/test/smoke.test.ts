import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import agentGuidance from "../agent-guidance.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function manifest(): {
  pi?: { extensions?: string[]; skills?: unknown };
  files?: string[];
} {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
}

test("registers provider guidance lifecycle handling", () => {
  const events: string[] = [];
  agentGuidance({ on: (event: string) => events.push(event) } as never);
  assert.deepEqual(events, ["before_agent_start"]);
});

test("templates are shipped as context files, never declared as Agent Skills", () => {
  const pkg = manifest();

  assert.deepEqual(pkg.pi?.extensions, ["./agent-guidance.ts"]);
  // The README tells users to symlink templates/CLAUDE.md out of the installed
  // package, so the directory has to survive into the published tarball.
  assert.ok(pkg.files?.includes("templates"), "templates must stay packaged for the README's symlink instruction");

  for (const template of ["CLAUDE.md", "CODEX.md", "GEMINI.md"]) {
    const contents = readFileSync(join(packageRoot, "templates", template), "utf8");
    assert.ok(!contents.startsWith("---"), `${template} is a context file and carries no skill frontmatter`);
  }

  // The invariant is not "never ship a skill" — it is that anything declared as one
  // really is loadable. Skill loading needs frontmatter carrying a description; a
  // context file has none, so declaring it would warn every user instead of loading.
  const skills = pkg.pi?.skills;
  assert.ok(skills === undefined || Array.isArray(skills), "pi.skills must be a list of paths when present");
  for (const skill of Array.isArray(skills) ? skills : []) {
    assert.equal(typeof skill, "string", "each declared skill is a path");
    const contents = readFileSync(join(packageRoot, String(skill)), "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(contents);
    assert.ok(frontmatter, `${skill} must open with a frontmatter block`);
    assert.match(frontmatter[1], /^description:\s*\S/mu, `${skill} must declare a non-empty description`);
  }
});
