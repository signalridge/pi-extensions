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
  initTheme,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { test } from "vitest";
import btw, { resolveBtwModel, runBtwThread } from "../src/btw.js";
import { runBtwFullscreen } from "../src/fullscreen-ui.js";
import { showBtwCommandMenu } from "../src/menu.js";

initTheme("dark", false);

// Call Pi's actual showExtensionCustom implementation on a minimal TUI shell.
// In particular, its savedText/restoreEditor logic must not be simulated away.
function createPiEditorHost(initialText: string, laterCompletionText?: string) {
  assert.ok(["1.0.4", "1.4.0"].includes(VERSION), `Unqualified Pi host version: ${VERSION}`);
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
    // 1.0.4 mounts directly; 1.4.0 owns a dialog stack and terminal-status reporter.
    ...(VERSION === "1.4.0" ? { extensionDialogs: [], programStatus: { setBlocked() {} } } : {}),
  }) as unknown as { showExtensionCustom: ExtensionCommandContext["ui"]["custom"] };
  const custom: ExtensionCommandContext["ui"]["custom"] = (factory, options) =>
    host.showExtensionCustom(
      (tui, theme, keys, done) =>
        factory(tui, theme, keys, (result) => {
          done(result);
          // A later writer runs after native savedText restoration but before
          // the shared adapter's synchronous repair.
          if (laterCompletionText !== undefined) editor.setText(laterCompletionText);
        }),
      options,
    );
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

