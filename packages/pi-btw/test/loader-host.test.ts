import assert from "node:assert/strict";
import {
  BorderedLoader,
  type ExtensionCommandContext,
  InteractiveMode,
  initTheme,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import btw from "../src/btw.js";
import { createMockContext, createMockPi } from "./support.js";

initTheme("dark", false);

// The installed host only disposes mounted components. In particular it does
// not mount (or dispose) a factory result whose done() ran in an earlier microtask.
function createLoaderHost() {
  assert.ok(["1.0.4", "1.5.0"].includes(VERSION), `Unqualified Pi host version: ${VERSION}`);
  let text = "original draft";
  let mounted: Component | undefined;
  let mounts = 0;
  let restores = 0;
  const render = vi.fn();
  const editor = { getText: () => text, setText: (value: string) => (text = value) };
  // The editor starts visible and focused until a dialog mounts in its place.
  let focus: unknown = editor;
  let visible: unknown[] = [editor];
  const host = Object.assign(Object.create(InteractiveMode.prototype) as object, {
    editor,
    editorContainer: {
      clear() {
        visible = [];
      },
      addChild(component: Component) {
        visible.push(component);
        if (component === (editor as unknown as Component)) restores++;
        else {
          mounted = component;
          mounts++;
        }
      },
    },
    ui: {
      terminal: { rows: 24, columns: 80 },
      setFocus(component: Component) {
        focus = component;
      },
      requestRender: render,
    },
    keybindings: { matches: () => false, getKeys: () => [] },
    // 1.0.4 mounts directly; 1.5.0 owns a dialog stack and terminal-status reporter.
    ...(VERSION === "1.5.0" ? { extensionDialogs: [], programStatus: { setBlocked() {} } } : {}),
  }) as { showExtensionCustom: ExtensionCommandContext["ui"]["custom"] };
  return {
    custom: ((factory, options) =>
      host.showExtensionCustom(factory, options)) as ExtensionCommandContext["ui"]["custom"],
    editor,
    render,
    get text() {
      return text;
    },
    get focus() {
      return focus;
    },
    get visible() {
      return visible;
    },
    get mounted() {
      return mounted;
    },
    get mounts() {
      return mounts;
    },
    get restores() {
      return restores;
    },
  };
}

function createCommand(host: ReturnType<typeof createLoaderHost>, overrides: Record<string, unknown> = {}) {
  const context = createMockContext({ mode: "tui", custom: host.custom, ...overrides });
  const mock = createMockPi();
  const runThread = vi.fn(async () => ({ kind: "closed" as const }));
  btw(mock.pi, {
    loadSettings: async () => ({}),
    runFullscreen: async (ctx, run) => run(ctx),
    runThread,
  });
  const command = mock.commands.get("btw");
  assert.ok(command);
  return { context, mock, runThread, run: () => command.handler("side question", context.ctx) };
}

test.each(["virtual", "unavailable"] as const)(
  "installed Pi immediate %s resolution disposes the credential loader before mount",
  async (outcome) => {
    vi.useFakeTimers();
    const dispose = vi.spyOn(BorderedLoader.prototype, "dispose");
    const host = createLoaderHost();
    const command = createCommand(host, {
      model:
        outcome === "virtual" ? { api: "pi-virtual", provider: "test", id: "virtual", reasoning: false } : undefined,
    });
    // 1.0.4 reattaches the editor on every close; 1.5.0 never replaced it for a dialog closed before mounting.
    const restoresPerRun = VERSION === "1.5.0" ? 0 : 1;
    try {
      for (let invocation = 0; invocation < 3; invocation++) {
        await command.run();
        assert.equal(host.mounts, 0);
        assert.deepEqual(host.visible, [host.editor]);
        assert.equal(host.restores, (invocation + 1) * restoresPerRun);
        assert.equal(dispose.mock.calls.length, invocation + 1);
        assert.equal(vi.getTimerCount(), 0);
      }
      assert.equal(command.runThread.mock.calls.length, outcome === "virtual" ? 3 : 0);
      assert.equal(command.context.notifications.length, outcome === "unavailable" ? 3 : 0);
      const renders = host.render.mock.calls.length;
      await vi.advanceTimersByTimeAsync(400);
      assert.equal(host.render.mock.calls.length, renders);
      assert.equal(host.text, "original draft");
      assert.equal(host.focus, host.editor);
    } finally {
      // Also clean a reproduced leak when running this test before the fix.
      for (const instance of dispose.mock.instances) instance.dispose();
      vi.clearAllTimers();
    }
  },
);

test.each(["cancel", "error", "factory-error"] as const)(
  "installed Pi credential loader cleanup is idempotent on %s and late resolution is inert",
  async (outcome) => {
    vi.useFakeTimers();
    let release!: (value: { ok: true; apiKey: string }) => void;
    let reject!: (error: Error) => void;
    const credentials = new Promise<{ ok: true; apiKey: string }>((resolve, fail) => {
      release = resolve;
      reject = fail;
    });
    const dispose = vi.spyOn(BorderedLoader.prototype, "dispose");
    const host = createLoaderHost();
    const command = createCommand(host, {
      model: { provider: "test", id: "physical", reasoning: false },
      modelRegistry: { getApiKeyAndHeaders: () => credentials },
    });
    if (outcome === "factory-error") {
      Object.defineProperty(command.context.ctx, "model", {
        get() {
          throw new Error("stale model context");
        },
      });
    }
    const running = command.run();
    try {
      if (outcome === "factory-error") {
        await assert.rejects(Promise.resolve(running), /stale model context/u);
      } else {
        for (let tick = 0; tick < 6; tick++) await Promise.resolve();
        assert.ok(host.mounted);
        assert.equal(vi.getTimerCount(), 1);
        if (outcome === "cancel") {
          for (const handler of command.mock.events.get("session_before_switch") ?? []) {
            await handler({ reason: "new" }, command.context.ctx);
          }
        } else reject(new Error("credential failure"));
        await running;
      }
      assert.equal(dispose.mock.calls.length, 1);
      assert.equal(vi.getTimerCount(), 0);
      host.editor.setText("replacement draft");
      const restores = host.restores;
      const renders = host.render.mock.calls.length;
      release({ ok: true, apiKey: "late key" });
      await credentials.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(400);
      assert.equal(host.restores, restores);
      assert.equal(host.render.mock.calls.length, renders);
      assert.equal(host.text, "replacement draft");
      assert.equal(command.runThread.mock.calls.length, 0);
      assert.equal(dispose.mock.calls.length, 1);
    } finally {
      release({ ok: true, apiKey: "cleanup" });
      vi.clearAllTimers();
    }
  },
);
