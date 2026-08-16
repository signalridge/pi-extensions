/**
 * custom-agents.ts — Load user-defined agents from project (.pi/agents/, plus the shared .agents/agents/ workspace) and global ($PI_CODING_AGENT_DIR/agents/, default ~/.pi/agent/agents/) locations.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isValidAgentTierKey } from "./agent-tiers.js";
import { BUILTIN_TOOL_NAMES } from "./agent-types.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import type { AgentConfig, MemoryScope } from "./types.js";
import { sanitizeDisplayText } from "./ui/safe-text.js";

/**
 * Scan for custom agent .md files from multiple locations.
 * Discovery hierarchy (higher priority wins):
 *   1. Project:   <cwd>/.pi/agents/*.md (authoritative — also where /agents writes)
 *   2. Workspace: <cwd>/.agents/agents/*.md (shared cross-tool .agents workspace, read-only)
 *   3. Global:    $PI_CODING_AGENT_DIR/agents/*.md (default: ~/.pi/agent/agents/*.md)
 *
 * Project-level agents override global ones with the same name. On a name clash
 * between the two project locations, .pi/agents wins — .pi stays the project
 * authority; .agents/agents is an additional read location.
 * Any name is allowed — names matching defaults (e.g. "Explore") override them.
 */
type WarningSink = (message: string, key?: string) => void;
type SkippedAgent = { name: string; priority: number };

/** Normalize a discovery root so aliases and symlinked worktree paths share state. */
function normalizeDiscoveryRoot(cwd: string): string {
  const absolute = resolve(cwd);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** Normalize a path only when stat identity is unavailable. */
function normalizeWarningFallback(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Use filesystem identity for warning/cache keys while retaining display paths.
 *
 * Inode numbers are recycled, so a directory that is removed and recreated can land on the number its
 * predecessor held and inherit that predecessor's "already warned" state, swallowing the warning the
 * user needs. Birth time separates those incarnations while still letting two symlinked paths to one
 * live directory share a key, which is the reason identity is used here at all. Filesystems that do
 * not record a birth time report 0; there the path is the only honest key, at the cost of no longer
 * folding symlink aliases together.
 */
function warningIdentity(path: string): string {
  try {
    const stats = statSync(path);
    const birth = stats.birthtimeMs;
    if (Number.isFinite(birth) && birth > 0) return `inode:${stats.dev}:${stats.ino}:${birth}`;
    return `path:${normalizeWarningFallback(path)}`;
  } catch {
    return `path:${normalizeWarningFallback(path)}`;
  }
}

function warningReasonKey(reason: string): string {
  return reason.split(":", 1)[0] ?? reason;
}

const MAX_WARNING_ROOTS = 64;
const warningCache = new Map<string, Set<string>>();

/**
 * Start a warning scope and retain per-root state in a bounded 64-root LRU.
 * Unchanged warning keys are suppressed only while their root remains cached;
 * an evicted root may warn again on a later reload.
 */
function createWarningSink(root: string): WarningSink {
  const previous = warningCache.get(root) ?? new Set<string>();
  const current = new Set<string>();
  warningCache.delete(root);
  warningCache.set(root, current);
  while (warningCache.size > MAX_WARNING_ROOTS) {
    const oldest = warningCache.keys().next().value as string | undefined;
    if (!oldest || oldest === root) break;
    warningCache.delete(oldest);
  }
  return (message: string, key = message) => {
    // A discovery pass can enumerate the same inode twice when the global
    // PI_CODING_AGENT_DIR aliases <cwd>/.pi. Dedupe both this pass and the
    // previous unchanged pass while this root remains in the bounded cache; a
    // later fix-then-break pass still re-warns, and an evicted root may warn again.
    const warningKey = `key:${key}`;
    if (current.has(warningKey)) return;
    current.add(warningKey);
    if (previous.has(warningKey)) return;
    console.warn(`[pi-subagents] ${message}`);
  };
}

export function loadCustomAgents(cwd: string, strict = false): Map<string, AgentConfig> {
  const discoveryRoot = normalizeDiscoveryRoot(cwd);
  const warningRoot = warningIdentity(cwd);
  const globalDir = join(getAgentDir(), "agents");
  const workspaceProjectDir = join(discoveryRoot, ".agents", "agents");
  const projectDir = join(discoveryRoot, ".pi", "agents");
  const warn = createWarningSink(warningRoot);

  const agents = new Map<string, AgentConfig>();
  const priorities = new Map<string, number>();
  const skipped: SkippedAgent[] = [];
  loadFromDir(globalDir, agents, "global", strict, warn, 0, priorities, skipped);            // lowest priority
  loadFromDir(workspaceProjectDir, agents, "project", strict, warn, 1, priorities, skipped); // shared workspace
  loadFromDir(projectDir, agents, "project", strict, warn, 2, priorities, skipped);          // highest priority (overwrites)

  // Only report a fallback when the skipped file was higher priority than the
  // definition that survived the complete discovery pass. A valid higher
  // priority file later in the scan makes a malformed lower file irrelevant.
  for (const { name, priority } of skipped) {
    warnSkippedOverride(name, priority, agents, priorities, warn);
  }

  return agents;
}

/** Load agent configs from a directory into the map. */
function loadFromDir(
  dir: string,
  agents: Map<string, AgentConfig>,
  source: "project" | "global",
  strict: boolean,
  warn: WarningSink,
  priority: number,
  priorities: Map<string, number>,
  skipped: SkippedAgent[],
): void {
  if (!existsSync(dir)) return;

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".md"));
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    if (strict) throw new Error(`${dir}: ${reason}`);
    warn(
      `Skipping agent directory ${dir}: ${reason}`,
      `directory:${warningIdentity(dir)}:${warningReasonKey(reason)}`,
    );
    return;
  }

  for (const file of files) {
    const name = basename(file, ".md");
    const path = join(dir, file);
    const parsed = readAgentFile(path, strict, warn);
    if (!parsed) {
      skipped.push({ name, priority });
      continue;
    }
    const { frontmatter: fm, body } = parsed;

    const { builtinToolNames, extSelectors } = parseToolsField(fm.tools);
    warnLegacyModelFields(fm, path, warn);

    agents.set(name, {
      name,
      displayName: label(fm.display_name),
      description: label(fm.description) ?? sanitizeDisplayText(name),
      builtinToolNames,
      extSelectors,
      disallowedTools: csvListOptional(fm.disallowed_tools),
      extensions: inheritField(fm.extensions ?? fm.inherit_extensions),
      excludeExtensions: csvListOptional(fm.exclude_extensions),
      skills: inheritField(fm.skills ?? fm.inherit_skills),
      agentTier: parseTier(fm.tier, path, warn),
      maxTurns: nonNegativeInt(fm.max_turns),
      persistSession: fm.persist_session != null ? fm.persist_session === true : undefined,
      outputTranscript: fm.output_transcript != null ? fm.output_transcript !== false : undefined,
      sessionDir: str(fm.session_dir),
      allowedSubagents: parseAllowedSubagents(fm.allowed_subagents),
      systemPrompt: body.trim(),
      promptMode: fm.prompt_mode === "append" ? "append" : "replace",
      inheritContext: fm.inherit_context != null ? fm.inherit_context === true : undefined,
      runInBackground: fm.run_in_background != null ? fm.run_in_background === true : undefined,
      isolated: fm.isolated != null ? fm.isolated === true : undefined,
      memory: parseMemory(fm.memory),
      isolation: fm.isolation === "worktree" ? "worktree" : undefined,
      enabled: fm.enabled !== false,  // default true; explicitly false disables
      source,
      sourcePath: path,
    });
    priorities.set(name, priority);
  }
}
/**
 * Report a `model:`/`thinking:` pin left over from before tiers.
 *
 * An agent file no longer chooses its own model — the tier catalogue in
 * `subagents.json` does, and a per-file pin would be a way around it. The file
 * still loads: a stale pin is a migration the author has not done yet, not a
 * reason to take the agent away mid-session. It simply has no effect, and the
 * warning names the file so it can be fixed.
 */
