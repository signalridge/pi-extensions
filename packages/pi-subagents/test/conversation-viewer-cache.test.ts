import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type * as PiTui from "@earendil-works/pi-tui";
import type * as PiUi from "@signalridge/pi-ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecordSnapshot } from "../src/types.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";
import type * as SafeText from "../src/ui/safe-text.js";

const work = vi.hoisted(() => ({ sanitizes: 0, labels: 0, fits: 0, wraps: 0, markdown: 0, fail: false }));
vi.mock("../src/ui/safe-text.js", async importOriginal => {
  const original = await importOriginal<typeof SafeText>();
  return { ...original, safeTerminalText: (text: string) => { work.sanitizes++; return original.safeTerminalText(text); } };
});
vi.mock("@signalridge/pi-ui", async importOriginal => {
  const original = await importOriginal<typeof PiUi>();
  return { ...original, sanitizeDisplayText: (text: string) => { work.labels++; return original.sanitizeDisplayText(text); } };
});
vi.mock("@earendil-works/pi-tui", async importOriginal => {
  const original = await importOriginal<typeof PiTui>();
  return {
    ...original,
    truncateToWidth: (...args: Parameters<typeof original.truncateToWidth>) => { work.fits++; return original.truncateToWidth(...args); },
    wrapTextWithAnsi: (text: string, width: number) => { work.wraps++; return original.wrapTextWithAnsi(text, width); },
    Markdown: class extends original.Markdown {
      override render(width: number): string[] { work.markdown++; if (work.fail) throw new Error("parser failure"); return super.render(width); }
    },
  };
});

type Block = { type: "text"; text: string } | { type: "toolCall"; name: string };
type TestMessage = { role: "user" | "assistant" | "toolResult" | "bashExecution"; content?: string | Block[]; command?: string; output?: string };
type CachedLayout = { lines: string[]; fitted?: { width: number; lines: string[]; padded: (string | undefined)[] }; sourceLength: number; next?: { block: number; offset: number }; raw: { calls: string[]; text: string }; failed: boolean };
type Internals = {
  buildContentLines: (width: number) => string[];
  layouts: Map<TestMessage, CachedLayout>;
  pages: Map<TestMessage, { cursor: { block: number; offset: number }; row: number }>;
  rowAnchors: ({ message: TestMessage; index: number; row: number } | undefined)[];
};
function fixture(messages: TestMessage[]) {
  const terminal = { rows: 40, columns: 120 };
  const tui = { mode: "fullscreen", terminal, requestRender: vi.fn() } as unknown as PiTui.TUI;
  const session = { messages, subscribe: () => vi.fn() } as unknown as AgentSession;
  const record = { id: "cache", type: "Explore", description: "Observe", status: "completed", startedAt: 1, completedAt: 1, toolUses: 0, compactionCount: 0 } as AgentRecordSnapshot;
  const viewer = new ConversationViewer(tui, session, record, undefined, { fg: (_color, text) => text, bold: text => text }, vi.fn());
  const state = viewer as unknown as Internals;
  const content = (width = 118) => state.buildContentLines(width);
  return { viewer, state, content, messages, terminal, record };
}
function freshContent(messages: TestMessage[], width = 118): string[] {
  const f = fixture(messages);
  try { return f.content(width); } finally { f.viewer.dispose(); }
}
beforeEach(() => { work.sanitizes = 0; work.labels = 0; work.fits = 0; work.wraps = 0; work.markdown = 0; work.fail = false; });

