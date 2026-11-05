import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExtensionCommandContext,
  ExtensionEditorComponent,
  InteractiveMode,
  initTheme,
  SessionManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Editor,
  getKeybindings,
  type KeybindingsConfig,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { ownedEditor } from "../src/command-owner.js";
import { registerStatuslineCommand } from "../src/commands.js";
import { loadStatuslineSettings } from "../src/settings.js";
import statusline from "../src/statusline.js";
import { createMockContext, createMockPi } from "./support.js";

initTheme("dark", false);

function createKeys(bindings?: KeybindingsConfig) {
  return new KeybindingsManager(
    { ...TUI_KEYBINDINGS, "app.editor.external": { defaultKeys: "ctrl+g", description: "External editor" } },
    bindings,
  );
}

// Exercise Pi's real custom-dialog mounting, closing and draft restoration.
function createEditorHost(keys = createKeys()) {
  assert.ok(["1.0.4", "1.5.0"].includes(VERSION), `Unqualified Pi host version: ${VERSION}`);
  const editor = {
    text: "original draft",
    focused: true,
    getText() {
      return this.text;
    },
    setText(text: string) {
      this.text = text;
    },
    render: () => [],
    invalidate() {},
  };
  const editorContainer = new Container();
  editorContainer.addChild(editor);
  let focus: Component = editor;
  let restores = 0;
  const ui = {
    terminal: { rows: 24, columns: 100 },
    stop: vi.fn(),
    start: vi.fn(),
    requestRender: vi.fn(),
    setFocus(component: Component) {
      if ("focused" in focus) focus.focused = false;
      focus = component;
      if ("focused" in focus) focus.focused = true;
      if (component === editor) restores++;
    },
  };
  const host = Object.assign(Object.create(InteractiveMode.prototype) as object, {
    editor,
    editorContainer,
    ui,
    keybindings: keys,
    // 1.0.4 mounts directly; 1.5.0 owns a dialog stack and terminal-status reporter.
    ...(VERSION === "1.5.0" ? { extensionDialogs: [], programStatus: { setBlocked: vi.fn() } } : {}),
  }) as { showExtensionCustom: ExtensionCommandContext["ui"]["custom"] };
  const custom: ExtensionCommandContext["ui"]["custom"] = (factory, options) =>
    host.showExtensionCustom(factory, options);
  return {
    custom,
    editor,
    editorContainer,
    ui,
    get focus() {
      return focus;
    },
    get restores() {
      return restores;
    },
    async mountedEditor() {
      // showExtensionCustom mounts the synchronous factory in a microtask.
      await Promise.resolve();
      const component = editorContainer.children[0];
      assert.ok(component instanceof ExtensionEditorComponent);
      const input = component.children.find((child) => child instanceof Editor);
      assert.ok(input instanceof Editor);
      assert.equal(focus, component);
      assert.equal(component.focused, true);
      assert.equal(input.focused, true);
      assert.equal(editor.focused, false);
      return { component, input };
    },
  };
}

