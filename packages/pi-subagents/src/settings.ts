// Persistence for pi-subagents operational settings.
// - Global:  ~/.pi/agent/subagents.json (via getAgentDir()) — manual defaults, never written here
// - Project: <cwd>/.pi/subagents.json — written by /agents → Settings; overrides global on load

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { WorkflowTier } from "@signalridge/pi-subagents-protocol";
// Imported only for the applySettings fallback so a persisted defaultToolTimeoutMs
// takes effect even before the host wires the new applier — avoids needing to
// edit index.ts in the same change.
import { setDefaultToolTimeoutMs } from "./agent-runner.js";
import { NO_FALLBACK } from "./agent-types.js";
import type { JoinMode, ThinkingLevel } from "./types.js";

/** How a `@handle message` mention is dispatched. See `agentMentions`. */
export const AGENT_MENTION_MODES = ["model", "direct", "off"] as const;
export type AgentMentionMode = (typeof AGENT_MENTION_MODES)[number];
const VALID_AGENT_MENTION_MODES: ReadonlySet<string> = new Set(AGENT_MENTION_MODES);

/** A tier's thinking value: a level, or `inherit` to keep the parent's. */
export type TierThinking = ThinkingLevel | "inherit";

/** Historical name for {@link TierThinking}, kept for the workflow tier types. */
export type WorkflowThinking = TierThinking;

/**
 * One user-named (model, thinking) pair for ordinary subagent spawns.
 *
 * Separate from {@link WorkflowTierProfile} because the key space differs: these
 * names are whatever the user chose, while workflow tiers are the protocol's
 * fixed small/medium/large. `description` is what the host agent reads in the
 * tool description to decide between tiers, so it is prose about the job the
 * tier is for, not about the model.
 */
export interface AgentTierProfile {
  /** `inherit` keeps the parent model; other values are provider/model references. */
  model: string;
  /** `inherit` keeps the parent thinking level; other values are clamped natively. */
  thinking: TierThinking;
  /** Shown to the host agent. Defaults to the tier key when omitted. */
  description?: string;
}

/** Tier policy for ordinary subagent spawns, resolved by `agent-tiers.ts`. */
export interface AgentTiersSettings {
  /** Applied when neither the caller nor the agent names a tier. */
  defaultTier?: string;
  /** A configured entry replaces the complete entry inherited from global settings. */
  profiles?: Record<string, AgentTierProfile>;
  /** Tombstones for malformed explicit profiles; not a user policy field. */
  blockedProfiles?: string[];
  /** Tombstone for a malformed defaultTier; not a user policy field. */
  blockedDefaultTier?: boolean;
}

export interface WorkflowTierProfile {
  /** `inherit` keeps the parent model; other values are provider/model references. */
  model: string;
  /** `inherit` keeps the parent Thinking level; other values are clamped natively. */
  thinking: WorkflowThinking;
}

/** Workflow policy configured by the user and resolved only by pi-subagents. */
export interface WorkflowSettings {
  /** Optional default used when a managed workflow task omits its tier. */
  defaultTier?: WorkflowTier;
  /** A configured entry replaces the complete entry inherited from global settings. */
  tiers?: Partial<Record<WorkflowTier, WorkflowTierProfile>>;
  /** Persistence tombstones for malformed explicit tier entries; not a user policy field. */
  blockedTiers?: WorkflowTier[];
  /** Persistence tombstone for a malformed defaultTier; not a user policy field. */
  blockedDefaultTier?: boolean;
}


