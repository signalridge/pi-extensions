import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { LspClient } from "../src/lsp-client.js";
import { runFix } from "../src/runner.js";
import type { LspServerAdapter } from "../src/types.js";

test("built-in edit and LSP fix serialize their complete mutation windows", async () => {
  const root = mkdtempSync(join(tmpdir(), "lsp-queue-"));
  const file = join(root, "main.ts");
  writeFileSync(file, "let a = 1;\nlet b = 1;\n");
  const adapter: LspServerAdapter = {
    name: "test",
    isDefault: true,
    defaultCommand: { command: "unused", args: [] },
    missingCommandHint: "",
    extensions: [".ts"],
    skipDirectories: new Set(),
    isSupportedFile: () => true,
    languageIdFor: () => "typescript",
  };
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(LspClient.prototype, "start").mockResolvedValue(undefined);
  vi.spyOn(LspClient.prototype, "initialize").mockResolvedValue(undefined);
  vi.spyOn(LspClient.prototype, "didOpen").mockImplementation(() => {});
  vi.spyOn(LspClient.prototype, "didClose").mockImplementation(() => {});
  vi.spyOn(LspClient.prototype, "shutdown").mockResolvedValue(undefined);
  vi.spyOn(LspClient.prototype, "diagnostics").mockResolvedValue([]);
  vi.spyOn(LspClient.prototype, "resolveActions").mockImplementation(async (actions) => actions);
  vi.spyOn(LspClient.prototype, "codeActions").mockImplementation(async () => {
    started();
    await gate;
    return [
      {
        title: "fix",
        kind: "source.fixAll",
        edit: {
          changes: {
            [pathToFileURL(file).href]: [
              { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 9 } }, newText: "2" },
            ],
          },
        },
      },
    ];
  });
  try {
    const fixing = runFix(
      adapter,
      { root, path: "./main.ts", write: true },
      1000,
      undefined,
      { ui: { setStatus: () => {} } },
      "lsp",
    );
    await ready;
    let builtInRead = false;
    const edit = createEditToolDefinition(root, {
      operations: {
        access,
        readFile: async (target) => {
          builtInRead = true;
          return readFile(target);
        },
        writeFile,
      },
    });
    const editing = edit.execute(
      "edit",
      { path: file, edits: [{ oldText: "let b = 1;", newText: "let b = 2;" }] },
      undefined,
      undefined,
      { cwd: root } as never,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(builtInRead, false);
    release();
    await Promise.all([fixing, editing]);
    assert.equal(readFileSync(file, "utf8"), "let a = 2;\nlet b = 2;\n");
    writeFileSync(file, "let a = 1;\n");
    await runFix(adapter, { root, path: file, write: false }, 1000, undefined, { ui: { setStatus: () => {} } }, "lsp");
    assert.equal(readFileSync(file, "utf8"), "let a = 1;\n");
  } finally {
    release();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
