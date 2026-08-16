/** Resolution and audit snapshots for semantic workflow model tiers. */
import {
  type Api,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
} from "@earendil-works/pi-ai";
import type { WorkflowTier } from "@signalridge/pi-subagents-protocol";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import {
  DEFAULT_WORKFLOW_TIER_PROFILES,
  type WorkflowSettings,
  type WorkflowThinking,
  type WorkflowTierProfile,
} from "./settings.js";
import type { AgentConfig, ThinkingLevel } from "./types.js";

let workflowSettings: WorkflowSettings = {};

export type { WorkflowTier };

export type WorkflowResolutionSource = "frontmatter" | "tier" | "parent";

/** Durable, JSON-safe explanation of the policy used for one managed spawn. */
export interface WorkflowTierResolutionSnapshot {
  tier: WorkflowTier;
  /** Effective provider/model id, after resolving or inheriting the parent. */
  model?: string;
  /** Effective thinking level; omitted when the selected model supports no level. */
  thinking?: ThinkingLevel;
  configuredModel?: string;
  configuredThinking?: WorkflowThinking;
  requestedThinking?: ThinkingLevel;
  modelSource: WorkflowResolutionSource;
  thinkingSource: WorkflowResolutionSource;
  /** True when pi-ai lowered the requested level for the selected model. */
  clamped?: boolean;
  diagnostic?: string;
}

export interface WorkflowTierResolution {
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  snapshot?: WorkflowTierResolutionSnapshot;
}

export interface ResolveWorkflowTierInput {
  /** Explicit semantic tier from a workflow task. */
  tier?: WorkflowTier;
  /** Settings are passed by pi-subagents; workflows never resolve policy. */
  settings?: WorkflowSettings;
  agentConfig?: AgentConfig;
  /** Direct model objects take precedence over agent frontmatter and tiers. */
  directModel?: Model<Api>;
  /** Direct model references take precedence over agent frontmatter and tiers. */
  modelOverride?: string;
  thinkingOverride?: ThinkingLevel;
  parentModel?: Model<Api>;
  parentThinking?: ThinkingLevel;
  modelRegistry: ModelRegistry<Model<Api>>;
}

export function isWorkflowTier(value: unknown): value is WorkflowTier {
  return value === "small" || value === "medium" || value === "large";
}

export function getWorkflowSettings(): WorkflowSettings {
  return structuredClone(workflowSettings);
}

export function setWorkflowSettings(settings: WorkflowSettings): void {
  workflowSettings = structuredClone(settings);
}


function effectiveModelId(model: Model<Api> | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

/**
 * Resolve model and thinking independently, preserving agent frontmatter as the
 * authoritative override. A tier only fills fields omitted by frontmatter; the
 * parent session is the final fallback. An unavailable model explicitly selected
 * by a tier fails closed instead of silently changing the model.
 */
function isCompleteProfile(value: unknown): value is WorkflowTierProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return (
    typeof profile.model === "string" &&
    profile.model.length > 0 &&
    typeof profile.thinking === "string" &&
    ["inherit", "minimal", "low", "medium", "high", "xhigh", "max"].includes(profile.thinking)
  );
}

/**
 * Resolve model and thinking independently, preserving agent frontmatter as the
 * authoritative override. A tier only fills fields omitted by frontmatter; the
 * parent session is the final fallback. The configured default tier is applied
 * only inside pi-subagents, never by the workflow package.
 */
