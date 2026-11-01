import { type Component, Editor, SelectList, type Terminal, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import { FleetList, type FleetUICtx } from "../src/ui/fleet-list.js";

class MemoryTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  input: ((data: string) => void) | undefined;
  start(input: (data: string) => void): void { this.input = input; }
  stop(): void { this.input = undefined; }
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
}
const identity = (text: string) => text;
const selectorTheme = { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity };
const theme = { fg: (_: string, text: string) => text, bold: identity };

describe("Fleet native SDK input barriers", () => {
  it.each([TuiMainScreen, TuiAltScreen])("preserves native selector/overlay keys across invalidation and renderer replacement with %s", Renderer => {
    const terminal = new MemoryTerminal();
    const host = new Renderer(terminal);
    let widget: (Component & { dispose?(): void }) | undefined;
    const record = { id: "a", type: "Explore", description: "a", status: "running", startedAt: Date.now(),
      session: {}, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 } } as AgentRecord;
    const manager = { listAgentsMutable: () => [record] } as unknown as AgentManager;
    const fleet = new FleetList(manager, new Map());
    const ui: FleetUICtx = {
      setWidget: (_, factory) => { if (widget) { host.removeChild(widget); widget.dispose?.(); } widget = factory?.(host, theme); if (widget) host.addChild(widget); },
      onTerminalInput: callback => host.addInputListener(callback), getEditorText: () => "", notify: vi.fn(), custom: async () => undefined as never,
    };
    const editor = new Editor(host, { borderColor: identity, selectList: selectorTheme });
    const customEditor = { render: () => [], invalidate: () => {}, handleInput: vi.fn(), getText: () => "", setText: () => {} };
    host.addChild(editor); host.setFocus(editor);
    host.start();
    try {
      fleet.setUICtx(ui); fleet.update();
      for (const focusedEditor of [editor, customEditor]) {
        host.setFocus(focusedEditor);
        expect(fleet.handleKey("\x1b[B")).toEqual({ consume: true });
        const selector = new SelectList([{ value: "one", label: "one" }, { value: "two", label: "two" }], 5, selectorTheme);
        const select = vi.fn(); const cancel = vi.fn(); selector.onSelect = select; selector.onCancel = cancel;
        host.addChild(selector); host.setFocus(selector);
        widget!.invalidate();
        // No timer advance or render between invalidation and input: native
        // selectors retain the keys at the actual TUI dispatch boundary.
        terminal.input!("\x1b[B"); terminal.input!("\r"); terminal.input!("\x1b");
        expect(select).toHaveBeenCalledWith(expect.objectContaining({ value: "two" }));
        expect(cancel).toHaveBeenCalledOnce();
        const overlay = host.showOverlay(selector);
        widget!.invalidate();
        expect(fleet.handleKey("\x1b[B")).toBeUndefined();
        overlay.hide(); host.removeChild(selector);
      }
      fleet.setUICtx({ ...ui }); // old mounting/input subscription disposed
      host.setFocus(customEditor); fleet.update();
      expect(fleet.handleKey("\x1b[B")).toEqual({ consume: true });
    } finally { fleet.dispose(); host.stop(); }
    expect(widget).toBeUndefined();
  });
});
