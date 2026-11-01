import assert from "node:assert/strict";
import { test } from "vitest";
import { displayPosition, resolvePosition } from "../src/positions.js";
import { findInvalidTextEditRange, flattenWorkspaceEdit } from "../src/text-edits.js";

const text = "package main\n\nfunc width(id int) int { return id + width(id) }\n";

test("symbol positions convert a 1-based line to the 0-based start of the identifier", () => {
  assert.deepEqual(resolvePosition(text, { line: 3, symbol: "width" }, "main.go"), { line: 2, character: 5 });
  // `id` must not match inside `width`; #N picks later matches on the same line.
  assert.deepEqual(resolvePosition(text, { line: 3, symbol: "id" }, "main.go"), { line: 2, character: 11 });
  assert.deepEqual(resolvePosition(text, { line: 3, symbol: "id#2" }, "main.go"), { line: 2, character: 32 });
  assert.deepEqual(resolvePosition(text, { line: 3, symbol: "width#2" }, "main.go"), { line: 2, character: 37 });
  // A leading non-identifier character needs no boundary before it.
  assert.deepEqual(resolvePosition("this.#count += #count;", { line: 1, symbol: "#count#2" }, "a.ts"), {
    line: 0,
    character: 15,
  });
});

test("symbol boundaries inspect Unicode code points and identifier continuations, retaining UTF-16 offsets", () => {
  for (const longer of ["𐐀id", "id𐐀", "id\u0301", "\u0301id", "id\u200c"]) {
    const source = `const ${longer} = 1; const id = 2; id;`;
    assert.equal(resolvePosition(source, { line: 1, symbol: "id" }, "a.ts").character, source.indexOf("id = 2"));
    assert.equal(resolvePosition(source, { line: 1, symbol: "id#2" }, "a.ts").character, source.lastIndexOf("id"));
  }
  for (const symbol of ["𐐀id", "id𐐀", "id\u0301"]) {
    const source = `x${symbol} ${symbol}x ${symbol} ${symbol}`;
    assert.equal(
      resolvePosition(source, { line: 1, symbol }, "a.ts").character,
      source.lastIndexOf(symbol) - symbol.length - 1,
    );
    assert.equal(
      resolvePosition(source, { line: 1, symbol: `${symbol}#2` }, "a.ts").character,
      source.lastIndexOf(symbol),
    );
  }
});

test("columns are 1-based UTF-16 code units, matching LSP positions and diagnostics output", () => {
  const emoji = 'const label = "😀"; render(label);\r\nnext\n';
  // The emoji is one character but two UTF-16 code units, so `render` starts at index 20.
  assert.equal(emoji.indexOf("render"), 20);
  assert.deepEqual(resolvePosition(emoji, { line: 1, symbol: "render" }, "a.ts"), { line: 0, character: 20 });
  assert.deepEqual(resolvePosition(emoji, { line: 1, column: 21 }, "a.ts"), {
    line: 0,
    character: 20,
  });
  assert.equal(displayPosition({ line: 0, character: 20 }), "1:21");
  assert.throws(
    () => resolvePosition(emoji, { line: 1, column: 17 }, "a.ts"),
    /column 17 splits a surrogate pair on line 1; use column 16/,
  );
  // A CRLF line ending is not part of the line; the end-of-line column is allowed.
  assert.deepEqual(resolvePosition(emoji, { line: 1, column: 35 }, "a.ts"), {
    line: 0,
    character: 34,
  });
  assert.throws(() => resolvePosition(emoji, { line: 1, column: 36 }, "a.ts"), /past the end of line 1 \(length 34\)/);
  assert.deepEqual(resolvePosition(emoji, { line: 3, column: 1 }, "a.ts"), {
    line: 2,
    character: 0,
  });
});

