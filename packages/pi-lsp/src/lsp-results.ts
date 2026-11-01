import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { displayPath } from "./files.js";
import { displayPosition, splitLines } from "./positions.js";
import { isRange, isRecord } from "./text-edits.js";
import type { LspLocation, LspPosition } from "./types.js";

// Source context is read for the first locations only; the rest print as positions.
export const LOCATION_CONTEXT_LIMIT = 100;
const CONTEXT_FILE_BYTES = 4 * 1024 * 1024;
const CONTEXT_LINE_LIMIT = 200;

const SYMBOL_KINDS = [
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enum member",
  "struct",
  "event",
  "operator",
  "type parameter",
];

export interface SymbolRow {
  name: string;
  kind: string;
  depth: number;
  uri?: string;
  position?: LspPosition;
  detail?: string;
  container?: string;
}

/** Accept Location, Location[], LocationLink[] or null; drop malformed entries. */
export function normalizeLocations(result: unknown): LspLocation[] {
  const items = Array.isArray(result) ? result : result === null || result === undefined ? [] : [result];
  return items.flatMap((item): LspLocation[] => {
    if (!isRecord(item)) return [];
    if (typeof item.uri === "string" && isRange(item.range)) return [{ uri: item.uri, range: item.range }];
    // A link's selection range is the name, not the whole declaration body.
    const range = isRange(item.targetSelectionRange) ? item.targetSelectionRange : item.targetRange;
    if (typeof item.targetUri === "string" && isRange(range)) return [{ uri: item.targetUri, range }];
    return [];
  });
}

export function displayUri(root: string, uri: string) {
  try {
    return displayPath(root, fileURLToPath(uri));
  } catch {
    // Servers such as jdtls also return non-file URIs for library sources.
    return uri;
  }
}

/** `path:line:column: source line`, reading each file at most once. */
export function formatLocations(root: string, locations: LspLocation[], known: { uri: string; text: string }) {
  const lines = new Map<string, string[] | undefined>([[known.uri, splitLines(known.text)]]);
  const formatted = locations.map((location, index) => {
    const where = `${displayUri(root, location.uri)}:${displayPosition(location.range.start)}`;
    if (index >= LOCATION_CONTEXT_LIMIT) return where;
    if (!lines.has(location.uri)) lines.set(location.uri, readLines(location.uri));
    const source = lines.get(location.uri)?.[location.range.start.line]?.trim();
    return source ? `${where}: ${truncate(source, CONTEXT_LINE_LIMIT)}` : where;
  });
  if (locations.length > LOCATION_CONTEXT_LIMIT) {
    formatted.splice(
      LOCATION_CONTEXT_LIMIT,
      0,
      `(source lines omitted for the remaining ${locations.length - LOCATION_CONTEXT_LIMIT} location(s))`,
    );
  }
  return formatted;
}

/** Accept MarkupContent, a MarkedString, or an array of MarkedStrings. */
export function hoverText(result: unknown) {
  if (!isRecord(result)) return undefined;
  return markedText(result.contents).trim() || undefined;
}

function markedText(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(markedText).filter(Boolean).join("\n\n");
  if (!isRecord(contents) || typeof contents.value !== "string") return "";
  // MarkupContent has a kind; a MarkedString object names its language.
  if (typeof contents.language === "string" && contents.language) {
    return `\`\`\`${contents.language}\n${contents.value}\n\`\`\``;
  }
  return contents.value;
}

/** Flatten DocumentSymbol trees, SymbolInformation and WorkspaceSymbol results. */
export function normalizeSymbols(result: unknown, documentUri: string): SymbolRow[] {
  if (!Array.isArray(result)) return [];
  const rows: SymbolRow[] = [];
  const visit = (item: unknown, depth: number) => {
    if (!isRecord(item) || typeof item.name !== "string") return;
    const kind = symbolKind(item.kind);
    if (isRange(item.selectionRange)) {
      rows.push({
        name: item.name,
        kind,
        depth,
        uri: documentUri,
        position: item.selectionRange.start,
        detail: typeof item.detail === "string" && item.detail ? item.detail : undefined,
      });
      if (Array.isArray(item.children)) for (const child of item.children) visit(child, depth + 1);
      return;
    }
    const location = isRecord(item.location) ? item.location : undefined;
    if (typeof location?.uri !== "string") return;
    rows.push({
      name: item.name,
      kind,
      depth,
      uri: location.uri,
      // A WorkspaceSymbol may omit the range until it is resolved.
      position: isRange(location.range) ? location.range.start : undefined,
      container: typeof item.containerName === "string" && item.containerName ? item.containerName : undefined,
    });
  };
  for (const item of result) visit(item, 0);
  return rows;
}

export function formatSymbols(root: string, rows: SymbolRow[], includePath: boolean) {
  return rows.map((row) => {
    const position = row.position ? displayPosition(row.position) : undefined;
    const file = includePath && row.uri ? displayUri(root, row.uri) : undefined;
    const where = [file, position].filter(Boolean).join(":");
    const detail = row.detail ? ` ${truncate(row.detail, CONTEXT_LINE_LIMIT)}` : "";
    const container = row.container ? ` in ${row.container}` : "";
    return `${"  ".repeat(row.depth)}${row.kind} ${row.name}${detail}${container}${where ? ` @ ${where}` : ""}`;
  });
}

function symbolKind(kind: unknown) {
  return typeof kind === "number" ? (SYMBOL_KINDS[kind - 1] ?? `kind ${kind}`) : "symbol";
}

function readLines(uri: string) {
  try {
    const file = fileURLToPath(uri);
    const stats = statSync(file);
    if (!stats.isFile() || stats.size > CONTEXT_FILE_BYTES) return undefined;
    return splitLines(readFileSync(file, "utf8"));
  } catch {
    // Context is decoration; an unreadable location still prints its position.
    return undefined;
  }
}

function truncate(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
