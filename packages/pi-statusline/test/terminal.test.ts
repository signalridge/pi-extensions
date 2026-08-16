import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { sanitizeTerminalText } from "../src/terminal.js";

const ESCAPE = String.fromCharCode(0x1b);
const BELL = String.fromCharCode(0x07);
const CSI = String.fromCharCode(0x9b);
const ST = String.fromCharCode(0x9c);
const OSC = String.fromCharCode(0x9d);
const DCS = String.fromCharCode(0x90);
const PM = String.fromCharCode(0x9e);
const APC = String.fromCharCode(0x9f);
const SOS = String.fromCharCode(0x98);
const RLO = String.fromCodePoint(0x202e);
const BIDI_CODE_POINTS = [
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
];

test("drops escape, csi, and osc sequences without leaking their payloads", () => {
  assert.equal(sanitizeTerminalText(`model${ESCAPE}[31mred${ESCAPE}[0m`), "modelred");
  assert.equal(sanitizeTerminalText(`model${CSI}31mred`), "modelred");
  assert.equal(sanitizeTerminalText(`a${ESCAPE}]8;;https://bad${BELL}link`), "alink");
  assert.equal(sanitizeTerminalText(`a${OSC}8;;https://bad${ST}link`), "alink");
  assert.equal(sanitizeTerminalText(`a${ESCAPE}Xb`), "ab");
});

test("drops dcs, pm, and apc payloads for seven-bit and eight-bit introducers", () => {
  assert.equal(sanitizeTerminalText(`head${ESCAPE}P1;2payload${ESCAPE}\\tail`), "headtail");
  assert.equal(sanitizeTerminalText(`head${DCS}1;2payload${ST}tail`), "headtail");
  assert.equal(sanitizeTerminalText(`head${ESCAPE}_apc payload${ESCAPE}\\tail`), "headtail");
  assert.equal(sanitizeTerminalText(`head${APC}apc payload${ST}tail`), "headtail");
  assert.equal(sanitizeTerminalText(`head${ESCAPE}^pm payload${ST}tail`), "headtail");
  assert.equal(sanitizeTerminalText(`head${PM}pm payload${ST}tail`), "headtail");
  assert.equal(sanitizeTerminalText(`head${ESCAPE}Xsos payload${ST}tail`), "headtail");
  assert.equal(sanitizeTerminalText(`head${SOS}sos payload${ST}tail`), "headtail");
});

test("an unterminated introducer drops only itself and keeps the tail", () => {
  // Scanning to end-of-string would give a hostile branch name a one-byte primitive for erasing
  // whatever follows it in the footer, and the code-point filter already makes the tail inert.
  for (const introducer of [DCS, OSC, PM, APC, SOS]) {
    assert.equal(
      sanitizeTerminalText(`release-2.1${introducer}-hotfix`),
      "release-2.1-hotfix",
      introducer.codePointAt(0)?.toString(16),
    );
  }
  for (const introducer of ["P", "]", "^", "_", "X"]) {
    assert.equal(sanitizeTerminalText(`release-2.1${ESCAPE}${introducer}-hotfix`), "release-2.1-hotfix", introducer);
  }
  // A CSI run ends at the first final byte, so an unbounded scan only shows up when no final byte
  // can follow: at end of string, or once a byte appears that no control sequence may contain.
  assert.equal(sanitizeTerminalText(`release-2.1${CSI}`), "release-2.1");
  assert.equal(sanitizeTerminalText(`release-2.1${ESCAPE}[`), "release-2.1");
  assert.equal(sanitizeTerminalText(`release-2.1${CSI}éclair`), "release-2.1éclair");
  assert.equal(sanitizeTerminalText(`head${DCS}unterminated payload`), "headunterminated payload");
});

test("drops bidi controls without shifting rendered width", () => {
  for (const codePoint of BIDI_CODE_POINTS) {
    const control = String.fromCodePoint(codePoint);
    const sanitized = sanitizeTerminalText(`feature/${control}gnp.exe`);
    assert.equal(sanitized, "feature/gnp.exe", codePoint.toString(16));
    assert.equal(visibleWidth(sanitized), visibleWidth("feature/gnp.exe"), codePoint.toString(16));
  }
  assert.equal(sanitizeTerminalText(`${RLO}claude-4-opus`), "claude-4-opus");
});

test("keeps line separators as spaces and preserves astral characters", () => {
  for (const codePoint of [0x09, 0x0a, 0x0d, 0x85, 0x2028, 0x2029]) {
    assert.equal(sanitizeTerminalText(`a${String.fromCodePoint(codePoint)}b`), "a b", codePoint.toString(16));
  }
  const book = String.fromCodePoint(0x1f4d6);
  const rocket = String.fromCodePoint(0x1f680);
  assert.equal(sanitizeTerminalText(`${book}${RLO}${rocket}`), `${book}${rocket}`);
});
