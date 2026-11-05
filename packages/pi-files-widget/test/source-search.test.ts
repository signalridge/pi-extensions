import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeDisplayText } from "@signalridge/pi-ui";
import { layoutSearchSource } from "../source-search.js";
import * as utils from "../utils.js";
import { createViewer } from "../viewer.js";

const theme = {
  fg: (_: string, text: string) => text,
  bg: (_: string, text: string) => text,
  bold: (text: string) => text,
};

for (const formatter of ["bat", "bat-retry", "bat-failed", "no-tools", "glow", "delta", "raw-diff"] as const) {
  test(`source search is independent of ${formatter} row structure and restores ordinary presentation`, () => {
    const root = mkdtempSync(join(tmpdir(), "source-search-fallback-"));
    const markdown = formatter === "glow";
    const diff = formatter === "delta" || formatter === "raw-diff";
    const name = markdown ? "file.md" : "file.ts";
    const path = join(root, name);
    const source = Array.from({ length: 80 }, (_, i) =>
      i === 0
        ? `${"long source ".repeat(300)}needle late`
        : i === 25 || i === 50
          ? `needle source ${i + 1}`
          : `source ${i + 1}`,
    ).join("\n");
    writeFileSync(path, source);
    const deps = spyOn(utils, "hasCommand").mockImplementation(
      (command) => formatter !== "no-tools" && (command !== "delta" || formatter === "delta"),
    );
    const exec = spyOn(childProcess, "execFileSync").mockImplementation(((command: string, args: string[]) => {
      if (command === "git")
        return args[0] === "rev-parse" ? "true\n" : "@@ -90 +90 @@\n-formatted old\n+formatted new\n";
      if (command === "glow") return "opaque Markdown rendering\n";
      if (command === "delta") return "opaque delta rendering\n";
      if (command === "bat") {
        if (formatter === "bat-failed" || (formatter === "bat-retry" && args.includes("--wrap=auto")))
          throw new Error("formatter failed");
        return "opaque bat rendering\n999 │ not source alignment\n";
      }
      throw new Error(`unexpected command ${command}`);
    }) as typeof childProcess.execFileSync);
    const viewer = createViewer({ getRoot: () => root, projectCwd: root }, theme as never, () =>
      assert.fail("no comment expected"),
    );
    viewer.setFile({ name, path, isDirectory: false, gitStatus: diff ? "M" : undefined });
    try {
      const ordinary = viewer.render(50);
      if (formatter === "bat-retry") assert.equal(exec.mock.calls.filter(([command]) => command === "bat").length, 2);
      viewer.handleInput("/");
      viewer.handleInput("need");
      assert.match(viewer.render(60)[0], /\/need█/);
      viewer.handleInput("le");
      viewer.handleInput("\r");
      assert.ok(
        viewer.render(50).some((line) => line.includes("needle late")),
        "a match late in a wrapped source line is visible",
      );
      viewer.handleInput("n");
      assert.ok(viewer.render(40).some((line) => line.includes("needle source 26")));
      viewer.handleInput("n");
      assert.ok(viewer.render(60).some((line) => line.includes("needle source 51")));
      viewer.handleInput("N");
      assert.ok(viewer.render(50).some((line) => line.includes("needle source 26")));
      viewer.handleInput("\x1b");
      viewer.handleInput("g");
      const restored = viewer.render(50);
      if (!markdown) assert.deepEqual(restored, ordinary);
      else
        assert.ok(
          restored.some((line) => line.includes("opaque bat rendering")),
          "Markdown search retains its documented switch to raw",
        );
      assert.equal(readFileSync(path, "utf8"), source);
      assert.ok(
        exec.mock.calls.every(([command, args]) => command !== "bat" || args?.includes("--terminal-width=50")),
        "formatter is only used at the real ordinary-view width",
      );
    } finally {
      viewer.close();
      exec.mockRestore();
      deps.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("confirmed viewer search reveals raw occurrences after controls through Enter, n/N, and resize", () => {
  const root = mkdtempSync(join(tmpdir(), "source-search-controls-"));
  const path = join(root, "file.ts");
  const source = [
    `\t${"a".repeat(2000)}unique first`,
    ...Array.from({ length: 30 }, (_, i) => `plain ${i}`),
    `\x1b[31m\x9dtitle\x07\u202e${"İ界🙂e\u0301 ".repeat(150)}unique second`,
    ...Array.from({ length: 30 }, (_, i) => `plain tail ${i}`),
  ].join("\n");
  writeFileSync(path, source);
  const deps = spyOn(utils, "hasCommand").mockReturnValue(true);
  const exec = spyOn(childProcess, "execFileSync").mockImplementation(
    (() => "opaque ordinary formatter\n") as typeof childProcess.execFileSync,
  );
  const comments: string[] = [];
  const viewer = createViewer({ getRoot: () => root, projectCwd: root }, theme as never, (payload) =>
    comments.push(payload.selectedText),
  );
  viewer.setFile({ name: "file.ts", path, isDirectory: false });
  try {
    const ordinary = viewer.render(40);
    viewer.handleInput("/");
    assert.ok(viewer.render(40)[2].includes("\\u0009"), "control is displayed as inert text");
    viewer.handleInput("u"); // The first displayed 'u' is artificial: \\u0009.
    viewer.handleInput("\r");
    for (const [input, occurrence, width] of [
      ["", "unique first", 40],
      ["n", "unique second", 40],
      ["", "unique second", 60],
      ["N", "unique first", 50],
      ["N", "unique second", 35],
      ["n", "unique first", 40],
    ] as const) {
      if (input) viewer.handleInput(input);
      const rows = viewer.render(width);
      const body = rows
        .slice(2, -2)
        .map((row) => row.slice(7))
        .join("");
      assert.ok(body.includes(occurrence), `exact raw occurrence visible: ${occurrence} at ${width}`);
      assert.ok(
        !rows.slice(2, -2).some((row) => row.includes("\x1b") || row.includes("\x9d") || row.includes("\u202e")),
        "source rows contain no active terminal or bidi controls (chrome may use trusted resets)",
      );
      assert.ok(rows.every((row) => visibleWidth(row) <= width));
    }
    viewer.handleInput("\x1b");
    viewer.handleInput("g");
    assert.deepEqual(viewer.render(40), ordinary, "clearing search restores the ordinary formatter");
    viewer.handleInput("v");
    viewer.handleInput("c");
    viewer.handleInput("draft unchanged");
    viewer.render(60);
    assert.ok(viewer.render(40).some((row) => row.includes("draft unchanged")));
    assert.deepEqual(comments, [], "search and resize do not send or mutate comment drafts");
    viewer.handleInput("\x04");
    assert.deepEqual(comments, [source.split("\n")[0]], "comments retain the original source bytes");
    assert.equal(readFileSync(path, "utf8"), source);
  } finally {
    viewer.close();
    exec.mockRestore();
    deps.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [name, prefix, occurrence, query] of [
  ["tab escape artifact", `\t${"a".repeat(2000)}`, "unique", "u"],
  ["multiple controls and ANSI boundary", `\t\x00\x1b[31m\x9dtitle\x07\u202e${"a".repeat(2000)}`, "unique", "u"],
  ["expanded lowercase prefix", `\t${"İ🙂 ".repeat(40)}`, "UNIQUE", "u"],
  ["inside expanded lowercase", `\x1b${"a".repeat(200)}`, "İstanbul", "\u0307s"],
  ["combining grapheme", `\t${"a".repeat(200)}`, "e\u0301x", "\u0301x"],
  ["emoji grapheme", `\x9b${"a".repeat(200)}`, "👩🏽‍💻", "💻"],
  ["contextual lowercase", `\t${"a".repeat(200)}`, "ΟΣ", "ος"],
  ["match at escaped control", "a".repeat(200), "\x1b[31m", "\x1b["],
  ["match after escaped introducer", `${"a".repeat(200)}\x1b`, "[31m", "[31"],
  ["combining after escape", `${"a".repeat(200)}\t`, "\u0301x", "\u0301x"],
] as const) {
  test(`source match offset projects through sanitization: ${name}`, () => {
    const raw = `${prefix}${occurrence} later ${occurrence}`;
    for (const width of [20, 40, 80]) {
      const layout = layoutSearchSource(raw, width, query);
      const row = layout.matchRows[0];
      assert.ok(row > 0, "the first real match is not an escape artifact at row zero");
      const before = layout.lines
        .slice(0, row)
        .map((line) => line.slice(7))
        .join("");
      const through = before + layout.lines[row].slice(7);
      // The first matching code point may lie inside a grapheme (or İ's folded expansion).
      // Its displayed position is inside this row, never a later occurrence or escape artifact.
      const matchInOccurrence = query === "\u0307s" ? 0 : occurrence.toLowerCase().indexOf(query);
      const expectedOffset = sanitizeDisplayText(prefix + occurrence.slice(0, matchInOccurrence)).length;
      assert.ok(before.length <= expectedOffset && expectedOffset < through.length, `${name}: exact mapped row`);
      assert.equal(layout.lines.map((line) => line.slice(7)).join(""), sanitizeDisplayText(raw));
      assert.ok(layout.lines.every((line) => visibleWidth(line) <= width));
      assert.equal(layout.matchRows.filter((match) => match !== undefined).length, 1);
    }
  });
}

for (const query of ["u", "u0009", "\\u001b", "0000"]) {
  test(`source search never matches display-only escape artifact ${JSON.stringify(query)}`, () => {
    assert.deepEqual(layoutSearchSource("\t\x00\x1b[31m plain", 40, query).matchRows, []);
  });
}

test("source mapping preserves graphemes, whitespace, empty lines, and folded offsets", () => {
  const source = `${"界🙂e\u0301 İ ".repeat(50)}needle\n\nneedle second\n`;
  for (const width of [20, 40, 80]) {
    const layout = layoutSearchSource(source, width, "needle");
    for (const index of [0, 2]) {
      const row = layout.matchRows[index];
      assert.ok(
        layout.lines
          .slice(row, row + 2)
          .map((line) => line.slice(7))
          .join("")
          .includes("needle"),
      );
    }
    assert.ok(layout.matchRows[0] > 2);
    assert.ok(layout.lines.every((line) => visibleWidth(line) <= width));
    const text = layout.lines.map((line) => line.slice(7)).join("");
    assert.equal(text, source.replaceAll("\n", ""), "hard wrapping never drops source spaces or graphemes");
    assert.deepEqual(layoutSearchSource(source, width, "absent").matchRows, []);
  }
  const manyLines = [`${"a".repeat(79)}needle`, ...Array<string>(10000).fill("")].join("\n");
  const layout = layoutSearchSource(manyLines, 25, "needle");
  assert.ok(
    layout.lines.every((line) => visibleWidth(line) <= 25),
    "five-digit source gutters consume real content width",
  );
  assert.ok(layout.lines[layout.matchRows[0]].includes("needle"));
});
