import assert from "node:assert/strict";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import history, { HistoryPopupComponent } from "../src/index.js";

function setupShortcut() {
  let editorText = "draft";
  const renderedEditorText: string[] = [];
  let popup: HistoryPopupComponent | undefined;
  let runShortcut: ((ctx: ExtensionContext) => Promise<void>) | undefined;

  const tui = {
    requestRender: () => renderedEditorText.push(editorText),
  } as unknown as TUI;
  const ctx = {
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getBranch: () => [{ type: "message", message: { role: "user", content: "remembered prompt" } }],
    },
    ui: {
      // Like Pi's overlay close: repaint is requested before custom() resolves.
      custom: (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) =>
        new Promise((resolve) => {
          const component = factory(tui, {} as never, {} as never, (result) => {
            tui.requestRender();
            resolve(result);
          });
          assert.ok(component instanceof HistoryPopupComponent);
          popup = component;
        }),
      setEditorText: (text: string) => {
        editorText = text;
      },
    },
  } as unknown as ExtensionContext;
  history({
    on() {},
    registerShortcut(_key: string, shortcut: { handler: (ctx: ExtensionContext) => Promise<void> }) {
      runShortcut = shortcut.handler;
    },
  } as never);

  return {
    open: async () => {
      assert.ok(runShortcut);
      const running = runShortcut(ctx);
      await vi.waitFor(() => assert.ok(popup)); // The shortcut waits for the history scan before opening.
      return { popup, running };
    },
    getEditorText: () => editorText,
    renderedEditorText,
  };
}

test("accepting a reverse-search match repaints the editor after the overlay closes", async () => {
  const { open, getEditorText, renderedEditorText } = setupShortcut();
  const { popup, running } = await open();

  popup.handleInput("\r");
  assert.ok(renderedEditorText.length > 0);
  assert.ok(renderedEditorText.every((text) => text === "draft"));
  const beforeEditorUpdate = renderedEditorText.length;

  await running;
  assert.equal(getEditorText(), "remembered prompt");
  assert.equal(renderedEditorText.length, beforeEditorUpdate + 1);
  assert.equal(renderedEditorText.at(-1), "remembered prompt");
});

test("cancelling reverse search keeps the draft and does not request an extra repaint", async () => {
  const { open, getEditorText, renderedEditorText } = setupShortcut();
  const { popup, running } = await open();

  popup.handleInput("\x1b");
  const rendersAfterClose = renderedEditorText.length;
  await running;

  assert.equal(getEditorText(), "draft");
  assert.equal(renderedEditorText.length, rendersAfterClose);
});

type SessionList = Awaited<ReturnType<typeof SessionManager.list>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function expectSettled(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await vi.waitFor(() => assert.equal(settled, true), { timeout: 1_000 });
  await promise;
}

