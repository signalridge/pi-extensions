import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const scenario = process.argv[2];
const expectedFiles = Number(process.argv[3] ?? "0");
let buffer = Buffer.alloc(0);
const openedUris = [];
let firstDiagnosticsRun = false;
// Open document text by URI; navigation answers prefer it over disk.
const documents = new Map();
const NAVIGATION_CAPABILITIES = {
  definitionProvider: true,
  referencesProvider: true,
  hoverProvider: true,
  documentSymbolProvider: true,
  workspaceSymbolProvider: true,
  renameProvider: true,
};
const IDENTIFIER = /[\p{L}\p{N}_$]/u;
const DECLARATION = /^(\s*)(func|type|var)\s+([\p{L}\p{N}_$]+)/u;

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function diagnostic(message, line = 0) {
  return {
    range: {
      start: { line, character: 0 },
      end: { line, character: 1 },
    },
    severity: 1,
    source: "fixture",
    message,
  };
}

function publish(uri, diagnostics) {
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics },
  });
}

function workspaceFiles() {
  return readdirSync(process.cwd(), { recursive: true })
    .filter((name) => String(name).endsWith(".go"))
    .sort()
    .map((name) => path.join(process.cwd(), String(name)));
}

function textOf(file) {
  return documents.get(pathToFileURL(file).href) ?? readFileSync(file, "utf8");
}

// JavaScript string indices are UTF-16 code units, the LSP default position encoding.
function wordAt(uri, position) {
  const line = (documents.get(uri) ?? "").split("\n")[position.line] ?? "";
  let start = position.character;
  let end = position.character;
  while (start > 0 && IDENTIFIER.test(line[start - 1])) start--;
  while (end < line.length && IDENTIFIER.test(line[end])) end++;
  return start === end ? undefined : line.slice(start, end);
}

function occurrences(word) {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_$])${word.replace(/\$/g, "\\$")}(?![\\p{L}\\p{N}_$])`, "gu");
  return workspaceFiles().flatMap((file) =>
    textOf(file)
      .split("\n")
      .flatMap((line, lineIndex) =>
        [...line.matchAll(pattern)].map((match) => ({
          uri: pathToFileURL(file).href,
          declaration: DECLARATION.exec(line)?.[3] === word,
          range: {
            start: { line: lineIndex, character: match.index },
            end: { line: lineIndex, character: match.index + word.length },
          },
        })),
      ),
  );
}

function documentSymbols(text) {
  const roots = [];
  const stack = [];
  text.split("\n").forEach((line, lineIndex) => {
    const match = DECLARATION.exec(line);
    if (!match) return;
    const [, indent, keyword, name] = match;
    const character = indent.length + keyword.length + 1;
    const symbol = {
      name,
      detail: keyword,
      kind: keyword === "func" ? 12 : keyword === "type" ? 23 : 13,
      range: { start: { line: lineIndex, character: 0 }, end: { line: lineIndex, character: line.length } },
      selectionRange: {
        start: { line: lineIndex, character },
        end: { line: lineIndex, character: character + name.length },
      },
      children: [],
    };
    while (stack.length && stack.at(-1).depth >= indent.length) stack.pop();
    (stack.at(-1)?.symbol.children ?? roots).push(symbol);
    stack.push({ depth: indent.length, symbol });
  });
  return roots;
}

function respondToNavigation(message) {
  const { textDocument, position } = message.params ?? {};
  const word = textDocument && position ? wordAt(textDocument.uri, position) : undefined;
  if (message.method === "textDocument/definition") {
    const found = word ? occurrences(word) : [];
    const target = found.find((occurrence) => occurrence.declaration) ?? found[0];
    return target
      ? [
          {
            targetUri: target.uri,
            targetRange: { start: { line: target.range.start.line, character: 0 }, end: target.range.end },
            targetSelectionRange: target.range,
          },
        ]
      : null;
  }
  if (message.method === "textDocument/references") {
    return word ? occurrences(word).map(({ uri, range }) => ({ uri, range })) : null;
  }
  if (message.method === "textDocument/hover") {
    return word ? { contents: { kind: "markdown", value: `\`\`\`go\n${word}\n\`\`\`` } } : null;
  }
  if (message.method === "textDocument/documentSymbol") {
    return documentSymbols(documents.get(textDocument.uri) ?? "");
  }
  if (message.method === "workspace/symbol") {
    const query = message.params.query.toLowerCase();
    return workspaceFiles().flatMap((file) =>
      textOf(file)
        .split("\n")
        .flatMap((line, lineIndex) => {
          const match = DECLARATION.exec(line);
          if (!match?.[3].toLowerCase().includes(query)) return [];
          const character = match[1].length + match[2].length + 1;
          return [
            {
              name: match[3],
              kind: match[2] === "func" ? 12 : 23,
              containerName: path.basename(file),
              location: {
                uri: pathToFileURL(file).href,
                range: {
                  start: { line: lineIndex, character },
                  end: { line: lineIndex, character: character + match[3].length },
                },
              },
            },
          ];
        }),
    );
  }
  if (message.method === "textDocument/rename") {
    if (!word) throw new Error("No symbol to rename at this position");
    const changes = {};
    const add = (uri, edit) => {
      changes[uri] = [...(changes[uri] ?? []), edit];
    };
    for (const { uri, range } of occurrences(word)) add(uri, { range, newText: message.params.newName });
    if (process.env.PI_LSP_TEST_RENAME_EXTRA_URI) {
      add(process.env.PI_LSP_TEST_RENAME_EXTRA_URI, {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: "// extra\n",
      });
    }
    if (scenario === "rename-invalid-range") {
      const [uri] = Object.keys(changes);
      changes[uri].push({
        range: { start: { line: 999, character: 0 }, end: { line: 999, character: 1 } },
        newText: "x",
      });
    }
    if (scenario === "rename-resource") {
      const [uri] = Object.keys(changes);
      return {
        documentChanges: [
          { textDocument: { uri, version: null }, edits: changes[uri] },
          { kind: "rename", oldUri: uri, newUri: uri.replace(/\.go$/, "_renamed.go") },
        ],
      };
    }
    return { changes };
  }
  return undefined;
}

