import type { AgentSession } from "@earendil-works/pi-coding-agent";
import * as PiTui from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecordSnapshot } from "../src/types.js";
import { ConversationViewer, getConversationOverlayOptions, getConversationViewerMode, type ViewerOptions } from "../src/ui/conversation-viewer.js";

const layouts = vi.hoisted(() => ({ renders: 0, inputs: [] as string[] }));
vi.mock("@earendil-works/pi-tui", async importOriginal => {
  const original = await importOriginal<typeof PiTui>();
  return { ...original, Markdown: class extends original.Markdown {
    override render(width: number): string[] { layouts.renders++; return super.render(width); }
    override setText(text: string): void { layouts.inputs.push(text); super.setText(text); }
  } };
});

type TestMessage = { role: "user"; content: string } | { role: "assistant"; content: ({ type: "text"; text: string } | { type: "toolCall"; name: string })[] };
const user = (content: string): TestMessage => ({ role: "user", content });
const assistant = (text: string): TestMessage => ({ role: "assistant", content: [{ type: "text", text }] });
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
function fixture(messages: TestMessage[] = [user("history")], options: ViewerOptions = {}, native: "fullscreen" | "regular" | undefined = undefined, keybindings?: PiTui.KeybindingsManager) {
  let input = (_data: string) => {};
  const terminal: PiTui.Terminal = {
    rows: 20, columns: 120, kittyProtocolActive: false,
    start: callback => { input = callback; }, stop: vi.fn(), drainInput: async () => {}, write: vi.fn(),
    moveBy: vi.fn(), hideCursor: vi.fn(), showCursor: vi.fn(), clearLine: vi.fn(), clearFromCursor: vi.fn(), clearScreen: vi.fn(), setTitle: vi.fn(), setProgress: vi.fn(), setProgramStatus: vi.fn(),
  };
  const tui = native === "regular" ? new PiTui.TuiMainScreen(terminal) : native === "fullscreen" ? new PiTui.TuiAltScreen(terminal) : { mode: "fullscreen", terminal, requestRender: vi.fn() } as unknown as PiTui.TUI;
  const session = { messages, subscribe: () => vi.fn() } as unknown as AgentSession;
  const record = { id: "a", type: "Explore", description: "Observe", status: "running", startedAt: Date.now(), toolUses: 0, compactionCount: 0 } as AgentRecordSnapshot;
  const stop = vi.fn(); const steer = vi.fn(); const done = vi.fn();
  const viewer = new ConversationViewer(tui, session, record, undefined, theme, done, stop, keybindings, steer, () => record, options);
  const render = () => viewer.render(terminal.columns);
  const text = () => render().map(PiTui.stripTerminalSequences).join("\n");
  const mouse = (event: Partial<PiTui.TuiMouseEvent>) => viewer.handleMouse({
    type: "press", button: "left", x: 1, y: 1, screenX: 1, screenY: 1, width: terminal.columns, height: terminal.rows, shift: false, alt: false, ctrl: false, ...event,
  });
  const click = (label: string) => {
    const lines = render().map(PiTui.stripTerminalSequences);
    const y = lines.findIndex(line => line.includes(label)); expect(y).toBeGreaterThanOrEqual(0);
    return mouse({ y, x: PiTui.visibleWidth(lines[y].slice(0, lines[y].indexOf(label))) });
  };
  return { terminal, tui, session, messages, record, stop, steer, done, viewer, render, text, mouse, click, input: (data: string) => input(data) };
}
const firstMessage = (text: string) => text.match(/message-\d+/)?.[0];
beforeEach(() => { layouts.renders = 0; layouts.inputs = []; });

