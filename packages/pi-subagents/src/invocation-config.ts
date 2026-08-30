import { agentTierApplies } from "./agent-tiers.js";
import type { AgentTiersSettings } from "./settings.js";
import type {
  AgentConfig,
  IsolationMode,
  JoinMode,
  ThinkingLevel,
} from "./types.js";

interface AgentInvocationParams {
  /**
   * User-named model tier requested at the call site. This is the only model
   * control the LLM-facing `Agent` tool exposes; `model` and `thinking` below
   * are reachable only from programmatic callers and the legacy RPC.
   */
  tier?: string;
  /** Effective Agent-tier settings, used only to avoid pre-resolving legacy fields. */
  agentTiers?: AgentTiersSettings;
  /** Set by callers that cannot inherit the parent model; see `ResolveAgentTierInput`. */
  requireTier?: boolean;
  model?: string;
  thinking?: string;
  max_turns?: number;
  run_in_background?: boolean;
  inherit_context?: boolean;
  isolated?: boolean;
  isolation?: IsolationMode;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
): {
  modelInput?: string;
  modelFromParams: boolean;
  /** Passed to `resolveAgentTier` as the requested tier; precedence lives there. */
  requestedAgentTier?: string;
  /** True when a tier owns final model and thinking resolution. */
  agentTierSelected: boolean;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  isolated: boolean;
  isolation?: IsolationMode;
} {
  // Asked, not restated: `agentTierApplies` runs the resolver's own selection.
  // Whenever a tier applies it owns model and thinking outright, so pre-resolving
  // a legacy field here would hand the runner a value the tier is about to
  // discard, and a scope check against a model that never runs.
  const agentTierSelected = agentTierApplies({
    requestedTier: params.tier,
    requireTier: params.requireTier,
    agentConfig,
    settings: params.agentTiers,
  });
  return {
    modelInput: agentTierSelected ? undefined : agentConfig?.model ?? params.model,
    requestedAgentTier: params.tier,
    agentTierSelected,
    modelFromParams: !agentTierSelected && agentConfig?.model == null && params.model != null,
    thinking: agentTierSelected
      ? undefined
      : (agentConfig?.thinking ?? params.thinking) as ThinkingLevel | undefined,
    maxTurns: agentConfig?.maxTurns ?? params.max_turns,
    inheritContext:
      agentConfig?.inheritContext ?? params.inherit_context ?? false,
    runInBackground:
      agentConfig?.runInBackground ?? params.run_in_background ?? false,
    isolated: agentConfig?.isolated ?? params.isolated ?? false,
    isolation: agentConfig?.isolation ?? params.isolation,
  };
}

export function resolveJoinMode(
  defaultJoinMode: JoinMode,
  runInBackground: boolean,
): JoinMode | undefined {
  return runInBackground ? defaultJoinMode : undefined;
}
