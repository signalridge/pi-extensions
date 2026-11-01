import { type RuleSet, SOURCE_LABELS } from "./discovery.js";
import type { Ledger } from "./ledger.js";
import type { Rule } from "./rule.js";

export interface RuleRow {
  rule: Rule;
  label: string;
}

function counts(rule: Rule, matches: ReadonlyMap<string, number>, ledger: Ledger): string {
  return `${matches.get(rule.name) ?? 0} matches, ${ledger.deliveries.get(rule.name) ?? 0} delivered`;
}

export function ruleRows(set: RuleSet, matches: ReadonlyMap<string, number>, ledger: Ledger): RuleRow[] {
  return set.rules.map((rule) => ({
    rule,
    label: `${rule.name}  ${rule.mode}  ${SOURCE_LABELS[rule.source]}  (${counts(rule, matches, ledger)})`,
  }));
}

export function summary(set: RuleSet): string {
  const errors = set.diagnostics.filter((diagnostic) => diagnostic.level === "error").length;
  const warnings = set.diagnostics.filter((diagnostic) => diagnostic.level === "warning").length;
  const parts = [`${set.rules.length} loaded`];
  if (errors > 0) parts.push(`${errors} rejected`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
  if (set.shadowed.length > 0) parts.push(`${set.shadowed.length} shadowed`);
  if (set.disabled.length > 0) parts.push(`${set.disabled.length} disabled`);
  return `pi-rules: ${parts.join(", ")}${set.projectTrusted ? "" : "; project rules skipped (project not trusted)"}`;
}

export function ruleDetail(rule: Rule, matches: ReadonlyMap<string, number>, ledger: Ledger): string {
  const lines = [`${rule.name} (${rule.mode}, ${SOURCE_LABELS[rule.source]})`, `File: ${rule.path}`];
  if (rule.description) lines.push(`Description: ${rule.description}`);
  if (rule.globs.length > 0) lines.push(`Globs: ${rule.globs.map((glob) => glob.pattern).join(", ")}`);
  if (rule.conditions.length > 0) {
    lines.push(`Conditions: ${rule.conditions.map((condition) => String(condition)).join(", ")}`);
    lines.push(
      `Scope: ${rule.scope.map((scope) => (scope.path ? `${scope.tool}(${scope.path.pattern})` : scope.tool)).join(", ")}`,
    );
  }
  lines.push(`Repeat: ${rule.repeat.mode === "once" ? "once per branch" : `after ${rule.repeat.gap} turns`}`);
  lines.push(
    `Activity: ${matches.get(rule.name) ?? 0} matches since load, ${ledger.deliveries.get(rule.name) ?? 0} delivered on this branch`,
  );
  for (const warning of rule.warnings) lines.push(`Warning: ${warning}`);
  return lines.join("\n");
}

/** The plain-text report used outside the TUI (and for `/rules` with no rules to browse). */
export function report(set: RuleSet, matches: ReadonlyMap<string, number>, ledger: Ledger): string {
  const lines = [summary(set)];
  for (const row of ruleRows(set, matches, ledger)) lines.push(`- ${row.label}`);
  for (const entry of set.shadowed) lines.push(`- shadowed: ${entry.path} (by ${entry.by})`);
  for (const entry of set.disabled) lines.push(`- disabled: ${entry.path}`);
  for (const diagnostic of set.diagnostics) lines.push(`${diagnostic.level}: ${diagnostic.message}`);
  if (set.rules.length === 0 && set.diagnostics.length === 0)
    lines.push("No rule files found in .pi/rules, .agents/rules, .cursor/rules or the user rules directory.");
  return lines.join("\n");
}
