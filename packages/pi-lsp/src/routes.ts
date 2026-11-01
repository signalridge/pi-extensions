import path from "node:path";
import { commandExists, commandPathValue } from "./command.js";
import { collectSupportedFiles, resolveRoot } from "./files.js";
import type { LspOperation, LspServerAdapter } from "./types.js";

export interface DiagnosticRoute {
  adapter: LspServerAdapter;
  reason: string;
  files: string[];
}

export interface SingleFileRoute {
  adapter: LspServerAdapter;
  reason: string;
}

export interface DiagnosticRouteParams {
  root?: string;
  paths?: string[];
  limit?: number;
  server?: string | string[];
}

export interface SingleFileRouteParams {
  root?: string;
  path: string;
  server?: string;
}

/** Servers to probe, in configured order, for one file-scoped operation. */
export interface OperationRoute {
  root: string;
  file: string;
  operation: LspOperation;
  candidates: LspServerAdapter[];
  // Default servers whose command is missing; reported only if no candidate serves the operation.
  skipped: LspServerAdapter[];
}

export const SUPPORTED_SERVER_DESCRIPTION =
  "Supported LSP servers are defined by pi-lsp config and selected by file extension.";

export function selectDiagnosticRoutes(
  adapters: LspServerAdapter[],
  params: DiagnosticRouteParams,
  defaultLimit: number,
) {
  const root = resolveRoot(params.root);
  const candidates = filterAdapters(adapters, params.server, "diagnostics");
  const skipped: DiagnosticRoute[] = [];
  const runnableCandidates = params.server
    ? candidates
    : candidates.filter((adapter) => {
        if (!adapter.isDefault) return true;
        const command = adapter.defaultCommand;
        if (commandExists(command.command, root, commandPathValue(adapter.env))) return true;
        skipped.push({ adapter, reason: `${adapter.name} command missing`, files: [] });
        return false;
      });

  const filesByPolicy = new Map<string, string[]>();
  const routes = runnableCandidates
    .map((adapter) => {
      const key = diagnosticFilePolicyKey(adapter);
      let files = filesByPolicy.get(key);
      if (!files) {
        files = collectSupportedFiles(adapter, root, params.paths, params.limit ?? defaultLimit);
        filesByPolicy.set(key, files);
      }
      return { adapter, reason: `${adapter.name} diagnostics`, files };
    })
    .filter((route) => route.files.length > 0);

  if (routes.length === 0 && skipped.length === 0) {
    const scope = params.paths?.length ? ` in requested paths: ${params.paths.join(", ")}` : "";
    throw new Error(`No supported files found${scope}. ${SUPPORTED_SERVER_DESCRIPTION}`);
  }

  return { root, routes, skipped };
}

export function selectFixRoute(adapters: LspServerAdapter[], params: SingleFileRouteParams) {
  const root = resolveRoot(params.root);
  const file = path.resolve(root, params.path);
  const candidates = filterAdapters(adapters, params.server, "fix").filter((adapter) => adapter.isSupportedFile(file));
  if (candidates.length === 0) throw unsupportedFileError("fix", params.path, params.server);
  if (!params.server && candidates.length > 1) {
    throw new Error(
      `Multiple LSP servers support ${params.path}: ${candidates.map((adapter) => adapter.name).join(", ")}. ` +
        "Specify the server parameter for lsp_fix.",
    );
  }
  const adapter = candidates[0];
  return {
    root,
    route: {
      adapter,
      reason: `${adapter.name} fix`,
    },
  };
}

export function selectOperationRoute(
  adapters: LspServerAdapter[],
  params: SingleFileRouteParams,
  operation: LspOperation,
): OperationRoute {
  const root = resolveRoot(params.root);
  const file = path.resolve(root, params.path);
  const supported = filterAdapters(adapters, params.server, operation).filter((adapter) =>
    adapter.isSupportedFile(file),
  );
  if (supported.length === 0) throw unsupportedFileError(operation, params.path, params.server);
  const skipped: LspServerAdapter[] = [];
  const candidates = params.server
    ? supported
    : supported.filter((adapter) => {
        if (!adapter.isDefault) return true;
        if (commandExists(adapter.defaultCommand.command, root, commandPathValue(adapter.env))) return true;
        skipped.push(adapter);
        return false;
      });
  if (candidates.length === 0) {
    const missing = skipped.map((adapter) => `${adapter.name} (command missing: ${adapter.defaultCommand.command})`);
    throw new Error(
      `No available LSP server for ${params.path} provides ${operation}: ${missing.join(", ")}. ` +
        "Install one, or configure a server for this file type in pi-lsp.json.",
    );
  }
  return { root, file, operation, candidates, skipped };
}

export function routesOperation(adapter: LspServerAdapter, operation: LspOperation) {
  return !adapter.operations || adapter.operations.has(operation);
}

function diagnosticFilePolicyKey(adapter: LspServerAdapter) {
  return JSON.stringify([
    adapter.extensions,
    [...adapter.skipDirectories].sort((left, right) => left.localeCompare(right)),
  ]);
}

function filterAdapters(
  adapters: LspServerAdapter[],
  selected: string | string[] | undefined,
  operation: LspOperation,
) {
  if (!selected) return adapters.filter((adapter) => routesOperation(adapter, operation));
  const names = [...new Set((Array.isArray(selected) ? selected : [selected]).map((name) => name.trim()))].filter(
    (name) => name.length > 0,
  );
  if (names.length === 0) throw new Error("LSP server parameter must not be blank.");
  const matched = adapters.filter((adapter) => names.includes(adapter.name));
  const missing = names.filter((name) => !adapters.some((adapter) => adapter.name === name));
  if (missing.length) {
    const configured = adapters.map((adapter) => adapter.name).join(", ") || "none";
    throw new Error(
      `Unknown LSP server(s): ${missing.join(", ")}. Configured LSP servers: ${configured}. ` +
        "Omit the server parameter to select matching servers automatically.",
    );
  }
  const excluded = matched.filter((adapter) => !routesOperation(adapter, operation));
  if (excluded.length) {
    const described = excluded.map(
      (adapter) => `${adapter.name} (operations: ${[...(adapter.operations ?? [])].join(", ")})`,
    );
    throw new Error(
      `LSP server(s) not routed for ${operation}: ${described.join(", ")}. ` +
        `Add "${operation}" to the server's operations in pi-lsp.json, or omit the server parameter.`,
    );
  }
  return matched;
}

function unsupportedFileError(action: LspOperation, filePath: string, server: string | undefined) {
  const override = server ? ` for server '${server}'` : "";
  return new Error(`No ${action} route supports ${filePath}${override}. ${SUPPORTED_SERVER_DESCRIPTION}`);
}