export const DEFAULT_WORKFLOW_TIER_PROFILES: Readonly<Record<WorkflowTier, WorkflowTierProfile>> = {
  // Defaults are provider-neutral. Users may pin a tier to any concrete
  // provider/model in the same complete profile, but the extension must not
  // silently choose a vendor-specific model on a new machine.
  small: { model: "inherit", thinking: "low" },
  medium: { model: "inherit", thinking: "medium" },
  large: { model: "inherit", thinking: "high" },
};
export interface SubagentsSettings {
  /** Semantic model-plus-thinking profiles used by workflow-owned spawns. */
  workflow?: WorkflowSettings;
  /**
   * User-named model tiers for ordinary subagent spawns. Independent of
   * `workflow` above: the key space is arbitrary, and `pi-workflows` never reads
   * these. See `agent-tiers.ts` for resolution and precedence.
   */
  agentTiers?: AgentTiersSettings;
  /**
   * The model a subagent runs when nothing else chose one — no tier applied and
   * no programmatic override. It takes the place of the parent session's model
   * as the last step of resolution, so a workspace can say "subagents run on the
   * cheap model" without first defining a tier catalogue.
   *
   * A `provider/model` reference, or the literal `"inherit"` to follow the
   * parent. `"inherit"` is spellable rather than merely omittable because a
   * project needs a way to undo a global default; omitting the key inherits
   * whatever global set.
   *
   * Deliberately weaker than a tier: a tier naming an unavailable model fails
   * the spawn, because someone asked for that policy by name, while an
   * unresolvable default model falls back to the parent. Failing every spawn on
   * a machine that happens to lack one provider is the wrong trade for a value
   * nobody named at the call site — the `/agents → Settings` row shows the
   * fallback instead.
   */
  defaultModel?: string;
  maxConcurrent?: number;
  /**
   * 0 = unlimited — the extension's single source of truth for that convention:
   * `normalizeMaxTurns()` in agent-runner.ts treats 0 → `undefined`, and the
   * `/agents` → Settings input prompt explicitly says "0 = unlimited".
   */
  defaultMaxTurns?: number;
  graceTurns?: number;
  /**
   * Token budget for one subagent run. `0` (default) = unlimited, matching
   * `defaultMaxTurns`. A wrap-up steer is sent at 80% and the run is aborted at
   * 100%. Bounds what one agent can spend, which a turn count cannot — a single
   * turn can burn an arbitrary number of tokens. Frontmatter `max_tokens` wins.
   */
  defaultMaxTokens?: number;
  /**
   * Tool-call budget for one subagent run. `0` (default) = unlimited, with the
   * same 80%/100% shape as `defaultMaxTokens`. Frontmatter `max_tool_calls`
   * wins.
   */
  defaultMaxToolCalls?: number;
  defaultJoinMode?: JoinMode;
  /**
   * Master switch for the schedule subagent feature. Defaults to `true`.
   * When `false`: the `Agent` tool's `schedule` param + its guideline are
   * stripped from the tool spec at registration (zero LLM-context cost), the
   * scheduler doesn't bind to the session, and the `/agents → Scheduled jobs`
   * menu entry is hidden. Schema-level removal applies at extension load
   * (next pi session); runtime menu/runtime-fire short-circuit is immediate.
   */
  schedulingEnabled?: boolean;
  /**
   * When true, the effective model of each subagent spawn is validated
   * against `enabledModels` from pi's settings — both global
   * (`<agentDir>/settings.json`) and project-local (`<cwd>/.pi/settings.json`),
   * with project overriding global (mirrors pi's SettingsManager deep-merge).
   *
   * scopeModels guards against runtime LLM choices, not user-level config.
   * Out-of-scope handling reflects this:
   *   - Caller-supplied via `Agent({ model: "..." })` (only when frontmatter
   *     has no `model:`, since frontmatter is authoritative): hard error
   *     returned to the orchestrator, listing the allowed models. The LLM
   *     made an explicit out-of-scope choice and gets explicit feedback.
   *   - Frontmatter-pinned: warning toast + the pinned model runs. The
   *     agent's author/installer chose this; trust it.
   *   - Parent-inherited (neither caller nor frontmatter sets a model):
   *     warning toast + parent's model runs. The user chose the parent's
   *     model when starting the session; trust it.
   *
   * No-op when pi's `enabledModels` is empty or absent — nothing to validate
   * against. Defaults to false: subagents may use any model.
   */
  scopeModels?: boolean;
  /**
   * When true, an unreadable or unparseable agent `.md` aborts startup with the
   * path in the error. Normal mode skips the file with a warning; reloads after
   * startup remain lenient so a bad edit cannot kill a running session.
   */
  strictAgentFiles?: boolean;
  /**
   * When true, the three built-in default agents (general-purpose, Explore, Plan)
   * are not registered at startup. User-defined agents from project/global custom
   * agent dirs are completely unaffected — only the hardcoded DEFAULT_AGENTS are suppressed.
   * Defaults to false.
   */
  disableDefaultAgents?: boolean;
  /**
   * Which Agent tool description the LLM sees. "full" (default) is the rich
   * Claude Code-style prompt; "compact" is a ~75% smaller version (one-line
   * agent type list, terse usage notes) for small/local models where tool-spec
   * tokens are expensive; "custom" reads `.pi/agent-tool-description.md`
   * (project, falling back to `<agentDir>/agent-tool-description.md`) with
   * `{{placeholder}}` substitution — a missing/empty file falls back to "full".
   * The mode is read once at tool registration — changing it applies on the
   * next pi session.
   */
  toolDescriptionMode?: ToolDescriptionMode;
  /**
   * Whether the Claude Code-style FleetView (the navigable main+subagents list
   * rendered below the editor) is shown. Defaults to `true`. Pure-UI: when off,
   * the list never registers and the global key handler never captures input.
   */
  fleetView?: boolean;
  /**
   * Project/global default for writing each subagent's `.output` transcript
   * (a JSON-lines copy of the run, stored under the OS temp dir).
   * Defaults to `true`. Set `false` to make transcripts opt-in for the whole
   * project (e.g. a repo that shouldn't leave run transcripts on disk for backup
   * or DLP tooling to ingest). A custom agent's `output_transcript` frontmatter
   * overrides this per agent. This governs only the transcript — it does NOT
   * affect the persisted pi session (`persist_session`), worktree commits
   * (`isolation: worktree`), or memory files.
   */
  outputTranscript?: boolean;
  /**
   * Whether evicted agent records stay addressable as resumable entries
   * (`@handle` reopen). Defaults to true. When false, a cleaned-up record is
   * forgotten entirely.
   */
  rememberAgents?: boolean;
  /**
   * How `@handle message` typed at the prompt is dispatched.
   *
   *  - `"model"` (default) — a mention that names an agent TYPE takes its turn
   *    in an off-screen clone of the conversation, so the started agent gets a
   *    prompt written with context instead of only the words after the handle.
   *    Messaging and resuming an existing agent stay direct either way.
   *  - `"direct"` — start the agent straight from the typed text, no clone.
   *  - `"off"` — the text goes to the main model verbatim, exactly as it did
   *    before mentions existed.
   *
   * A boolean is still accepted and read as `"model"`/`"off"`.
   */
  agentMentions?: AgentMentionMode;
  /**
   * Whether subagents may interrupt with `contact_supervisor` to ask their
   * human a question. Defaults to true. The tool is only ever injected where
   * there is a UI to ask through, so this turns it off where there is one.
   */
  supervisorQuestions?: boolean;
  /**
   * Hard ceiling on nested subagent delegation, counted from the main session:
   * main = 0, its subagents = 1, their children = 2. Defaults to `2`; `0` or `1`
   * disables nesting project-wide. Read when a subagent session is built, so a
   * change applies to agents started after it.
   */
  maxSubagentDepth?: number;
  /**
   * Cumulative descendants any one top-level agent may start, over its whole
   * life. Defaults to `64`. The depth cap bounds how DEEP nesting goes and
   * nothing about how WIDE it gets — this is the horizontal bound. Minimum 1;
   * turn nesting off with `maxSubagentDepth` instead.
   */
  maxSubagentSpawnsPerBranch?: number;
  /**
   * Default per-tool timeout in milliseconds. `0` = disabled (no timeout). When
   * set, any tool call that does not settle within this window is aborted with
   * a timeout error, preventing a hung `bash` or MCP tool from stalling the
   * subagent forever. `0` when unset, matching tintinweb (no per-tool timeout
   * by default; hung tools are reclaimed via abort/quiescence). Frontmatter does
   * not override.
   */
  defaultToolTimeoutMs?: number;
  /**
   * Agent type substituted when a caller-supplied `subagent_type` doesn't
   * resolve to exactly one enabled agent (unknown, disabled, or ambiguous by
   * case). Omitted keeps the historical `general-purpose` fallback; a type name
   * routes those calls to that agent instead; `"none"` disables the fallback so
   * dispatch fails closed with an error naming the available types.
   *
   * The boolean `false` is accepted as a spelling of `"none"`, because a boolean
   * would otherwise be dropped as the wrong type and silently leave the
   * PERMISSIVE default in place while the author believes strict dispatch is on
   * — the wrong direction to fail for this setting. Every other value is an
   * agent name, so a mistaken `"off"` fails loudly at dispatch rather than
   * meaning one thing here and another in the resolver.
   */
  fallbackSubagent?: string;
}

