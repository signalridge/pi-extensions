import { defineTool, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { consumeLspConfigNotice, loadRuntime } from "./adapters.js";
import { commandExists, commandPathValue } from "./command.js";
import { resolveRoot } from "./files.js";
import {
  lspDefinitionTool,
  lspHoverTool,
  lspReferencesTool,
  lspRenameTool,
  lspSymbolsTool,
} from "./navigation-tools.js";
import { selectDiagnosticRoutes, selectFixRoute } from "./routes.js";
import { DEFAULT_FILE_LIMIT, runDiagnostics, runFix, textResult } from "./runner.js";
import { LspSessionScope } from "./session-lifecycle.js";
import { resetStatus, STATUS_KEY } from "./status.js";

const ServerParameter = Type.Optional(
  Type.Union([Type.String(), Type.Array(Type.String())], {
    description:
      "Optional configured LSP server name, or names for diagnostics. Defaults to all servers matching the file extension.",
  }),
);

const DiagnosticsParameters = Type.Object({
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Files or directories to check. Defaults to the workspace root and routes by configured server extensions.",
    }),
  ),
  root: Type.Optional(Type.String({ description: "Workspace root for language servers. Defaults to cwd." })),
  limit: Type.Optional(Type.Number({ description: "Maximum files to open per selected server." })),
  server: ServerParameter,
});

const SingleFileParameters = {
  path: Type.String({
    description: "File to process. The server is selected from configured file extensions.",
  }),
  root: Type.Optional(Type.String({ description: "Workspace root for language servers. Defaults to cwd." })),
  write: Type.Optional(Type.Boolean({ description: "Write changed text back to the file. Defaults to false." })),
  server: Type.Optional(
    Type.String({
      description: "Optional configured LSP server name. Defaults to extension-based inference.",
    }),
  ),
};

const lspDiagnosticsTool = defineTool({
  name: "lsp_diagnostics",
  label: "LSP: Diagnostics",
  description: "Run diagnostics using configured, language-agnostic LSP server routes.",
  promptSnippet: "Get diagnostics from configured LSP servers selected by file extension",
  promptGuidelines: [
    "Use lsp_diagnostics when files need diagnostics from a configured LSP server.",
    "Use the server parameter only when the user asks for a specific configured LSP server or multiple servers match the same extension.",
    "If a configured server command is missing, report the configuration error and suggest installing it or updating the server's command in pi-lsp.json.",
  ],
  parameters: DiagnosticsParameters,
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const requestedRoot = resolveRoot(params.root, ctx.cwd);
    const { adapters, timeoutMs } = loadRuntime(ctx.cwd, {
      projectTrusted: ctx.isProjectTrusted(),
    });
    const { root, routes, skipped } = selectDiagnosticRoutes(
      adapters,
      { ...params, root: requestedRoot },
      DEFAULT_FILE_LIMIT,
    );
    const results = [];
    for (const route of routes) {
      signal?.throwIfAborted();
      const result = await runDiagnostics(
        route.adapter,
        { root, paths: params.paths, limit: params.limit, files: route.files },
        timeoutMs,
        signal,
        ctx,
        STATUS_KEY,
        false, // Bound the complete aggregate once, not each server section.
      );
      signal?.throwIfAborted();
      results.push({ route, result });
    }

    const sections = results.map(({ route, result }) => `${route.reason}\n\n${textFromResult(result)}`);
    if (skipped.length) {
      sections.push(
        `Skipped unavailable default LSP server(s): ${skipped.map((route) => route.adapter.name).join(", ")}.`,
      );
    }
    return textResult(sections.join("\n\n---\n\n"), {
      root,
      skipped: skipped.map((route) => ({
        server: route.adapter.name,
        reason: route.reason,
        files: route.files,
      })),
      routes: results.map(({ route, result }) => ({
        server: route.adapter.name,
        backend: route.adapter.name,
        reason: route.reason,
        files: route.files,
        details: result.details,
      })),
    });
  },
});

