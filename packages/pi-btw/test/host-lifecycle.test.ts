import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
  InteractiveMode,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { test } from "vitest";
import btw from "../src/btw.js";
import { runBtwFullscreen } from "../src/fullscreen-ui.js";
import { showBtwCommandMenu } from "../src/menu.js";

// Call Pi's actual showExtensionCustom implementation on a minimal TUI shell.
// In particular, its savedText/restoreEditor logic must not be simulated away.
function createPiEditorHost(initialText: string) {
  let editorText = initialText;
  let openComponent: Component | undefined;
  let opened!: () => void;
  const openedPromise = new Promise<void>((resolve) => {
    opened = resolve;
  });
  let closeCount = 0;
  const editor = {
    getText: () => editorText,
    setText: (value: string) => {
      editorText = value;
    },
  };
  const host = Object.assign(Object.create(InteractiveMode.prototype) as object, {
    editor,
    editorContainer: {
      clear() {},
      addChild(component: Component) {
        if (component === (editor as unknown as Component)) {
          closeCount++;
        } else {
          openComponent = component;
          opened();
        }
      },
    },
    ui: {
      terminal: {
        rows: 24,
        columns: 80,
        start() {},
        stop() {},
        write() {},
        hideCursor() {},
        showCursor() {},
      },
      stop() {},
      start() {},
      renderNow() {},
      getShowHardwareCursor: () => false,
      setFocus() {},
      requestRender() {},
    },
    keybindings: { matches: () => false, getKeys: () => [] },
  }) as unknown as { showExtensionCustom: ExtensionCommandContext["ui"]["custom"] };
  const custom: ExtensionCommandContext["ui"]["custom"] = (factory, options) =>
    host.showExtensionCustom(factory, options);
  return {
    custom,
    editor,
    get text() {
      return editorText;
    },
    get openComponent() {
      return openComponent;
    },
    get closeCount() {
      return closeCount;
    },
    async waitForOpen() {
      await openedPromise;
    },
  };
}

type Transition = "new" | "tree" | "cancelled-new" | "cancelled-tree";

