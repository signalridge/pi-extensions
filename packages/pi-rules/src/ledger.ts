import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { RULE_NAME, type Rule } from "./rule.js";

/**
 * Delivery records live on the session branch as `pi-rules:delivered` custom
 * entries (never sent to the model). Repeat state is always recomputed from
 * the current branch, so `/reload`, resume and `/tree` need no extra wiring:
 * a delivery on an abandoned branch is simply not on the path any more.
 */
export const DELIVERY_ENTRY = "pi-rules:delivered";

export type DeliveryChannel = "reminder" | "block" | "offer" | "read";
const CHANNELS: ReadonlySet<string> = new Set<DeliveryChannel>(["reminder", "block", "offer", "read"]);
const MAX_RULES_PER_ENTRY = 64;

export interface DeliveryRecord {
  v: 1;
  via: DeliveryChannel;
  rules: string[];
}

export interface Ledger {
  /** Assistant responses on the branch; `after-gap` counts these. */
  turns: number;
  /** For each rule, the value of `turns` when it was last delivered. */
  lastDelivered: ReadonlyMap<string, number>;
  deliveries: ReadonlyMap<string, number>;
}

export function deliveryRecord(via: DeliveryChannel, rules: readonly string[]): DeliveryRecord {
  return { v: 1, via, rules: [...rules] };
}

export function deliveryRecords(via: DeliveryChannel, rules: readonly string[]): DeliveryRecord[] {
  const records: DeliveryRecord[] = [];
  for (let at = 0; at < rules.length; at += MAX_RULES_PER_ENTRY) {
    records.push(deliveryRecord(via, rules.slice(at, at + MAX_RULES_PER_ENTRY)));
  }
  return records;
}

export function parseDeliveryRecord(data: unknown): DeliveryRecord | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  if (record.v !== 1 || typeof record.via !== "string" || !CHANNELS.has(record.via)) return undefined;
  const rules = record.rules;
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > MAX_RULES_PER_ENTRY) return undefined;
  if (!rules.every((name): name is string => typeof name === "string" && RULE_NAME.test(name))) return undefined;
  return { v: 1, via: record.via as DeliveryChannel, rules: [...rules] };
}

export function readLedger(branch: readonly SessionEntry[]): Ledger {
  let turns = 0;
  const lastDelivered = new Map<string, number>();
  const deliveries = new Map<string, number>();
  for (const entry of branch) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      turns++;
      continue;
    }
    if (entry.type !== "custom" || entry.customType !== DELIVERY_ENTRY) continue;
    const record = parseDeliveryRecord(entry.data);
    if (!record) continue;
    for (const name of record.rules) {
      lastDelivered.set(name, turns);
      deliveries.set(name, (deliveries.get(name) ?? 0) + 1);
    }
  }
  return { turns, lastDelivered, deliveries };
}

/** Whether a rule's text should be delivered again under its repeat policy. */
export function isDue(rule: Rule, ledger: Ledger): boolean {
  const at = ledger.lastDelivered.get(rule.name);
  if (at === undefined) return true;
  return rule.repeat.mode === "after-gap" && ledger.turns - at >= rule.repeat.gap;
}
