import assert from "node:assert/strict";
import { setImmediate as nextCycle } from "node:timers/promises";
import { type ExtensionCommandContext, InteractiveMode, initTheme, VERSION } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  getKeybindings,
  Input,
  type KeybindingsConfig,
  KeybindingsManager,
  ScrollView,
  setKeybindings,
  type Terminal,
  Text,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
} from "@earendil-works/pi-tui";
import { defineMenu, runCustomInteraction, runMenu } from "@narumitw/pi-tui-kit";
import { withBorderedCustomUi } from "@signalridge/pi-ui";
import { test } from "vitest";
import { type AnalyticsLoadResult, createAnalyticsMenu, showAnalyticsMenu } from "../src/menu.js";
import { querySnapshot } from "../src/storage/queries.js";

initTheme("dark", false);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

class MainHost extends TuiMainScreen {
  flush() {
    this.doRender();
  }
}
class FullscreenHost extends TuiAltScreen {
  flush() {
    this.doRender();
  }
}

// Test-only shell around the installed SDK's actual custom-dialog stack and
// reset loop. Renderers and terminal-input dispatch are real; no runtime patches.
function sdkHost(mode: "regular" | "fullscreen" = "regular", bindings: KeybindingsConfig = {}, rows = 24) {
  assert.equal(VERSION, "1.5.0");
  const previousKeys = getKeybindings();
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
  setKeybindings(keys);
  let send!: (data: string) => void;
  const noop = () => {};
  const terminal: Terminal = {
    columns: 80,
    rows,
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
  const tui = mode === "regular" ? new MainHost(terminal) : new FullscreenHost(terminal);
  const input = new Input();
  input.setValue("opening draft");
  const editor = {
    render: (width: number) => input.render(width),
    invalidate: () => input.invalidate(),
    handleInput: (data: string) => input.handleInput(data),
    getText: () => input.getValue(),
    setText: (value: string) => input.setValue(value),
  };
  const dock = new Container();
  dock.addChild(editor);
  const transcript = new Text(Array.from({ length: 100 }, (_, i) => `history ${i}`).join("\n"), 0, 0);
  const scroll = new ScrollView(transcript, { primary: true, follow: "end" });
  if (tui instanceof FullscreenHost) {
    tui.setLayoutRoot(new VStack([{ component: scroll, basis: 0, grow: 1, minSize: 1 }, dock]));
  } else {
    tui.addChild(transcript);
    tui.addChild(dock);
  }
  tui.setFocus(editor);
  const host = Object.assign(Object.create(InteractiveMode.prototype) as object, {
    editor,
    defaultEditor: editor,
    editorContainer: dock,
    extensionDialogs: [],
    programStatus: { setBlocked() {} },
    keybindings: keys,
    ui: tui,
    clearExtensionTerminalInputListeners() {},
    setExtensionFooter() {},
    setExtensionHeader() {},
    clearExtensionWidgets() {},
    setCustomEditorComponent() {},
    setupAutocompleteProvider() {},
    updateTerminalTitle() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    footerDataProvider: { clearExtensionStatuses() {} },
    footer: { invalidate() {} },
  }) as { showExtensionCustom: ExtensionCommandContext["ui"]["custom"]; resetExtensionUI(): void };
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: (factory, options) => host.showExtensionCustom(factory, options),
      notify: () => assert.fail("unexpected error notification"),
    },
  } as ExtensionCommandContext;
  tui.start();
  tui.flush();
  return {
    ctx,
    editor,
    tui,
    scroll,
    reset: () => host.resetExtensionUI(),
    get component() {
      const component = dock.children[0];
      assert.ok(component && component !== editor, "custom component mounted");
      return component as Component & { dispose?(): void; waitForPending?(): Promise<void> };
    },
    async mounted() {
      await nextCycle();
      tui.flush();
      assert.notEqual(dock.children[0], editor);
    },
    send(data: string) {
      send(data);
      tui.flush();
    },
    stop() {
      host.resetExtensionUI();
      tui.stop();
      setKeybindings(previousKeys);
    },
  };
}

