import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { loadRuntime } from "../src/adapters.js";
import {
  formatLocations,
  formatSymbols,
  hoverText,
  LOCATION_CONTEXT_LIMIT,
  normalizeLocations,
  normalizeSymbols,
} from "../src/lsp-results.js";
import { selectDiagnosticRoutes, selectFixRoute, selectOperationRoute } from "../src/routes.js";
import type { LspServerAdapter } from "../src/types.js";

const range = (line: number, character: number, length = 1) => ({
  start: { line, character },
  end: { line, character: character + length },
});

test("locations accept Location, Location[] and LocationLink[] and drop malformed entries", () => {
  assert.deepEqual(normalizeLocations(null), []);
  assert.deepEqual(normalizeLocations({ uri: "file:///a.go", range: range(1, 2) }), [
    { uri: "file:///a.go", range: range(1, 2) },
  ]);
  assert.deepEqual(
    normalizeLocations([
      {
        targetUri: "file:///b.go",
        targetRange: range(4, 0, 20),
        targetSelectionRange: range(4, 5, 3),
      },
      { targetUri: "file:///c.go", targetRange: range(7, 0, 9) },
      { uri: "file:///broken.go" },
      "file:///string.go",
    ]),
    [
      { uri: "file:///b.go", range: range(4, 5, 3) },
      { uri: "file:///c.go", range: range(7, 0, 9) },
    ],
  );
});

test("locations print workspace-relative paths, bounded source lines and an omission note", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-locations-"));
  const real = path.join(directory, "real");
  const root = path.join(directory, "link");
  mkdirSync(path.join(real, "pkg"), { recursive: true });
  symlinkSync(real, root);
  const other = path.join(real, "pkg", "other.go");
  writeFileSync(other, `package pkg\n\tvar long = "${"x".repeat(300)}"\n`);
  const outside = path.join(directory, "outside.go");
  writeFileSync(outside, "package outside\n");
  const known = {
    uri: pathToFileURL(path.join(root, "main.go")).href,
    text: "package main\n  func main() {}\n",
  };
  try {
    const lines = formatLocations(
      root,
      [
        { uri: known.uri, range: range(1, 7) },
        // Servers often report the real path behind a symlinked workspace root.
        { uri: pathToFileURL(other).href, range: range(1, 5) },
        { uri: pathToFileURL(outside).href, range: range(0, 0) },
        { uri: "jdt://contents/rt.jar/String.class", range: range(2, 3) },
      ],
      known,
    );
    assert.deepEqual(lines.slice(0, 1), ["main.go:2:8: func main() {}"]);
    assert.match(lines[1] ?? "", new RegExp(`^${path.join("pkg", "other.go")}:2:6: var long = "x{188}…$`));
    assert.deepEqual(lines.slice(2), [`${outside}:1:1: package outside`, "jdt://contents/rt.jar/String.class:3:4"]);

    const many = Array.from({ length: LOCATION_CONTEXT_LIMIT + 2 }, () => ({
      uri: known.uri,
      range: range(0, 0),
    }));
    const bounded = formatLocations(root, many, known);
    assert.equal(bounded.length, LOCATION_CONTEXT_LIMIT + 3);
    assert.equal(bounded[LOCATION_CONTEXT_LIMIT - 1], "main.go:1:1: package main");
    assert.equal(bounded[LOCATION_CONTEXT_LIMIT], "(source lines omitted for the remaining 2 location(s))");
    assert.equal(bounded.at(-1), "main.go:1:1");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hover text accepts MarkupContent, MarkedString objects and arrays", () => {
  assert.equal(hoverText(null), undefined);
  assert.equal(hoverText({ contents: { kind: "markdown", value: "**int**" } }), "**int**");
  assert.equal(
    hoverText({
      contents: ["plain", { language: "go", value: "func f()" }, ""],
    }),
    "plain\n\n```go\nfunc f()\n```",
  );
  assert.equal(hoverText({ contents: { kind: "plaintext", value: "  " } }), undefined);
});

test("symbols flatten document trees, symbol information and unresolved workspace symbols", () => {
  const uri = "file:///root/main.go";
  const tree = normalizeSymbols(
    [
      {
        name: "Server",
        kind: 23,
        detail: "struct{...}",
        range: range(2, 0, 30),
        selectionRange: range(2, 5, 6),
        children: [
          {
            name: "Start",
            kind: 6,
            range: range(3, 1, 20),
            selectionRange: range(3, 6, 5),
          },
        ],
      },
      { name: "missingRange", kind: 12 },
    ],
    uri,
  );
  assert.deepEqual(formatSymbols("/root", tree, false), ["struct Server struct{...} @ 3:6", "  method Start @ 4:7"]);
  const workspace = normalizeSymbols(
    [
      {
        name: "Start",
        kind: 6,
        containerName: "Server",
        location: { uri, range: range(3, 6, 5) },
      },
      { name: "Lazy", kind: 99, location: { uri: "file:///root/pkg/lazy.go" } },
    ],
    uri,
  );
  assert.deepEqual(formatSymbols("/root", workspace, true), [
    "method Start in Server @ main.go:4:7",
    `kind 99 Lazy @ ${path.join("pkg", "lazy.go")}`,
  ]);
  assert.deepEqual(normalizeSymbols({ name: "not an array" }, uri), []);
});

