import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const scenario = process.argv[2];
const expectedFiles = Number(process.argv[3] ?? "0");
let buffer = Buffer.alloc(0);
const openedUris = [];
let firstDiagnosticsRun = false;

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

function handle(message) {
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
          scenario === "pull-empty-only"
            ? {
                diagnosticProvider: {
                  interFileDependencies: false,
                  workspaceDiagnostics: false,
                },
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

  if (message.method === "textDocument/didOpen") {
    const uri = message.params.textDocument.uri;
    openedUris.push(uri);
    if (scenario === "diagnostic-once") {
      if (firstDiagnosticsRun) publish(uri, [diagnostic("old server diagnostic")]);
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
      scenario === "pull-empty-then-push" || scenario === "pull-empty-after-push" || scenario === "pull-empty-only"
        ? { jsonrpc: "2.0", id: message.id, result: { kind: "full", items: [] } }
        : {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: "intentional pull failure" },
          },
    );
    return;
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