function warnLegacyModelFields(fm: Record<string, unknown>, path: string, warn: WarningSink): void {
  const present = ["model", "thinking"].filter((field) => fm[field] != null);
  if (present.length === 0) return;
  warn(
    `Ignoring ${present.join(" and ")} in ${path}: agents pick a model with "tier:" now. ` +
      `Replace it with a tier from agentTiers.profiles, or remove it to use the default tier.`,
    `legacy-model:${warningIdentity(path)}`,
  );
}

/** Read and parse one agent file, warning or throwing with its path on failure. */
function readAgentFile(
  path: string,
  strict: boolean,
  warn: WarningSink,
): { frontmatter: Record<string, unknown>; body: string } | undefined {
  try {
    return parseFrontmatter<Record<string, unknown>>(readFileSync(path, "utf-8"));
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    if (strict) throw new Error(`${path}: ${reason}`);
    warn(
      `Skipping agent file ${path}: ${reason}`,
      `file:${warningIdentity(path)}:${warningReasonKey(reason)}`,
    );
    return undefined;
  }
}

/** Warn when a skipped file shadowed a lower-priority definition after discovery. */
function warnSkippedOverride(
  name: string,
  skippedPriority: number,
  agents: Map<string, AgentConfig>,
  priorities: Map<string, number>,
  warn: WarningSink,
): void {
  const survivingPriority = priorities.get(name);
  if (survivingPriority !== undefined && survivingPriority >= skippedPriority) return;

  const surviving = agents.get(name);
  if (!surviving) {
    if (DEFAULT_AGENTS.has(name)) {
      warn(
        `Agent "${name}" now uses embedded default "${name}" instead`,
        `override:${name}:${skippedPriority}:embedded`,
      );
    }
    return;
  }
  if (surviving.enabled === false) return;
  if (surviving.sourcePath) {
    warn(
      `Agent "${name}" now loads from ${surviving.sourcePath} instead`,
      `override:${name}:${skippedPriority}:${warningIdentity(surviving.sourcePath)}`,
    );
  }
}

