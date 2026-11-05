import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { HistoryPopupComponent } from "../src/index.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
} as never;
const raw = "  😀 e\u0301 👩‍💻\n exact payload  ";

for (let rows = 0; rows <= 7; rows++) {
  test(`history at ${rows} terminal rows keeps the query visible or cancels without accepting`, async () => {
    for (const width of [20, 40, 76, 100]) {
      const results: (string | null)[] = [];
      const popup = new HistoryPopupComponent(
        { terminal: { rows }, requestRender() {} } as never,
        theme,
        [{ text: raw }],
        (value) => results.push(value),
      );
      if (rows >= 5) popup.handleInput("😀");
      const lines = popup.render(width);
      assert.ok(lines.length <= Math.floor(rows * 0.85));
      assert.ok(lines.every((line) => line.isWellFormed() && visibleWidth(line) <= width));
      if (rows < 5) {
        assert.deepEqual(lines, []);
        popup.handleInput("\r"); // Must not accept an invisible result before deferred closure.
        await Promise.resolve();
        assert.deepEqual(results, [null]);
      } else {
        const plain = stripVTControlCharacters(lines.join("\n"));
        assert.match(plain, /> 😀/u);
        assert.equal((plain.match(/>/gu) ?? []).length, 1, "Input owns the only prompt glyph");
        assert.match(plain, /▌/u, "a selected result remains visible alongside the query");
        popup.handleInput("\r");
        assert.deepEqual(results, [raw]);
      }
    }
  });
}

for (const shrinkRows of [0, 1, 2, 3, 4]) {
  for (const renderFirst of [false, true]) {
    test(`shrink to ${shrinkRows} rows cancels ${renderFirst ? "during rendering" : "before next render"} and stays closed`, async () => {
      const terminal = { rows: 24 };
      const results: (string | null)[] = [];
      const popup = new HistoryPopupComponent(
        { terminal, requestRender() {} } as never,
        theme,
        [{ text: raw }],
        (value) => results.push(value),
      );
      popup.handleInput("😀");
      assert.match(stripVTControlCharacters(popup.render(100).join("\n")), /> 😀/u);
      terminal.rows = shrinkRows;
      if (renderFirst) assert.deepEqual(popup.render(100), []);
      else popup.handleInput("\r");
      // Recovery before a deferred done callback must not revive a retired selection.
      terminal.rows = 24;
      popup.handleInput("\r");
      popup.handleInput("\x12");
      popup.handleInput("\x1b");
      assert.deepEqual(popup.render(100), []);
      await Promise.resolve();
      assert.deepEqual(results, [null]);
    });
  }
}

for (const cancel of ["\x1b", "\x07", "\x03"]) {
  test(`cancel ${JSON.stringify(cancel)} at the minimum height is final`, () => {
    const terminal = { rows: 5 };
    const results: (string | null)[] = [];
    const popup = new HistoryPopupComponent(
      { terminal, requestRender() {} } as never,
      theme,
      [{ text: raw }],
      (value) => results.push(value),
    );
    assert.equal(popup.render(40).length, 4);
    popup.handleInput(cancel);
    terminal.rows = 40;
    popup.handleInput("\r");
    assert.deepEqual(results, [null]);
  });
}

test("resizing above the minimum preserves query, local navigation and exact accepted payload", () => {
  const terminal = { rows: 24 };
  const results: (string | null)[] = [];
  const popup = new HistoryPopupComponent(
    { terminal, requestRender() {} } as never,
    theme,
    [{ text: "😀 newer" }, { text: raw }],
    (value) => results.push(value),
  );
  popup.handleInput("😀");
  for (const rows of [7, 6, 5, 24, 5]) {
    terminal.rows = rows;
    const lines = popup.render(100);
    assert.ok(lines.length <= Math.floor(rows * 0.85));
    assert.match(stripVTControlCharacters(lines.join("\n")), /> 😀/u);
  }
  popup.handleInput("\x12"); // Ctrl+R still selects the older match.
  assert.match(stripVTControlCharacters(popup.render(100).join("\n")), /2\/2/u);
  popup.handleInput("\r");
  assert.deepEqual(results, [raw]);
});
