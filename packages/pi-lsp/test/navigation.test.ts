import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import * as adapters from "../src/adapters.js";
import { runNavigation } from "../src/navigation.js";
import lsp from "../src/pi-lsp.js";
import { selectOperationRoute } from "../src/routes.js";
import type { LspOperation } from "../src/types.js";
import { messages, navigationAdapter, text } from "./navigation-fixture.js";
import { createMockContext, createMockPi } from "./support.js";

const ctx = { ui: { setStatus() {} } };

function workspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-navigation-"));
  writeFileSync(
    path.join(root, "main.go"),
    'package main\n\nfunc greet(name string) string { return "😀" + name }\n\nfunc main() { greet("x"); greet("y") }\n',
  );
  mkdirSync(path.join(root, "pkg"));
  writeFileSync(path.join(root, "pkg", "other.go"), "package main\n\ntype Server struct{}\n\nvar _ = greet\n");
  return root;
}

test("navigation routes each operation to the first server advertising its provider", async () => {
  const root = workspace();
  const hoverLog = path.join(root, "hover.jsonl");
  const navigationLog = path.join(root, "navigation.jsonl");
  const servers = [
    navigationAdapter("hover-only", "navigation-hover-only", hoverLog),
    navigationAdapter("navigator", "navigation", navigationLog),
  ];
  const route = (operation: LspOperation, file = "main.go") =>
    selectOperationRoute(servers, { root, path: file }, operation);
  try {
    const definition = await runNavigation(
      route("definition"),
      { operation: "definition", line: 5, symbol: "greet#2" },
      5_000,
      undefined,
      ctx,
      "test",
    );
    assert.equal(
      text(definition),
      "navigator definition for main.go:5:27 (greet#2): 1 location(s).\n\n" +
        'main.go:3:6: func greet(name string) string { return "😀" + name }',
    );
    assert.deepEqual(definition.details, {
      root,
      path: "main.go",
      operation: "definition",
      server: "navigator",
      position: { line: 5, column: 27 },
      count: 1,
      locations: [{ path: "main.go", line: 3, column: 6 }],
    });
    // The hover-only server was started and shut down, but never asked for a definition.
    // `exit` may race the termination signal that follows it, so only the awaited sequence is exact.
    assert.deepEqual(
      messages(hoverLog)
        .map(({ method }) => method)
        .filter((method) => method !== "exit"),
      ["initialize", "initialized", "shutdown"],
    );
    const request = messages(navigationLog).find(({ method }) => method === "textDocument/definition");
    assert.deepEqual(request?.params?.position, { line: 4, character: 26 });

    // `name#2` follows an emoji: its UTF-16 offset (47) differs from its code-point offset (46).
    rmSync(hoverLog);
    const hover = await runNavigation(
      route("hover"),
      { operation: "hover", line: 3, symbol: "name#2" },
      5_000,
      undefined,
      ctx,
      "test",
    );
    assert.equal(text(hover), "hover-only hover for main.go:3:48 (name#2):\n\n```go\nname\n```");
    assert.deepEqual(messages(hoverLog).find(({ method }) => method === "textDocument/hover")?.params?.position, {
      line: 2,
      character: 47,
    });

    const references = await runNavigation(
      route("references", path.join("pkg", "other.go")),
      { operation: "references", line: 5, column: 9 },
      5_000,
      undefined,
      ctx,
      "test",
    );
    assert.equal(
      text(references),
      [
        `navigator references for ${path.join("pkg", "other.go")}:5:9: 4 location(s).`,
        "",
        'main.go:3:6: func greet(name string) string { return "😀" + name }',
        'main.go:5:15: func main() { greet("x"); greet("y") }',
        'main.go:5:27: func main() { greet("x"); greet("y") }',
        `${path.join("pkg", "other.go")}:5:9: var _ = greet`,
      ].join("\n"),
    );
    assert.deepEqual(
      messages(navigationLog).find(({ method }) => method === "textDocument/references")?.params?.context,
      { includeDeclaration: true },
    );

    const empty = await runNavigation(
      route("definition"),
      { operation: "definition", line: 5, column: 12 },
      5_000,
      undefined,
      ctx,
      "test",
    );
    assert.equal(text(empty), "navigator found no definition for main.go:5:12.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("symbols list a file's tree, or search the workspace with a query", async () => {
  const root = workspace();
  writeFileSync(path.join(root, "tree.go"), "package main\n\nfunc outer() {\n\tvar inner = 1\n}\n");
  const servers = [navigationAdapter("navigator", "navigation", path.join(root, "log.jsonl"))];
  try {
    const document = await runNavigation(
      selectOperationRoute(servers, { root, path: "tree.go" }, "symbols"),
      { operation: "symbols" },
      5_000,
      undefined,
      ctx,
      "test",
    );
    assert.equal(
      text(document),
      "navigator symbols in tree.go: 2 symbol(s).\n\nfunction outer func @ 3:6\n  variable inner var @ 4:6",
    );
    const search = await runNavigation(
      selectOperationRoute(servers, { root, path: "tree.go" }, "symbols"),
      { operation: "symbols", query: "SERV" },
      5_000,
      undefined,
      ctx,
      "test",
    );
    assert.equal(
      text(search),
      `navigator symbols matching "SERV": 1 symbol(s).\n\nstruct Server in other.go @ ${path.join("pkg", "other.go")}:3:6`,
    );
    await assert.rejects(
      runNavigation(
        selectOperationRoute(servers, { root, path: "tree.go" }, "symbols"),
        { operation: "symbols", query: " " },
        5_000,
        undefined,
        ctx,
        "test",
      ),
      /query must not be blank/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an operation no server advertises fails with the provider and the servers tried", async () => {
  const root = workspace();
  const log = path.join(root, "log.jsonl");
  const missing = navigationAdapter("missing-default", "navigation", log);
  missing.isDefault = true;
  missing.defaultCommand = { command: "./not-installed-lsp", args: [] };
  const servers = [missing, navigationAdapter("hover-only", "navigation-hover-only", log)];
  try {
    await assert.rejects(
      runNavigation(
        selectOperationRoute(servers, { root, path: "main.go" }, "definition"),
        { operation: "definition", line: 3, symbol: "greet" },
        5_000,
        undefined,
        ctx,
        "test",
      ),
      (error: Error) => {
        assert.equal(
          error.message,
          "No configured LSP server for main.go advertises definitionProvider, which definition requires. " +
            "Servers without it: hover-only. Not started because the command is missing: missing-default. " +
            "Configure a server that provides definition for .go files in pi-lsp.json.",
        );
        return true;
      },
    );
    // Position errors are reported before any server starts.
    rmSync(log);
    await assert.rejects(
      runNavigation(
        selectOperationRoute(servers, { root, path: "main.go" }, "hover"),
        { operation: "hover", line: 3, symbol: "missing" },
        5_000,
        undefined,
        ctx,
        "test",
      ),
      /Symbol "missing" was not found on line 3 of main.go/,
    );
    assert.equal(existsSync(log), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelling a pending navigation request reaps the server and leaves no listeners", async () => {
  const root = workspace();
  const log = path.join(root, "log.jsonl");
  const servers = [navigationAdapter("hang", "navigation-hang", log)];
  const controller = new AbortController();
  try {
    const running = runNavigation(
      selectOperationRoute(servers, { root, path: "main.go" }, "references"),
      { operation: "references", line: 3, symbol: "greet" },
      30_000,
      controller.signal,
      ctx,
      "test",
    );
    await vi.waitFor(() => assert.ok(messages(log).some(({ method }) => method === "textDocument/references")));
    controller.abort();
    await assert.rejects(running, /hang LSP request (aborted|cancelled)/);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    // The same launcher and root are admitted again once the old child closed.
    const hover = await runNavigation(
      selectOperationRoute(servers, { root, path: "main.go" }, "hover"),
      { operation: "hover", line: 3, symbol: "greet" },
      5_000,
      undefined,
      ctx,
      "test",
    );
    assert.match(text(hover), /hang hover for main.go:3:6 \(greet\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registered navigation tools resolve routes from the session cwd and run in the session scope", async () => {
  const root = workspace();
  vi.spyOn(adapters, "loadRuntime").mockReturnValue({
    adapters: [navigationAdapter("navigator", "navigation", path.join(root, "log.jsonl"))],
    timeoutMs: 5_000,
  });
  const mock = createMockPi();
  lsp(mock.pi);
  const tool = (name: string) =>
    mock.tools.find((candidate) => candidate.name === name) as unknown as {
      execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }> }>;
    };
  const { ctx: toolContext } = createMockContext({ cwd: root, mode: "print" });
  try {
    const result = await tool("lsp_definition").execute(
      "call",
      { path: "pkg/other.go", line: 5, symbol: "greet" },
      undefined,
      undefined,
      toolContext,
    );
    assert.match(text(result), /^navigator definition for pkg\/other.go:5:9 \(greet\): 1 location\(s\)\./);
    await assert.rejects(
      tool("lsp_hover").execute("call", { path: "main.go", line: 3 }, undefined, undefined, toolContext),
      /Pass symbol \(an identifier on line 3\) or a 1-based column/,
    );
  } finally {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