function setupSessionScans() {
  const oldScan = deferred<SessionList>();
  const newScan = deferred<SessionList>();
  vi.spyOn(SessionManager, "list").mockImplementation((cwd) => (cwd === "/old" ? oldScan.promise : newScan.promise));
  vi.spyOn(SessionManager, "open").mockImplementation(
    (path) =>
      ({
        getEntries: () => [{ type: "message", message: { role: "user", content: path } }],
      }) as never,
  );

  let cwd = "/old";
  let branch = ["old branch"];
  let editorText = "draft";
  const renderedEditorText: string[] = [];
  const popups: HistoryPopupComponent[] = [];
  let activePopup: HistoryPopupComponent | undefined;
  let closedPopups = 0;
  const inheritedHistory: string[] = [];
  const inheritedEditor = { addToHistory: (text: string) => inheritedHistory.push(text) };
  const inheritedFactory = () => inheritedEditor as never;
  let editorFactory: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];
  const tui = { requestRender: () => renderedEditorText.push(editorText) } as unknown as TUI;
  const ctx = {
    mode: "tui",
    hasUI: true,
    get cwd() {
      return cwd;
    },
    sessionManager: {
      getBranch: () => branch.map((text) => ({ type: "message", message: { role: "user", content: text } })),
    },
    ui: {
      getEditorComponent: () => inheritedFactory,
      setEditorComponent: (factory: typeof editorFactory) => {
        editorFactory = factory;
      },
      custom: (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) =>
        new Promise<string | null>((resolve) => {
          const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };
          let closed = false;
          const done = (result: unknown) => {
            if (closed) return; // Pi's close callback is idempotent.
            closed = true;
            activePopup = undefined; // Pi hides the overlay before settling custom().
            closedPopups++;
            tui.requestRender();
            resolve(result as string | null);
          };
          // Pi mounts the component in a microtask after calling the factory.
          Promise.resolve(factory(tui, theme as never, {} as never, done)).then((component) => {
            if (closed) return;
            assert.ok(component instanceof HistoryPopupComponent);
            activePopup = component;
            popups.push(component);
          });
        }),
      setEditorText: (text: string) => {
        editorText = text;
      },
      notify: () => assert.fail("history was unexpectedly empty"),
    },
  } as unknown as ExtensionContext;
  const lifecycle = new Map<string, (event: never, ctx: ExtensionContext) => void>();
  let shortcut: ((ctx: ExtensionContext) => Promise<void>) | undefined;
  history({
    on(event: string, handler: (event: never, ctx: ExtensionContext) => void) {
      lifecycle.set(event, handler);
    },
    registerShortcut(_key: string, registered: { handler: (ctx: ExtensionContext) => Promise<void> }) {
      shortcut = registered.handler;
    },
  } as never);

  const start = () => lifecycle.get("session_start")?.({} as never, ctx);
  const shutdown = () => lifecycle.get("session_shutdown")?.({} as never, ctx);
  const beforeTree = () => lifecycle.get("session_before_tree")?.({} as never, ctx);
  const commitTree = (messages: string[]) => {
    branch = messages;
    lifecycle.get("session_tree")?.({} as never, ctx);
  };
  const trigger = (context: ExtensionContext = ctx) => {
    assert.ok(shortcut);
    return shortcut(context);
  };
  const finishScan = (scan: typeof oldScan, text: string) => {
    scan.resolve([{ path: text, modified: new Date("2026-01-01") }] as SessionList);
  };

  return {
    oldScan,
    newScan,
    start,
    shutdown,
    beforeTree,
    commitTree,
    trigger,
    finishScan,
    setBranch: (messages: string[]) => {
      branch = messages;
    },
    switchSession: () => {
      shutdown();
      cwd = "/new";
      branch = ["new branch"];
      start();
    },
    popups,
    getActivePopup: () => activePopup,
    getClosedPopups: () => closedPopups,
    inheritedHistory,
    getEditorFactory: () => editorFactory,
    getEditorText: () => editorText,
    renderedEditorText,
  };
}

test("Ctrl+R repeats during a scan select older entries in one popup", async () => {
  const fixture = setupSessionScans();
  fixture.start();
  const first = fixture.trigger();
  await fixture.trigger(); // While the scan is unresolved, queue one move down.
  assert.equal(fixture.popups.length, 0);

  fixture.finishScan(fixture.oldScan, "cached prompt");
  await vi.waitFor(() => assert.equal(fixture.popups.length, 1));
  assert.ok(fixture.popups[0]);
  assert.ok(fixture.popups[0].render(100).some((line) => line.includes("2/2")));
  fixture.popups[0].handleInput("\r");
  await first;
  assert.equal(fixture.getEditorText(), "cached prompt");
  assert.equal(fixture.renderedEditorText.at(-1), "cached prompt");

  const reopened = fixture.trigger();
  await vi.waitFor(() => assert.equal(fixture.popups.length, 2));
  assert.ok(fixture.popups[1]);
  fixture.popups[1].handleInput("\x1b");
  await reopened;
  assert.equal(fixture.getEditorText(), "cached prompt");
  assert.equal(fixture.getClosedPopups(), 2);
});

test("queued repeat presses have a finite navigation cap", async () => {
  const fixture = setupSessionScans();
  fixture.start();
  fixture.setBranch(Array.from({ length: 103 }, (_, index) => `branch ${index}`));
  const running = fixture.trigger();
  await Promise.all(Array.from({ length: 150 }, () => fixture.trigger()));
  fixture.finishScan(fixture.oldScan, "cached prompt");
  await vi.waitFor(() => assert.equal(fixture.popups.length, 1));
  assert.ok(fixture.popups[0]);
  fixture.popups[0].handleInput("\r");
  await running;
  assert.equal(fixture.getEditorText(), "branch 2");
});