describe("bounded available-history windows", () => {
  it.each([65, 1_000])("reaches the first of %i messages with Home and ordinary page/scroll navigation", count => {
    const f = fixture(Array.from({ length: count }, (_, i) => assistant(`message-${i}`)));
    expect(f.text()).toContain(`message-${count - 1}`);
    expect(layouts.renders).toBeLessThanOrEqual(64);
    f.viewer.handleInput("\x1b[H"); expect(f.text()).toContain("message-0");
    for (let i = 0; i < Math.ceil(count / 3); i++) { f.viewer.handleInput("\x1b[6~"); f.render(); }
    expect(f.text()).toContain(`message-${count - 1}`);
    for (let i = 0; i < Math.ceil(count / 3); i++) { f.viewer.handleInput("\x1b[5~"); f.render(); }
    expect(f.text()).toContain("message-0");
    f.viewer.dispose();
  });

  it("retains the paused message across append, resize, replacement and compaction", () => {
    const f = fixture(Array.from({ length: 150 }, (_, i) => user(`message-${i}`)));
    f.render(); f.viewer.handleInput("\x1b[H");
    for (let i = 0; i < 10; i++) { f.viewer.handleInput("\x1b[6~"); f.render(); }
    const paused = firstMessage(f.text()); expect(paused).toBeDefined();
    f.messages.push(user("new message")); expect(firstMessage(f.text())).toBe(paused);
    f.terminal.columns = 70; expect(firstMessage(f.text())).toBe(paused);
    const index = Number(paused!.split("-")[1]);
    f.messages[index] = user(`${paused} replacement`); expect(firstMessage(f.text())).toBe(paused);
    f.messages.splice(0, index - 2); f.record.compactionCount++;
    expect(firstMessage(f.text())).toBe(paused);
    f.viewer.handleInput("\x1b[F"); expect(f.text()).toContain("new message"); f.viewer.dispose();
  });

  it("does not discard older groups when the active row budget is exhausted", () => {
    const f = fixture(Array.from({ length: 80 }, (_, i) => user(`message-${i}\n${"line\n".repeat(200)}`)));
    f.render(); f.viewer.handleInput("\x1b[H"); expect(f.text()).toContain("message-0");
    let seen = false;
    for (let i = 0; i < 1_000; i++) { f.viewer.handleInput("\x1b[6~"); if (f.text().includes("message-79")) { seen = true; break; } }
    expect(seen).toBe(true); f.viewer.dispose();
  });

  it("pages available source text, blocks and tool labels without losing the continuation marker", () => {
    const f = fixture([{ role: "assistant", content: [
      { type: "text", text: "a".repeat(30_000) + "SOURCE_END" },
      ...Array.from({ length: 70 }, (_, i) => ({ type: "toolCall" as const, name: `tool_${i}` })),
    ] }]);
    f.render(); expect(f.text()).toContain("more available");
    let sourceEnd = false; let finalTool = false;
    for (let i = 0; i < 50; i++) {
      f.viewer.handleInput("]");
      const top = f.text(); sourceEnd ||= top.includes("SOURCE_END"); finalTool ||= top.includes("tool_69");
      for (let row = 0; row < 80; row++) {
        f.viewer.handleInput("j");
        const output = f.text(); sourceEnd ||= output.includes("SOURCE_END"); finalTool ||= output.includes("tool_69");
      }
      // Return to the top of this message, not global Home (which resets its source page).
      for (let row = 0; row < 80; row++) f.viewer.handleInput("k");
      if (finalTool) break;
    }
    expect(sourceEnd).toBe(true); expect(finalTool).toBe(true);
    f.viewer.handleInput("["); expect(f.text()).toContain("aaa");
    expect(layouts.inputs.every(text => text.length <= 8_192)).toBe(true); f.viewer.dispose();
  });

  it("retains a source page on append/resize/compaction and resets an invalid cursor after shortening", () => {
    const message = user("a".repeat(4_000) + "b".repeat(4_000));
    const f = fixture([user("earlier"), message]); f.render(); f.viewer.handleInput("\x1b[F"); f.viewer.handleInput("]");
    const paused = f.text(); expect(paused).toContain("aaa");
    if (message.role === "user") message.content += " appended";
    expect(f.text()).toContain("aaa"); f.terminal.columns = 70; expect(f.text()).toContain("aaa");
    f.messages.splice(0, 1); f.record.compactionCount++; expect(f.text()).toContain("aaa");
    if (message.role === "user") message.content = "short replacement";
    expect(f.text()).toContain("short replacement"); f.viewer.dispose();
  });

  it("pages every source row instead of discarding the tail after 128 newlines", () => {
    const original = Array.from({ length: 350 }, (_, i) => `source-row-${i}`).join("\n");
    const f = fixture([user(original)]);
    f.render(); f.viewer.handleInput("\x1b[H"); expect(f.text()).toContain("source-row-0");
    for (let i = 0; i < 3; i++) f.viewer.handleInput("]");
    let found = f.text().includes("source-row-349");
    for (let i = 0; i < 128; i++) { f.viewer.handleInput("j"); found ||= f.text().includes("source-row-349"); }
    expect(found).toBe(true); expect(f.messages[0]).toEqual(user(original)); f.viewer.dispose();
  });

  it("truthfully pages render-row overflow at width 3, including tool labels", () => {
    const f = fixture([{ role: "assistant", content: [{ type: "text", text: "\u202e".repeat(70) + "x".repeat(50) }, { type: "toolCall", name: "LAST_TOOL" }] }]);
    f.terminal.columns = 3; f.terminal.rows = 300;
    expect(f.text()).toContain(">");
    expect(layouts.inputs.some(text => text.length > 254)).toBe(true); // actual render-row overflow, not just a source cap.
    f.viewer.handleInput("]"); expect(f.text()).toContain(">");
    f.viewer.handleInput("]"); const next = f.text();
    expect(next).toContain("T"); // label is rendered, not silently sliced behind the body.
    expect(f.render().every(line => PiTui.visibleWidth(line) === 3)).toBe(true);
    f.viewer.dispose();
  });
});

