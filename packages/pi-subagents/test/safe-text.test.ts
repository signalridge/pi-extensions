/**
 * safe-text.test.ts — the scrubbers standing between an untrusted child
 * transcript and the parent's terminal.
 *
 * Everything this package renders is text a subagent produced, and a subagent
 * that read a poisoned file, fetched a hostile page or was prompt-injected can
 * emit bytes the PARENT terminal obeys. These assert the terminal-controlling
 * ones come out inert, that ordinary text survives untouched, and that our own
 * styling still wraps the scrubbed result instead of being scrubbed with it.
 */
import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { describeActivity } from "../src/ui/agent-display.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";
import { FleetList, type FleetUICtx } from "../src/ui/fleet-list.js";
import { safeTerminalText, sanitizeDisplayText, truncateCodePoints } from "../src/ui/safe-text.js";

/** Erase display + home the cursor — rewrites the parent's whole screen. */
const CSI_CLEAR = "\x1b[2J\x1b[H";
/** The same erase through the 8-bit C1 introducer, which never sees an ESC. */
const C1_CLEAR = "\u009b2J";
/** OSC 8: renders as innocuous text while pointing somewhere else. */
const OSC8_LINK = "\x1b]8;;https://evil.example/\x07click me\x1b]8;;\x07";
/** RTL override + pop: reverses the visible order of everything between them. */
const RTL_SANDWICH = "report\u202egnp.exe\u202c done";

/** Marks our own styling so a leftover ESC in the output can only be the payload's. */
const markerTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `*${text}*`,
};

describe("sanitizeDisplayText", () => {
  it("consumes CSI, OSC and 8-bit C1 sequences down to a single space", () => {
    expect(sanitizeDisplayText(`before${CSI_CLEAR}after`)).toBe("before after");
    expect(sanitizeDisplayText(`x${C1_CLEAR}y`)).toBe("x y");
    expect(sanitizeDisplayText(`link:${OSC8_LINK}`)).toBe("link: click me");
  });

  it("names bidi overrides instead of letting them reorder the row", () => {
    expect(sanitizeDisplayText(RTL_SANDWICH)).toBe("report[U+202E]gnp.exe[U+202C] done");
  });

  it("collapses newlines and tabs so a preview stays one line", () => {
    expect(sanitizeDisplayText("first\nsecond\t\tthird")).toBe("first second third");
  });

  it("passes CJK and emoji through unharmed", () => {
    expect(sanitizeDisplayText("日本語 🚀 ok")).toBe("日本語 🚀 ok");
  });
});