test("a repeat after the popup opens moves within that popup", async () => {
  const fixture = setupSessionScans();
  fixture.start();
  fixture.finishScan(fixture.oldScan, "cached prompt");
  const running = fixture.trigger();
  await vi.waitFor(() => assert.equal(fixture.popups.length, 1));
  await fixture.trigger();
  assert.equal(fixture.popups.length, 1);
  assert.ok(fixture.popups[0]);
  fixture.popups[0].handleInput("\r");
  await running;
  assert.equal(fixture.getEditorText(), "cached prompt");
});

test("a headless shortcut cannot start a popup", async () => {
  const fixture = setupSessionScans();
  fixture.start();
  await fixture.trigger({ mode: "print", hasUI: false } as ExtensionContext);
  fixture.finishScan(fixture.oldScan, "cached prompt");
  await Promise.resolve();
  assert.equal(fixture.popups.length, 0);
});

test("a committed tree navigation retires a pending scan and searches the new branch", async () => {
  const fixture = setupSessionScans();
  fixture.start();
  const oldShortcut = fixture.trigger();
  fixture.commitTree(["new branch"]);
  await expectSettled(oldShortcut); // The old session I/O may never finish.
  assert.equal(fixture.popups.length, 0);

  const newShortcut = fixture.trigger();
  fixture.finishScan(fixture.oldScan, "cached prompt");
  await vi.waitFor(() => assert.equal(fixture.popups.length, 1));
  assert.ok(fixture.popups[0]);
  fixture.popups[0].handleInput("\r");
  await newShortcut;
  assert.equal(fixture.getEditorText(), "new branch");
  assert.equal(fixture.renderedEditorText.at(-1), "new branch");
  assert.equal(fixture.getClosedPopups(), 1);
});

test("a committed tree navigation closes the old popup before a new-branch selection", async () => {
  const fixture = setupSessionScans();
  fixture.start();
  fixture.finishScan(fixture.oldScan, "cached prompt");
  const oldShortcut = fixture.trigger();
  await vi.waitFor(() => assert.equal(fixture.popups.length, 1));
  assert.equal(fixture.getActivePopup(), fixture.popups[0]);

  fixture.commitTree(["new branch"]);
  await expectSettled(oldShortcut);
  assert.equal(fixture.getActivePopup(), undefined);
  assert.equal(fixture.getClosedPopups(), 1);
  assert.equal(fixture.getEditorText(), "draft");
  assert.ok(fixture.popups[0]);
  fixture.popups[0].handleInput("\r"); // A late old-branch selection must be ignored.
  assert.equal(fixture.getEditorText(), "draft");

  const newShortcut = fixture.trigger();
  await vi.waitFor(() => assert.equal(fixture.popups.length, 2));
  assert.ok(fixture.popups[1]);
  fixture.popups[1].handleInput("\r");
  await newShortcut;
  assert.equal(fixture.getEditorText(), "new branch");
  assert.equal(fixture.renderedEditorText.at(-1), "new branch");
  assert.equal(fixture.getClosedPopups(), 2);
});

test("a cancelled pre-tree navigation leaves the old popup active", async () => {
  const fixture = setupSessionScans();
  fixture.start();
  fixture.finishScan(fixture.oldScan, "cached prompt");
  const running = fixture.trigger();
  await vi.waitFor(() => assert.equal(fixture.popups.length, 1));

  fixture.beforeTree(); // Navigation was proposed but cancelled; no session_tree follows.
  assert.equal(fixture.getActivePopup(), fixture.popups[0]);
  assert.equal(fixture.getClosedPopups(), 0);
  assert.ok(fixture.popups[0]);
  fixture.popups[0].handleInput("\r");
  await running;
  assert.equal(fixture.getEditorText(), "old branch");
  assert.equal(fixture.renderedEditorText.at(-1), "old branch");
});

