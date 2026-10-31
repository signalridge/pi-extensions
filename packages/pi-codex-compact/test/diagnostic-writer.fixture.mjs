import { mock } from "bun:test";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { createDiagnosticTrace, flushDiagnostics } from "../src/diagnostics.ts";

const [path, mode] = process.argv.slice(2);
if (!path) throw new Error("test path required");
if (mode === "hold") {
  const original = fs.open;
  mock.module("node:fs/promises", () => ({
    ...fs,
    open: async (...args) => {
      const handle = await original(...args);
      if (args[0] === path && typeof args[1] === "number" && args[1] & constants.O_APPEND) {
        const stat = handle.stat.bind(handle);
        let calls = 0;
        Object.defineProperty(handle, "stat", {
          value: async () => {
            const result = await stat();
            if (++calls === 2) {
              process.stdout.write("ready\n");
              await new Promise((resolve) => process.stdin.once("data", resolve));
              process.stdin.pause();
            }
            return result;
          },
        });
      }
      return handle;
    },
  }));
}
createDiagnosticTrace("concurrent-writer", "manual", { path }).phase("fetch");
await flushDiagnostics();