describe("safeTerminalText", () => {
  it("consumes CSI, OSC and 8-bit C1 sequences", () => {
    expect(safeTerminalText(`before${CSI_CLEAR}after`)).toBe("before after");
    expect(safeTerminalText(`x${C1_CLEAR}y`)).toBe("x y");
    expect(safeTerminalText(`link:${OSC8_LINK}`)).toBe("link: click me");
  });

  it("names bidi overrides, lone surrogates, private use and non-characters", () => {
    expect(safeTerminalText(RTL_SANDWICH)).toBe("report[U+202E]gnp.exe[U+202C] done");
    expect(safeTerminalText("bad\ud800end")).toBe("bad[U+D800]end");
    expect(safeTerminalText("pua\ue000end")).toBe("pua[U+E000]end");
    expect(safeTerminalText("odd\ufffeend")).toBe("odd[U+FFFE]end");
  });

  it("keeps the newlines and tabs the wrapping layout splits on", () => {
    expect(safeTerminalText("a\n\tb")).toBe("a\n\tb");
    expect(safeTerminalText("a\r\nb")).toBe("a\nb");
    // A lone CR would drag the cursor back over the line already drawn.
    expect(safeTerminalText("a\rb")).toBe("a[U+000D]b");
  });

  it("substitutes a placeholder for NUL blobs and dense control bytes", () => {
    expect(safeTerminalText("\0\0\0\0binary")).toBe("[binary content omitted]");
    expect(safeTerminalText("\x01\x02\x03\x04\x05".repeat(16))).toBe("[binary content omitted]");
  });

  it("keeps a short line that merely contains control bytes", () => {
    // Six backspaces in eighteen characters clear the old ratio; discarding the
    // message would hide readable output over a progress bar or readline echo.
    const output = safeTerminalText("secret\b\b\b\b\b\bpublic");

    expect(output).not.toContain("binary content omitted");
    expect(output).toContain("secret");
    expect(output).toContain("public");
  });

  it("keeps the tail after an introducer that never terminates", () => {
    // A bare two-byte OSC introducer used to swallow everything after it — a
    // free content-hiding primitive for a child covering its own tracks.
    expect(safeTerminalText(`hello\x1b]0;title AND EVERYTHING AFTER`)).toContain("EVERYTHING AFTER");
    expect(sanitizeDisplayText("a\u009dpayload REST-OF-LINE")).toContain("REST-OF-LINE");
    expect(safeTerminalText(`keep\x1b]0;hidden`)).not.toContain("\x1b");
  });

  it("still consumes a control string that does terminate", () => {
    expect(sanitizeDisplayText(`a\x1b]0;title\x07b`)).toBe("a b");
    expect(sanitizeDisplayText(`a\x1b]8;;url\x1b\\b`)).toBe("a b");
  });

  it("re-dispatches on an introducer nested inside a sequence", () => {
    // '[' is a legal CSI final byte, so the inner introducer used to terminate
    // the outer sequence and leak its parameter bytes as visible text.
    expect(sanitizeDisplayText("a\x1b[3\x1b[1mb")).toBe("a b");
    expect(sanitizeDisplayText("a\x1b]0;t\u009b2Jb")).toBe("a b");
  });

  it("does not pad an SGR reset that already sits next to whitespace", () => {
    expect(safeTerminalText("\x1b[31mERR\x1b[0m ok")).toBe("ERR ok");
    expect(safeTerminalText("\x1b[31mERR\x1b[0m\nok")).toBe("ERR\nok");
  });

  it("does not mistake heavily colorized tool output for a binary blob", () => {
    const colorized = Array.from({ length: 8 }, () => "\x1b[31mERR\x1b[0m").join(" ");
    expect(safeTerminalText(colorized)).toContain("ERR");
    expect(safeTerminalText(colorized)).not.toContain("binary content omitted");
  });

  it("passes CJK and emoji through unharmed", () => {
    expect(safeTerminalText("日本語 🚀 ok")).toBe("日本語 🚀 ok");
  });
});

describe("truncateCodePoints", () => {
  it("never cuts a surrogate pair in half", () => {
    const cut = truncateCodePoints(`${"z".repeat(59)}${"\u{1F4A5}".repeat(5)}`, 60, "");

    expect([...cut]).toHaveLength(60);
    expect([...cut].at(-1)).toBe("\u{1F4A5}");
    // A half-cut pair would come back named, which is what the slice put there.
    expect(sanitizeDisplayText(cut)).toBe(cut);
    expect(cut).not.toContain("[U+D8");
  });

  it("keeps the suffix inside the budget and leaves short text alone", () => {
    expect(truncateCodePoints("abcdefghij", 6)).toBe("abc...");
    expect(truncateCodePoints("abc", 6)).toBe("abc");
    expect(truncateCodePoints("🚀🚀🚀", 6)).toBe("🚀🚀🚀");
  });
});

// ---- Rendered surfaces ----

function mockTui(rows = 30, columns = 120) {
  return { terminal: { rows, columns }, requestRender: () => {} } as any;
}

function mockSession(messages: unknown[]) {
  return {
    messages,
    subscribe: () => () => {},
    dispose: () => {},
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
  } as any;
}

function mockRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "safe description",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...overrides,
  } as AgentRecord;
}

