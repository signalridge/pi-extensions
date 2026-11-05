import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  getKeybindings,
  KeybindingsManager,
  ScrollView,
  setKeybindings,
  type Terminal,
  Text,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  VStack,
} from "@earendil-works/pi-tui";
import type { BrowserController } from "../browser.js";
import * as browsers from "../browser.js";
import * as fileViewer from "../file-viewer.js";
import extension from "../index.js";
import * as utils from "../utils.js";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[0m`,
  bold: (text: string) => text,
};

test("already-retired factory return still declares viewport ownership without polling or completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "files-retired-return-"));
  const deps = spyOn(utils, "hasCommand").mockReturnValue(true);
  const native = browsers.createFileBrowser;
  let mode: "tui" | "rpc" = "tui";
  const factory = spyOn(browsers, "createFileBrowser").mockImplementation((...args) => {
    const browser = native(...args);
    mode = "rpc"; // ownership changes during construction, before the return branch
    return browser;
  });
  const intervals = spyOn(globalThis, "setInterval");
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  let component: (Component & BrowserController) | undefined;
  let doneCalls = 0;
  extension({
    registerCommand: (_name: string, command: { handler: typeof handler }) => {
      handler = command.handler;
    },
    on: () => {},
  } as never);
  const custom: ExtensionUIContext["custom"] = async (create) => {
    component = (await create({ requestRender() {} } as never, theme as never, getKeybindings() as never, () => {
      doneCalls++;
    })) as Component & BrowserController;
    return undefined as never;
  };
  const ctx = {
    cwd: root,
    get mode() {
      return mode;
    },
    hasUI: true,
    sessionManager: {},
    ui: { custom },
  } as unknown as ExtensionCommandContext;
  try {
    assert.ok(handler);
    await handler("", ctx);
    assert.ok(component);
    assert.equal(component.capturesViewportInput, true);
    assert.deepEqual(component.render(80), []);
    component.handleInput("q");
    component.dispose();
    await pause(20);
    assert.equal(doneCalls, 0);
    assert.equal(intervals.mock.calls.length, 0);
  } finally {
    component?.dispose();
    factory.mockRestore();
    deps.mockRestore();
    intervals.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

class FullscreenHost extends TuiAltScreen {
  flush() {
    this.doRender();
  }
}

test("returned inline component owns real fullscreen page dispatch without scrolling the transcript", async () => {
  const root = mkdtempSync(join(tmpdir(), "files-viewport-"));
  const source = Array.from({ length: 100 }, (_, i) => `source row ${i + 1}`);
  for (let i = 0; i < 60; i++) writeFileSync(join(root, `file-${String(i).padStart(2, "0")}.txt`), source.join("\n"));
  const deps = spyOn(utils, "hasCommand").mockReturnValue(true);
  const loader = spyOn(fileViewer, "loadFileContent").mockReturnValue({ lines: source, renderedMarkdown: false });
  const previousKeys = getKeybindings();
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
  let send!: (data: string) => void;
  const noop = () => {};
  const terminal: Terminal = {
    columns: 120,
    rows: 45,
    start: (onInput) => {
      send = onInput;
    },
    stop: noop,
    drainInput: async () => {},
    write: noop,
    moveBy: noop,
    hideCursor: noop,
    showCursor: noop,
    clearLine: noop,
    clearFromCursor: noop,
    clearScreen: noop,
    setTitle: noop,
    setProgress: noop,
    setProgramStatus: noop,
  };
  const tui = new FullscreenHost(terminal);
  const scroll = new ScrollView(new Text(Array.from({ length: 200 }, (_, i) => `history ${i}`).join("\n"), 0, 0), {
    primary: true,
    follow: "end",
  });
  const dock = new Container();
  const editor = new Text("opening draft", 0, 0);
  dock.addChild(editor);
  tui.setLayoutRoot(new VStack([{ component: scroll, basis: 0, grow: 1, minSize: 1 }, dock]));
  let component: (Component & BrowserController) | undefined;
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  let doneCalls = 0;
  const clears = spyOn(globalThis, "clearInterval");
  const custom: ExtensionUIContext["custom"] = (factory) =>
    new Promise((resolve) => {
      const done = () => {
        doneCalls++;
        dock.clear();
        dock.addChild(editor);
        tui.setFocus(editor);
        component?.dispose();
        resolve(undefined as never);
      };
      Promise.resolve(factory(tui, theme as never, getKeybindings() as never, done)).then((created) => {
        component = created as Component & BrowserController;
        dock.clear();
        dock.addChild(component);
        // Ordinary host mount, not a focus override in the extension or dispatch.
        tui.setFocus(component);
      });
    });
  extension({
    registerCommand: (name: string, command: { handler: typeof handler }) => {
      if (name === "readfiles") handler = command.handler;
    },
    on: () => {},
  } as never);
  const ctx = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    sessionManager: {},
    ui: { custom, notify: noop },
  } as unknown as ExtensionCommandContext;
  let interaction: Promise<void> | undefined;
  try {
    tui.start();
    assert.ok(handler);
    interaction = handler("", ctx);
    for (let i = 0; i < 200 && !component?.render(120).some((row) => row.includes("file-00.txt")); i++) await pause(10);
    assert.ok(component);
    tui.flush();
    assert.equal(tui.getFocusedComponent(), component);
    const transcriptTop = scroll.scrollTop;
    const focused = component;
    const selected = () => focused.render(120).find((row) => row.startsWith("\x1b[44m"));
    const beforeSelection = selected();
    send("\x1b[6~"); // tui.altScreen.pageDown / fullscreenPageDown
    tui.flush();
    assert.notEqual(selected(), beforeSelection, "browser selection pages through terminal dispatch");
    assert.equal(scroll.scrollTop, transcriptTop);
    send("\x1b[5~");
    tui.flush();
    assert.equal(selected(), beforeSelection);
    send("j");
    send("\r");
    tui.flush();
    const beforeFile = component.render(120)[2];
    const viewerTranscriptTop = scroll.scrollTop;
    send("\x1b[6~");
    tui.flush();
    assert.notEqual(component.render(120)[2], beforeFile, "viewer pages through the same wrapper");
    assert.equal(scroll.scrollTop, viewerTranscriptTop);
    send("\x1b[5~");
    tui.flush();
    assert.equal(component.render(120)[2], beforeFile);
    assert.equal(scroll.scrollTop, viewerTranscriptTop);
    send("q"); // viewer -> browser
    send("q"); // browser -> host
    await interaction;
    assert.equal(doneCalls, 1);
    assert.equal(clears.mock.calls.length, 1, "poll resource cleared exactly once");
    assert.deepEqual(component.render(120), []);
    component.dispose();
    component.handleInput("q");
    assert.equal(doneCalls, 1);
  } finally {
    component?.dispose();
    tui.stop();
    setKeybindings(previousKeys);
    deps.mockRestore();
    loader.mockRestore();
    clears.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
