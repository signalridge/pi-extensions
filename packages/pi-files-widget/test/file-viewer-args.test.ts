import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import {
  batArgs,
  deltaArgs,
  gitDiffArgs,
  glowArgs,
  loadFileContent,
  wrapDeltaLines,
  wrapDiffLines,
} from "../file-viewer.ts";
import { initRepo, skipWithoutGit as skip } from "./git-fixture.ts";

/**
 * Paths come from `git ls-files`/`git status`, so a cloned repository controls
 * them. These are the shapes that used to reach `/bin/sh` through a
 * double-quoted interpolation: `$(...)` and backticks were substituted, and an
 * embedded `"` closed the quoting outright.
 */
const HOSTILE_PATHS = ['a"b.txt', "report$(id).md", "-dashfile", "back`id`tick.md", "back\\slash.md", "spa ced.md"];

test("gitDiffArgs keeps the path as a single verbatim argv element", () => {
  for (const path of HOSTILE_PATHS) {
    for (const scope of ["worktree", "staged", "head"] as const) {
      const args = gitDiffArgs(path, scope);
      assert.equal(args.at(-1), path, `path must survive verbatim for scope ${scope}`);
      assert.equal(args.filter((arg) => arg === path).length, 1);
      assert.equal(args.at(-2), "--", "the path must sit behind git's end-of-options marker");
    }
  }
});

test("gitDiffArgs encodes the three diff scopes", () => {
  const cases: Array<[Parameters<typeof gitDiffArgs>[1], string[]]> = [
    ["worktree", ["diff", "--no-color", "--no-ext-diff", "--", "f.txt"]],
    ["staged", ["diff", "--no-color", "--no-ext-diff", "--cached", "--", "f.txt"]],
    ["head", ["diff", "--no-color", "--no-ext-diff", "HEAD", "--", "f.txt"]],
  ];
  for (const [scope, expected] of cases) {
    assert.deepEqual(gitDiffArgs("f.txt", scope), expected);
  }
});

test("glowArgs keeps the path verbatim and passes width as its own argument", () => {
  for (const path of HOSTILE_PATHS) {
    const args = glowArgs(path, 120);
    assert.equal(args.at(-1), path);
    assert.equal(args.at(-2), "--");
    assert.deepEqual(args.slice(0, 4), ["-s", "dark", "-w", "120"]);
  }
});

test("batArgs preserves the two-tier fallback order and the verbatim path", () => {
  for (const path of HOSTILE_PATHS) {
    const wrapped = batArgs(path, 100, true);
    const plain = batArgs(path, 100, false);

    assert.deepEqual(wrapped, [
      "--style=numbers",
      "--color=always",
      "--paging=never",
      "--wrap=auto",
      "--terminal-width=100",
      "--",
      path,
    ]);
    // The retry is the first tier minus --wrap=auto; nothing else may change.
    assert.deepEqual(
      plain,
      wrapped.filter((arg) => arg !== "--wrap=auto"),
    );
    assert.equal(plain.at(-1), path);
  }
});

test("deltaArgs carries only the numeric width and never a path", () => {
  assert.deepEqual(deltaArgs(72), [
    "--no-gitconfig",
    "--width=72",
    "--line-numbers",
    "--wrap-max-lines=unlimited",
    "--max-line-length=0",
  ]);
});

test("wrapDiffLines re-emits the diff marker on every continuation row", () => {
  const cases: Array<{
    name: string;
    lines: string[];
    width: number;
    expected: string[];
  }> = [
    {
      name: "short lines pass through",
      lines: ["+added", "-removed", " context"],
      width: 20,
      expected: ["+added", "-removed", " context"],
    },
    {
      name: "content lines keep their +/-/space prefix",
      lines: ["+abcdefgh"],
      width: 5,
      expected: ["+abcd", "+efgh"],
    },
    {
      name: "file headers are not treated as content",
      lines: ["+++ b/some/very/long/path"],
      width: 10,
      expected: ["+++ b/some", "/very/long", "/path"],
    },
    {
      name: "non-content lines wrap at the full width",
      lines: ["@@ -1,10 +1,10 @@"],
      width: 6,
      expected: ["@@ -1,", "10 +1,", "10 @@"],
    },
    {
      name: "non-positive width disables wrapping",
      lines: ["+abcdefgh"],
      width: 0,
      expected: ["+abcdefgh"],
    },
  ];

  for (const { name, lines, width, expected } of cases) {
    assert.deepEqual(wrapDiffLines(lines, width), expected, name);
  }
});

test("wrapDiffLines measures terminal cells, not code units", () => {
  const cases: Array<{ name: string; lines: string[]; width: number; expected: string[] }> = [
    {
      name: "CJK content wraps two cells at a time",
      lines: [`+${"漢字".repeat(3)}`],
      width: 5,
      expected: ["+漢字", "+漢字", "+漢字"],
    },
    {
      name: "emoji stay whole instead of splitting into surrogate halves",
      lines: [`+${"👍".repeat(4)}`],
      width: 5,
      expected: ["+👍👍", "+👍👍"],
    },
    {
      name: "a wide line that already fits is left alone",
      lines: ["+漢字"],
      width: 5,
      expected: ["+漢字"],
    },
  ];

  for (const { name, lines, width, expected } of cases) {
    assert.deepEqual(wrapDiffLines(lines, width), expected, name);
  }
});

