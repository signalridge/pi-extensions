/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { WorkflowTier } from "@signalridge/pi-subagents-protocol";
import { type AgentTierResolutionSnapshot, resolveAgentTier } from "./agent-tiers.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getConfig, getMemoryToolNames, getReadOnlyMemoryToolNames, getToolNamesForType } from "./agent-types.js";
import { createAskGate } from "./ask-tools.js";
import { runInChildSessionContext } from "./child-context.js";
import { buildParentContext, extractText } from "./context.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { detectEnv } from "./env.js";
import { formatGateVerdict, type GateExec, runGate, workspaceFingerprint } from "./gate.js";
import {
  INTERNAL_AGENT_CONFIG_OVERRIDE,
  type InternalAgentConfigOverride,
} from "./internal-run.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "./memory.js";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import { checkModelScope } from "./model-scope.js";
import { createNestedSubagentTools, getMaxSubagentDepth, type NestedAgentManager } from "./nested-tools.js";
import { buildAgentPrompt, type PromptExtras } from "./prompts.js";
import { shutdownAndDisposeSession } from "./session-lifecycle.js";
import { preloadSkills } from "./skill-loader.js";
import { createSupervisorTool } from "./supervisor.js";
import type { SubagentType, ThinkingLevel } from "./types.js";
import type { WorkflowTierResolutionSnapshot } from "./workflow-tiers.js";
import { resolveWorkflowTier } from "./workflow-tiers.js";

/**
 * Tool names registered by THIS extension. Single source of truth so the
 * registration sites (index.ts) and the subagent exclusion list below can't
 * drift apart. These are our own tools, not pi built-ins, so they can't be
 * derived from pi — but they only need defining once.
 */
export const SUBAGENT_TOOL_NAMES = {
  AGENT: "Agent",
  GET_RESULT: "get_subagent_result",
  STEER: "steer_subagent",
} as const;

/** Names of tools registered by this extension that subagents must NOT inherit. */
const EXCLUDED_TOOL_NAMES: string[] = Object.values(SUBAGENT_TOOL_NAMES);

/**
 * Canonical name of an extension for `extensions: [...]` allowlist matching.
 * Lowercased — extension names match case-insensitively so `extensions: [Mcp]`
 * resolves the same as `[mcp]`. Tool names within `ext:foo/bar` are not affected.
 * Directory extensions (`foo/index.ts`) resolve to the parent directory name;
 * single-file extensions to the basename minus `.ts`/`.js`.
 */
export function extensionCanonicalName(extPath: string): string {
  const base = basename(extPath);
  const name = base === "index.ts" || base === "index.js"
    ? basename(dirname(extPath))
    : base.replace(/\.(ts|js)$/, "");
  return name.toLowerCase();
}

/**
 * The unscoped, lowercased npm short name of the pi package that DECLARES
 * `extPath` as an extension entry — or undefined if the entry doesn't belong to
 * such a package.
 *
 * Climbs from the entry's directory looking for the package that owns it, and
 * stays strictly within that package's tree by stopping at two structural
 * boundaries — no hardcoded depth:
 *   - the FIRST `package.json` found (the package root); the entry's own
 *     manifest always sits at the root, above the entry, below any node_modules.
 *   - a `node_modules` directory: a package never spans one (it's where OTHER
 *     packages live), so reaching it means we've climbed out of the package —
 *     stop before reading a consumer's or parent package's manifest.
 * The name is then taken only when that root's `pi.extensions` manifest actually
 * lists this entry. That "declares this entry" check is deliberate: our own test
 * fixtures live under this repo, whose root manifest declares `./src/index.ts`
 * as `@signalridge/pi-subagents`, so a looser rule would misattribute every
 * co-located file to `pi-subagents`.
 */
function extensionPackageName(extPath: string): string | undefined {
  const entry = resolve(extPath);
  let dir = dirname(extPath);
  for (;;) {
    // Climbing into node_modules means we've left the owning package's tree.
    if (basename(dir) === "node_modules") return undefined;
    let pkg: { name?: unknown; pi?: { extensions?: unknown } };
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return undefined; // walked to the filesystem root
      dir = parent;
      continue;
    }
    // First package.json wins — it's the package root; decide here.
    const entries = pkg.pi?.extensions;
    if (
      typeof pkg.name === "string" &&
      Array.isArray(entries) &&
      entries.some((e) => typeof e === "string" && resolve(dir, e) === entry)
    ) {
      const short = pkg.name.startsWith("@") ? pkg.name.slice(pkg.name.indexOf("/") + 1) : pkg.name;
      return short.toLowerCase();
    }
    return undefined;
  }
}

/**
 * All names an extension answers to for allowlist matching (lowercased): its
 * path-derived {@link extensionCanonicalName} plus, when a pi package manifest
 * declares this entry, that package's unscoped short name (`@scope/foo` → `foo`).
 * #143: an extension installed via `pi.extensions: ["./src/index.ts"]` would
 * otherwise only ever match as `src` (the source directory), never by its
 * package name. The path-derived name is preserved, so it keeps matching too.
 */
export function extensionCanonicalNames(extPath: string): string[] {
  const canonical = extensionCanonicalName(extPath);
  const pkg = extensionPackageName(extPath);
  return pkg && pkg !== canonical ? [canonical, pkg] : [canonical];
}

/**
 * Classify `extensions: string[]` frontmatter entries for the loader-level filter.
 *
 * An entry is a PATH iff it contains a path separator or starts with `~`; otherwise
 * it is a NAME. `"*"` sets the wildcard flag (keep all default-discovered extensions).
 *
 * Path entries are resolved (`~` expanded, made absolute against `cwd`) into `paths`
 * — and their canonical name is also added to `names`. The loader override matches
 * everything by canonical name, so path-loaded extensions are matched via their name
 * rather than their post-staging `Extension.path`.
 */
export function parseExtensionsSpec(
  entries: string[],
  cwd: string,
): { names: Set<string>; paths: string[]; wildcard: boolean } {
  const names = new Set<string>();
  const paths: string[] = [];
  let wildcard = false;
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === "*") {
      wildcard = true;
      continue;
    }
    const isPathEntry = entry.includes("/") || entry.includes("\\") || entry.startsWith("~");
    if (!isPathEntry) {
      names.add(entry.toLowerCase());
      continue;
    }
    let p = entry;
    if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
      p = homedir() + p.slice(1);
    }
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    paths.push(abs);
    names.add(extensionCanonicalName(abs));
  }
  return { names, paths, wildcard };
}

/**
 * Parse raw `ext:` selector strings (from the `tools:` CSV) into the set of
 * extension names to keep loaded and a per-extension tool-narrowing map.
 *
 * `ext:foo` → `extNames` has `foo`, no narrowing entry (all of foo's tools).
 * `ext:foo/bar` → `extNames` has `foo`, `narrowing.foo` has `bar` (only `bar`).
 * A name lands in `narrowing` only when a `/tool` form is seen, so a bare
 * `ext:foo` alongside `ext:foo/bar` leaves narrowing in effect (narrowing wins).
 * The split is on the first `/`; extension canonical names never contain `/`.
 */
export function parseExtSelectors(entries: string[]): {
  extNames: Set<string>;
  narrowing: Map<string, Set<string>>;
} {
  const extNames = new Set<string>();
  const narrowing = new Map<string, Set<string>>();
  for (const raw of entries) {
    if (!raw) continue;
    const body = raw.slice("ext:".length);
    const slash = body.indexOf("/");
    // Extension name matches case-insensitively (matches the loader-side canonical
    // name). Tool names are case-preserved — they're matched against pi-mono's
    // registered identifiers, which are case-sensitive.
    const name = (slash === -1 ? body : body.slice(0, slash)).trim().toLowerCase();
    if (!name) continue;
    extNames.add(name);
    if (slash === -1) continue;
    const tool = body.slice(slash + 1).trim();
    if (!tool) continue;
    let set = narrowing.get(name);
    if (!set) {
      set = new Set();
      narrowing.set(name, set);
    }
    set.add(tool);
  }
  return { extNames, narrowing };
}

