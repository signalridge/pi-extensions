import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadRuntime } from "./adapters.js";
import { resolveRoot } from "./files.js";
import { runNavigation } from "./navigation.js";
import { runRename } from "./rename.js";
import { selectOperationRoute } from "./routes.js";
import { STATUS_KEY } from "./status.js";
import type { LspOperation } from "./types.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const FileParameters = {
  path: Type.String({
    description: "File to query. The server is selected from configured file extensions.",
  }),
  root: Type.Optional(
    Type.String({
      description: "Workspace root for language servers. Defaults to cwd.",
    }),
  ),
  server: Type.Optional(
    Type.String({
      description:
        "Optional configured LSP server name. Defaults to the first matching server that advertises this operation.",
    }),
  ),
};

const PositionParameters = {
  ...FileParameters,
  line: Type.Integer({ minimum: 1, description: "1-based line number." }),
  symbol: Type.Optional(
    Type.String({
      description:
        "Identifier on that line; its first match sets the position. Append #N for the Nth match on the line, " +
        "for example value#2. Preferred over column.",
    }),
  ),
  column: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "1-based column in UTF-16 code units, as lsp_diagnostics prints it. Use instead of symbol.",
    }),
  ),
};

function routeFor(
  params: { root?: string; path: string; server?: string },
  ctx: ExtensionContext,
  operation: LspOperation,
) {
  const requestedRoot = resolveRoot(params.root, ctx.cwd);
  const { adapters, timeoutMs } = loadRuntime(ctx.cwd, {
    projectTrusted: ctx.isProjectTrusted(),
  });
  return {
    route: selectOperationRoute(adapters, { ...params, root: requestedRoot }, operation),
    timeoutMs,
  };
}

export const lspDefinitionTool = defineTool({
  name: "lsp_definition",
  label: "LSP: Definition",
  description: "Find where the symbol at a file position is defined, using a configured LSP server.",
  promptSnippet: "Jump to a symbol's definition through a configured LSP server",
  promptGuidelines: [
    "Use lsp_definition, lsp_references, lsp_hover, and lsp_symbols to navigate code a configured language server covers; pass the line and the identifier as symbol instead of counting columns.",
  ],
  parameters: Type.Object(PositionParameters),
  annotations: READ_ONLY,
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const { route, timeoutMs } = routeFor(params, ctx, "definition");
    return runNavigation(route, { ...params, operation: "definition" }, timeoutMs, signal, ctx, STATUS_KEY);
  },
});

export const lspReferencesTool = defineTool({
  name: "lsp_references",
  label: "LSP: References",
  description: "List references to the symbol at a file position, including its declaration.",
  promptSnippet: "List references to a symbol through a configured LSP server",
  parameters: Type.Object(PositionParameters),
  annotations: READ_ONLY,
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const { route, timeoutMs } = routeFor(params, ctx, "references");
    return runNavigation(route, { ...params, operation: "references" }, timeoutMs, signal, ctx, STATUS_KEY);
  },
});

export const lspHoverTool = defineTool({
  name: "lsp_hover",
  label: "LSP: Hover",
  description: "Show the type and documentation a configured LSP server reports for the symbol at a file position.",
  promptSnippet: "Show type and documentation for a symbol through a configured LSP server",
  parameters: Type.Object(PositionParameters),
  annotations: READ_ONLY,
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const { route, timeoutMs } = routeFor(params, ctx, "hover");
    return runNavigation(route, { ...params, operation: "hover" }, timeoutMs, signal, ctx, STATUS_KEY);
  },
});

export const lspSymbolsTool = defineTool({
  name: "lsp_symbols",
  label: "LSP: Symbols",
  description:
    "List the symbols declared in a file, or with query, search the workspace for symbols by name. " +
    "The file selects the server and gives project-aware servers a project to load.",
  promptSnippet: "List a file's symbols or search workspace symbols through a configured LSP server",
  parameters: Type.Object({
    ...FileParameters,
    query: Type.Optional(
      Type.String({
        description: "Search workspace symbols by name instead of listing the file's symbols.",
      }),
    ),
  }),
  annotations: READ_ONLY,
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const { route, timeoutMs } = routeFor(params, ctx, "symbols");
    return runNavigation(route, { operation: "symbols", query: params.query }, timeoutMs, signal, ctx, STATUS_KEY);
  },
});

export const lspRenameTool = defineTool({
  name: "lsp_rename",
  label: "LSP: Rename",
  description:
    "Rename the symbol at a file position across the workspace with a configured LSP server. " +
    "Returns a preview of every edit by default and writes files only with apply: true.",
  promptSnippet: "Preview or apply a semantic rename through a configured LSP server",
  promptGuidelines: [
    "Use lsp_rename for semantic renames: review the preview, then repeat the same call with apply: true to write it.",
    "lsp_rename with apply: true writes files outside the edit tool; reread changed files before editing them again.",
  ],
  parameters: Type.Object({
    ...PositionParameters,
    newName: Type.String({ description: "New name for the symbol." }),
    apply: Type.Optional(
      Type.Boolean({
        description: "Write the edits. Defaults to false, which only returns a preview.",
      }),
    ),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const { route, timeoutMs } = routeFor(params, ctx, "rename");
    return runRename(route, params, timeoutMs, signal, ctx, STATUS_KEY);
  },
});
