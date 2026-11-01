import type { ExtensionUIContext, KeybindingsManager as HostKeybindings, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
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

/** Public custom-UI contract backed by Pi's actual regular/fullscreen renderers. */
export function nativeUIFixture(fullscreen = true) {
  let input: (data: string) => void = () => {};
  let resize: () => void = () => {};
  let output = "";
  let component: (Component & { dispose?(): void }) | undefined;
  let overlay: OverlayHandle | undefined;
  const terminal = {
    columns: 100,
    rows: 16,
    kittyProtocolActive: false,
    start: (onInput, onResize) => {
      input = onInput;
      resize = onResize;
    },
    stop: () => {},
    drainInput: async () => {},
    write: (data) => {
      output += data;
    },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
    setProgramStatus: () => {},
  } satisfies Terminal;
  const tui = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
  const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
  // Mirror the host's public transcript + shrinking editor dock layout, not a bare root.
  const document = new Text(Array.from({ length: 50 }, (_, i) => `Host transcript ${i}`).join("\n"), 0, 0);
  const editor = new Container();
  const draft = new Text("Host draft\n\n", 0, 0);
  editor.addChild(draft);
  const footer = new Text("Host footer", 0, 0);
  const transcript = new ScrollView(document, { follow: "end", primary: true });
  const root = new VStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    {
      component: new VStack([
        { component: editor, shrink: 1, minSize: 3 },
        { component: footer, shrink: 1, minSize: 0 },
      ]),
      basis: "auto",
      grow: 0,
      shrink: 1,
      minSize: 1,
    },
  ]);
  tui.addChild(document);
  tui.addChild(editor);
  tui.addChild(footer);
  if (tui instanceof TuiAltScreen) tui.setLayoutRoot(root);
  tui.setFocus(draft);
  const custom: ExtensionUIContext["custom"] = (factory, options) =>
    new Promise((resolve, reject) => {
      const previous = tui.getFocusedComponent();
      let finished = false;
      const done = (value: Parameters<typeof resolve>[0]) => {
        if (finished) return;
        finished = true;
        component?.dispose?.();
        if (options?.overlay) {
          tui.hideOverlay();
          overlay = undefined;
        } else {
          editor.clear();
          editor.addChild(draft);
        }
        component = undefined;
        tui.setFocus(previous);
        tui.requestRender();
        resolve(value);
      };
      Promise.resolve(factory(tui, theme, new KeybindingsManager({}) as unknown as HostKeybindings, done)).then(
        (created) => {
          if (finished) {
            created.dispose?.();
            return;
          }
          component = created;
          if (options?.overlay) {
            const bounds =
              typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
            overlay = tui.showOverlay(created, bounds);
            options.onHandle?.(overlay);
          } else {
            editor.clear();
            editor.addChild(created);
            tui.setFocus(created);
          }
          tui.requestRender();
        },
        reject,
      );
    });
  const customSpy = vi.fn(custom);
  const ui = {
    custom: customSpy,
    setStatus: vi.fn(),
    notify: vi.fn(),
    theme,
  } as unknown as ExtensionUIContext;
  tui.start();
  return {
    tui,
    terminal,
    theme,
    ui,
    custom: customSpy,
    key: (data: string) => {
      input(data);
      tui.renderNow();
    },
    resize: (columns: number, rows: number) => {
      terminal.columns = columns;
      terminal.rows = rows;
      resize();
      tui.renderNow();
    },
    render: () => {
      tui.renderNow();
      if (tui instanceof TuiAltScreen) return tui.getScreenLines();
      const state = tui.captureRenderState();
      return state.previousLines.slice(state.previousViewportTop, state.previousViewportTop + terminal.rows);
    },
    component: () => component,
    overlayBounds: () => overlay?.getBounds(),
    output: () => output,
    dispose: () => {
      component?.dispose?.();
      tui.stop();
    },
  };
}
