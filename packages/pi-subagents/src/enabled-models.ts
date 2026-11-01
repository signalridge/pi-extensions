/**
 * Reads `enabledModels` from pi's settings (global `<agentDir>/settings.json`
 * + project-local `<cwd>/.pi/settings.json`, project wins) and resolves
 * entries to concrete `provider/modelId` keys for scope validation.
 *
 * **Admitted project settings override global**, mirroring pi's own `SettingsManager`
 * deep-merge behavior and matching the precedence we use for our own
 * `subagents.json` settings (see `src/settings.ts:loadSettings`). If
 * project file has `enabledModels` set, it wholly replaces global's
 * (array fields are replaced, not concatenated).
 *
 * Resolve exact `provider/modelId` entries, bare IDs, partial references
 * (provider-qualified or not), and Pi's glob patterns (`*sonnet*`,
 * `anthropic/*`) with optional thinking suffixes, as Pi 1.4 scopes them.
 * The suffix selects a thinking level in Pi; this guard checks only model
 * membership. A configured pattern with no available match must not disable
 * the opt-in scope check.
 *
 * Example:
 *   enabledModels = ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6"]
 *   → resolves to { "anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6" }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";
import type { ModelEntry } from "./model-resolver.js";
import { isProjectResource, type ProjectTrust } from "./project-trust.js";

/** Minimal registry shape — only the methods resolveEnabledModels actually calls. */
export interface ModelRegistryRef {
  getAll(): unknown[];
  getAvailable?(): unknown[];
}

/** Paths to pi's settings.json files: [project, global] (project takes precedence). */
function settingsPaths(cwd: string): [project: string, global: string] {
  return [
    join(cwd, ".pi", "settings.json"),
    join(getAgentDir(), "settings.json"),
  ];
}

/** Read `enabledModels` from a single settings.json file. Undefined when missing or absent. */
function readField(path: string): string[] | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (Array.isArray(raw?.enabledModels)) {
      // Keep the configured list present even if every item is malformed: an
      // invalid project allowlist must not fall back to a broader global list
      // or silently disable the opt-in scope check.
      return raw.enabledModels.map((pattern: unknown) => typeof pattern === "string" ? pattern : "");
    }
  } catch {
    /* corrupt file — silent */
  }
  return undefined;
}

/**
 * Read enabledModels from pi's settings — project-local overrides global.
 * Mirrors pi's SettingsManager deep-merge for the `enabledModels` field
 * (and matches our own loadSettings precedence in src/settings.ts).
 * Runtime callers pass captured configuration authority to exclude denied
 * project sources and global aliases; standalone callers keep project defaults.
 * Returns undefined when neither admitted file has the field.
 */
export function readEnabledModels(cwd: string, authority?: ProjectTrust): string[] | undefined {
  const [project, global] = settingsPaths(authority?.cwd ?? cwd);
  // Standalone readers retain project precedence. Runtime readers must pass
  // captured configuration authority, never infer it from execution cwd.
  const denied = (path: string): boolean => authority?.deniedRoots.some(root => isProjectResource(path, root)) ?? false;
  return (authority?.trusted !== false && !denied(project) ? readField(project) : undefined)
    ?? (!denied(global) ? readField(global) : undefined);
}

/**
 * Resolve enabledModels patterns → Set<"provider/modelId"> (lowercase keys).
 *
 * Matches references and case-insensitive glob patterns against the full
 * `provider/modelId` or bare ID. A reference several providers offer admits
 * each of them, as Pi's scope does. A recognized `:thinking` suffix is
 * ignored for this model-only policy.
 *
 * Resolves against the current registry on every call. Availability can
 * change without a settings-file edit (or even a new registry instance).
 * The optional cwd is retained for callers that pass it alongside patterns
 * read from that project's settings.
 *
 * Returns undefined only when there is no configured allowlist. A configured
 * list with no available exact matches returns an empty set so caller-supplied
 * models cannot bypass the scope check.
 */
export function resolveEnabledModels(
  patterns: string[] | undefined,
  registry: ModelRegistryRef,
  _cwd: string = process.cwd(),
): Set<string> | undefined {
  if (!patterns || patterns.length === 0) return undefined;

  const available = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
  const allowed = new Set<string>();

  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (!trimmed) continue;  // skip empty/whitespace
    resolvePattern(trimmed, available, allowed);
  }

  return allowed;
}



/**
 * True when `model` is in the allowed set. Centralizes the key format
 * (`provider/id` lowercase) so callers don't have to reproduce it —
 * both set-building (resolveExact) and lookup go through `modelKey`.
 */
export function isModelInScope(
  model: { provider: string; id: string },
  allowed: Set<string>,
): boolean {
  return allowed.has(modelKey(model));
}

