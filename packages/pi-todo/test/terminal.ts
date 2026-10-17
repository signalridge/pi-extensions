import type { ExtensionUIContext, KeybindingsManager as HostKeys, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Input,
  KeybindingsManager,
  type OverlayHandle,
  ScrollView,
  type Terminal,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
} from "@earendil-works/pi-tui";
import { vi } from "vitest";

/** Original fixture: public custom UI mounted over host-shaped scrollback/editor/status chrome. */
export function terminalFixture(fullscreen = true) {
  let key = (_data: string) => {};
  let resize = () => {};
  let writes = "";
  const terminal = {
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    start: (input, changed) => {
      key = input;
      resize = changed;
    },
    stop: () => {},
    drainInput: async () => {},
    write: (data) => {
      writes += data;
    },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
  } satisfies Terminal;
  const tui = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
  const draft = new Input();
  draft.setValue("Keep this root draft");
  const transcript = new Text(Array.from({ length: 60 }, (_, n) => `Native history line ${n}`).join("\n"), 0, 0);
  const dock = new Container();
  dock.addChild(new Text("Native editor", 0, 0));
  dock.addChild(draft);
  const footer = new Text("Native footer", 0, 0);
  tui.addChild(transcript);
  tui.addChild(dock);
  tui.addChild(footer);
  if (tui instanceof TuiAltScreen)
    tui.setLayoutRoot(
      new VStack([
        {
          component: new ScrollView(transcript, { follow: "end", primary: true }),
          grow: 1,
          shrink: 1,
          basis: 0,
          minSize: 1,
        },
        { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
        { component: footer, basis: 1, grow: 0, shrink: 1, minSize: 0 },
      ]),
    );
  tui.setFocus(draft);
  const theme = { fg: (_color: string, value: string) => `\x1b[36m${value}\x1b[0m` } as unknown as Theme;
  let active: (Component & { dispose?(): void }) | undefined;
  let overlay: OverlayHandle | undefined;
  const custom: ExtensionUIContext["custom"] = (factory, options) =>
    new Promise((resolve, reject) => {
      const prior = tui.getFocusedComponent();
      let finished = false;
      const done = (result: Parameters<typeof resolve>[0]) => {
        if (finished) return;
        finished = true;
        active?.dispose?.();
        active = undefined;
        tui.hideOverlay();
        overlay = undefined;
        tui.setFocus(prior);
        tui.requestRender();
        resolve(result);
      };
      Promise.resolve(factory(tui, theme, new KeybindingsManager({}) as unknown as HostKeys, done)).then(
        (component) => {
          if (finished) {
            component.dispose?.();
            return;
          }
          active = component;
          const bounds =
            typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions;
          overlay = tui.showOverlay(component, bounds);
          options?.onHandle?.(overlay);
          tui.requestRender();
        },
        reject,
      );
    });
  const ui = {
    custom: vi.fn(custom),
    notify: vi.fn(),
    setStatus: vi.fn(),
    input: vi.fn<ExtensionUIContext["input"]>(async () => undefined),
    select: vi.fn<ExtensionUIContext["select"]>(async () => undefined),
    theme,
    getEditorText: () => draft.getValue(),
  } as unknown as ExtensionUIContext;
  tui.start();
  return {
    tui,
    ui,
    draft,
    active: () => {
      const focused = tui.getFocusedComponent();
      return focused !== draft ? (focused ?? undefined) : undefined;
    },
    bounds: () => {
      const focused = tui.getFocusedComponent();
      return focused && "getBounds" in focused && typeof focused.getBounds === "function"
        ? focused.getBounds()
        : overlay?.getBounds();
    },
    writes: () => writes,
    key: (data: string) => {
      key(data);
      tui.renderNow();
    },
    resize: (columns: number, rows: number) => {
      terminal.columns = columns;
      terminal.rows = rows;
      resize();
      tui.renderNow();
    },
    lines: () => {
      tui.renderNow();
      if (tui instanceof TuiAltScreen) return tui.getScreenLines();
      const state = tui.captureRenderState();
      return state.previousLines.slice(state.previousViewportTop, state.previousViewportTop + terminal.rows);
    },
    dispose: () => {
      const focused = tui.getFocusedComponent();
      if (focused && "dispose" in focused && typeof focused.dispose === "function") focused.dispose();
      active?.dispose?.();
      tui.stop();
    },
  };
}