const lspFixTool = defineTool({
  name: "lsp_fix",
  label: "LSP: Fix",
  description: "Apply source fixes or import organization using configured LSP server routes.",
  promptSnippet: "Apply configured LSP source fixes to a file",
  promptGuidelines: [
    "Use lsp_fix for files handled by a configured LSP code-action server.",
    "Use kind when the server needs a specific source action kind such as source.organizeImports.",
  ],
  parameters: Type.Object({
    ...SingleFileParameters,
    kind: Type.Optional(
      Type.String({
        description: "Source action kind. Defaults to source.fixAll.",
      }),
    ),
  }),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const requestedRoot = resolveRoot(params.root, ctx.cwd);
    const { adapters, timeoutMs } = loadRuntime(ctx.cwd, {
      projectTrusted: ctx.isProjectTrusted(),
    });
    const { root, route } = selectFixRoute(adapters, { ...params, root: requestedRoot });
    return runFix(
      route.adapter,
      { root, path: params.path, kind: params.kind, write: params.write },
      timeoutMs,
      signal,
      ctx,
      STATUS_KEY,
    );
  },
});

export default function lsp(pi: ExtensionAPI) {
  const sessions = new WeakMap<object, LspSessionScope>();
  const newScope = (key: object) => {
    const scope: LspSessionScope = new LspSessionScope(() => sessions.get(key) === scope, sessions.get(key));
    sessions.set(key, scope);
    return scope;
  };
  const sessionFor = (key: object) => sessions.get(key) ?? newScope(key);

  // Every tool runs as one session-owned invocation that shutdown and replacement drain.
  const register = <TParams extends TSchema, TDetails>(tool: ToolDefinition<TParams, TDetails>) =>
    pi.registerTool({
      ...tool,
      execute(id, params, signal, onUpdate, ctx) {
        const scope = sessionFor(ctx.sessionManager ?? ctx);
        return scope.run(signal, (ownedSignal) => tool.execute(id, params, ownedSignal, onUpdate, scope.context(ctx)));
      },
    });
  register(lspDiagnosticsTool);
  register(lspFixTool);
  register(lspDefinitionTool);
  register(lspReferencesTool);
  register(lspHoverTool);
  register(lspSymbolsTool);
  register(lspRenameTool);

  pi.registerCommand("lsp", {
    description: "Show shared LSP extension configuration",
    handler: async (_args, ctx) => {
      try {
        const { adapters } = loadRuntime(ctx.cwd, {
          projectTrusted: ctx.isProjectTrusted(),
        });
        const notice = consumeLspConfigNotice();
        if (notice) ctx.ui.notify(notice, "warning");
        ctx.ui.notify(buildStatusMessage(adapters, ctx.cwd), statusLevel(adapters, ctx.cwd));
      } catch (error) {
        ctx.ui.notify(`LSP config ignored: ${formatError(error)}`, "warning");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const key = ctx.sessionManager ?? ctx;
    const previous = sessions.get(key);
    // Install the replacement before abort listeners can reenter session_start.
    const scope = newScope(key);
    resetStatus(scope.context(ctx), STATUS_KEY);
    const drained = scope.drainPrevious();
    if (previous) resetStatus(previous.context(ctx, true), STATUS_KEY);
    await drained;
    if (!scope.isOpen()) return;
    try {
      loadRuntime(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() });
      const notice = consumeLspConfigNotice();
      if (notice && scope.isOpen() && ctx.hasUI) scope.context(ctx).ui.notify(notice, "warning");
    } catch (error) {
      if (scope.isOpen() && ctx.hasUI) {
        scope.context(ctx).ui.notify(`LSP config ignored: ${formatError(error)}`, "warning");
      }
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const scope = sessionFor(ctx.sessionManager ?? ctx);
    const drained = scope.close();
    resetStatus(scope.context(ctx, true), STATUS_KEY);
    await drained;
  });
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function textFromResult(result: { content?: Array<{ type?: string; text?: string }> }) {
  return result.content?.find((item) => item.type === "text")?.text ?? "";
}

function buildStatusMessage(adapters: ReturnType<typeof loadRuntime>["adapters"], cwd: string) {
  return adapters
    .flatMap((adapter) => {
      const command = adapter.defaultCommand;
      return [
        `${adapter.name} LSP command: ${command.command} ${command.args.join(" ")}`.trim(),
        `${adapter.name} status: ${
          commandExists(command.command, cwd, commandPathValue(adapter.env)) ? "ready" : "command missing"
        }`,
      ];
    })
    .join("\n");
}

function statusLevel(adapters: ReturnType<typeof loadRuntime>["adapters"], cwd: string) {
  return adapters.every((adapter) => {
    const command = adapter.defaultCommand;
    return commandExists(command.command, cwd, commandPathValue(adapter.env));
  })
    ? "info"
    : "warning";
}
