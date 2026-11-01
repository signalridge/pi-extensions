import {
  normalizePlanModeCompletion,
  PLAN_MODE_COMPLETE_TOOL_NAME,
  planFromCompletionDetails,
} from "./completion-tool.js";
import type { ImplementationModelHandoff } from "./implementation-model.js";
import {
  IMPLEMENTATION_PLAN_RETENTIONS,
  type ImplementationPlanRetention,
  PLAN_MODE_THINKING_LEVELS,
  type PlanModeFixedThinkingLevel,
  type PlanModeModelReference,
} from "./settings.js";

const MAX_PERSISTED_MODEL_FIELD_LENGTH = 512;

export type PlanCompletionSource = typeof PLAN_MODE_COMPLETE_TOOL_NAME | "legacy_proposed_plan";

export interface ActiveImplementationPlan {
  id: string;
  plan: string;
  source: PlanCompletionSource;
  startedAt: number;
  retention?: ImplementationPlanRetention;
}

export interface SavedPlan {
  plan: string;
  source: PlanCompletionSource;
}

export interface PlanModeState {
  enabled: boolean;
  latestPlan?: string;
  latestPlanSource?: PlanCompletionSource;
  awaitingAction: boolean;
  savedPlan?: SavedPlan;
  activeImplementation?: ActiveImplementationPlan;
  selectedToolNames?: string[];
  selectedToolKeys?: string[];
  previousThinkingLevel?: PlanModeFixedThinkingLevel;
  appliedThinkingLevel?: PlanModeFixedThinkingLevel;
  manualThinkingLevel?: PlanModeFixedThinkingLevel;
  /** Present only after an implementation handoff switched model or thinking; never while planning. */
  modelHandoff?: ImplementationModelHandoff;
  /** Native entry boundary after the handoff's own model/thinking selections. */
  modelHandoffBoundary?: string;
}

type SessionEntry = {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: {
    role?: string;
    toolName?: string;
    details?: unknown;
  };
};

export function restorePlanModeState(entries: unknown[], stateEntryType: string): PlanModeState {
  const branch = entries as SessionEntry[];
  let stateEntryIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const candidate = branch[index];
    if (candidate?.type === "custom" && candidate.customType === stateEntryType) {
      stateEntryIndex = index;
      break;
    }
  }
  const entry = branch[stateEntryIndex];
  if (!isRecord(entry?.data)) return { enabled: false, awaitingAction: false };

  const enabled = entry.data.enabled === true;
  const persistedSource = enabled ? planCompletionSource(entry.data.latestPlanSource) : undefined;
  const persistedPlan = enabled ? normalizePersistedPlan(entry.data.latestPlan) : undefined;
  const recoveredPlan = enabled && !persistedPlan ? latestCompletionPlan(branch.slice(stateEntryIndex + 1)) : undefined;
  const latestPlan = persistedPlan ?? recoveredPlan;
  const activeImplementation = enabled ? undefined : normalizeActiveImplementation(entry.data.activeImplementation);
  const savedPlan = enabled || activeImplementation ? undefined : normalizeSavedPlan(entry.data.savedPlan);
  return {
    enabled,
    latestPlan,
    latestPlanSource: enabled
      ? ((persistedPlan ? persistedSource : undefined) ?? (recoveredPlan ? PLAN_MODE_COMPLETE_TOOL_NAME : undefined))
      : undefined,
    awaitingAction: enabled && latestPlan !== undefined,
    savedPlan,
    activeImplementation,
    selectedToolNames: stringArray(entry.data.selectedToolNames),
    selectedToolKeys: stringArray(entry.data.selectedToolKeys),
    previousThinkingLevel: enabled ? fixedThinkingLevel(entry.data.previousThinkingLevel) : undefined,
    appliedThinkingLevel: enabled ? fixedThinkingLevel(entry.data.appliedThinkingLevel) : undefined,
    manualThinkingLevel: enabled ? fixedThinkingLevel(entry.data.manualThinkingLevel) : undefined,
    modelHandoff: enabled ? undefined : normalizeModelHandoff(entry.data.modelHandoff),
    modelHandoffBoundary:
      !enabled && typeof entry.data.modelHandoffBoundary === "string" && entry.data.modelHandoffBoundary.length <= 128
        ? entry.data.modelHandoffBoundary
        : undefined,
  };
}

