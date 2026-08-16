/**
 * agent-tiers.ts — user-named model tiers for ordinary subagent spawns.
 *
 * A tier is one name for a (model, thinking) pair. The host agent picks a tier
 * key and nothing else: the LLM-facing `Agent` tool exposes `tier` and does not
 * expose `model` or `thinking`, so the choice of which model runs stays with
 * whoever writes `subagents.json` rather than with the model deciding per call.
 *
 * Deliberately separate from `workflow-tiers.ts`. Workflow tiers are the fixed
 * `small | medium | large` vocabulary of the `pi-workflows` protocol and are
 * typed as that union; agent tiers are arbitrary user-chosen names. Sharing one
 * field between them would force `WorkflowTier` open to `string` and take the
 * protocol's exhaustiveness with it, so the two keep separate settings, separate
 * snapshot types, and separate fields on `AgentInvocation`. The mechanics they
 * both use — resolving a model reference, clamping thinking — are short enough
 * to state twice; `workflow-tiers.ts` keeps its own copy so this change cannot
 * alter the protocol-facing resolver's behavior.
 *
 * The two also disagree on precedence, which is why they are not one function:
 * a workflow tier only fills what agent frontmatter left blank, while an agent
 * tier overrides frontmatter's legacy `model:`/`thinking:`. That is the point of
 * agent tiers — the tier is the policy, and a per-agent pin is the older, weaker
 * statement of the same thing.
 */

import { type Api, clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import { type AgentTierProfile, type AgentTiersSettings, TIER_THINKING_LEVELS, type TierThinking } from "./settings.js";
import type { AgentConfig, ThinkingLevel } from "./types.js";

/** `provider/id`, or undefined when no model was selected. */
function effectiveModelId(model: Model<Api> | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

/** Longest accepted tier key. Long enough for any real name, short enough to render. */
export const MAX_AGENT_TIER_KEY_LENGTH = 64;

let agentTiersSettings: AgentTiersSettings = {};

export function getAgentTiersSettings(): AgentTiersSettings {
  return structuredClone(agentTiersSettings);
}

export function setAgentTiersSettings(settings: AgentTiersSettings): void {
  agentTiersSettings = structuredClone(settings);
}

/**
 * A key is usable when it is a bounded, non-blank, whitespace-free string.
 *
 * Whitespace is excluded because the key appears in tool descriptions and error
 * messages as a bare token; a key with a space in it reads as two keys.
 */
export function isValidAgentTierKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_AGENT_TIER_KEY_LENGTH &&
    value.trim() === value &&
    !/\s/u.test(value)
  );
}

/** Where the tier that was used came from; recorded for audit. */
export type AgentTierSource = "call" | "frontmatter" | "default";

/** Durable, JSON-safe record of how one spawn's model and thinking were chosen. */
export interface AgentTierResolutionSnapshot {
  /** The tier key that was applied. */
  tier: string;
  source: AgentTierSource;
  /** Effective provider/model id after resolution. */
  model?: string;
  /** Effective thinking level; omitted when the model supports none. */
  thinking?: ThinkingLevel;
  /** The profile's model reference, before resolution. */
  configuredModel: string;
  /** The profile's thinking value, before clamping. */
  configuredThinking: TierThinking;
  /** Level asked for after `inherit` resolved against the parent. */
  requestedThinking?: ThinkingLevel;
  /** True when pi-ai lowered the requested level for this model. */
  clamped?: boolean;
  diagnostic?: string;
}

export interface AgentTierResolution {
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  snapshot?: AgentTierResolutionSnapshot;
}

export interface ResolveAgentTierInput {
  /** Tier key from the spawn call. Highest precedence. */
  requestedTier?: string;
  /** The agent's own config; supplies its default tier and legacy model/thinking. */
  agentConfig?: AgentConfig;
  /** Overrides the module-level settings; tests and callers with their own load. */
  settings?: AgentTiersSettings;
  parentModel?: Model<Api>;
  parentThinking?: ThinkingLevel;
  modelRegistry: ModelRegistry<Model<Api>>;
}

/** Thrown for every fail-closed tier condition so callers can report it verbatim. */
export class AgentTierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTierError";
  }
}

/** Every defined tier key, sorted — the catalogue as the UI and the host see it. */
export function listAgentTierKeys(settings: AgentTiersSettings): string[] {
  return Object.keys(settings.profiles ?? {}).sort((a, b) => a.localeCompare(b));
}