async function withRealPiMenu(transition: Transition) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-btw-host-boundary-"));
  const host = createPiEditorHost(transition.endsWith("tree") ? "" : "old draft");
  let runtime: AgentSessionRuntime | undefined;
  let threadStarts = 0;
  try {
    const settingsManager = SettingsManager.inMemory({ defaultModel: "anthropic/claude-sonnet-4-5" });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      extensionFactories: [
        {
          name: "btw-host-boundary",
          factory: (pi) => {
            btw(pi, {
              showCommandMenu: (_pi, ctx, _threads, isSessionCurrent, registerClose) =>
                showBtwCommandMenu(ctx, {
                  settingsPath: join(cwd, "pi-btw.json"),
                  currentThinkingLevel: "off",
                  availableThinkingLevels: ["off", "low"],
                  isSessionCurrent,
                  registerClose,
                }),
              loadSettings: async () => ({}),
              resolveModel: async () => ({
                kind: "selected",
                selected: { model: { provider: "test", id: "test", reasoning: false } as Model<Api>, auth: {} },
              }),
              runFullscreen: async (ctx, run) => run(ctx),
              runThread: async () => {
                threadStarts++;
                return { kind: "closed" };
              },
            });
            if (transition === "cancelled-new") {
              pi.on("session_before_switch", () => {
                assert.equal(host.closeCount, 1);
                return { cancel: true };
              });
            }
            if (transition === "cancelled-tree") {
              pi.on("session_before_tree", () => {
                assert.equal(host.closeCount, 1);
                return { cancel: true };
              });
            }
            if (transition === "new") {
              pi.on("session_shutdown", () => assert.equal(host.closeCount, 1));
            }
            if (transition === "tree") {
              pi.on("session_tree", () => assert.equal(host.closeCount, 1));
            }
          },
        },
      ],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const model = { provider: "test", id: "test", reasoning: false } as Model<Api>;
    const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
      const result = await createAgentSession({
        ...options,
        model,
        resourceLoader: loader,
        settingsManager,
        noTools: "all",
      });
      return { ...result, services: { cwd, agentDir: cwd } as never, diagnostics: [] };
    };
    runtime = new AgentSessionRuntime(
      (await createRuntime({ cwd, agentDir: cwd, sessionManager: SessionManager.inMemory(cwd) })).session,
      { cwd, agentDir: cwd } as never,
      createRuntime,
    );
    const bind = async (session: AgentSession) => {
      const uiContext = {
        custom: host.custom,
        getEditorText: () => host.text,
        setEditorText: (text: string) => host.editor.setText(text),
        notify() {},
      };
      await session.bindExtensions({ mode: "tui", uiContext: uiContext as never });
    };
    await bind(runtime.session);
    runtime.setRebindSession(bind);
    const oldSession = runtime.session;
    const oldManager = oldSession.sessionManager;
    let targetId: string | undefined;
    if (transition.endsWith("tree")) {
      targetId = oldManager.appendMessage({ role: "user", content: "branch editor", timestamp: 1 });
      oldManager.appendMessage({ role: "user", content: "other branch", timestamp: 2 });
    }
    const command = oldSession.extensionRunner.getCommand("btw");
    assert.ok(command);
    // The registered command runs against Pi's own bound extension context.
    const commandRunning = command.handler("", oldSession.extensionRunner.createCommandContext());
    await host.waitForOpen();
    assert.ok(host.openComponent);
    assert.equal(host.closeCount, 0);
    if (transition.startsWith("cancelled")) host.editor.setText("updated draft while menu open");

    if (transition.endsWith("tree")) {
      assert.ok(targetId);
      const result = await oldSession.navigateTree(targetId);
      assert.equal(result.cancelled, transition === "cancelled-tree");
      if (!result.cancelled) {
        assert.equal(result.editorText, "branch editor");
        if (!host.text.trim()) host.editor.setText(result.editorText ?? "");
      }
    } else {
      const result = await runtime.newSession({ withSession: async () => host.editor.setText("new session editor") });
      assert.equal(result.cancelled, transition === "cancelled-new");
    }
    await commandRunning;
    assert.equal(host.closeCount, 1);
    assert.equal(threadStarts, 0);
    assert.equal(
      host.text,
      transition === "new"
        ? "new session editor"
        : transition === "tree"
          ? "branch editor"
          : "updated draft while menu open",
    );
    assert.equal(runtime.session.sessionManager === oldManager, transition !== "new");
  } finally {
    await runtime?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}

test.each(["new", "tree", "cancelled-new", "cancelled-tree"] as const)(
  "real Pi %s transition closes pending BTW menu before editor restoration",
  withRealPiMenu,
);

type WriterOrder = "writer-before-btw" | "btw-before-writer";