describe("bounded raw projection and second-stage fitting caches", () => {
  it("does no idle sanitization, tool-label processing, wrapping, Markdown or message-row fitting", () => {
    const f = fixture([
      { role: "user", content: "question\n界e\u0301" },
      { role: "assistant", content: [{ type: "text", text: "**answer**" }, { type: "toolCall", name: "read\u202e" }] },
      { role: "toolResult", content: [{ type: "text", text: "result" }] },
      { role: "bashExecution", command: "printf hello", output: "hello" },
    ]);
    try {
      const original = f.content();
      const counts = { ...work };
      const cached = [...f.state.layouts.values()].map(entry => entry.fitted);
      for (let i = 0; i < 20; i++) expect(f.content()).toEqual(original);
      expect({ ...work, fits: counts.fits }).toEqual(counts);
      expect(work.fits - counts.fits).toBe(20 * 3); // Only the three inter-message separators.
      expect([...f.state.layouts.values()].map(entry => entry.fitted)).toEqual(cached);
      for (const [index, entry] of [...f.state.layouts.values()].entries()) expect(entry.fitted).toBe(cached[index]);
    } finally { f.viewer.dispose(); }
  });

  it("reuses only visible transcript padding while status, description and navigation stay live", () => {
    const message: TestMessage = { role: "user", content: Array.from({ length: 100 }, (_, i) => `row-${i}`).join("\n") };
    const f = fixture([message]);
    try {
      const output = f.viewer.render(120);
      const fitted = f.state.layouts.get(message)!.fitted!;
      const before = work.fits;
      expect(f.viewer.render(120)).toEqual(output);
      expect(work.fits - before).toBe(3); // Header, rule and footer only; no transcript fitting.
      expect(f.state.layouts.get(message)!.fitted).toBe(fitted);
      f.record.status = "running"; f.record.description = "changed description";
      const updated = f.viewer.render(120).join("\n");
      expect(updated).toContain("running"); expect(updated).toContain("changed description");
      expect(f.state.layouts.get(message)!.fitted).toBe(fitted);
      f.viewer.handleInput("k"); expect(f.viewer.render(120)).not.toEqual(output);
      f.terminal.columns = 70; f.viewer.render(70);
      expect(f.state.layouts.get(message)!.fitted).not.toBe(fitted);
      expect(f.state.layouts.get(message)!.fitted?.width).toBe(68);
    } finally { f.viewer.dispose(); }
  });

  it("refreshes in-place string/block append, replacement, truncation, role, tool names and commands with fresh-view parity", () => {
    const blocks: Block[] = [{ type: "text", text: "initial" }, { type: "toolCall", name: "a\0b" }, { type: "toolCall", name: "c" }];
    const user: TestMessage = { role: "user", content: "question" };
    const assistant: TestMessage = { role: "assistant", content: blocks };
    const bash: TestMessage = { role: "bashExecution", command: "echo first", output: "first" };
    const f = fixture([user, assistant, bash]);
    try {
      f.content();
      const changes = [
        () => { user.content += " appended"; },
        () => { user.content = "replaced\x1b[2J\u202e"; },
        () => { user.content = "short"; },
        () => { blocks[0] = { type: "text", text: "initial appended" }; },
        () => { if (blocks[0].type === "text") blocks[0].text = "replacement\u202e\x1b]52;c;secret\x07"; },
        // These arrays have the same NUL-joined raw key, but are not the same tool labels.
        () => { if (blocks[1].type === "toolCall") blocks[1].name = "a"; if (blocks[2].type === "toolCall") blocks[2].name = "b\0c"; },
        () => { blocks.push({ type: "toolCall", name: "last\u202e" }); },
        () => { blocks.splice(1); },
        () => { bash.command = "echo changed\x1b[2J\u202e"; bash.output += " appended"; },
        () => { user.role = "assistant"; },
      ];
      for (const change of changes) {
        change();
        expect(f.content()).toEqual(freshContent(f.messages));
        expect(f.state.layouts.size).toBe(3);
      }
      const output = f.content().join("\n");
      expect(output).not.toContain("\u202e"); expect(output).not.toContain("\x1b[2J"); expect(output).not.toContain("\x1b]52");
    } finally { f.viewer.dispose(); }
  });

  it("uses the original sanitized signature on a raw difference and updates the next raw fast hit", () => {
    const block: Block = { type: "text", text: "\x1b[31msame" };
    const message: TestMessage = { role: "assistant", content: [block] };
    const f = fixture([message]);
    try {
      const original = f.content(); const cached = f.state.layouts.get(message);
      expect(work.markdown).toBe(1);
      block.text = "\x1b[32msame";
      expect(f.content()).toEqual(original); expect(work.sanitizes).toBe(2); expect(work.markdown).toBe(1);
      expect(f.state.layouts.get(message)).toBe(cached);
      f.content(); expect(work.sanitizes).toBe(2); expect(work.markdown).toBe(1);
      message.content = [{ type: "text", text: "a".repeat(10_000) }]; f.content();
      const entry = f.state.layouts.get(message)!; const renders = work.markdown; const sanitizes = work.sanitizes;
      message.content[0] = { type: "text", text: "a".repeat(11_000) }; f.content();
      expect(f.state.layouts.get(message)).toBe(entry); expect(entry.sourceLength).toBe(11_000);
      expect(entry.next).toEqual({ block: 0, offset: 1_887 }); expect(work.sanitizes).toBe(sanitizes);
      message.content[0] = { type: "text", text: "a".repeat(9_000) }; f.content();
      expect(work.markdown).toBe(renders + 1); // Shortening must not take either cache hit.
      expect(f.state.layouts.get(message)).not.toBe(entry);
    } finally { f.viewer.dispose(); }
  });

  it("keeps failed-Markdown fallback behavior across raw fast hits, append and replacement", () => {
    const block: Block = { type: "text", text: "# failing" };
    const message: TestMessage = { role: "assistant", content: [block] };
    const f = fixture([message]);
    try {
      work.fail = true; f.content(); f.content();
      expect(work.markdown).toBe(1); expect(work.wraps).toBe(1);
      block.text += " appended"; expect(f.content().join("\n")).toContain("appended");
      expect(work.markdown).toBe(1); expect(work.wraps).toBe(2);
      block.text = "# replacement"; f.content(); expect(work.markdown).toBe(2);
      f.record.compactionCount++; f.content(); expect(work.markdown).toBe(3);
      f.viewer.invalidate(); f.content(); expect(work.markdown).toBe(4);
    } finally { f.viewer.dispose(); }
  });

  it("retains the selected raw cursor on mutation/reflow/compaction and resets a shortened source", () => {
    const message: TestMessage = { role: "user", content: "a".repeat(1_888) + "PAGE_TWO" + "b".repeat(3_000) };
    const f = fixture([{ role: "user", content: "earlier" }, message]);
    try {
      f.viewer.render(120); f.viewer.handleInput("\x1b[H"); f.viewer.handleInput("]");
      expect(f.content().join("\n")).toContain("PAGE_TWO");
      const cursor = { ...f.state.pages.get(message)!.cursor };
      message.content = "a".repeat(1_888) + "CHANGED\u202e" + "b".repeat(3_000);
      expect(f.content().join("\n")).toContain("CHANGED[U+202E]");
      f.messages.splice(0, 1); f.record.compactionCount++;
      expect(f.content().join("\n")).toContain("CHANGED[U+202E]");
      expect(f.state.pages.get(message)?.cursor).toEqual(cursor);
      const prior = f.state.layouts.get(message);
      f.terminal.columns = 70; f.viewer.render(70);
      expect(f.state.pages.get(message)?.cursor).toEqual(cursor);
      expect(f.state.layouts.get(message)).not.toBe(prior);
      message.content = "short\u202e";
      expect(f.content(68).join("\n")).toContain("short[U+202E]");
      expect(f.state.pages.has(message)).toBe(false);
    } finally { f.viewer.dispose(); }
  });

  it("bounds layouts/fitted rows/anchors through message and row-budget eviction, resize and teardown", () => {
    const f = fixture(Array.from({ length: 200 }, (_, index) => ({ role: "user", content: `message-${index}\n${"line\n".repeat(200)}` })));
    try {
      for (const width of [118, 3, 68]) {
        f.content(width);
        expect(f.state.layouts.size).toBeLessThanOrEqual(64);
        expect(f.state.rowAnchors.length).toBeLessThanOrEqual(4_096);
        const admitted = new Set(f.state.rowAnchors.flatMap(row => row ? [row.message] : []));
        expect(new Set(f.state.layouts.keys())).toEqual(admitted); // No hidden boundary candidate or stale window retained.
        for (const entry of f.state.layouts.values()) {
          expect(entry.lines.length).toBeLessThanOrEqual(256);
          expect(entry.fitted?.lines.length).toBe(entry.lines.length);
          expect(entry.fitted?.padded.length).toBeLessThanOrEqual(entry.lines.length);
          expect(entry.raw.text.length).toBeLessThanOrEqual(8_192);
        }
      }
      f.messages.splice(0, 199); f.record.compactionCount++; f.content();
      expect(f.state.layouts.size).toBe(1);
      f.viewer.invalidate(); expect(f.state.layouts.size).toBe(0);
    } finally { f.viewer.dispose(); }
    expect(f.state.layouts.size).toBe(0); expect(f.state.pages.size).toBe(0); expect(f.state.rowAnchors).toEqual([]);
  });
});
