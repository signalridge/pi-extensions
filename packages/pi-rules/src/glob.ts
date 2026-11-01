import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** A compiled file glob. Matching is the same on every host: no platform glob API is involved. */
export interface Glob {
  readonly pattern: string;
  matches(path: string): boolean;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/;
const literal = (char: string) => (REGEX_SPECIAL.test(char) ? `\\${char}` : char);

/**
 * Translate a glob into RegExp source: `**` as a whole path segment spans
 * directories, `*` and `?` stay inside one segment, `[...]`/`[!...]` are
 * character classes and `{a,b}` alternatives may nest. Throws when unbalanced.
 */
function globSource(pattern: string): string {
  let source = "";
  let braces = 0;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "\\") {
      const next = pattern[++index];
      if (next === undefined) throw new Error("ends with an escape");
      source += literal(next);
    } else if (char === "*") {
      const globstar =
        pattern[index + 1] === "*" &&
        (index === 0 || pattern[index - 1] === "/") &&
        (index + 2 === pattern.length || pattern[index + 2] === "/");
      if (!globstar) {
        while (pattern[index + 1] === "*") index++;
        source += "[^/]*";
      } else if (pattern[index + 2] === "/") {
        source += "(?:[^/]*/)*";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "?") source += "[^/]";
    else if (char === "[") {
      const close = pattern.indexOf("]", index + 2);
      if (close < 0) throw new Error("has an unclosed [");
      let body = pattern.slice(index + 1, close);
      const negated = body.startsWith("!") || body.startsWith("^");
      if (negated) body = body.slice(1);
      source += `[${negated ? "^" : ""}${body.replaceAll("\\", "\\\\")}]`;
      index = close;
    } else if (char === "{") {
      braces++;
      source += "(?:";
    } else if (char === "}") {
      if (braces === 0) throw new Error("has an unmatched }");
      braces--;
      source += ")";
    } else if (char === "," && braces > 0) source += "|";
    else source += literal(char);
  }
  if (braces > 0) throw new Error("has an unclosed {");
  return source;
}

export function compileGlob(pattern: string): Glob {
  const trimmed = pattern.trim().replace(/^\.\//, "");
  if (!trimmed) throw new Error("is empty");
  const regex = new RegExp(`^${globSource(trimmed)}$`);
  return {
    pattern: trimmed,
    // As in Cursor and oh-my-pi, a pattern also matches the file name alone, so `*.ts` covers `src/a.ts`.
    matches: (path) => regex.test(path) || regex.test(basename(path)),
  };
}

/** Normalize a tool `path` argument to a cwd-relative POSIX path (absolute when outside cwd). */
export function normalizeToolPath(cwd: string, raw: string): string | undefined {
  let value = raw;
  if (value.startsWith("@")) value = value.slice(1);
  if (!value) return undefined;
  // Pi decodes only the exact lowercase file:// prefix. Other file: spellings
  // are literal paths (including file:src/a.ts and FILE:// on POSIX).
  if (value.startsWith("file://")) {
    try {
      value = fileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  if (value === "~" || value.startsWith("~/")) value = homedir() + value.slice(1);
  const absolute = resolve(cwd, value);
  const inside = relative(cwd, absolute);
  const chosen = inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : absolute;
  return sep === "\\" ? chosen.replaceAll("\\", "/") : chosen;
}

/** Split on commas outside quotes, (), [] and {}; used for scope tokens and comma-separated globs. */
export function splitTopLevel(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | undefined;
  for (const char of value) {
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if ("([{".includes(char)) depth++;
    else if (")]}".includes(char)) depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      if (current.trim()) tokens.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) tokens.push(current.trim());
  return tokens;
}