test("wrapDiffLines never emits a row wider than the pane or a lone surrogate", () => {
  const inputs = [`+${"漢字".repeat(10)}`, `+${"👍".repeat(8)}`, ` ${"a".repeat(30)}`, `@@ ${"字".repeat(9)} @@`];
  for (const line of inputs) {
    for (const row of wrapDiffLines([line], 10)) {
      assert.ok(visibleWidth(row) <= 10, `row "${row}" overflows the pane`);
      const unpaired = row.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "");
      assert.ok(!/[\uD800-\uDFFF]/.test(unpaired), `row "${row}" splits a surrogate pair`);
    }
  }
});

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

test("wrapDeltaLines wraps on visible width and reindents under the gutter", () => {
  const cases: Array<{
    name: string;
    lines: string[];
    width: number;
    expected: string[];
  }> = [
    {
      name: "non-positive width disables wrapping",
      lines: [`  12 │ ${RED}abcdefghij${RESET}`],
      width: 0,
      expected: [`  12 │ ${RED}abcdefghij${RESET}`],
    },
    {
      name: "lines without a gutter fall back to plain ANSI wrapping",
      lines: ["abcdefghij"],
      width: 5,
      expected: ["abcde", "fghij"],
    },
    {
      name: "continuation rows blank the line numbers but keep the gutter",
      lines: ["  12 │ abcdefgh"],
      width: 11,
      expected: ["  12 │ abcd", "     │ efgh"],
    },
    {
      name: "ASCII pipe gutters are recognised too",
      lines: ["  7 | abcdefgh"],
      width: 10,
      expected: ["  7 | abcd", "    | efgh"],
    },
    {
      name: "ANSI codes are not counted toward the visible width",
      lines: [`  12 │ ${RED}abcdefgh${RESET}`],
      width: 11,
      expected: [`  12 │ ${RED}abcd`, `     │ ${RED}efgh${RESET}`],
    },
  ];

  for (const { name, lines, width, expected } of cases) {
    assert.deepEqual(wrapDeltaLines(lines, width), expected, name);
  }
});

test("wrapDeltaLines falls back to plain wrapping when the gutter is wider than the terminal", () => {
  // Reindenting is impossible once the gutter alone fills the width, so the
  // line is handed to the shared wrapper untouched.
  const line = "  1234567890 │ x";
  assert.deepEqual(wrapDeltaLines([line], 8), wrapTextWithAnsi(line, 8));
});

test("loadFileContent never lets a repository-controlled name reach a shell", { skip }, (t) => {
  const { root, git } = initRepo(t, "files-widget-injection-");

  // A clone can ship this name. Under the old double-quoted interpolation the
  // command substitution ran with the repository as its cwd.
  const hostileName = "report$(touch pwned.txt).md";
  const hostilePath = join(root, hostileName);
  writeFileSync(hostilePath, "# before\n");
  git("add", "--", hostileName);
  git("commit", "-qm", "init");
  writeFileSync(hostilePath, "# before\nchanged\n");

  const result = loadFileContent(hostilePath, root, true, true, 80);

  assert.equal(existsSync(join(root, "pwned.txt")), false, "the substitution must never execute");
  assert.ok(!result.lines[0].startsWith("Diff error"), `unexpected failure: ${result.lines[0]}`);
  assert.ok(result.lines.join("\n").includes("changed"), "the diff for the hostile name still renders");
});

// The shim is a POSIX script, so this pair of tests needs a real /bin/sh.
const skipShim: false | string = skip || (process.platform === "win32" ? "requires a POSIX shell" : false);

test("loadFileContent renders git's own diff even when diff.external is configured", { skip: skipShim }, (t) => {
  const { root, git } = initRepo(t, "files-widget-extdiff-");
  const marker = join(root, "external-diff-ran");
  const shim = join(root, "fake-differ.sh");
  writeFileSync(shim, `#!/bin/sh\ntouch '${marker}'\necho 'side-by-side nonsense'\n`, { mode: 0o755 });
  git("config", "diff.external", shim);

  // A leading dash is the second half of the problem: git hands the pathspec to
  // the external differ as a bare positional, with no `--` of its own.
  const names = ["tracked.md", "-dashstart.md"];
  for (const name of names) {
    writeFileSync(join(root, name), "# before\n");
    git("add", "--", name);
  }
  git("commit", "-qm", "init");
  for (const name of names) {
    writeFileSync(join(root, name), "# before\nchanged\n");
  }

  for (const name of names) {
    const result = loadFileContent(join(root, name), root, true, true, 80);
    const text = result.lines.join("\n");
    assert.equal(existsSync(marker), false, `the external differ must never run for ${name}`);
    assert.ok(!text.includes("side-by-side nonsense"), `${name} must not render the external differ's output`);
    assert.ok(!result.lines[0].startsWith("Diff error"), `unexpected failure for ${name}: ${result.lines[0]}`);
    assert.ok(text.includes("changed"), `the unified diff for ${name} still renders`);
  }
});
