import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { fitHints, WelcomeCard } from "../src/index.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as never;

function render(width: number, rows: [string, string][], hints?: string[]) {
  return new WelcomeCard({ rows, hints }, theme).render(width);
}

test("welcome card stays within the terminal at normal and narrow widths", () => {
  const rows: [string, string][] = [
    ["Directory", "~/work/signalridge/pi-extensions"],
    ["Branch", "main [+12 -4]"],
    ["Model", "openai-codex / gpt-5.6-luna · thinking max"],
    ["Budget", "372K · compacts at 242K"],
    ["", ""],
    ["Tools", "11 active of 17"],
  ];

  for (const width of [12, 16, 19, 20, 32, 48, 80, 120]) {
    const lines = render(width, rows, ["Ctrl+C interrupt", "/ commands", "! bash"]);
    assert.ok(lines.length > 0);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `overflow at width ${width}`,
    );
  }
});

test("wide cards lead with the pi mark and version, never a vendor name", () => {
  const lines = render(80, [
    ["Directory", "~/project"],
    ["Session", "new"],
    ["Skills", "commit, dev-preferences +12"],
  ]);
  const text = lines.join("\n");
  assert.match(text, /▄▄▄▄▄▄/u);
  assert.match(text, /▐█ {2}█▌/u);
  assert.match(text, /pi v\d/u);
  assert.match(text, /A focused coding workspace/u);
  assert.match(text, /Directory:/u);
  assert.match(text, /Session:/u);
  assert.match(text, /Skills:\s+commit, dev-preferences \+12/u);
  assert.match(lines[0] ?? "", /^╭─+╮$/u);
  assert.match(lines.at(-1) ?? "", /^╰─+╯$/u);
});

test("the card carries the key hints pi's own header would have shown", () => {
  // With quietStartup on, pi prints nothing at all, so these are the only place
  // a new session learns how to interrupt or reach the command list.
  const hints = ["Ctrl+C interrupt", "/ commands", "! bash", "Ctrl+L clear"];
  const text = render(80, [["Directory", "~/project"]], hints).join("\n");

  assert.match(text, /Ctrl\+C interrupt/u);
  assert.match(text, /\/ commands/u);
  assert.match(text, /! bash/u);

  // A session that could not read its keybindings still gets a usable card.
  const withoutHints = render(80, [["Directory", "~/project"]]).join("\n");
  assert.match(withoutHints, /Directory:/u);

  // Too narrow for the whole list: drop from the end rather than wrap a
  // separator onto a line of its own.
  assert.equal(fitHints(hints, 80), hints.join(" · "));
  assert.equal(fitHints(hints, 20), "Ctrl+C interrupt");
  assert.equal(fitHints(hints, 4), undefined);
});

test("hostile workspace facts are neutralized before they reach the terminal", () => {
  // A directory name may contain any byte but `/` and NUL, and a git refname may
  // carry a bidi override, so both arrive as attacker-controlled text in a clone.
  const rows: [string, string][] = [
    ["Directory", "~/work/repo\u0007\u001b]0;pwned\u0007\u001b[2Jcleared"],
    ["Branch", "main\u202egnp.js\u202c [+1 -0]"],
    ["Session", "review\u0085\u009bHrogue"],
  ];

  // pi-tui's truncateToWidth emits its own SGR reset when it cuts a line; that one
  // sequence is the renderer's, so drop it and require the remainder to be inert.
  const SGR_RESET = "\u001b[0m";

  for (const width of [16, 80]) {
    for (const rendered of new WelcomeCard({ rows }, theme).render(width)) {
      const line = rendered.split(SGR_RESET).join("");
      for (const character of line) {
        const codePoint = character.codePointAt(0) ?? 0;
        assert.ok(
          codePoint > 0x1f && !(codePoint >= 0x7f && codePoint <= 0x9f),
          `control U+${codePoint.toString(16)} survived at width ${width}`,
        );
        assert.ok(
          !(codePoint >= 0x202a && codePoint <= 0x202e),
          `bidi override U+${codePoint.toString(16)} survived at width ${width}`,
        );
      }
    }
  }

  // The facts themselves must still be readable once the controls are gone.
  const wide = new WelcomeCard({ rows }, theme).render(80).join("\n");
  // Hints are stored in the same entry and replayed on resume, so they get the
  // same scrubbing on the way out.
  const poisonedHints = new WelcomeCard({ rows: [["Directory", "~/p"]], hints: ["Ctrl+C\u001b[2J interrupt"] }, theme)
    .render(80)
    .join("\n");
  assert.equal(poisonedHints.includes("\u001b[2J"), false);
  assert.match(wide, /repo/u);
  assert.match(wide, /main/u);
});

test("compact cards remain useful instead of overflowing their border", () => {
  const lines = render(16, [
    ["Directory", "~/very-long-project"],
    ["Branch", "main"],
  ]);
  assert.ok(lines.every((line) => !line.includes("SIGNALRIDGE")));
  assert.ok(lines.some((line) => line.includes("Directory:")));
  assert.ok(lines.every((line) => visibleWidth(line) <= 16));
});