function tierKeyList(settings: AgentTiersSettings): string {
  const keys = listAgentTierKeys(settings);
  return keys.length > 0 ? keys.join(", ") : "(none configured)";
}

/**
 * Tier edits, as pure settings-to-settings functions.
 *
 * The `/agents → Model tiers` menu is the only caller, but the rules it has to
 * obey are policy, not presentation — retiring a tombstone, not leaving
 * `defaultTier` pointing at a tier that no longer exists — so they live here
 * with the resolver that enforces the other half of the same invariants.
 *
 * Each returns a fresh object and omits empty containers, so a catalogue edited
 * back down to nothing serializes as nothing rather than as empty braces.
 */
function withoutBlocked(blocked: string[] | undefined, key: string): string[] | undefined {
  const rest = (blocked ?? []).filter((k) => k !== key);
  return rest.length > 0 ? rest : undefined;
}

function compactTierSettings(settings: AgentTiersSettings): AgentTiersSettings {
  const out: AgentTiersSettings = {};
  if (settings.defaultTier !== undefined) out.defaultTier = settings.defaultTier;
  if (settings.profiles && Object.keys(settings.profiles).length > 0) out.profiles = settings.profiles;
  if (settings.blockedProfiles && settings.blockedProfiles.length > 0) {
    out.blockedProfiles = settings.blockedProfiles;
  }
  if (settings.blockedDefaultTier) out.blockedDefaultTier = true;
  return out;
}

/**
 * Define or replace one tier.
 *
 * Writing a valid profile retires that key's tombstone: the tombstone exists to
 * stop a malformed entry from silently resolving to some other model, and an
 * explicit definition is the fix it was waiting for.
 */
export function upsertAgentTierProfile(
  settings: AgentTiersSettings,
  key: string,
  profile: AgentTierProfile,
): AgentTiersSettings {
  return compactTierSettings({
    ...settings,
    profiles: { ...settings.profiles, [key]: profile },
    blockedProfiles: withoutBlocked(settings.blockedProfiles, key),
  });
}

/**
 * Delete one tier.
 *
 * A `defaultTier` pointing at it is cleared in the same step. Leaving it would
 * turn every later spawn that names no tier into a hard refusal, which is a
 * strange thing to get from deleting a tier you had stopped using.
 */
export function removeAgentTierProfile(settings: AgentTiersSettings, key: string): AgentTiersSettings {
  const { [key]: _removed, ...profiles } = settings.profiles ?? {};
  return compactTierSettings({
    ...settings,
    profiles,
    blockedProfiles: withoutBlocked(settings.blockedProfiles, key),
    ...(settings.defaultTier === key ? { defaultTier: undefined } : {}),
  });
}

/**
 * The thinking values a tier may usefully store for one model reference.
 *
 * Asked of the model rather than read off a fixed list, because `resolveAgentTier`
 * clamps an unsupported level at spawn time: a menu offering a level destined to
 * be silently lowered would be a menu that lies. `inherit` is always offerable —
 * it defers to the parent session, which this model has no say over.
 *
 * A reference of `inherit`, or one this machine cannot resolve, yields the full
 * static list: the model is not knowable here, and refusing to let the user
 * configure a tier for a provider they have not authed yet would make the menu
 * weaker than hand-editing the file.
 */
export function offerableTierThinking(
  modelRef: string,
  registry: ModelRegistry<Model<Api>>,
): TierThinking[] {
  if (modelRef === "inherit") return [...TIER_THINKING_LEVELS];
  const resolved = resolveModel(modelRef, registry);
  if (typeof resolved === "string") return [...TIER_THINKING_LEVELS];
  const supported = new Set<string>(getSupportedThinkingLevels(resolved));
  return TIER_THINKING_LEVELS.filter(level => level === "inherit" || supported.has(level));
}

/**
 * Set or clear the default tier.
 *
 * Always clears `blockedDefaultTier`: that tombstone describes the malformed
 * value this call is replacing, and keeping it would make the resolver refuse
 * the choice the user just made explicitly.
 */
export function setDefaultAgentTier(
  settings: AgentTiersSettings,
  key: string | undefined,
): AgentTiersSettings {
  return compactTierSettings({ ...settings, defaultTier: key, blockedDefaultTier: false });
}

/**
 * Which tier applies, and where it came from.
 *
 * An explicitly requested tier that does not exist is an error rather than a
 * fallback: the host asked for a specific policy, and quietly running a
 * different model than the one it selected is worse than refusing.
 */