function choiceMenu(onSelect: (id: string) => void) {
  return defineMenu<undefined, "main", "apply", ExtensionCommandContext>({
    start: "main",
    screens: {
      main: () => ({
        kind: "choice",
        title: "Choice",
        items: Array.from({ length: 24 }, (_, i) => ({ id: `item-${i}`, label: `Item ${i}` })),
        action: "apply",
        viewportSize: 6,
        enableSearch: true,
      }),
    },
    actions: {
      apply: ({ itemId }) => {
        onSelect(itemId);
        return { kind: "close" };
      },
    },
  });
}

test("published 0.69 runMenu still strands dispose-only host teardown without the adapter", async (t) => {
  const host = sdkHost();
  t.onTestFinished(() => host.stop());
  let settled = false;
  void runMenu(
    host.ctx,
    choiceMenu(() => assert.fail("must not activate")),
    { getState: () => undefined },
  ).then(() => {
    settled = true;
  });
  await host.mounted();
  host.reset();
  await nextCycle();
  assert.equal(settled, false, "qualification sentinel: upstream runtime has no disposal settlement");
});

test("border adapter fences re-entrant and retained completion during host reset", async (t) => {
  const host = sdkHost();
  t.onTestFinished(() => host.stop());
  let lateComplete!: () => void;
  let disposals = 0;
  const ctx = withBorderedCustomUi(host.ctx);
  const running = ctx.ui.custom<string>((_tui, _theme, _keys, done) => {
    lateComplete = () => done("obsolete");
    return {
      render: () => ["Custom"],
      invalidate() {},
      dispose() {
        disposals++;
        lateComplete();
      },
    };
  });
  await host.mounted();
  host.reset();
  host.editor.setText("replacement");
  assert.equal(await running, undefined);
  lateComplete();
  assert.equal(disposals, 1);
  assert.equal(host.editor.getText(), "replacement");
  const menu = runMenu(
    ctx,
    choiceMenu(() => assert.fail("must not activate")),
    { getState: () => undefined },
  );
  await host.mounted();
  host.reset();
  assert.deepEqual(await menu, { kind: "closed", reason: "close" });
});

test("border adapter settles dispose-only menu teardown and drains accepted settings work", async (t) => {
  const host = sdkHost();
  t.onTestFinished(() => host.stop());
  const started = deferred<void>();
  const save = deferred<void>();
  let saved = false;
  let siblingDisposed = 0;
  const menu = defineMenu<undefined, "main", "save", ExtensionCommandContext>({
    start: "main",
    screens: {
      main: () => ({
        kind: "settings",
        title: "Settings",
        items: [{ id: "setting", label: "Setting", currentValue: "Off", values: ["Off", "On"], action: "save" }],
      }),
    },
    actions: {
      save: async () => {
        started.resolve();
        await save.promise;
        saved = true;
        return { kind: "stay" };
      },
    },
  });
  let settled = false;
  const running = runMenu(withBorderedCustomUi(host.ctx), menu, { getState: () => undefined }).then((result) => {
    settled = true;
    return result;
  });
  await host.mounted();
  host.send("\r");
  await started.promise;
  // A sibling proves reset iteration is not mutated by a synthetic done().
  void host.ctx.ui.custom(() => ({ render: () => ["Sibling"], invalidate() {}, dispose: () => siblingDisposed++ }));
  await host.mounted();
  host.reset();
  host.editor.setText("replacement draft");
  await nextCycle();
  assert.equal(siblingDisposed, 1);
  assert.equal(settled, false);
  save.resolve();
  assert.deepEqual(await running, { kind: "stale" });
  assert.equal(saved, true);
  assert.equal(host.editor.getText(), "replacement draft");
});