export type ToolDescriptionMode = "full" | "compact" | "custom";

/** Setter hooks used by applySettings to wire persisted values into in-memory state. */
export interface SettingsAppliers {
  setMaxConcurrent: (n: number) => void;
  setDefaultMaxTurns: (n: number) => void;
  setGraceTurns: (n: number) => void;
  setDefaultMaxTokens: (n: number) => void;
  setDefaultMaxToolCalls: (n: number) => void;
  setDefaultToolTimeout?: (ms: number) => void;
  setDefaultJoinMode: (mode: JoinMode) => void;
  /** `undefined` and `"inherit"` both mean "follow the parent session". */
  setDefaultModel: (ref: string | undefined) => void;
  setSchedulingEnabled: (b: boolean) => void;
  setScopeModels: (enabled: boolean) => void;
  setStrictAgentFiles: (b: boolean) => void;
  setDisableDefaultAgents: (b: boolean) => void;
  setToolDescriptionMode: (mode: ToolDescriptionMode) => void;
  setFleetView: (b: boolean) => void;
  setOutputTranscript: (b: boolean) => void;
  setRememberAgents: (b: boolean) => void;
  setAgentMentions: (mode: AgentMentionMode) => void;
  setSupervisorQuestions: (b: boolean) => void;
  setMaxSubagentDepth: (n: number) => void;
  setMaxSubagentSpawnsPerBranch: (n: number) => void;
  setFallbackSubagent: (v: string | undefined) => void;
  /** Optional because non-runtime settings tests and consumers need not apply workflow state. */
  setWorkflow?: (settings: WorkflowSettings) => void;
  /** Optional for the same reason as `setWorkflow`. */
  setAgentTiers?: (settings: AgentTiersSettings) => void;
}

/** Emit callback — a subset of `pi.events.emit` to keep helpers testable. */
export type SettingsEmit = (event: string, payload: unknown) => void;

const VALID_JOIN_MODES: ReadonlySet<string> = new Set<JoinMode>(["async", "group", "smart"]);
const VALID_TOOL_DESCRIPTION_MODES: ReadonlySet<string> = new Set<ToolDescriptionMode>(["full", "compact", "custom"]);
/**
 * Thinking values a tier profile accepts, `inherit` first and then ascending.
 *
 * Ordered because the `/agents → Model tiers` editor offers them in this order;
 * note `off` is absent — a profile that wants no thinking says so through the
 * model it names, and `clampThinkingLevel` handles a model that supports none.
 */
