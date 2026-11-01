import type { AgentSession, AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import * as PiTui from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecordSnapshot } from "../src/types.js";
import { ConversationViewer, getConversationOverlayOptions, getConversationViewerMode, type SteerHandler, type ViewerOptions } from "../src/ui/conversation-viewer.js";

const parser = vi.hoisted(() => ({ renders: 0, constructions: 0, wraps: 0, throws: false, inputs: [] as string[] }));
vi.mock("@earendil-works/pi-tui", async importOriginal => {
  const original = await importOriginal<typeof PiTui>();
  return {
    ...original,
    Markdown: class extends original.Markdown {
      constructor(...args: ConstructorParameters<typeof original.Markdown>) {
        super(...args);
        parser.constructions++;
        parser.inputs.push(args[0]);
      }
      override render(width: number): string[] {
        parser.renders++;
        if (parser.throws) throw new Error("parser failure");
        return super.render(width);
      }
    },
    wrapTextWithAnsi: (text: string, width: number) => {
      parser.wraps++;
      return original.wrapTextWithAnsi(text, width);
    },
  };
});

type TestMessage = { role: "user"; content: string } | { role: "assistant" | "toolResult"; content: { type: "text"; text: string }[] };
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
function fixture(options: ViewerOptions = {}, mode: "fullscreen" | "regular" | "legacy" = "fullscreen", host?: PiTui.TUI, onSteer: SteerHandler = vi.fn()) {
  const terminal = { rows: 20, columns: 120 };
  const tui = host ?? { terminal, mode: mode === "legacy" ? undefined : mode, requestRender: vi.fn() } as unknown as PiTui.TUI;
  const messages: TestMessage[] = [{ role: "user", content: Array.from({ length: 100 }, (_, i) => `row-${String(i).padStart(3, "0")}`).join("\n") }];
  let listener: AgentSessionEventListener = () => {};
  const unsubscribe = vi.fn();
  const session = { messages, subscribe: (callback: AgentSessionEventListener) => { listener = callback; return unsubscribe; } } as unknown as AgentSession;
  const record = { id: "a", type: "Explore", description: "Observe", status: "running", toolUses: 0, startedAt: Date.now(), compactionCount: 0 } as AgentRecordSnapshot;
  const done = vi.fn();
  const stop = vi.fn();
  const viewer = new ConversationViewer(tui, session, record, undefined, theme, done, stop, undefined, onSteer, () => record, options);
  const render = () => viewer.render(tui.terminal.columns);
  const emit = () => listener({ type: "message_start", message: messages.at(-1)! } as Parameters<AgentSessionEventListener>[0]);
  const mouse = (event: Partial<PiTui.TuiMouseEvent>) => viewer.handleMouse({
    type: "wheel", button: "none", x: 10, y: 8, screenX: 10, screenY: 8, width: tui.terminal.columns, height: tui.terminal.rows,
    shift: false, alt: false, ctrl: false, ...event,
  });
  const click = (label: string) => {
    const lines = render().map(PiTui.stripTerminalSequences);
    const y = lines.findIndex(line => line.includes(label));
    expect(y).toBeGreaterThanOrEqual(0);
    const x = PiTui.visibleWidth(lines[y].slice(0, lines[y].indexOf(label)));
    return mouse({ type: "press", button: "left", x, y });
  };
  return { viewer, render, tui, terminal, messages, session, record, done, stop, unsubscribe, emit, mouse, click };
}
function firstRow(lines: string[]): string | undefined { return lines.join("\n").match(/row-\d+/)?.[0]; }
function draft(viewer: ConversationViewer, value = "draft"): void { viewer.handleInput("\r"); viewer.handleInput(value); }

beforeEach(() => { parser.renders = 0; parser.constructions = 0; parser.wraps = 0; parser.throws = false; parser.inputs = []; });

