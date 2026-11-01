import { type FrontmatterValue, parseRuleFile } from "./frontmatter.js";
import { compileGlob, type Glob, splitTopLevel } from "./glob.js";

/** Where a rule file was found, in precedence order (earlier wins a name collision). */
export const RULE_SOURCES = ["project-pi", "project-agents", "project-cursor", "user"] as const;
export type RuleSource = (typeof RULE_SOURCES)[number];

/** Tools whose arguments carry text a `condition` can be matched against. */
export const SCOPE_TOOLS = ["edit", "write", "bash", "powershell"] as const;
export type ScopeTool = (typeof SCOPE_TOOLS)[number];
const PATH_TOOLS: ReadonlySet<ScopeTool> = new Set(["edit", "write"]);

export type Enforcement = "block" | "remind";
export type RepeatPolicy = { mode: "once" } | { mode: "after-gap"; gap: number };

/**
 * How a rule reaches the model, decided in this order:
 * `block`/`remind` (has a `condition`), `always`, `glob`, `index` (has a
 * `description`), and `manual` (readable with `read_rule` only).
 */
export type RuleMode = Enforcement | "always" | "glob" | "index" | "manual";

export interface ToolScope {
  tool: ScopeTool;
  path?: Glob;
}

export interface Rule {
  name: string;
  path: string;
  source: RuleSource;
  body: string;
  mode: RuleMode;
  description?: string;
  globs: readonly Glob[];
  conditions: readonly RegExp[];
  scope: readonly ToolScope[];
  repeat: RepeatPolicy;
  warnings: readonly string[];
}

export type RuleFileResult =
  | { kind: "rule"; rule: Rule }
  | { kind: "disabled"; name: string }
  | { kind: "error"; name: string; error: string };

export const RULE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const DEFAULT_REPEAT_GAP = 10;
const MAX_DESCRIPTION = 1_000;
const MAX_CONDITIONS = 32;
const MAX_CONDITION_LENGTH = 1_000;
const KNOWN_FIELDS = new Set([
  "description",
  "alwaysApply",
  "globs",
  "condition",
  "scope",
  "interruptMode",
  "enforce",
  "repeatMode",
  "repeatGap",
  "enabled",
]);
const UNSUPPORTED_FIELDS: Record<string, string> = {
  astCondition: "AST conditions are not supported; use a regex `condition`",
  question: "model-judged rules are not supported; pi-rules makes no model requests",
  agents: "per-agent rule scoping is not supported",
  ttsr_trigger: "rename it to `condition`",
  ttsrTrigger: "rename it to `condition`",
};
const INTERRUPT_MODES: Record<string, Enforcement> = {
  never: "remind",
  "prose-only": "remind",
  "tool-only": "block",
  always: "block",
};

class RuleError extends Error {}

function describe(value: FrontmatterValue): string {
  return Array.isArray(value) ? "a list" : JSON.stringify(value);
}

function stringField(key: string, value: FrontmatterValue): string {
  if (typeof value !== "string") throw new RuleError(`"${key}" must be a string, not ${describe(value)}`);
  return value.trim();
}

function booleanField(key: string, value: FrontmatterValue): boolean {
  if (typeof value !== "boolean") throw new RuleError(`"${key}" must be true or false, not ${describe(value)}`);
  return value;
}

function listField(key: string, value: FrontmatterValue): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return [...value];
  throw new RuleError(`"${key}" must be a string or a list of strings, not ${describe(value)}`);
}

/** Compile a regex `condition`, translating a leading `(?i)`/`(?m)`/`(?s)` group into flags as oh-my-pi does. */
export function compileCondition(pattern: string): RegExp {
  const inline = /^\(\?([ims]+)\)/.exec(pattern);
  try {
    return inline ? new RegExp(pattern.slice(inline[0].length), [...new Set(inline[1])].join("")) : new RegExp(pattern);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const hint = /^[*?]|\*\*|^\*\.\w+$/.test(pattern)
      ? " It looks like a file glob: put paths in `globs` or `scope: tool:edit(<glob>)`."
      : "";
    throw new RuleError(`invalid condition ${JSON.stringify(pattern)}: ${reason}.${hint}`);
  }
}

