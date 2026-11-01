import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LspServerAdapter } from "../src/types.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/diagnostics-server.mjs");

export function navigationAdapter(name: string, scenario: string, log: string): LspServerAdapter {
  return {
    name,
    isDefault: false,
    defaultCommand: { command: process.execPath, args: [fixture, scenario] },
    missingCommandHint: "Node is required for the test fixture.",
    extensions: [".go"],
    env: { PI_LSP_TEST_LOG: log },
    skipDirectories: new Set(),
    isSupportedFile: (file) => file.endsWith(".go"),
    languageIdFor: () => "go",
  };
}

/** Every JSON-RPC message the fixture server received, in order. */
export function messages(log: string) {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          method?: string;
          params?: Record<string, unknown>;
        },
    );
}

export function text(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((item) => item.text ?? "").join("\n");
}
