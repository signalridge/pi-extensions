/**
 * agent-color.test.ts — agent name badges.
 *
 * Two things are load-bearing here and neither is cosmetic:
 *
 *  - the NAME comes from a `.pi/agents/*.md` file this extension did not write,
 *    and the badge wraps it in escape sequences before it reaches the terminal.
 *    Sanitizing has to happen first, or a crafted `display_name` redraws the
 *    parent terminal from inside our own styling.
 *  - the COLOR decides the badge's background, and the text colour is chosen by
 *    contrast against it. Getting that backwards yields an unreadable badge on
 *    half the palette.
 */
import { describe, expect, it, vi } from "vitest";
import {
  hasAgentBadge,
  renderAgentName,
  renderAgentNameLabel,
  resolveAgentColor,
} from "../src/agent-color.js";
import { registerAgents } from "../src/agent-types.js";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
};

const theme256 = { ...theme, getColorMode: () => "256color" as const };

/** Strip SGR so a test can assert on the visible text alone. */
const plain = (text: string) => text.replaceAll(/\u001B\[[0-9;]*m/g, "");

describe("resolveAgentColor", () => {
  it("resolves Claude Code's named colours", () => {
    expect(resolveAgentColor("red")).toBe("#DC2626");
    expect(resolveAgentColor("cyan")).toBe("#0891B2");
  });

  it("resolves the Agency Agents palette aliases", () => {
    expect(resolveAgentColor("neon-green")).toBe("#10B981");
    expect(resolveAgentColor("grey")).toBe(resolveAgentColor("gray"));
  });

  it("accepts six-digit hex and normalizes its case", () => {
    expect(resolveAgentColor("#abcdef")).toBe("#ABCDEF");
    expect(resolveAgentColor("  #AbCdEf  ")).toBe("#ABCDEF");
  });

  it("is case-insensitive for names", () => {
    expect(resolveAgentColor("RED")).toBe("#DC2626");
  });

  // A colour typo must cost the badge, never the agent: the loader keeps the
  // definition and this returns undefined, so the name renders unstyled.
  it("rejects anything that is not a known name or six-digit hex", () => {
    expect(resolveAgentColor("chartreuse")).toBeUndefined();
    expect(resolveAgentColor("#abc")).toBeUndefined();
    expect(resolveAgentColor("#gggggg")).toBeUndefined();
    expect(resolveAgentColor("")).toBeUndefined();
    expect(resolveAgentColor(undefined)).toBeUndefined();
  });

  // The resolved value is what gets parsed into the escape sequence's numbers,
  // so nothing that is not hex may survive this gate.
  it("rejects a value carrying an escape sequence", () => {
    expect(resolveAgentColor("#DC2626[31m")).toBeUndefined();
    expect(resolveAgentColor("[0m")).toBeUndefined();
  });
});

describe("renderAgentNameLabel", () => {
  it("keeps the caller's styling when no colour is configured", () => {
    expect(
      renderAgentNameLabel("Explore", undefined, theme, {
        fallbackColor: "muted",
      }),
    ).toBe("<muted>Explore</muted>");
  });

  it("keeps the caller's styling when the colour is invalid", () => {
    expect(
      renderAgentNameLabel("Explore", "chartreuse", theme, {
        fallbackColor: "muted",
      }),
    ).toBe("<muted>Explore</muted>");
  });

  it("returns the bare name when there is neither colour nor fallback", () => {
    expect(renderAgentNameLabel("Explore", undefined, theme)).toBe("Explore");
  });

  it("applies bold through the theme on the unbadged path", () => {
    expect(
      renderAgentNameLabel("Explore", undefined, theme, { bold: true }),
    ).toBe("<b>Explore</b>");
  });

  it("pads the name inside the badge so the background reads as a badge", () => {
    expect(plain(renderAgentNameLabel("Explore", "red", theme))).toBe(
      " Explore ",
    );
  });

  it("emits a truecolor background from the resolved hex", () => {
    // #DC2626 → 220, 38, 38
    expect(renderAgentNameLabel("Explore", "red", theme)).toContain(
      "[48;2;220;38;38m",
    );
  });

  it("closes both layers so the badge cannot leak into the rest of the line", () => {
    const badge = renderAgentNameLabel("Explore", "red", theme);
    expect(badge).toContain("[39m");
    expect(badge.endsWith("[49m")).toBe(true);
  });

  it("restores an enclosing background instead of resetting it when asked", () => {
    const badge = renderAgentNameLabel("Explore", "red", theme, {
      restoreBackground: "[44m",
    });
    expect(badge.endsWith("[44m")).toBe(true);
    expect(badge).not.toContain("[49m");
  });

  // Claude Code uses one inverse colour for every badge; picking by contrast
  // instead is what keeps the light half of the palette readable.
  it("puts dark text on a light badge and light text on a dark one", () => {
    // #EAB308 (gold) is light → black text.
    expect(renderAgentNameLabel("A", "gold", theme)).toContain("[38;2;0;0;0m");
    // #1E3A8A (navy) is dark → white text.
    expect(renderAgentNameLabel("A", "navy", theme)).toContain(
      "[38;2;255;255;255m",
    );
  });

  it("quantizes to the xterm-256 palette when the theme reports 256 colours", () => {
    const badge = renderAgentNameLabel("Explore", "red", theme256);
    expect(badge).toMatch(/\[48;5;\d+m/);
    expect(badge).not.toContain("48;2;");
  });

  it("judges contrast against the colour the terminal will actually show", () => {
    // Quantized too, not a truecolor foreground on a quantized background.
    expect(renderAgentNameLabel("A", "gold", theme256)).toMatch(/\[38;5;\d+m/);
  });

  // The whole reason this module owns sanitizing rather than its callers: it is
  // the last place the name is plain text before escape sequences wrap it.
  describe("untrusted names", () => {
    it("neutralizes an escape sequence in the name", () => {
      const badge = renderAgentNameLabel("evil[31mred", "red", theme);
      expect(badge).not.toContain("[31m");
    });

    it("neutralizes a bidi override in the name", () => {
      expect(renderAgentNameLabel("evil‮name", "red", theme)).not.toContain(
        "‮",
      );
    });

    it("sanitizes on the unbadged path too", () => {
      expect(
        renderAgentNameLabel("evil[31mred", undefined, theme),
      ).not.toContain("[31m");
    });

    // Sanitizing after wrapping would strip the badge's own codes; this asserts
    // the order is name-first.
    it("keeps its own styling while removing the name's", () => {
      const badge = renderAgentNameLabel("evil[31mred", "red", theme);
      expect(badge).toContain("[48;2;220;38;38m");
      expect(badge).not.toContain("[31m");
    });
  });
});

describe("renderAgentName", () => {
  const withAgents = (
    agents: Record<string, { color?: string; displayName?: string }>,
  ) => {
    registerAgents(
      new Map(
        Object.entries(agents).map(([name, extra]) => [
          name,
          { name, description: "d", systemPrompt: "s", ...extra },
        ]),
      ) as never,
    );
  };

  it("badges an agent that declares a colour", () => {
    withAgents({ reviewer: { color: "red", displayName: "Reviewer" } });
    expect(plain(renderAgentName("reviewer", theme))).toBe(" Reviewer ");
    registerAgents(new Map());
  });

  it("falls back to the caller's status colour for an agent without one", () => {
    withAgents({ plain: { displayName: "Plain" } });
    // This is the composition seam with `getAgentStatusColor`: an unbadged
    // agent still reads as running/failed/done exactly as it did before.
    expect(renderAgentName("plain", theme, { fallbackColor: "success" })).toBe(
      "<success>Plain</success>",
    );
    registerAgents(new Map());
  });

  it("renders a generic label when no type is given", () => {
    expect(renderAgentName(undefined, theme)).toBe("Agent");
  });
});

describe("hasAgentBadge", () => {
  it("is true only for a registered agent with a valid colour", () => {
    registerAgents(
      new Map([
        [
          "colored",
          {
            name: "colored",
            description: "d",
            systemPrompt: "s",
            color: "red",
          },
        ],
        [
          "typo",
          {
            name: "typo",
            description: "d",
            systemPrompt: "s",
            color: "chartreuse",
          },
        ],
        ["bare", { name: "bare", description: "d", systemPrompt: "s" }],
      ]) as never,
    );
    expect(hasAgentBadge("colored")).toBe(true);
    expect(hasAgentBadge("typo")).toBe(false);
    expect(hasAgentBadge("bare")).toBe(false);
    expect(hasAgentBadge(undefined)).toBe(false);
    registerAgents(new Map());
  });
});

describe("theme integration", () => {
  it("asks the theme for its colour mode rather than assuming truecolor", () => {
    const getColorMode = vi.fn(() => "truecolor" as const);
    renderAgentNameLabel("A", "red", { ...theme, getColorMode });
    expect(getColorMode).toHaveBeenCalled();
  });

  it("assumes truecolor when the theme does not report a mode", () => {
    expect(renderAgentNameLabel("A", "red", theme)).toContain("48;2;");
  });
});