/**
 * Keep a subagent's tool scope correct as extensions register tools over time.
 *
 * Extensions may call `registerTool` long after load — pi-mcp from `session_start`,
 * context-mode from `before_agent_start` — so scope has to be re-derived rather than
 * snapshotted. `registerTool` writes into the very `extension.tools` maps this reads,
 * so `inScope()` sees late arrivals on the next call.
 *
 * Two enforcement points, because neither covers the whole picture:
 *
 *   - `turn_end` re-narrows the ACTIVE set. pi emits `turn_end` immediately before
 *     `prepareNextTurn` re-snapshots `agent.state.tools`, and session listeners run
 *     synchronously, so the narrow lands in time for turns 2..N.
 *   - `beforeToolCall` blocks out-of-scope calls. Turn 1 cannot be narrowed at all:
 *     `before_agent_start` fires INSIDE `prompt()` and may widen the tool set, but
 *     `createContextSnapshot()` freezes that turn's tools immediately after — there
 *     is no hook in between. A call-time check is the only correct guard there.
 *
 * Both are installed on the session and deliberately NOT unsubscribed: they must
 * outlive the `runAgent` call so resumed/steered turns stay scoped. pi's `dispose()`
 * clears `_eventListeners`, so they die with the session rather than leaking.
 *
 * Only meaningful when extensions are loaded — under `noExtensions`/`isolated` the
 * static `allowedToolNames` allowlist already gates the registry itself.
 */
export function installExtensionToolScope(
  session: AgentSession,
  ctx: {
    loader: DefaultResourceLoader;
    toolNames: string[];
    disallowedSet: Set<string> | undefined;
    extNames: Set<string>;
    narrowing: Map<string, Set<string>>;
    /** Opt-in nested-delegation tool names to keep active despite the EXCLUDED strip. */
    nestedToolNames: Set<string>;
    /** Per-call approval gate from `ask_tools:`, when the agent declares any. */
    askGate?: (toolName: string, input: unknown) => Promise<{ block: true; reason: string } | undefined>;
  },
): void {
  const { loader, toolNames, disallowedSet, extNames, narrowing, nestedToolNames, askGate } = ctx;

  // The names allowed right now. Mirrors the `ext:` opt-in flip: when any `ext:`
  // selector is present, extension tools become an explicit allowlist — a loaded
  // extension not named by a selector contributes nothing (its handlers still ran),
  // and `ext:foo/bar` narrows `foo` to just `bar`.
  const inScope = (): Set<string> => {
    const keep = new Set(toolNames.filter((t) => !disallowedSet?.has(t)));
    const optInActive = extNames.size > 0;
    for (const extension of loader.getExtensions().extensions) {
      const canons = extensionCanonicalNames(extension.path);
      if (optInActive && !canons.some((c) => extNames.has(c))) continue;
      // First alias that carries a narrowing set — a user won't narrow one
      // extension under two different names, so first-match is correct.
      const narrowed = canons.map((c) => narrowing.get(c)).find(Boolean);
      for (const name of extension.tools.keys()) {
        if (narrowed && !narrowed.has(name)) continue;
        if (disallowedSet?.has(name)) continue;
        keep.add(name);
      }
    }
    for (const name of EXCLUDED_TOOL_NAMES) keep.delete(name);
    // Opt-in nested delegation tools share EXCLUDED_TOOL_NAMES' names but are
    // legitimately active for this agent — re-admit them so the renarrow keeps
    // them in the active set and beforeToolCall doesn't block them.
    for (const name of nestedToolNames) {
      if (!disallowedSet?.has(name)) keep.add(name);
    }
    return keep;
  };

  const renarrow = () => {
    const allowed = inScope();
    const next = session.getAllTools().map((t) => t.name).filter((n) => allowed.has(n));
    const current = session.getActiveToolNames();
    // setActiveToolsByName unconditionally rebuilds the system prompt, so skip
    // the no-op that steady-state turns would otherwise pay for every turn.
    if (next.length !== current.length || next.some((n, i) => n !== current[i])) {
      session.setActiveToolsByName(next);
    }
  };

  // Activate what registered during session_start (eager MCP servers); pi would
  // otherwise leave only its four default built-ins active at turn 1.
  renarrow();

  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") renarrow();
  });

  const priorBeforeToolCall = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (context, signal) => {
    const run = async () => {
      if (!inScope().has(context.toolCall.name)) {
        return {
          block: true,
          reason: `Tool "${context.toolCall.name}" is not available to this subagent.`,
        } as const;
      }
      // Scope first, then approval: a tool this agent may not use at all is
      // refused without troubling the user about it.
      const gated = await askGate?.(context.toolCall.name, (context.toolCall as { input?: unknown }).input);
      if (gated) return gated;
      return priorBeforeToolCall?.(context, signal);
    };
    // Default per-tool timeout prevents a hung beforeToolCall (slow extension,
    // stuck LLM arbitrator) from stalling the subagent forever. Approval
    // dialogs are wrapped too — a tool that cannot be approved in time is
    // blocked fail-closed rather than left hanging.
    if (defaultToolTimeoutMs > 0) {
      try {
        return await withTimeout(run(), defaultToolTimeoutMs, `beforeToolCall for "${context.toolCall.name}"`);
      } catch (err) {
        return { block: true, reason: (err as Error).message };
      }
    }
    return run();
  };
}

/**
 * Run an agent's `gate:` command and format its verdict for the result text.
 *
 * Failures here are contained: a gate that cannot be fingerprinted simply runs
 * uncached, and one that cannot run at all reports as failed rather than taking
 * the agent's whole result down with it.
 */
async function runConfiguredGate(command: string, cwd: string, pi: ExtensionAPI): Promise<string> {
  const exec: GateExec = (file, args, execOptions) =>
    pi.exec(file, args, execOptions as Parameters<ExtensionAPI["exec"]>[2]);
  try {
    const fingerprint = await workspaceFingerprint(cwd, exec);
    const verdict = await runGate({ command, cwd, exec, ...(fingerprint ? { fingerprint } : {}) });
    return formatGateVerdict(command, verdict);
  } catch (error: unknown) {
    return `\n\n---\nAcceptance gate \`${command}\`: could not run (${error instanceof Error ? error.message : String(error)})`;
  }
}

/** Default max turns. undefined = unlimited (no turn limit). */
let defaultMaxTurns: number | undefined;

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}

/** Get the default max turns value. undefined = unlimited. */
export function getDefaultMaxTurns(): number | undefined { return defaultMaxTurns; }
/** Set the default max turns value. undefined or 0 = unlimited, otherwise minimum 1. */
export function setDefaultMaxTurns(n: number | undefined): void { defaultMaxTurns = normalizeMaxTurns(n); }

/** Additional turns allowed after the soft limit steer message. */
/**
 * Fraction of a resource budget at which the wrap-up steer is sent.
 *
 * Not 1.0: an agent told to produce its final answer needs allowance left to
 * produce it, so the steer has to arrive while there is still budget to spend
 * on the response.
 */
const SOFT_BUDGET_FRACTION = 0.8;

/** Project defaults for the per-agent resource budgets. `0` = unlimited. */
let defaultMaxTokens = 0;
let defaultMaxToolCalls = 0;

/** Token budget for one agent run, from settings. `0` disables the cap. */
export function getDefaultMaxTokens(): number { return defaultMaxTokens; }
export function setDefaultMaxTokens(n: number): void { defaultMaxTokens = Math.max(0, Math.floor(n)); }

/** Tool-call budget for one agent run, from settings. `0` disables the cap. */
export function getDefaultMaxToolCalls(): number { return defaultMaxToolCalls; }
export function setDefaultMaxToolCalls(n: number): void { defaultMaxToolCalls = Math.max(0, Math.floor(n)); }