test.each(["tree", "shutdown"] as const)(
  "Pi host %s synchronously restores the editor and ignores late callbacks over a replacement dialog",
  async (boundary) => {
    const directory = mkdtempSync(join(tmpdir(), "pi-statusline-editor-host-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    const path = join(directory, "pi-statusline.json");
    const document = '{"palettePreset":"classic","segments":["model"]}\n';
    writeFileSync(path, document);
    const host = createEditorHost();
    const sessionManager = SessionManager.inMemory(directory);
    const context = createMockContext({ mode: "tui", custom: host.custom, sessionManager });
    const mock = createMockPi();
    const emit = async (name: string) => {
      for (const handler of mock.events.get(name) ?? []) await handler({}, context.ctx);
    };
    let closeReplacement!: () => void;
    try {
      statusline(mock.pi);
      await emit("session_start");
      const pending = mock.commands.get("statusline")?.handler("settings", context.ctx);
      const old = await host.mountedEditor();
      assert.deepEqual(JSON.parse(old.input.getText()), JSON.parse(document));
      const changing = emit(boundary === "tree" ? "session_before_tree" : "session_shutdown");
      // Restoration must happen before a pre-navigation handler returns, not
      // in the continuation of an abandoned editor promise.
      assert.deepEqual(host.editorContainer.children, [host.editor]);
      assert.equal(host.focus, host.editor);
      assert.equal(host.editor.focused, true);
      assert.equal(old.component.focused, false);
      assert.equal(old.input.focused, false);
      assert.equal(host.restores, 1);
      assert.equal(host.editor.text, "original draft");
      await changing;
      host.editor.setText("branch draft");
      if (boundary === "tree") {
        await emit("session_tree");
        assert.equal((context.ctx as ExtensionCommandContext).sessionManager, sessionManager);
      }
      await pending; // Shutdown also settles without any user reply.
      const notifications = context.notifications.length;
      const replacement = { render: () => [], invalidate() {}, focused: false };
      const replacementResult = host.custom<void>((_tui, _theme, _keys, done) => {
        closeReplacement = () => done();
        return replacement;
      });
      await Promise.resolve();
      assert.deepEqual(host.editorContainer.children, [replacement]);
      assert.equal(host.focus, replacement);
      assert.equal(replacement.focused, true);
      // Invoke an already captured submit callback, bypassing the retired
      // input guard; even this cannot call Pi's close on the new dialog.
      old.input.onSubmit?.('{"palettePreset":"forest","segments":[]}');
      ExtensionEditorComponent.prototype.handleInput.call(old.component, "\u001b");
      old.component.handleInput("\r");
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(host.editorContainer.children, [replacement]);
      assert.equal(host.focus, replacement);
      assert.equal(host.restores, 1);
      assert.equal(host.editor.text, "branch draft");
      assert.equal(readFileSync(path, "utf8"), document);
      assert.equal(context.notifications.length, notifications);
      closeReplacement();
      await replacementResult;
      assert.equal(host.editor.text, "branch draft");
    } finally {
      closeReplacement?.();
      await emit("session_shutdown");
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  },
  10_000,
);

test("owned public editor keeps Enter, Shift+Enter, Escape, configurable keys and listener cleanup", async () => {
  const previousKeys = getKeybindings();
  const controller = new AbortController();
  const add = vi.spyOn(controller.signal, "addEventListener");
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const owner = { signal: controller.signal, isCurrent: () => true };
  const host = createEditorHost();
  const context = createMockContext({ mode: "tui", custom: host.custom });
  try {
    setKeybindings(createKeys());
    const submitted = ownedEditor(context.ctx, owner, "Settings", "first");
    const first = await host.mountedEditor();
    first.component.handleInput("\u001b[13;2u"); // Kitty Shift+Enter
    first.component.handleInput("second");
    assert.equal(first.input.getText(), "first\nsecond");
    first.component.handleInput("\r");
    assert.equal(await submitted, "first\nsecond");
    assert.equal(host.focus, host.editor);
    const cancelled = ownedEditor(context.ctx, owner, "Settings", "discard");
    (await host.mountedEditor()).component.handleInput("\u001b");
    assert.equal(await cancelled, undefined);
    setKeybindings(createKeys({ "tui.input.submit": "ctrl+s", "tui.select.cancel": "ctrl+q" }));
    const remapped = ownedEditor(context.ctx, owner, "Settings", "remapped");
    (await host.mountedEditor()).component.handleInput("\u0013");
    assert.equal(await remapped, "remapped");
    const remappedCancel = ownedEditor(context.ctx, owner, "Settings", "discard");
    (await host.mountedEditor()).component.handleInput("\u0011");
    assert.equal(await remappedCancel, undefined);
    const added = add.mock.calls.filter(([name]) => name === "abort");
    const removed = remove.mock.calls.filter(([name]) => name === "abort");
    assert.equal(added.length, 4);
    for (const [, listener] of added) assert.ok(removed.some(([, removedListener]) => listener === removedListener));
    const restores = host.restores;
    controller.abort();
    assert.equal(host.restores, restores);
  } finally {
    controller.abort();
    setKeybindings(previousKeys);
  }
});

test("submission followed by retirement before await resumes cannot apply settings", async () => {
  const controller = new AbortController();
  const host = createEditorHost();
  const context = createMockContext({ mode: "tui", custom: host.custom });
  const pending = ownedEditor(context.ctx, { signal: controller.signal, isCurrent: () => true }, "Settings", "old");
  (await host.mountedEditor()).input.onSubmit?.("late");
  controller.abort();
  assert.equal(await pending, undefined);
  assert.equal(host.restores, 1);
});

test("registered settings editor preserves Pi's configured command over VISUAL and its external-editor key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-statusline-external-editor-"));
  const previousVisual = process.env.VISUAL;
  const script = join(directory, "editor.mjs");
  const fallbackScript = join(directory, "fallback.mjs");
  writeFileSync(
    script,
    'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "external value\\n");',
  );
  writeFileSync(
    fallbackScript,
    'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "wrong editor\\n");',
  );
  process.env.VISUAL = `${process.execPath} ${fallbackScript}`;
  const controller = new AbortController();
  const host = createEditorHost(createKeys({ "app.editor.external": "ctrl+x" }));
  const context = createMockContext({ mode: "tui", custom: host.custom });
  const settingsPath = join(directory, "pi-statusline.json");
  const mock = createMockPi({ externalEditor: `${process.execPath} ${script}` });
  registerStatuslineCommand(mock.pi, {
    settingsPath,
    getLoaded: () => loadStatuslineSettings(settingsPath),
    getMenuOwner: () => ({ signal: controller.signal, isCurrent: () => true }),
    apply() {},
  });
  try {
    const command = mock.commands.get("statusline");
    assert.ok(command);
    const pending = command.handler("settings", context.ctx);
    const { component, input } = await host.mountedEditor();
    const resumed = new Promise<void>((resolve) => host.ui.start.mockImplementation(resolve));
    component.handleInput("\u0018");
    assert.equal(host.ui.stop.mock.calls.length, 1);
    await resumed;
    assert.equal(input.getText(), "external value");
    component.handleInput("\u001b");
    await pending;
    assert.equal(host.focus, host.editor);
  } finally {
    controller.abort();
    if (previousVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = previousVisual;
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);

test.each(["navigation", "shutdown"] as const)(
  "pending external editor respects %s terminal lifetime",
  async (boundary) => {
    const directory = mkdtempSync(join(tmpdir(), "pi-statusline-pending-editor-"));
    const script = join(directory, "editor.mjs");
    writeFileSync(script, 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "late value\\n");');
    const controller = new AbortController();
    let hostActive = true;
    const host = createEditorHost(createKeys());
    const context = createMockContext({ mode: "tui", custom: host.custom });
    try {
      const pending = ownedEditor(
        context.ctx,
        { signal: controller.signal, isCurrent: () => !controller.signal.aborted, isHostActive: () => hostActive },
        "Settings",
        "before",
        `${process.execPath} ${script}`,
      );
      const { component, input } = await host.mountedEditor();
      let completed!: () => void;
      const externalCompleted = new Promise<void>((resolve) => {
        completed = resolve;
      });
      const setText = input.setText.bind(input);
      vi.spyOn(input, "setText").mockImplementation((text) => {
        setText(text);
        completed();
      });
      component.handleInput("\u0007");
      assert.equal(host.ui.stop.mock.calls.length, 1);
      hostActive = boundary === "navigation";
      controller.abort();
      assert.equal(await pending, undefined);
      host.editor.setText("target draft");
      const renders = host.ui.requestRender.mock.calls.length;
      await externalCompleted;
      assert.equal(host.editor.getText(), "target draft");
      assert.equal(host.focus, host.editor);
      assert.equal(host.ui.start.mock.calls.length, boundary === "navigation" ? 1 : 0);
      if (boundary === "shutdown") assert.equal(host.ui.requestRender.mock.calls.length, renders);
    } finally {
      controller.abort();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  10_000,
);
