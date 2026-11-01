import { splitLines } from "./lines.js";

export { splitLines } from "./lines.js";

import type { LspPosition } from "./types.js";

/**
 * A position in tool input or output: a 1-based line plus either an
 * identifier on that line or a 1-based column. Columns count UTF-16 code
 * units, the LSP default unit and the unit `lsp_diagnostics` prints.
 */
export interface PositionInput {
  line: number;
  column?: number;
  symbol?: string;
}

const IDENTIFIER_CHARACTER = /[\p{ID_Continue}$\u200c\u200d]/u;

export function resolvePosition(text: string, input: PositionInput, label: string): LspPosition {
  const lines = splitLines(text);
  if (!Number.isInteger(input.line) || input.line < 1) {
    throw new Error(`line must be a positive integer (1-based); got ${input.line}.`);
  }
  if (input.line > lines.length) {
    throw new Error(`line ${input.line} is past the end of ${label} (${lines.length} line(s)).`);
  }
  const lineIndex = input.line - 1;
  const lineText = lines[lineIndex] ?? "";
  if (input.symbol !== undefined && input.column !== undefined) {
    throw new Error("Pass either symbol or column, not both.");
  }
  if (input.symbol !== undefined) {
    return {
      line: lineIndex,
      character: symbolCharacter(lineText, input.symbol, input.line, label),
    };
  }
  if (input.column === undefined) {
    // A silent fallback such as the first non-blank column often lands on a
    // keyword or decorator and returns plausible but unrelated results.
    throw new Error(`Pass symbol (an identifier on line ${input.line}) or a 1-based column.`);
  }
  const { column } = input;
  if (!Number.isInteger(column) || column < 1) {
    throw new Error(`column must be a positive integer (1-based UTF-16 code units); got ${column}.`);
  }
  const character = column - 1;
  if (character > lineText.length) {
    throw new Error(`column ${column} is past the end of line ${input.line} (length ${lineText.length}).`);
  }
  if (isLowSurrogate(lineText.charCodeAt(character)) && isHighSurrogate(lineText.charCodeAt(character - 1))) {
    throw new Error(`column ${column} splits a surrogate pair on line ${input.line}; use column ${column - 1}.`);
  }
  return { line: lineIndex, character };
}

/** Format a 0-based LSP position as the 1-based `line:column` used in tool text. */
export function displayPosition(position: LspPosition) {
  return `${position.line + 1}:${position.character + 1}`;
}

/**
 * `name` or `name#N`, where N picks the Nth match on the line. A side that
 * ends in an identifier character must sit on an identifier boundary, so
 * `id` does not match inside `width`.
 */
function symbolCharacter(lineText: string, spec: string, line: number, label: string) {
  const occurrenceMatch = /^(.+)#(\d+)$/u.exec(spec);
  const symbol = occurrenceMatch ? (occurrenceMatch[1] ?? spec) : spec;
  const occurrence = occurrenceMatch ? Number(occurrenceMatch[2]) : 1;
  if (!symbol.trim()) throw new Error("symbol must not be blank.");
  if (occurrence < 1) throw new Error(`symbol occurrence must be 1 or greater; got ${occurrence}.`);
  const matches = symbolMatches(lineText, symbol);
  if (matches.length === 0) {
    throw new Error(`Symbol "${symbol}" was not found on line ${line} of ${label}: ${excerpt(lineText)}`);
  }
  const match = matches[occurrence - 1];
  if (match === undefined) {
    throw new Error(
      `Symbol "${symbol}" occurrence ${occurrence} is out of range on line ${line} (found ${matches.length}).`,
    );
  }
  return match;
}

function symbolMatches(lineText: string, symbol: string) {
  const boundedStart = IDENTIFIER_CHARACTER.test(codePointAt(symbol, 0));
  const boundedEnd = IDENTIFIER_CHARACTER.test(codePointBefore(symbol, symbol.length));
  const matches: number[] = [];
  for (let index = lineText.indexOf(symbol); index >= 0; index = lineText.indexOf(symbol, index + 1)) {
    const before = codePointBefore(lineText, index);
    const after = codePointAt(lineText, index + symbol.length);
    if (boundedStart && before && IDENTIFIER_CHARACTER.test(before)) continue;
    if (boundedEnd && after && IDENTIFIER_CHARACTER.test(after)) continue;
    matches.push(index);
  }
  return matches;
}

function codePointAt(text: string, index: number): string {
  const point = text.codePointAt(index);
  return point === undefined ? "" : String.fromCodePoint(point);
}

function codePointBefore(text: string, index: number): string {
  const start =
    index - (isLowSurrogate(text.charCodeAt(index - 1)) && isHighSurrogate(text.charCodeAt(index - 2)) ? 2 : 1);
  return start < 0 ? "" : codePointAt(text, start);
}

function excerpt(text: string, limit = 120) {
  const trimmed = text.trim();
  return JSON.stringify(trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed);
}

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number) {
  return code >= 0xdc00 && code <= 0xdfff;
}
