import assert from "node:assert/strict";
import { type ExtensionUIContext, InteractiveMode, initTheme, VERSION } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { withBorderedCustomUi, withPreservedCustomEditor } from "../src/index.js";

initTheme("dark", false);

// Test-only host internals: exercise the installed SDK's real savedText path,
// exposing the same public UI API an extension receives. No production patches.
// Both qualified hosts restore the opening draft synchronously inside done().
function sdkHost() {
  assert.ok(["1.0.4", "1.5.0"].includes(VERSION), `Unqualified Pi host version: ${VERSION}`);
  let text = "original draft";
  let invalid = false;
  let writes = 0;
  let mounted: Component | undefined;
  const editor = {
    getText: () => text,
    setText(value: string) {
      text = value;
    },
  };
  const host = Object.assign(Object.create(InteractiveMode.prototype) as object, {
    editor,
    editorContainer: {
      clear() {},
      addChild(component: Component) {
        if (component !== (editor as unknown as Component)) mounted = component;
      },
    },
    ui: {
      setFocus() {},
      requestRender() {},
      showOverlay(component: Component) {
        mounted = component;
        return {};
      },
      hideOverlay() {},
    },
    keybindings: {},
    // 1.0.4 mounts directly; 1.5.0 owns a dialog stack and terminal-status reporter.
    ...(VERSION === "1.5.0" ? { extensionDialogs: [], programStatus: { setBlocked() {} } } : {}),
  }) as { createExtensionUIContext(): ExtensionUIContext };
  const native = host.createExtensionUIContext();
  const ui: ExtensionUIContext = {
    ...native,
    getEditorText() {
      if (invalid) throw new Error("retired context");
      return native.getEditorText();
    },
    setEditorText(value) {
      if (invalid) throw new Error("retired context");
      writes++;
      native.setEditorText(value);
    },
  };
  return {
    ui,
    editor,
    retire() {
      invalid = true;
    },
    get text() {
      return text;
    },
    get writes() {
      return writes;
    },
    get mounted() {
      return mounted;
    },
  };
}

const passive = (): Component => ({ render: () => ["content"], invalidate() {} });

