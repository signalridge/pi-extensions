import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { displayPath, resolveSupportedFile } from "./files.js";
import type { LspClient } from "./lsp-client.js";
import {
  displayUri,
  formatLocations,
  formatSymbols,
  hoverText,
  normalizeLocations,
  normalizeSymbols,
} from "./lsp-results.js";
import { displayPosition, type PositionInput, resolvePosition } from "./positions.js";
import type { OperationRoute } from "./routes.js";
import { textResult, withLspClient } from "./runner.js";
import type { LspPosition, LspServerAdapter, StatusContext } from "./types.js";

export type NavigationRequest =
  | ({ operation: "definition" | "references" | "hover" } & PositionInput)
  | { operation: "symbols"; query?: string };

const POSITION_REQUESTS = {
  definition: {
    provider: "definitionProvider",
    method: "textDocument/definition",
  },
  references: {
    provider: "referencesProvider",
    method: "textDocument/references",
  },
  hover: { provider: "hoverProvider", method: "textDocument/hover" },
} as const;

/**
 * Start each candidate in configured order until one advertises `provider` in
 * its `initialize` result, then run the operation on that server only.
 */
export async function runOnCapableServer<T>(
  route: OperationRoute,
  provider: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  ctx: StatusContext,
  statusKey: string,
  operation: (client: LspClient, adapter: LspServerAdapter) => Promise<T>,
): Promise<{ adapter: LspServerAdapter; value: T }> {
  const declined: string[] = [];
  for (const adapter of route.candidates) {
    const label = `${adapter.name} ${route.operation}`;
    const outcome = await withLspClient(
      adapter,
      route.root,
      timeoutMs,
      signal,
      ctx,
      statusKey,
      label,
      async (client) => (client.hasCapability(provider) ? { value: await operation(client, adapter) } : undefined),
    );
    if (outcome) return { adapter, value: outcome.value };
    declined.push(adapter.name);
  }
  const unavailable = route.skipped.length
    ? ` Not started because the command is missing: ${route.skipped.map((adapter) => adapter.name).join(", ")}.`
    : "";
  throw new Error(
    `No configured LSP server for ${displayPath(route.root, route.file)} advertises ${provider}, ` +
      `which ${route.operation} requires. Servers without it: ${declined.join(", ")}.${unavailable} ` +
      `Configure a server that provides ${route.operation} for ${path.extname(route.file) || "these"} files in pi-lsp.json.`,
  );
}

export async function runNavigation(
  route: OperationRoute,
  request: NavigationRequest,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  ctx: StatusContext,
  statusKey: string,
) {
  const [lead] = route.candidates;
  if (!lead) throw new Error(`No ${route.operation} route supports ${route.file}.`);
  const root = route.root;
  const file = resolveSupportedFile(lead, root, route.file);
  const relativePath = path.relative(root, file) || file;
  const text = readFileSync(file, "utf8");
  const uri = pathToFileURL(file).href;
  const ask = (provider: string, method: string, params: unknown) =>
    runOnCapableServer(route, provider, timeoutMs, signal, ctx, statusKey, async (client, adapter) => {
      // Project-aware servers such as tsserver need an open file, even for workspace symbols.
      client.didOpen(uri, text, adapter.languageIdFor(file));
      try {
        return await client.requestResult(method, params);
      } finally {
        client.didClose(uri);
      }
    });
  const base = { root, path: relativePath, operation: route.operation };

  if (request.operation === "symbols") {
    const { query } = request;
    if (query !== undefined && !query.trim()) {
      throw new Error("query must not be blank; omit it to list the symbols in path.");
    }
    const { adapter, value } =
      query === undefined
        ? await ask("documentSymbolProvider", "textDocument/documentSymbol", { textDocument: { uri } })
        : await ask("workspaceSymbolProvider", "workspace/symbol", { query });
    const rows = normalizeSymbols(value, uri);
    const scope = query === undefined ? `in ${relativePath}` : `matching ${JSON.stringify(query)}`;
    const header = `${adapter.name} symbols ${scope}: ${rows.length} symbol(s).`;
    const lines = formatSymbols(root, rows, query !== undefined);
    return textResult(rows.length ? `${header}\n\n${lines.join("\n")}` : header, {
      ...base,
      server: adapter.name,
      query,
      count: rows.length,
      symbols: rows.map((row) => ({
        name: row.name,
        kind: row.kind,
        depth: row.depth,
        path: row.uri ? displayUri(root, row.uri) : undefined,
        ...lineColumn(row.position),
        container: row.container,
      })),
    });
  }

  // Validate the position before any server starts.
  const position = resolvePosition(text, request, relativePath);
  const { provider, method } = POSITION_REQUESTS[request.operation];
  const context = request.operation === "references" ? { context: { includeDeclaration: true } } : {};
  const { adapter, value } = await ask(provider, method, { textDocument: { uri }, position, ...context });
  const subject = `${relativePath}:${displayPosition(position)}${request.symbol ? ` (${request.symbol})` : ""}`;
  const details = { ...base, server: adapter.name, position: lineColumn(position) };
  if (request.operation === "hover") {
    const hover = hoverText(value);
    return textResult(
      hover
        ? `${adapter.name} hover for ${subject}:\n\n${hover}`
        : `${adapter.name} returned no hover information for ${subject}.`,
      { ...details, found: hover !== undefined },
    );
  }

  const locations = normalizeLocations(value);
  const noun = request.operation === "definition" ? "definition" : "references";
  const header = locations.length
    ? `${adapter.name} ${noun} for ${subject}: ${locations.length} location(s).`
    : `${adapter.name} found no ${noun} for ${subject}.`;
  const lines = formatLocations(root, locations, { uri, text });
  return textResult(locations.length ? `${header}\n\n${lines.join("\n")}` : header, {
    ...details,
    count: locations.length,
    locations: locations.map((location) => ({
      path: displayUri(root, location.uri),
      ...lineColumn(location.range.start),
    })),
  });
}

function lineColumn(position: LspPosition | undefined) {
  return position ? { line: position.line + 1, column: position.character + 1 } : {};
}