describe("adaptive conversation observer", () => {
  it("exports pure sizing/mode helpers with an honest old-host fallback", () => {
    expect(getConversationViewerMode()).toBe("overlay");
    expect(getConversationViewerMode({ mode: "fullscreen" })).toBe("fullscreen");
    expect(getConversationOverlayOptions()).toEqual({ anchor: "center", width: "90%", maxHeight: "70%" });
    expect(getConversationOverlayOptions({ mode: "regular" })).toEqual(getConversationOverlayOptions());
    expect(getConversationOverlayOptions({ mode: "fullscreen" })).toEqual({ anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 });
    const old = fixture({ mode: "fullscreen" }, "legacy");
    expect(old.render()).toHaveLength(14);
    expect(old.render()[0]).toContain("╭");
    old.viewer.dispose();
  });

  it("covers native fullscreen cells without an extra frame, and preserves the regular full border", () => {
    const full = fixture();
    for (const [rows, columns] of [[20, 120], [35, 70], [4, 12], [1, 1], [0, 0], [2, 2]]) {
      full.terminal.rows = rows; full.terminal.columns = columns;
      const output = full.render();
      expect(output).toHaveLength(rows);
      expect(output.every(line => PiTui.visibleWidth(line) === columns)).toBe(true);
      expect(output.join("\n")).not.toMatch(/[╭╮╰╯]/);
    }
    full.terminal.rows = 20; full.terminal.columns = 120;
    draft(full.viewer);
    expect(full.render()).toHaveLength(20);
    full.viewer.dispose();
    for (const mode of ["regular", "legacy"] as const) {
      const regular = fixture({ mode: "overlay" }, mode);
      expect(regular.render()).toHaveLength(14);
      expect(regular.render()[0]).toContain("╭");
      expect(regular.render().at(-1)).toContain("╰");
      expect(regular.render().every(line => PiTui.visibleWidth(line) === 120)).toBe(true);
      expect(regular.mouse({ wheelDelta: -5 })).toEqual({ handled: false });
      regular.viewer.dispose();
    }
  });

  it("bounds tiny CJK, combining, emoji and unsafe messages before Markdown/layout", () => {
    const f = fixture();
    f.messages.splice(0, 1, { role: "assistant", content: [{ type: "text", text: (`界e\u0301👩‍💻\x1b[2J\x1b]52;c;secret\x07\u202e\n`).repeat(100_000) }] });
    for (const width of [1, 2, 3, 4, 5, 8, 15, 40, 80]) {
      f.terminal.columns = width;
      const lines = f.render();
      expect(lines).toHaveLength(20);
      expect(lines.every(line => PiTui.visibleWidth(line) <= width)).toBe(true);
      expect(lines.join("\n")).not.toContain("\x1b[2J");
      expect(lines.join("\n")).not.toContain("\x1b]52");
      expect(lines.join("\n")).not.toContain("\u202e");
    }
    expect(parser.inputs.every(text => text.length <= 8_192 && text.split("\n").length <= 128)).toBe(true);
    f.viewer.dispose();
  });

  it("pauses follow on up, counts messages rather than streaming deltas and jumps to latest", () => {
    const f = fixture();
    const bottom = firstRow(f.render());
    f.viewer.handleInput("\x1b[A");
    const paused = firstRow(f.render());
    expect(paused).not.toBe(bottom);
    expect(f.render()[18]).toContain("Jump to latest");
    f.messages[0] = { role: "user", content: `${(f.messages[0] as { content: string }).content}\nrow-100` };
    f.emit();
    expect(firstRow(f.render())).toBe(paused);
    f.messages.push({ role: "user", content: "new-turn" }); f.emit();
    expect(f.render()[18]).toContain("1 new message");
    f.emit(); f.emit();
    expect(f.render()[18]).toContain("1 new message");
    f.viewer.handleInput("\x1b[1;5F");
    expect(f.render()[18]).not.toContain("new message");
    expect(f.render().join("\n")).toContain("new-turn");
    f.messages.push({ role: "user", content: "latest" });
    expect(f.render().join("\n")).toContain("latest");
    f.viewer.handleInput("\x1b[H"); f.render();
    f.viewer.handleInput("\x1b[F");
    expect(f.render().join("\n")).toContain("latest");
    f.viewer.dispose();
  });

  it("owns normalized wheel, rail drag, jump and footer controls without double actions", () => {
    const f = fixture();
    const bottom = firstRow(f.render());
    expect(f.mouse({ wheelDelta: -5 })).toMatchObject({ handled: true });
    expect(firstRow(f.render())).not.toBe(bottom);
    f.click("Jump to latest");
    expect(firstRow(f.render())).toBe(bottom);
    const thumb = f.render().findIndex(line => line.endsWith("┃"));
    expect(f.mouse({ type: "press", button: "left", x: 119, y: thumb })).toMatchObject({ capture: true });
    f.mouse({ type: "drag", button: "left", x: 119, y: -100 });
    expect(f.render().join("\n")).toContain("row-000");
    f.mouse({ type: "drag", button: "left", x: 119, y: 1000 });
    expect(f.render().join("\n")).toContain("row-099");
    f.mouse({ type: "release", button: "left", x: 119, y: 1000 });
    f.click("x stop");
    expect(f.stop).not.toHaveBeenCalled();
    f.mouse({ type: "click", button: "left", x: 14, y: 19 });
    expect(f.stop).not.toHaveBeenCalled();
    f.click("y confirm STOP");
    expect(f.stop).toHaveBeenCalledTimes(1);
    f.click("Enter chat");
    f.viewer.handleInput("b");
    f.mouse({ wheelDelta: -10 });
    f.render(); f.click("Jump to latest");
    expect(f.render().join("\n")).toContain("Enter send");
    f.click("Esc cancel");
    f.click("Esc close");
    expect(f.done).toHaveBeenCalledTimes(1);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    f.emit();
    f.viewer.dispose();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("bounded Markdown and layout caches", () => {
  it("reuses Markdown/layout on render, scroll and omitted-tail appends; refreshes append/replacement/width/theme", () => {
    const f = fixture();
    const msg: TestMessage = { role: "assistant", content: [{ type: "text", text: "# heading\nbody" }] };
    f.messages.splice(0, 1, msg);
    f.render(); f.render(); f.viewer.handleInput("k"); f.render();
    expect(parser.renders).toBe(1);
    expect(parser.constructions).toBe(1);
    msg.content[0].text += "\nappend"; f.emit(); f.render();
    expect(parser.renders).toBe(2);
    msg.content[0].text = "## replacement"; f.render();
    expect(parser.renders).toBe(3);
    f.terminal.columns = 80; f.render();
    expect(parser.renders).toBe(4);
    f.viewer.invalidate(); f.render();
    expect(parser.renders).toBe(5);
    msg.content[0].text = "x".repeat(2_000_000); f.render();
    const renders = parser.renders;
    msg.content[0].text += "\n".repeat(2_000_000); f.render(); f.render();
    expect(parser.renders).toBe(renders);
    expect(parser.inputs.every(text => text.length <= 8_192)).toBe(true);
    f.viewer.dispose();
  });

  it("remembers parser failures across append-only streams, and retries replacement, shortening, width, compaction and theme", () => {
    const f = fixture();
    const msg: TestMessage = { role: "assistant", content: [{ type: "text", text: "# unsafe" }] };
    f.messages.splice(0, 1, msg);
    parser.throws = true;
    expect(() => f.render()).not.toThrow();
    expect(f.render().join("\n")).toContain("# unsafe");
    msg.content[0].text += "\nappend"; f.render();
    expect(parser.renders).toBe(1);
    msg.content[0].text = "# replaced"; f.render();
    expect(parser.renders).toBe(2);
    msg.content[0].text = "#"; f.render();
    expect(parser.renders).toBe(3);
    f.terminal.columns = 80; f.render();
    expect(parser.renders).toBe(4);
    f.record.compactionCount++; f.render();
    expect(parser.renders).toBe(5);
    f.viewer.invalidate(); f.render();
    expect(parser.renders).toBe(6);
    parser.throws = false;
    f.messages.splice(0, 1, { role: "assistant", content: [{ type: "text", text: "# safe" }] }); f.render();
    expect(parser.renders).toBe(7);
    expect(f.render().join("\n")).not.toContain("# safe");
    f.viewer.dispose();
  });

  it("bounds history/cache lifetime and raw result wrapping, with no hidden-tail scans", () => {
    const f = fixture();
    const tool: TestMessage = { role: "toolResult", content: [{ type: "text", text: "visible" + "\n".repeat(2_000_000) }] };
    f.messages.splice(0, 1, tool); f.render();
    const wraps = parser.wraps;
    tool.content[0].text += "tail"; f.render(); f.viewer.handleInput("k"); f.render();
    expect(parser.wraps).toBe(wraps);
    for (let i = 0; i < 200; i++) f.messages.push({ role: "assistant", content: [{ type: "text", text: `message-${i}` }] });
    f.render();
    expect(parser.constructions).toBeLessThanOrEqual(64);
    f.messages.splice(0, 200); f.render();
    f.viewer.dispose();
    const renders = parser.renders;
    expect(f.viewer.render(80)).toEqual([]);
    expect(parser.renders).toBe(renders);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("focused composer and runtime controls", () => {
  it("propagates Focusable and cursor markers for IME, without intercepting composer keys", () => {
    const steer = vi.fn();
    const f = fixture({}, "fullscreen", undefined, steer);
    f.viewer.focused = true; draft(f.viewer, "界e\u0301👩‍💻bqjx");
    expect(f.render().join("\n")).toContain(PiTui.CURSOR_MARKER);
    f.viewer.focused = false;
    expect(f.render().join("\n")).not.toContain(PiTui.CURSOR_MARKER);
    f.viewer.focused = true;
    for (const width of [3, 4, 8, 15, 40]) {
      f.terminal.columns = width;
      const output = f.render();
      expect(output.join("\n")).toContain(PiTui.CURSOR_MARKER);
      expect(output.every(line => PiTui.visibleWidth(line) <= width)).toBe(true);
    }
    f.terminal.columns = 120;
    f.viewer.handleInput("\x1b[F"); // editing End, not observer jump
    f.viewer.handleInput("\x1b[1;5F");
    expect(f.render().join("\n")).toContain("Enter send");
    f.viewer.handleInput("\r");
    expect(steer).toHaveBeenCalledExactlyOnceWith("界e\u0301👩‍💻bqjx");
    expect(f.render().join("\n")).not.toContain(PiTui.CURSOR_MARKER);
    f.viewer.dispose();
  });

  it("ignores Kitty releases/repeats for confirmations and releases in the composer", () => {
    const handoff = vi.fn(() => true);
    const steer = vi.fn();
    const f = fixture({ canHandoff: () => true, onHandoff: handoff }, "fullscreen", undefined, steer);
    f.viewer.handleInput("\x1b[120;1u"); // x press
    f.viewer.handleInput("\x1b[120;1:3u");
    f.viewer.handleInput("\x1b[120;1:2u");
    expect(f.stop).not.toHaveBeenCalled();
    f.viewer.handleInput("\x1b[120;1u");
    expect(f.stop).not.toHaveBeenCalled();
    f.viewer.handleInput("\x1b[121;1:3u");
    f.viewer.handleInput("\x1b[121;1:2u");
    expect(f.stop).not.toHaveBeenCalled();
    f.viewer.handleInput("\x1b[121;1u");
    expect(f.stop).toHaveBeenCalledTimes(1);
    f.viewer.handleInput("\x1b[98;1u");
    f.viewer.handleInput("\x1b[98;1:3u");
    expect(handoff).not.toHaveBeenCalled();
    f.viewer.handleInput("\x1b[98;1u");
    expect(handoff).not.toHaveBeenCalled();
    f.viewer.handleInput("\x1b[121;1u");
    expect(handoff).toHaveBeenCalledTimes(1);
    draft(f.viewer, "draft");
    f.viewer.handleInput("\x1b[13;1:3u");
    expect(steer).not.toHaveBeenCalled();
    f.viewer.handleInput("\r");
    expect(steer).toHaveBeenCalledExactlyOnceWith("draft");
    f.viewer.dispose();
  });

  it("retains rejected async drafts, locks pending submission, permits retry and ignores a cancelled draft settlement", async () => {
    let settle: ((accepted: boolean) => void) | undefined;
    const steer = vi.fn(() => new Promise<boolean>(resolve => { settle = resolve; }));
    const f = fixture({}, "fullscreen", undefined, steer);
    draft(f.viewer); f.viewer.handleInput("\r"); f.viewer.handleInput("\r"); f.viewer.handleInput("x");
    expect(steer).toHaveBeenCalledTimes(1);
    expect(f.render().join("\n")).toContain("Sending");
    settle!(false); await Promise.resolve();
    expect(f.render().join("\n")).toContain("draft retained");
    f.viewer.handleInput("\r");
    settle!(true); await Promise.resolve();
    expect(f.render().join("\n")).not.toContain("draft retained");
    draft(f.viewer, "cancelled"); f.viewer.handleInput("\r");
    const cancelled = settle!;
    f.viewer.handleInput("\x1b"); draft(f.viewer, "replacement");
    cancelled(false); await Promise.resolve();
    expect(f.render().join("\n")).toContain("replacement");
    expect(f.render().join("\n")).not.toContain("draft retained");
    f.viewer.dispose();
  });

  it("offers handoff only with live exact eligibility and distinct confirmation, preserving failure for retry", () => {
    let eligible = false;
    const handoff = vi.fn(() => false);
    const f = fixture({ canHandoff: () => eligible, onHandoff: handoff });
    expect(f.render().join("\n")).not.toContain("b background");
    f.viewer.handleInput("b"); f.viewer.handleInput("b");
    expect(handoff).not.toHaveBeenCalled();
    eligible = true;
    expect(f.render().join("\n")).toContain("b background");
    f.viewer.handleInput("b");
    expect(f.render().join("\n")).toContain("y confirm background");
    eligible = false; f.viewer.handleInput("y");
    expect(handoff).not.toHaveBeenCalled();
    expect(f.render().join("\n")).toContain("Handoff unavailable");
    eligible = true; f.viewer.handleInput("y");
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(f.render().join("\n")).toContain("Handoff failed; still foreground");
    expect(f.done).not.toHaveBeenCalled();
    f.viewer.handleInput("\x1b"); // Cancel the retained failed confirmation before composing.
    draft(f.viewer, "b"); f.viewer.handleInput("b");
    expect(handoff).toHaveBeenCalledTimes(1);
    f.viewer.handleInput("\x1b"); f.record.status = "queued";
    expect(f.render().join("\n")).not.toContain("b background");
    f.record.status = "completed"; f.viewer.handleInput("b"); f.viewer.handleInput("b");
    expect(handoff).toHaveBeenCalledTimes(1);
    f.viewer.dispose();
  });

  it.each(["true", "void", "throw"] as const)("reports the %s handoff callback outcome without closing the observer", outcome => {
    let eligible = true;
    const handoff = vi.fn(() => {
      if (outcome === "throw") throw new Error("not available");
      eligible = false;
      return outcome === "true" ? true : undefined;
    });
    const f = fixture({ canHandoff: () => eligible, onHandoff: handoff });
    f.viewer.handleInput("b"); f.viewer.handleInput("b");
    expect(handoff).not.toHaveBeenCalled();
    f.viewer.handleInput("y");
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(f.done).not.toHaveBeenCalled();
    if (outcome === "throw") expect(f.render().join("\n")).toContain("Handoff failed");
    else {
      expect(f.render().join("\n")).not.toContain("Handoff failed");
      expect(f.render().join("\n")).not.toContain("b background");
    }
    f.viewer.dispose();
  });

  it("keeps getRecord controls/status bound to the exact agent and respects detached read-only state", () => {
    const f = fixture({ canHandoff: () => true, onHandoff: vi.fn() });
    const foreign = { ...f.record, id: "other", status: "completed" } as AgentRecordSnapshot;
    const viewer = new ConversationViewer(f.tui, f.session, f.record, undefined, theme, f.done, f.stop, undefined, vi.fn(), () => foreign);
    expect(viewer.render(120).join("\n")).toContain("Enter chat");
    f.record.detached = true;
    expect(f.render().join("\n")).not.toContain("b background");
    expect(f.render().join("\n")).not.toContain("x stop");
    f.viewer.handleInput("x"); f.viewer.handleInput("x");
    expect(f.stop).not.toHaveBeenCalled();
    viewer.dispose(); f.viewer.dispose();
  });
});

it("uses the actual public regular host with exactly one floating full border", () => {
  const terminal: PiTui.Terminal = {
    rows: 20, columns: 120, kittyProtocolActive: false,
    start: vi.fn(), stop: vi.fn(), drainInput: async () => {}, write: vi.fn(),
    moveBy: vi.fn(), hideCursor: vi.fn(), showCursor: vi.fn(), clearLine: vi.fn(), clearFromCursor: vi.fn(), clearScreen: vi.fn(), setTitle: vi.fn(), setProgress: vi.fn(), setProgramStatus: vi.fn(),
  };
  const tui = new PiTui.TuiMainScreen(terminal);
  tui.addChild(new PiTui.Text("main"));
  const f = fixture({}, "regular", tui);
  try {
    tui.start();
    const handle = tui.showOverlay(f.viewer, getConversationOverlayOptions(tui));
    tui.renderNow();
    expect(handle.getBounds()).toEqual({ row: 3, col: 6, width: 108, height: 14 });
    const lines = f.viewer.render(108);
    expect(lines).toHaveLength(14);
    expect(lines.every(line => PiTui.visibleWidth(line) === 108)).toBe(true);
    expect(lines.join("\n").match(/╭/g)).toHaveLength(1);
    expect(lines.join("\n").match(/╰/g)).toHaveLength(1);
  } finally { f.viewer.dispose(); tui.stop(); }
});

it("uses the actual public fullscreen host: observer wheel/focus do not mutate the main editor or scroll view", () => {
  let input = (_data: string) => {};
  const terminal: PiTui.Terminal = {
    rows: 20, columns: 120, kittyProtocolActive: false,
    start: callback => { input = callback; }, stop: vi.fn(), drainInput: async () => {}, write: vi.fn(),
    moveBy: vi.fn(), hideCursor: vi.fn(), showCursor: vi.fn(), clearLine: vi.fn(), clearFromCursor: vi.fn(), clearScreen: vi.fn(), setTitle: vi.fn(), setProgress: vi.fn(), setProgramStatus: vi.fn(),
  };
  const tui = new PiTui.TuiAltScreen(terminal);
  const editor = new PiTui.Input(); editor.setValue("main draft");
  const main = new PiTui.ScrollView(new PiTui.Text("main\n".repeat(100)));
  tui.setLayoutRoot(new PiTui.VStack([{ component: main, flex: 1 }, editor]));
  tui.setFocus(editor);
  const f = fixture({}, "fullscreen", tui);
  try {
    tui.start(); tui.renderNow();
    main.scrollTo(25, { disableFollow: true }); tui.renderNow();
    const position = main.scrollTop;
    const handle = tui.showOverlay(f.viewer, getConversationOverlayOptions(tui));
    tui.renderNow();
    expect(handle.getBounds()).toEqual({ row: 0, col: 0, width: 120, height: 20 });
    const before = firstRow(f.render());
    input("\x1b[<64;11;9M"); tui.renderNow();
    expect(firstRow(f.render())).not.toBe(before);
    expect(main.scrollTop).toBe(position);
    expect(editor.getValue()).toBe("main draft");
    input("\r"); input("draft"); tui.renderNow();
    expect(f.viewer.focused).toBe(true);
    const dialog = new PiTui.Input();
    const dialogHandle = tui.showOverlay(dialog, { width: 40, maxHeight: 1 });
    f.emit(); tui.renderNow();
    expect(f.viewer.focused).toBe(false);
    expect(f.render().join("\n")).not.toContain(PiTui.CURSOR_MARKER);
    input("dialog input");
    expect(dialog.getValue()).toBe("dialog input");
    expect(f.render().join("\n")).not.toContain("dialog input");
    dialogHandle.hide(); tui.renderNow();
    expect(f.viewer.focused).toBe(true);
    expect(f.render().join("\n")).toContain(PiTui.CURSOR_MARKER);
    input("\x1b"); input("q");
    tui.hideOverlay(); tui.renderNow();
    input("!");
    expect(editor.getValue()).toBe("!main draft");
  } finally { f.viewer.dispose(); tui.stop(); }
});