async function withRealPiFullscreen(transition: Transition, order: WriterOrder) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-btw-fullscreen-boundary-"));
  const host = createPiEditorHost(transition.endsWith("tree") ? "" : "outgoing draft");
  let runtime: AgentSessionRuntime | undefined;
  let releaseThread!: () => void;
  let threadStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    threadStarted = resolve;
  });
  try {
    const settingsManager = SettingsManager.inMemory({ defaultModel: "anthropic/claude-sonnet-4-5" });
    const committed = !transition.startsWith("cancelled");
    const destination = transition.endsWith("tree") ? "destination editor" : "new session editor";
    const observedAtBoundary: Array<{ text: string; closeCount: number }> = [];
    const writer = {
      name: "destination-writer",
      factory: (pi: ExtensionAPI) => {
        if (committed) {
          pi.on(transition === "new" ? "session_shutdown" : "session_tree", () => {
            host.editor.setText(destination);
          });
        }
      },
    };
    const btwFactory = {
      name: "btw-fullscreen-boundary",
      factory: (pi: ExtensionAPI) => {
        btw(pi, {
          loadSettings: async () => ({}),
          resolveModel: async () => ({
            kind: "selected",
            selected: { model: { provider: "test", id: "test", reasoning: false } as Model<Api>, auth: {} },
          }),
          runFullscreen: runBtwFullscreen,
          runThread: async () => {
            threadStarted();
            await new Promise<void>((resolve) => {
              releaseThread = resolve;
            });
            return { kind: "closed" };
          },
        });
        if (transition.startsWith("cancelled")) {
          pi.on(transition.endsWith("tree") ? "session_before_tree" : "session_before_switch", () => {
            assert.equal(host.closeCount, 0);
            assert.equal(host.text, "updated draft while fullscreen open");
            return { cancel: true };
          });
        }
      },
    };
    const observer = {
      name: "destination-observer",
      factory: (pi: ExtensionAPI) => {
        if (committed) {
          pi.on(transition === "new" ? "session_shutdown" : "session_tree", () => {
            observedAtBoundary.push({ text: host.text, closeCount: host.closeCount });
          });
        }
      },
    };
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      extensionFactories:
        order === "writer-before-btw" ? [writer, btwFactory, observer] : [btwFactory, writer, observer],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const model = { provider: "test", id: "test", reasoning: false } as Model<Api>;
    const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
      const result = await createAgentSession({
        ...options,
        model,
        resourceLoader: loader,
        settingsManager,
        noTools: "all",
      });
      return { ...result, services: { cwd, agentDir: cwd } as never, diagnostics: [] };
    };
    runtime = new AgentSessionRuntime(
      (await createRuntime({ cwd, agentDir: cwd, sessionManager: SessionManager.inMemory(cwd) })).session,
      { cwd, agentDir: cwd } as never,
      createRuntime,
    );
    const bind = async (session: AgentSession) => {
      const uiContext = {
        custom: host.custom,
        getEditorText: () => host.text,
        setEditorText: (text: string) => host.editor.setText(text),
        notify() {},
      };
      await session.bindExtensions({ mode: "tui", uiContext: uiContext as never });
    };
    await bind(runtime.session);
    runtime.setRebindSession(bind);
    const oldSession = runtime.session;
    const oldManager = oldSession.sessionManager;
    let targetId: string | undefined;
    if (transition.endsWith("tree")) {
      targetId = oldManager.appendMessage({ role: "user", content: "branch editor", timestamp: 1 });
      oldManager.appendMessage({ role: "user", content: "other branch", timestamp: 2 });
    }
    const command = oldSession.extensionRunner.getCommand("btw");
    assert.ok(command);
    // Exercise the real fullscreen wrapper and Pi's unconditional savedText restore.
    const commandRunning = command.handler("side question", oldSession.extensionRunner.createCommandContext());
    await host.waitForOpen();
    await started;
    assert.equal(host.closeCount, 0);
    if (transition.startsWith("cancelled")) host.editor.setText("updated draft while fullscreen open");

    if (transition.endsWith("tree")) {
      assert.ok(targetId);
      const result = await oldSession.navigateTree(targetId);
      assert.equal(result.cancelled, transition === "cancelled-tree");
      if (!result.cancelled) assert.equal(result.editorText, "branch editor");
    } else {
      const result = await runtime.newSession();
      assert.equal(result.cancelled, transition === "cancelled-new");
    }
    const expectedText = transition.startsWith("cancelled") ? "updated draft while fullscreen open" : destination;
    assert.deepEqual(observedAtBoundary, committed ? [{ text: destination, closeCount: 1 }] : []);
    assert.equal(host.text, expectedText);
    assert.equal(host.closeCount, transition.startsWith("cancelled") ? 0 : 1);
    releaseThread();
    await commandRunning;
    assert.equal(host.text, expectedText);
    assert.equal(host.closeCount, 1);
    assert.equal(runtime.session.sessionManager === oldManager, transition !== "new");
  } finally {
    releaseThread?.();
    await runtime?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}

test.each(
  (["new", "tree", "cancelled-new", "cancelled-tree"] as const).flatMap((transition) =>
    (["writer-before-btw", "btw-before-writer"] as const).map((order) => [transition, order] as const),
  ),
)("real Pi %s transition (%s) keeps the owning editor text during and after BTW closure", withRealPiFullscreen);
