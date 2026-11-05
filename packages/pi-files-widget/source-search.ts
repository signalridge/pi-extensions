import { visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeDisplayText } from "@signalridge/pi-ui";

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Locate the viewer's first raw, case-insensitive match in display coordinates. */
function firstMatchDisplayOffset(raw: string, foldedQuery: string): number {
  const match = foldedQuery ? raw.toLowerCase().indexOf(foldedQuery) : -1;
  if (match < 0) return -1;

  let foldedOffset = 0;
  let rawOffset = 0;
  for (const point of raw) {
    // Lowercasing can expand a code point (İ -> i + combining dot). A match
    // inside that expansion still belongs to the original source code point.
    // Search the whole line above to retain contextual lowercase semantics;
    // only lengths, not independently folded text, are used for projection.
    foldedOffset += point.toLowerCase().length;
    if (foldedOffset > match) break;
    rawOffset += point.length;
  }
  // The public display encoder escapes individual controls, including ESC;
  // it does not parse/strip ANSI sequences. Thus a prefix ending at any source
  // code point has the same encoded length as that prefix in the full line.
  return sanitizeDisplayText(raw.slice(0, rawOffset)).length;
}

/**
 * Search owns a plain source presentation, not formatter output. Hard wrapping
 * preserves source offsets (including spaces); bat/glow/delta rows are opaque.
 * Each matching source line has one result, revealing its first occurrence.
 */
export function layoutSearchSource(
  source: string,
  width: number,
  query: string,
): {
  lines: string[];
  matchRows: number[];
} {
  const lines: string[] = [];
  const matchRows: number[] = [];
  const sourceLines = source.split("\n");
  const gutterWidth = Math.max(4, String(sourceLines.length).length);
  const contentWidth = Math.max(1, width - gutterWidth - 3);
  const q = query.toLowerCase();
  for (const [lineIndex, raw] of sourceLines.entries()) {
    const text = sanitizeDisplayText(raw);
    const match = firstMatchDisplayOffset(raw, q);
    let row = "";
    let cells = 0;
    let start = 0;
    let offset = 0;
    let first = true;
    const push = (end: number) => {
      if (match >= start && match < end) matchRows[lineIndex] = lines.length;
      lines.push(`${first ? String(lineIndex + 1).padStart(gutterWidth) : " ".repeat(gutterWidth)} │ ${row}`);
      first = false;
    };
    for (const { segment } of GRAPHEMES.segment(text)) {
      const size = visibleWidth(segment);
      if (row && cells + size > contentWidth) {
        push(offset);
        row = "";
        cells = 0;
        start = offset;
      }
      row += segment;
      cells += size;
      offset += segment.length;
    }
    push(offset);
  }
  return { lines, matchRows };
}