export const TIER_THINKING_LEVELS: readonly TierThinking[] = [
  "inherit",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const VALID_THINKING_LEVELS: ReadonlySet<string> = new Set(TIER_THINKING_LEVELS);
const WORKFLOW_TIER_NAMES: readonly WorkflowTier[] = ["small", "medium", "large"];
const MAX_MODEL_REFERENCE_LENGTH = 512;
/** Mirrors MAX_AGENT_TIER_KEY_LENGTH in agent-tiers.ts; duplicated to keep settings dependency-free. */
const MAX_AGENT_TIER_KEY_LENGTH = 64;
/** Bounds a hand-edited config; far above any realistic number of tiers. */
const MAX_AGENT_TIER_PROFILES = 64;
const MAX_AGENT_TIER_DESCRIPTION_LENGTH = 512;

// Sanity ceilings — prevent hand-edited configs from asking for values that
// make no operational sense (e.g. 1e6 concurrent subagents). Permissive enough
// that any realistic power-user setting passes through.
const MAX_CONCURRENT_CEILING = 1024;
const MAX_TURNS_CEILING = 10_000;
const GRACE_TURNS_CEILING = 1_000;
const SUBAGENT_DEPTH_CEILING = 16;
/**
 * Upper bound on the branch spawn budget. A configured value this high is
 * already far past the point where a fan-out is intentional; the ceiling exists
 * so a typo cannot turn the horizontal bound off by writing a huge number.
 */
const SUBAGENT_SPAWNS_PER_BRANCH_CEILING = 4_096;
/** Per-tool timeout ceiling: 10 minutes, matching gate timeout. */
const TOOL_TIMEOUT_CEILING_MS = 600_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `inherit`, or a bounded whitespace-free `provider/model` reference.
 *
 * Exported so the `/agents` menus can reject a typed reference at the prompt.
 * Without that they would hand an invalid value to `saveSettings`, which drops
 * unrecognized fields silently — a success toast for a setting that never
 * persisted.
 */
export function isModelReference(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const model = value.trim();
  if (model === "inherit") return true;
  if (model.length === 0 || model.length > MAX_MODEL_REFERENCE_LENGTH || /\s/u.test(model)) return false;
  const slash = model.indexOf("/");
  return slash > 0 && slash < model.length - 1;
}

function validThinkingLevel(value: unknown): value is WorkflowThinking {
  return typeof value === "string" && VALID_THINKING_LEVELS.has(value);
}

/**
 * A profile is all-or-nothing. In particular, never turn `{ model: ... }` into
 * a profile whose thinking silently inherits from the parent: that would make a
 * typo in a policy file look like an intentional policy choice.
 */
function sanitizeWorkflowProfile(raw: unknown): WorkflowTierProfile | undefined {
  if (!isRecord(raw)) return undefined;
  const keys = Object.keys(raw);
  if (keys.some((key) => key !== "model" && key !== "thinking")) return undefined;
  if (!Object.hasOwn(raw, "model") || !Object.hasOwn(raw, "thinking")) return undefined;
  if (!isModelReference(raw.model) || !validThinkingLevel(raw.thinking)) return undefined;
  return { model: raw.model.trim(), thinking: raw.thinking };
}

function sanitizeWorkflow(raw: unknown): WorkflowSettings | undefined {
  if (!isRecord(raw)) return undefined;
  const out: WorkflowSettings = {};
  if (isWorkflowTierValue(raw.defaultTier)) out.defaultTier = raw.defaultTier;
  if (Object.hasOwn(raw, "defaultTier") && !isWorkflowTierValue(raw.defaultTier)) out.blockedDefaultTier = true;
  if (raw.blockedDefaultTier === true) out.blockedDefaultTier = true;
  if (Object.hasOwn(raw, "blockedTiers")) {
    const rawBlocked = raw.blockedTiers;
    const blocked = Array.isArray(rawBlocked) && rawBlocked.every(isWorkflowTierValue)
      ? [...new Set(rawBlocked)]
      : [...WORKFLOW_TIER_NAMES];
    if (blocked.length > 0) out.blockedTiers = blocked;
  }
  const tiersValue = raw.tiers;
  if (isRecord(tiersValue)) {
    const tiers: Partial<Record<WorkflowTier, WorkflowTierProfile>> = {};
    for (const tier of WORKFLOW_TIER_NAMES) {
      if (!Object.hasOwn(tiersValue, tier)) continue;
      const profile = sanitizeWorkflowProfile(tiersValue[tier]);
      if (profile) tiers[tier] = profile;
    }
    if (Object.keys(tiers).length > 0) out.tiers = tiers;
  }
  return out.defaultTier !== undefined || out.tiers !== undefined || out.blockedTiers !== undefined || out.blockedDefaultTier !== undefined ? out : undefined;
}

function isAgentTierKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_AGENT_TIER_KEY_LENGTH &&
    value.trim() === value &&
    !/\s/u.test(value)
  );
}

/**
 * A profile is all-or-nothing, for the same reason a workflow profile is: half
 * a profile with an implied `inherit` makes a typo look like a policy choice.
 * `description` is the one optional field — it is prose for the tool
 * description, and its absence has an obvious meaning (use the key).
 */
function sanitizeAgentTierProfile(raw: unknown): AgentTierProfile | undefined {
  if (!isRecord(raw)) return undefined;
  const keys = Object.keys(raw);
  if (keys.some((key) => key !== "model" && key !== "thinking" && key !== "description")) return undefined;
  if (!Object.hasOwn(raw, "model") || !Object.hasOwn(raw, "thinking")) return undefined;
  if (!isModelReference(raw.model) || !validThinkingLevel(raw.thinking)) return undefined;
  if (
    Object.hasOwn(raw, "description") &&
    (typeof raw.description !== "string" ||
      raw.description.trim().length === 0 ||
      raw.description.length > MAX_AGENT_TIER_DESCRIPTION_LENGTH)
  ) {
    return undefined;
  }
  return {
    model: raw.model.trim(),
    thinking: raw.thinking,
    ...(typeof raw.description === "string" ? { description: raw.description.trim() } : {}),
  };
}

function sanitizeAgentTiers(raw: unknown): AgentTiersSettings | undefined {
  if (!isRecord(raw)) return undefined;
  const out: AgentTiersSettings = {};
  if (isAgentTierKey(raw.defaultTier)) out.defaultTier = raw.defaultTier;
  if (Object.hasOwn(raw, "defaultTier") && !isAgentTierKey(raw.defaultTier)) out.blockedDefaultTier = true;
  if (raw.blockedDefaultTier === true) out.blockedDefaultTier = true;
  if (Array.isArray(raw.blockedProfiles)) {
    const blocked = [...new Set(raw.blockedProfiles.filter(isAgentTierKey))];
    if (blocked.length > 0) out.blockedProfiles = blocked;
  }
  if (isRecord(raw.profiles)) {
    const profiles: Record<string, AgentTierProfile> = {};
    for (const key of Object.keys(raw.profiles).slice(0, MAX_AGENT_TIER_PROFILES)) {
      if (!isAgentTierKey(key)) continue;
      const profile = sanitizeAgentTierProfile(raw.profiles[key]);
      if (profile) profiles[key] = profile;
    }
    if (Object.keys(profiles).length > 0) out.profiles = profiles;
  }
  return out.defaultTier !== undefined ||
    out.profiles !== undefined ||
    out.blockedProfiles !== undefined ||
    out.blockedDefaultTier !== undefined
    ? out
    : undefined;
}

