import type { Rule } from "./rule.js";

export const READ_RULE_TOOL = "read_rule";

function attribute(value: string): string {
  return value.replace(/[&"<>]/g, (char) => `&#${char.charCodeAt(0)};`);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function globList(rule: Rule): string {
  return rule.globs.map((glob) => glob.pattern).join(", ");
}

/**
 * The system-prompt section: always-apply bodies, then the on-demand index.
 * It depends only on the loaded rule files, in discovery order, so the bytes
 * stay identical from run to run and the provider's prompt cache keeps hitting.
 */
export function renderSection(rules: readonly Rule[], readRuleAvailable: boolean): string | undefined {
  const always = rules.filter((rule) => rule.mode === "always");
  const indexed = rules.filter((rule) => (rule.mode === "index" || rule.mode === "glob") && rule.description);
  if (always.length === 0 && indexed.length === 0) return undefined;
  const parts: string[] = [];
  if (always.length > 0) {
    parts.push("These rules come from the project's and the user's rule files. Follow them while you work.");
    for (const rule of always) parts.push(`<rule name="${rule.name}">\n${rule.body}\n</rule>`);
  }
  if (indexed.length > 0) {
    parts.push(
      readRuleAvailable
        ? `More rules are available on demand. When one applies to your task, read it with the ${READ_RULE_TOOL} tool before acting.`
        : "More rules are available on demand. When one applies to your task, read its file before acting.",
    );
    parts.push(
      indexed
        .map((rule) => {
          const files = rule.globs.length > 0 ? ` (files: ${globList(rule)})` : "";
          const file = readRuleAvailable ? "" : ` [${rule.path}]`;
          return `- ${rule.name}${files}${file}: ${oneLine(rule.description ?? "")}`;
        })
        .join("\n"),
    );
  }
  return parts.join("\n\n");
}

export interface CallLabel {
  tool: string;
  path?: string;
}

function callText(call: CallLabel): string {
  return call.path ? `${call.tool} call for ${call.path}` : `${call.tool} call`;
}

function ruleBlock(rule: Rule): string {
  return `<rule name="${rule.name}">\n${rule.body}\n</rule>`;
}

function offerLine(rule: Rule, call: CallLabel): string {
  const about = rule.description ? `: ${oneLine(rule.description)}` : "";
  return `The rule "${rule.name}" applies to ${call.path ?? "this file"} (files: ${globList(rule)})${about}. Read it with ${READ_RULE_TOOL} before changing the file.`;
}

/** Hidden steering text for `remind` matches and glob offers; the call itself was not stopped by pi-rules. */
export function renderReminder(reminders: readonly Rule[], offers: readonly Rule[], call: CallLabel): string {
  const parts: string[] = [];
  const pathAttribute = call.path ? ` path="${attribute(call.path)}"` : "";
  for (const rule of reminders)
    parts.push(
      `<rule-reminder rule="${rule.name}" tool="${attribute(call.tool)}"${pathAttribute}>\nThe arguments of your ${callText(call)} matched this project or user rule. pi-rules did not stop the call. Check what you wrote against the rule: fix a real violation in your next steps, and leave anything the rule allows.\n\n${rule.body}\n</rule-reminder>`,
    );
  for (const rule of offers)
    parts.push(`<rule-offer rule="${rule.name}"${pathAttribute}>\n${offerLine(rule, call)}\n</rule-offer>`);
  return parts.join("\n\n");
}

/**
 * The tool error a blocked call returns. A block rule's text is quoted the
 * first time on a branch (and again after its repeat gap); later blocks name
 * the rule and point at `read_rule` instead of repeating it.
 */
export function renderBlock(
  blockers: readonly Rule[],
  quoted: ReadonlySet<string>,
  reminders: readonly Rule[],
  offers: readonly Rule[],
  call: CallLabel,
): string {
  const names = blockers.map((rule) => `"${rule.name}"`).join(", ");
  const parts = [
    `Blocked by ${blockers.length === 1 ? "rule" : "rules"} ${names}: the arguments of this ${callText(call)} match ${blockers.length === 1 ? "its" : "their"} condition. Nothing was executed. Change the call so it complies, then retry.`,
  ];
  for (const rule of blockers)
    parts.push(
      quoted.has(rule.name)
        ? ruleBlock(rule)
        : `Rule "${rule.name}" was quoted earlier on this branch; ${READ_RULE_TOOL} shows it again.`,
    );
  for (const rule of reminders) parts.push(`This call also matched the rule "${rule.name}":\n${ruleBlock(rule)}`);
  for (const rule of offers) parts.push(offerLine(rule, call));
  return parts.join("\n\n");
}