export function resolveWorkflowTier(input: ResolveWorkflowTierInput): WorkflowTierResolution {
  if (input.tier !== undefined && !isWorkflowTier(input.tier)) {
    throw new Error("workflow tier must be one of small, medium, or large");
  }

  const workflow = input.settings ?? workflowSettings;
  if (input.tier === undefined && workflow.blockedDefaultTier) {
    throw new Error("workflow defaultTier is blocked by malformed configuration");
  }
  const tier = input.tier ?? workflow.defaultTier;
  if (tier !== undefined && !isWorkflowTier(tier)) {
    throw new Error("workflow defaultTier must be one of small, medium, or large");
  }

  const defaultProfile = tier === undefined ? undefined : DEFAULT_WORKFLOW_TIER_PROFILES[tier];
  const configuredProfile = tier === undefined ? undefined : workflow.tiers?.[tier];
  if (tier !== undefined && workflow.blockedTiers?.includes(tier)) {
    throw new Error(`workflow tier "${tier}" is blocked by malformed configuration`);
  }
  if (configuredProfile !== undefined && !isCompleteProfile(configuredProfile)) {
    // This should be unreachable after settings validation. Throwing here keeps
    // a forged in-process settings object from degrading into parent policy.
    throw new Error(`workflow tier "${tier}" has an incomplete model/thinking profile`);
  }
  const profile = tier === undefined
    ? undefined
    : { ...defaultProfile, ...(configuredProfile ?? {}) };

  const tierConfiguredModel = profile?.model;
  const configuredModel = input.modelOverride ?? input.agentConfig?.model ?? tierConfiguredModel;
  const modelSource: WorkflowResolutionSource = input.directModel !== undefined || input.modelOverride !== undefined || input.agentConfig?.model !== undefined
    ? "frontmatter"
    : configuredModel !== undefined && configuredModel !== "inherit"
      ? "tier"
      : "parent";
  let model = input.directModel ?? input.parentModel;
  let diagnostic: string | undefined;

  if (input.directModel === undefined && configuredModel !== undefined && configuredModel !== "inherit") {
    const resolved = resolveModel(configuredModel, input.modelRegistry);
    if (typeof resolved === "string") {
      const tierOwnsModel =
        input.modelOverride === undefined &&
        input.agentConfig?.model === undefined &&
        tierConfiguredModel !== undefined &&
        tierConfiguredModel !== "inherit";
      if (tierOwnsModel) {
        throw new Error(`workflow tier "${tier}" has an unavailable model: ${resolved}`);
      }
      diagnostic = `${resolved} Falling back to the parent model.`;
    } else {
      model = resolved;
    }
  }

  const tierConfiguredThinking = profile?.thinking;
  const configuredThinking = input.thinkingOverride ?? input.agentConfig?.thinking ?? tierConfiguredThinking;
  const thinkingSource: WorkflowResolutionSource = input.thinkingOverride !== undefined || input.agentConfig?.thinking !== undefined
    ? "frontmatter"
    : tierConfiguredThinking !== undefined && tierConfiguredThinking !== "inherit"
      ? "tier"
      : "parent";
  const requestedThinking = configuredThinking === "inherit" ? input.parentThinking : configuredThinking ?? input.parentThinking;
  let thinkingLevel = requestedThinking;
  let clamped = false;

  if (model && requestedThinking) {
    const supported = getSupportedThinkingLevels(model);
    const clampedLevel = clampThinkingLevel(model, requestedThinking);
    if (clampedLevel !== requestedThinking) {
      clamped = true;
      const supportedText = supported.join(", ");
      const clampDiagnostic = `Thinking level "${requestedThinking}" is not supported by ${effectiveModelId(model) ?? "the selected model"}; using "${clampedLevel}" (supported: ${supportedText}).`;
      diagnostic = diagnostic ? `${diagnostic} ${clampDiagnostic}` : clampDiagnostic;
    }
    // "off" is a ModelThinkingLevel sentinel, not a ThinkingLevel accepted by
    // AgentSession options. Omitting the option preserves the provider's off behavior.
    thinkingLevel = clampedLevel === "off" ? undefined : clampedLevel as ThinkingLevel;
  }

  if (tier === undefined) return { model, thinkingLevel };

  const snapshot: WorkflowTierResolutionSnapshot = {
    tier,
    ...(effectiveModelId(model) ? { model: effectiveModelId(model) } : {}),
    ...(thinkingLevel ? { thinking: thinkingLevel } : {}),
    ...(configuredModel !== undefined ? { configuredModel } : {}),
    ...(configuredThinking !== undefined ? { configuredThinking } : {}),
    ...(requestedThinking !== undefined ? { requestedThinking } : {}),
    modelSource,
    thinkingSource,
    ...(clamped ? { clamped: true } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };

  return { model, thinkingLevel, snapshot };
}

/** Compatibility alias for callers that use the shorter tier terminology. */
export const resolveTier = resolveWorkflowTier;
