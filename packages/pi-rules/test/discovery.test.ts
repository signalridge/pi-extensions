import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRules, MAX_RULE_FILE_BYTES } from "../src/discovery.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-rules-discovery-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const write = (dir: string, file: string, text: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  return {
    cwd,
    agentDir,
    project: (dir: string, file: string, text: string) => write(join(cwd, dir), file, text),
    user: (file: string, text: string) => write(join(agentDir, "rules"), file, text),
  };
}

const indexRule = (description: string) => `---\ndescription: ${description}\n---\nBody of ${description}`;

describe("loadRules", () => {
  it("dedupes by name with project .pi > .agents > .cursor > user precedence", () => {
    const f = fixture();
    f.user("shared.md", indexRule("user"));
    f.user("only-user.md", indexRule("only user"));
    f.project(".cursor/rules", "shared.mdc", indexRule("cursor"));
    f.project(".cursor/rules", "cursor-only.mdc", indexRule("cursor only"));
    f.project(".cursor/rules", "ignored.md", indexRule("wrong extension"));
    f.project(".agents/rules", "shared.md", indexRule("agents"));
    f.project(".pi/rules", "shared.md", indexRule("pi"));
    f.project(".pi/rules", "b.md", indexRule("b"));
    f.project(".pi/rules", "a.md", indexRule("a"));
    const set = loadRules({
      cwd: f.cwd,
      agentDir: f.agentDir,
      projectTrusted: true,
    });
    expect(set.rules.map((rule) => [rule.name, rule.source, rule.description])).toEqual([
      ["a", "project-pi", "a"],
      ["b", "project-pi", "b"],
      ["shared", "project-pi", "pi"],
      ["cursor-only", "project-cursor", "cursor only"],
      ["only-user", "user", "only user"],
    ]);
    expect(set.shadowed.map((entry) => [entry.source, entry.by])).toEqual([
      ["project-agents", join(f.cwd, ".pi/rules/shared.md")],
      ["project-cursor", join(f.cwd, ".pi/rules/shared.md")],
      ["user", join(f.cwd, ".pi/rules/shared.md")],
    ]);
    expect(set.diagnostics).toEqual([]);
  });

  it("reads no project rule when the project is not trusted, but still loads user rules", () => {
    const f = fixture();
    f.project(".pi/rules", "secret.md", indexRule("project"));
    f.project(".cursor/rules", "c.mdc", indexRule("cursor"));
    f.user("mine.md", indexRule("user"));
    const set = loadRules({
      cwd: f.cwd,
      agentDir: f.agentDir,
      projectTrusted: false,
    });
    expect(set.rules.map((rule) => rule.name)).toEqual(["mine"]);
    expect(set.projectTrusted).toBe(false);
    expect(set.diagnostics).toEqual([
      {
        level: "info",
        message: ".pi/rules: 1 rule file(s) not loaded because the project is not trusted",
      },
      {
        level: "info",
        message: ".cursor/rules: 1 rule file(s) not loaded because the project is not trusted",
      },
    ]);
  });

  it("lets a broken file keep its name, skips disabled files and reports warnings", () => {
    const f = fixture();
    f.project(".pi/rules", "broken.md", "---\nunknown: x\n---\nBody");
    f.project(".pi/rules", "off.md", "---\nenabled: false\n---\nBody");
    f.project(".pi/rules", "huge.md", "x".repeat(MAX_RULE_FILE_BYTES + 1));
    f.project(".pi/rules", "narrow.md", "---\ncondition: x\nscope: text, tool:bash\n---\nBody");
    f.user("broken.md", indexRule("user fallback"));
    f.user("off.md", indexRule("user takes over"));
    const set = loadRules({
      cwd: f.cwd,
      agentDir: f.agentDir,
      projectTrusted: true,
    });
    expect(set.rules.map((rule) => [rule.name, rule.source])).toEqual([
      ["narrow", "project-pi"],
      ["off", "user"],
    ]);
    expect(set.disabled.map((entry) => entry.name)).toEqual(["off"]);
    expect(set.shadowed.map((entry) => entry.path)).toEqual([join(f.agentDir, "rules/broken.md")]);
    expect(set.diagnostics.map((diagnostic) => [diagnostic.level, diagnostic.message])).toEqual([
      ["error", `${join(f.cwd, ".pi/rules/broken.md")}: unknown field "unknown"`],
      ["error", `${join(f.cwd, ".pi/rules/huge.md")}: larger than 64 KiB`],
      [
        "warning",
        `${join(f.cwd, ".pi/rules/narrow.md")}: scope "text" is ignored: matching assistant text is not supported`,
      ],
    ]);
  });
});
