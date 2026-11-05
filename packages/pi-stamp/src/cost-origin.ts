import type { AssistantStampCostOrigin } from "./metadata.js";

/** Optional extension-owned annotation; the pi-stamp v4 wire format is frozen. */
export const COST_ORIGIN_ENTRY_TYPE = "pi-stamp:cost-origin:v1";
export const MAX_COST_ORIGIN_REFERENCES = 4096;

export interface CostOriginAnnotation {
  version: 1;
  stampEntryId: string;
  cost: number;
  origin: AssistantStampCostOrigin;
}

export type CostOriginLookup = (stampEntryId: string, cost: number) => AssistantStampCostOrigin | undefined;

export function isStampEntryId(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{1,160}$/u.test(value);
}

export function isCostOriginAnnotation(value: unknown): value is CostOriginAnnotation {
  return (
    isRecord(value) &&
    Object.keys(value).length === 4 &&
    Object.keys(value).every((key) => ["version", "stampEntryId", "cost", "origin"].includes(key)) &&
    value.version === 1 &&
    isStampEntryId(value.stampEntryId) &&
    typeof value.cost === "number" &&
    Number.isFinite(value.cost) &&
    value.cost >= 0 &&
    (value.origin === "provider" || value.origin === "estimated" || value.origin === "unknown")
  );
}

/** Only earlier exact references on this branch count. Ambiguity fails closed. */
export function buildCostOriginLookup(
  entries: readonly unknown[],
  stampCost: (entry: unknown) => number | undefined,
): CostOriginLookup {
  const targets = new Map<string, number | undefined>();
  const annotations = new Map<string, CostOriginAnnotation | undefined>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const cost = stampCost(entry);
    if (cost !== undefined && isStampEntryId(entry.id)) {
      if (targets.size >= MAX_COST_ORIGIN_REFERENCES) return () => undefined;
      targets.set(entry.id, targets.has(entry.id) ? undefined : cost);
    }
    if (entry.type !== "custom" || entry.customType !== COST_ORIGIN_ENTRY_TYPE) continue;
    const data = entry.data;
    if (!isRecord(data) || !isStampEntryId(data.stampEntryId)) continue;
    if (annotations.size >= MAX_COST_ORIGIN_REFERENCES) return () => undefined;
    const valid =
      !annotations.has(data.stampEntryId) &&
      isCostOriginAnnotation(data) &&
      targets.get(data.stampEntryId) === data.cost;
    annotations.set(data.stampEntryId, valid ? data : undefined);
  }
  return (id, cost) => {
    const annotation = annotations.get(id);
    return annotation?.cost === cost && targets.get(id) === cost ? annotation.origin : undefined;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
