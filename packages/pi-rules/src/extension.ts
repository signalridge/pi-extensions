import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadRules, type RuleSet, SOURCE_LABELS } from "./discovery.js";
import { DELIVERY_ENTRY, type DeliveryChannel, deliveryRecords, isDue, type Ledger, readLedger } from "./ledger.js";
import { type CallSubject, describeCall, matchesCondition, matchesGlobs } from "./match.js";
import { READ_RULE_TOOL, renderBlock, renderReminder, renderSection } from "./render.js";
import { report, ruleDetail, ruleRows, summary } from "./report.js";
import type { Rule } from "./rule.js";

/** System-prompt section key; Pi renders it as `<pi_rules>…</pi_rules>`. */
export const SECTION_NAME = "pi_rules";
/** Custom message type of the hidden steering reminder. */
export const REMINDER_MESSAGE = "pi-rules:reminder";

export interface RulesExtensionOptions {
  /** Agent directory for user rules; defaults to Pi's resolver, which honours `PI_CODING_AGENT_DIR`. */
  agentDir?: () => string;
}

const MAX_LISTED_NAMES = 50;

export function registerRules(pi: ExtensionAPI, options: RulesExtensionOptions = {}): void {
  const agentDir = options.agentDir ?? getAgentDir;
  let loaded: RuleSet | undefined;
  // Matches since this runtime loaded its rules; deliveries come from the branch instead.
  const matches = new Map<string, number>();

  const load = (ctx: ExtensionContext): RuleSet => {
    loaded = loadRules({
      cwd: ctx.cwd,
      agentDir: agentDir(),
      projectTrusted: ctx.isProjectTrusted(),
    });
    matches.clear();
    return loaded;
  };
  const current = (ctx: ExtensionContext): RuleSet => loaded ?? load(ctx);
  const ledgerOf = (ctx: ExtensionContext): Ledger => readLedger(ctx.sessionManager.getBranch());
  const record = (via: DeliveryChannel, rules: readonly Rule[]): void => {
    if (rules.length === 0) return;
    try {
      for (const batch of deliveryRecords(
        via,
        rules.map((rule) => rule.name),
      )) {
        pi.appendEntry(DELIVERY_ENTRY, batch);
      }
    } catch {
      // A failed append only means the rule may be delivered again later.
    }
  };

  pi.on("session_start", (_event, ctx) => {
    const set = load(ctx);
    if (ctx.hasUI && set.diagnostics.some((diagnostic) => diagnostic.level !== "info"))
      ctx.ui.notify(`${summary(set)}. Run /rules for details.`, "warning");
  });

  pi.on("session_shutdown", () => {
    loaded = undefined;
    matches.clear();
  });

  pi.on("before_agent_start", (event, ctx) => {
    const prompt = event.systemPromptOptions;
    const readable = prompt.selectedTools.includes(READ_RULE_TOOL) && !prompt.hiddenTools.includes(READ_RULE_TOOL);
    const section = renderSection(current(ctx).rules, readable);
    if (section) prompt.sections[SECTION_NAME] = section;
  });

  pi.on("tool_call", (event, ctx): ToolCallEventResult | undefined => {
    const set = current(ctx);
    if (set.rules.length === 0) return undefined;
    const call: CallSubject = describeCall(event.toolName, event.input, ctx.cwd);
    const matched = set.rules.filter((rule) => matchesCondition(rule, call));
    const touched = set.rules.filter((rule) => matchesGlobs(rule, call));
    if (matched.length === 0 && touched.length === 0) return undefined;
    for (const rule of [...matched, ...touched]) matches.set(rule.name, (matches.get(rule.name) ?? 0) + 1);

    const ledger = ledgerOf(ctx);
    const due = (rule: Rule) => isDue(rule, ledger);
    const blockers = matched.filter((rule) => rule.mode === "block");
    const reminders = matched.filter((rule) => rule.mode === "remind" && due(rule));
    const offers = touched.filter(due);
    const label = { tool: call.tool, path: call.paths[0] };
    if (blockers.length > 0) {
      const quoted = blockers.filter(due);
      record("block", [...quoted, ...reminders, ...offers]);
      return {
        block: true,
        reason: renderBlock(blockers, new Set(quoted.map((rule) => rule.name)), reminders, offers, label),
      };
    }
    if (reminders.length === 0 && offers.length === 0) return undefined;
    record(reminders.length > 0 ? "reminder" : "offer", [...reminders, ...offers]);
    pi.sendMessage(
      {
        customType: REMINDER_MESSAGE,
        content: renderReminder(reminders, offers, label),
        display: false,
        details: {
          rules: [...reminders, ...offers].map((rule) => rule.name),
          tool: call.tool,
        },
      },
      { deliverAs: "steer" },
    );
    return undefined;
  });

  pi.registerTool(
    defineTool({
      name: READ_RULE_TOOL,
      label: "Read rule",
      description:
        "Return the full text of a loaded project or user rule by name. Rule names come from the rule index in the system prompt and from rule reminders.",
      promptSnippet: "Read a project or user rule by name",
      parameters: Type.Object(
        {
          name: Type.String({
            minLength: 1,
            maxLength: 64,
            description: "The rule name, as listed in the rule index or a rule reminder",
          }),
        },
        { additionalProperties: false },
      ),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const set = current(ctx);
        const rule = set.rules.find((candidate) => candidate.name === params.name);
        if (!rule) {
          const names = set.rules.map((candidate) => candidate.name);
          const listed = names.slice(0, MAX_LISTED_NAMES).join(", ") || "none";
          const more = names.length > MAX_LISTED_NAMES ? ` and ${names.length - MAX_LISTED_NAMES} more` : "";
          throw new Error(`Unknown rule ${JSON.stringify(params.name)}. Loaded rules: ${listed}${more}.`);
        }
        record("read", [rule]);
        return {
          content: [
            {
              type: "text",
              text: `Rule "${rule.name}" (${SOURCE_LABELS[rule.source]}):\n\n${rule.body}`,
            },
          ],
          details: {
            name: rule.name,
            source: rule.source,
            path: rule.path,
            mode: rule.mode,
          },
        };
      },
    }),
  );

  pi.registerCommand("rules", {
    description: "List loaded rule files, their modes and matches, and any rule file errors",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const set = current(ctx);
      const ledger = ledgerOf(ctx);
      const name = args.trim();
      if (name) {
        const rule = set.rules.find((candidate) => candidate.name === name);
        ctx.ui.notify(
          rule ? ruleDetail(rule, matches, ledger) : `pi-rules: no loaded rule named ${JSON.stringify(name)}`,
          rule ? "info" : "warning",
        );
        return;
      }
      const level = set.diagnostics.some((diagnostic) => diagnostic.level === "error") ? "warning" : "info";
      const rows = ruleRows(set, matches, ledger);
      if (ctx.mode !== "tui" || rows.length === 0) {
        ctx.ui.notify(report(set, matches, ledger), level);
        return;
      }
      // TUI: browse the rules; the full report (including diagnostics) stays one entry away.
      const reportLabel = `Full report (${set.diagnostics.length} diagnostics)`;
      const choice = await ctx.ui.select(summary(set), [...rows.map((row) => row.label), reportLabel]);
      if (choice === undefined) return;
      const row = rows.find((candidate) => candidate.label === choice);
      ctx.ui.notify(row ? ruleDetail(row.rule, matches, ledger) : report(set, matches, ledger), row ? "info" : level);
    },
  });
}
