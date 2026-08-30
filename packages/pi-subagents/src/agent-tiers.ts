/**
 * agent-tiers.ts — user-named model tiers. The one tier catalogue.
 *
 * A tier is one name for a (model, thinking) pair. The host agent picks a tier
 * key and nothing else: the LLM-facing `Agent` tool exposes `tier` and does not
 * expose `model` or `thinking`, so the choice of which model runs stays with
 * whoever writes `subagents.json` rather than with the model deciding per call.
 *
 * Managed `pi-workflows` calls name a key from this same catalogue. There is no
 * separate workflow-tier vocabulary and no mapping layer: a workflow that wants
 * cheap work asks for the tier the user defined for cheap work, and gets the
 * same resolver, the same precedence, and the same fail-closed errors an
 * ordinary spawn gets. `getRoutingPolicySnapshot()` publishes the part of this
 * catalogue a managed peer needs to reason about replay.
 */

import { type Api, clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ManagedRoutingPolicy, ManagedRoutingPolicySnapshot } from "@signalridge/pi-subagents-protocol";
import { isManagedAgentTier, MAX_AGENT_TIER_KEY_LENGTH, routingPolicyFingerprint } from "@signalridge/pi-subagents-protocol";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import { type AgentTierProfile, type AgentTiersSettings, TIER_THINKING_LEVELS, type TierThinking } from "./settings.js";
import type { AgentConfig, ThinkingLevel } from "./types.js";

