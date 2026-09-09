import assert from "node:assert/strict";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Editor,
  MouseRegion,
  SelectList,
  TuiAltScreen,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
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
    render: () => ["╭──────╮", "│ content │", "╰──────╯"],
    invalidate() {},
  };
  const framed = borderedComponent(component, (text) => `color(${text})`);

  assert.deepEqual(framed.render(8), ["╭──────╮", "│ content │", "╰──────╯"]);
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

function mouse(type: TuiMouseEvent["type"], y: number): TuiMouseEvent {
  return {
    type,
    button: "left",
    x: 0,
    y,
    screenX: 10,
    screenY: 20 + y,
    width: 1,
    height: 3,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta: -1,
  };
}

test("forwards mouse coordinates, return identity, capture, and focus only over content", () => {
  const calls: TuiMouseEvent[] = [];
  const result = { handled: true, capture: true, focus: true, render: false };
  const component = {
    focused: false,
    render: () => ["x"],
    invalidate() {},
    handleMouse(event: TuiMouseEvent) {
      calls.push(event);
      return result;
    },
  };
  const framed = borderedComponent(component, (text) => text);
  framed.render(1);
  for (const type of ["wheel", "click", "press", "drag", "release", "move"] as const) {
    const event = mouse(type, 1);
    assert.equal(framed.handleMouse?.(event), result);
    assert.deepEqual(calls.at(-1), { ...event, y: 0, height: 1 });
    assert.equal(event.y, 1);
    // Finish any owned gesture before testing fresh border hit tests.
    framed.handleMouse?.(mouse("release", 1));
    const count = calls.length;
    assert.equal(framed.handleMouse?.(mouse(type, 0)), undefined);
    assert.equal(framed.handleMouse?.(mouse(type, 2)), undefined);
    assert.equal(calls.length, count);
  }
  // Captured movement outside the wrapper retains its relative coordinates.
  framed.handleMouse?.(mouse("press", 1));
  framed.handleMouse?.(mouse("drag", -2));
  assert.equal(calls.at(-1)?.y, -3);
  framed.focused = true;
  assert.equal(component.focused, true);
});

test("owned gestures release on borders, offscreen, and after empty renders", () => {
  for (const capture of [true, false]) {
    for (const releaseY of [0, 2, -5, 20]) {
      for (const empty of [false, true]) {
        let lines = ["x"];
        let dragging = false;
        const calls: TuiMouseEvent[] = [];
        const result = { handled: true, capture, focus: true, render: false };
        const framed = borderedComponent(
          {
            render: () => lines,
            invalidate() {},
            handleMouse(event) {
              calls.push(event);
              if (event.type === "press") dragging = true;
              if (event.type === "release") dragging = false;
              return result;
            },
          },
          (text) => text,
        );
        framed.render(1);
        assert.equal(framed.handleMouse?.(mouse("press", 1)), result);
        assert.equal(dragging, true);
        if (empty) {
          lines = [];
          framed.render(1);
        }
        const height = empty ? 2 : 3;
        for (const type of ["drag", "release"] as const) {
          const event = { ...mouse(type, releaseY), height };
          assert.equal(framed.handleMouse?.(event), result);
          assert.deepEqual(calls.at(-1), { ...event, y: releaseY - 1, height: height - 2 });
        }
        assert.equal(dragging, false);
        const count = calls.length;
        for (const type of ["press", "click", "wheel", "drag", "release"] as const) {
          assert.equal(framed.handleMouse?.(mouse(type, 0)), undefined);
        }
        assert.equal(calls.length, count);
      }
    }
  }
});

test("disposal clears gesture ownership", () => {
  let calls = 0;
  const framed = borderedComponent(
    {
      render: () => ["x"],
      invalidate() {},
      handleMouse() {
        calls++;
        return { capture: true };
      },
    },
    (text) => text,
  );
  framed.render(1);
  framed.handleMouse?.(mouse("press", 1));
  framed.dispose?.();
  assert.equal(framed.handleMouse?.(mouse("release", 0)), undefined);
  assert.equal(calls, 1);
});

test("native capture dispatch retains wrapper-local coordinates and keyboard focus", () => {
  const calls: TuiMouseEvent[] = [];
  const framed = borderedComponent(
    {
      focused: false,
      render: () => ["a", "b"],
      invalidate() {},
      handleMouse(event) {
        calls.push(event);
        return { capture: true, focus: true };
      },
    },
    (text) => text,
  );
  framed.render(1);
  const press = { ...mouse("press", 1), height: 4 };
  const parent = new Container();
  parent.addChild(framed);
  parent.render(1);
  const result = parent.handleMouse(press);
  assert.deepEqual(result, {
    handled: true,
    capture: true,
    focus: true,
    focusTarget: framed,
    target: { component: framed, originX: 10, originY: 20, width: 1, height: 4 },
  });
  // The captured target receives wrapper-local coordinates on later movement.
  framed.handleMouse?.({ ...press, type: "drag", y: 2, screenY: press.screenY + 1 });
  assert.equal(calls.at(-1)?.y, 1);
  assert.equal(calls.at(-1)?.height, 2);
});

