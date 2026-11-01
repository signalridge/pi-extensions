import { describe, expect, it } from "vitest";
import { compileGlob } from "../src/glob.js";
import { parseRule, type Rule } from "../src/rule.js";

function rule(frontmatter: string, body = "Rule body"): Rule {
  const result = parseRule("sample", "/rules/sample.md", "project-pi", `---\n${frontmatter}\n---\n${body}`);
  if (result.kind !== "rule") throw new Error(`expected a rule, got ${JSON.stringify(result)}`);
  return result.rule;
}

function error(frontmatter: string, body = "Rule body"): string {
  const result = parseRule("sample", "/rules/sample.md", "project-pi", `---\n${frontmatter}\n---\n${body}`);
  if (result.kind !== "error") throw new Error(`expected an error, got ${result.kind}`);
  return result.error;
}

describe("rule modes", () => {
  it.each([
    ["description: d\nalwaysApply: true", "always"],
    ["description: d\nglobs: '*.ts'", "glob"],
    ["description: d", "index"],
    ["globs:", "manual"],
    ["condition: foo", "remind"],
    ["condition: foo\nenforce: block", "block"],
    ["condition: foo\ninterruptMode: never", "remind"],
    ["condition: foo\ninterruptMode: prose-only", "remind"],
    ["condition: foo\ninterruptMode: tool-only", "block"],
    ["condition: foo\ninterruptMode: always", "block"],
  ])("%j is %s", (frontmatter, mode) => {
    expect(rule(frontmatter).mode).toBe(mode);
  });

  it("parses an oh-my-pi bundled rule unchanged", () => {
    const parsed = rule(
      [
        'description: "Do not use `await import()`"',
        'condition: "await import\\\\("',
        'scope: "tool:edit(*.ts), tool:edit(*.tsx), tool:write(*.ts), tool:write(*.tsx)"',
        "interruptMode: never",
      ].join("\n"),
    );
    expect(parsed).toMatchObject({
      mode: "remind",
      repeat: { mode: "once" },
      warnings: [],
    });
    expect(parsed.conditions.map(String)).toEqual(["/await import\\(/"]);
    expect(parsed.scope.map((scope) => `${scope.tool}(${scope.path?.pattern})`)).toEqual([
      "edit(*.ts)",
      "edit(*.tsx)",
      "write(*.ts)",
      "write(*.tsx)",
    ]);
  });

  it("defaults a condition's scope to every checkable tool and translates inline flags", () => {
    const parsed = rule('condition: ["(?i)force", "(?ms)a.b"]');
    expect(parsed.scope.map((scope) => scope.tool)).toEqual(["edit", "write", "bash", "powershell"]);
    expect(parsed.conditions.map(String)).toEqual(["/force/i", "/a.b/ms"]);
  });

  it("expands `tool` to the checkable tools, keeping a path glob only where a call has a path", () => {
    expect(
      rule("condition: x\nscope: tool(*.ts)").scope.map((scope) => `${scope.tool}:${scope.path?.pattern}`),
    ).toEqual(["edit:*.ts", "write:*.ts"]);
    expect(rule("condition: x\nscope: [toolcall]").scope).toHaveLength(4);
  });

  it("warns about scope it cannot check instead of silently widening or dropping the rule", () => {
    const parsed = rule("condition: x\nscope: text, thinking, tool:read(*.env), tool:bash");
    expect(parsed.scope).toEqual([{ tool: "bash" }]);
    expect(parsed.warnings).toEqual([
      'scope "text" is ignored: matching assistant text is not supported',
      'scope "thinking" is ignored: matching assistant thinking is not supported',
      'scope "tool:read(*.env)" is ignored: only edit, write, bash, powershell arguments can be checked',
    ]);
  });

  it("reads repeat policy", () => {
    expect(rule("description: d\nrepeatMode: after-gap").repeat).toEqual({
      mode: "after-gap",
      gap: 10,
    });
    expect(rule("description: d\nrepeatMode: after-gap\nrepeatGap: 3").repeat).toEqual({ mode: "after-gap", gap: 3 });
  });

  it("splits comma-separated globs outside braces", () => {
    expect(rule("globs: '*.{ts,tsx}, docs/**'").globs.map((glob) => glob.pattern)).toEqual(["*.{ts,tsx}", "docs/**"]);
  });

  it("returns disabled files without validating the rest", () => {
    expect(parseRule("sample", "/r/sample.md", "user", "---\nenabled: false\n---\n")).toEqual({
      kind: "disabled",
      name: "sample",
    });
  });
});

describe("rule errors", () => {
  it.each([
    ["owner: me", 'unknown field "owner"'],
    ["astCondition: foo($A)", '"astCondition" is not supported'],
    ["question: Is it wrong?", "model-judged rules are not supported"],
    ["agents: main", "per-agent rule scoping is not supported"],
    ["ttsr_trigger: foo", "rename it to `condition`"],
    ["condition: '*.rs'", "It looks like a file glob"],
    ["condition: '(unclosed'", "invalid condition"],
    ["condition: []", '"condition" has no patterns'],
    ["condition: x\nscope: text", "no scope Pi can check"],
    ["condition: x\nscope: bash(*.sh)", "bash calls have no path"],
    ["condition: x\nscope: '!!!'", "invalid scope token"],
    ["condition: x\nenforce: deny", '"enforce" must be block or remind'],
    ["condition: x\ninterruptMode: sometimes", '"interruptMode" must be one of'],
    ["condition: x\nenforce: block\ninterruptMode: always", "not both"],
    ["alwaysApply: 'true'", '"alwaysApply" must be true or false'],
    ["description: [a]", '"description" must be a string'],
    ["globs: 'src/{a'", "has an unclosed {"],
    ["repeatGap: 3", '"repeatGap" needs "repeatMode: after-gap"'],
    ["repeatMode: after-gap\nrepeatGap: 0", '"repeatGap" must be a whole number'],
    ["repeatMode: sometimes", '"repeatMode" must be once or after-gap'],
  ])("%j is rejected", (frontmatter, message) => {
    expect(error(frontmatter)).toContain(message);
  });

  it("rejects an empty body and an unsafe file name", () => {
    expect(error("description: d", "")).toContain("no text after its frontmatter");
    expect(parseRule("my rule", "/r/my rule.md", "user", "Body")).toMatchObject({ kind: "error" });
  });

  it("warns when fields have no effect", () => {
    expect(rule("description: d\nscope: tool:edit\nenforce: block").warnings).toEqual([
      '"scope" has no effect without "condition"',
      '"enforce" has no effect without "condition"',
    ]);
    expect(rule("condition: x\nalwaysApply: true").warnings).toEqual([
      '"alwaysApply" is ignored because the rule has a condition',
    ]);
  });
});

describe("compileGlob", () => {
  it.each([
    ["*.ts", "src/deep/a.ts", true],
    ["*.ts", "a.tsx", false],
    ["src/**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "src/x/y/a.ts", true],
    ["src/**/*.ts", "lib/a.ts", false],
    ["**/*.md", "README.md", true],
    ["docs/**", "docs/a/b.md", true],
    ["src/*.ts", "src/x/a.ts", false],
    ["*.{ts,{tsx,mts}}", "a.mts", true],
    ["file?.txt", "file1.txt", true],
    ["[!a]*.ts", "b.ts", true],
    ["[!a]*.ts", "a.ts", false],
    ["./a.(x).ts", "a.(x).ts", true],
  ])("%s matches %s: %s", (pattern, path, expected) => {
    expect(compileGlob(pattern).matches(path)).toBe(expected);
  });
});