/** Default per-tool timeout; `0` disables (no timeout). Mirrors tintinweb — no per-tool timeout by default; hung tools are reclaimed via session abort/quiescence, not a hard tool cut. Set via settings defaultToolTimeoutMs when needed. */
const DEFAULT_TOOL_TIMEOUT_MS = 0;
const TOOL_TIMEOUT_CEILING_MS = 600_000;
let defaultToolTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS;
export function getDefaultToolTimeoutMs(): number { return defaultToolTimeoutMs; }
export function setDefaultToolTimeoutMs(n: number): void {
  defaultToolTimeoutMs = Math.max(0, Math.min(Math.floor(n), TOOL_TIMEOUT_CEILING_MS));
}
/** Race a promise against a timeout that rejects with `label timed out after ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return promise;
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    handle.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (handle) clearTimeout(handle);
  });
}

let graceTurns = 5;

/** Get the grace turns value. */
export function getGraceTurns(): number { return graceTurns; }
/** Set the grace turns value (minimum 1). */
export function setGraceTurns(n: number): void { graceTurns = Math.max(1, n); }

/**
 * Model every subagent falls back to when nothing else picked one.
 *
 * Held here rather than in settings.ts because this is the one module that
 * consumes it, and every spawn path already reaches model resolution through
 * `runAgent`.
 *
 * Stored verbatim, `"inherit"` included, rather than normalized to `undefined`:
 * the two are the same at spawn time but not on disk. A project that must
 * cancel a global `defaultModel` has to write `"inherit"` into its own settings
 * file, and a state that had already collapsed it to `undefined` would persist
 * as an absent key and let the global value win again on the next start.
 */
let defaultModel: string | undefined;

/** The configured fallback model reference — a `provider/model`, `"inherit"`, or unset. */
export function getDefaultModel(): string | undefined { return defaultModel; }
/** Set the fallback model reference. `undefined` and blank clear it; `"inherit"` is kept. */
export function setDefaultModel(ref: string | undefined): void {
  const trimmed = ref?.trim();
  defaultModel = trimmed ? trimmed : undefined;
}

/**
 * The configured default model, resolved against this machine's registry.
 *
 * Resolved with the same fuzzy `resolveModel` the tiers use, so a hand-written
 * `subagents.json` may name a model the way a person would. Unlike a tier it
 * never throws: it is the value nobody chose at the call site, so an
 * unavailable one yields to the parent rather than taking every spawn on this
 * machine down with it.
 *
 * Exported because the callers that compute a spawn's model for the scope check
 * and the UI label have to see the same answer this module will act on.
 */
export function resolveConfiguredDefaultModel(
  registry: ModelRegistry<Model<any>>,
): Model<any> | undefined {
  if (!defaultModel || defaultModel === "inherit") return undefined;
  const resolved = resolveModel(defaultModel, registry);
  return typeof resolved === "string" ? undefined : resolved;
}

/**
 * Try to find the right model for an agent type.
 * Priority: explicit option > config.model > configured default model > parent model.
 */
function resolveDefaultModel(
  parentModel: Model<any> | undefined,
  registry: ModelRegistry<Model<any>>,
  configModel?: string,
): Model<any> | undefined {
  if (configModel) {
    const slashIdx = configModel.indexOf("/");
    if (slashIdx !== -1) {
      const provider = configModel.slice(0, slashIdx);
      const modelId = configModel.slice(slashIdx + 1);

      // Build a set of available model keys for fast lookup
      const available = registry.getAvailable?.();
      const availableKeys = available
        ? new Set(available.map((m) => `${m.provider}/${m.id}`))
        : undefined;
      const isAvailable = (p: string, id: string) =>
        !availableKeys || availableKeys.has(`${p}/${id}`);

      const found = registry.find(provider, modelId);
      if (found && isAvailable(provider, modelId)) return found;
    }
  }

  return resolveConfiguredDefaultModel(registry) ?? parentModel;
}

/** Info about a tool event in the subagent. */
export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

export interface RunOptions {
  /** ExtensionAPI instance — used for pi.exec() instead of execSync. */
  pi: ExtensionAPI;
  /** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `Explore#a1b2c3d4`). */
  agentId?: string;
  model?: Model<any>;
  maxTurns?: number;
  signal?: AbortSignal;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Semantic workflow tier; resolved here rather than by workflow callers. */
  tier?: WorkflowTier;
  /**
   * User-named model tier for an ordinary spawn. Resolved here so the top-level
   * Agent tool, nested delegation, the scheduler and cross-extension RPC all get
   * the same precedence and the same fail-closed errors from one place.
   */
  agentTier?: string;
  /** Optional toolset hint forwarded by managed workflow callers. */
  toolset?: string;
  /** Additional tool names denied by the caller, merged with agent frontmatter. */
  excludeTools?: string[];
  /** Named sequential-thread hint; used for stable session naming. */
  thread?: string;
  /** Parent thinking level used only when a tier profile omits thinking. */
  parentThinking?: ThinkingLevel;
  /** Override working directory (e.g. for worktree isolation). */
  cwd?: string;
  /** Original repository top-level the worktree copy was created from, for prompt isolation guidance. */
  worktreeBase?: string;
  /**
   * Where .pi config is discovered (project extensions, skills, pi settings,
   * agent memory). Default: same as the working directory. The manager sets
   * this to the parent session's cwd when `SpawnOptions.cwd` points the
   * working directory elsewhere — the agent works *there* but carries the
   * parent project's config (the target's `.pi` extensions never execute).
   *
   * WARNING for future callers: if you pass `cwd` pointing at a directory the
   * user didn't open, you almost certainly must pass `configCwd` too —
   * omitting it makes the target's `.pi` extensions execute in this process.
   * (Worktree isolation is the one intentional exception: its copy IS the
   * parent's repo, so config resolving inside it is correct.)
   */
  configCwd?: string;
  /** Called on tool start/end with activity info. */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  /** Called after pi-subagents resolves a semantic workflow tier. */
  onTierResolved?: (snapshot: WorkflowTierResolutionSnapshot) => void;
  /** Called after pi-subagents resolves a user-named agent tier. */
  onAgentTierResolved?: (snapshot: AgentTierResolutionSnapshot) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /**
   * Called once per assistant message_end with that message's usage delta.
   * Lets callers maintain a lifetime accumulator that survives compaction
   * (which replaces session.state.messages and resets stats-derived sums).
   */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /**
   * Called when the session successfully compacts. `tokensBefore` is upstream's
   * pre-compaction context size estimate. Aborted compactions don't fire.
   */
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
  /**
   * Package-internal symbol-keyed policy override. It is deliberately not a
   * JSON/public spawn field; the generation wizard is the only issuer.
   */
  readonly [INTERNAL_AGENT_CONFIG_OVERRIDE]?: InternalAgentConfigOverride;
  /**
   * Reopen an existing conversation from this session file instead of starting
   * a new one. Package-internal: the only issuer is the `@handle` mention
   * dispatcher, replaying a path this extension itself wrote to the resumable
   * index. A caller-supplied value would let a spawn read any session on disk,
   * so no public spawn surface forwards it.
   */
  resumeSessionFile?: string;
  /**
   * Project default for persisting a top-level agent's conversation to disk,
   * from the `rememberAgents` setting. Frontmatter `persist_session:` still
   * wins; nested agents never persist. Without this, only agents that opted in
   * by frontmatter leave a transcript, and `@handle` has nothing to reopen.
   */
  rememberAgents?: boolean;
  /**
   * Whether this agent may ask its human a question with `contact_supervisor`.
   * Defaults to on wherever there is a UI to ask through; `false` withholds the
   * tool entirely rather than injecting one that always refuses.
   */
  supervisorQuestions?: boolean;
  /** Runtime bridge for opt-in child-safe nested delegation. */
  nestedRuntime?: {
    manager: NestedAgentManager;
    parentAgentId: string;
    depth: number;
    maxSubagentDepth?: number;
  };
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
  /** True if the agent was hard-aborted (max_turns + grace exceeded). */
  aborted: boolean;
  /** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
  steered: boolean;
  /**
   * A failure message for the run's FINAL assistant turn, when that turn failed:
   * a provider error (stopReason "error"), or a "length" stop that produced no
   * text (a silent max-token death). pi resolves an exhausted-retries failure
   * normally instead of rejecting, so without this the manager would report such
   * a run as completed — with an empty result, or worse, an earlier turn's text
   * presented as the answer (#144). Undefined for a clean stop, or a "length"
   * stop that produced text (a legitimate truncated answer).
   */
  failure?: string;
}

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
function collectResponseText(session: AgentSession) {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    // message_start also fires for user and toolResult messages — resetting on
    // those would wipe assistant text already collected. Reset only when a new
    // ASSISTANT message begins, so getText() is the last assistant message's text.
    if (event.type === "message_start" && event.message.role === "assistant") {
      text = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
    }
  });
  return { getText: () => text, unsubscribe };
}