test("switching during a scan discards the old shortcut and preserves the new scan's ownership", async () => {
  const fixture = setupSessionScans();
  fixture.start();
  const oldShortcut = fixture.trigger();
  fixture.switchSession();
  const newShortcut = fixture.trigger();

  fixture.finishScan(fixture.oldScan, "old cached prompt");
  await oldShortcut;
  assert.equal(fixture.popups.length, 0);
  assert.equal(fixture.getEditorText(), "draft");
  assert.equal(fixture.getEditorFactory(), undefined);

  const duplicate = fixture.trigger();
  await duplicate;
  fixture.finishScan(fixture.newScan, "new cached prompt");
  await vi.waitFor(() => assert.equal(fixture.popups.length, 1));
  assert.ok(fixture.popups[0]);
  const popup = fixture.popups[0];
  assert.ok(popup.render(100).some((line) => line.includes("new cached prompt")));
  assert.ok(popup.render(100).every((line) => !line.includes("old cached prompt")));
  popup.handleInput("\x1b");
  await newShortcut;
  assert.equal(fixture.getEditorText(), "draft");

  // The scan still composes with an existing editor instead of replacing it.
  fixture.getEditorFactory()?.({} as never, {} as never, {} as never);
  assert.deepEqual(fixture.inheritedHistory, ["new cached prompt"]);
});

test("session shutdown settles a shortcut even if the history scan never resolves", async () => {
  const fixture = setupSessionScans();
  fixture.start();
  const running = fixture.trigger();
  fixture.shutdown();

  await expectSettled(running);
  assert.equal(fixture.popups.length, 0);
  assert.equal(fixture.getEditorText(), "draft");
});

test("a session switch settles the old pending scan without waiting for old I/O", async () => {
  const fixture = setupSessionScans();
  fixture.start();
  const oldShortcut = fixture.trigger();
  fixture.switchSession();
  await expectSettled(oldShortcut);

  const newShortcut = fixture.trigger();
  fixture.finishScan(fixture.newScan, "new cached prompt");
  await vi.waitFor(() => assert.equal(fixture.popups.length, 1));
  assert.ok(fixture.popups[0]);
  fixture.popups[0].handleInput("\x1b");
  await expectSettled(newShortcut);
  assert.equal(fixture.getEditorText(), "draft");
});

test("shutdown settles an active overlay without requiring another session", async () => {
  const fixture = setupSessionScans();
  fixture.start();
  fixture.finishScan(fixture.oldScan, "cached prompt");
  const running = fixture.trigger();
  await vi.waitFor(() => assert.equal(fixture.popups.length, 1));

  fixture.shutdown();
  await expectSettled(running);
  assert.equal(fixture.getActivePopup(), undefined);
  assert.equal(fixture.getClosedPopups(), 1);
  assert.equal(fixture.getEditorText(), "draft");
});

test("shutdown settles the active overlay; a late selection cannot update the next editor", async () => {
  const fixture = setupSessionScans();
  fixture.start();
  fixture.finishScan(fixture.oldScan, "old cached prompt");
  const oldShortcut = fixture.trigger();
  await vi.waitFor(() => assert.equal(fixture.popups.length, 1));
  assert.equal(fixture.getActivePopup(), fixture.popups[0]);

  // Pi's resetExtensionUI only hides the overlay; it does not call done().
  // This event must close it through done before the old shortcut can hang.
  fixture.switchSession();
  await expectSettled(oldShortcut);
  assert.equal(fixture.getActivePopup(), undefined);
  assert.equal(fixture.getClosedPopups(), 1);
  assert.equal(fixture.getEditorText(), "draft");
  assert.ok(fixture.popups[0]);
  fixture.popups[0].handleInput("\r"); // A late callback is ignored by Pi's close guard.
  assert.equal(fixture.getEditorText(), "draft");
  assert.equal(fixture.getClosedPopups(), 1);

  const newShortcut = fixture.trigger();
  fixture.finishScan(fixture.newScan, "new cached prompt");
  await vi.waitFor(() => assert.equal(fixture.popups.length, 2));
  assert.ok(fixture.popups[1]);
  fixture.popups[1].handleInput("\r");
  await newShortcut;
  assert.equal(fixture.getEditorText(), "new branch");
  assert.equal(fixture.renderedEditorText.at(-1), "new branch");
  assert.equal(fixture.getClosedPopups(), 2);
});
