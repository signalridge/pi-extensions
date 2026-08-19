/**
 * status.test.ts — porcelain-v2 parsing for the worktree status browser.
 *
 * v1 (which the safety check uses, correctly) gives two characters and a path.
 * v2 is used here because a person reads this result, and these are the
 * distinctions v1 cannot make: staged versus unstaged as separate values, a
 * rename's original path and score, unmerged entries, and submodules. Each is
 * covered below because getting one wrong makes the listing quietly misleading
 * rather than visibly broken.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { formatStatusEntry, groupStatusEntries, parsePorcelainV2 } from "../src/status.js";

const nul = (...records: string[]) => `${records.join("\0")}\0`;

describe("ordinary changes", () => {
  test("splits staged from unstaged", () => {
    const [entry] = parsePorcelainV2("1 MD N... 100644 100644 100644 aaa bbb src/a.ts");
    assert.equal(entry?.path, "src/a.ts");
    assert.equal(entry?.staged, "modified");
    assert.equal(entry?.unstaged, "deleted");
  });

  test("reads `.` as no change on that side", () => {
    const [entry] = parsePorcelainV2("1 .M N... 100644 100644 100644 aaa bbb src/a.ts");
    assert.equal(entry?.staged, "unmodified");
    assert.equal(entry?.unstaged, "modified");
  });

  test("maps every status letter", () => {
    const codes: [string, string][] = [
      ["A.", "added"],
      ["D.", "deleted"],
      ["T.", "type-changed"],
      ["M.", "modified"],
    ];
    for (const [xy, expected] of codes) {
      const [entry] = parsePorcelainV2(`1 ${xy} N... 100644 100644 100644 aaa bbb f`);
      assert.equal(entry?.staged, expected, xy);
    }
  });

  test("keeps a path containing spaces intact", () => {
    const [entry] = parsePorcelainV2("1 M. N... 100644 100644 100644 aaa bbb my file name.ts");
    assert.equal(entry?.path, "my file name.ts");
  });

  test("marks a submodule as one rather than as a modified file", () => {
    const [entry] = parsePorcelainV2("1 .M SC.. 160000 160000 160000 aaa bbb vendor/lib");
    assert.equal(entry?.submodule, true);
  });

  test("does not mark an ordinary file as a submodule", () => {
    const [entry] = parsePorcelainV2("1 .M N... 100644 100644 100644 aaa bbb src/a.ts");
    assert.equal(entry?.submodule, undefined);
  });
});

// v1 hides these inside the path field as an arrow; v2 gives both the score and
// the original path, which is what makes a rename readable in a listing.
describe("renames and copies", () => {
  test("reads the score and the original path from NUL-separated output", () => {
    const [entry] = parsePorcelainV2(
      nul("2 R. N... 100644 100644 100644 aaa bbb R95 new/path.ts", "old/path.ts"),
      "\0",
    );
    assert.equal(entry?.path, "new/path.ts");
    assert.equal(entry?.originalPath, "old/path.ts");
    assert.equal(entry?.similarity, 95);
    assert.equal(entry?.staged, "renamed");
  });

  test("reads the tab form from newline-separated output", () => {
    const [entry] = parsePorcelainV2("2 R. N... 100644 100644 100644 aaa bbb R95 new/path.ts\told/path.ts");
    assert.equal(entry?.path, "new/path.ts");
    assert.equal(entry?.originalPath, "old/path.ts");
  });

  test("handles a copy the same way", () => {
    const [entry] = parsePorcelainV2(nul("2 C. N... 100644 100644 100644 aaa bbb C80 copy.ts", "src.ts"), "\0");
    assert.equal(entry?.staged, "copied");
    assert.equal(entry?.similarity, 80);
  });

  test("does not consume the following record as an original path", () => {
    const entries = parsePorcelainV2(
      nul(
        "2 R. N... 100644 100644 100644 aaa bbb R95 new.ts",
        "old.ts",
        "1 .M N... 100644 100644 100644 aaa bbb other.ts",
      ),
      "\0",
    );
    assert.equal(entries.length, 2);
    assert.equal(entries[1]?.path, "other.ts");
  });
});

// XY on an unmerged record is the pair of conflict sides, not staged/unstaged.
// Rendering it as the latter would be a lie, so the entry carries a flag.
describe("unmerged entries", () => {
  test("are flagged as conflicts", () => {
    const [entry] = parsePorcelainV2("u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts");
    assert.equal(entry?.path, "src/conflict.ts");
    assert.equal(entry?.unmerged, true);
  });

  test("are grouped ahead of everything else", () => {
    const groups = groupStatusEntries(
      parsePorcelainV2(
        nul(
          "1 M. N... 100644 100644 100644 aaa bbb staged.ts",
          "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts",
        ),
        "\0",
      ),
    );
    assert.deepEqual(
      groups.conflicted.map((e) => e.path),
      ["conflict.ts"],
    );
    assert.equal(groups.staged.length, 1);
  });
});

describe("untracked and ignored", () => {
  test("reads an untracked path", () => {
    const [entry] = parsePorcelainV2("? new-file.ts");
    assert.equal(entry?.path, "new-file.ts");
    assert.equal(entry?.untracked, true);
  });

  test("reads an ignored path", () => {
    const [entry] = parsePorcelainV2("! node_modules/x");
    assert.equal(entry?.ignored, true);
  });
});

// This feeds a viewer: a future git record type should cost one row, not the
// whole screen.
describe("robustness", () => {
  test("skips header lines", () => {
    assert.deepEqual(parsePorcelainV2(nul("# branch.oid aaa", "# branch.head main"), "\0"), []);
  });

  test("skips an unrecognized record instead of throwing", () => {
    const entries = parsePorcelainV2(nul("9 something new", "1 M. N... 100644 100644 100644 aaa bbb a.ts"), "\0");
    assert.equal(entries.length, 1);
  });

  test("skips a truncated record with no path", () => {
    assert.deepEqual(parsePorcelainV2("1 M. N... 100644 100644 100644 aaa bbb"), []);
  });

  test("returns nothing for empty output", () => {
    assert.deepEqual(parsePorcelainV2(""), []);
    assert.deepEqual(parsePorcelainV2("\0", "\0"), []);
  });
});

describe("grouping", () => {
  // "Have I staged everything?" and "what is still uncommitted?" are different
  // questions, and a path with both staged and further unstaged edits is a real
  // answer to each.
  test("lists a doubly-changed path under both staged and unstaged", () => {
    const groups = groupStatusEntries(parsePorcelainV2("1 MM N... 100644 100644 100644 aaa bbb both.ts"));
    assert.equal(groups.staged.length, 1);
    assert.equal(groups.unstaged.length, 1);
  });

  test("keeps untracked and ignored out of the change groups", () => {
    const groups = groupStatusEntries(parsePorcelainV2(nul("? a.ts", "! b.ts"), "\0"));
    assert.equal(groups.staged.length, 0);
    assert.equal(groups.unstaged.length, 0);
    assert.equal(groups.untracked.length, 1);
    assert.equal(groups.ignored.length, 1);
  });
});

describe("formatStatusEntry", () => {
  test("renders the two-letter code and path", () => {
    assert.equal(formatStatusEntry(parsePorcelainV2("1 MD N... 1 1 1 a b src/a.ts")[0]), "MD src/a.ts");
  });

  test("shows a rename's origin and score", () => {
    const [entry] = parsePorcelainV2(nul("2 R. N... 1 1 1 a b R95 new.ts", "old.ts"), "\0");
    assert.equal(formatStatusEntry(entry), "R. new.ts ← old.ts (95%)");
  });

  test("marks conflicts and submodules", () => {
    const [conflict] = parsePorcelainV2("u UU N... 1 1 1 1 a b c c.ts");
    assert.match(formatStatusEntry(conflict), /conflict/);
    const [submodule] = parsePorcelainV2("1 .M SC.. 1 1 1 a b vendor/lib");
    assert.match(formatStatusEntry(submodule), /submodule/);
  });

  test("uses the familiar `??` and `!!` prefixes", () => {
    assert.equal(formatStatusEntry(parsePorcelainV2("? a.ts")[0]), "?? a.ts");
    assert.equal(formatStatusEntry(parsePorcelainV2("! b.ts")[0]), "!! b.ts");
  });
});