async function withRealPiMenu(transition: Transition, deferredCredentials = false) {
  let releaseCredentials!: () => void;
  const credentials = new Promise<{ ok: true; apiKey: string }>((resolve) => {
    releaseCredentials = () => resolve({ ok: true, apiKey: "test" });
  });
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
              ...(deferredCredentials
                ? {}
                : {
                    resolveModel: async () => ({
                      kind: "selected" as const,
                      selected: { model: { provider: "test", id: "test", reasoning: false } as Model<Api>, auth: {} },
                    }),
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
    const commandContext = oldSession.extensionRunner.createCommandContext();
    if (deferredCredentials) commandContext.modelRegistry.getApiKeyAndHeaders = () => credentials;
    const commandRunning = command.handler(deferredCredentials ? "side question" : "", commandContext);
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
    // The actual default credential loader must settle on navigation, before
    // credentials arrive; late done() would restore the old editor over this draft.
    await commandRunning;
    releaseCredentials();
    await credentials;
    await Promise.resolve();
    await Promise.resolve();
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
  (transition) => withRealPiMenu(transition),
);

test.each(["new", "tree"] as const)(
  "real Pi %s closes the default credential loader before late authentication",
  (transition) => withRealPiMenu(transition, true),
  10_000,
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

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test.each(
  (["settings", "auth", "side-answer"] as const).flatMap((stage) =>
    (["sibling", "append", "cancelled"] as const).map((navigation) => [stage, navigation] as const),
  ),
)("real SDK %s validates %s independently of delayed tree delivery", async (stage, navigation) => {
  const cwd = await mkdtemp(join(tmpdir(), "btw-live-origin-"));
  const entered = gate();
  const releaseWork = gate();
  const treeEntered = gate();
  const releaseTree = gate();
  let session: AgentSession | undefined;
  let calls = 0;
  let reads = 0;
  let ownTree = false;
  const model = { provider: "test", id: "side", reasoning: false } as Model<Api>;
  try {
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        {
          name: "two-gate-btw",
          factory: (pi) => {
            if (navigation === "cancelled") pi.on("session_before_tree", () => ({ cancel: true }));
            pi.on("session_tree", async () => {
              treeEntered.resolve();
              await releaseTree.promise;
            });
            btw(pi, {
              loadSettings: async () => {
                if (stage === "settings") {
                  entered.resolve();
                  await releaseWork.promise;
                }
                return {};
              },
              resolveModel: async (_settings, ctx, isCurrent) => {
                const selected = await resolveBtwModel({
                  settings: {},
                  currentModel: model,
                  modelRegistry: ctx.modelRegistry,
                  isCurrent,
                });
                return selected ? { kind: "selected", selected } : { kind: "cancelled" };
              },
              runFullscreen: async (ctx, run) => run(ctx),
              runThread: (options) =>
                runBtwThread({
                  ...options,
                  dependencies: {
                    interact: async () => ({ kind: "close" }),
                    ask: async (_thread, _question, _selected, _thinking, _ctx, steering) => {
                      assert.notEqual(steering.prepareContext(), false);
                      calls++;
                      if (calls === 1) steering.submit("--with-parent=test/side queued question");
                      entered.resolve();
                      await releaseWork.promise;
                      return { kind: "error", message: "side answer" };
                    },
                  },
                }),
            });
            pi.on("session_tree", () => {
              ownTree = true;
            });
          },
        },
      ],
    });
    await loader.reload();
    const manager = SessionManager.inMemory(cwd);
    const root = manager.appendMessage({ role: "user", content: "parent secret", timestamp: 1 });
    const origin = manager.appendCustomEntry("origin metadata");
    const originMessages = manager.buildSessionProjection().messages;
    manager.branch(root);
    const destination = manager.appendCustomEntry("destination metadata");
    assert.deepEqual(manager.buildSessionProjection().messages, originMessages);
    manager.branch(origin);
    ({ session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      model,
      settingsManager,
      resourceLoader: loader,
      sessionManager: manager,
      noTools: "all",
    }));
    let editor = "owning editor";
    await session.bindExtensions({
      mode: "tui",
      uiContext: {
        getEditorText: () => editor,
        setEditorText: (value: string) => {
          editor = value;
        },
        notify() {},
      } as never,
    });
    const ctx = session.extensionRunner.createCommandContext();
    ctx.modelRegistry.getApiKeyAndHeaders = async () => {
      if (stage === "auth") {
        entered.resolve();
        await releaseWork.promise;
      }
      return { ok: true, apiKey: "test" };
    };
    const projection = manager.buildSessionProjection.bind(manager);
    manager.buildSessionProjection = () => {
      reads++;
      return projection();
    };
    const command = session.extensionRunner.getCommand("btw");
    assert.ok(command);
    const openingLeaf = manager.getLeafId();
    const running = command.handler("side question", ctx);
    await entered.promise;
    let tree: ReturnType<AgentSession["navigateTree"]> | undefined;
    if (navigation === "sibling") {
      tree = session.navigateTree(destination);
      await treeEntered.promise;
      assert.equal(manager.getLeafId(), destination);
    } else if (navigation === "cancelled") {
      assert.equal((await session.navigateTree(destination)).cancelled, true);
      assert.equal(manager.getLeafId(), openingLeaf);
    } else {
      manager.appendCustomEntry("ordinary appended metadata");
    }
    assert.equal(ownTree, false);
    editor = "destination editor";
    const priorReads = reads;
    releaseWork.resolve();
    await running;
    assert.equal(ownTree, false, "work settled before BTW's tree handler");
    if (navigation === "sibling") {
      assert.equal(reads, priorReads, "no stale parent projection read");
      assert.equal(calls, stage === "side-answer" ? 1 : 0, "no stale or queued provider request");
    } else {
      assert.ok(reads > priorReads, "the explicitly opted-in queued request may read an unchanged prefix");
      assert.equal(calls, 2, "normal appends and canceled navigation preserve queued side questions");
    }
    assert.equal(editor, "destination editor");
    releaseTree.resolve();
    await tree;
  } finally {
    releaseWork.resolve();
    releaseTree.resolve();
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test.each(["repair", "later-writer", "invalid-sdk-scope"] as const)(
  "real Pi fullscreen completion before delayed tree delivery respects %s",
  async (completion) => {
    const cwd = await mkdtemp(join(tmpdir(), "btw-fullscreen-live-origin-"));
    const laterCompletionText = completion === "later-writer" ? "later destination draft" : undefined;
    const expectedText =
      completion === "invalid-sdk-scope" ? "opening draft" : (laterCompletionText ?? "destination draft");
    const host = createPiEditorHost("opening draft", laterCompletionText);
    const providerEntered = gate();
    const releaseProvider = gate();
    const treeEntered = gate();
    const releaseTree = gate();
    let session: AgentSession | undefined;
    let ownTree = false;
    let providerCalls = 0;
    let bringChoices = 0;
    let bringDeliveries = 0;
    const editorWrites: string[] = [];
    const model = { provider: "test", id: "side", reasoning: false } as Model<Api>;
    try {
      const settingsManager = SettingsManager.inMemory();
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: cwd,
        settingsManager,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          {
            name: "fullscreen-two-gate-btw",
            factory: (pi) => {
              pi.on("session_tree", async () => {
                host.editor.setText("destination draft");
                treeEntered.resolve();
                await releaseTree.promise;
              });
              btw(pi, {
                loadSettings: async () => ({}),
                resolveModel: async () => ({ kind: "selected", selected: { model, auth: {} } }),
                runFullscreen: runBtwFullscreen,
                runThread: (options) =>
                  runBtwThread({
                    ...options,
                    dependencies: {
                      ask: async (_thread, _question, _selected, _thinking, _ctx, steering) => {
                        assert.notEqual(steering.prepareContext(), false);
                        providerCalls++;
                        steering.submit("--with-parent=test/side queued question");
                        providerEntered.resolve();
                        await releaseProvider.promise;
                        return { kind: "error", message: "late provider response" };
                      },
                      interact: async () => ({ kind: "bringToMain", questionDraft: "stale draft" }),
                      chooseBringToMain: async () => {
                        bringChoices++;
                        return { kind: "closed" };
                      },
                      loadBringToMainDraft: async () => {
                        bringDeliveries++;
                        return "loaded";
                      },
                    },
                  }),
              });
              pi.on("session_tree", () => {
                ownTree = true;
              });
            },
          },
        ],
      });
      await loader.reload();
      const manager = SessionManager.inMemory(cwd);
      const root = manager.appendMessage({ role: "user", content: "same transcript", timestamp: 1 });
      const origin = manager.appendCustomEntry("origin metadata");
      const originMessages = manager.buildSessionProjection().messages;
      manager.branch(root);
      const destination = manager.appendCustomEntry("destination metadata");
      assert.deepEqual(manager.buildSessionProjection().messages, originMessages);
      manager.branch(origin);
      ({ session } = await createAgentSession({
        cwd,
        agentDir: cwd,
        model,
        settingsManager,
        resourceLoader: loader,
        sessionManager: manager,
        noTools: "all",
      }));
      await session.bindExtensions({
        mode: "tui",
        uiContext: {
          custom: host.custom,
          getEditorText: () => host.text,
          setEditorText: (text: string) => {
            editorWrites.push(text);
            host.editor.setText(text);
          },
          notify() {},
        } as never,
      });
      const command = session.extensionRunner.getCommand("btw");
      assert.ok(command);
      const running = command.handler("side question", session.extensionRunner.createCommandContext());
      await host.waitForOpen();
      await providerEntered.promise;
      assert.equal(host.closeCount, 0);
      const tree = session.navigateTree(destination);
      await treeEntered.promise;
      assert.equal(manager.getLeafId(), destination);
      assert.equal(host.text, "destination draft");
      assert.equal(ownTree, false);
      if (completion === "invalid-sdk-scope") session.extensionRunner.invalidate("test retired SDK context");
      releaseProvider.resolve();
      await running;
      assert.equal(ownTree, false, "fullscreen finishes before BTW's committed tree handler");
      assert.equal(host.closeCount, 1, "native custom done restored the opening text");
      assert.equal(host.text, expectedText);
      assert.deepEqual(editorWrites, completion === "repair" ? ["destination draft"] : []);
      assert.equal(providerCalls, 1, "retired queued request never dispatches");
      assert.equal(bringChoices, 0, "retired thread never chooses bring-to-main");
      assert.equal(bringDeliveries, 0, "retired thread never delivers bring-to-main");
      releaseTree.resolve();
      await tree;
      assert.equal(ownTree, true);
      assert.equal(host.text, expectedText);
      assert.equal(host.closeCount, 1);
    } finally {
      releaseProvider.resolve();
      releaseTree.resolve();
      session?.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
