/**
 * Reads `enabledModels` from pi's settings (global `<agentDir>/settings.json`
 * + project-local `<cwd>/.pi/settings.json`, project wins) and resolves
 * entries to concrete `provider/modelId` keys for scope validation.
 *
 * **Project overrides global**, mirroring pi's own `SettingsManager`
 * deep-merge behavior and matching the precedence we use for our own
 * `subagents.json` settings (see `src/settings.ts:loadSettings`). If
 * project file has `enabledModels` set, it wholly replaces global's
 * (array fields are replaced, not concatenated).
 *
 * Resolve exact `provider/modelId` entries, unambiguous bare IDs, and Pi's
 * glob patterns (`*sonnet*`, `anthropic/*`) with optional thinking suffixes.
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
 * Returns undefined when neither file has the field.
 */
export function readEnabledModels(cwd: string): string[] | undefined {
  const [project, global] = settingsPaths(cwd);
  return readField(project) ?? readField(global);
}

/**
 * Resolve enabledModels patterns → Set<"provider/modelId"> (lowercase keys).
 *
 * Matches exact references, unambiguous bare IDs, and case-insensitive glob
 * patterns against the full `provider/modelId` or bare ID. A recognized
 * `:thinking` suffix is ignored for this model-only policy.
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

function resolvePattern(pattern: string, available: ModelEntry[], allowed: Set<string>): void {
  const colon = pattern.lastIndexOf(":");
  if (/[*?[]/.test(pattern)) {
    // Pi strips a recognized thinking level from globs before matching. Trying
    // the full glob first would select only colon-suffixed model IDs and miss
    // their base models (e.g. custom/*:high).
    const reference = colon >= 0 && THINKING_LEVELS.has(pattern.slice(colon + 1))
      ? pattern.slice(0, colon) : pattern;
    for (const model of available) {
      if (minimatch(modelKey(model), reference, { nocase: true }) || minimatch(model.id, reference, { nocase: true })) {
        allowed.add(modelKey(model));
      }
    }
    return;
  }

  // Pi tries the complete reference before treating a colon as a thinking
  // suffix: a model ID itself may contain ":high" or ":high-speed".
  if (matchReference(pattern, available, allowed)) return;
  // Invalid thinking suffixes on non-globs fall back to the prefix in scope
  // mode, just as Pi does (though it reports a warning to its own UI).
  if (colon >= 0) matchReference(pattern.slice(0, colon), available, allowed);
}

function matchReference(reference: string, available: ModelEntry[], allowed: Set<string>): boolean {
  const exact = available.find((model) => modelKey(model) === reference.toLowerCase());
  if (exact) {
    allowed.add(modelKey(exact));
    return true;
  }
  const bare = available.filter((model) => model.id.toLowerCase() === reference.toLowerCase());
  if (bare.length === 1) {
    allowed.add(modelKey(bare[0]));
    return true;
  }

  // Pi's non-glob partial picker searches model IDs and names, not canonical
  // provider/model keys. A provider-qualified partial is not an exact reference.
  const query = reference.toLowerCase();
  const matches = available.filter((model) =>
    model.id.toLowerCase().includes(query) || model.name?.toLowerCase().includes(query)
  );
  const aliases = matches.filter((model) => model.id.endsWith("-latest") || !/-\d{8}$/.test(model.id));
  const selected = (aliases.length > 0 ? aliases : matches).sort((a, b) => b.id.localeCompare(a.id))[0];
  if (selected) allowed.add(modelKey(selected));
  return selected !== undefined;
}

