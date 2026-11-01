import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRules } from "./extension.js";

export default function rules(pi: ExtensionAPI): void {
  registerRules(pi);
}

export { type Diagnostic, loadRules, type RuleSet } from "./discovery.js";
export {
  REMINDER_MESSAGE,
  type RulesExtensionOptions,
  registerRules,
  SECTION_NAME,
} from "./extension.js";
export {
  DELIVERY_ENTRY,
  type DeliveryRecord,
  parseDeliveryRecord,
} from "./ledger.js";
export { READ_RULE_TOOL } from "./render.js";
export {
  parseRule,
  type Rule,
  type RuleMode,
  type RuleSource,
} from "./rule.js";
