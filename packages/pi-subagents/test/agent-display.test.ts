import { describe, expect, it } from "vitest";
import { renderRunningAgentStatus } from "../src/index.js";
import { fgPreservingNestedStyles, formatSessionTokens, SPINNER } from "../src/ui/agent-display.js";

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };
  const ansiTheme = {
    fg: (c: string, s: string) => {
      const codes: Record<string, string> = { dim: "2", warning: "33", accent: "35" };
      return `\u001b[${codes[c] ?? "31"}m${s}\u001b[39m`;
    },
    bold: (s: string) => s,
  };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k tokens");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k tokens (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k tokens (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k tokens (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k tokens (<error>85%</error>)" );
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k tokens (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k tokens (<dim>compactions 1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k tokens (<dim>compactions 3</dim>)");
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k tokens (<dim>45%</dim> · <dim>compactions 2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k tokens (<error>88%</error> · <dim>compactions 4</dim>)");
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k tokens (<dim>45%</dim>)");
  });

  it("preserves the outer style after nested annotation styles reset", () => {
    const tokenText = formatSessionTokens(1234, 70, ansiTheme);

    expect(fgPreservingNestedStyles(ansiTheme, "accent", tokenText)).toBe(
      "\u001b[35m1.2k tokens (\u001b[33m70%\u001b[39m\u001b[35m)\u001b[39m",
    );
  });
});

describe("renderRunningAgentStatus", () => {
  it("renders a marked status line and an indented activity line", () => {
    const theme = { fg: (_c: string, s: string) => s };
    const component = renderRunningAgentStatus("\u283b", "thinking: xhigh · tools 4", "reading", theme);

    expect(component.render(120).map((line) => line.trimEnd())).toEqual([
      "● running · thinking: xhigh · tools 4",
      "  ⠻ reading",
    ]);
  });
});

describe("SPINNER", () => {
  it("keeps every frame one column wide so trailing text never shifts", () => {
    // The frame is followed on the same line by the activity description; a
    // frame that changes width drags that text sideways on every tick.
    for (const frame of SPINNER) {
      expect([...frame]).toHaveLength(1);
    }
  });
});