function normalizeModelHandoff(value: unknown): ImplementationModelHandoff | undefined {
  if (!isRecord(value)) return undefined;
  const appliedModel = modelReference(value.appliedModel);
  const previousModel = appliedModel ? modelReference(value.previousModel) : undefined;
  const thinkingModel = modelReference(value.thinkingModel);
  const appliedThinkingLevel =
    appliedModel || thinkingModel ? fixedThinkingLevel(value.appliedThinkingLevel) : undefined;
  const previousThinkingLevel = appliedThinkingLevel ? fixedThinkingLevel(value.previousThinkingLevel) : undefined;
  const handoff: ImplementationModelHandoff = {
    ...(appliedModel ? { appliedModel } : {}),
    ...(previousModel ? { previousModel } : {}),
    ...(appliedThinkingLevel && previousThinkingLevel
      ? { appliedThinkingLevel, previousThinkingLevel, ...(thinkingModel ? { thinkingModel } : {}) }
      : {}),
  };
  return Object.keys(handoff).length > 0 ? handoff : undefined;
}

function modelReference(value: unknown): PlanModeModelReference | undefined {
  if (!isRecord(value)) return undefined;
  const { provider, id } = value;
  return typeof provider === "string" &&
    typeof id === "string" &&
    provider.length > 0 &&
    id.length > 0 &&
    provider.length <= MAX_PERSISTED_MODEL_FIELD_LENGTH &&
    id.length <= MAX_PERSISTED_MODEL_FIELD_LENGTH
    ? { provider, id }
    : undefined;
}

function normalizeSavedPlan(value: unknown): SavedPlan | undefined {
  if (!isRecord(value)) return undefined;
  const source = planCompletionSource(value.source);
  const normalized = normalizePlanModeCompletion({ plan: value.plan });
  if (!source || !normalized.ok) return undefined;
  return { plan: normalized.plan, source };
}

function normalizeActiveImplementation(value: unknown): ActiveImplementationPlan | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(value.id) ? value.id : undefined;
  const source = planCompletionSource(value.source);
  const normalized = normalizePlanModeCompletion({ plan: value.plan });
  const startedAt =
    typeof value.startedAt === "number" && Number.isSafeInteger(value.startedAt) && value.startedAt >= 0
      ? value.startedAt
      : undefined;
  if (!id || !source || !normalized.ok || startedAt === undefined) return undefined;
  const retention = IMPLEMENTATION_PLAN_RETENTIONS.includes(value.retention as ImplementationPlanRetention)
    ? (value.retention as ImplementationPlanRetention)
    : "keep";
  return { id, plan: normalized.plan, source, startedAt, retention };
}

function normalizePersistedPlan(value: unknown) {
  const normalized = normalizePlanModeCompletion({ plan: value });
  return normalized.ok ? normalized.plan : undefined;
}

function latestCompletionPlan(entries: SessionEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]?.message;
    if (message?.role !== "toolResult" || message.toolName !== PLAN_MODE_COMPLETE_TOOL_NAME) {
      continue;
    }
    const plan = planFromCompletionDetails(message.details);
    if (plan) return plan;
  }
  return undefined;
}

function planCompletionSource(value: unknown): PlanCompletionSource | undefined {
  return value === PLAN_MODE_COMPLETE_TOOL_NAME || value === "legacy_proposed_plan" ? value : undefined;
}

function fixedThinkingLevel(value: unknown): PlanModeFixedThinkingLevel | undefined {
  return typeof value === "string" &&
    value !== "inherit" &&
    PLAN_MODE_THINKING_LEVELS.includes(value as (typeof PLAN_MODE_THINKING_LEVELS)[number])
    ? (value as PlanModeFixedThinkingLevel)
    : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
    ? Array.from(new Set(value))
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
