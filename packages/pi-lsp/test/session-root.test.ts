import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import * as adapters from "../src/adapters.js";
import extension from "../src/pi-lsp.js";
import * as routes from "../src/routes.js";

test("both tool roots are resolved against session cwd, including relative roots", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lsp-context-"));
  mkdirSync(join(cwd, "nested"));
  const tools: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
  const stop = new Error("route inspected");
  vi.spyOn(adapters, "loadRuntime").mockReturnValue({ adapters: [], timeoutMs: 1000 });
  const diagnostics = vi.spyOn(routes, "selectDiagnosticRoutes").mockImplementation(() => {
    throw stop;
  });
  const fix = vi.spyOn(routes, "selectFixRoute").mockImplementation(() => {
    throw stop;
  });
  try {
    extension({ registerTool: (tool: never) => tools.push(tool), registerCommand: () => {}, on: () => {} } as never);
    assert.notEqual(cwd, process.cwd());
    for (const tool of tools) {
      for (const root of [undefined, "nested"]) {
        await assert.rejects(
          tool.execute("root", { root, path: "main.ts" }, undefined, undefined, { cwd, isProjectTrusted: () => false }),
          (error) => error === stop,
        );
        const spy = tool.name === "lsp_fix" ? fix : diagnostics;
        assert.equal(spy.mock.calls.at(-1)?.[1].root, root ? join(cwd, root) : cwd);
      }
    }
  } finally {
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  }
});