function isWorkflowTierValue(value: unknown): value is WorkflowTier {
  return value === "small" || value === "medium" || value === "large";
}
/** Drop fields that don't match the expected shape. Silent — garbage becomes absent. */
function sanitize(raw: unknown): SubagentsSettings {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: SubagentsSettings = {};
  if (
    Number.isInteger(r.maxConcurrent) &&
    (r.maxConcurrent as number) >= 1 &&
    (r.maxConcurrent as number) <= MAX_CONCURRENT_CEILING
  ) {
    out.maxConcurrent = r.maxConcurrent as number;
  }
  if (
    Number.isInteger(r.defaultMaxTurns) &&
    (r.defaultMaxTurns as number) >= 0 &&
    (r.defaultMaxTurns as number) <= MAX_TURNS_CEILING
  ) {
    out.defaultMaxTurns = r.defaultMaxTurns as number;
  }
  if (
    Number.isInteger(r.graceTurns) &&
    (r.graceTurns as number) >= 1 &&
    (r.graceTurns as number) <= GRACE_TURNS_CEILING
  ) {
    out.graceTurns = r.graceTurns as number;
  }
  // `0` is accepted and means unlimited, matching `defaultMaxTurns`.
  if (Number.isInteger(r.defaultMaxTokens) && (r.defaultMaxTokens as number) >= 0) {
    out.defaultMaxTokens = r.defaultMaxTokens as number;
  }
  if (Number.isInteger(r.defaultMaxToolCalls) && (r.defaultMaxToolCalls as number) >= 0) {
    out.defaultMaxToolCalls = r.defaultMaxToolCalls as number;
  }
  if (
    Number.isInteger(r.maxSubagentDepth) &&
    (r.maxSubagentDepth as number) >= 0 &&
    (r.maxSubagentDepth as number) <= SUBAGENT_DEPTH_CEILING
  ) {
    out.maxSubagentDepth = r.maxSubagentDepth as number;
  }
  // Minimum 1, not 0: zero reads as a limit, and silently meaning "unlimited"
  // is how a safety valve gets disabled by accident. Nesting is turned off with
  // `maxSubagentDepth`, which says so.
  if (
    Number.isInteger(r.maxSubagentSpawnsPerBranch) &&
    (r.maxSubagentSpawnsPerBranch as number) >= 1 &&
    (r.maxSubagentSpawnsPerBranch as number) <= SUBAGENT_SPAWNS_PER_BRANCH_CEILING
  ) {
    out.maxSubagentSpawnsPerBranch = r.maxSubagentSpawnsPerBranch as number;
  }
  if (
    Number.isInteger(r.defaultToolTimeoutMs) &&
    (r.defaultToolTimeoutMs as number) >= 0 &&
    (r.defaultToolTimeoutMs as number) <= TOOL_TIMEOUT_CEILING_MS
  ) {
    out.defaultToolTimeoutMs = r.defaultToolTimeoutMs as number;
  }
  if (isModelReference(r.defaultModel)) {
    out.defaultModel = r.defaultModel.trim();
  }
  if (typeof r.defaultJoinMode === "string" && VALID_JOIN_MODES.has(r.defaultJoinMode)) {
    out.defaultJoinMode = r.defaultJoinMode as JoinMode;
  }
  if (typeof r.schedulingEnabled === "boolean") {
    out.schedulingEnabled = r.schedulingEnabled;
  }
  if (typeof r.scopeModels === "boolean") {
    out.scopeModels = r.scopeModels;
  }
  if (typeof r.strictAgentFiles === "boolean") {
    out.strictAgentFiles = r.strictAgentFiles;
  }
  if (typeof r.disableDefaultAgents === "boolean") {
    out.disableDefaultAgents = r.disableDefaultAgents;
  }
  if (typeof r.toolDescriptionMode === "string" && VALID_TOOL_DESCRIPTION_MODES.has(r.toolDescriptionMode)) {
    out.toolDescriptionMode = r.toolDescriptionMode as ToolDescriptionMode;
  }
  if (typeof r.fleetView === "boolean") {
    out.fleetView = r.fleetView;
  }
  if (typeof r.outputTranscript === "boolean") {
    out.outputTranscript = r.outputTranscript;
  }
  if (typeof r.rememberAgents === "boolean") {
    out.rememberAgents = r.rememberAgents;
  }
  if (typeof r.agentMentions === "boolean") {
    out.agentMentions = r.agentMentions ? "model" : "off";
  } else if (typeof r.agentMentions === "string" && VALID_AGENT_MENTION_MODES.has(r.agentMentions)) {
    out.agentMentions = r.agentMentions as AgentMentionMode;
  }
  if (typeof r.supervisorQuestions === "boolean") {
    out.supervisorQuestions = r.supervisorQuestions;
  }
  if (r.fallbackSubagent === false) {
    // The only non-string spelling worth accepting: a boolean would otherwise be
    // dropped, silently leaving the PERMISSIVE default in place. Every string is
    // an agent name except the `none` sentinel, which the resolver recognizes —
    // so a mistaken "off" fails loudly at dispatch instead of meaning something
    // different here than it does there.
    out.fallbackSubagent = NO_FALLBACK;
  } else if (typeof r.fallbackSubagent === "string" && r.fallbackSubagent.trim()) {
    out.fallbackSubagent = r.fallbackSubagent.trim();
  }

  const workflow = sanitizeWorkflow(r.workflow);
  if (workflow) out.workflow = workflow;
  const agentTiers = sanitizeAgentTiers(r.agentTiers);
  if (agentTiers) out.agentTiers = agentTiers;
  return out;
}

function globalPath(): string {
  return join(getAgentDir(), "subagents.json");
}

function projectPath(cwd: string): string {
  return join(cwd, ".pi", "subagents.json");
}

/**
 * Read a settings file. Missing file is silent (returns `{}`). A file that
 * exists but can't be parsed emits a warning to stderr and blocks workflow-tier
 * policy so users aren't silently reverted to defaults.
 */