test("position arguments are validated with actionable messages", () => {
  const cases: Array<[Parameters<typeof resolvePosition>[1], RegExp]> = [
    [{ line: 0, symbol: "width" }, /line must be a positive integer \(1-based\); got 0/],
    [{ line: 1.5, symbol: "width" }, /line must be a positive integer/],
    [{ line: 9, symbol: "width" }, /line 9 is past the end of main.go \(4 line\(s\)\)/],
    [{ line: 3 }, /Pass symbol \(an identifier on line 3\) or a 1-based column/],
    [{ line: 3, symbol: "width", column: 6 }, /either symbol or column, not both/],
    [{ line: 3, column: 0 }, /column must be a positive integer \(1-based UTF-16 code units\); got 0/],
    [{ line: 3, symbol: " " }, /symbol must not be blank/],
    [{ line: 3, symbol: "height" }, /Symbol "height" was not found on line 3 of main.go: "func width/],
    [{ line: 3, symbol: "width#3" }, /occurrence 3 is out of range on line 3 \(found 2\)/],
    [{ line: 3, symbol: "width#0" }, /occurrence must be 1 or greater; got 0/],
  ];
  for (const [input, expected] of cases) {
    assert.throws(() => resolvePosition(text, input, "main.go"), expected, JSON.stringify(input));
  }
});

test("edit ranges must exist in the snapshot they will be applied to", () => {
  const edit = (line: number, character: number, endLine = line, endCharacter = character) => ({
    range: {
      start: { line, character },
      end: { line: endLine, character: endCharacter },
    },
    newText: "x",
  });
  const source = "ab\ncd";
  assert.equal(findInvalidTextEditRange(source, [edit(0, 0, 0, 2), edit(1, 2)]), undefined);
  // {lineCount, 0} is the conventional end-of-document position; nothing lies beyond it.
  assert.equal(findInvalidTextEditRange(source, [edit(2, 0)]), undefined);
  assert.equal(findInvalidTextEditRange(source, [edit(2, 1)]), "3:2-3:2");
  assert.equal(findInvalidTextEditRange(source, [edit(3, 0)]), "4:1-4:1");
  assert.equal(findInvalidTextEditRange(source, [edit(0, 3)]), "1:4-1:4");
  assert.equal(findInvalidTextEditRange(source, [edit(1, 1, 0, 1)]), "2:2-1:2");
  assert.equal(findInvalidTextEditRange(`${source}\n`, [edit(2, 0)]), undefined);
});

test("workspace edits are validated, grouped by URI, and resource operations reported", () => {
  const edit = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    newText: "x",
  };
  assert.deepEqual(flattenWorkspaceEdit(null), {
    files: [],
    resourceOperations: [],
  });
  assert.deepEqual(flattenWorkspaceEdit({ changes: { "file:///a.go": [edit] } }), {
    files: [{ uri: "file:///a.go", edits: [edit] }],
    resourceOperations: [],
  });
  // documentChanges takes precedence over changes, and repeated URIs merge in order.
  const second = { ...edit, newText: "y" };
  assert.deepEqual(
    flattenWorkspaceEdit({
      changes: { "file:///ignored.go": [edit] },
      documentChanges: [
        { textDocument: { uri: "file:///a.go", version: 1 }, edits: [edit] },
        { kind: "rename", oldUri: "file:///a.go", newUri: "file:///b.go" },
        { textDocument: { uri: "file:///a.go", version: 1 }, edits: [second] },
        { kind: "delete", uri: "file:///c.go" },
      ],
    }),
    {
      files: [{ uri: "file:///a.go", edits: [edit, second] }],
      resourceOperations: [
        { kind: "rename", uris: ["file:///a.go", "file:///b.go"] },
        { kind: "delete", uris: ["file:///c.go"] },
      ],
    },
  );
  for (const malformed of [
    "edit",
    { changes: [] },
    { changes: { "file:///a.go": [{ newText: "x" }] } },
    {
      changes: {
        "file:///a.go": [
          {
            ...edit,
            range: { start: { line: -1, character: 0 }, end: edit.range.end },
          },
        ],
      },
    },
    { documentChanges: [null] },
    { documentChanges: [{ textDocument: {}, edits: [edit] }] },
  ]) {
    assert.throws(() => flattenWorkspaceEdit(malformed), /malformed WorkspaceEdit/, JSON.stringify(malformed));
  }
});
