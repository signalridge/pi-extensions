/**
 * Package-internal run capabilities. These values are intentionally not part of
 * the Agent tool or managed RPC contracts; only trusted package code can issue
 * the symbol-keyed override.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentReopenRoute } from "./reopen-route.js";
import type { AgentConfig, ThinkingLevel } from "./types.js";

/**
 * Immutable policy used while asking a model to draft an agent definition.
 * The parent owns all file writes, so the child receives no tools, extensions,
 * skills, memory, or nested-delegation capability.
 */
export interface InternalAgentConfigOverride {
  readonly builtinToolNames: readonly string[];
  readonly extensions: false;
  readonly skills: false;
  readonly allowedSubagents: undefined;
  readonly memory: undefined;
  readonly persistSession: false;
  readonly outputTranscript: false;
  readonly isolation: undefined;
  readonly isolated: true;
  readonly inheritContext: false;
}

/** Symbol-keyed so ordinary JSON/RPC/public spawn options cannot carry it. */
export const INTERNAL_AGENT_CONFIG_OVERRIDE = Symbol("pi-subagents.internal-agent-config-override");

/**
 * Parent model/thinking chosen when a managed spawn is allocated. The symbol key
 * keeps this capability out of JSON, the public spawn contract, and wire RPC.
 */
export interface ParentPolicySnapshot {
  readonly model?: Model<Api>;
  readonly thinking?: ThinkingLevel;
}

export const INTERNAL_PARENT_POLICY_SNAPSHOT = Symbol("pi-subagents.internal-parent-policy-snapshot");

/** Manager-issued isolation after ordinary, branch-local, or managed admission.
 * Never forwarded from public SpawnOptions; direct runner calls resolve definition policy.
 */
export const INTERNAL_RESOLVED_ISOLATED = Symbol("pi-subagents.internal-resolved-isolated");

/** Branch-local frontmatter only; never accepts another run/config capability. */
export type ResumeBudgetPolicy = Pick<AgentConfig, "maxTurns">;
export const INTERNAL_RESUME_BUDGET_POLICY = Symbol("pi-subagents.internal-resume-budget-policy");

/** Manager-issued catalog proof, rechecked by the real runner before any replay. */
export const INTERNAL_REOPEN_ROUTE = Symbol("pi-subagents.internal-reopen-route");
export interface InternalReopenRouteProof { readonly route: AgentReopenRoute; }

/** Reject string-keyed reopen capabilities at every public admission boundary. */
export function assertNoPublicReopen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  for (const key of ["resumeSessionFile", "reclaimHandle", "resume_session_file", "reclaim_handle"]) {
    if (Reflect.has(value, key)) {
      throw new Error(`Unsupported internal capability "${key}". Resume an ordinary agent by its agent ID instead; session file paths are never accepted.`);
    }
  }
}

/** The only no-tool policy currently issued by the package. */
export const AGENT_DEFINITION_GENERATION_OVERRIDE: InternalAgentConfigOverride = Object.freeze({
  builtinToolNames: Object.freeze([] as string[]),
  extensions: false,
  skills: false,
  allowedSubagents: undefined,
  memory: undefined,
  persistSession: false,
  outputTranscript: false,
  isolation: undefined,
  isolated: true,
  inheritContext: false,
});