interface WorkflowSource {
  present: boolean;
  object: boolean;
  defaultTierPresent: boolean;
  defaultTier?: WorkflowTier;
  tiersPresent: boolean;
  tiersObject: boolean;
  tierEntries: Partial<Record<WorkflowTier, WorkflowTierProfile | undefined>>;
  blockedTiers: WorkflowTier[];
  blockedDefaultTier: boolean;
}

/**
 * Presence of each agent-tier entry in one file, kept separate from the
 * sanitized value so the merge can tell "the project did not mention this
 * profile" from "the project mentioned it and it was malformed". Only the
 * second may block the global entry, and neither may silently revive it.
 */
interface AgentTiersSource {
  present: boolean;
  object: boolean;
  defaultTierPresent: boolean;
  defaultTier?: string;
  profilesPresent: boolean;
  profilesObject: boolean;
  profileEntries: Record<string, AgentTierProfile | undefined>;
  blockedProfiles: string[];
  blockedDefaultTier: boolean;
}

interface ReadSettings {
  settings: SubagentsSettings;
  workflow: WorkflowSource;
  agentTiers: AgentTiersSource;
}

function emptyWorkflowSource(): WorkflowSource {
  return {
    present: false,
    object: false,
    defaultTierPresent: false,
    blockedDefaultTier: false,
    tiersPresent: false,
    tiersObject: false,
    tierEntries: {},
    blockedTiers: [],
  };
}

function emptyAgentTiersSource(): AgentTiersSource {
  return {
    present: false,
    object: false,
    defaultTierPresent: false,
    blockedDefaultTier: false,
    profilesPresent: false,
    profilesObject: false,
    profileEntries: {},
    blockedProfiles: [],
  };
}

/** Preserve invalid agent-tier entry presence so project policy cannot resurrect a global entry. */
function agentTiersSource(raw: unknown): AgentTiersSource {
  if (!isRecord(raw) || !Object.hasOwn(raw, "agentTiers")) return emptyAgentTiersSource();
  const value = raw.agentTiers;
  if (!isRecord(value)) {
    return { ...emptyAgentTiersSource(), present: true, object: false, blockedDefaultTier: true };
  }

  const source: AgentTiersSource = {
    present: true,
    object: true,
    defaultTierPresent: Object.hasOwn(value, "defaultTier"),
    blockedDefaultTier:
      (Object.hasOwn(value, "defaultTier") && !isAgentTierKey(value.defaultTier)) || value.blockedDefaultTier === true,
    ...(isAgentTierKey(value.defaultTier) ? { defaultTier: value.defaultTier } : {}),
    profilesPresent: Object.hasOwn(value, "profiles"),
    profilesObject: isRecord(value.profiles),
    profileEntries: {},
    blockedProfiles: Array.isArray(value.blockedProfiles) ? value.blockedProfiles.filter(isAgentTierKey) : [],
  };

  if (isRecord(value.profiles)) {
    for (const key of Object.keys(value.profiles).slice(0, MAX_AGENT_TIER_PROFILES)) {
      if (!isAgentTierKey(key)) continue;
      const profile = sanitizeAgentTierProfile(value.profiles[key]);
      source.profileEntries[key] = profile;
      if (!profile) source.blockedProfiles.push(key);
    }
  }
  source.blockedProfiles = [...new Set(source.blockedProfiles)];
  return source;
}

/**
 * Global supplies the catalogue, project edits it. A project profile replaces
 * its global namesake whole — never field by field, which would let a project
 * change a model while inheriting a thinking level nobody chose for that pair.
 */
function mergeAgentTierSources(
  global: AgentTiersSource,
  project: AgentTiersSource,
): AgentTiersSettings | undefined {
  if (!global.present && !project.present) return undefined;

  const merged: AgentTiersSettings = {};
  if (project.present && !project.object) {
    // The project said "agentTiers" and gave something that is not an object.
    // Inheriting the global catalogue here would run models the project was
    // trying to change, so the whole policy is blocked instead.
    merged.blockedDefaultTier = true;
    const inherited = [
      ...new Set([...Object.keys(global.profileEntries), ...global.blockedProfiles]),
    ].sort((a, b) => a.localeCompare(b));
    if (inherited.length > 0) merged.blockedProfiles = inherited;
    return merged;
  }

  if (project.defaultTierPresent) {
    if (project.defaultTier !== undefined) merged.defaultTier = project.defaultTier;
    else merged.blockedDefaultTier = true;
  } else {
    if (global.defaultTier !== undefined) merged.defaultTier = global.defaultTier;
    if (global.blockedDefaultTier || project.blockedDefaultTier) merged.blockedDefaultTier = true;
  }

  const blocked = new Set<string>([...global.blockedProfiles, ...project.blockedProfiles]);
  const profiles: Record<string, AgentTierProfile> = {};
  const keys = [...new Set([...Object.keys(global.profileEntries), ...Object.keys(project.profileEntries)])];
  for (const key of keys) {
    if (project.profilesPresent && !project.profilesObject) {
      blocked.add(key);
      continue;
    }
    if (Object.hasOwn(project.profileEntries, key)) {
      const profile = project.profileEntries[key];
      if (profile) {
        profiles[key] = profile;
        blocked.delete(key);
      } else {
        blocked.add(key);
      }
      continue;
    }
    const inherited = global.profileEntries[key];
    if (inherited) profiles[key] = inherited;
  }

  if (Object.keys(profiles).length > 0) merged.profiles = profiles;
  if (blocked.size > 0) merged.blockedProfiles = [...blocked].sort((a, b) => a.localeCompare(b));
  return merged.defaultTier !== undefined ||
    merged.profiles !== undefined ||
    merged.blockedProfiles !== undefined ||
    merged.blockedDefaultTier !== undefined
    ? merged
    : undefined;
}