/** `provider/id`, or undefined when no model was selected. */
function effectiveModelId(model: Model<Api> | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

/**
 * The tier-key bound and predicate, re-exported from the protocol package.
 *
 * They are defined once, on the wire, because that is the narrower of the two
 * gates: a key this package accepted but the protocol rejected could never be
 * sent to a managed peer. Everything in pi-subagents imports them from here so
 * there is still one import site inside the package.
 */
export { isManagedAgentTier as isValidAgentTierKey, MAX_AGENT_TIER_KEY_LENGTH };

/**
 * Fresh installs receive an effort ladder: `low`, `medium`, `high`. Every
 * shipped profile inherits its model, so a new machine gets a usable vocabulary
 * without this package ever pinning a vendor. A user definition in
 * `subagents.json` replaces a shipped profile wholesale; a blocked profile is
 * never resurrected.
 */
const SHIPPED_LOW_PROFILE: AgentTierProfile = {
  model: "inherit",
  thinking: "low",
  description: "Cheap, shallow work (shipped)",
};
const SHIPPED_MEDIUM_PROFILE: AgentTierProfile = {
  model: "inherit",
  thinking: "medium",
  description: "Ordinary work (shipped)",
};
const SHIPPED_HIGH_PROFILE: AgentTierProfile = {
  model: "inherit",
  thinking: "high",
  description: "Deep or risky work (shipped)",
};

export const SHIPPED_AGENT_TIER_PROFILES: Readonly<Record<string, AgentTierProfile>> = {
  low: SHIPPED_LOW_PROFILE,
  medium: SHIPPED_MEDIUM_PROFILE,
  high: SHIPPED_HIGH_PROFILE,
};

/**
 * The tier a *managed* call gets when nobody named one.
 *
 * Deliberately not a global `defaultTier`. A managed workflow call fails closed
 * without a tier, and "install the package, run a workflow, get a hard error"
 * is not a defensible first experience — but that is the only case that needs a
 * shipped answer. Making it the catalogue's default instead would take over
 * every ordinary spawn as well, which would silence `defaultModel` and pin a
 * thinking level on machines that asked for neither.
 *
 * `medium` inherits its model, so this commits to an effort level, not to a
 * vendor — and, being `inherit`, it lands on the parent session's model. That
 * is the honest trade: this fallback exists so a managed call has a *named*
 * policy with a durable snapshot on a machine that configured none, not so it
 * runs somewhere cheaper. A workspace that wants cheaper managed work names a
 * `defaultTier` whose profile pins a model.
 *
 * It applies only while the user has expressed no opinion: any configured
 * `defaultTier` wins, `noDefaultTier` suppresses it outright, a tombstoned
 * default still blocks, and deleting the `medium` profile removes this fallback
 * with it.
 */
export const SHIPPED_DEFAULT_AGENT_TIER = "medium";

/**
 * The default a managed call resolves against, or `undefined` when it must fail
 * closed. The single definition of the shipped fallback: `selectAgentTier` consults
 * it for a `requireTier` spawn and `getRoutingPolicySnapshot` publishes it, so a
 * managed peer's replay identity can never disagree with what the host will do.
 */
export function managedDefaultAgentTier(settings: AgentTiersSettings): string | undefined {
  if (settings.blockedDefaultTier === true) return undefined;
  if (settings.defaultTier !== undefined) return settings.defaultTier;
  if (settings.noDefaultTier === true) return undefined;
  return settings.profiles?.[SHIPPED_DEFAULT_AGENT_TIER] ? SHIPPED_DEFAULT_AGENT_TIER : undefined;
}

/**
 * What leaving `defaultTier` unset would actually give a managed call, whatever
 * the user has chosen right now.
 *
 * The Settings menu offers `unset` as a distinct choice from `none`, and the
 * difference between them is exactly this value — which is `undefined` on a
 * catalogue whose `medium` profile has been edited away or tombstoned. A menu
 * that says "unset uses the shipped medium" there would be describing a
 * fallback that no longer exists, and `unset` would behave identically to
 * `none` while claiming otherwise. Asked of the same function that decides it,
 * with the current choice stripped, so the answer cannot drift from the
 * behavior.
 */
export function shippedFallbackAgentTier(settings: AgentTiersSettings = agentTiersSettings): string | undefined {
  return managedDefaultAgentTier({ ...settings, defaultTier: undefined, noDefaultTier: false });
}

let agentTiersSettings: AgentTiersSettings = {}; // effective view (shipped tiers merged)
let agentTiersConfigured: AgentTiersSettings = {}; // exactly what the user configured

/** Effective catalogue: shipped tiers merged under any user configuration. */
export function getAgentTiersSettings(): AgentTiersSettings {
  return structuredClone(agentTiersSettings);
}

/** The raw user configuration, without shipped tiers — what snapshotSettings writes back. */
export function getAgentTiersConfiguredSettings(): AgentTiersSettings {
  return structuredClone(agentTiersConfigured);
}

/** Exactly-equal profile? Used to strip untouched shipped tiers from the configured view. */
function sameProfile(a: AgentTierProfile, b: AgentTierProfile): boolean {
  return a.model === b.model && a.thinking === b.thinking && (a.description ?? "") === (b.description ?? "");
}

/**
 * Install the effective tier catalogue.
 *
 * Each shipped tier is merged in unless the caller already defined it or
 * explicitly blocked it — a user catalogue wins over a shipped profile, and a
 * tombstone means "do not substitute", which applies to shipped profiles too.
 *
 * The configured view is derived from the same input by stripping profiles that
 * exactly equal a shipped profile, so the UI can operate on the effective view
 * and send it back without materializing untouched shipped tiers into
 * `subagents.json`. Editing a shipped tier (changing its model, thinking, or
 * description) makes it a user-owned profile and it is then persisted; deleting
 * one leaves its tombstone, which persists.
 */
export function setAgentTiersSettings(settings: AgentTiersSettings): void {
  const effective = structuredClone(settings);
  const profiles = { ...(effective.profiles ?? {}) };
  const blocked = new Set<string>(effective.blockedProfiles ?? []);

  const configuredProfiles: Record<string, AgentTierProfile> = {};
  for (const [key, profile] of Object.entries(profiles)) {
    const shipped = SHIPPED_AGENT_TIER_PROFILES[key];
    if (!blocked.has(key) && shipped !== undefined && sameProfile(profile, shipped)) continue;
    configuredProfiles[key] = profile;
  }
  for (const [key, profile] of Object.entries(SHIPPED_AGENT_TIER_PROFILES)) {
    if (!blocked.has(key) && profiles[key] === undefined) profiles[key] = profile;
  }

  // `defaultTier` is passed through untouched. The shipped fallback is not
  // merged in here: it is scoped to managed calls (see
  // `managedDefaultAgentTier`), so the effective catalogue keeps saying "the
  // user named no default" and an ordinary spawn still falls through to
  // `defaultModel` and the parent session.
  agentTiersSettings = { ...effective, profiles };
  const configured: AgentTiersSettings = { ...effective };
  if (Object.keys(configuredProfiles).length > 0) configured.profiles = configuredProfiles;
  else delete configured.profiles;
  agentTiersConfigured = configured;
}

/**
 * Where the tier that was used came from; recorded for audit.
 *
 * A managed workflow call is a `call`: an orchestrator naming a tier per
 * dispatch is the same act whether the orchestrator is the host model or a
 * workflow script, so it gets the same precedence and the same scope policy.
 */
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
  /**
   * This spawn cannot fall back to the parent session's model, so the shipped
   * fallback applies when nothing else named a tier. Managed workflow calls set
   * it; an ordinary spawn leaves it off and simply resolves no tier.
   */
  requireTier?: boolean;
  /** The agent's own config; supplies its default tier and legacy model/thinking. */
  agentConfig?: AgentConfig;
  /** Overrides the module-level settings; tests and callers with their own load. */
  settings?: AgentTiersSettings;
  parentModel?: Model<Api>;
  parentThinking?: ThinkingLevel;
  modelRegistry: ModelRegistry<Model<Api>>;
}