test("descendant-owned release does not leave a border gesture captured", () => {
  const identity = (s: string) => s;
  const list = new SelectList([{ value: "one", label: "one" }], 5, {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  });
  const calls: TuiMouseEvent[] = [];
  const region = new MouseRegion(list, (event) => {
    calls.push(event);
    return { capture: true };
  });
  const framed = borderedComponent(region, identity);
  framed.render(20);
  const press = region.handleMouse({ ...mouse("press", 0), width: 20, height: 1 });
  assert.equal(press?.target?.component, list);
  const result = framed.handleMouse?.({ ...mouse("press", 1), width: 20, height: 3 });
  assert.equal((result as typeof press)?.target?.component, list);
  // Native host delivers the retained gesture directly, bypassing the adapter.
  list.handleMouse({ ...mouse("release", 0), width: 20, height: 1 });
  assert.equal(framed.handleMouse?.(mouse("drag", 0)), undefined);
  assert.equal(framed.handleMouse?.(mouse("press", 0)), undefined);
  assert.equal(framed.handleMouse?.(mouse("drag", 0)), undefined);
  assert.deepEqual(calls, []);
});

test("clipped native container keeps the last visible content row clickable", () => {
  const inner = new Container();
  let clicked = false;
  inner.addChild({
    render: () => ["a", "b", "c", "d", "e"],
    invalidate() {},
    handleMouse(event) {
      clicked = event.y === 3;
      return { handled: true };
    },
  });
  const framed = borderedComponent(inner, (s) => s);
  framed.render(10);
  framed.handleMouse?.({ ...mouse("click", 4), width: 10, height: 5 });
  assert.equal(clicked, true);
});

test("native editor autocomplete retains overlay keyboard ownership", async () => {
  class Host extends TuiAltScreen {
    focusTarget(component: Component) {
      return this.resolveMouseFocusTarget(component);
    }
  }
  const tui = new Host({ columns: 40, rows: 20, hideCursor() {} } as never);
  const identity = (s: string) => s;
  const editor = new Editor(tui, {
    borderColor: identity,
    selectList: {
      selectedPrefix: identity,
      selectedText: identity,
      description: identity,
      scrollInfo: identity,
      noMatch: identity,
    },
  });
  editor.setAutocompleteProvider({
    getSuggestions: () => ({
      prefix: "/",
      items: [
        { value: "/one", label: "one" },
        { value: "/two", label: "two" },
      ],
    }),
    applyCompletion: (_lines, _line, _col, item) => ({
      lines: [item.value],
      cursorLine: 0,
      cursorCol: item.value.length,
    }),
  });
  editor.handleInput("/");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const inner = new Container();
  inner.addChild(editor);
  const framed = borderedComponent(inner, identity);
  tui.showOverlay(framed);
  const lines = framed.render(40);
  const press = framed.handleMouse?.({ ...mouse("press", 4), width: 40, height: lines.length });
  const target = (press as { target?: { component: Component } })?.target?.component;
  assert.equal(target, editor);
  const click = target?.handleMouse?.({ ...mouse("click", 3), width: 40, height: lines.length - 2 });
  assert.equal(click?.focus, true);
  assert.ok(target);
  assert.equal(tui.focusTarget(target), framed);
});

test("mouse forwarding follows the latest border detection and empty content", () => {
  let lines = ["──", "content", "──"];
  let received: TuiMouseEvent | undefined;
  const framed = borderedComponent(
    {
      render: () => lines,
      invalidate() {},
      handleMouse(event) {
        received = event;
        return { handled: true };
      },
    },
    (text) => text,
  );
  framed.render(2);
  const event = mouse("click", 0);
  framed.handleMouse?.(event);
  assert.equal(received, event);
  lines = [];
  framed.render(1);
  received = undefined;
  for (const y of [-1, 0, 1, 2]) framed.handleMouse?.(mouse("release", y));
  assert.equal(received, undefined);
  lines = ["x"];
  framed.render(1);
  framed.handleMouse?.(mouse("wheel", 1));
  assert.equal(received?.y, 0);
  assert.equal(borderedComponent({ render: () => [], invalidate() {} }, (s) => s).handleMouse, undefined);
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
