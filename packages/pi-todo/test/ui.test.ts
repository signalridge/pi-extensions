import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { columns, SourceViewport } from "../src/ui.js";

describe("lossless column layout", () => {
  it("keeps ASCII spaces, all UUID suffixes and combining/CJK graphemes without oversized rows", () => {
    const text = "ID: 00000000-0000-4000-8000-000000000099\nStatus: in_progress\nA 界é  end";
    for (const width of [1, 2, 3, 20, 40, 100]) {
      const rows = columns(text, width);
      expect(rows.every((row) => visibleWidth(row.text) <= width)).toBe(true);
      expect(rows.map((row) => row.text).join("")).toBe(
        text.replaceAll("\n", "").replaceAll("界", width === 1 ? "?" : "界"),
      );
    }
  });
  it("preserves the raw source anchor across repeated narrow/wide reflow instead of reusing row numbers", () => {
    const source = "0123456789".repeat(50);
    const viewport = new SourceViewport();
    viewport.render(source, 20, 4);
    viewport.navigate("\x1b[6~");
    const at80 = viewport.render(source, 20, 4);
    expect(at80[0]).toBe(source.slice(80, 100));
    expect(viewport.render(source, 3, 4)[0]).toBe(source.slice(78, 81));
    expect(viewport.render(source, 27, 4)[0]).toBe(source.slice(54, 81));
    // Pure reflow must NOT replace raw offset 80 with a previous layout's row index/start.
    expect(viewport.render(source, 20, 4)).toEqual(at80);
    expect(viewport.render(source, 1, 4)[0]).toBe(source[80]);
  });
  it("reaches the last source character and restores an oversized glyph after resize", () => {
    const viewport = new SourceViewport();
    const source = `prefix ${"界".repeat(512)} UUID-TAIL`;
    const seen = new Set<string>();
    for (let i = 0; i < source.length + 10; i++) {
      for (const row of viewport.render(source, 1, 12)) seen.add(row);
      viewport.navigate("n");
    }
    expect(seen.has("?")).toBe(true);
    for (const char of "UUID-TAIL") expect(seen.has(char)).toBe(true);
    viewport.navigate("\x1b[H");
    expect(viewport.render(source, 100, 30).join("")).toBe(source);
  });
});