async function tick(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test("the unadapted SDK really overwrites editor changes with its opening draft", async () => {
  const host = sdkHost();
  await host.ui.custom((_tui, _theme, _keys, done) => {
    host.ui.setEditorText("quoted edit");
    done("ok");
    return passive();
  });
  assert.equal(host.text, "original draft");
});

test.each(["sync", "async", "mounted"] as const)(
  "SDK %s completion preserves quote edits and duplicate finish is inert",
  async (kind) => {
    const host = sdkHost();
    const ctx = withPreservedCustomEditor({ ui: host.ui, extra: "context" });
    let finish!: (result: string | undefined) => void;
    const factory = (_tui: unknown, _theme: unknown, _keys: unknown, done: typeof finish) => {
      finish = done;
      if (kind !== "mounted") {
        host.ui.setEditorText("quoted message\nwith edits 👩‍💻");
        done("ok");
        host.ui.setEditorText("destination after completion");
        done("duplicate");
      }
      return passive();
    };
    const running = ctx.ui.custom<string | undefined>(kind === "async" ? async (...args) => factory(...args) : factory);
    if (kind === "mounted") {
      await tick();
      assert.ok(host.mounted);
      host.ui.setEditorText("quoted message\nwith edits 👩‍💻");
      finish("ok");
      assert.equal(host.text, "quoted message\nwith edits 👩‍💻");
      host.ui.setEditorText("destination after completion");
      finish("duplicate");
    }
    assert.equal(await running, "ok");
    assert.equal(host.text, "destination after completion");
    assert.equal(ctx.extra, "context");
    assert.equal(host.writes, 3);
    host.ui.setEditorText("destination after await");
    finish(undefined);
    await tick();
    assert.equal(host.text, "destination after await");
  },
);

test.each([false, true])(
  "SDK cancel (async=%s) preserves a pre-completion destination writer",
  async (asyncFactory) => {
    const host = sdkHost();
    const ui = withPreservedCustomEditor({ ui: host.ui }).ui;
    const controller = new AbortController();
    let finish!: () => void;
    const factory = (_tui: unknown, _theme: unknown, _keys: unknown, done: (value: undefined) => void) => {
      finish = () => done(undefined);
      return passive();
    };
    const running = ui.custom(asyncFactory ? async (...args) => factory(...args) : factory);
    await tick();
    host.ui.setEditorText("destination before abort");
    controller.signal.addEventListener("abort", finish, { once: true });
    controller.abort();
    assert.equal(await running, undefined);
    assert.equal(host.text, "destination before abort");
  },
);

test("SDK unchanged draft is not rewritten and overlays retain their own editor behavior", async () => {
  const host = sdkHost();
  const ui = withPreservedCustomEditor({ ui: host.ui }).ui;
  await ui.custom((_tui, _theme, _keys, done) => {
    done(undefined);
    return passive();
  });
  assert.equal(host.text, "original draft");
  assert.equal(host.writes, 0);
  await ui.custom(
    (_tui, _theme, _keys, done) => {
      ui.setEditorText("overlay edit");
      done(undefined);
      return passive();
    },
    { overlay: true },
  );
  assert.equal(host.text, "overlay edit");
  assert.equal(host.writes, 1);
});

test.each(["sync", "async"] as const)(
  "SDK %s factory errors preserve writes without masking the error",
  async (kind) => {
    const host = sdkHost();
    const ui = withPreservedCustomEditor({ ui: host.ui }).ui;
    const error = new Error("factory failed");
    const fail = () => {
      ui.setEditorText("edit before failure");
      throw error;
    };
    await assert.rejects(ui.custom(kind === "async" ? async () => fail() : fail), (actual) => actual === error);
    assert.equal(host.text, "edit before failure");
  },
);

test("SDK disposal's destination writer wins over captured text", async () => {
  const host = sdkHost();
  let finish!: (result: undefined) => void;
  const running = withPreservedCustomEditor({ ui: host.ui }).ui.custom((_tui, _theme, _keys, done) => {
    finish = done;
    return { ...passive(), dispose: () => host.ui.setEditorText("destination from dispose") };
  });
  await tick();
  host.ui.setEditorText("quote before done");
  finish(undefined);
  await running;
  assert.equal(host.text, "destination from dispose");
  assert.equal(host.writes, 2);
});

test.each(["before-open", "before-done", "during-dispose"] as const)(
  "invalid context at %s fails closed",
  async (when) => {
    const host = sdkHost();
    if (when === "before-open") host.retire();
    let finish!: (result: undefined) => void;
    const running = withPreservedCustomEditor({ ui: host.ui }).ui.custom((_tui, _theme, _keys, done) => {
      finish = done;
      return {
        ...passive(),
        dispose: () => {
          if (when === "during-dispose") host.retire();
        },
      };
    });
    await tick();
    host.editor.setText("changed editor");
    if (when === "before-done") host.retire();
    finish(undefined);
    await running;
    // The SDK itself restores the old text; the adapter must not write via stale UI.
    assert.equal(host.text, "original draft");
    assert.equal(host.writes, 0);
  },
);

test.each(["border-first", "preserve-first"] as const)("composes with border adapter in %s order", async (order) => {
  const host = sdkHost();
  const ctx =
    order === "border-first"
      ? withPreservedCustomEditor(withBorderedCustomUi({ ui: host.ui }))
      : withBorderedCustomUi(withPreservedCustomEditor({ ui: host.ui }));
  let finish!: (result: undefined) => void;
  const running = ctx.ui.custom((_tui, _theme, _keys, done) => {
    finish = done;
    return passive();
  });
  await tick();
  assert.equal(host.mounted?.render(10).length, 3);
  ctx.ui.setEditorText("quoted edit");
  finish(undefined);
  await running;
  assert.equal(host.text, "quoted edit");
});

// A deferred-close public host double covers waitForPending without adding a
// component lifecycle wrapper or changing which host owns cancellation.
function pendingHost(afterRestore?: (ui: ExtensionUIContext) => void) {
  let text = "draft";
  let resume!: () => void;
  const pending = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const ui = {
    getEditorText: () => text,
    setEditorText(value: string) {
      text = value;
    },
    custom: async (factory, options) => {
      const opening = text;
      let close!: () => void;
      const closed = new Promise<void>((resolve) => {
        close = resolve;
      });
      const component = await factory({} as never, {} as never, {} as never, close);
      await closed;
      await (component as Component & { waitForPending?(): Promise<void> }).waitForPending?.();
      if (!options?.overlay) text = opening;
      afterRestore?.(ui);
      component.dispose?.();
      return undefined;
    },
  } as ExtensionUIContext;
  return {
    ui,
    pending,
    resume: () => resume(),
    get text() {
      return text;
    },
  };
}

test.each([false, true])("deferred restoration waits for pending; later destination wins=%s", async (laterWriter) => {
  const host = pendingHost(laterWriter ? (ui) => ui.setEditorText("later destination") : undefined);
  let finish!: () => void;
  const running = withPreservedCustomEditor({ ui: host.ui }).ui.custom((_tui, _theme, _keys, done) => {
    finish = () => done(undefined);
    return { ...passive(), waitForPending: () => host.pending };
  });
  await tick();
  host.ui.setEditorText("quote before close");
  finish();
  await tick();
  assert.equal(host.text, "quote before close");
  host.resume();
  await running;
  assert.equal(host.text, laterWriter ? "later destination" : "quote before close");
});

test("writes during pending work erased by the host are not observable through the public API", async () => {
  const host = pendingHost();
  let finish!: () => void;
  const running = withPreservedCustomEditor({ ui: host.ui }).ui.custom((_tui, _theme, _keys, done) => {
    finish = () => done(undefined);
    return { ...passive(), waitForPending: () => host.pending };
  });
  await tick();
  host.ui.setEditorText("pre-done quote");
  finish();
  host.ui.setEditorText("newer pending write");
  host.resume();
  await running;
  // Explicit limitation regression: no editor setter interception/ownership lock.
  assert.equal(host.text, "pre-done quote");
});

test("a later writer restoring the opening draft after synchronous repair is not replayed over", async () => {
  const host = sdkHost();
  await withPreservedCustomEditor({ ui: host.ui }).ui.custom((_tui, _theme, _keys, done) => {
    host.ui.setEditorText("quote");
    done(undefined);
    host.ui.setEditorText("original draft");
    return passive();
  });
  assert.equal(host.text, "original draft");
  assert.equal(host.writes, 3);
});

test("a settled host cancellation without done cannot supply a pre-restoration capture", async () => {
  let text = "draft";
  let finish!: (value: undefined) => void;
  const ui = {
    getEditorText: () => text,
    setEditorText(value: string) {
      text = value;
    },
    custom: async (factory) => {
      await factory({} as never, {} as never, {} as never, () => {});
      text = "draft";
      return undefined;
    },
  } as ExtensionUIContext;
  await withPreservedCustomEditor({ ui }).ui.custom((_tui, _theme, _keys, done) => {
    finish = done;
    ui.setEditorText("quote");
    return passive();
  });
  assert.equal(text, "draft");
  ui.setEditorText("later destination");
  finish(undefined);
  assert.equal(text, "later destination");
});

test("a failing pending host keeps the original rejection and any later destination", async () => {
  const error = new Error("pending failed");
  let text = "draft";
  const ui = {
    getEditorText: () => text,
    setEditorText(value: string) {
      text = value;
    },
    custom: async (factory) => {
      const component = await factory({} as never, {} as never, {} as never, () => {
        text = "draft";
      });
      text = "destination after close";
      await (component as Component & { waitForPending(): Promise<void> }).waitForPending();
    },
  } as ExtensionUIContext;
  await assert.rejects(
    withPreservedCustomEditor({ ui }).ui.custom((_tui, _theme, _keys, done) => {
      ui.setEditorText("quote");
      done(undefined);
      return {
        ...passive(),
        waitForPending: async () => {
          throw error;
        },
      };
    }),
    (actual) => actual === error,
  );
  assert.equal(text, "destination after close");
});
