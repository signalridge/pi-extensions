import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Snippet } from "../src/snippets.js";
import { pickSnippet } from "../src/ui.js";

function ownership() {
  const controller = new AbortController();
  return { controller, signal: controller.signal, isCurrent: () => !controller.signal.aborted };
}

test("raw, CSI-u, and shifted Kitty printable keys apply the same snippet filter", async () => {
  const snippets = [
    { id: 0, type: "block", language: "ts", content: "zulu", sourceLabel: "now", messageId: "a" },
    { id: 1, type: "block", language: "ts", content: "Abacus", sourceLabel: "now", messageId: "b" },
  ] as Snippet[];
  for (const input of ["A", "\u001b[65u", "\u001b[97:65;2u"]) {
    const renders: string[] = [];
    const ctx = {
      mode: "tui",
      hasUI: true,
      ui: {
        custom: async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
          let result: unknown;
          const component = await factory(
            { requestRender() {} } as never,
            { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
            {} as never,
            (value) => {
              result = value;
            },
          );
          component.handleInput?.(input);
          renders.push(component.render(140).join("\n"));
          component.handleInput?.("\r");
          return result;
        },
      },
    };
    const picked = await pickSnippet(ctx as never, snippets, ownership());
    assert.equal(picked?.snippet.content, "Abacus");
    assert.match(renders[0] ?? "", /Filter: A/);
    assert.doesNotMatch(renders[0] ?? "", /zulu/);
  }
});
