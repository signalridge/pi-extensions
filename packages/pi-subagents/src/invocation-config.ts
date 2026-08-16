import type { WorkflowTier } from "@signalridge/pi-subagents-protocol";
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
  /**
   * Workflow protocol tier (`small | medium | large`), set only by the managed
   * spawn path. Kept apart from `tier` so the protocol's union stays closed.
   */
  workflowTier?: WorkflowTier;
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
  workflowTier?: WorkflowTier;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  isolated: boolean;
  isolation?: IsolationMode;
} {
  return {
    modelInput: agentConfig?.model ?? params.model,
    requestedAgentTier: params.tier,
    workflowTier: params.workflowTier,
    modelFromParams: agentConfig?.model == null && params.model != null,
    thinking: (agentConfig?.thinking ?? params.thinking) as
      | ThinkingLevel
      | undefined,
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