/** The part of a resolve request that decides *which* tier applies. */
export type TierSelectionInput = Pick<
  ResolveAgentTierInput,
  "requestedTier" | "requireTier" | "agentConfig" | "settings"
>;

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
  else if (settings.noDefaultTier) out.noDefaultTier = true;
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
 *
 * Deleting a shipped tier tombstones it instead of just dropping it: the
 * shipped merge in `setAgentTiersSettings` would otherwise silently re-add it
 * on the next load, and a user who deletes it means it. The tombstone says
 * "do not substitute", which is exactly the semantics the load path already
 * honors for malformed profiles.
 */
export function removeAgentTierProfile(settings: AgentTiersSettings, key: string): AgentTiersSettings {
  const { [key]: _removed, ...profiles } = settings.profiles ?? {};
  const shipped = Object.hasOwn(SHIPPED_AGENT_TIER_PROFILES, key);
  let blocked = withoutBlocked(settings.blockedProfiles, key);
  if (shipped) blocked = [...(blocked ?? []), key];
  return compactTierSettings({
    ...settings,
    profiles,
    blockedProfiles: blocked,
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
 * What the user chose for the default tier.
 *
 * `none` and `unset` are different policies, and a single "no default" value
 * cannot express both: an absent `defaultTier` still lets a managed workflow
 * call reach the shipped fallback, while `none` is the statement that managed
 * calls should fail closed as well. Typed rather than modelled as
 * `string | undefined` so a caller has to say which one it means, and so a menu
 * can render the difference instead of showing one word for two behaviors.
 */
export type DefaultAgentTierSelection =
  | { kind: "tier"; tier: string }
  | { kind: "none" }
  | { kind: "unset" };

/** Which of the three states the catalogue is currently in. */
export function getDefaultAgentTierSelection(
  settings: AgentTiersSettings = agentTiersSettings,
): DefaultAgentTierSelection {
  if (settings.defaultTier !== undefined) return { kind: "tier", tier: settings.defaultTier };
  return settings.noDefaultTier === true ? { kind: "none" } : { kind: "unset" };
}

/**
 * Set, clear, or withdraw the default tier.
 *
 * Always clears `blockedDefaultTier`: that tombstone describes the malformed
 * value this call is replacing, and keeping it would make the resolver refuse
 * the choice the user just made explicitly.
 */
export function setDefaultAgentTier(
  settings: AgentTiersSettings,
  selection: DefaultAgentTierSelection,
): AgentTiersSettings {
  return compactTierSettings({
    ...settings,
    defaultTier: selection.kind === "tier" ? selection.tier : undefined,
    noDefaultTier: selection.kind === "none",
    blockedDefaultTier: false,
  });
}

/**
 * Which tier applies, and where it came from.
 *
 * An explicitly requested tier that does not exist is an error rather than a
 * fallback: the caller asked for a specific policy, and quietly running a
 * different model than the one it selected is worse than refusing.
 *
 * Precedence is `call > frontmatter > default`. A tier named per dispatch is
 * current policy; an agent's own `tier:` is the older, weaker statement of the
 * same thing. This holds for a workflow script exactly as it does for the host
 * model — both are orchestrators routing one call.
 *
 * A `requireTier` spawn gets one extra step after the configured default: the
 * shipped fallback. It is last because it is the only step the user did not
 * write, and it is reachable only from a caller that has no parent model to
 * fall back to.
 *
 * Exported because the managed-spawn path needs the tier *key* before the
 * runner resolves — a tombstone and the lifecycle events carry it as a label.
 * That caller asks this function rather than rebuilding the same three-step
 * fallback beside it, for the reason given on {@link agentTierApplies}: a
 * second copy of a precedence is only ever a way for the two to disagree.
 */
export function selectAgentTier(
  input: TierSelectionInput,
  settings: AgentTiersSettings = agentTiersSettings,
): { tier: string; source: AgentTierSource } | undefined {
  const requested = input.requestedTier;
  if (requested !== undefined) {
    if (!isManagedAgentTier(requested)) {
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
  // Only a spawn that may not inherit the parent reaches the shipped fallback.
  if (input.requireTier !== true) return undefined;
  const fallback = managedDefaultAgentTier(settings);
  return fallback === undefined ? undefined : { tier: fallback, source: "default" };
}

/**
 * Whether `resolveAgentTier` will select a tier for this spawn.
 *
 * The callers that pre-compute a legacy model or thinking value need this
 * before the runner resolves: a selected tier owns both outright, so
 * pre-resolving one would hand the runner a value it is about to discard, and a
 * scope check against a model that never runs. Implemented by asking
 * `selectAgentTier` itself rather than restating its precedence, so the two cannot
 * drift. A fail-closed condition counts as "applies": the tier path owns the
 * refusal, and the legacy path must not quietly answer in its place.
 */
export function agentTierApplies(input: TierSelectionInput): boolean {
  try {
    return selectAgentTier(input, input.settings ?? agentTiersSettings) !== undefined;
  } catch {
    return true;
  }
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
 * caller then falls back to a programmatic model option, the configured
 * `defaultModel`, and finally the parent session. A `requireTier` spawn cannot
 * take that path, so it reaches the shipped fallback instead — and fails closed
 * when the user has suppressed that too.
 */
export function resolveAgentTier(input: ResolveAgentTierInput): AgentTierResolution {
  const settings = input.settings ?? agentTiersSettings;
  const selected = selectAgentTier(input, settings);
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

/**
 * The catalogue as a managed peer needs to see it.
 *
 * Protocol-shaped on purpose: no settings-file details, no descriptions, no
 * host paths — only what decides how a tier resolves, so a peer can tell
 * whether a journaled call would still resolve the same way. `defaultTier` is
 * the *managed* default, shipped fallback included: every consumer of this
 * snapshot is a managed caller, and publishing the bare configured value would
 * make its replay identity disagree with what the host actually selects.
 *
 * Both sorts use the default code-unit order rather than `localeCompare`.
 * `blockedProfiles` is an array, so its order reaches the fingerprint, and a
 * locale-dependent comparator would let the same catalogue hash differently on
 * two machines — or on one machine after its locale changed. Object keys are
 * canonicalized again by `canonicalizeRoutingPolicy`; sorting them here only
 * keeps the wire payload readable.
 */
export function getRoutingPolicySnapshot(
  settings: AgentTiersSettings = agentTiersSettings,
): ManagedRoutingPolicySnapshot {
  const policy: ManagedRoutingPolicy = {
    defaultTier: managedDefaultAgentTier(settings) ?? null,
    profiles: Object.fromEntries(
      Object.entries(settings.profiles ?? {})
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, profile]) => [key, { model: profile.model, thinking: profile.thinking }]),
    ),
    blockedProfiles: [...(settings.blockedProfiles ?? [])].sort(),
    blockedDefaultTier: settings.blockedDefaultTier === true,
  };
  return { policy, fingerprint: routingPolicyFingerprint(policy) };
}
