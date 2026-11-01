import { describe, expect, it } from "vitest";
import { FrontmatterError, parseRuleFile } from "../src/frontmatter.js";

const fields = (text: string) => Object.fromEntries(parseRuleFile(text).fields);

describe("parseRuleFile", () => {
  it("returns the whole text as body when there is no frontmatter", () => {
    expect(parseRuleFile("\uFEFF# Title\r\n\r\nBody\r\n")).toEqual({
      fields: new Map(),
      body: "# Title\n\nBody",
    });
  });

  it("reads scalars, booleans, quoted strings and both list forms in file order", () => {
    const parsed = parseRuleFile(
      [
        "---",
        "# a comment",
        "description: Plain text # trailing comment",
        "alwaysApply: true",
        "enabled: False",
        `condition: "await import\\\\(\\u0041"`,
        "interruptMode: 'it''s'",
        "scope: [tool:edit(*.ts), 'tool:write(*.{ts,tsx})', ]",
        "globs:",
        "  - src/**/*.ts",
        '  - "*.md"',
        "empty:",
        "---",
        "",
        "Rule body",
      ].join("\n"),
    );
    expect([...parsed.fields.keys()]).toEqual([
      "description",
      "alwaysApply",
      "enabled",
      "condition",
      "interruptMode",
      "scope",
      "globs",
      "empty",
    ]);
    expect(Object.fromEntries(parsed.fields)).toEqual({
      description: "Plain text",
      alwaysApply: true,
      enabled: false,
      condition: "await import\\(A",
      interruptMode: "it's",
      scope: ["tool:edit(*.ts)", "tool:write(*.{ts,tsx})"],
      globs: ["src/**/*.ts", "*.md"],
      empty: null,
    });
    expect(parsed.body).toBe("Rule body");
  });

  it("accepts Cursor's unquoted globs that YAML would read as an alias", () => {
    expect(fields("---\ndescription:\nglobs: *.tsx,src/**/*.ts\nalwaysApply: false\n---\nBody")).toEqual({
      description: null,
      globs: "*.tsx,src/**/*.ts",
      alwaysApply: false,
    });
  });

  it.each([
    ["---\ndescription: x\nBody", "line 3: expected `key: value`"],
    ["---\ndescription: x\n", "no closing --- line"],
    ["---\na: 1\na: 2\n---\nBody", 'line 3: duplicate field "a"'],
    ["---\ndescription: |\n  folded\n---\nBody", 'unsupported YAML syntax "|"'],
    ["---\ndescription: &anchor x\n---\nBody", 'unsupported YAML syntax "&"'],
    ["---\ndescription: one\n  two\n---\nBody", "multi-line values are not supported"],
    ["---\n- item\n---\nBody", "a list item must follow a key"],
    ['---\ncondition: "\\d+"\n---\nBody', "invalid escape \\d"],
    ['---\ndescription: "open\n---\nBody', "unterminated quoted string"],
    ["---\nscope: [a, [b]]\n---\nBody", "nested lists are not supported"],
    ["---\nscope: [a, b\n---\nBody", "unterminated [ list"],
    ['---\ndescription: "a" "b"\n---\nBody', "unexpected text after the value"],
  ])("rejects %j with a located error", (text, message) => {
    expect(() => parseRuleFile(text)).toThrow(FrontmatterError);
    expect(() => parseRuleFile(text)).toThrow(message);
  });
});
