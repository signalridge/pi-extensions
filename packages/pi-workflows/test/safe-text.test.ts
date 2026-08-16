import { describe, expect, it } from "vitest";
import { sanitizeDisplayText, sanitizeTerminalText } from "../src/safe-text.js";

const ESC = "";
const BEL = "";
/** Clear the screen and home the cursor. */
const CSI_CLEAR = `${ESC}[2J${ESC}[H`;
/** OSC 8 hyperlink wrapping visible text around an attacker-controlled URL. */
const OSC8 = `${ESC}]8;;https://evil.example${BEL}click${ESC}]8;;${BEL}`;
/** 8-bit C1 CSI introducer — a single 0x9b byte, no ESC in sight. */
const C1_CSI = "31mred";
/** U+202E RIGHT-TO-LEFT OVERRIDE, used to disguise a filename. */
const RTL_OVERRIDE = "‮gnp.exe";

describe("terminal sanitization of child-agent text", () => {
  it("neutralizes the introducer of a CSI clear-screen sequence", () => {
    const safe = sanitizeTerminalText(`before${CSI_CLEAR}after`);
    expect(safe).not.toContain(ESC);
    expect(safe).toContain("before");
    expect(safe).toContain("after");
  });

  it("neutralizes OSC 8 hyperlinks including the BEL terminator", () => {
    const safe = sanitizeTerminalText(OSC8);
    expect(safe).not.toContain(ESC);
    expect(safe).not.toContain(BEL);
    expect(safe).toContain("click");
  });

  it("neutralizes the 8-bit C1 CSI introducer", () => {
    expect(sanitizeTerminalText(C1_CSI)).toBe(" 31mred");
    expect(sanitizeTerminalText(C1_CSI)).not.toContain("");
  });

  it("neutralizes bidi overrides and isolates", () => {
    for (const codePoint of ["؜", "‎", "‏", "‪", "‮", "⁦", "⁩"]) {
      expect(sanitizeTerminalText(`a${codePoint}b`)).toBe("a b");
    }
    expect(sanitizeDisplayText(RTL_OVERRIDE, 300)).toBe("gnp.exe");
  });

  it("sanitizes before truncating so a straddling escape cannot leave a dangling introducer", () => {
    // The CSI introducer lands at index 298, so a slice(0, 300) applied first keeps "ESC [".
    const payload = `${"x".repeat(298)}${CSI_CLEAR}${"y".repeat(100)}`;
    expect(payload.slice(0, 300)).toContain(ESC);

    const safe = sanitizeDisplayText(payload, 300);
    expect(safe).not.toContain(ESC);
    expect([...safe]).toHaveLength(300);
  });

  it("collapses newlines so multi-line results stay on one rendered row", () => {
    expect(sanitizeDisplayText("one\ntwo\r\nthree", 300)).toBe("one two three");
  });

  it("truncates by code point so a surrogate pair is never split", () => {
    const safe = sanitizeDisplayText("\u{1f600}".repeat(10), 4);
    expect(safe).toBe("\u{1f600}".repeat(4));
    expect(safe).not.toContain("�");
  });

  it("returns an empty string for a nonpositive bound", () => {
    expect(sanitizeDisplayText("anything", 0)).toBe("");
  });
});