describe("distinct-key destructive confirmation", () => {
  it("legacy b/b, x/x and Enter cannot execute controls, y can, Escape cancels", () => {
    const handoff = vi.fn(() => true); const f = fixture(undefined, { canHandoff: () => true, onHandoff: handoff });
    for (let i = 0; i < 30; i++) f.viewer.handleInput("b");
    f.viewer.handleInput("\r"); expect(handoff).not.toHaveBeenCalled(); expect(f.text()).toContain("y confirm background");
    f.viewer.handleInput("y"); expect(handoff).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 30; i++) f.viewer.handleInput("x");
    f.viewer.handleInput("\r"); expect(f.stop).not.toHaveBeenCalled();
    f.viewer.handleInput("\x1b"); expect(f.done).not.toHaveBeenCalled();
    f.viewer.handleInput("y"); expect(f.stop).not.toHaveBeenCalled();
    f.viewer.handleInput("x"); f.viewer.handleInput("y"); expect(f.stop).toHaveBeenCalledTimes(1); f.viewer.dispose();
  });

  it("ignores Kitty confirmation releases/repeats and requires a distinct y press", () => {
    const f = fixture(); f.viewer.handleInput("\x1b[120;1u");
    f.viewer.handleInput("\x1b[120;1:2u"); f.viewer.handleInput("\x1b[120;1u");
    f.viewer.handleInput("\x1b[121;1:3u"); f.viewer.handleInput("\x1b[121;1:2u");
    expect(f.stop).not.toHaveBeenCalled();
    f.viewer.handleInput("\x1b[121;1u"); expect(f.stop).toHaveBeenCalledTimes(1); f.viewer.dispose();
  });

  it("unavailable b disarms stop and falls through to configured pageUp", () => {
    const keybindings = new PiTui.KeybindingsManager(PiTui.TUI_KEYBINDINGS, { "tui.select.pageUp": "b" });
    const f = fixture(Array.from({ length: 30 }, (_, i) => user(`message-${i}`)), {}, undefined, keybindings);
    const bottom = firstMessage(f.text()); f.viewer.handleInput("x"); f.viewer.handleInput("b");
    expect(firstMessage(f.text())).not.toBe(bottom);
    f.viewer.handleInput("x"); expect(f.stop).not.toHaveBeenCalled(); f.viewer.handleInput("y"); expect(f.stop).toHaveBeenCalledTimes(1); f.viewer.dispose();
  });

  it("retains armed state and shows failure if capacity disappears or the callback rejects", () => {
    let eligible = true; const handoff = vi.fn(() => false);
    const f = fixture(undefined, { canHandoff: () => eligible, onHandoff: handoff });
    f.viewer.handleInput("b"); eligible = false; f.viewer.handleInput("y");
    expect(f.text()).toContain("Handoff unavailable"); expect(handoff).not.toHaveBeenCalled();
    eligible = true; f.click("y retry"); expect(handoff).toHaveBeenCalledTimes(1); expect(f.text()).toContain("Handoff failed");
    f.viewer.handleInput("\x1b"); expect(f.done).not.toHaveBeenCalled();
    f.viewer.handleInput("x"); f.record.status = "completed"; f.viewer.handleInput("y"); expect(f.text()).toContain("Stop unavailable"); expect(f.stop).not.toHaveBeenCalled();
    f.viewer.dispose();
  });
});