test("published custom interaction settles host disposal once and drains pending work", async (t) => {
  const host = sdkHost();
  t.onTestFinished(() => host.stop());
  const pending = deferred<void>();
  let disposals = 0;
  let lateComplete!: () => void;
  const running = runCustomInteraction(host.ctx, {
    create: ({ complete }) => {
      lateComplete = () => complete("obsolete");
      return {
        render: () => ["Custom"],
        invalidate() {},
        dispose: () => disposals++,
        waitForPending: () => pending.promise,
      };
    },
  });
  let settled = false;
  void running.then(() => {
    settled = true;
  });
  await host.mounted();
  const component = host.component;
  host.reset();
  component.dispose?.();
  host.editor.setText("new draft");
  lateComplete();
  await nextCycle();
  assert.equal(disposals, 1);
  assert.equal(settled, false);
  pending.resolve();
  assert.deepEqual(await running, { kind: "stale" });
  assert.equal(host.editor.getText(), "new draft");
});

test("owner cancellation during async creation retains and drains the late component", async (t) => {
  const host = sdkHost();
  t.onTestFinished(() => host.stop());
  const owner = new AbortController();
  const started = deferred<void>();
  const creation = deferred<void>();
  const pending = deferred<void>();
  let disposals = 0;
  const running = runCustomInteraction(host.ctx, {
    signal: owner.signal,
    create: async () => {
      started.resolve();
      await creation.promise;
      return { render: () => [], invalidate() {}, dispose: () => disposals++, waitForPending: () => pending.promise };
    },
  });
  let settled = false;
  void running.then(() => {
    settled = true;
  });
  await started.promise;
  owner.abort();
  host.reset();
  host.editor.setText("destination");
  creation.resolve();
  await nextCycle();
  assert.equal(disposals, 1);
  assert.equal(settled, false);
  pending.resolve();
  assert.deepEqual(await running, { kind: "stale" });
  assert.equal(host.editor.getText(), "destination");
});

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode} loading settles host disposal after draining its accepted query`, async (t) => {
    const host = sdkHost(mode);
    const owner = new AbortController();
    const started = deferred<void>();
    const query = deferred<AnalyticsLoadResult>();
    const snapshot = await querySnapshot([], { fromMs: 0, toMs: 10 });
    const result: AnalyticsLoadResult = { kind: "ready", snapshot };
    let querySignal: AbortSignal | undefined;
    let settled = false;
    let clears = 0;
    t.onTestFinished(() => {
      query.resolve(result);
      host.stop();
    });
    const running = showAnalyticsMenu(
      host.ctx,
      {
        path: "/tmp/test-analytics",
        load: (_range, signal) => {
          querySignal = signal;
          started.resolve();
          return query.promise;
        },
        clearAll: async () => {
          clears++;
          return { cleanupIncomplete: false };
        },
      },
      { signal: owner.signal, isCurrent: () => !owner.signal.aborted },
    ).then(() => {
      settled = true;
    });
    await started.promise;
    await host.mounted();
    host.reset();
    host.editor.setText("replacement draft");
    await nextCycle();
    assert.equal(querySignal?.aborted, true);
    assert.equal(settled, false, "accepted query work must still drain");
    query.resolve(result);
    await nextCycle();
    assert.equal(settled, true, "dispose-only host reset must settle the command");
    await running;
    assert.equal(host.editor.getText(), "replacement draft");
    assert.equal(clears, 0);
  });

  test(`${mode} response review and pair details settle actual host disposal without touching editor or Clear`, async (t) => {
    const host = sdkHost(mode, { "tui.select.pageDown": "ctrl+v", "tui.altScreen.pageDown": "ctrl+v" }, 14);
    t.onTestFinished(() => host.stop());
    const snapshot = await querySnapshot([], { fromMs: 0, toMs: 10 });
    snapshot.responses.modelPairs = Array.from({ length: 100 }, (_, index) => ({
      provider: "test",
      model: `request-${index}`,
      responseModel: `reported-${index}`,
      count: 1,
    }));
    let clears = 0;
    const controller = createAnalyticsMenu({
      path: "/tmp/test-analytics",
      load: async () => ({ kind: "ready", snapshot }),
      clearAll: async () => {
        clears += 1;
        return { cleanupIncomplete: false };
      },
    });
    controller.menu.start = "responses";
    for (const view of ["statistics", "pair"] as const) {
      const running = runMenu(withBorderedCustomUi(host.ctx), controller.menu, { getState: controller.getState });
      await host.mounted();
      assert.equal(host.component.capturesViewportInput, true);
      // Keep the transcript away from its follow-end/layout clamp: selecting a
      // row can resize the adaptive dock, but must not scroll transcript input.
      if (mode === "fullscreen") host.scroll.scrollTo(20);
      const before = host.scroll.scrollTop;
      const first = host.component.render(80).join("\n");
      host.send("\u0016");
      assert.notEqual(host.component.render(80).join("\n"), first);
      assert.equal(host.scroll.scrollTop, before);
      host.send("\u001b[H");
      if (view === "pair") host.send("\u001b[B");
      host.send("\r");
      assert.match(
        host.component.render(80).join("\n"),
        view === "pair" ? /Requested provider/ : /Response statistics/,
      );
      assert.equal(host.component.capturesViewportInput, true);
      const review = host.component.render(80).join("\n");
      host.send("\u0016");
      assert.notEqual(host.component.render(80).join("\n"), review);
      assert.equal(host.scroll.scrollTop, before);
      host.reset();
      host.editor.setText("replacement draft");
      assert.deepEqual(await running, { kind: "closed", reason: "close" });
      assert.equal(host.editor.getText(), "replacement draft");
      assert.equal(clears, 0);
    }
  });

  test(`${mode} list keeps fragmented paste and free text out of shortcut dispatch`, async (t) => {
    const host = sdkHost(mode, { "tui.select.pageDown": "ctrl+v", "tui.altScreen.pageDown": "ctrl+v" });
    t.onTestFinished(() => host.stop());
    let selected: string | undefined;
    const running = runMenu(
      withBorderedCustomUi(host.ctx),
      choiceMenu((id) => {
        selected = id;
      }),
      { getState: () => undefined },
    );
    await host.mounted();
    for (const chunk of ["\u001b[200~", "Item 0", "\u0016", "\u0003", "\u001b[201~"]) host.send(chunk);
    assert.equal(selected, undefined);
    host.send("\r");
    assert.deepEqual(await running, { kind: "closed", reason: "close" });
    assert.equal(selected, "item-0");
    assert.equal(host.editor.getText(), "opening draft");
  });

  for (const remapped of [false, true]) {
    test(`${mode} Kit list pages through the border wrapper (${remapped ? "remapped" : "default"})`, async (t) => {
      const host = sdkHost(
        mode,
        remapped ? { "tui.select.pageDown": "ctrl+v", "tui.altScreen.pageDown": "ctrl+v" } : {},
      );
      t.onTestFinished(() => host.stop());
      let selected: string | undefined;
      const running = runMenu(
        withBorderedCustomUi(host.ctx),
        choiceMenu((id) => {
          selected = id;
        }),
        { getState: () => undefined },
      );
      await host.mounted();
      assert.equal(host.component.capturesViewportInput, true);
      const before = host.scroll.scrollTop;
      const overlayInput: string[] = [];
      const overlay = host.tui.showOverlay({
        render: () => ["Other"],
        invalidate() {},
        handleInput: (data) => overlayInput.push(data),
      });
      const down = remapped ? "\u0016" : "\u001b[6~";
      host.send(down);
      assert.deepEqual(overlayInput, [down]);
      overlay.hide();
      host.send(down);
      assert.equal(host.scroll.scrollTop, before);
      host.send("\r");
      assert.deepEqual(await running, { kind: "closed", reason: "close" });
      assert.equal(selected, "item-6");
      assert.equal(host.editor.getText(), "opening draft");
    });
  }
}
