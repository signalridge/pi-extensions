import assert from "node:assert/strict";
import test from "node:test";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { showRecap } from "../index.ts";

class TrackingContainer extends Container {
  removeCalls = 0;

  removeChild(component) {
    this.removeCalls += 1;
    super.removeChild(component);
  }
}

function createUi({ mode = "fullscreen", documentShape = "container" } = {}) {
  const document =
    documentShape === "container" ? new TrackingContainer() : documentShape === "plain" ? { children: [] } : undefined;
  if (document instanceof Container) {
    for (let i = 0; i < 3; i += 1) document.addChild(new Container());
  }
  const tui = { mode, children: document === undefined ? [] : [document] };
  const theme = { fg: (_name, text) => text, bold: (text) => text };
  const widgets = new Map();
  const statuses = [];
  const ui = {
    theme,
    setStatus(key, text) {
      statuses.push({ key, text });
    },
    setWidget(key, content, options) {
      widgets.get(key)?.component?.dispose?.();
      widgets.delete(key);
      if (content === undefined) return;
      const component = typeof content === "function" ? content(tui, theme) : undefined;
      widgets.set(key, { content, component, options });
    },
  };
  return {
    ctx: { mode: "tui", hasUI: true, ui },
    document,
    tui,
    widgets,
    statuses,
  };
}

test("fullscreen recap is temporary transcript content", () => {
  const { ctx, document, widgets } = createUi();
  showRecap(ctx, "Temporary recap text.");

  assert.equal(document.children.length, 4);
  const transcript = document.children[3];
  assert.match(transcript.render(80).join("\n"), /Temporary recap text/);
  assert.equal(widgets.get("session-recap").options.placement, "aboveEditor");
  assert.deepEqual(widgets.get("session-recap").component.render(80), []);

  const widget = widgets.get("session-recap").component;
  widget.dispose();
  widget.dispose();
  assert.equal(document.children.length, 3, "transcript removal is idempotent");
  assert.equal(document.removeCalls, 1);

  ctx.ui.setWidget("session-recap", undefined);
  assert.equal(document.children.length, 3);
  assert.equal(document.removeCalls, 1);
});

test("replacing a fullscreen recap removes the old transcript component once", () => {
  const { ctx, document } = createUi();
  showRecap(ctx, "First recap.");
  showRecap(ctx, "Second recap.");

  assert.equal(document.children.length, 4);
  assert.match(document.children[3].render(80).join("\n"), /Second recap/);
  assert.equal(document.removeCalls, 1);

  ctx.ui.setWidget("session-recap", undefined);
  assert.equal(document.children.length, 3);
  assert.equal(document.removeCalls, 2);
});

test("fullscreen recap rendering remains width-safe", () => {
  const { ctx, document } = createUi();
  showRecap(ctx, "A very long recap with an intentionally unbroken xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.");

  for (const line of document.children[3].render(12)) {
    assert.ok(visibleWidth(line) <= 12, `line exceeds width: ${visibleWidth(line)}`);
  }
});

test("regular TUI renders the recap above the editor", () => {
  const { ctx, document, widgets } = createUi({ mode: "regular" });
  showRecap(ctx, "Temporary recap text.");

  assert.equal(document.children.length, 4, "the hidden transcript component stays mounted");
  assert.equal(widgets.get("session-recap").options.placement, "aboveEditor");
  assert.match(widgets.get("session-recap").component.render(80).join("\n"), /Temporary recap text/);
  assert.deepEqual(document.children[3].render(80), []);
});

test("fullscreen to regular and back migrates the same recap on render", () => {
  const { ctx, document, tui, widgets } = createUi();
  showRecap(ctx, "Temporary recap text.");

  const transcript = document.children[3];
  const dock = widgets.get("session-recap").component;
  assert.match(document.render(80).join("\n"), /Temporary recap text/);
  assert.deepEqual(dock.render(80), []);

  tui.mode = "regular";
  assert.deepEqual(transcript.render(80), []);
  assert.match(dock.render(80).join("\n"), /Temporary recap text/);
  assert.equal(document.children.length, 4, "rendering does not remount the transcript");

  tui.mode = "fullscreen";
  assert.match(transcript.render(80).join("\n"), /Temporary recap text/);
  assert.deepEqual(dock.render(80), []);
});

test("regular to fullscreen migrates the same recap on render", () => {
  const { ctx, document, tui, widgets } = createUi({ mode: "regular" });
  showRecap(ctx, "Temporary recap text.");

  const transcript = document.children[3];
  const dock = widgets.get("session-recap").component;
  assert.match(dock.render(80).join("\n"), /Temporary recap text/);
  assert.deepEqual(transcript.render(80), []);

  tui.mode = "fullscreen";
  assert.match(document.render(80).join("\n"), /Temporary recap text/);
  assert.deepEqual(dock.render(80), []);
});

test("malformed or unavailable fullscreen documents use the regular fallback", () => {
  for (const documentShape of ["plain", "missing"]) {
    const { ctx, widgets } = createUi({ documentShape });
    assert.doesNotThrow(() => showRecap(ctx, "Temporary recap text."));
    assert.equal(widgets.get("session-recap").options.placement, "aboveEditor");
    assert.deepEqual(widgets.get("session-recap").content, ["✦ recap", "Temporary recap text."]);
  }
});

test("print and JSON contexts never call widget APIs", () => {
  let calls = 0;
  const ui = {
    get theme() {
      calls += 1;
      throw new Error("headless UI accessed");
    },
    setWidget() {
      calls += 1;
      throw new Error("headless widget accessed");
    },
  };

  assert.doesNotThrow(() => showRecap({ mode: "print", hasUI: false, ui }, "ignored"));
  assert.doesNotThrow(() => showRecap({ mode: "json", hasUI: false, ui }, "ignored"));
  assert.equal(calls, 0);
});