function compileGlobs(key: string, patterns: readonly string[]): Glob[] {
  return patterns
    .flatMap((pattern) => splitTopLevel(pattern))
    .map((pattern) => {
      try {
        return compileGlob(pattern);
      } catch (error) {
        throw new RuleError(
          `"${key}" glob ${JSON.stringify(pattern)} ${error instanceof Error ? error.message : error}`,
        );
      }
    });
}

const SCOPE_TOKEN = /^(?:(tool)(?::([a-z0-9_-]+))?|([a-z0-9_-]+))(?:\(([^)]+)\))?$/i;

/** Resolve oh-my-pi scope tokens to the tool scopes Pi can check before a call runs. */
function parseScope(tokens: readonly string[], warnings: string[]): ToolScope[] {
  const scope: ToolScope[] = [];
  for (const raw of tokens.flatMap((token) => splitTopLevel(token))) {
    const token = raw.replace(/^(["'])(.*)\1$/, "$2").trim();
    const lower = token.toLowerCase();
    if (lower === "text" || lower === "thinking") {
      warnings.push(`scope "${token}" is ignored: matching assistant ${lower} is not supported`);
      continue;
    }
    const match = SCOPE_TOKEN.exec(token);
    if (!match) throw new RuleError(`invalid scope token ${JSON.stringify(token)}`);
    const name = (match[2] ?? match[3] ?? "").toLowerCase();
    const anyTool = match[1] !== undefined && match[2] === undefined;
    if (name === "toolcall" || anyTool) {
      for (const tool of SCOPE_TOOLS) scope.push(scopeFor(tool, match[4], token, true));
      continue;
    }
    const tool = SCOPE_TOOLS.find((candidate) => candidate === name);
    if (!tool) {
      warnings.push(`scope "${token}" is ignored: only ${SCOPE_TOOLS.join(", ")} arguments can be checked`);
      continue;
    }
    scope.push(scopeFor(tool, match[4], token, false));
  }
  return scope.filter((entry) => entry.path === undefined || PATH_TOOLS.has(entry.tool));
}

function scopeFor(tool: ScopeTool, pattern: string | undefined, token: string, anyTool: boolean): ToolScope {
  if (pattern === undefined) return { tool };
  if (!PATH_TOOLS.has(tool) && !anyTool)
    throw new RuleError(`scope "${token}" has a path, but ${tool} calls have no path to match`);
  const [path, ...more] = compileGlobs("scope", [pattern]);
  if (!path || more.length > 0) throw new RuleError(`scope "${token}" must name one path glob`);
  return { tool, path };
}

function parseRepeat(fields: ReadonlyMap<string, FrontmatterValue>): RepeatPolicy {
  const modeValue = fields.get("repeatMode");
  const gapValue = fields.get("repeatGap");
  const mode = modeValue === undefined || modeValue === null ? "once" : stringField("repeatMode", modeValue);
  if (mode !== "once" && mode !== "after-gap")
    throw new RuleError(`"repeatMode" must be once or after-gap, not ${JSON.stringify(mode)}`);
  if (mode === "once") {
    if (gapValue !== undefined && gapValue !== null) throw new RuleError('"repeatGap" needs "repeatMode: after-gap"');
    return { mode };
  }
  if (gapValue === undefined || gapValue === null) return { mode, gap: DEFAULT_REPEAT_GAP };
  const gap = typeof gapValue === "string" && /^\d{1,4}$/.test(gapValue) ? Number(gapValue) : 0;
  if (gap < 1) throw new RuleError(`"repeatGap" must be a whole number of turns from 1 to 9999`);
  return { mode, gap };
}

function parseEnforcement(fields: ReadonlyMap<string, FrontmatterValue>): Enforcement | undefined {
  const enforce = fields.get("enforce");
  const interrupt = fields.get("interruptMode");
  if (enforce !== undefined && interrupt !== undefined)
    throw new RuleError('use either "enforce" or the oh-my-pi field "interruptMode", not both');
  if (enforce !== undefined) {
    const value = stringField("enforce", enforce);
    if (value !== "block" && value !== "remind")
      throw new RuleError(`"enforce" must be block or remind, not ${JSON.stringify(value)}`);
    return value;
  }
  if (interrupt === undefined) return undefined;
  const value = stringField("interruptMode", interrupt);
  const mapped = INTERRUPT_MODES[value];
  if (!mapped)
    throw new RuleError(`"interruptMode" must be one of ${Object.keys(INTERRUPT_MODES).join(", ")}, not ${value}`);
  return mapped;
}

function buildRule(name: string, path: string, source: RuleSource, text: string): RuleFileResult {
  const { fields, body } = parseRuleFile(text);
  for (const key of fields.keys()) {
    const unsupported = UNSUPPORTED_FIELDS[key];
    if (unsupported) throw new RuleError(`"${key}" is not supported: ${unsupported}`);
    if (!KNOWN_FIELDS.has(key)) throw new RuleError(`unknown field "${key}"`);
  }
  const enabled = fields.get("enabled");
  if (enabled !== undefined && enabled !== null && !booleanField("enabled", enabled)) return { kind: "disabled", name };
  if (!body) throw new RuleError("the rule has no text after its frontmatter");

  const warnings: string[] = [];
  const field = (key: string) => {
    const value = fields.get(key);
    return value === null ? undefined : value;
  };
  const descriptionValue = field("description");
  const description = descriptionValue === undefined ? undefined : stringField("description", descriptionValue);
  if (description !== undefined && description.length > MAX_DESCRIPTION)
    throw new RuleError(`"description" is longer than ${MAX_DESCRIPTION} characters`);
  const alwaysValue = field("alwaysApply");
  const alwaysApply = alwaysValue === undefined ? false : booleanField("alwaysApply", alwaysValue);
  const globsValue = field("globs");
  const globs = globsValue === undefined ? [] : compileGlobs("globs", listField("globs", globsValue));

  const conditionValue = field("condition");
  const conditionSources = conditionValue === undefined ? [] : listField("condition", conditionValue);
  if (conditionSources.length > MAX_CONDITIONS)
    throw new RuleError(`"condition" has more than ${MAX_CONDITIONS} patterns`);
  const conditions = [...new Set(conditionSources.map((pattern) => pattern.trim()).filter(Boolean))].map((pattern) => {
    if (pattern.length > MAX_CONDITION_LENGTH)
      throw new RuleError(`a condition is longer than ${MAX_CONDITION_LENGTH} characters`);
    return compileCondition(pattern);
  });
  const scopeValue = field("scope");
  const enforcement = parseEnforcement(fields);
  const repeat = parseRepeat(fields);

  let scope: ToolScope[] = [];
  if (conditions.length > 0) {
    scope =
      scopeValue === undefined
        ? SCOPE_TOOLS.map((tool) => ({ tool }))
        : parseScope(listField("scope", scopeValue), warnings);
    if (scope.length === 0)
      throw new RuleError("the condition has no scope Pi can check; add tool:edit, write or bash");
    if (alwaysApply) warnings.push('"alwaysApply" is ignored because the rule has a condition');
  } else {
    if (conditionValue !== undefined) throw new RuleError('"condition" has no patterns');
    for (const key of ["scope", "enforce", "interruptMode"])
      if (fields.has(key)) warnings.push(`"${key}" has no effect without "condition"`);
  }

  const mode: RuleMode =
    conditions.length > 0
      ? (enforcement ?? "remind")
      : alwaysApply
        ? "always"
        : globs.length > 0
          ? "glob"
          : description
            ? "index"
            : "manual";
  return {
    kind: "rule",
    rule: {
      name,
      path,
      source,
      body,
      mode,
      description,
      globs,
      conditions,
      scope,
      repeat,
      warnings,
    },
  };
}

/**
 * Parse one rule file. An error rejects the whole file. A warning names a
 * part of an oh-my-pi rule Pi cannot honour; it only ever narrows where the
 * rule fires, never widens it.
 */
export function parseRule(name: string, path: string, source: RuleSource, text: string): RuleFileResult {
  if (!RULE_NAME.test(name))
    return {
      kind: "error",
      name,
      error: "file name must be 1-64 letters, digits, '.', '_' or '-'",
    };
  try {
    return buildRule(name, path, source, text);
  } catch (error) {
    return {
      kind: "error",
      name,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
