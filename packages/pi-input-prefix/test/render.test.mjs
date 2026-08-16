import assert from "node:assert/strict";
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
const stripSgr = (text) => text.replaceAll(/\u001B\[[0-9;]*m/g, "");

const promptLine = "    hello         ";
const withPrompt = injectPromptSymbol(promptLine, ">");
assert.equal(withPrompt, "  > hello         ");
assert.equal(withPrompt.length, promptLine.length);
assert.equal(injectPromptSymbol("  too narrow", ">"), undefined);

const shellLine = "    !git status        ";
const detachedShell = detachLeadingShellBang(shellLine);
assert.equal(detachedShell.line, "    git status         ");
assert.equal(detachedShell.detached, true);
assert.equal(detachedShell.cursorOnPrompt, false);
assert.equal(detachedShell.line.length, shellLine.length);

const cursorShell = detachLeadingShellBang(`    ${HARDWARE_CURSOR_MARKER}\x1b[7m!\x1b[0mgit status        `);
assert.equal(cursorShell.detached, true);
assert.equal(cursorShell.cursorOnPrompt, true);
assert.equal(cursorShell.hardwareCursorMarker, HARDWARE_CURSOR_MARKER);
assert.equal(cursorShell.line, "    git status         ");

const box = wrapWithRoundedBorder(["────────────────────", "    hello           ", "────────────────────"], identity);
assert.deepEqual(box, ["╭──────────────────╮", "│   hello          │", "╰──────────────────╯"]);
assert.ok(box.every((line) => line.length === 20));

const label = " \x1b[1m! shell mode\x1b[0m ";
const shellBox = wrapWithRoundedBorder(
  ["────────────────────", "                    ", "────────────────────"],
  identity,
  { label },
);
assert.equal(stripSgr(shellBox[0]), "╭ ! shell mode ────╮");
assert.equal(stripSgr(shellBox[0]).length, 20);

const magenta = (text) => `\x1b[35m${text}\x1b[39m`;
const coloredBox = wrapWithRoundedBorder([magenta("─").repeat(8), "        ", magenta("─").repeat(8)], magenta);
assert.deepEqual(coloredBox.map(stripSgr), ["╭──────╮", "│      │", "╰──────╯"]);

const themedAccent = (text) => `\x1b[1m${magenta(text)}\x1b[22m`;
const slashWithCursor = `    ${HARDWARE_CURSOR_MARKER}\x1b[7m/\x1b[0mhelp       `;
const highlightedSlash = highlightLeadingSlashToken(slashWithCursor, themedAccent);
assert.notEqual(highlightedSlash, undefined);
assert.equal(stripSgr(highlightedSlash).replaceAll(HARDWARE_CURSOR_MARKER, ""), "    /help       ");
// biome-ignore lint/suspicious/noControlCharactersInRegex: Test asserts ANSI styling output.
assert.match(highlightedSlash, /\x1b\[35m/);
// biome-ignore lint/suspicious/noControlCharactersInRegex: Test asserts ANSI styling output.
assert.match(highlightedSlash, /\x1b\[1m/);
assert.equal(highlightLeadingSlashToken("    path/to/file   ", themedAccent), undefined);

// Prompt glyph resolution. The override is read as a grapheme cluster and must
// measure exactly one cell, otherwise the reserved column desynchronises.
assert.equal(resolvePromptMarker(undefined), ">");
assert.equal(resolvePromptMarker(""), ">");
assert.equal(resolvePromptMarker(">"), ">");
assert.equal(resolvePromptMarker("›"), "›");
assert.equal(resolvePromptMarker("❯"), "❯");
// Only the leading glyph is honoured, so a multi-character override is trimmed.
assert.equal(resolvePromptMarker("❯❯❯"), "❯");
// A non-BMP glyph that occupies one cell must not be split into a surrogate.
assert.equal(resolvePromptMarker("\u{1D11E}"), "\u{1D11E}");
// Double-width glyphs would occupy two columns, so they fall back.
assert.equal(resolvePromptMarker("中"), ">");
assert.equal(resolvePromptMarker("\u{1F537}"), ">");
// A combining mark belongs to the glyph it modifies; splitting by code point
// would silently hand back the unaccented base letter.
assert.equal(resolvePromptMarker("e\u0301"), "e\u0301");
assert.equal(resolvePromptMarker("e\u0301x"), "e\u0301");
// An emoji-presentation selector widens the cluster to two cells; the base glyph
// still fits one column, so it is preferred over dropping to the default.
assert.equal(resolvePromptMarker("\u2714\ufe0f"), "\u2714");
assert.equal(resolvePromptMarker("\u26a0\ufe0f"), "\u26a0");
// A ZWJ sequence has no single-cell base glyph, so it falls back.
assert.equal(resolvePromptMarker("\u{1F469}\u200d\u{1F4BB}"), ">");

console.log("test_pi_theme_following_editor: OK");
