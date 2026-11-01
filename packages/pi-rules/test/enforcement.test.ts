import { sep } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { normalizeToolPath } from "../src/glob.js";
import { DELIVERY_ENTRY, deliveryRecord, isDue, parseDeliveryRecord, readLedger } from "../src/ledger.js";
import { describeCall, matchesCondition, matchesGlobs } from "../src/match.js";
import { renderBlock, renderReminder, renderSection } from "../src/render.js";
import { parseRule, type Rule } from "../src/rule.js";

function rule(name: string, frontmatter: string, body = `Body of ${name}`): Rule {
  const result = parseRule(name, `/rules/${name}.md`, "project-pi", `---\n${frontmatter}\n---\n${body}`);
  if (result.kind !== "rule") throw new Error(JSON.stringify(result));
  return result.rule;
}

const cwd = "/work/project";

describe("describeCall", () => {
  it("reads the replacement text, written content or command, and cwd-relative paths", () => {
    expect(
      describeCall(
        "edit",
        {
          path: "/work/project/src/a.ts",
          edits: [{ oldText: "old any", newText: "new 1" }, { newText: "new 2" }],
        },
        cwd,
      ),
    ).toEqual({ tool: "edit", texts: ["new 1", "new 2"], paths: ["src/a.ts"] });
    expect(describeCall("write", { path: "@docs/x.md", content: "text" }, cwd)).toEqual({
      tool: "write",
      texts: ["text"],
      paths: ["docs/x.md"],
    });
    expect(describeCall("bash", { command: "git push --force" }, cwd)).toEqual({
      tool: "bash",
      texts: ["git push --force"],
      paths: [],
    });
    expect(describeCall("read", { path: "../outside.ts" }, cwd)).toEqual({
      tool: "read",
      texts: [],
      paths: ["/work/outside.ts"],
    });
  });
});

it("normalizes file URLs without trimming valid path bytes and rejects malformed URLs", () => {
  expect(normalizeToolPath(cwd, "file:///work/project/src/space%20%E9%9B%AA.ts")).toBe("src/space 雪.ts");
  expect(normalizeToolPath(cwd, "file:///work/outside.ts")).toBe("/work/outside.ts");
  expect(normalizeToolPath(cwd, " src/a.ts ")).toBe(" src/a.ts ");
  expect(normalizeToolPath(cwd, "file:///work/project/src/%20space%20%E9%9B%AA.ts%20")).toBe("src/ space 雪.ts ");
  if (sep === "/") {
    expect(normalizeToolPath(cwd, "file:src/a.ts")).toBe("file:src/a.ts");
    expect(normalizeToolPath(cwd, "file:/src/a.ts")).toBe("file:/src/a.ts");
    expect(normalizeToolPath(cwd, "FILE://src/a.ts")).toBe("FILE:/src/a.ts");
    expect(normalizeToolPath(cwd, "FILE:///work/project/src/a.ts")).toBe("FILE:/work/project/src/a.ts");
  }
  if (sep === "/") expect(normalizeToolPath(cwd, "file:///work/project/src/a%5Cb.ts")).toBe("src/a\\b.ts");
  for (const value of ["file://remote/work/project/src/a.ts", "file:///src/%ZZ", "file:///src/a%2Fb.ts"])
    expect(normalizeToolPath(cwd, value)).toBeUndefined();
});

describe("matching", () => {
  const anyRule = rule("no-any", "condition: ':\\s*any\\b'\nscope: tool:edit(*.ts), tool:write(*.ts)");
  const forcePush = rule("no-force-push", "condition: 'git push .*--force'\nscope: tool:bash\nenforce: block");
  const docsOnly = rule("docs-tone", "condition: '(?i)simply'\nglobs: docs/**");
  const react = rule("react", "description: React conventions\nglobs: src/**/*.tsx");

  it("checks scope tool, scope path, rule globs and the condition", () => {
    const ts = describeCall("write", { path: "src/a.ts", content: "let x: any" }, cwd);
    const md = describeCall("write", { path: "src/a.md", content: "let x: any" }, cwd);
    expect(matchesCondition(anyRule, ts)).toBe(true);
    expect(matchesCondition(anyRule, md)).toBe(false);
    expect(matchesCondition(anyRule, describeCall("bash", { command: "echo x: any" }, cwd))).toBe(false);
    expect(matchesCondition(forcePush, describeCall("bash", { command: "git push origin --force" }, cwd))).toBe(true);
    expect(matchesCondition(forcePush, describeCall("bash", { command: "git push origin" }, cwd))).toBe(false);
    expect(matchesCondition(docsOnly, describeCall("write", { path: "docs/a.md", content: "Simply" }, cwd))).toBe(true);
    expect(matchesCondition(docsOnly, describeCall("write", { path: "src/a.md", content: "Simply" }, cwd))).toBe(false);
    expect(matchesCondition(docsOnly, describeCall("bash", { command: "simply" }, cwd))).toBe(false);
  });

  it("offers glob rules for any tool that touches a matching path", () => {
    expect(matchesGlobs(react, describeCall("read", { path: "src/ui/App.tsx" }, cwd))).toBe(true);
    expect(matchesGlobs(react, describeCall("read", { path: "src/ui/App.ts" }, cwd))).toBe(false);
    expect(matchesGlobs(docsOnly, describeCall("read", { path: "docs/a.md" }, cwd))).toBe(false);
  });
});