function renderViewer(messages: unknown[], record: AgentRecord = mockRecord()): string {
  const viewer = new ConversationViewer(
    mockTui(), mockSession(messages), record, undefined, markerTheme, () => {},
  );
  return viewer.render(120).join("\n");
}

function renderFleet(records: AgentRecord[]): string {
  const fleet = new FleetList({ listAgentsMutable: () => records, abort: () => true } as any, new Map());
  let factory: any;
  fleet.setUICtx({
    setWidget: (_key: string, content: unknown) => { factory = content; },
    onTerminalInput: () => () => {},
    getEditorText: () => "",
    notify: () => {},
    custom: async () => undefined,
  } as unknown as FleetUICtx);
  fleet.update();
  if (!factory) return "";
  return factory(mockTui(), markerTheme).render(120).join("\n");
}

/**
 * No payload sequence survived into the output. Checked against the specific
 * introducers rather than "any ESC" — the layout helpers emit their own SGR
 * resets, which are ours and legitimate.
 */
function expectInert(output: string): void {
  expect(output).not.toContain("\x1b[2J");
  expect(output).not.toContain("\x1b]");
  expect(output).not.toContain("\x07");
  expect(output).not.toContain("\u009b");
  expect(output).not.toContain("\u202e");
}

describe("rendered surfaces neutralize child-derived text", () => {
  it("keeps a poisoned tool result inert in the conversation viewer, still dim-styled", () => {
    const output = renderViewer([
      { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: `${CSI_CLEAR}${OSC8_LINK} ${RTL_SANDWICH}` }] },
    ]);

    expectInert(output);
    expect(output).not.toContain("evil.example");
    expect(output).toContain("click me");
    expect(output).toContain("<dim>");
  });

  it("neutralizes poisoned user, assistant and bash messages too", () => {
    const output = renderViewer([
      { role: "user", content: `${C1_CLEAR}ask` },
      { role: "assistant", content: [{ type: "text", text: `${CSI_CLEAR}reply` }, { type: "toolCall", name: `bash${CSI_CLEAR}` }] },
      {
        role: "bashExecution", command: `echo ${CSI_CLEAR}`, output: `${OSC8_LINK}\n${RTL_SANDWICH}`,
        exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(),
      },
    ]);

    expectInert(output);
    expect(output).toContain("ask");
    expect(output).toContain("reply");
    expect(output).toContain("[U+202E]");
  });

  it("renders a NUL blob in a tool result as the binary placeholder", () => {
    const output = renderViewer([
      { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "\0\0\0\0\0payload" }] },
    ]);

    expect(output).toContain("binary content omitted");
    expect(output).not.toContain("\0");
  });

  it("keeps CJK and emoji readable in the viewer", () => {
    const output = renderViewer([{ role: "user", content: "日本語 🚀" }]);

    expect(output).toContain("日本語");
    expect(output).toContain("🚀");
  });

  it("neutralizes the header description while keeping our own muted styling", () => {
    const output = renderViewer([], mockRecord({ description: `head${CSI_CLEAR}line` }));

    expectInert(output);
    expect(output).toContain("<muted>head line");
  });

  it("neutralizes the activity preview drawn from a child's own response text", () => {
    // The preview is whatever the child last said, so it is the one line that
    // carries child-authored bytes into the parent verbatim.
    const output = describeActivity(new Map(), `${OSC8_LINK} ${RTL_SANDWICH}`);

    expectInert(output);
    expect(output).toContain("click me");
  });

  it("neutralizes a tool name reported by the child", () => {
    const output = describeActivity(new Map([["call-1", `bash${CSI_CLEAR}`]]));

    expectInert(output);
    expect(output).toContain("bash");
  });

  it("neutralizes the fleet row description while keeping its own styling", () => {
    const output = renderFleet([
      mockRecord({ id: "f1", description: `fleet${CSI_CLEAR}row`, session: { subscribe: () => () => {}, messages: [] } as never }),
    ]);

    expectInert(output);
    expect(output).toContain("fleet row");
  });
});
