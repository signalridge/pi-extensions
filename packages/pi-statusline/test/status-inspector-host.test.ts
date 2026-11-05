import assert from "node:assert/strict";
import { type ExtensionContext, InteractiveMode, initTheme, VERSION } from "@earendil-works/pi-coding-agent";
import { type Component, Container, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import {
  STATUS_ACTION_OPEN,
  STATUS_ACTION_QUERY,
  type StatusActionOpen,
  type StatusActionQuery,
} from "../src/status-actions.js";
import { inspectStatuses } from "../src/status-inspector.js";
import { createMockContext, createMockPi } from "./support.js";

initTheme("dark", false);

test.each(["select", "cancel", "retire"])(
  "installed Pi custom host %s restores its draft before any owner open",
  async (exit) => {
    assert.ok(["1.0.4", "1.5.0"].includes(VERSION), `Unqualified Pi host version: ${VERSION}`);
    vi.useFakeTimers();
    const controller = new AbortController();
    const editor = {
      text: "original draft\nwith a second line",
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
    const ui = {
      terminal: { rows: 24, columns: 80 },
      requestRender() {},
      setFocus(component: Component) {
        focus = component;
      },
    };
    const host = Object.assign(Object.create(InteractiveMode.prototype) as object, {
      editor,
      editorContainer,
      ui,
      keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
      // 1.0.4 mounts directly; 1.5.0 owns a dialog stack and terminal-status reporter.
      ...(VERSION === "1.5.0" ? { extensionDialogs: [], programStatus: { setBlocked: vi.fn() } } : {}),
    }) as { showExtensionCustom: ExtensionContext["ui"]["custom"] };
    const context = createMockContext({
      mode: "tui",
      custom: (factory: Parameters<typeof host.showExtensionCustom>[0]) => host.showExtensionCustom(factory),
    });
    const mock = createMockPi();
    const opens: StatusActionOpen[] = [];
    mock.eventBus.on(STATUS_ACTION_QUERY, (value) => {
      const request = value as StatusActionQuery;
      mock.eventBus.emit(`${STATUS_ACTION_QUERY}:reply:${request.requestId}`, {
        success: true,
        data: {
          version: 1,
          providerId: "owner",
          surfaceId: "surface",
          sessionId: request.sessionId,
          entries: [{ statusKey: "status", actionId: "detail", label: "Owner detail" }],
        },
      });
    });
    mock.eventBus.on(STATUS_ACTION_OPEN, (value) => {
      const request = value as StatusActionOpen;
      assert.equal(focus, editor);
      assert.deepEqual(editorContainer.children, [editor]);
      assert.equal(editor.getText(), "original draft\nwith a second line");
      opens.push(request);
      mock.eventBus.emit(`${STATUS_ACTION_OPEN}:reply:${request.requestId}`, {
        success: true,
        data: { accepted: true },
      });
    });
    try {
      const pending = inspectStatuses(
        mock.pi,
        context.ctx,
        { signal: controller.signal, isCurrent: () => true },
        () => new Map([["status", "ready"]]),
      );
      await vi.advanceTimersByTimeAsync(50);
      const inspector = editorContainer.children[0];
      assert.ok(inspector && inspector !== editor);
      assert.equal(focus, inspector);
      assert.equal(inspector.capturesViewportInput, true);
      if (exit === "retire") controller.abort();
      else inspector.handleInput?.(exit === "select" ? "\r" : "\x1b");
      // Native close restores before any promise continuation, not after dispatch.
      assert.equal(focus, editor);
      assert.deepEqual(editorContainer.children, [editor]);
      assert.equal(opens.length, 0);
      await vi.advanceTimersByTimeAsync(50);
      await pending;
      assert.equal(opens.length, exit === "select" ? 1 : 0);
      assert.equal(editor.getText(), "original draft\nwith a second line");
      assert.deepEqual(mock.sentUserMessages, []);
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      controller.abort();
      vi.useRealTimers();
    }
  },
);
