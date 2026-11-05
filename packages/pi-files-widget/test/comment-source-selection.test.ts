import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatCommentMessage } from "../comment.js";
import * as fileViewer from "../file-viewer.js";
import { type CommentPayload, createViewer } from "../viewer.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[0m`,
  bold: (text: string) => text,
};

function fixture(source: string, rendered: fileViewer.LoadedFileContent, gitStatus?: string, name = "file.ts") {
  const root = mkdtempSync(join(tmpdir(), "comment-source-"));
  const path = join(root, name);
  writeFileSync(path, source);
  const loader = spyOn(fileViewer, "loadFileContent").mockReturnValue(rendered);
  const comments: CommentPayload[] = [];
  const messages: string[] = [];
  const viewer = createViewer({ getRoot: () => root, projectCwd: root }, theme as never, (payload, comment) => {
    comments.push(payload);
    messages.push(formatCommentMessage(payload, comment));
  });
  viewer.setFile({ name, path, isDirectory: false, gitStatus });
  return {
    path,
    viewer,
    loader,
    comments,
    messages,
    dispose() {
      loader.mockRestore();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function sendComment(viewer: ReturnType<typeof createViewer>): void {
  viewer.handleInput("c");
  viewer.handleInput("Explain this selection");
  viewer.handleInput("\x04"); // Ctrl+D
}

function selectedRows(rows: string[]): string[] {
  return rows.filter((row) => row.startsWith("\x1b[44m"));
}

test("confirmed search advances and wraps; Escape cancels without closing or retaining matches", () => {
  const source = Array.from({ length: 70 }, (_, i) => (i % 25 === 0 ? `needle ${i}` : `row ${i}`));
  const f = fixture(source.join("\n"), { lines: source, renderedMarkdown: false });
  try {
    f.viewer.render(80);
    f.viewer.handleInput("/");
    f.viewer.handleInput("needle");
    f.viewer.handleInput("\r");
    assert.match(f.viewer.render(80)[0], /\[1\/3\]/);
    f.viewer.handleInput("n");
    assert.match(f.viewer.render(80)[0], /\[2\/3\]/);
    assert.ok(f.viewer.render(80).some((line) => line.includes("needle 25")));
    f.viewer.handleInput("n");
    assert.match(f.viewer.render(80)[0], /\[3\/3\]/);
    f.viewer.handleInput("n");
    assert.match(f.viewer.render(80)[0], /\[1\/3\]/);
    f.viewer.handleInput("N");
    assert.match(f.viewer.render(80)[0], /\[3\/3\]/);
    assert.deepEqual(f.viewer.handleInput("\x1b"), { type: "none" });
    assert.equal(f.viewer.isOpen(), true);
    const cleared = f.viewer.render(80);
    f.viewer.handleInput("n");
    assert.deepEqual(f.viewer.render(80), cleared);
    f.viewer.handleInput("/");
    f.viewer.handleInput("needle");
    f.viewer.handleInput("\x1b");
    assert.doesNotMatch(f.viewer.render(80)[0], /\[\d\/3\]|needle/);
  } finally {
    f.dispose();
  }
});

test("confirmed search uses source-to-row alignment after a 60-row first line, n/N, and resize", () => {
  const source = Array.from({ length: 80 }, (_, i) =>
    i === 0 ? "long first source ".repeat(160) : i === 25 || i === 50 ? `needle source ${i + 1}` : `source ${i + 1}`,
  );
  const f = fixture(source.join("\n"), { lines: [], renderedMarkdown: false });
  f.loader.mockImplementation((_path, _cwd, _diff, _changes, width) => ({
    lines: source.flatMap((line, i) =>
      wrapTextWithAnsi(line, Math.max(1, (width ?? 80) - 7)).map(
        (row, j) => `${j === 0 ? String(i + 1).padStart(4) : "    "} │ ${row}`,
      ),
    ),
    renderedMarkdown: false,
  }));
  try {
    const ordinary = f.viewer.render(40);
    f.viewer.handleInput("/");
    f.viewer.handleInput("need");
    assert.match(f.viewer.render(55)[0], /\/need█/);
    f.viewer.handleInput("le");
    f.viewer.handleInput("\r");
    for (const [input, match, count, width] of [
      ["", "needle source 26", "1/2", 40],
      ["n", "needle source 51", "2/2", 40],
      ["N", "needle source 26", "1/2", 60],
      ["n", "needle source 51", "2/2", 30],
      ["n", "needle source 26", "1/2", 50],
    ] as const) {
      if (input) f.viewer.handleInput(input);
      const rows = f.viewer.render(width);
      assert.ok(
        rows.some((line) => line.includes(match)),
        `exact active match visible: ${match} at ${width}`,
      );
      if (width >= 40) assert.ok(rows[0].includes(`[${count}]`));
      assert.ok(rows.every((line) => visibleWidth(line) <= width));
    }
    f.viewer.handleInput("\x1b");
    f.viewer.handleInput("g");
    assert.deepEqual(f.viewer.render(40), ordinary, "clearing search restores ordinary wrapping/formatter");
    f.viewer.handleInput("v");
    sendComment(f.viewer);
    assert.equal(f.comments[0].selectedText, source[0], "search never rewrites source or selection payload");
  } finally {
    f.dispose();
  }
});

for (const change of ["file", "close", "diff", "markdown", "select"] as const) {
  test(`confirmed search is cleared by incompatible ${change} transition`, () => {
    const source = "needle\nplain\nneedle";
    const f = fixture(source, { lines: source.split("\n"), renderedMarkdown: false }, "M", "file.md");
    try {
      f.viewer.render(80);
      f.viewer.handleInput("d"); // Search raw source, not the initial diff.
      f.viewer.render(80);
      f.viewer.handleInput("/");
      f.viewer.handleInput("needle");
      f.viewer.handleInput("\r");
      assert.match(f.viewer.render(80)[0], /\[1\/2\]/);
      if (change === "close") f.viewer.close();
      if (change === "file" || change === "close") {
        f.viewer.setFile({ name: "file.md", path: f.path, isDirectory: false });
      } else {
        f.viewer.handleInput(change === "diff" ? "d" : change === "markdown" ? "m" : "v");
      }
      assert.doesNotMatch(f.viewer.render(80)[0], /\[\d\/2\]/);
      assert.deepEqual(f.comments, []);
    } finally {
      f.dispose();
    }
  });
}

test("default diff near line 90 cannot emit a comment on unrelated early source", () => {
  const source = Array.from({ length: 100 }, (_, i) => `source line ${i + 1}`);
  source[0] = "private early source must not be sent";
  source[89] = "changed source line 90";
  const diff = [
    "@@ -80,21 +80,21 @@",
    ...source.slice(79, 89).map((line) => ` ${line}`),
    "-source line 90",
    "+changed source line 90",
    ...source.slice(90).map((line) => ` ${line}`),
  ];
  const f = fixture(source.join("\n"), { lines: diff, renderedMarkdown: false }, " M");
  try {
    const before = f.viewer.render(100);
    assert.match(before[0], /\[DIFF\]/);
    assert.ok(before.some((row) => row.includes("+changed source line 90")));
    assert.ok(before.some((row) => row.includes("Selection/comments disabled in diff; press d for raw source.")));
    assert.equal(f.loader.mock.calls[0][2], true);
    for (let attempt = 0; attempt < 2; attempt++) {
      f.viewer.handleInput("v");
      sendComment(f.viewer);
    }
    assert.deepEqual(f.comments, []);
    assert.deepEqual(f.messages, []);
    assert.deepEqual(f.viewer.render(100), before);
    f.viewer.handleInput("j");
    assert.equal(f.viewer.render(100)[2], diff[1]); // Ordinary diff navigation is unchanged.

    f.viewer.handleInput("d");
    f.viewer.render(100);
    assert.equal(f.loader.mock.calls.at(-1)?.[2], false);
    f.viewer.handleInput("v");
    for (let i = 1; i < 90; i++) f.viewer.handleInput("j");
    assert.match(f.viewer.render(100)[0], /SOURCE SELECT 1-90/);
    f.viewer.handleInput("d"); // Cannot switch to diff while selecting.
    sendComment(f.viewer);
    assert.equal(f.comments[0].lineRange, "lines 1-90");
    assert.equal(f.comments[0].selectedText, source.slice(0, 90).join("\n"));
  } finally {
    f.dispose();
  }
});

for (const longLine of ["long source ".repeat(30), "界🙂e\u0301".repeat(40)]) {
  test(`wrapped ${longLine.startsWith("界") ? "wide Unicode" : "ASCII"} rows select whole source lines, not continuations`, () => {
    const source = [longLine, "next source line", "third source line"];
    const wrapped = wrapTextWithAnsi(longLine, 20).map((row, i) => `${i === 0 ? "   1" : "    "} │ ${row}`);
    const normalRows = [...wrapped, "   2 │ next source line", "   3 │ third source line"];
    const f = fixture(source.join("\n"), { lines: normalRows, renderedMarkdown: false });
    try {
      assert.equal(f.viewer.render(30)[2], normalRows[0]);
      for (let i = 0; i < 4; i++) f.viewer.handleInput("j"); // A bat continuation, not source line 5.
      f.viewer.handleInput("v");
      let rows = f.viewer.render(30);
      assert.match(rows[0], /SOURCE SELECT 1-1/);
      assert.equal(selectedRows(rows).length, 1);
      assert.ok(selectedRows(rows)[0].includes("   1 │ "));
      assert.ok(rows[3].includes("   2 │ next source line"));
      assert.ok(rows[4].includes("   3 │ third source line"));
      assert.ok(rows.every((row) => visibleWidth(row) <= 30));
      sendComment(f.viewer);
      assert.equal(f.comments[0].lineRange, "line 1");
      assert.equal(f.comments[0].selectedText, longLine); // Entire source line, including clipped text.
      assert.ok(f.messages[0].includes(longLine));
      rows = f.viewer.render(30);
      assert.ok(!rows[0].includes("SOURCE SELECT"));
      assert.equal(rows[2], normalRows[0]); // Ordinary wrapped view is restored.

      f.viewer.handleInput("v");
      f.viewer.handleInput("j");
      rows = f.viewer.render(50);
      assert.match(rows[0], /SOURCE SELECT 1-2/);
      assert.equal(selectedRows(rows).length, 2);
      assert.ok(selectedRows(rows)[1].includes("   2 │ next source line"));
      sendComment(f.viewer);
      assert.equal(f.comments[1].lineRange, "lines 1-2");
      assert.equal(f.comments[1].selectedText, source.slice(0, 2).join("\n"));
      assert.ok(!f.messages[1].includes(source[2]));
    } finally {
      f.dispose();
    }
  });
}

test("selection and comment resize keep the displayed snapshot despite disk edits; cancel restores highlighting", () => {
  const f = fixture("original first\noriginal second\nthird", {
    lines: ["\x1b[32m   1 │ original first\x1b[0m", "   2 │ original second"],
    renderedMarkdown: false,
  });
  try {
    const original = f.viewer.render(80);
    f.viewer.handleInput("v");
    f.viewer.handleInput("j");
    writeFileSync(f.path, "replacement secret\nchanged second");
    for (const width of [80, 20, 8, 1]) {
      const rows = f.viewer.render(width);
      assert.ok(rows.every((row) => visibleWidth(row) <= width));
      assert.equal(selectedRows(rows).length, 2);
      assert.ok(!rows.some((row) => row.includes("replacement")));
    }
    f.viewer.handleInput("c");
    f.viewer.handleInput("Explain");
    f.viewer.render(60);
    assert.equal(f.loader.mock.calls.length, 1);
    f.viewer.handleInput("\x04");
    assert.deepEqual(f.comments, [
      { relPath: "file.ts", lineRange: "lines 1-2", ext: "ts", selectedText: "original first\noriginal second" },
    ]);
    assert.ok(!f.messages[0].includes("replacement secret"));
    assert.equal(f.viewer.render(80)[2], original[2]);
    assert.equal(f.loader.mock.calls.length, 2);

    f.viewer.handleInput("v");
    assert.ok(f.viewer.render(80)[2].includes("replacement secret")); // A new selection reads fresh source.
    f.viewer.handleInput("\x1b");
    assert.equal(f.viewer.render(80)[2], original[2]);
    assert.equal(f.comments.length, 1);
  } finally {
    f.dispose();
  }
});

test("rendered Markdown first switches to raw; the next v selects the source, not rendered rows", () => {
  const f = fixture(
    "# Source title\n\nSource paragraph",
    { lines: ["Rendered title"], renderedMarkdown: true },
    undefined,
    "file.md",
  );
  try {
    assert.match(f.viewer.render(80)[0], /\[RENDERED\]/);
    f.loader.mockReturnValue({
      lines: ["   1 │ # Source title", "   2 │ ", "   3 │ Source paragraph"],
      renderedMarkdown: false,
    });
    f.viewer.handleInput("v");
    assert.match(f.viewer.render(80)[0], /\[RAW\]/);
    assert.ok(!f.viewer.render(80)[0].includes("SOURCE SELECT"));
    f.viewer.handleInput("v");
    assert.ok(selectedRows(f.viewer.render(80))[0].includes("   1 │ # Source title"));
    sendComment(f.viewer);
    assert.equal(f.comments[0].selectedText, "# Source title");
    assert.equal(f.comments[0].lineRange, "line 1");
  } finally {
    f.dispose();
  }
});
