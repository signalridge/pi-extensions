import assert from "node:assert/strict";
import type { ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { type RuntimeState, renderStatusline } from "../src/render.js";
import { createDefaultConfig } from "../src/settings.js";
import { createMockContext } from "./support.js";

const ESCAPE = String.fromCharCode(0x1b);
const BELL = String.fromCharCode(0x07);
const CSI = String.fromCharCode(0x9b);
const DCS = String.fromCharCode(0x90);
const RLO = String.fromCodePoint(0x202e);
const PR_LINK = `${ESCAPE}]8;;https://github.com/o/r/pull/7${BELL}#7${ESCAPE}]8;;${BELL}`;

function footerData(branch: string | null, statuses = new Map<string, string>()): ReadonlyFooterDataProvider {
  return {
    getGitBranch: () => branch,
    getExtensionStatuses: () => statuses,
    onBranchChange: () => () => undefined,
    getAvailableProviderCount: () => 1,
  };
}

function emptyRuntime(): RuntimeState {
  return {
    turnCount: 0,
    activeTools: new Map(),
    isStreaming: false,
    thinkingLevel: "off",
    duplicateExtensions: [],
    extensionStatusIconAliases: new Map(),
  };
}

/** Every code point the footer must never emit, excluding the intentional OSC 8 PR hyperlink. */
function unsafeCodePoints(value: string): number[] {
  return [...value]
    .map((character) => character.codePointAt(0) ?? 0)
    .filter(
      (codePoint) =>
        (codePoint <= 0x1f && codePoint !== 0x0a) ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        codePoint === 0x061c ||
        codePoint === 0x200e ||
        codePoint === 0x200f ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069),
    );
}

function renderBranch(branch: string, statuses?: Map<string, string>): string {
  const config = createDefaultConfig();
  config.palettePreset = "classic";
  config.segments = ["branch"];
  const context = createMockContext({
    model: { id: "m", provider: "p", contextWindow: 1 },
  });
  return renderStatusline(300, context.ctx, footerData(branch, statuses), {} as Theme, config, emptyRuntime());
}

test("hostile branch names reach the footer sanitized", () => {
  const payloads = [
    `feat/${RLO}gnp.exe`,
    `main${ESCAPE}]0;OWNED${BELL}`,
    `main${ESCAPE}[31mFAKE`,
    `main${CSI}31mFAKE`,
    "main\nSECOND LINE",
  ];
  for (const branch of payloads) {
    const rendered = renderBranch(branch);
    assert.deepEqual(unsafeCodePoints(rendered), [], JSON.stringify(branch));
    assert.equal(rendered.includes("\n"), false, JSON.stringify(branch));
  }
  assert.match(renderBranch(`feat/${RLO}gnp.exe`), /feat\/gnp\.exe/u);
  assert.match(renderBranch(`main${ESCAPE}[31mFAKE`), /mainFAKE/u);
});

test("sanitizing the branch keeps the intentional PR hyperlink intact", () => {
  const statuses = new Map([["github-pr", `PR ${PR_LINK}: checks passing`]]);
  const rendered = renderBranch(`feat/${RLO}gnp.exe`, statuses);
  assert.ok(rendered.includes(PR_LINK), rendered);
  assert.ok(rendered.includes("feat/gnp.exe"), rendered);
  assert.equal(rendered.includes(RLO), false);
});

test("an unterminated introducer in a branch name never truncates the footer", () => {
  // A bounded skip is required: an unbounded one lets a single byte erase the rest of the row.
  assert.match(renderBranch(`release-2.1${DCS}-hotfix`), /release-2\.1-hotfix/u);
  assert.match(renderBranch(`release-2.1${ESCAPE}P-hotfix`), /release-2\.1-hotfix/u);
  assert.match(renderBranch(`release-2.1${CSI}`), /release-2\.1/u);
});

test("provider and active tool names reach the footer sanitized", () => {
  const config = createDefaultConfig();
  config.palettePreset = "classic";
  config.segments = ["provider", "tools"];
  const context = createMockContext({
    model: {
      id: "m",
      provider: `openai${ESCAPE}[31m${RLO}evil`,
      contextWindow: 1,
    },
  });
  const runtime = emptyRuntime();
  runtime.activeTools = new Map([[`mcp__evil__${RLO}tool`, 1]]);
  const rendered = renderStatusline(300, context.ctx, footerData("main"), {} as Theme, config, runtime);
  assert.deepEqual(unsafeCodePoints(rendered), [], rendered);
  assert.ok(rendered.includes("openaievil"), rendered);
  assert.ok(rendered.includes("mcp__evil__tool"), rendered);
});