describe("public Input mouse and native renderer integration", () => {
  it.each(["abcdef", "a界b文c", "0123456789".repeat(10)])("places the actual composer caret at the clicked ASCII/CJK/scrolled cell: %s", value => {
    const f = fixture(); f.terminal.columns = 18;
    f.viewer.focused = true; f.viewer.handleInput("\r"); f.viewer.handleInput(value);
    const reference = new PiTui.Input({ prompt: "" }); reference.focused = true; reference.handleInput(value); reference.render(16);
    const y = f.render().findIndex(line => line.includes(PiTui.CURSOR_MARKER)); expect(y).toBeGreaterThanOrEqual(0);
    const event: PiTui.TuiMouseEvent = { type: "press", button: "left", x: 5, y: 0, screenX: 4, screenY: y, width: 16, height: 1, shift: false, ctrl: false, alt: false };
    const expected = reference.handleMouse(event);
    expect(f.mouse({ x: 4, y })).toMatchObject(expected!);
    f.viewer.handleInput("!"); reference.handleInput("!"); f.viewer.handleInput("\r");
    expect(f.steer).toHaveBeenCalledExactlyOnceWith(reference.getValue()); f.viewer.dispose();
  });

  it.each([1, 2, 3, 4, 5])("prioritizes controls and the focused draft at height %i and keeps footer clicks live", rows => {
    const f = fixture(); f.terminal.rows = rows; f.viewer.focused = true;
    expect(f.render()).toHaveLength(rows); f.click("Enter chat"); f.viewer.handleInput("draft");
    const output = f.render(); expect(output).toHaveLength(rows); expect(output.at(-1)).toContain("Enter send");
    if (rows >= 2) { expect(output.at(-2)).toContain("draft"); expect(output.at(-2)).toContain(PiTui.CURSOR_MARKER); }
    f.click("Enter send"); expect(f.steer).toHaveBeenCalledExactlyOnceWith("draft");
    f.click("x stop"); f.click("y confirm STOP"); expect(f.stop).toHaveBeenCalledTimes(1); f.viewer.dispose();
  });

  it.each(["fullscreen", "regular"] as const)("matches helper geometry and constructor mode on native %s hosts", mode => {
    const options: ViewerOptions = { mode: "overlay" }; const f = fixture(undefined, options, mode);
    f.tui.addChild(new PiTui.Text("main"));
    try {
      f.tui.start(); const handle = f.tui.showOverlay(f.viewer, getConversationOverlayOptions(f.tui, options)); f.tui.renderNow();
      expect(getConversationViewerMode(f.tui, options)).toBe("overlay");
      expect(handle.getBounds()).toEqual({ row: 3, col: 6, width: 108, height: 14 });
      expect(f.viewer.render(108)[0]).toContain("╭");
      if (mode === "fullscreen") {
        f.input("\r"); f.input("abcdef"); f.tui.renderNow(); expect(f.viewer.focused).toBe(true);
        // Floating frame col 6 + border/padding 2 + text offset 3; composer is overlay row 11.
        f.input("\x1b[<0;12;15M"); f.input("!"); f.input("\r");
        expect(f.steer).toHaveBeenCalledExactlyOnceWith("abc!def");
      }
    } finally { f.viewer.dispose(); f.tui.stop(); }
  });

  it("a click in an unfocused native overlay returns keyboard focus and caret to the observer", () => {
    const f = fixture(undefined, {}, "fullscreen"); const editor = new PiTui.Input(); f.tui.addChild(editor); f.tui.setFocus(editor);
    try {
      f.tui.start(); const handle = f.tui.showOverlay(f.viewer, getConversationOverlayOptions(f.tui));
      f.input("\r"); f.input("abcdef"); f.tui.renderNow(); handle.unfocus({ target: editor }); f.tui.renderNow();
      expect(f.viewer.focused).toBe(false);
      // Native SGR press: component cell x=4, composer y=18 (zero-based).
      f.input("\x1b[<0;5;19M"); f.tui.renderNow(); expect(f.viewer.focused).toBe(true);
      expect(f.render().join("\n")).toContain(PiTui.CURSOR_MARKER);
      f.input("!"); f.input("\r"); expect(f.steer).toHaveBeenCalledExactlyOnceWith("abc!def"); expect(editor.getValue()).toBe("");
    } finally { f.viewer.dispose(); f.tui.stop(); }
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("normalizes invalid width and rows %s without allocation or parsing", value => {
    const f = fixture([assistant("x".repeat(2_000_000))]); f.terminal.rows = value;
    expect(f.viewer.render(value)).toEqual([]); expect(layouts.renders).toBe(0);
    f.terminal.rows = 5; expect(f.viewer.render(value)).toHaveLength(5); expect(layouts.renders).toBe(0); f.viewer.dispose();
  });
});
