/**
 * history.test.ts — the pure logic behind the Ctrl+R history popup.
 *
 * The popup itself is a TUI component, but everything that decides WHICH
 * prompts you see and in what order is ordinary data transformation: the fuzzy
 * matcher, the cross-session merge, the timestamp parse, and the age label.
 * Those are the parts that go quietly wrong — a matcher that is too greedy, a
 * merge that shows the same prompt twice, an age that reads "now" for last
 * week — so they are tested directly rather than through a rendered frame.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  extractText,
  fuzzyMatch,
  type HistoryEntry,
  mergeHistory,
  parseTimestamp,
  relativeAge,
  subsequence,
  toSingleLinePreview,
} from "../src/index.js";

describe("subsequence", () => {
  test("matches characters in order, not necessarily adjacent", () => {
    assert.equal(subsequence("abcdef", "ace"), true);
    assert.equal(subsequence("abcdef", "abc"), true);
  });

  test("respects order", () => {
    assert.equal(subsequence("abcdef", "cba"), false);
  });

  test("does not reuse a character position", () => {
    // Only one "a", so "aa" cannot match — the second search starts past it.
    assert.equal(subsequence("abc", "aa"), false);
  });

  test("an empty needle always matches", () => {
    assert.equal(subsequence("abc", ""), true);
    assert.equal(subsequence("", ""), true);
  });

  test("nothing matches inside an empty haystack", () => {
    assert.equal(subsequence("", "a"), false);
  });
});

describe("fuzzyMatch", () => {
  test("an empty query keeps every entry", () => {
    assert.equal(fuzzyMatch("anything", ""), true);
    assert.equal(fuzzyMatch("anything", "   "), true);
  });

  test("is case-insensitive in both directions", () => {
    assert.equal(fuzzyMatch("Fix The Parser", "fix"), true);
    assert.equal(fuzzyMatch("fix the parser", "FIX"), true);
  });

  // Whitespace splits the query into independent tokens, each matched as its
  // own subsequence. That is what lets "fix parser" find "fix the parser"
  // without the space having to appear between them in the text.
  test("matches each whitespace-separated token independently", () => {
    assert.equal(fuzzyMatch("fix the parser", "fix parser"), true);
    assert.equal(fuzzyMatch("fix the parser", "parser fix"), true);
  });

  test("requires every token to match", () => {
    assert.equal(fuzzyMatch("fix the parser", "fix compiler"), false);
  });

  test("matches a scattered subsequence, which is the point of fuzzy", () => {
    assert.equal(fuzzyMatch("packages/pi-input-history", "pih"), true);
  });

  test("rejects a query whose characters are out of order", () => {
    assert.equal(fuzzyMatch("abc", "cb"), false);
  });
});

describe("toSingleLinePreview", () => {
  test("collapses newlines and runs of whitespace into single spaces", () => {
    assert.equal(toSingleLinePreview("fix   the\n\n  parser"), "fix the parser");
  });

  test("trims the ends", () => {
    assert.equal(toSingleLinePreview("  padded  "), "padded");
  });

  test("survives an all-whitespace string", () => {
    assert.equal(toSingleLinePreview("  \n\t "), "");
  });
});

describe("relativeAge", () => {
  const now = Date.parse("2026-08-17T12:00:00Z");
  const ago = (ms: number) => relativeAge(now - ms, now);

  test("renders nothing when the session recorded no timestamp", () => {
    assert.equal(relativeAge(undefined, now), "");
  });

  test("reads `now` under a minute", () => {
    assert.equal(ago(0), "now");
    assert.equal(ago(59_000), "now");
  });

  test("steps up through minutes, hours, days, and years", () => {
    assert.equal(ago(60_000), "1m");
    assert.equal(ago(59 * 60_000), "59m");
    assert.equal(ago(60 * 60_000), "1h");
    assert.equal(ago(23 * 3_600_000), "23h");
    assert.equal(ago(24 * 3_600_000), "1d");
    assert.equal(ago(364 * 86_400_000), "364d");
    assert.equal(ago(365 * 86_400_000), "1y");
  });

  test("truncates rather than rounds, so a label never overstates the age", () => {
    assert.equal(ago(119_000), "1m");
    assert.equal(ago(7_199_000), "1h");
  });
});

describe("parseTimestamp", () => {
  test("parses an ISO string", () => {
    assert.equal(parseTimestamp("2026-08-17T12:00:00Z"), Date.parse("2026-08-17T12:00:00Z"));
  });

  test("returns undefined for a non-string, so a malformed entry is undated rather than fatal", () => {
    assert.equal(parseTimestamp(undefined), undefined);
    assert.equal(parseTimestamp(1_234), undefined);
    assert.equal(parseTimestamp(null), undefined);
    assert.equal(parseTimestamp({}), undefined);
  });

  test("returns undefined for an unparseable string", () => {
    assert.equal(parseTimestamp("not a date"), undefined);
    assert.equal(parseTimestamp(""), undefined);
  });
});

describe("mergeHistory", () => {
  const entry = (text: string, timestamp?: number): HistoryEntry => ({ text, timestamp });

  test("keeps the current session's entries ahead of the cached ones", () => {
    const merged = mergeHistory([entry("branch")], [entry("cached")]);
    assert.deepEqual(
      merged.map((e) => e.text),
      ["branch", "cached"],
    );
  });

  // The same prompt typed in this session and recorded in an older one must
  // appear once — and as the CURRENT session's copy, which carries the newer
  // timestamp the age gutter renders.
  test("deduplicates by text, keeping the branch copy", () => {
    const merged = mergeHistory([entry("same", 200)], [entry("same", 100)]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].timestamp, 200);
  });

  test("deduplicates within the cached list too", () => {
    const merged = mergeHistory([], [entry("dup", 2), entry("dup", 1)]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].timestamp, 2);
  });

  test("preserves order among distinct entries", () => {
    const merged = mergeHistory([entry("a"), entry("b")], [entry("c"), entry("d")]);
    assert.deepEqual(
      merged.map((e) => e.text),
      ["a", "b", "c", "d"],
    );
  });

  test("handles both sides being empty", () => {
    assert.deepEqual(mergeHistory([], []), []);
  });

  // Dedup is on exact text: two prompts differing only in whitespace are
  // genuinely different things to re-run, so they are not collapsed.
  test("treats whitespace-different prompts as distinct", () => {
    assert.equal(mergeHistory([entry("a b")], [entry("a  b")]).length, 2);
  });
});

describe("extractText", () => {
  test("returns a plain string body as-is", () => {
    assert.equal(extractText("hello"), "hello");
  });

  test("returns null for an empty string, so it is never offered as history", () => {
    assert.equal(extractText(""), null);
  });

  test("finds the first text part of a structured message", () => {
    assert.equal(extractText([{ type: "text", text: "hello" }] as never), "hello");
  });

  test("skips non-text parts, so an image-only message contributes nothing", () => {
    assert.equal(extractText([{ type: "image", source: "x" }] as never), null);
  });

  test("skips empty text parts and takes the first non-empty one", () => {
    assert.equal(
      extractText([
        { type: "text", text: "" },
        { type: "text", text: "second" },
      ] as never),
      "second",
    );
  });

  test("returns null for an empty content array", () => {
    assert.equal(extractText([] as never), null);
  });
});
