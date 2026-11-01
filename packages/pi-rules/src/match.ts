import { normalizeToolPath } from "./glob.js";
import type { Rule } from "./rule.js";

/** What one tool call exposes to rules: the text it would write or run, and the paths it touches. */
export interface CallSubject {
  tool: string;
  texts: readonly string[];
  paths: readonly string[];
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Read the built-in Pi 1.4 tool arguments after schema validation: `edit`
 * contributes each `edits[].newText` (only the replacement text, never the
 * text being removed), `write` its `content`, and `bash`/`powershell` the
 * `command`. Any tool's top-level `path`/`paths` counts as a touched path.
 */
export function describeCall(tool: string, input: Record<string, unknown>, cwd: string): CallSubject {
  let texts: string[] = [];
  if (tool === "edit") {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    texts = edits.flatMap((edit: unknown) =>
      typeof edit === "object" && edit !== null && "newText" in edit ? strings(edit.newText) : [],
    );
  } else if (tool === "write") texts = strings(input.content);
  else if (tool === "bash" || tool === "powershell") texts = strings(input.command);
  const paths = [...strings(input.path), ...strings(input.paths)]
    .map((path) => normalizeToolPath(cwd, path))
    .filter((path): path is string => path !== undefined);
  return { tool, texts, paths };
}

function touches(rule: Rule, call: CallSubject): boolean {
  return rule.globs.some((glob) => call.paths.some((path) => glob.matches(path)));
}

/** A `condition` rule matches when the call is in its scope, inside its `globs` (if any) and a pattern hits. */
export function matchesCondition(rule: Rule, call: CallSubject): boolean {
  if (rule.conditions.length === 0) return false;
  const scopes = rule.scope.filter((scope) => scope.tool === call.tool);
  if (!scopes.some((scope) => scope.path === undefined || call.paths.some((path) => scope.path?.matches(path))))
    return false;
  if (rule.globs.length > 0 && !touches(rule, call)) return false;
  return call.texts.some((text) => rule.conditions.some((condition) => condition.test(text)));
}

/** A glob rule (Cursor "auto attached") is offered when a call touches one of its files. */
export function matchesGlobs(rule: Rule, call: CallSubject): boolean {
  return rule.mode === "glob" && touches(rule, call);
}