/**
 * Get the last non-empty assistant text produced during THIS invocation.
 * `startIndex` is the message count captured before the prompt, so the walk-back
 * never crosses into a previous turn: on a resume whose new turn failed empty,
 * this returns "" instead of the prior turn's answer (#144). Defaults to 0 (a
 * fresh spawn, where the whole history belongs to this run).
 */
function getLastAssistantText(session: AgentSession, startIndex = 0): string {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Error message of THIS invocation's final assistant message, when that turn
 * failed. Two failure shapes, both keyed off how the final turn STOPPED:
 *   - stopReason "error": a provider failure pi resolved instead of rejecting
 *     (any text; partial output is surfaced separately).
 *   - stopReason "length" with NO text: a silent max-token death — the run hit
 *     the output-token ceiling before writing anything, which would otherwise
 *     land as a "completed" run with an empty result (the #144 symptom).
 * Everything else completes: a clean "stop"/"toolUse" final, and — crucially — a
 * "length" stop that DID produce text (a legitimate truncated-but-useful answer).
 * "aborted" is handled by the manager's abort flag / "stopped" guard, not here.
 * Bounded by `startIndex` (like the text fallback) so a resume that produced no
 * assistant message of its own never inherits a PRIOR turn's stop reason.
 */
function finalTurnError(session: AgentSession, startIndex = 0): string | undefined {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    if (msg.stopReason === "error") {
      return (msg as { errorMessage?: string }).errorMessage?.trim() || "provider error with no output";
    }
    if (msg.stopReason === "length" && !extractText(msg.content).trim()) {
      return "run hit the output token limit before producing any text";
    }
    return undefined;
  }
  return undefined;
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function abortSignalReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("operation aborted");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortSignalReason(signal);
}

function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const onAbort = () => session.abort();
  if (signal.aborted) {
    session.abort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  // An AbortSignal can be aborted between the check above and listener
  // installation. Check again so a setup-time abort cannot be lost before the
  // first prompt is sent.
  if (signal.aborted) {
    signal.removeEventListener("abort", onAbort);
    session.abort();
    return () => {};
  }
  return () => signal.removeEventListener("abort", onAbort);
}

function resolveConfiguredSessionDir(sessionDir: string | undefined, cwd: string): string | undefined {
  if (!sessionDir) return undefined;
  if (sessionDir === "~" || sessionDir.startsWith("~/")) return resolve(homedir(), sessionDir.slice(2));
  if (isAbsolute(sessionDir)) return sessionDir;
  return resolve(cwd, sessionDir);
}

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  // Do not create a loader/session, bind extensions, or install listeners for
  // an already-cancelled caller. This matters for tool-call signals: the
  // caller may be cancelled before this async function gets its first turn.
  throwIfAborted(options.signal);

  const loadedConfig = getConfig(type);
  const internalOverride = options[INTERNAL_AGENT_CONFIG_OVERRIDE];
  const loadedAgentConfig = getAgentConfig(type);
  const config = internalOverride
    ? {
        ...loadedConfig,
        builtinToolNames: [...internalOverride.builtinToolNames],
        extensions: internalOverride.extensions,
        skills: internalOverride.skills,
      }
    : loadedConfig;
  const agentConfig = internalOverride
    ? {
        ...(loadedAgentConfig ?? {
          name: type,
          description: loadedConfig.description,
          extensions: loadedConfig.extensions,
          skills: loadedConfig.skills,
          systemPrompt: "",
          promptMode: loadedConfig.promptMode,
        }),
        builtinToolNames: [...internalOverride.builtinToolNames],
        extensions: internalOverride.extensions,
        skills: internalOverride.skills,
        allowedSubagents: internalOverride.allowedSubagents,
        memory: internalOverride.memory,
        persistSession: internalOverride.persistSession,
        outputTranscript: internalOverride.outputTranscript,
        isolation: internalOverride.isolation,
        isolated: internalOverride.isolated,
        inheritContext: internalOverride.inheritContext,
      }
    : loadedAgentConfig;
  const parentThinking = options.parentThinking ?? (() => {
    const level = options.pi.getThinkingLevel?.();
    return level === "minimal" || level === "low" || level === "medium" || level === "high" || level === "xhigh" || level === "max"
      ? level
      : undefined;
  })();
  // Resolve the semantic tier before the first await. Managed callers persist the
  // immutable policy snapshot from onTierResolved before provider work begins.
  const tierResolution = options.tier
    ? resolveWorkflowTier({
        tier: options.tier,
        agentConfig,
        directModel: options.model,
        thinkingOverride: options.thinkingLevel,
        parentModel: ctx.model,
        parentThinking,
        modelRegistry: ctx.modelRegistry,
      })
    : undefined;
  if (tierResolution?.snapshot) options.onTierResolved?.(tierResolution.snapshot);

  // Agent tiers resolve in the same place and before the same await, so every
  // spawn path shares one precedence and one set of fail-closed errors. A tier
  // that applies decides model and thinking outright: it is current policy,
  // while an agent's legacy `model:`/`thinking:` frontmatter is the older, weaker
  // statement of the same thing. Throwing here refuses the spawn rather than
  // quietly running a model the caller did not choose.
  const agentTierResolution = resolveAgentTier({
    requestedTier: options.agentTier,
    agentConfig,
    parentModel: ctx.model,
    parentThinking,
    modelRegistry: ctx.modelRegistry,
  });
  if (agentTierResolution.snapshot) options.onAgentTierResolved?.(agentTierResolution.snapshot);

  // Resolve working directory: worktree override > parent cwd
  const effectiveCwd = options.cwd ?? ctx.cwd;
  // Filesystem work happens in effectiveCwd; config discovery in configCwd.
  // They differ only for SpawnOptions.cwd spawns (config stays with the parent).
  const configCwd = options.configCwd ?? effectiveCwd;

  const env = await detectEnv(options.pi, effectiveCwd);
  throwIfAborted(options.signal);

  // Get parent system prompt for append-mode agents
  const parentSystemPrompt = ctx.getSystemPrompt();

  // Build prompt extras (memory, skill preloading)
  const extras: PromptExtras = {};
  if (options.worktreeBase) extras.worktreeBase = options.worktreeBase;

  // Resolve extensions/skills: isolated or the package-internal generation
  // override forces both off. The latter also prevents a custom general-purpose
  // definition from widening this one trusted no-tool run.
  const isolated = options.isolated || internalOverride?.isolated === true;
  const extensions = isolated ? false : config.extensions;
  // Nulling excludes under isolated also suppresses the orphaned-exclude warning —
  // isolation is an intentional override, not a misconfiguration.
  const excludeExtensions = isolated ? undefined : config.excludeExtensions;
  const skills = isolated ? false : config.skills;

  // Skill preloading: when skills is string[], preload their content into prompt
  if (Array.isArray(skills)) {
    const loaded = preloadSkills(skills, configCwd);
    if (loaded.length > 0) {
      extras.skillBlocks = loaded;
    }
  }

  let toolNames = internalOverride
    ? [...internalOverride.builtinToolNames]
    : getToolNamesForType(type);

  // Persistent memory: detect write capability and branch accordingly. The
  // package-internal generation policy skips this entire branch to preserve its
  // zero-tool invariant even if a custom definition requests memory.
  // Account for disallowedTools — a tool in the base set but on the denylist is not truly available.
  if (!internalOverride && agentConfig?.memory) {
    const existingNames = new Set(toolNames);
    const denied = agentConfig.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined;
    const effectivelyHas = (name: string) => existingNames.has(name) && !denied?.has(name);
    const hasWriteTools = effectivelyHas("write") || effectivelyHas("edit");

    if (hasWriteTools) {
      // Read-write memory: add any missing memory tool names (read/write/edit)
      const extraNames = getMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = buildMemoryBlock(agentConfig.name, agentConfig.memory, configCwd);
    } else {
      // Read-only memory: only add read tool name, use read-only prompt
      const extraNames = getReadOnlyMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = buildReadOnlyMemoryBlock(agentConfig.name, agentConfig.memory, configCwd);
    }
  }

  // Build system prompt from agent config
  let systemPrompt: string;
  if (agentConfig) {
    systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, parentSystemPrompt, extras);
  } else {
    // Unknown type fallback: spread the canonical general-purpose config (defensive —
    // unreachable in practice since index.ts resolves unknown types before calling runAgent).
    const fallback = DEFAULT_AGENTS.get("general-purpose");
    if (!fallback) throw new Error(`No fallback config available for unknown type "${type}"`);
    systemPrompt = buildAgentPrompt({ ...fallback, name: type }, effectiveCwd, env, parentSystemPrompt, extras);
  }

  // When skills is string[], we've already preloaded them into the prompt.
  // Still pass noSkills: true since we don't need the skill loader to load them again.
  const noSkills = skills === false || Array.isArray(skills);

  const agentDir = getAgentDir();

  // Extension loading:
  // - true  → all default-discovered extensions
  // - false → none (noExtensions)
  // - string[] → loader-level allowlist. Bare names keep the matching
  //   default-discovered extension; path entries load that extension fresh;
  //   "*" keeps all default-discovered extensions. Excluded extensions never
  //   bind handlers or register tools (their factory still runs once).
  //
  // Suppress AGENTS.md/CLAUDE.md and APPEND_SYSTEM.md — upstream's
  // buildSystemPrompt() re-appends both AFTER systemPromptOverride, which
  // would defeat prompt_mode: replace and isolated: true. Parent context, if
  // wanted, reaches the subagent via prompt_mode: append (parentSystemPrompt
  // is embedded in systemPromptOverride) or inherit_context (conversation).
  // `ext:` selectors from the `tools:` CSV narrow which extension tools surface to
  // the LLM. They do NOT control loading — `extensions:` is the sole authority for
  // which extensions load. `ext:foo` against an extension that `extensions:` excluded
  // is an orphan and warns after reload. `isolated` means no extension tools at all.
  const { extNames, narrowing } = parseExtSelectors(
    isolated ? [] : (agentConfig?.extSelectors ?? []),
  );
  const noExtensions = extensions === false;

  const extensionsSpec = Array.isArray(extensions)
    ? parseExtensionsSpec(extensions, configCwd)
    : undefined;
  const keepNames = extensionsSpec?.names ?? new Set<string>();
  // `exclude_extensions:` is a denylist applied AFTER the include set — exclude wins.
  // Plain canonical names only (case-insensitive). Note: excluded extensions'
  // factories still run once during reload() (see comment above) — exclusion
  // suppresses handler binding and tool registration; it is not a sandbox.
  const excludeNames = new Set((excludeExtensions ?? []).map((n) => n.toLowerCase()));
  const hasExcludes = excludeNames.size > 0;
  // The override filters loaded extensions down to `keepNames` minus `excludeNames`.
  // It's only needed when we're neither loading everything without excludes
  // (`extensions: true` or a `"*"` wildcard) nor nothing (`noExtensions`).
  const loadAll = extensions === true || extensionsSpec?.wildcard === true;
  const additionalExtensionPaths = extensionsSpec?.paths.length ? extensionsSpec.paths : undefined;
  // Pre-filter discovered set, captured by the override — the exclude-typo warning
  // must compare against this, not the surviving set (absence from survivors is
  // an exclude *succeeding*).
  let discoveredNames: Set<string> | undefined;
  const extensionsOverride: ((base: LoadExtensionsResult) => LoadExtensionsResult) | undefined =
    noExtensions || (loadAll && !hasExcludes)
      ? undefined
      : (base) => {
          discoveredNames = new Set(base.extensions.flatMap((e) => extensionCanonicalNames(e.path)));
          return {
            ...base,
            extensions: base.extensions.filter((e) => {
              const canons = extensionCanonicalNames(e.path);
              if (canons.some((n) => excludeNames.has(n))) return false; // exclude wins
              return loadAll || canons.some((n) => keepNames.has(n));
            }),
          };
        };

  const loader = new DefaultResourceLoader({
    cwd: configCwd,
    agentDir,
    noExtensions,
    additionalExtensionPaths,
    extensionsOverride,
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await runInChildSessionContext(() => loader.reload());
  throwIfAborted(options.signal);

  // Plain entries in `tools:` are expected to be built-in names (extension tools
  // go through `ext:`), so an unknown name there is unambiguously a typo. Previously
  // this produced a silently broken agent (#75) — pi-mono accepted the bogus name
  // into the allowlist, then dropped it at registration with no signal back.
  if (agentConfig?.builtinToolNames?.length) {
    const knownBuiltins = new Set(BUILTIN_TOOL_NAMES);
    for (const name of agentConfig.builtinToolNames) {
      if (!knownBuiltins.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `tools-error:tool "${name}" requested by agent "${type}" is not a known built-in`,
        });
      }
    }
  }

  // A subagent spawns mid-task, so a bad `extensions:`/`ext:` entry warns rather
  // than aborts. Two distinct misconfigurations to catch:
  //   - `extensions: [foo]` but no extension named foo was discovered (typo or
  //     path that failed to load — path entries fold their canonical name into
  //     `keepNames`, so this covers them too).
  //   - `tools: ext:foo` but foo isn't in the loaded set (because `extensions:`
  //     didn't include it). Since v0.9, `ext:` no longer pulls extensions in;
  //     loading is `extensions:`-authoritative.
  // An exclude_extensions: alongside extensions: false is contradictory — nothing
  // loads, so there is nothing to exclude.
  if (hasExcludes && noExtensions) {
    options.onToolActivity?.({
      type: "end",
      toolName: `extension-error:exclude_extensions has no effect for agent "${type}" — extensions: false loads nothing`,
    });
  }
  // Exclude typo check: compares against the PRE-filter discovered set (an excluded
  // name absent from the surviving set is the exclude working as intended). Also
  // flags path-like and "*" entries — excludes are plain names only.
  if (hasExcludes && discoveredNames) {
    for (const name of excludeNames) {
      if (!discoveredNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `extension-error:exclude_extensions: "${name}" for agent "${type}" did not match any discovered extension`,
        });
      }
    }
  }
  if (keepNames.size > 0 || extNames.size > 0) {
    const survivingNames = new Set(
      loader.getExtensions().extensions.flatMap((e) => extensionCanonicalNames(e.path)),
    );
    for (const name of keepNames) {
      if (!survivingNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: excludeNames.has(name)
            ? `extension-error:extension "${name}" is in both extensions: and exclude_extensions: for agent "${type}" — exclude wins`
            : `extension-error:extension "${name}" requested by agent "${type}" was not loaded`,
        });
      }
    }
    for (const name of extNames) {
      if (!survivingNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `extension-error:ext:${name} referenced by agent "${type}" but extension "${name}" is not loaded (check extensions:/exclude_extensions:)`,
        });
      }
    }
  }

  // `options.model` stays highest: it is a resolved Model handed over by a
  // programmatic caller, which is a more explicit act than naming a tier.
  const model = options.model ?? agentTierResolution.model ?? tierResolution?.model ?? resolveDefaultModel(
    ctx.model, ctx.modelRegistry, agentConfig?.model,
  );
  const thinkingLevel = agentTierResolution.snapshot
    ? agentTierResolution.thinkingLevel
    : options.tier !== undefined
      ? tierResolution?.thinkingLevel
      : options.thinkingLevel ?? agentConfig?.thinking;

  if (agentTierResolution.snapshot) {
    const { configuredModel, source } = agentTierResolution.snapshot;
    const scopeVerdict = checkModelScope({
      model,
      cwd: ctx.cwd,
      modelRegistry: ctx.modelRegistry,
      // A tier the caller named is a runtime choice by the model, which is what
      // scopeModels exists to police; a tier that came from the agent file or
      // the configured default is the user's own config and only warns.
      callerSupplied: source === "call",
      agentLabel: agentConfig?.displayName ?? type,
      modelInput: configuredModel === "inherit" ? undefined : configuredModel,
    });
    if (scopeVerdict.kind === "error") throw new Error(scopeVerdict.message);
    if (scopeVerdict.kind === "warn" && ctx.hasUI) ctx.ui.notify(scopeVerdict.message, "warning");
  }

  if (options.tier) {
    const configuredModel = tierResolution?.snapshot?.configuredModel;
    const scopeVerdict = checkModelScope({
      model,
      cwd: ctx.cwd,
      modelRegistry: ctx.modelRegistry,
      callerSupplied: false,
      agentLabel: agentConfig?.displayName ?? type,
      modelInput: configuredModel === "inherit" ? undefined : configuredModel,
    });
    if (scopeVerdict.kind === "error") throw new Error(scopeVerdict.message);
    if (scopeVerdict.kind === "warn" && ctx.hasUI) ctx.ui.notify(scopeVerdict.message, "warning");
  }
  const disallowedSet = (() => {
    const names = [...(agentConfig?.disallowedTools ?? []), ...(options.excludeTools ?? [])];
    return names.length > 0 ? new Set(names) : undefined;
  })();

  // Nested delegation tools (opt-in, ownership-scoped). Empty unless the agent
  // set `allowed_subagents` and a nestedRuntime was provided — and never when
  // isolated. Their names collide with EXCLUDED_TOOL_NAMES by design, so the
  // scoping below re-admits them explicitly (registry deny + active-set narrow).
  const effectiveMaxDepth = options.nestedRuntime?.maxSubagentDepth ?? getMaxSubagentDepth();
  // At (or past) the cap this agent can never spawn, so it can never own a child
  // to fetch from or steer either — inject nothing rather than three tools whose
  // every call is an error. This is also what makes `maxSubagentDepth` 0/1 mean
  // "nesting off" instead of "nesting always fails".
  const nestedRuntime = options.nestedRuntime && options.nestedRuntime.depth < effectiveMaxDepth
    ? options.nestedRuntime
    : undefined;
  const nestedTools = agentConfig?.allowedSubagents && nestedRuntime && !isolated
    ? createNestedSubagentTools({
        manager: nestedRuntime.manager,
        pi: options.pi,
        parentAgentId: nestedRuntime.parentAgentId,
        depth: nestedRuntime.depth,
        maxSubagentDepth: effectiveMaxDepth,
        allowedSubagents: agentConfig.allowedSubagents,
        configCwd,
      })
    : [];
  // `contact_supervisor` is injected separately from the nested tools and under
  // a different condition. Nesting is gated on `allowedSubagents`, but the agent
  // that most needs to ask a question is a LEAF one that cannot delegate — so
  // gating them together would withhold it from exactly those agents. It needs
  // only a human to answer, which `hasUI` decides. Isolation still suppresses
  // it: an `isolated: true` agent is defined as built-in tools only.
  const supervisorTools =
    ctx.hasUI && !isolated && options.supervisorQuestions !== false
      ? createSupervisorTool({
          agentLabel: agentConfig?.displayName ?? type,
          ask: {
            input: (title, placeholder) => ctx.ui.input(title, placeholder),
            select: (title, choices) => ctx.ui.select(title, choices),
          },
        })
      : [];
  // One list from here on: both sets are custom tools this package injects, and
  // the scoping pass below keeps exactly the names it is given.
  const injectedTools = [...nestedTools, ...supervisorTools];
  const nestedToolNames = new Set(injectedTools.map(tool => tool.name));

  // ─── Tool scoping ───────────────────────────────────────────────────────
  //
  // Some extensions register their tools ASYNCHRONOUSLY, long after the
  // `loader.reload()` above: pi-mcp calls registerTool from `session_start`
  // (once its MCP servers connect), context-mode from `before_agent_start`.
  // That is deliberate on their part — eagerly spawning an MCP bridge during
  // extension discovery orphans child processes on pi's non-agent code paths
  // (--help, config, trust probing).
  //
  // So the tool set cannot be snapshotted here. pi's `allowedToolNames` gates
  // tool *registration* (`_refreshToolRegistry`'s `isAllowedTool`), not merely
  // the active set, and is frozen at construction — a name absent from the
  // snapshot is dropped forever, even once the tool actually registers (#125).
  //
  // Whenever extensions are in play we therefore:
  //   - leave `allowedToolNames` unset, so pi's live gate admits tools whenever
  //     they register;
  //   - express the name-stable, permanent part of the scope (our own
  //     orchestration tools, built-ins the agent didn't ask for, and
  //     `disallowedTools`) as `excludeTools`, which pi re-applies on every
  //     registry refresh;
  //   - enforce `ext:` narrowing on the ACTIVE set via the live `inScope()`
  //     predicate installed after bind — the active set is what the LLM sees,
  //     so a registry tool that is never activated is invisible and uncallable.
  //
  // `noExtensions`/`isolated` keeps the historical static allowlist: nothing
  // async can appear there, and a hard registry gate is the correct boundary.
  const builtinToolNameSet = new Set(toolNames);

  let sessionTools: string[] | undefined;
  let sessionExcludeTools: string[] | undefined;
  if (noExtensions) {
    // Strict allowlist: built-ins the agent asked for, plus any opt-in nested
    // tools (whose names would otherwise be dropped as EXCLUDED_TOOL_NAMES).
    sessionTools = [
      ...toolNames.filter(
        (t) => !EXCLUDED_TOOL_NAMES.includes(t) && !disallowedSet?.has(t),
      ),
      ...[...nestedToolNames].filter((t) => !disallowedSet?.has(t)),
    ];
  } else {
    // Deny the orchestration tools EXCEPT the nested ones this agent opted into —
    // those are injected as customTools and must survive the registry gate.
    const denyTools = new Set<string>(
      EXCLUDED_TOOL_NAMES.filter((t) => !nestedToolNames.has(t)),
    );
    // Keep only the built-ins the agent asked for — deny the rest.
    for (const name of BUILTIN_TOOL_NAMES) {
      if (!builtinToolNameSet.has(name)) denyTools.add(name);
    }
    if (disallowedSet) {
      // disallowed_tools wins even over an opt-in nested tool of the same name.
      for (const name of disallowedSet) denyTools.add(name);
    }
    sessionExcludeTools = [...denyTools];
    // Named toolsets are advisory labels; they never widen the configured
    // allowlist. Concrete tool availability remains owned by the agent config.
  }

  const settingsManager = SettingsManager.create(configCwd, agentDir);
  const configuredSessionDir = resolveConfiguredSessionDir(agentConfig?.sessionDir, effectiveCwd);
  const defaultSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR ?? settingsManager.getSessionDir?.();
  // Frontmatter wins when it says anything; otherwise the project default,
  // which `rememberAgents` supplies for top-level agents only. A nested agent
  // is an implementation detail of its parent and is never addressable by
  // `@handle`, so it has nothing to gain from a transcript on disk.
  const persistSession = agentConfig?.persistSession ?? (options.nestedRuntime ? false : options.rememberAgents === true);
  // Optional metadata — it only nests the subagent under its spawner in
  // `/resume`. Now that `rememberAgents` persists every top-level spawn, a
  // context without a session manager (a bare programmatic ctx) must still
  // persist rather than take the whole spawn down.
  const parentSession = persistSession ? ctx.sessionManager?.getSessionFile?.() : undefined;
  const sessionManager = options.resumeSessionFile
    ? // Reopening an existing conversation: the file already carries its own
      // header (cwd, parent) and history, so none of the create-time options
      // apply. `sessionDir` still matters for a later /new or /branch off it.
      SessionManager.open(options.resumeSessionFile, configuredSessionDir ?? defaultSessionDir)
    : persistSession
      ? parentSession
        ? SessionManager.create(effectiveCwd, configuredSessionDir ?? defaultSessionDir, { parentSession })
        : SessionManager.create(effectiveCwd, configuredSessionDir ?? defaultSessionDir)
      : SessionManager.inMemory(effectiveCwd);

  // Pi 0.80.8 replaced createAgentSession's modelRegistry option with
  // modelRuntime, but ExtensionContext still exposes only the registry facade.
  // Pass both so the full supported Pi range retains the parent's providers.
  const parentModelRuntime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
  const sessionOpts: Parameters<typeof createAgentSession>[0] & {
    modelRegistry: ExtensionContext["modelRegistry"];
    modelRuntime?: ModelRuntime;
  } = {
    cwd: effectiveCwd,
    agentDir,
    sessionManager,
    settingsManager,
    modelRegistry: ctx.modelRegistry,
    ...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime }),
    model,
    tools: sessionTools,
    customTools: injectedTools,
    resourceLoader: loader,
  };
  if (sessionExcludeTools) {
    sessionOpts.excludeTools = sessionExcludeTools;
  }
  if (thinkingLevel) {
    sessionOpts.thinkingLevel = thinkingLevel;
  }

  const { session } = await runInChildSessionContext(() => createAgentSession(sessionOpts));
  // Install the forwarding listener immediately after session creation, before
  // bindExtensions/session_start can do asynchronous work. The old placement
  // just before prompt missed an abort during extension activation.
  const cleanupAbort = forwardAbortSignal(session, options.signal);
  let handedOff = false;
  let completed = false;
  try {
    throwIfAborted(options.signal);

  const baseSessionName = options.thread ? `workflow-thread:${options.thread}` : (agentConfig?.name ?? type);
  session.setSessionName(
    options.agentId && !options.thread ? `${baseSessionName}#${options.agentId.slice(0, 8)}` : baseSessionName,
  );

  // Bind extensions so that session_start fires and extensions can initialize
  // (e.g. loading credentials, setting up state). Tool gating already happened
  // at session construction via the `tools:` allowlist above — no separate
  // post-bind filter is needed. All ExtensionBindings fields are optional.
  await session.bindExtensions({
    onError: (err) => {
      options.onToolActivity?.({
        type: "end",
        toolName: `extension-error:${err.extensionPath}`,
      });
    },
  });
  throwIfAborted(options.signal);

  // With `allowedToolNames` unset, the registry is scoped by `excludeTools` but
  // the ACTIVE set still needs managing: pi activates only its four default
  // built-ins at turn 1, and `ext:` narrowing has no registry-level expression
  // (we can't deny the name of a tool that hasn't registered yet). Both are
  // handled below by re-deriving scope from the loader's live extension maps —
  // `registerTool` writes into those same maps, so late arrivals are judged too.
  // `ask_tools:` gates individual CALLS, which is orthogonal to which tools
  // exist — so it applies to isolated agents too, where the scope installer
  // below never runs because the registry is already statically allowlisted.
  const askGate = createAskGate({
    askTools: agentConfig?.askTools ?? [],
    agentLabel: agentConfig?.displayName ?? type,
    ...(ctx.hasUI ? { confirm: (title: string, message: string) => ctx.ui.confirm(title, message) } : {}),
  });

  if (!noExtensions) {
    installExtensionToolScope(session, {
      loader,
      toolNames,
      disallowedSet,
      extNames,
      narrowing,
      nestedToolNames,
      ...(askGate ? { askGate } : {}),
    });
  } else if (askGate) {
    // Same hook, without the scope check the allowlist already performed.
    const priorBeforeToolCall = session.agent.beforeToolCall;
    session.agent.beforeToolCall = async (context, signal) => {
      const run = async () => {
        const gated = await askGate(context.toolCall.name, (context.toolCall as { input?: unknown }).input);
        if (gated) return gated;
        return priorBeforeToolCall?.(context, signal);
      };
      if (defaultToolTimeoutMs > 0) {
        try {
          return await withTimeout(run(), defaultToolTimeoutMs, `beforeToolCall for "${context.toolCall.name}"`);
        } catch (err) {
          return { block: true, reason: (err as Error).message };
        }
      }
      return run();
    };
  }

  if (options.onSessionCreated) {
    // Mark ownership before invoking the callback: manager wrappers assign the
    // session to their record at callback entry, so a callback exception must
    // still be cleaned up by that manager rather than this runner.
    handedOff = true;
    options.onSessionCreated(session);
  }

  // Track turns for graceful max_turns enforcement
  let turnCount = 0;
  const maxTurns = normalizeMaxTurns(options.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns);
  let softLimitReached = false;
  let aborted = false;

  // Resource budgets, in the same shape as max_turns: a wrap-up steer at the
  // soft threshold, an abort at the hard one. They bound what a single agent
  // can spend on its own, which turn count does not — one turn can burn an
  // arbitrary number of tokens or tool calls.
  //
  // `0` means unlimited here, matching this package's existing convention for
  // `maxTurns`. That is the opposite of `maxSubagentSpawnsPerBranch`, and
  // deliberately: these are opt-in resource caps that ship off, while the
  // branch spawn budget is a safety valve that ships on.
  const tokenBudget = normalizeMaxTurns(agentConfig?.maxTokens ?? defaultMaxTokens);
  const toolCallBudget = normalizeMaxTurns(agentConfig?.maxToolCalls ?? defaultMaxToolCalls);
  let budgetTokens = 0;
  let budgetToolCalls = 0;
  let tokenSoftReached = false;
  let toolSoftReached = false;

  /**
   * Apply one budget, returning the next soft-limit state.
   *
   * The soft threshold is `SOFT_BUDGET_FRACTION` of the budget so the agent has
   * room left to actually write its answer after being told to wrap up — a
   * steer sent at 100% would be asking for a final response with no allowance
   * to produce it.
   */
  const applyBudget = (used: number, budget: number | undefined, softReached: boolean, label: string): boolean => {
    if (budget == null) return softReached;
    // The hard limit is checked FIRST. One message can consume more than the
    // whole budget, and testing the soft threshold first would answer that with
    // a wrap-up steer and no abort — leaving an agent already over budget to
    // run on until its next event.
    if (used >= budget) {
      aborted = true;
      session.abort();
      return true;
    }
    if (!softReached && used >= budget * SOFT_BUDGET_FRACTION) {
      session.steer(
        `You are near your ${label} budget for this task. Wrap up immediately — provide your final answer now.`,
      );
      return true;
    }
    return softReached;
  };

  let currentMessageText = "";
  // Per-tool timeout: a hung bash/MCP call must not stall the subagent forever.
  // Each tool_execution_start arms a timer; the matching end clears it. On
  // timeout the session is aborted — which propagates via the tool's
  // AbortSignal into the hanging execute() and surfaces as an error result.
  // `contact_supervisor` is excluded: it intentionally waits for a human.
  const pendingToolTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  const clearToolTimeout = (toolCallId: string): void => {
    const handle = pendingToolTimeouts.get(toolCallId);
    if (handle) {
      clearTimeout(handle);
      pendingToolTimeouts.delete(toolCallId);
    }
  };
  const armToolTimeout = (toolCallId: string, toolName: string): void => {
    if (defaultToolTimeoutMs <= 0) return;
    if (toolName === "contact_supervisor") return;
    const handle = setTimeout(() => {
      pendingToolTimeouts.delete(toolCallId);
      try {
        session.abort();
      } catch {}
    }, defaultToolTimeoutMs);
    handle.unref?.();
    pendingToolTimeouts.set(toolCallId, handle);
  };
  const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      turnCount++;
      options.onTurnEnd?.(turnCount);
      if (maxTurns != null) {
        if (!softLimitReached && turnCount >= maxTurns) {
          softLimitReached = true;
          session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
        } else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
          aborted = true;
          session.abort();
        }
      }
    }
    if (event.type === "message_start") {
      currentMessageText = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      currentMessageText += event.assistantMessageEvent.delta;
      options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
    }
    if (event.type === "tool_execution_start") {
      options.onToolActivity?.({ type: "start", toolName: event.toolName });
      armToolTimeout((event as { toolCallId: string }).toolCallId, event.toolName);
    }
    if (event.type === "tool_execution_end") {
      clearToolTimeout((event as { toolCallId: string }).toolCallId);
      options.onToolActivity?.({ type: "end", toolName: event.toolName });
      budgetToolCalls++;
      toolSoftReached = applyBudget(budgetToolCalls, toolCallBudget, toolSoftReached, "tool call");
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const u = (event.message as any).usage;
      if (u) options.onAssistantUsage?.({
        input: u.input ?? 0,
        output: u.output ?? 0,
        cacheWrite: u.cacheWrite ?? 0,
      });
      if (u) {
        // Same total as `getLifetimeTotal`: input + output + cacheWrite, with
        // cacheRead deliberately excluded.
        budgetTokens += (u.input ?? 0) + (u.output ?? 0) + (u.cacheWrite ?? 0);
        tokenSoftReached = applyBudget(budgetTokens, tokenBudget, tokenSoftReached, "token");
      }
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
    }
  });

  const collector = collectResponseText(session);

  // Build the effective prompt: optionally prepend parent context
  let effectivePrompt = prompt;
  const inheritContext = internalOverride?.inheritContext ?? options.inheritContext;
  if (inheritContext) {
    const parentContext = buildParentContext(ctx);
    if (parentContext) {
      effectivePrompt = parentContext + prompt;
    }
  }

  // Boundary for the history fallback: only assistant text produced from here
  // on counts as this run's output (a fresh session, so usually 0).
  const startLen = session.messages.length;
  try {
    throwIfAborted(options.signal);
    await session.prompt(effectivePrompt);
  } finally {
    unsubTurns();
    collector.unsubscribe();
    for (const handle of pendingToolTimeouts.values()) clearTimeout(handle);
    pendingToolTimeouts.clear();
  }

  const baseText = collector.getText().trim() || getLastAssistantText(session, startLen);
  // The acceptance gate runs AFTER the agent is done and its verdict is
  // appended to the result, so the parent reads the check and the claim it is
  // checking side by side. It deliberately does not steer the agent to fix
  // what failed: the gate is evidence for the caller, not another turn.
  const responseText = agentConfig?.gate
    ? `${baseText}${await runConfiguredGate(agentConfig.gate, effectiveCwd, options.pi)}`
    : baseText;
  completed = true;
  return { responseText, session, aborted, steered: softLimitReached, failure: finalTurnError(session, startLen) };
  } finally {
    cleanupAbort();
    // The manager takes ownership only after onSessionCreated is invoked. If
    // setup or the first prompt fails before that hand-off, this runner owns
    // the session and must close it instead of leaving a live session behind.
    if (!handedOff && !completed) {
      try {
        if (!options.signal?.aborted) await session.abort();
      } finally {
        await shutdownAndDisposeSession(session);
      }
    }
  }
}

