import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, type Focusable, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { RecallMessageRecord } from "../src/messages.js";
import { ScopedRecallPicker, sanitizeTerminalText } from "../src/picker.js";

const ESCAPE = String.fromCharCode(0x1b);
const BELL = String.fromCharCode(0x07);
const CSI = String.fromCharCode(0x9b);
const ST = String.fromCharCode(0x9c);
const OSC = String.fromCharCode(0x9d);
const DCS = String.fromCharCode(0x90);
const PM = String.fromCharCode(0x9e);
const APC = String.fromCharCode(0x9f);
const SOS = String.fromCharCode(0x98);
const RLO = String.fromCodePoint(0x202e);
const BIDI_CODE_POINTS = [
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
];

function saved(id: string, sessionId: string, cwd: string, text: string): RecallMessageRecord {
  return {
    type: "recall_message",
    version: 1,
    id,
    savedAt: "2026-08-04T12:00:00.000Z",
    source: {
      sessionId,
      entryId: `entry-${id}`,
      sessionName: `Session ${sessionId}`,
      cwd,
      messageTimestamp: Date.parse("2026-08-04T11:00:00.000Z"),
    },
    role: id === "one" ? "user" : "assistant",
    text,
  };
}

function createPicker(
  records: RecallMessageRecord[],
  options: {
    initialScope?: "all" | "cwd" | "session";
    initialSelectedId?: string;
    initialQuery?: string;
    rows?: number;
  } = {},
) {
  let result: unknown;
  let renders = 0;
  const picker = new ScopedRecallPicker({
    tui: {
      terminal: { rows: options.rows ?? 12 },
      requestRender: () => renders++,
    } as never,
    theme: {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    keybindings: {
      matches(data: string, key: string) {
        return (
          (data === "up" && key === "tui.select.up") ||
          (data === "down" && key === "tui.select.down") ||
          (data === "enter" && key === "tui.select.confirm") ||
          (data === "escape" && key === "tui.select.cancel") ||
          (data === "\u0004" && key === "app.session.delete")
        );
      },
      getKeys: (key: string) => (key === "app.session.delete" ? ["ctrl+d"] : []),
    } as never,
    records,
    current: { sessionId: "current", cwd: "/work/project" },
    initialScope: options.initialScope ?? "cwd",
    initialSelectedId: options.initialSelectedId,
    initialQuery: options.initialQuery,
    complete: (value) => {
      result = value;
    },
  });
  return { picker, result: () => result, renders: () => renders };
}

test("defaults to Current cwd and cycles scope forward and backward with visible counts", () => {
  const { picker, renders } = createPicker([
    saved("one", "current", "/work/project", "one"),
    saved("two", "other", "/work/project", "two"),
    saved("three", "elsewhere", "/other", "three"),
  ]);
  assert.match(picker.render(80).join("\n"), /Scope: Current cwd \(2\).*Tab change scope/);
  picker.handleInput("\t");
  assert.match(picker.render(80).join("\n"), /Scope: All \(3\)/);
  picker.handleInput("\t");
  assert.match(picker.render(80).join("\n"), /Scope: Current session \(1\)/);
  picker.handleInput("\u001b[Z");
  assert.match(picker.render(80).join("\n"), /Scope: All \(3\)/);
  assert.equal(renders(), 3);
});

test("preserves a selected saved id across scope changes when still visible", () => {
  const { picker, result } = createPicker([
    saved("one", "current", "/work/project", "one"),
    saved("two", "other", "/work/project", "two"),
    saved("three", "elsewhere", "/other", "three"),
  ]);
  picker.handleInput("down");
  picker.handleInput("\t");
  picker.handleInput("enter");
  assert.deepEqual(result(), {
    kind: "selected",
    recordId: "one",
    scope: "all",
    query: "",
  });
});

test("falls back to the first newest record when selection leaves the scope", () => {
  const { picker, result } = createPicker([
    saved("one", "current", "/work/project", "one"),
    saved("two", "other", "/work/project", "two"),
    saved("three", "elsewhere", "/other", "three"),
  ]);
  picker.handleInput("\t");
  picker.handleInput("\t");
  picker.handleInput("enter");
  assert.deepEqual(result(), {
    kind: "selected",
    recordId: "one",
    scope: "session",
    query: "",
  });
});

test("escape returns to the menu while ctrl+c closes the whole Recall flow", () => {
  const records = [saved("one", "current", "/work/project", "one")];
  const back = createPicker(records);
  back.picker.handleInput("escape");
  assert.deepEqual(back.result(), {
    kind: "back",
    scope: "cwd",
    selectedId: "one",
    query: "",
  });
  const close = createPicker(records);
  close.picker.handleInput("\u0003");
  assert.deepEqual(close.result(), {
    kind: "close",
    scope: "cwd",
    selectedId: "one",
    query: "",
  });
});

test("empty scopes remain switchable and rendered output is sanitized and width-safe", () => {
  const { picker } = createPicker([
    saved("unsafe", "other", "/other", "unsafe\u001b]8;;https://bad\u0007link\u001b[31m"),
  ]);
  const empty = picker.render(24);
  assert.match(empty.join("\n"), /No saved messages/);
  picker.handleInput("\t");
  const all = picker.render(24);
  assert.ok(all.every((line) => visibleWidth(line) <= 24));
  const rendered = all.join("\n");
  assert.equal(rendered.includes("\u001b]"), false);
  assert.equal(rendered.includes("\u001b[31m"), false);
  assert.equal(rendered.includes("https://bad"), false);
  picker.dispose();
  picker.handleInput("\t");
  assert.match(picker.render(24).join("\n"), /Scope: All \(1\)/);
});

test("fuzzy-searches message text, role, and session name with relevance ordering", () => {
  const direct = saved("one", "current", "/work/project", "alpha release");
  direct.source.sessionName = "Planning Room";
  const later = saved("two", "other", "/work/project", "prefix alpha notes");
  later.source.sessionName = "Other Room";

  const content = createPicker([direct, later]);
  assert.ok(
    content.picker.render(100).join("\n").indexOf("prefix alpha") <
      content.picker.render(100).join("\n").indexOf("alpha release"),
  );
  content.picker.handleInput("alpha");
  const ranked = content.picker.render(100).join("\n");
  assert.ok(ranked.indexOf("alpha release") < ranked.indexOf("prefix alpha"));

  const role = createPicker([direct, later]);
  role.picker.handleInput("user");
  assert.match(role.picker.render(100).join("\n"), /alpha release/);
  assert.doesNotMatch(role.picker.render(100).join("\n"), /prefix alpha/);

  const session = createPicker([direct, later]);
  session.picker.handleInput("plnng room");
  assert.match(session.picker.render(100).join("\n"), /Planning Room/);
  assert.doesNotMatch(session.picker.render(100).join("\n"), /Other Room/);

  const hiddenMetadata = createPicker([direct, later]);
  hiddenMetadata.picker.handleInput("work project");
  assert.match(hiddenMetadata.picker.render(100).join("\n"), /No matching saved messages/);
});

test("applies scope before search and distinguishes totals, matches, and empty states", () => {
  const noMatch = createPicker([
    saved("one", "current", "/work/project", "local note"),
    saved("two", "other", "/other", "remote needle"),
  ]);
  noMatch.picker.handleInput("needle");
  let rendered = noMatch.picker.render(80).join("\n");
  assert.match(rendered, /Scope: Current cwd \(1\).*0 matches/);
  assert.match(rendered, /No matching saved messages/);
  noMatch.picker.handleInput("enter");
  assert.equal(noMatch.result(), undefined);
  noMatch.picker.handleInput("\t");
  rendered = noMatch.picker.render(80).join("\n");
  assert.match(rendered, /Scope: All \(2\).*1 match/);
  assert.match(rendered, /remote needle/);

  const empty = createPicker([saved("three", "other", "/other", "elsewhere")]);
  assert.match(empty.picker.render(80).join("\n"), /No saved messages in this scope/);
});

test("preserves query spaces, removes pasted controls, bounds queries, and forwards focus", () => {
  const record = saved("one", "current", "/work/project", "bar foo 📖");
  const { picker } = createPicker([record]);
  const focusable = picker as ScopedRecallPicker & Focusable;
  focusable.focused = true;
  assert.equal(picker.render(80).join("\n").includes(CURSOR_MARKER), true);
  focusable.focused = false;
  picker.handleInput("\u001b[200~foo \u0007\u009dbar\u009c\u001b[201~");
  const rendered = picker.render(80).join("\n");
  assert.match(rendered, /bar foo/);
  assert.equal(rendered.includes("\u0007"), false);
  assert.equal(rendered.includes("\u009d"), false);
  assert.equal(rendered.includes("\u009c"), false);
  for (const width of [1, 2, 8, 20, 80]) {
    assert.ok(picker.render(width).every((line) => visibleWidth(line) <= width));
  }

  const overlong = createPicker([record]);
  overlong.picker.handleInput("a".repeat(257));
  assert.match(overlong.picker.render(80).join("\n"), /Search query is too long.*256/);
  assert.match(overlong.picker.render(80).join("\n"), /No matching saved messages/);

  const beforeDispose = picker.render(80);
  picker.dispose();
  assert.equal(picker.render(80).join("\n").includes(CURSOR_MARKER), false);
  picker.handleInput("ignored");
  assert.deepEqual(picker.render(80), beforeDispose);
});

test("requests direct deletion with the selected record and nearest surviving result", () => {
  const content = createPicker([
    saved("one", "current", "/work/project", "first saved message"),
    saved("two", "current", "/work/project", "second saved message"),
  ]);
  content.picker.handleInput("down");
  assert.match(content.picker.render(20).join("\n"), /ctrl\+d delete/i);
  content.picker.handleInput("\u0004");
  assert.deepEqual(content.result(), {
    kind: "delete",
    recordId: "one",
    nextSelectedId: "two",
    scope: "cwd",
    query: "",
  });
});

test("does not request deletion without a match and leaves plain Delete to search input", () => {
  const noMatch = createPicker([saved("one", "current", "/work/project", "alpha")], {
    initialQuery: "zulu",
  });
  noMatch.picker.handleInput("\u0004");
  assert.equal(noMatch.result(), undefined);

  const editing = createPicker([saved("one", "current", "/work/project", "alpha")]);
  editing.picker.handleInput("\u001b[3~");
  assert.equal(editing.result(), undefined);
});

test("restores selection after broadening and carries query through scope and completion", () => {
  const records = [saved("one", "current", "/work/project", "alpha"), saved("two", "other", "/work/project", "zulu")];
  const restored = createPicker(records, { initialSelectedId: "one" });
  restored.picker.handleInput("z");
  restored.picker.handleInput("\u007f");
  restored.picker.handleInput("enter");
  assert.deepEqual(restored.result(), {
    kind: "selected",
    recordId: "one",
    scope: "cwd",
    query: "",
  });

  const carried = createPicker(records, { initialQuery: "alpha" });
  assert.match(stripVTControlCharacters(carried.picker.render(80).join("\n")), /Search: .*alpha/);
  carried.picker.handleInput("\t");
  carried.picker.handleInput("enter");
  assert.deepEqual(carried.result(), {
    kind: "selected",
    recordId: "one",
    scope: "all",
    query: "alpha",
  });
});

test("sanitizes terminal escapes, payload-bearing sequences, and bidi overrides in recalled text", () => {
  assert.equal(sanitizeTerminalText(`note${ESCAPE}[31mred${ESCAPE}[0m`), "notered");
  assert.equal(sanitizeTerminalText(`note${CSI}31mred`), "notered");
  assert.equal(sanitizeTerminalText(`a${ESCAPE}]8;;https://bad${BELL}link`), "alink");
  assert.equal(sanitizeTerminalText(`a${OSC}8;;https://bad${ST}link`), "alink");
  assert.equal(sanitizeTerminalText(`head${ESCAPE}P1;2payload${ESCAPE}\\tail`), "headtail");
  assert.equal(sanitizeTerminalText(`head${DCS}1;2payload${ST}tail`), "headtail");
  assert.equal(sanitizeTerminalText(`head${ESCAPE}_apc payload${ESCAPE}\\tail`), "headtail");
  assert.equal(sanitizeTerminalText(`head${APC}apc payload${ST}tail`), "headtail");
  assert.equal(sanitizeTerminalText(`head${ESCAPE}^pm payload${ST}tail`), "headtail");
  assert.equal(sanitizeTerminalText(`head${PM}pm payload${ST}tail`), "headtail");
  assert.equal(sanitizeTerminalText(`head${ESCAPE}Xsos payload${ST}tail`), "headtail");
  assert.equal(sanitizeTerminalText(`head${SOS}sos payload${ST}tail`), "headtail");
  for (const codePoint of BIDI_CODE_POINTS) {
    const sanitized = sanitizeTerminalText(`rm ${String.fromCodePoint(codePoint)}fdp.txt`);
    assert.equal(sanitized, "rm fdp.txt", codePoint.toString(16));
  }
});

test("sanitizing recalled text steps by code point so astral characters survive intact", () => {
  const book = String.fromCodePoint(0x1f4d6);
  const rocket = String.fromCodePoint(0x1f680);
  assert.equal(sanitizeTerminalText(`${book}${RLO}${rocket}`), `${book} ${rocket}`);
  assert.equal(sanitizeTerminalText(`${book}${ESCAPE}[31m${rocket}`), `${book}${rocket}`);
  assert.equal([...sanitizeTerminalText(`${book}${rocket}`)].length, 2);
});

test("bidi overrides pasted into the search query are removed before matching", () => {
  const { picker } = createPicker([saved("one", "current", "/work/project", "alpha")]);
  picker.handleInput(`${RLO}alpha`);
  const rendered = stripVTControlCharacters(picker.render(80).join("\n"));
  assert.equal(rendered.includes(RLO), false);
  assert.match(rendered, /alpha/);
});

test("an unterminated introducer never truncates a preview or the searchable text", () => {
  // Regression: scanning to end-of-string made one byte hide the tail of a saved message from both
  // the picker row and the fuzzy filter, and the code-point filter already made that tail inert.
  const text = `Here is the plan:${DCS} step one, step two, and the important secret detail.`;
  const { picker } = createPicker([saved("one", "current", "/work/project", text)]);
  const rendered = stripVTControlCharacters(picker.render(200).join("\n"));
  assert.match(rendered, /important secret detail/u);

  const filtered = createPicker([saved("one", "current", "/work/project", text)], {
    initialQuery: "secret detail",
  });
  assert.match(stripVTControlCharacters(filtered.picker.render(200).join("\n")), /1 match/u);
  for (const introducer of [DCS, OSC, PM, APC, SOS]) {
    assert.equal(
      sanitizeTerminalText(`release-2.1${introducer}-hotfix`),
      "release-2.1-hotfix",
      introducer.codePointAt(0)?.toString(16),
    );
  }
  assert.equal(sanitizeTerminalText(`release-2.1${CSI}`), "release-2.1");
});

test("previews are sanitized before truncation so the budget buys visible characters", () => {
  const text = `${`${ESCAPE}[1;32m`.repeat(15)}REAL MESSAGE CONTENT`;
  const { picker } = createPicker([saved("one", "current", "/work/project", text)]);
  const rendered = stripVTControlCharacters(picker.render(200).join("\n"));
  assert.match(rendered, /REAL MESSAGE CONTENT/u);
});