/** Canonical lowercase `provider/id` key for the allowed set. */
function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`.toLowerCase();
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

// Mirrors Pi 1.4's scope resolver (`--models`, `enabledModels`), in which every
// listed model is usable: a reference several providers offer admits each of them.
function resolvePattern(pattern: string, available: ModelEntry[], allowed: Set<string>): void {
  const add = (models: readonly ModelEntry[] | undefined) => {
    for (const model of models ?? []) allowed.add(modelKey(model));
  };
  if (/[*?[]/.test(pattern)) {
    // Pi strips a recognized thinking level from globs before matching. Trying
    // the full glob first would select only colon-suffixed model IDs and miss
    // their base models (e.g. custom/*:high).
    const colon = pattern.lastIndexOf(":");
    const reference = colon >= 0 && THINKING_LEVELS.has(pattern.slice(colon + 1))
      ? pattern.slice(0, colon) : pattern;
    // An exact reference wins: IDs such as `model[1m]` are not globs.
    add(selectReference(reference, available, false) ?? available.filter((model) =>
      minimatch(modelKey(model), reference, { nocase: true }) || minimatch(model.id, reference, { nocase: true })));
    return;
  }
  add(resolveReference(pattern, available));
}

// Pi tries the complete reference before treating a colon as a thinking
// suffix: a model ID itself may contain ":high" or ":high-speed". Invalid
// suffixes fall back to the prefix in scope mode, just as Pi does (though it
// reports a warning to its own UI).
function resolveReference(text: string, available: ModelEntry[]): readonly ModelEntry[] | undefined {
  const resolved = selectReference(text, available, true) ?? selectFuzzy(fuzzyMatches(text, available));
  if (resolved) return resolved;
  const colon = text.lastIndexOf(":");
  return colon >= 0 ? resolveReference(text.slice(0, colon), available) : undefined;
}

// `provider/rest` is only a hint: the whole text may also be a model ID on
// another provider (a gateway's `zai/glm-5`). The named provider's literal ID,
// then its partial match, wins over such raw IDs.
function selectReference(text: string, available: ModelEntry[], fuzzy: boolean): readonly ModelEntry[] | undefined {
  const lower = text.toLowerCase();
  const raw = available.filter((model) => model.id.toLowerCase() === lower);
  const split = splitProvider(text, available);
  let named: ModelEntry | undefined;
  if (split) {
    const providerModels = available.filter((model) => model.provider === split.provider);
    const modelText = split.modelText.toLowerCase();
    named = providerModels.find((model) => model.id.toLowerCase() === modelText) ??
      raw.find((model) => model.provider === split.provider) ??
      (fuzzy ? bestFuzzyMatch(fuzzyMatches(split.modelText, providerModels)) : undefined);
  }
  const others = raw.filter((model) => model !== named);
  const candidates = named ? [named, ...others] : others;
  if (candidates.length === 0) return undefined;
  if (named || new Set(candidates.map((model) => model.provider)).size === 1) return [candidates[0]];
  return candidates;
}

function splitProvider(text: string, available: ModelEntry[]): { provider: string; modelText: string } | undefined {
  const slash = text.indexOf("/");
  if (slash < 0) return undefined;
  const prefix = text.slice(0, slash).trim().toLowerCase();
  const modelText = text.slice(slash + 1).trim();
  if (!prefix || !modelText) return undefined;
  const provider = available.find((model) => model.provider.toLowerCase() === prefix)?.provider;
  return provider ? { provider, modelText } : undefined;
}

// Pi's partial picker searches model IDs and names, never canonical keys.
function fuzzyMatches(text: string, models: readonly ModelEntry[]): ModelEntry[] {
  const query = text.toLowerCase();
  return models.filter((model) => model.id.toLowerCase().includes(query) || model.name?.toLowerCase().includes(query));
}

// The same best ID on several providers is ambiguous: Pi admits each of them.
function selectFuzzy(matches: readonly ModelEntry[]): readonly ModelEntry[] | undefined {
  const best = bestFuzzyMatch(matches);
  if (!best) return undefined;
  const tied = matches.filter((model) => model.id === best.id);
  return new Set(tied.map((model) => model.provider)).size === 1 ? [best] : tied;
}

// Prefer aliases (`claude-sonnet-4-5`) over dated IDs (`...-20250929`), then the latest.
function bestFuzzyMatch(matches: readonly ModelEntry[]): ModelEntry | undefined {
  const aliases = matches.filter((model) => model.id.endsWith("-latest") || !/-\d{8}$/.test(model.id));
  return [...(aliases.length > 0 ? aliases : matches)].sort((a, b) => b.id.localeCompare(a.id))[0];
}