/**
 * Send a new prompt to an existing session (resume).
 */
export async function resumeAgent(
  session: AgentSession,
  prompt: string,
  options: {
    onToolActivity?: (activity: ToolActivity) => void;
    onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
    onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ text: string; failure?: string }> {
  // Boundary for the history fallback: the session already holds prior turns,
  // so only assistant text produced by THIS resume prompt counts as its output
  // — a failed resume must not surface the previous turn's answer (#144).
  throwIfAborted(options.signal);
  const startLen = session.messages.length;
  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  const unsubEvents = (options.onToolActivity || options.onAssistantUsage || options.onCompaction)
    ? session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "tool_execution_start") options.onToolActivity?.({ type: "start", toolName: event.toolName });
        if (event.type === "tool_execution_end") options.onToolActivity?.({ type: "end", toolName: event.toolName });
        if (event.type === "message_end" && event.message.role === "assistant") {
          const u = (event.message as any).usage;
          if (u) options.onAssistantUsage?.({
            input: u.input ?? 0,
            output: u.output ?? 0,
            cacheWrite: u.cacheWrite ?? 0,
          });
        }
        if (event.type === "compaction_end" && !event.aborted && event.result) {
          options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
        }
      })
    : () => {};
  // Per-tool timeout for resume as well — same stuck-command fix as runAgent.
  const resumePendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  const unsubResumeTimeout =
    defaultToolTimeoutMs > 0
      ? session.subscribe((event: AgentSessionEvent) => {
          if (event.type === "tool_execution_start") {
            const id = (event as { toolCallId: string }).toolCallId;
            if (event.toolName === "contact_supervisor") return;
            const handle = setTimeout(() => {
              resumePendingTimeouts.delete(id);
              try {
                session.abort();
              } catch {}
            }, defaultToolTimeoutMs);
            handle.unref?.();
            resumePendingTimeouts.set(id, handle);
          } else if (event.type === "tool_execution_end") {
            const id = (event as { toolCallId: string }).toolCallId;
            const handle = resumePendingTimeouts.get(id);
            if (handle) {
              clearTimeout(handle);
              resumePendingTimeouts.delete(id);
            }
          }
        })
      : () => {};

  try {
    throwIfAborted(options.signal);
    await session.prompt(prompt);
  } finally {
    collector.unsubscribe();
    unsubEvents();
    unsubResumeTimeout();
    for (const handle of resumePendingTimeouts.values()) clearTimeout(handle);
    resumePendingTimeouts.clear();
    cleanupAbort();
  }

  return {
    text: collector.getText().trim() || getLastAssistantText(session, startLen),
    failure: finalTurnError(session, startLen),
  };
}

/**
 * Send a steering message to a running subagent.
 * The message will interrupt the agent after its current tool execution.
 */
export async function steerAgent(
  session: AgentSession,
  message: string,
): Promise<void> {
  await session.steer(message);
}

/**
 * Get the subagent's conversation messages as formatted text.
 */
export function getAgentConversation(session: AgentSession): string {
  const parts: string[] = [];

  for (const msg of session.messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : extractText(msg.content);
      if (text.trim()) parts.push(`[User]: ${text.trim()}`);
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text) textParts.push(c.text);
        else if (c.type === "toolCall") toolCalls.push(`  Tool: ${(c as any).name ?? (c as any).toolName ?? "unknown"}`);
      }
      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
      if (toolCalls.length > 0) parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`);
    } else if (msg.role === "toolResult") {
      const text = extractText(msg.content);
      const truncated = text.length > 200 ? text.slice(0, 200) + "..." : text;
      parts.push(`[Tool Result (${msg.toolName})]: ${truncated}`);
    }
  }

  return parts.join("\n\n");
}
