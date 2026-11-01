import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { expect, it } from "vitest";
import { describeCall, matchesCondition } from "../src/match.js";
import { parseRule, type Rule } from "../src/rule.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

function examples(): Rule[] {
  return [...readme.matchAll(/^`([^`]+)`:\n\n```markdown\n([\s\S]*?)```$/gm)].map(([, path = "", text = ""]) => {
    const name = basename(path).replace(/\.mdc?$/, "");
    const result = parseRule(name, path, path.startsWith(".cursor") ? "project-cursor" : "project-pi", text);
    if (result.kind !== "rule") throw new Error(`${path}: ${JSON.stringify(result)}`);
    return result.rule;
  });
}

it("README examples parse into the modes they illustrate and match what they promise", () => {
  const rules = examples();
  expect(rules.map((rule) => [rule.name, rule.mode, rule.warnings])).toEqual([
    ["style", "always", []],
    ["http-handlers", "index", []],
    ["react", "glob", []],
    ["no-force-push", "block", []],
    ["ts-no-any", "remind", []],
  ]);
  const [, , , forcePush, noAny] = rules as [Rule, Rule, Rule, Rule, Rule];
  const cwd = "/work";
  expect(matchesCondition(forcePush, describeCall("bash", { command: "git push -f origin main" }, cwd))).toBe(true);
  expect(matchesCondition(forcePush, describeCall("bash", { command: "git push origin main" }, cwd))).toBe(false);
  expect(noAny.repeat).toEqual({ mode: "after-gap", gap: 20 });
  expect(matchesCondition(noAny, describeCall("write", { path: "a.ts", content: "const x = y as any;" }, cwd))).toBe(
    true,
  );
  expect(matchesCondition(noAny, describeCall("write", { path: "a.md", content: "const x = y as any;" }, cwd))).toBe(
    false,
  );
});