function selectTier(
  input: ResolveAgentTierInput,
  settings: AgentTiersSettings,
): { tier: string; source: AgentTierSource } | undefined {
  const requested = input.requestedTier;
  if (requested !== undefined) {
    if (!isValidAgentTierKey(requested)) {
      throw new AgentTierError(
        `Invalid agent tier key. Keys are non-empty, contain no whitespace, and are at most ` +
          `${MAX_AGENT_TIER_KEY_LENGTH} characters. Available tiers: ${tierKeyList(settings)}`,
      );
    }
    return { tier: requested, source: "call" };
  }

  const frontmatter = input.agentConfig?.agentTier;
  if (frontmatter !== undefined) return { tier: frontmatter, source: "frontmatter" };

  if (settings.blockedDefaultTier) {
    throw new AgentTierError("agentTiers.defaultTier is blocked by malformed configuration");
  }
  if (settings.defaultTier !== undefined) return { tier: settings.defaultTier, source: "default" };
  return undefined;
}

function describeSource(source: AgentTierSource, agentName: string | undefined): string {
  switch (source) {
    case "call":
      return "requested by the caller";
    case "frontmatter":
      return `set by agent "${agentName ?? "unknown"}"`;
    case "default":
      return "the configured agentTiers.defaultTier";
  }
}

/**
 * Resolve a spawn's model and thinking from its tier.
 *
 * Returns `undefined` fields and no snapshot when no tier applies at all, which
 * is how a workspace that has configured none keeps its previous behavior: the
 * caller then falls back to the agent's legacy `model:`/`thinking:` frontmatter
 * and finally to the parent session.
 */