function adapter(name: string, operations?: string[], isDefault = false): LspServerAdapter {
  return {
    name,
    isDefault,
    extensions: [".go"],
    operations: operations ? new Set(operations as never[]) : undefined,
    skipDirectories: new Set(),
    defaultCommand: { command: process.execPath, args: [] },
    missingCommandHint: "",
    languageIdFor: () => "go",
    isSupportedFile: (file) => file.endsWith(".go"),
  };
}

test("operation routes keep configured order, honor operations, and skip missing default commands", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-operation-routes-"));
  writeFileSync(path.join(root, "main.go"), "package main\n");
  const linter = adapter("linter", ["diagnostics", "fix"]);
  const first = adapter("first");
  const second = adapter("second", ["definition", "rename"]);
  const missing = adapter("missing", undefined, true);
  missing.defaultCommand = { command: "./missing-lsp", args: [] };
  try {
    const route = selectOperationRoute([linter, missing, first, second], { root, path: "main.go" }, "definition");
    assert.deepEqual(
      route.candidates.map(({ name }) => name),
      ["first", "second"],
    );
    assert.deepEqual(
      route.skipped.map(({ name }) => name),
      ["missing"],
    );
    assert.equal(route.file, path.join(root, "main.go"));
    assert.deepEqual(
      selectOperationRoute([linter, first, second], { root, path: "main.go" }, "hover").candidates.map(
        ({ name }) => name,
      ),
      ["first"],
    );
    // An explicit server is not probed for its command and is the only candidate.
    assert.deepEqual(
      selectOperationRoute([first, second], { root, path: "main.go", server: "second" }, "rename").candidates.map(
        ({ name }) => name,
      ),
      ["second"],
    );
    assert.throws(
      () => selectOperationRoute([linter, second], { root, path: "main.go", server: "linter" }, "definition"),
      /LSP server\(s\) not routed for definition: linter \(operations: diagnostics, fix\)\. Add "definition"/,
    );
    assert.throws(
      () => selectOperationRoute([linter, missing], { root, path: "main.go" }, "references"),
      /No available LSP server for main.go provides references: missing \(command missing: \.\/missing-lsp\)/,
    );
    assert.throws(
      () => selectOperationRoute([linter], { root, path: "main.go" }, "references"),
      /No references route supports main.go/,
    );
    // Diagnostics and fixes skip servers that are not routed for them.
    assert.deepEqual(
      selectDiagnosticRoutes([linter, second], { root }, 50).routes.map(({ adapter }) => adapter.name),
      ["linter"],
    );
    assert.equal(selectFixRoute([linter, second], { root, path: "main.go" }).route.adapter.name, "linter");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the default catalog keeps TS diagnostics and fixes on Biome and navigation on typescript-language-server", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-default-ts-"));
  const agentDir = path.join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(path.join(root, "main.ts"), "export const value = 1;\n");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const { adapters } = loadRuntime(root);
    const byName = (name: string) => adapters.find((candidate) => candidate.name === name);
    assert.deepEqual([...(byName("biome")?.operations ?? [])], ["diagnostics", "fix"]);
    assert.deepEqual(byName("typescript-language-server")?.defaultCommand, {
      command: "typescript-language-server",
      args: ["--stdio"],
    });
    assert.equal(byName("typescript-language-server")?.languageIdFor("view.tsx"), "typescriptreact");
    // Explicit selection avoids the PATH probe, so this checks routing alone.
    assert.equal(selectFixRoute(adapters, { root, path: "main.ts" }).route.adapter.name, "biome");
    for (const operation of ["definition", "references", "hover", "symbols", "rename"] as const) {
      const route = selectOperationRoute(
        adapters,
        { root, path: "main.ts", server: "typescript-language-server" },
        operation,
      );
      assert.deepEqual(
        route.candidates.map(({ name }) => name),
        ["typescript-language-server"],
      );
      assert.throws(
        () => selectOperationRoute(adapters, { root, path: "main.ts", server: "biome" }, operation),
        /not routed for/,
      );
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("server operations are validated in pi-lsp.json", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-operations-config-"));
  const agentDir = path.join(root, "agent");
  mkdirSync(agentDir);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const write = (operations: unknown) =>
    writeFileSync(
      path.join(agentDir, "pi-lsp.json"),
      JSON.stringify({
        gopls: { command: ["gopls"], extensions: [".go"], operations },
      }),
    );
  try {
    write(["hover", "definition", "hover"]);
    assert.deepEqual([...(loadRuntime(root).adapters[0]?.operations ?? [])], ["hover", "definition"]);
    for (const invalid of [[], ["navigate"], "hover"]) {
      write(invalid);
      assert.throws(
        () => loadRuntime(root),
        /gopls\.operations must be a non-empty array of: diagnostics, fix, definition, references, hover, symbols, rename/,
      );
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});
