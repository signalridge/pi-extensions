/**
 * A small strict frontmatter reader for rule files.
 *
 * It accepts the YAML subset rule files actually use — one `key: value` per
 * line, quoted strings, `true`/`false`, one-line `[a, b]` lists and block
 * `- item` lists — and rejects everything else with a line number instead of
 * guessing. One deliberate difference from YAML: an unquoted value may start
 * with `*`, because Cursor writes globs such as `globs: *.ts` that a YAML
 * parser would read as an alias and reject.
 */

export type FrontmatterValue = string | boolean | readonly string[] | null;

export interface ParsedRuleFile {
  /** Fields in file order. `null` is an empty value (`description:`). */
  fields: ReadonlyMap<string, FrontmatterValue>;
  body: string;
}

export class FrontmatterError extends Error {}

const KEY_LINE = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/;
const LIST_ITEM = /^[ \t]*-(?:[ \t]+(.*))?$/;
const DOUBLE_QUOTE_ESCAPES: Record<string, string> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\u0085",
  _: " ",
  L: " ",
  P: " ",
};
const HEX_ESCAPE_LENGTH: Record<string, number> = { x: 2, u: 4, U: 8 };

function fail(line: number, message: string): never {
  throw new FrontmatterError(`line ${line}: ${message}`);
}

/** Read one quoted string starting at `text[0]`; returns the value and the unread rest. */
function readQuoted(text: string, line: number): { value: string; rest: string } {
  const quote = text[0];
  let value = "";
  for (let index = 1; index < text.length; index++) {
    const char = text[index];
    if (quote === "'") {
      if (char !== "'") value += char;
      else if (text[index + 1] === "'") {
        value += "'";
        index++;
      } else return { value, rest: text.slice(index + 1) };
      continue;
    }
    if (char === '"') return { value, rest: text.slice(index + 1) };
    if (char !== "\\") {
      value += char;
      continue;
    }
    const code = text[++index];
    const hexLength = code === undefined ? undefined : HEX_ESCAPE_LENGTH[code];
    if (hexLength !== undefined) {
      const hex = text.slice(index + 1, index + 1 + hexLength);
      if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== hexLength) fail(line, `invalid \\${code} escape`);
      value += String.fromCodePoint(Number.parseInt(hex, 16));
      index += hexLength;
      continue;
    }
    const replacement = code === undefined ? undefined : DOUBLE_QUOTE_ESCAPES[code];
    if (replacement === undefined) fail(line, `invalid escape \\${code ?? ""} in a double-quoted string`);
    value += replacement;
  }
  return fail(line, "unterminated quoted string");
}

function ensureLineEnds(rest: string, line: number): void {
  const trimmed = rest.trim();
  if (trimmed && !trimmed.startsWith("#")) fail(line, `unexpected text after the value: ${trimmed}`);
}

/** Strip a YAML comment (`#` after whitespace) from a plain value. */
function plain(text: string, line: number): string {
  const comment = text.search(/[ \t]#/);
  const value = (comment < 0 ? text : text.slice(0, comment)).trim();
  if (/^[&!%@`|>{]/.test(value))
    fail(line, `unsupported YAML syntax "${value[0]}"; quote the value or write it on one line`);
  return value;
}

function readFlowList(text: string, line: number): string[] {
  const items: string[] = [];
  let rest = text.slice(1);
  for (;;) {
    rest = rest.trimStart();
    if (rest.startsWith("]")) {
      ensureLineEnds(rest.slice(1), line);
      return items;
    }
    if (!rest) fail(line, "unterminated [ list; lists in brackets must fit on one line");
    let item: string;
    if (rest[0] === '"' || rest[0] === "'") {
      const quoted = readQuoted(rest, line);
      item = quoted.value;
      rest = quoted.rest.trimStart();
    } else {
      const end = rest.search(/[,\]]/);
      if (end < 0) fail(line, "unterminated [ list; lists in brackets must fit on one line");
      item = plain(rest.slice(0, end), line);
      if (item.startsWith("[")) fail(line, "nested lists are not supported");
      rest = rest.slice(end);
    }
    if (item) items.push(item);
    if (rest.startsWith(",")) rest = rest.slice(1);
    else if (!rest.startsWith("]")) fail(line, "expected , or ] in a [ list");
  }
}

function readValue(raw: string, line: number): FrontmatterValue {
  const text = raw.trim();
  if (!text || text.startsWith("#")) return null;
  if (text[0] === '"' || text[0] === "'") {
    const { value, rest } = readQuoted(text, line);
    ensureLineEnds(rest, line);
    return value;
  }
  if (text[0] === "[") return readFlowList(text, line);
  const value = plain(text, line);
  if (/^(?:true|True|TRUE)$/.test(value)) return true;
  if (/^(?:false|False|FALSE)$/.test(value)) return false;
  if (/^(?:null|Null|NULL|~)$/.test(value)) return null;
  return value;
}

export function parseRuleFile(text: string): ParsedRuleFile {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const fields = new Map<string, FrontmatterValue>();
  if (lines[0]?.trimEnd() !== "---") return { fields, body: normalized.trim() };

  let listKey: string | undefined;
  let listItems: string[] = [];
  const closeList = () => {
    if (listKey !== undefined && listItems.length > 0) fields.set(listKey, listItems);
    listKey = undefined;
    listItems = [];
  };
  for (let index = 1; index < lines.length; index++) {
    const line = index + 1;
    const content = lines[index] ?? "";
    if (content.trimEnd() === "---") {
      closeList();
      return {
        fields,
        body: lines
          .slice(index + 1)
          .join("\n")
          .trim(),
      };
    }
    const trimmed = content.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const item = LIST_ITEM.exec(content);
    if (item) {
      if (listKey === undefined) fail(line, "a list item must follow a key with an empty value");
      const value = readValue(item[1] ?? "", line);
      if (typeof value !== "string") fail(line, "list items must be strings");
      listItems.push(value);
      continue;
    }
    if (/^[ \t]/.test(content))
      fail(line, "multi-line values are not supported; put the value on one line or quote it");
    closeList();
    const match = KEY_LINE.exec(content);
    if (!match) fail(line, "expected `key: value`");
    const key = match[1] ?? "";
    if (fields.has(key)) fail(line, `duplicate field "${key}"`);
    const value = readValue(match[2] ?? "", line);
    fields.set(key, value);
    if (value === null) listKey = key;
  }
  return fail(lines.length, "frontmatter starts with --- but has no closing --- line");
}