export function resolveAgentTier(input: ResolveAgentTierInput): AgentTierResolution {
  const settings = input.settings ?? agentTiersSettings;
  const selected = selectTier(input, settings);
  if (!selected) return {};

  const { tier, source } = selected;
  const origin = describeSource(source, input.agentConfig?.name);

  if (settings.blockedProfiles?.includes(tier)) {
    throw new AgentTierError(
      `Agent tier "${tier}" (${origin}) is blocked by a malformed profile in subagents.json. ` +
        `Fix or remove it; a tier is never silently replaced by another model.`,
    );
  }

  const profile: AgentTierProfile | undefined = settings.profiles?.[tier];
  if (!profile) {
    throw new AgentTierError(
      `Unknown agent tier "${tier}" (${origin}). Available tiers: ${tierKeyList(settings)}`,
    );
  }

  // A tier owns its model outright, so an unresolvable reference fails the spawn
  // instead of degrading into whatever the parent happens to be running — the
  // caller asked for this policy by name.
  let model = input.parentModel;
  if (profile.model !== "inherit") {
    const resolved = resolveModel(profile.model, input.modelRegistry);
    if (typeof resolved === "string") {
      throw new AgentTierError(`Agent tier "${tier}" (${origin}) has an unavailable model: ${resolved}`);
    }
    model = resolved;
  }

  const requestedThinking = profile.thinking === "inherit" ? input.parentThinking : profile.thinking;
  let thinkingLevel = requestedThinking;
  let clamped = false;
  let diagnostic: string | undefined;
  if (model && requestedThinking) {
    const clampedLevel = clampThinkingLevel(model, requestedThinking);
    if (clampedLevel !== requestedThinking) {
      clamped = true;
      diagnostic =
        `Thinking level "${requestedThinking}" is not supported by ${effectiveModelId(model) ?? "the selected model"}; ` +
        `using "${clampedLevel}" (supported: ${getSupportedThinkingLevels(model).join(", ")}).`;
    }
    // "off" is a ModelThinkingLevel sentinel, not a ThinkingLevel an AgentSession
    // accepts. Omitting the option leaves the provider's own off behavior alone.
    thinkingLevel = clampedLevel === "off" ? undefined : (clampedLevel as ThinkingLevel);
  }

  const snapshot: AgentTierResolutionSnapshot = {
    tier,
    source,
    ...(effectiveModelId(model) ? { model: effectiveModelId(model) } : {}),
    ...(thinkingLevel ? { thinking: thinkingLevel } : {}),
    configuredModel: profile.model,
    configuredThinking: profile.thinking,
    ...(requestedThinking !== undefined ? { requestedThinking } : {}),
    ...(clamped ? { clamped: true } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };

  return { model, thinkingLevel, snapshot };
}

/**
 * Every tier name that is referenced but not defined.
 *
 * The resolver refuses these at spawn time anyway, but a `defaultTier` typo
 * would otherwise sit quiet until the first agent that names no tier — which
 * may be minutes into a session, in the middle of something. Checking the
 * references once, when settings and agents are loaded, moves that discovery to
 * where it is cheap and where the fix is obvious.
 *
 * `agentNames` maps an agent to the tier its frontmatter asks for, so a typo in
 * one agent file is reported the same way as one in `defaultTier`.
 */
export function findUnknownAgentTierReferences(
  settings: AgentTiersSettings,
  agentTiers: ReadonlyMap<string, string> = new Map(),
): string[] {
  const defined = new Set(Object.keys(settings.profiles ?? {}));
  // With nothing configured there is no catalogue to be wrong about; the
  // resolver simply never applies a tier.
  if (defined.size === 0 && settings.defaultTier === undefined) return [];

  const problems: string[] = [];
  if (settings.defaultTier !== undefined && !defined.has(settings.defaultTier)) {
    problems.push(
      `agentTiers.defaultTier is "${settings.defaultTier}", which is not a defined tier. ` +
        `Available: ${tierKeyList(settings)}`,
    );
  }
  for (const [agent, tier] of [...agentTiers].sort(([a], [b]) => a.localeCompare(b))) {
    if (!defined.has(tier)) {
      problems.push(
        `Agent "${agent}" asks for tier "${tier}", which is not a defined tier. ` +
          `Available: ${tierKeyList(settings)}`,
      );
    }
  }
  return problems;
}

/**
 * The tier catalogue, rendered for the `Agent` tool description.
 *
 * The host has to know the vocabulary before its first call, so this is injected
 * into the tool description at registration rather than exposed through a lookup
 * tool the model would have to remember to call. Only names, descriptions,
 * models and thinking levels appear — nothing here reads credentials.
 */
export function buildAgentTierListText(settings: AgentTiersSettings = agentTiersSettings): string {
  const keys = listAgentTierKeys(settings);
  if (keys.length === 0) return "";

  const entries = keys.map((key) => {
    const profile = settings.profiles?.[key];
    if (!profile) return `- ${key}`;
    // A profile without its own description is still worth listing; the key is
    // the description in that case, which is what a terse config intends.
    const summary = profile.description ?? key;
    return `- ${key}: ${summary}\n  model: ${profile.model}\n  thinking: ${profile.thinking}`;
  });

  const defaultLine =
    settings.defaultTier !== undefined ? `\n\nDefault tier: ${settings.defaultTier}` : "";
  return `Available agent tiers:\n\n${entries.join("\n\n")}${defaultLine}\n\nThe caller may pass only a tier key. Do not pass model or thinking directly.`;
}

/** One line per tier, for the compact tool description. */
export function buildCompactAgentTierListText(settings: AgentTiersSettings = agentTiersSettings): string {
  const keys = listAgentTierKeys(settings);
  if (keys.length === 0) return "";

  const entries = keys.map((key) => {
    const profile = settings.profiles?.[key];
    if (!profile) return `- ${key}`;
    return `- ${key}: ${profile.description ?? key} (${profile.model}, thinking ${profile.thinking})`;
  });
  const defaultSuffix = settings.defaultTier !== undefined ? ` Default: ${settings.defaultTier}.` : "";
  return `Agent tiers (pass \`tier\`, never model/thinking):\n${entries.join("\n")}${defaultSuffix}`;
}

/** The configured default tier key, or "" when none is set. */
export function getDefaultAgentTierText(settings: AgentTiersSettings = agentTiersSettings): string {
  return settings.defaultTier ?? "";
}

/** Description for the `tier` parameter, naming the keys this workspace defines. */
export function buildAgentTierParameterDescription(settings: AgentTiersSettings = agentTiersSettings): string {
  const keys = listAgentTierKeys(settings);
  const available = keys.length > 0 ? keys.join(", ") : "none configured";
  const fallback =
    settings.defaultTier !== undefined
      ? ` Omit to use the agent's own tier, or "${settings.defaultTier}".`
      : " Omit to use the agent's own tier.";
  return (
    `Model tier for this spawn, chosen by name. Available: ${available}.${fallback}` +
    " A tier overrides the agent's default. Unknown tiers are rejected rather than substituted."
  );
}
