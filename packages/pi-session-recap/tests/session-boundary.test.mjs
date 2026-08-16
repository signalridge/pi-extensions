import assert from "node:assert/strict";
import test from "node:test";
import { Container } from "@earendil-works/pi-tui";
import sessionRecap, { showRecap } from "../index.ts";

class TrackingContainer extends Container {
  removeCalls = 0;

  removeChild(component) {
    this.removeCalls += 1;
    super.removeChild(component);
  }
}

function makeUi(sessionManager = {}) {
  const document = new TrackingContainer();
  document.addChild(new Container());
  const tui = { mode: "fullscreen", children: [document] };
  const theme = { fg: (_name, text) => text, bold: (text) => text };
  const widgets = new Map();
  const ui = {
    theme,
    setStatus() {},
    setWidget(key, content, options) {
      widgets.get(key)?.component?.dispose?.();
      widgets.delete(key);
      if (content === undefined) return;
      const component = typeof content === "function" ? content(tui, theme) : undefined;
      widgets.set(key, { component, content, options });
    },
  };
  return { ctx: { mode: "tui", hasUI: true, ui, sessionManager }, document, widgets };
}

function makePi() {
  const events = new Map();
  const commands = new Map();
  const flags = new Map();
  return {
    events,
    commands,
    on(name, handler) {
      events.set(name, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerFlag(name, options) {
      flags.set(name, options.default);
    },
    getFlag(name) {
      return flags.get(name);
    },
  };
}

test("a cancelled pre-transition leaves the recap and state untouched", async () => {
  const pi = makePi();
  sessionRecap(pi);
  const { ctx, document } = makeUi();
  showRecap(ctx, "Old session recap.");

  assert.equal(pi.events.has("session_before_switch"), false);
  assert.equal(document.children.length, 2);
  assert.equal(document.removeCalls, 0);

  assert.equal(pi.events.has("session_before_fork"), false);
  assert.equal(document.children.length, 2);
  assert.equal(document.removeCalls, 0);
});

test("successful session shutdown clears transcript recaps exactly once", async () => {
  const pi = makePi();
  sessionRecap(pi);
  const { ctx, document } = makeUi();
  showRecap(ctx, "Old session recap.");

  await pi.events.get("session_shutdown")({ reason: "resume" }, ctx);
  assert.equal(document.children.length, 1);
  assert.equal(document.removeCalls, 1);

  await pi.events.get("session_shutdown")({ reason: "quit" }, ctx);
  assert.equal(document.children.length, 1);
  assert.equal(document.removeCalls, 1);
});

test("a new session clears a replacement context before any recap is scheduled", async () => {
  const pi = makePi();
  sessionRecap(pi);
  const { ctx, document } = makeUi();
  showRecap(ctx, "Stale recap.");

  await pi.events.get("session_start")({ reason: "startup" }, ctx);
  assert.equal(document.children.length, 1);
  assert.equal(document.removeCalls, 1);
});

test("a stale shutdown cannot clear the replacement session's recap", async () => {
  const pi = makePi();
  sessionRecap(pi);
  const oldSession = makeUi({ id: "old" });
  const newSession = makeUi({ id: "new" });

  await pi.events.get("session_start")({ reason: "startup" }, oldSession.ctx);
  showRecap(oldSession.ctx, "Old recap.");
  await pi.events.get("session_start")({ reason: "startup" }, newSession.ctx);
  showRecap(newSession.ctx, "New recap.");

  await pi.events.get("session_shutdown")({}, oldSession.ctx);
  assert.equal(newSession.document.children.length, 2);
  assert.equal(newSession.document.removeCalls, 0);
});

test("successful session tree navigation clears the old branch recap", async () => {
  const pi = makePi();
  sessionRecap(pi);
  const session = makeUi({ id: "session" });

  await pi.events.get("session_start")({ reason: "startup" }, session.ctx);
  showRecap(session.ctx, "Old branch recap.");
  assert.equal(session.document.children.length, 2);

  await pi.events.get("session_tree")({ newLeafId: "new", oldLeafId: "old" }, session.ctx);
  assert.equal(session.document.children.length, 1);
  assert.equal(session.document.removeCalls, 1);
});

test("input and agent-start cleanup remove regular fallback widgets", async () => {
  const pi = makePi();
  sessionRecap(pi);
  const { ctx, widgets } = makeUi();
  const regularTui = { mode: "regular", children: [] };
  ctx.ui.setWidget = (key, content, options) => {
    widgets.get(key)?.component?.dispose?.();
    widgets.delete(key);
    if (content === undefined) return;
    const component = typeof content === "function" ? content(regularTui, ctx.ui.theme) : undefined;
    widgets.set(key, { component, content, options });
  };

  showRecap(ctx, "Regular recap.");
  assert.equal(widgets.get("session-recap").options.placement, "aboveEditor");
  await pi.events.get("input")({}, ctx);
  assert.equal(widgets.has("session-recap"), false);

  showRecap(ctx, "Another regular recap.");
  await pi.events.get("agent_start")({}, ctx);
  assert.equal(widgets.has("session-recap"), false);
});

test("lifecycle handlers do not touch UI APIs in headless contexts", async () => {
  const pi = makePi();
  sessionRecap(pi);
  const ctx = {
    mode: "print",
    hasUI: false,
    ui: {
      get theme() {
        throw new Error("headless UI accessed");
      },
      setWidget() {
        throw new Error("headless widget accessed");
      },
      setStatus() {
        throw new Error("headless status accessed");
      },
    },
  };

  await pi.events.get("input")({}, ctx);
  await pi.events.get("agent_start")({}, ctx);
  await pi.events.get("session_shutdown")({}, ctx);
  await pi.events.get("session_start")({ reason: "startup" }, ctx);
  await pi.commands.get("recap").handler("", ctx);
  assert.ok(true);
});

test("resume timers ignore stale contexts across switch, reload, and shutdown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  for (const transition of ["switch", "reload", "shutdown"]) {
    const pi = makePi();
    sessionRecap(pi);
    let branchReads = 0;
    const manager = {
      getBranch() {
        branchReads += 1;
        return [];
      },
      buildContextEntries() {
        branchReads += 1;
        return [];
      },
    };
    const oldSession = makeUi(manager);

    await pi.events.get("session_start")({ reason: "resume" }, oldSession.ctx);
    await pi.events.get("session_shutdown")({ reason: transition }, oldSession.ctx);
    if (transition !== "shutdown") {
      await pi.events.get("session_start")({ reason: transition }, makeUi({}).ctx);
    }

    t.mock.timers.tick(300);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(branchReads, 0, `${transition} must not touch the stale session context`);
  }
});
