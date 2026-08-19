/**
 * render.test.mjs — the pure rendering helpers behind the rounded input box.
 *
 * Every one of these functions edits a string that pi-tui has already laid out,
 * so the invariant that matters most is width: the overlay reserves exactly one
 * column and rewrites cells in place, and any function that changes a line's
 * rendered width desynchronises Pi's cursor math. Width is asserted explicitly
 * rather than left implied by the expected string.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  detachLeadingShellBang,
  HARDWARE_CURSOR_MARKER,
  highlightLeadingSlashToken,
  injectPromptSymbol,
  resolvePromptMarker,
  wrapWithRoundedBorder,
} from "../src/render.ts";

const identity = (text) => text;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Test helper strips ANSI SGR sequences.
const stripSgr = (text) => text.replaceAll(/\[[0-9;]*m/g, "");
const magenta = (text) => `\x1b[35m${text}\x1b[39m`;
const themedAccent = (text) => `\x1b[1m${magenta(text)}\x1b[22m`;

describe("injectPromptSymbol", () => {
  test("overlays the glyph at column 2 without changing the line width", () => {
    const promptLine = "    hello         ";
    const withPrompt = injectPromptSymbol(promptLine, ">");
    assert.equal(withPrompt, "  > hello         ");
    assert.equal(withPrompt.length, promptLine.length);
  });

  // The overlay rewrites Pi's four columns of left padding in place. Without
  // them there is nothing to write into, and shifting the text would move every
  // cell after it.
  test("declines a line without the four-column editor padding", () => {
    assert.equal(injectPromptSymbol("  too narrow", ">"), undefined);
    assert.equal(injectPromptSymbol("", ">"), undefined);
    assert.equal(injectPromptSymbol("no padding at all", ">"), undefined);
  });

  test("accepts any single-cell glyph", () => {
    assert.equal(injectPromptSymbol("    hi", "❯"), "  ❯ hi");
  });
});

describe("detachLeadingShellBang", () => {
  test("removes the plain leading bang and restores the width at the right edge", () => {
    const shellLine = "    !git status        ";
    const detached = detachLeadingShellBang(shellLine);
    assert.equal(detached.line, "    git status         ");
    assert.equal(detached.detached, true);
    assert.equal(detached.cursorOnPrompt, false);
    assert.equal(detached.line.length, shellLine.length);
  });

  test("reports the cursor sitting on the bang, and preserves the cursor marker", () => {
    const line = `    ${HARDWARE_CURSOR_MARKER}\x1b[7m!\x1b[0mgit status        `;
    const detached = detachLeadingShellBang(line);
    assert.equal(detached.detached, true);
    assert.equal(detached.cursorOnPrompt, true);
    assert.equal(detached.hardwareCursorMarker, HARDWARE_CURSOR_MARKER);
    assert.equal(detached.line, "    git status         ");
  });

  test("accepts the other SGR reset pi emits for the inverse bang", () => {
    const detached = detachLeadingShellBang("    \x1b[7m!\x1b[27mls   ");
    assert.equal(detached.detached, true);
    assert.equal(detached.cursorOnPrompt, true);
  });

  test("leaves a line that does not start with a bang untouched", () => {
    const line = "    git status  ";
    const detached = detachLeadingShellBang(line);
    assert.equal(detached.line, line);
    assert.equal(detached.detached, false);
    assert.equal(detached.cursorOnPrompt, false);
  });

  test("leaves a line without editor padding untouched", () => {
    const detached = detachLeadingShellBang("!git status");
    assert.equal(detached.line, "!git status");
    assert.equal(detached.detached, false);
  });

  // A bang that is not the first character is part of the command, not pi's
  // shell-mode marker.
  test("does not detach a bang that appears later in the line", () => {
    const detached = detachLeadingShellBang("    echo hi!   ");
    assert.equal(detached.detached, false);
  });
});

describe("wrapWithRoundedBorder", () => {
  test("replaces the horizontal rules with corners and the edges with walls", () => {
    const box = wrapWithRoundedBorder(
      ["────────────────────", "    hello           ", "────────────────────"],
      identity,
    );
    assert.deepEqual(box, ["╭──────────────────╮", "│   hello          │", "╰──────────────────╯"]);
  });

  test("keeps every row exactly as wide as it came in", () => {
    const box = wrapWithRoundedBorder(
      ["────────────────────", "    hello           ", "────────────────────"],
      identity,
    );
    assert.ok(box.every((line) => line.length === 20));
  });

  test("insets a label into the top rule without widening it", () => {
    const label = " \x1b[1m! shell mode\x1b[0m ";
    const box = wrapWithRoundedBorder(
      ["────────────────────", "                    ", "────────────────────"],
      identity,
      { label },
    );
    assert.equal(stripSgr(box[0]), "╭ ! shell mode ────╮");
    assert.equal(stripSgr(box[0]).length, 20);
  });

  // The label is measured with its ANSI stripped; a label wider than the rule
  // has nowhere to go, so the plain border is drawn rather than a torn one.
  test("drops a label too wide for the rule", () => {
    const box = wrapWithRoundedBorder(["──────", "      ", "──────"], identity, {
      label: " a very long label indeed ",
    });
    assert.equal(stripSgr(box[0]), "╭────╮");
  });

  test("labels only the top rule, never the bottom", () => {
    const box = wrapWithRoundedBorder(["────────", "        ", "────────"], identity, { label: " x " });
    assert.equal(stripSgr(box[0]), "╭ x ───╮");
    assert.equal(stripSgr(box.at(-1)), "╰──────╯");
  });

  test("sees through the theme's colouring to find the rules", () => {
    const box = wrapWithRoundedBorder([magenta("─").repeat(8), "        ", magenta("─").repeat(8)], magenta);
    assert.deepEqual(box.map(stripSgr), ["╭──────╮", "│      │", "╰──────╯"]);
  });

  test("leaves an empty row alone", () => {
    assert.deepEqual(wrapWithRoundedBorder([""], identity), [""]);
  });

  test("handles a one-column rule, which has no middle to draw", () => {
    assert.deepEqual(wrapWithRoundedBorder(["─"], identity), ["╭"]);
  });
});

describe("highlightLeadingSlashToken", () => {
  test("paints the command token through the cursor marker and inverse styling", () => {
    const line = `    ${HARDWARE_CURSOR_MARKER}\x1b[7m/\x1b[0mhelp       `;
    const highlighted = highlightLeadingSlashToken(line, themedAccent);
    assert.notEqual(highlighted, undefined);
    assert.equal(stripSgr(highlighted).replaceAll(HARDWARE_CURSOR_MARKER, ""), "    /help       ");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Test asserts ANSI styling output.
    assert.match(highlighted, /\x1b\[35m/);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Test asserts ANSI styling output.
    assert.match(highlighted, /\x1b\[1m/);
  });

  // Only a LEADING slash names a command. A path has text before its slash, so
  // highlighting it would colour an argument as if it were a command.
  test("declines a slash that is not the first non-space character", () => {
    assert.equal(highlightLeadingSlashToken("    path/to/file   ", themedAccent), undefined);
    assert.equal(highlightLeadingSlashToken("    run /help", themedAccent), undefined);
  });

  test("declines a line with no slash at all", () => {
    assert.equal(highlightLeadingSlashToken("    hello world", themedAccent), undefined);
  });

  test("stops the token at the first space, leaving arguments unpainted", () => {
    const highlighted = highlightLeadingSlashToken("    /goal clear   ", identity);
    assert.equal(highlighted, "    /goal clear   ");
  });

  test("paints a command that runs to the end of the line", () => {
    let painted = "";
    highlightLeadingSlashToken("    /help", (text) => {
      painted = text;
      return text;
    });
    assert.equal(painted, "/help");
  });

  test("paints only the token, not the leading padding", () => {
    let painted = "";
    highlightLeadingSlashToken("    /goal do a thing", (text) => {
      painted = text;
      return text;
    });
    assert.equal(painted, "/goal");
  });
});

// The overlay reserves exactly one column, so whatever this returns must measure
// one cell or Pi's cursor math desynchronises.
describe("resolvePromptMarker", () => {
  test("falls back to the default when unset or empty", () => {
    assert.equal(resolvePromptMarker(undefined), ">");
    assert.equal(resolvePromptMarker(""), ">");
  });

  test("passes through an ordinary single-cell glyph", () => {
    assert.equal(resolvePromptMarker(">"), ">");
    assert.equal(resolvePromptMarker("›"), "›");
    assert.equal(resolvePromptMarker("❯"), "❯");
  });

  test("honours only the leading glyph of a longer override", () => {
    assert.equal(resolvePromptMarker("❯❯❯"), "❯");
  });

  test("does not split a non-BMP glyph into a lone surrogate", () => {
    assert.equal(resolvePromptMarker("\u{1D11E}"), "\u{1D11E}");
  });

  test("falls back for a double-width glyph, which would claim two columns", () => {
    assert.equal(resolvePromptMarker("中"), ">");
    assert.equal(resolvePromptMarker("\u{1F537}"), ">");
  });

  // A combining mark belongs to the glyph it modifies; splitting by code point
  // would silently hand back the unaccented base letter.
  test("keeps a combining mark attached to its base", () => {
    assert.equal(resolvePromptMarker("é"), "é");
    assert.equal(resolvePromptMarker("éx"), "é");
  });

  // An emoji-presentation selector widens the cluster to two cells, but the
  // base glyph still fits one column, so it beats dropping to the default.
  test("recovers the base glyph behind a variation selector", () => {
    assert.equal(resolvePromptMarker("✔️"), "✔");
    assert.equal(resolvePromptMarker("⚠️"), "⚠");
  });

  test("falls back for a ZWJ sequence, which has no single-cell base", () => {
    assert.equal(resolvePromptMarker("\u{1F469}‍\u{1F4BB}"), ">");
  });
});