// ---- Field parsers ----
// All follow the same convention: omitted → default, "none"/empty → nothing, value → exact.

/** Extract a string or undefined. */
function str(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

/**
 * Extract a string that will be rendered as a label.
 *
 * Frontmatter is untrusted: a cloned repository, or a subagent with write access
 * to the cwd, supplies `.pi/agents/*.md`, and `display_name`/`description` reach
 * every widget row, fleet row, menu label and viewer header. Neutralizing them
 * once here means no render site can forget — and nothing matches or dispatches
 * on either field, so the registry never needs the raw bytes.
 */
function label(val: unknown): string | undefined {
  const raw = str(val);
  return raw === undefined ? undefined : sanitizeDisplayText(raw);
}

/**
 * Parse the agent's default model tier.
 *
 * Only the shape is checked here; whether the key names a configured profile is
 * decided at spawn time, because the catalogue lives in `subagents.json` and may
 * legitimately change after this file was read. A malformed key is dropped with
 * a warning rather than failing the load: the rest of the agent is still usable,
 * and a spawn without a tier falls back to the configured default.
 */
function parseTier(val: unknown, path: string, warn: WarningSink): string | undefined {
  if (val === undefined || val === null) return undefined;
  // Deliberately not "no tier means no model": which model an agent runs is
  // decided by the tier catalogue, so an agent that names no tier falls to
  // `agentTiers.defaultTier` rather than pinning anything itself.
  if (isValidAgentTierKey(val)) return val;
  warn(
    `Ignoring invalid tier in ${path}: expected a non-empty single-word key`,
    `tier:${warningIdentity(path)}`,
  );
  return undefined;
}

/** Extract a non-negative integer or undefined. 0 means unlimited for max_turns. */
function nonNegativeInt(val: unknown): number | undefined {
  return typeof val === "number" && val >= 0 ? val : undefined;
}

/**
 * Parse a raw CSV field value into items, or undefined if absent/empty/"none".
 */
function parseCsvField(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  const s = String(val).trim();
  if (!s || s === "none") return undefined;
  const items = s.split(",").map(t => t.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * Parse the nested-delegation allowlist. Single field, default-off:
 * omitted/empty/"none"/`false` → undefined (no nested tools); "all"/"*"/`true`
 * → "all" (any enabled agent); csv → only the listed types.
 *
 * Booleans are accepted because `extensions:`/`skills:` take them and users
 * generalize: without this, YAML's `true` stringifies into an agent type
 * literally named "true", so the tools appear and every spawn is refused.
 */
function parseAllowedSubagents(val: unknown): "all" | string[] | undefined {
  if (typeof val === "boolean") return val ? "all" : undefined;
  const items = parseCsvField(val);
  if (!items) return undefined;
  return items.some(i => i === "*" || i.toLowerCase() === "all") ? "all" : items;
}

/**
 * Parse a comma-separated list field with defaults.
 * omitted → defaults; "none"/empty → []; csv → listed items.
 */
function csvList(val: unknown, defaults: string[]): string[] {
  if (val === undefined || val === null) return defaults;
  return parseCsvField(val) ?? [];
}

/**
 * Partition the `tools:` CSV into the built-in tool allowlist and raw `ext:` selectors.
 * `*` (and the case-insensitive alias `all`, for `tools: all`) expands to all
 * built-ins; plain entries are built-in names; `ext:` entries are extension-tool
 * selectors parsed later by the runner. omitted → all built-ins, no selectors.
 * `tools:` present with only `ext:` entries → zero built-ins (use `*`).
 */
function parseToolsField(val: unknown): { builtinToolNames: string[]; extSelectors: string[] | undefined } {
  const entries = csvList(val, BUILTIN_TOOL_NAMES);
  const isWildcard = (e: string) => e === "*" || e.toLowerCase() === "all";
  const hasWildcard = entries.some(isWildcard);
  const plain = entries.filter(e => !isWildcard(e) && !e.startsWith("ext:"));
  const extEntries = entries.filter(e => e.startsWith("ext:"));
  return {
    builtinToolNames: hasWildcard ? [...new Set([...BUILTIN_TOOL_NAMES, ...plain])] : plain,
    extSelectors: extEntries.length > 0 ? extEntries : undefined,
  };
}

/**
 * Parse an optional comma-separated list field.
 * omitted → undefined; "none"/empty → undefined; csv → listed items.
 */
function csvListOptional(val: unknown): string[] | undefined {
  return parseCsvField(val);
}

/**
 * Parse a memory scope field.
 * omitted → undefined; "user"/"project"/"local" → MemoryScope.
 */
function parseMemory(val: unknown): MemoryScope | undefined {
  if (val === "user" || val === "project" || val === "local") return val;
  return undefined;
}

/**
 * Parse an inherit field (extensions, skills).
 * omitted/true → true (inherit all); false/"none"/empty → false; csv → listed names.
 */
function inheritField(val: unknown): true | string[] | false {
  if (val === undefined || val === null || val === true) return true;
  if (val === false || val === "none") return false;
  const items = csvList(val, []);
  return items.length > 0 ? items : false;
}