/** Preserve invalid workflow entry presence so project policy cannot resurrect a global entry. */
function workflowSource(raw: unknown): WorkflowSource {
  if (!isRecord(raw) || !Object.hasOwn(raw, "workflow")) return emptyWorkflowSource();
  const value = raw.workflow;
  if (!isRecord(value)) {
    return {
      ...emptyWorkflowSource(),
      present: true,
      object: false,
      blockedTiers: [...WORKFLOW_TIER_NAMES],
      blockedDefaultTier: true,
    };
  }
  const tiersValue = value.tiers;
  const blockedTiers: WorkflowTier[] = [];
  if (Object.hasOwn(value, "blockedTiers")) {
    const rawBlocked = value.blockedTiers;
    if (Array.isArray(rawBlocked) && rawBlocked.every(isWorkflowTierValue)) blockedTiers.push(...new Set(rawBlocked));
    else blockedTiers.push(...WORKFLOW_TIER_NAMES);
  }
  const source: WorkflowSource = {
    present: true,
    object: true,
    defaultTierPresent: Object.hasOwn(value, "defaultTier"),
    blockedDefaultTier:
      (Object.hasOwn(value, "defaultTier") && !isWorkflowTierValue(value.defaultTier)) || value.blockedDefaultTier === true,
    ...(isWorkflowTierValue(value.defaultTier) ? { defaultTier: value.defaultTier } : {}),
    tiersPresent: Object.hasOwn(value, "tiers"),
    tiersObject: isRecord(tiersValue),
    tierEntries: {},
    blockedTiers,
  };
  if (Object.hasOwn(value, "tiers") && !source.tiersObject) blockedTiers.push(...WORKFLOW_TIER_NAMES);
  if (isRecord(tiersValue)) {
    for (const tier of WORKFLOW_TIER_NAMES) {
      if (!Object.hasOwn(tiersValue, tier)) continue;
      const profile = sanitizeWorkflowProfile(tiersValue[tier]);
      source.tierEntries[tier] = profile;
      if (!profile) blockedTiers.push(tier);
    }
  }
  source.blockedTiers = [...new Set(blockedTiers)];
  return source;
}