function handle(message) {
  if (process.env.PI_LSP_TEST_LOG) appendFileSync(process.env.PI_LSP_TEST_LOG, `${JSON.stringify(message)}\n`);
  if (message.method === "initialize") {
    if (scenario === "large-stderr") {
      void (async () => {
        for (let index = 0; index < 32; index++) {
          await new Promise((resolve) => process.stderr.write(`old-stderr-marker\n${"漢".repeat(16_384)}`, resolve));
        }
        // The suffix length makes the retained 16 KiB start inside a UTF-8 character.
        process.stderr.write("\nrecent-stderr-marker!\n");
      })();
      return;
    }
    if (scenario === "invalid-stderr") {
      process.stderr.write(Buffer.alloc(65_536, 0xff));
      return;
    }
    if (scenario === "partial-stderr") {
      process.stderr.write(Buffer.from([0xe6, 0xb1]));
      return;
    }
    if (scenario === "partial-response-once") {
      const flag = path.join(process.cwd(), "partial-response-first-run.flag");
      if (!existsSync(flag)) {
        writeFileSync(flag, "done");
        process.stdout.write("Content-Length: 999\r\n\r\n{");
        return;
      }
    }
    if (scenario === "diagnostic-once") {
      const flag = path.join(process.cwd(), "diagnostic-first-run.flag");
      firstDiagnosticsRun = !existsSync(flag);
      if (firstDiagnosticsRun) writeFileSync(flag, "done");
    }
    if (scenario === "stderr-once") {
      process.on("SIGTERM", () => setTimeout(() => process.exit(0), 300));
      const flag = path.join(process.cwd(), "stderr-first-run.flag");
      if (!existsSync(flag)) {
        writeFileSync(flag, "done");
        process.stderr.write("first-run-stderr-marker\n");
      }
      return;
    }
    if (scenario === "require-environment" && process.env.PI_LSP_TEST_ENV !== "forwarded") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32002, message: "required server environment was not forwarded" },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        capabilities:
          scenario === "pull-error" ||
          scenario === "pull-strict-optional-params" ||
          scenario === "pull-empty-then-push" ||
          scenario === "pull-empty-after-push" ||
          scenario === "pull-empty-only" ||
          scenario === "pull-alternate-uri"
            ? {
                diagnosticProvider: {
                  interFileDependencies: false,
                  workspaceDiagnostics: false,
                },
              }
            : scenario === "navigation" || scenario === "navigation-hang" || scenario.startsWith("rename-")
              ? NAVIGATION_CAPABILITIES
              : scenario === "navigation-hover-only"
                ? { hoverProvider: {}, definitionProvider: false }
                : scenario === "resolve-literal"
                  ? {
                      codeActionProvider:
                        message.params.capabilities.textDocument?.codeAction?.codeActionLiteralSupport?.codeActionKind?.valueSet?.includes(
                          "source.fixAll",
                        )
                          ? { resolveProvider: true }
                          : true,
                    }
                  : scenario === "resolve-enabled"
                    ? { codeActionProvider: { resolveProvider: true } }
                    : scenario === "resolve-disabled"
                      ? { codeActionProvider: true }
                      : {},
      },
    });
    return;
  }

  if (message.method === "textDocument/didClose") {
    documents.delete(message.params.textDocument.uri);
    return;
  }

  if (message.method === "textDocument/didOpen") {
    const uri = message.params.textDocument.uri;
    openedUris.push(uri);
    documents.set(uri, message.params.textDocument.text);
    if (scenario === "diagnostic-once") {
      if (firstDiagnosticsRun) publish(uri, [diagnostic("old server diagnostic")]);
      return;
    }
    if (scenario === "push-alternate-uri" || scenario === "pull-alternate-uri") {
      const alternate = uri
        .replace(/^file:\/\/\/([A-Za-z]):\//, (_match, drive) => `file:///${drive.toLowerCase()}%3A/`)
        .replace(/-/g, "%2D");
      publish(alternate, [diagnostic("alternate uri diagnostic")]);
      return;
    }
    if (scenario !== "push-silent" && scenario !== "push-silent-then-diagnostic") {
      publish(uri, []);
    }
    if (scenario === "push-silent-then-diagnostic") {
      setTimeout(() => publish(uri, [diagnostic("late push-only diagnostic")]), 40);
    } else if (scenario === "push-sequence") {
      setTimeout(() => publish(uri, [diagnostic("first")]), 20);
      setTimeout(() => publish(uri, [diagnostic("first"), diagnostic("second", 1)]), 40);
    } else if (scenario === "pull-empty-then-push") {
      setTimeout(() => publish(uri, [diagnostic("late pull-capable diagnostic")]), 40);
    } else if (scenario === "pull-empty-after-push") {
      publish(uri, [diagnostic("already published diagnostic")]);
    } else if (scenario === "batch-push" && openedUris.length === expectedFiles) {
      setTimeout(() => {
        for (const openedUri of openedUris) {
          publish(openedUri, [diagnostic(`ready:${openedUri}`)]);
        }
      }, 5);
    }
    return;
  }

  if (message.method === "textDocument/diagnostic") {
    if (scenario === "pull-strict-optional-params") {
      const hasUnsupportedOptionalParam =
        Object.hasOwn(message.params, "identifier") || Object.hasOwn(message.params, "previousResultId");
      send(
        hasUnsupportedOptionalParam
          ? {
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32602, message: "optional diagnostic params must be omitted" },
            }
          : {
              jsonrpc: "2.0",
              id: message.id,
              result: { kind: "full", items: [diagnostic("strict pull diagnostic")] },
            },
      );
      return;
    }
    send(
      scenario === "pull-empty-then-push" ||
        scenario === "pull-empty-after-push" ||
        scenario === "pull-empty-only" ||
        scenario === "pull-alternate-uri"
        ? { jsonrpc: "2.0", id: message.id, result: { kind: "full", items: [] } }
        : {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: "intentional pull failure" },
          },
    );
    return;
  }

  if (message.method === "textDocument/codeAction" && scenario === "resolve-literal") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: [
        {
          title: "deferred fixture fix",
          kind: "source.fixAll.fixture",
          data: { uri: message.params.textDocument.uri },
        },
      ],
    });
    return;
  }

  if (message.method === "codeAction/resolve" && scenario === "resolve-literal") {
    const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "// fixed\n" };
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { ...message.params, edit: { changes: { [message.params.data.uri]: [edit] } } },
    });
    return;
  }

  if (
    message.id !== undefined &&
    (scenario === "navigation" || scenario.startsWith("navigation-") || scenario.startsWith("rename-"))
  ) {
    if (message.method === "textDocument/references" && scenario === "navigation-hang") return;
    try {
      const result = respondToNavigation(message);
      if (result !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, result });
        return;
      }
    } catch (error) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: error.message } });
      return;
    }
  }

  if (message.method === "codeAction/resolve") {
    if (scenario === "resolve-enabled") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { ...message.params, title: `${message.params.title}:resolved` },
      });
    } else {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: "unexpected code-action resolve" },
      });
    }
    return;
  }

  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }

  if (message.method === "exit") process.exit(0);
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const separator = buffer.indexOf("\r\n\r\n");
    if (separator < 0) return;
    const header = buffer.subarray(0, separator).toString("utf8");
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
    const bodyStart = separator + 4;
    if (!Number.isFinite(length) || buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    handle(JSON.parse(body));
  }
});

// Optional test bootstrap acknowledgement, separate from any RPC response.
if (process.env.PI_LSP_TEST_READY) writeFileSync(process.env.PI_LSP_TEST_READY, "ready");
