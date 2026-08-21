import assert from "node:assert/strict";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { borderedComponent, hasBorderRules, withBorderedCustomUi } from "../src/index.js";

test("frames an unbordered component and preserves width", () => {
  const component = {
    render: (width: number) => [`content ${width}`],
    invalidate() {},
  };
  const framed = borderedComponent(component, (text) => `<border>${text}</border>`);
  const lines = framed.render(12);

  assert.equal(lines.length, 3);
  assert.equal(lines[0], "<border>────────────</border>");
  assert.equal(lines[1], "content 12");
  assert.equal(lines[2], lines[0]);
});

test("does not double-frame an existing bordered component", () => {
  const component = {
    render: () => ["────────", "content", "────────"],
    invalidate() {},
  };
  const framed = borderedComponent(component, (text) => `color(${text})`);

  assert.deepEqual(framed.render(8), ["────────", "content", "────────"]);
  assert.equal(hasBorderRules(framed.render(8)), true);
});

test("forwards input, focus, invalidation, and disposal", () => {
  const calls: string[] = [];
  const component = {
    focused: false,
    render: () => ["content"],
    handleInput: (data: string) => calls.push(`input:${data}`),
    invalidate: () => calls.push("invalidate"),
    dispose: () => calls.push("dispose"),
  };
  const framed = borderedComponent(component, (text) => text);

  framed.focused = true;
  framed.handleInput("enter");
  framed.invalidate();
  framed.dispose();

  assert.equal(component.focused, true);
  assert.deepEqual(calls, ["input:enter", "invalidate", "dispose"]);
});

test("keeps passive components passive and forwards pending work", async () => {
  let pendingFinished = false;
  const component = {
    render: () => ["content"],
    invalidate() {},
    async waitForPending() {
      pendingFinished = true;
    },
  };
  const framed = borderedComponent(component, (text) => text);

  assert.equal("focused" in framed, false);
  await framed.waitForPending?.();
  assert.equal(pendingFinished, true);
});

test("wraps only custom UI and leaves native dialog methods unchanged", async () => {
  let customFactory: ((done: (value: string) => void) => unknown) | undefined;
  const select = async () => "native";
  const ui = {
    select,
    confirm: async () => true,
    input: async () => "input",
    editor: async () => "editor",
    notify() {},
    onTerminalInput: () => () => {},
    setStatus() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget() {},
    setFooter() {},
    setHeader() {},
    setTitle() {},
    pasteToEditor() {},
    setEditorText() {},
    getEditorText: () => "",
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent: () => undefined,
    theme: undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: true }),
    getToolsExpanded: () => false,
    setToolsExpanded() {},
    custom: async <T>(factory: (tui: never, theme: never, keybindings: never, done: (value: T) => void) => unknown) => {
      customFactory = (done) => factory(undefined as never, undefined as never, undefined as never, done);
      return undefined;
    },
  } as unknown as ExtensionUIContext;

  const wrapped = withBorderedCustomUi({ ui });
  assert.equal(await wrapped.ui.select("title", ["one"]), "native");
  assert.notEqual(wrapped.ui, ui);
  await wrapped.ui.custom(() => ({ render: () => ["content"], invalidate() {} }));
  assert.ok(customFactory);
});
