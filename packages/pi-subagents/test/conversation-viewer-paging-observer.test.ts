import type { AgentSession, AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import * as PiTui from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecordSnapshot } from "../src/types.js";
import { ConversationViewer, getConversationOverlayOptions } from "../src/ui/conversation-viewer.js";

const layout = vi.hoisted(() => ({ renders: 0, inputs: [] as string[] }));
vi.mock("@earendil-works/pi-tui", async importOriginal => {
  const original = await importOriginal<typeof PiTui>();
  return { ...original, Markdown: class extends original.Markdown {
    override render(width: number): string[] { layout.renders++; return super.render(width); }
    override setText(text: string): void { layout.inputs.push(text); super.setText(text); }
  } };
});
type TestMessage = { role: "user"; content: string } | { role: "assistant" | "toolResult"; content: ({ type: "text"; text: string } | { type: "toolCall"; name: string })[] };
const user = (content: string): TestMessage => ({ role: "user", content });
const assistant = (text: string): TestMessage => ({ role: "assistant", content: [{ type: "text", text }] });
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
function fixture(messages: TestMessage[], rows = 40, columns = 120) {
  let input = (_data: string) => {};
  let listener: AgentSessionEventListener = () => {};
  const unsubscribe = vi.fn(); const getSessionStats = vi.fn();
  const terminal: PiTui.Terminal = {
    rows, columns, kittyProtocolActive: false,
    start: callback => { input = callback; }, stop: vi.fn(), drainInput: async () => {}, write: vi.fn(),
    moveBy: vi.fn(), hideCursor: vi.fn(), showCursor: vi.fn(), clearLine: vi.fn(), clearFromCursor: vi.fn(), clearScreen: vi.fn(), setTitle: vi.fn(), setProgress: vi.fn(), setProgramStatus: vi.fn(),
  };
  const tui = new PiTui.TuiAltScreen(terminal);
  const editor = new PiTui.Input(); editor.setValue("root draft");
  const root = new PiTui.ScrollView(new PiTui.Text("root\n".repeat(100)));
  tui.setLayoutRoot(new PiTui.VStack([{ component: root, flex: 1 }, editor])); tui.setFocus(editor);
  const session = { messages, getSessionStats, subscribe: (callback: AgentSessionEventListener) => { listener = callback; return unsubscribe; } } as unknown as AgentSession;
  const record = { id: "paging", type: "Explore", description: "Observe", status: "running", startedAt: Date.now(), toolUses: 0, compactionCount: 0 } as AgentRecordSnapshot;
  const stop = vi.fn(); const steer = vi.fn(); const handoff = vi.fn(() => true);
  const viewer = new ConversationViewer(tui, session, record, undefined, theme, vi.fn(), stop, undefined, steer, () => record, { canHandoff: () => true, onHandoff: handoff });
  tui.start(); tui.renderNow(); root.scrollTo(25, { disableFollow: true }); tui.renderNow();
  const rootPosition = root.scrollTop;
  const handle = tui.showOverlay(viewer, getConversationOverlayOptions(tui)); tui.renderNow();
  const render = () => viewer.render(terminal.columns).map(PiTui.stripTerminalSequences);
  const text = () => render().join("\n");
  const key = (data: string) => { input(data); tui.renderNow(); };
  const click = (label: string) => {
    const lines = render(); const y = lines.findIndex(line => line.includes(label)); expect(y).toBeGreaterThanOrEqual(0);
    const x = PiTui.visibleWidth(lines[y].slice(0, lines[y].indexOf(label)));
    key(`\x1b[<0;${x + 1};${y + 1}M`); key(`\x1b[<0;${x + 1};${y + 1}m`);
  };
  const emit = () => listener({ type: "message_start", message: messages.at(-1)! } as Parameters<AgentSessionEventListener>[0]);
  const dispose = () => { viewer.dispose(); tui.stop(); };
  return { messages, terminal, tui, viewer, record, session, unsubscribe, getSessionStats, editor, root, rootPosition, handle, render, text, key, click, emit, dispose, stop, steer, handoff };
}
beforeEach(() => { layout.renders = 0; layout.inputs = []; });