function readSettingsFile(path: string): ReadSettings {
  if (!existsSync(path)) {
    return { settings: {}, workflow: emptyWorkflowSource(), agentTiers: emptyAgentTiersSource() };
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return { settings: sanitize(raw), workflow: workflowSource(raw), agentTiers: agentTiersSource(raw) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[pi-subagents] Ignoring malformed settings at ${path}: ${reason}`);
    return {
      settings: {},
      workflow: {
        ...emptyWorkflowSource(),
        present: true,
        object: false,
        blockedTiers: [...WORKFLOW_TIER_NAMES],
        blockedDefaultTier: true,
      },
      // An unreadable file may have held the tier catalogue; block rather than
      // fall through to whatever global happens to define.
      agentTiers: { ...emptyAgentTiersSource(), present: true, object: false, blockedDefaultTier: true },
    };
  }
}

/**
 * Load merged settings: global provides defaults, project overrides. Workflow
 * profiles are complete replacement units: a project entry never inherits one
 * field from the global entry, and an invalid project entry blocks that global
 * entry instead of silently reviving it.
 */
export function loadSettings(cwd: string = process.cwd()): SubagentsSettings {
  const global = readSettingsFile(globalPath());
  const project = readSettingsFile(projectPath(cwd));
  const { workflow: _globalWorkflow, agentTiers: _globalAgentTiers, ...globalSettings } = global.settings;
  const { workflow: _projectWorkflow, agentTiers: _projectAgentTiers, ...projectSettings } = project.settings;
  const workflow = mergeWorkflowSources(global.workflow, project.workflow);
  const agentTiers = mergeAgentTierSources(global.agentTiers, project.agentTiers);
  return {
    ...globalSettings,
    ...projectSettings,
    ...(workflow ? { workflow } : {}),
    ...(agentTiers ? { agentTiers } : {}),
  };
}

function mergeWorkflowSources(global: WorkflowSource, project: WorkflowSource): WorkflowSettings | undefined {
  if (!global.present && !project.present) return undefined;

  const merged: WorkflowSettings = {};
  if (project.present && !project.object) {
    merged.blockedTiers = [...WORKFLOW_TIER_NAMES];
    merged.blockedDefaultTier = true;
    return merged;
  }
  if (project.defaultTierPresent) {
    if (project.defaultTier !== undefined) {
      merged.defaultTier = project.defaultTier;
    } else {
      merged.blockedDefaultTier = true;
    }
  } else {
    if (global.defaultTier !== undefined) merged.defaultTier = global.defaultTier;
    if (global.blockedDefaultTier || project.blockedDefaultTier) merged.blockedDefaultTier = true;
  }

  const blocked = new Set<WorkflowTier>([...global.blockedTiers, ...project.blockedTiers]);
  const tiers: Partial<Record<WorkflowTier, WorkflowTierProfile>> = {};
  for (const tier of WORKFLOW_TIER_NAMES) {
    if (project.tiersPresent && !project.tiersObject) {
      blocked.add(tier);
      continue;
    }
    if (project.tiersObject && Object.hasOwn(project.tierEntries, tier)) {
      const profile = project.tierEntries[tier];
      if (profile) {
        tiers[tier] = profile;
        blocked.delete(tier);
      } else {
        blocked.add(tier);
      }
      continue;
    }
    if (Object.hasOwn(global.tierEntries, tier)) {
      const profile = global.tierEntries[tier];
      if (profile) tiers[tier] = profile;
    }
  }
  if (Object.keys(tiers).length > 0) merged.tiers = tiers;
  if (blocked.size > 0) merged.blockedTiers = WORKFLOW_TIER_NAMES.filter((tier) => blocked.has(tier));
  return merged.defaultTier !== undefined || merged.tiers !== undefined || merged.blockedTiers !== undefined || merged.blockedDefaultTier !== undefined ? merged : undefined;
}

/**
 * Write project-local settings. Global is never touched from code.
 * Returns `true` on success, `false` if the write (or mkdir) failed so the
 * caller can surface a warning — persistence isn't fatal but isn't silent.
 */
export function saveSettings(s: SubagentsSettings, cwd: string = process.cwd()): boolean {
  const path = projectPath(cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Atomic write: settings are written on every /agents mutation, and a torn
    // write (crash, kill, disk full between truncate and flush) would silently
    // discard the project's entire configuration. Write to a unique temp file
    // in the same directory, then rename over the target — rename is atomic on
    // POSIX and Windows. Same pattern as packages/pi-goal/src/settings.ts.
    const document = `${JSON.stringify(sanitize(s), null, 2)}\n`;
    const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporaryPath, document, { encoding: "utf8", flag: "wx" });
      renameSync(temporaryPath, path);
    } finally {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Best-effort cleanup must not replace the save result.
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Apply persisted settings to the in-memory state via caller-supplied setters. */
export function applySettings(s: SubagentsSettings, appliers: SettingsAppliers): void {
  if (typeof s.maxConcurrent === "number") appliers.setMaxConcurrent(s.maxConcurrent);
  if (typeof s.defaultMaxTurns === "number") appliers.setDefaultMaxTurns(s.defaultMaxTurns);
  if (typeof s.graceTurns === "number") appliers.setGraceTurns(s.graceTurns);
  if (typeof s.defaultMaxTokens === "number") appliers.setDefaultMaxTokens(s.defaultMaxTokens);
  if (typeof s.defaultMaxToolCalls === "number") appliers.setDefaultMaxToolCalls(s.defaultMaxToolCalls);
  if (typeof s.maxSubagentDepth === "number") appliers.setMaxSubagentDepth(s.maxSubagentDepth);
  if (typeof s.maxSubagentSpawnsPerBranch === "number")
    appliers.setMaxSubagentSpawnsPerBranch(s.maxSubagentSpawnsPerBranch);
  if (typeof s.defaultToolTimeoutMs === "number") {
    appliers.setDefaultToolTimeout?.(s.defaultToolTimeoutMs);
    // Fallback for hosts that have not yet wired the new applier (and for tests
    // that call applySettings with a minimal appliers object): ensure the
    // in-memory timeout still follows the persisted value.
    setDefaultToolTimeoutMs(s.defaultToolTimeoutMs);
  }
  if (typeof s.fallbackSubagent === "string") appliers.setFallbackSubagent(s.fallbackSubagent);
  // Applied whenever the key is present, `"inherit"` included: that spelling is
  // how a project cancels a global default model, so it has to reach the setter.
  if (typeof s.defaultModel === "string") appliers.setDefaultModel(s.defaultModel);
  if (s.defaultJoinMode) appliers.setDefaultJoinMode(s.defaultJoinMode);
  if (typeof s.schedulingEnabled === "boolean") appliers.setSchedulingEnabled(s.schedulingEnabled);
  if (typeof s.scopeModels === "boolean") appliers.setScopeModels(s.scopeModels);
  if (typeof s.strictAgentFiles === "boolean") appliers.setStrictAgentFiles(s.strictAgentFiles);
  if (typeof s.disableDefaultAgents === "boolean") appliers.setDisableDefaultAgents(s.disableDefaultAgents);
  if (s.toolDescriptionMode) appliers.setToolDescriptionMode(s.toolDescriptionMode);
  if (typeof s.fleetView === "boolean") appliers.setFleetView(s.fleetView);
  if (typeof s.outputTranscript === "boolean") appliers.setOutputTranscript(s.outputTranscript);
  if (typeof s.rememberAgents === "boolean") appliers.setRememberAgents(s.rememberAgents);
  if (s.agentMentions) appliers.setAgentMentions(s.agentMentions);
  if (typeof s.supervisorQuestions === "boolean") appliers.setSupervisorQuestions(s.supervisorQuestions);
  if (s.workflow) appliers.setWorkflow?.(s.workflow);
  // Applied unconditionally so a session that had tiers and no longer does gets
  // the empty catalogue rather than keeping the previous one.
  appliers.setAgentTiers?.(s.agentTiers ?? {});
}

/**
 * Format the user-facing toast for a settings mutation. Pure function —
 * routes the success/failure of `saveSettings` into the right message + level
 * so the UI layer (index.ts) stays a thin wire between input and notification.
 */
export function persistToastFor(
  successMsg: string,
  persisted: boolean,
): { message: string; level: "info" | "warning" } {
  return persisted
    ? { message: successMsg, level: "info" }
    : { message: `${successMsg} (session only; failed to persist)`, level: "warning" };
}

/**
 * Load merged settings, apply them to in-memory state, and emit the
 * `subagents:settings_loaded` lifecycle event. Returns the loaded settings so
 * callers can log/inspect. Extension init wires this once.
 */
export function applyAndEmitLoaded(
  appliers: SettingsAppliers,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): SubagentsSettings {
  const settings = loadSettings(cwd);
  applySettings(settings, appliers);
  emit("subagents:settings_loaded", { settings });
  return settings;
}

/**
 * Persist a settings snapshot, emit the `subagents:settings_changed` event
 * (regardless of persist outcome so listeners see the in-memory change), and
 * return the toast the UI should display. Event payload carries the `persisted`
 * flag so listeners can react to write failures.
 */
export function saveAndEmitChanged(
  snapshot: SubagentsSettings,
  successMsg: string,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): { message: string; level: "info" | "warning" } {
  const persisted = saveSettings(snapshot, cwd);
  emit("subagents:settings_changed", { settings: snapshot, persisted });
  return persistToastFor(successMsg, persisted);
}