function message(role: "user" | "assistant", id: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "",
    message:
      role === "user"
        ? { role, content: "u", timestamp: 0 }
        : {
            role,
            content: [],
            api: "x",
            provider: "x",
            model: "x",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop",
            timestamp: 0,
          },
  } as SessionEntry;
}

function delivered(id: string, data: unknown): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "",
    customType: DELIVERY_ENTRY,
    data,
  } as SessionEntry;
}

describe("ledger", () => {
  const once = rule("once", "description: d");
  const gap = rule("gap", "description: d\nrepeatMode: after-gap\nrepeatGap: 2");

  it("counts assistant turns and deliveries on the given branch only", () => {
    const branch = [
      message("user", "1"),
      message("assistant", "2"),
      delivered("3", deliveryRecord("reminder", ["once", "gap"])),
      delivered("4", { v: 2, via: "reminder", rules: ["gap"] }),
      delivered("5", { v: 1, via: "reminder", rules: ["../bad name"] }),
      message("assistant", "6"),
    ];
    const ledger = readLedger(branch);
    expect(ledger.turns).toBe(2);
    expect(Object.fromEntries(ledger.lastDelivered)).toEqual({
      once: 1,
      gap: 1,
    });
    expect(isDue(once, ledger)).toBe(false);
    expect(isDue(gap, ledger)).toBe(false);
    expect(isDue(gap, readLedger([...branch, message("assistant", "7")]))).toBe(true);
    expect(isDue(once, readLedger(branch.slice(0, 2)))).toBe(true);
  });

  it("validates delivery records at the persistence boundary", () => {
    expect(parseDeliveryRecord(deliveryRecord("read", ["a"]))).toEqual({
      v: 1,
      via: "read",
      rules: ["a"],
    });
    for (const data of [null, [], { v: 1, via: "x", rules: ["a"] }, { v: 1, via: "read", rules: [] }, "a"])
      expect(parseDeliveryRecord(data)).toBeUndefined();
  });
});

describe("rendering", () => {
  const always = rule("style", "alwaysApply: true", "Use tabs.");
  const indexed = rule("api", "description: How   handlers are shaped");
  const globbed = rule("react", "description: React conventions\nglobs: src/**/*.tsx");
  const manual = rule("manual", "globs:");
  const enforced = rule("enforced", "condition: x");

  it("renders a byte-stable section from always rules and the index, never enforced or manual rules", () => {
    const rules = [always, indexed, globbed, manual, enforced];
    const section = renderSection(rules, true);
    expect(section).toBe(
      [
        "These rules come from the project's and the user's rule files. Follow them while you work.",
        '<rule name="style">\nUse tabs.\n</rule>',
        "More rules are available on demand. When one applies to your task, read it with the read_rule tool before acting.",
        "- api: How handlers are shaped\n- react (files: src/**/*.tsx): React conventions",
      ].join("\n\n"),
    );
    expect(renderSection(rules, true)).toBe(section);
    expect(renderSection(rules, false)).toContain("- api [/rules/api.md]: How handlers are shaped");
    expect(renderSection([manual, enforced], true)).toBeUndefined();
  });

  it("quotes a block rule only when it is due and attaches other matched rules", () => {
    const blocker = rule("blocker", "condition: x\nenforce: block", "Never x.");
    const call = { tool: "bash" };
    expect(renderBlock([blocker], new Set(["blocker"]), [], [], call)).toBe(
      'Blocked by rule "blocker": the arguments of this bash call match its condition. Nothing was executed. Change the call so it complies, then retry.\n\n<rule name="blocker">\nNever x.\n</rule>',
    );
    expect(renderBlock([blocker], new Set(), [enforced], [], call)).toContain(
      'Rule "blocker" was quoted earlier on this branch; read_rule shows it again.\n\nThis call also matched the rule "enforced":\n<rule name="enforced">\nBody of enforced\n</rule>',
    );
  });

  it("renders reminders with the call and offers that name the rule", () => {
    const text = renderReminder([enforced], [globbed], {
      tool: "write",
      path: 'src/"a".tsx',
    });
    expect(text).toContain('<rule-reminder rule="enforced" tool="write" path="src/&#34;a&#34;.tsx">');
    expect(text).toContain('The arguments of your write call for src/"a".tsx matched this project or user rule.');
    expect(text).toContain(
      'The rule "react" applies to src/"a".tsx (files: src/**/*.tsx): React conventions. Read it with read_rule before changing the file.',
    );
  });
});