describe("owned observer paging targets", () => {
  it("retains an explicitly paged target across bounded history-window eviction", () => {
    const target = assistant("SELECTED_START" + "a".repeat(12_000) + "SELECTED_END");
    const f = fixture([...Array.from({ length: 100 }, (_, i) => assistant(`old-${i}`)), target]);
    try {
      f.key("]"); expect(f.text()).toContain("Text #101 assistant");
      for (let i = 0; i < 300; i++) f.key("k");
      expect(f.text()).toContain("old-0");
      f.key("]");
      expect(f.text()).toContain("Text #101 assistant");
      expect(f.text()).not.toContain("SELECTED_START");
      expect(f.messages[100]).toBe(target);
    } finally { f.dispose(); }
  });

  it("does not skip unread sanitized text after rendered-row paging and widening", () => {
    const source = "\u202e".repeat(70) + "x".repeat(50) + "UNSEEN" + "z".repeat(2_000);
    const f = fixture([user(source)], 300, 3);
    try {
      f.key("\x1b[H"); f.key("]");
      expect(f.text()).not.toContain("UNSEEN");
      f.terminal.columns = 120; f.terminal.rows = 40; f.tui.renderNow();
      let reached = f.text().includes("UNSEEN");
      for (let i = 0; i < 5; i++) { f.key("]"); reached ||= f.text().includes("UNSEEN"); }
      expect(reached).toBe(true);
      expect(f.messages[0]).toEqual(user(source));
    } finally { f.dispose(); }
  });

  it("resumes the exact next source page and restores first-page navigation after eviction", () => {
    // Fullscreen 120 columns gives 118 content columns and 1,887 raw units per block page.
    const chunk = (label: string) => label + "a".repeat(1_887 - label.length);
    const target = assistant(chunk("PAGE_ONE") + chunk("PAGE_TWO") + chunk("PAGE_THREE") + "FINAL_PAGE");
    const f = fixture([...Array.from({ length: 100 }, (_, i) => assistant(`old-${i}`)), target]);
    try {
      f.key("]"); expect(f.text()).toContain("PAGE_TWO");
      for (let i = 0; i < 300; i++) f.key("k");
      expect(f.text()).toContain("old-0"); expect(f.text()).toContain("Text #101 assistant");
      const renders = layout.renders;
      f.render(); expect(layout.renders).toBe(renders); // no off-window layout work.
      f.key("]"); expect(f.text()).toContain("PAGE_THREE"); expect(f.text()).not.toContain("PAGE_TWO");
      expect(layout.renders - renders).toBeLessThanOrEqual(65); // bounded restore plus the next page.
      for (let i = 0; i < 300; i++) f.key("k");
      f.key("["); expect(f.text()).toContain("PAGE_ONE");
      expect(f.messages[100]).toBe(target);
    } finally { f.dispose(); }
  });

  it("retains an evicted exhausted selection across compaction without paging another message", () => {
    const target = assistant("a".repeat(1_887) + "EXHAUSTED_TARGET");
    const f = fixture([assistant("OTHER_START" + "b".repeat(5_000)), ...Array.from({ length: 100 }, (_, i) => assistant(`old-${i}`)), target]);
    try {
      f.key("]"); expect(f.text()).toContain("EXHAUSTED_TARGET");
      for (let i = 0; i < 400; i++) f.key("k");
      expect(f.text()).toContain("OTHER_START");
      f.messages.splice(1, 1); f.record.compactionCount++; f.emit();
      expect(f.text()).toContain("Text #101 assistant");
      f.key("]"); expect(f.text()).toContain("EXHAUSTED_TARGET"); expect(f.text()).not.toContain("OTHER_START");
      for (let i = 0; i < 400; i++) f.key("k");
      f.messages.pop(); f.record.compactionCount++; f.emit();
      expect(f.text()).not.toContain("Text #101 assistant");
      f.key("]"); expect(f.text()).toContain("Text #1 assistant"); expect(f.text()).not.toContain("OTHER_START");
    } finally { f.dispose(); }
  });

  it("resets wrapping rows but retains raw block offsets across narrow/wide reflow", () => {
    const message: TestMessage = { role: "assistant", content: [
      { type: "text", text: "PREFIX" + "界".repeat(2_000) },
      { type: "text", text: "\u202e".repeat(70) + "x".repeat(50) + "UNSEEN" + "z".repeat(2_000) },
      { type: "toolCall", name: "FINAL_TOOL" },
    ] };
    const f = fixture([message]);
    try {
      f.key("\x1b[H"); f.key("]"); expect(f.text()).not.toContain("PREFIX");
      f.terminal.columns = 3; f.terminal.rows = 300; f.tui.renderNow();
      expect(f.text()).not.toContain("PREFIX");
      f.key("]"); // advance the raw cursor into block 1.
      f.key("]"); // advance wrapping rows within its sanitized source chunk.
      f.terminal.columns = 120; f.terminal.rows = 40; f.tui.renderNow();
      expect(f.text()).not.toContain("PREFIX");
      let unseen = f.text().includes("UNSEEN"); let tool = f.text().includes("Tool: FINAL_TOOL");
      for (let i = 0; i < 8; i++) { f.key("]"); unseen ||= f.text().includes("UNSEEN"); tool ||= f.text().includes("Tool: FINAL_TOOL"); }
      expect(unseen).toBe(true); expect(tool).toBe(true);
      expect(f.render().every(line => PiTui.visibleWidth(line) <= 120)).toBe(true);
      expect(layout.inputs.every(text => text.length <= 8_192)).toBe(true);
      expect(f.messages[0]).toBe(message);
    } finally { f.dispose(); }
  });

  it("reaches every assistant source page when a short prompt and bounded preview fit fullscreen 40x120", () => {
    const source = "a".repeat(30_000) + "ASSISTANT_TAIL";
    const f = fixture([user("prompt"), assistant(source)]);
    try {
      expect(f.handle.getBounds()).toEqual({ row: 0, col: 0, width: 120, height: 40 });
      expect(f.text()).toContain("prompt"); expect(f.text()).toContain("more available");
      expect(f.render().some(line => line.endsWith("┃"))).toBe(false);
      f.key("]");
      expect(f.text()).toContain("Text #2 assistant"); // selection is independent of the first visible user.
      let reached = false;
      for (let i = 0; i < 25; i++) { reached ||= f.text().includes("ASSISTANT_TAIL"); f.key("]"); }
      expect(reached).toBe(true); expect(layout.inputs.join("")).toBe(source);
      f.key("["); expect(f.text()).toContain("aaa");
      expect(f.messages).toEqual([user("prompt"), assistant(source)]);
      expect(f.root.scrollTop).toBe(f.rootPosition); expect(f.editor.getValue()).toBe("root draft");
      expect(layout.inputs.every(text => text.length <= 8_192)).toBe(true);
    } finally { f.dispose(); }
  });

  it("preserves top-message priority and never falls through from an exhausted selected page", () => {
    const f = fixture([user("U".repeat(3_000) + "USER_TAIL"), assistant("A".repeat(9_000) + "OTHER_TAIL")], 60);
    try {
      expect(f.text()).toContain("Text #1 user");
      const renders = layout.renders;
      f.key("]"); expect(f.text()).toContain("USER_TAIL");
      for (let i = 0; i < 8; i++) f.key("]");
      expect(f.text()).toContain("Text #1 user"); expect(f.text()).not.toContain("OTHER_TAIL");
      expect(layout.renders).toBe(renders); // no assistant page was silently chosen.
      f.key("["); expect(f.text()).toContain("UUU");
      f.key("\t"); expect(f.text()).toContain("Text #2 assistant");
      for (let i = 0; i < 8; i++) f.key("]");
      expect(f.text()).toContain("OTHER_TAIL");
    } finally { f.dispose(); }
  });

  it("selects multiple visible long messages with Tab/Shift+Tab and native mouse press without paging on release", () => {
    const f = fixture([user("prompt"), assistant("FIRST_START" + "a".repeat(4_000) + "FIRST_TAIL"), assistant("SECOND_START" + "b".repeat(4_000) + "SECOND_TAIL")], 60);
    try {
      expect(f.text()).toContain("Text #2 assistant"); expect(f.text()).toContain("Tab/Shift+Tab target");
      f.key("\t"); expect(f.text()).toContain("Text #3 assistant");
      f.key("\x1b[Z"); expect(f.text()).toContain("Text #2 assistant");
      f.click("SECOND_START"); expect(f.text()).toContain("Text #3 assistant"); expect(f.text()).toContain("SECOND_START");
      for (let i = 0; i < 4; i++) f.key("]");
      expect(f.text()).toContain("SECOND_TAIL"); expect(f.text()).toContain("FIRST_START");
      f.key("\t"); expect(f.text()).toContain("Text #2 assistant");
      for (let i = 0; i < 4; i++) f.key("]");
      expect(f.text()).toContain("FIRST_TAIL"); expect(f.text()).toContain("SECOND_TAIL");
      f.key("["); expect(f.text()).toContain("FIRST_START"); expect(f.text()).toContain("SECOND_TAIL");
    } finally { f.dispose(); }
  });

  it("keeps an explicit target and source cursor by identity across append, resize and retained-message compaction", () => {
    const target = assistant("START" + "a".repeat(5_000) + "SELECTED_TAIL");
    const f = fixture([user("prompt"), assistant("other" + "b".repeat(9_000)), target], 60);
    try {
      f.key("\t"); f.key("]"); expect(f.text()).toContain("Text #3 assistant"); expect(f.text()).not.toContain("START");
      f.messages.push(assistant("NEW" + "z".repeat(10_000))); f.emit();
      expect(f.text()).toContain("Text #3 assistant");
      f.terminal.columns = 80; f.terminal.rows = 40; f.tui.renderNow();
      expect(f.text()).toContain("Text #3 assistant"); expect(f.text()).not.toContain("START");
      f.messages.splice(0, 1); f.record.compactionCount++; f.emit();
      expect(f.text()).toContain("Text #2 assistant");
      let reached = false;
      for (let i = 0; i < 8; i++) { f.key("]"); reached ||= f.text().includes("SELECTED_TAIL"); }
      expect(reached).toBe(true); expect(f.text()).toContain("Text #2 assistant");
      expect(f.text()).toContain("NEW"); // appended message is still on its first source page.
      f.key("["); expect(f.text()).toContain("START");
    } finally { f.dispose(); }
  });

  it("does not let viewport scrolling replace an explicit target that still has continuation", () => {
    const f = fixture([user("prompt"), assistant("FIRST" + "a".repeat(5_000)), assistant("SECOND" + "b".repeat(5_000))]);
    try {
      f.click("SECOND");
      for (let i = 0; i < 15; i++) f.key("k");
      expect(f.text()).toContain("FIRST"); expect(f.text()).toContain("Text #3 assistant");
      f.key("]"); expect(f.text()).toContain("FIRST"); expect(f.text()).not.toContain("SECOND");
      expect(f.text()).toContain("Text #3 assistant");
    } finally { f.dispose(); }
  });

  it("clears a removed target instead of attaching its cursor to a replacement at the same index", () => {
    const f = fixture([user("prompt"), assistant("a".repeat(8_000))]);
    try {
      f.key("]");
      f.messages[1] = assistant("REPLACEMENT_START" + "b".repeat(3_000) + "REPLACEMENT_TAIL"); f.record.compactionCount++; f.emit();
      expect(f.text()).toContain("REPLACEMENT_START");
      for (let i = 0; i < 3; i++) f.key("]");
      expect(f.text()).toContain("REPLACEMENT_TAIL");
    } finally { f.dispose(); }
  });

  // This pressure case keeps 25×80 native key dispatches and their rendering;
  // budget the measured host frame work separately from production deadlines.
  it("reaches source tails and every tool label after a short prompt without truncating history", () => {
    const message: TestMessage = { role: "assistant", content: [
      { type: "text", text: "a".repeat(30_000) + "SOURCE_TAIL" },
      ...Array.from({ length: 70 }, (_, i) => ({ type: "toolCall" as const, name: `tool_${String(i).padStart(3, "0")}` })),
    ] };
    const f = fixture([user("prompt"), message]);
    try {
      const seen = new Set<number>(); let tail = false;
      for (let page = 0; page < 25; page++) {
        f.key("]");
        for (let scroll = 0; scroll < 80; scroll++) {
          const text = f.text(); tail ||= text.includes("SOURCE_TAIL");
          for (const match of text.matchAll(/Tool: tool_(\d+)/g)) seen.add(Number(match[1]));
          f.key("j");
        }
      }
      expect(tail).toBe(true); expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 70 }, (_, i) => i));
      expect(f.messages).toHaveLength(2); expect(f.messages[1]).toBe(message);
      expect(layout.inputs.every(text => text.length <= 8_192)).toBe(true);
    } finally { f.dispose(); }
  }, 20_000);

  it("pages a continuation in an older bounded window and preserves Home/End and root controls", () => {
    const f = fixture([user("old prompt"), assistant("a".repeat(6_000) + "OLD_TAIL"), ...Array.from({ length: 150 }, (_, i) => assistant(`message-${i}`))]);
    try {
      expect(f.text()).toContain("message-149"); expect(layout.renders).toBeLessThanOrEqual(64);
      f.key("\x1b[H"); expect(f.text()).toContain("old prompt"); expect(f.text()).toContain("Text #2 assistant");
      let reached = false;
      for (let i = 0; i < 8; i++) { f.key("]"); reached ||= f.text().includes("OLD_TAIL"); }
      expect(reached).toBe(true); expect(f.messages).toHaveLength(152);
      f.key("\x1b[H"); expect(f.text()).toContain("old prompt"); expect(f.text()).not.toContain("OLD_TAIL");
      f.key("\x1b[F"); expect(f.text()).toContain("message-149");
      f.key("b"); f.key("b"); f.key("\r"); expect(f.handoff).not.toHaveBeenCalled();
      f.key("\x1b"); f.key("x"); f.key("\t"); f.key("y"); expect(f.stop).not.toHaveBeenCalled();
      f.key("x"); f.key("y"); expect(f.stop).toHaveBeenCalledTimes(1);
      expect(f.root.scrollTop).toBe(f.rootPosition); expect(f.editor.getValue()).toBe("root draft");
    } finally { f.dispose(); }
  });

  it.each([[8, 40], [3, 40], [1, 40], [20, 8]])("reaches available continuation at %i columns and %i rows", (columns, rows) => {
    const source = "a".repeat(450) + "Z";
    const f = fixture([user("p"), assistant(source)], rows, columns);
    try {
      f.key("\x1b[H");
      let reached = false;
      for (let i = 0; i < 12; i++) {
        f.key("]");
        for (let j = 0; j < 40; j++) { reached ||= f.text().includes("Z"); f.key("j"); }
      }
      expect(reached).toBe(true);
      expect(f.render()).toHaveLength(rows); expect(f.render().every(line => PiTui.visibleWidth(line) <= columns)).toBe(true);
      expect(f.messages[1]).toEqual(assistant(source));
    } finally { f.dispose(); }
  });

  it("pages rendered-row overflow before advancing source, including tool labels at width 3", () => {
    const f = fixture([user("p"), { role: "assistant", content: [
      { type: "text", text: "\u202e".repeat(70) + "x".repeat(50) }, { type: "toolCall", name: "LAST_TOOL" },
    ] }], 300, 3);
    try {
      expect(f.text()).toContain(">"); expect(layout.inputs.some(text => text.length > 254)).toBe(true);
      f.key("]"); expect(f.text()).toContain(">");
      f.key("]"); expect(f.text()).toContain("T"); expect(f.text()).toContain("L");
      expect(f.render().every(line => PiTui.visibleWidth(line) === 3)).toBe(true);
      f.key("["); expect(f.text()).toContain(">");
    } finally { f.dispose(); }
  });

  it("does not rescan idle pages or poll model/history state and leaves composer/IME ownership intact", () => {
    const f = fixture([user("prompt"), assistant("a".repeat(2_000_000))]);
    try {
      f.key("]"); const renders = layout.renders;
      for (let i = 0; i < 20; i++) f.render();
      f.messages.push(user("appended")); f.emit(); f.render();
      expect(layout.renders).toBe(renders); expect(f.getSessionStats).not.toHaveBeenCalled();
      f.key("\r"); f.key("界e\u0301[]"); f.key("\t");
      expect(f.viewer.render(120).join("\n")).toContain(PiTui.CURSOR_MARKER);
      expect(f.text()).toContain("Enter send");
      f.key("\r"); expect(f.steer).toHaveBeenCalledExactlyOnceWith("界e\u0301[]");
      expect(f.editor.getValue()).toBe("root draft");
    } finally { f.dispose(); }
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
