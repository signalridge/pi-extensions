import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionCommandContext,
  ExtensionEditorComponent,
  InteractiveMode,
  initTheme,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Editor, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";

initTheme("dark", false);

function createHost() {
  assert.ok(["1.0.4", "1.5.0"].includes(VERSION), `Unqualified Pi host version: ${VERSION}`);
  const editor = {
    text: "outgoing draft",
    focused: true,
    getText() {
      return this.text;
    },
    setText(value: string) {
      this.text = value;
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
      if ("focused" in component) component.focused = true;
      if (component === editor) restores++;
    },
  };
  const host = Object.assign(Object.create(InteractiveMode.prototype) as object, {
    editor,
    editorContainer,
    ui,
    keybindings: new KeybindingsManager(
      { ...TUI_KEYBINDINGS, "app.editor.external": { defaultKeys: "ctrl+g", description: "External editor" } },
      { "app.editor.external": "ctrl+x" },
    ),
    // 1.0.4 mounts directly; 1.5.0 owns a dialog stack and terminal-status reporter.
    ...(VERSION === "1.5.0" ? { extensionDialogs: [], programStatus: { setBlocked: vi.fn() } } : {}),
  }) as { showExtensionCustom: ExtensionCommandContext["ui"]["custom"] };
  return {
    custom: ((factory, options) =>
      host.showExtensionCustom(factory, options)) as ExtensionCommandContext["ui"]["custom"],
    editor,
    editorContainer,
    ui,
    get focus() {
      return focus;
    },
    get restores() {
      return restores;
    },
  };
}

test.each(["new", "reload", "resume", "fork", "quit", "new-then-quit", "reload-then-quit"] as const)(
  "installed Pi %s while an external settings editor is pending respects terminal, not command, lifetime",
  async (transition) => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-statusline-replacement-editor-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousVisual = process.env.VISUAL;
    process.env.PI_CODING_AGENT_DIR = cwd;
    process.env.VISUAL = "this-fallback-must-not-run";
    const script = join(cwd, "editor.mjs");
    const releasePath = join(cwd, "release");
    // Pi appends the temporary file after the configured command arguments.
    writeFileSync(
      script,
      'import { existsSync, writeFileSync } from "node:fs"; while (!existsSync(process.argv[2])) await new Promise(r => setTimeout(r, 10)); writeFileSync(process.argv[3], "obsolete edited value\\n");',
    );
    const settingsPath = join(cwd, "pi-statusline.json");
    const settingsDocument = '{"palettePreset":"classic","segments":["model"]}\n';
    writeFileSync(settingsPath, settingsDocument);
    const host = createHost();
    let runtime: AgentSessionRuntime | undefined;
    let footer: { dispose?(): void } | undefined;
    let factoryStarts = 0;
    let externalCompleted: Promise<void> | undefined;
    try {
      const settingsManager = SettingsManager.inMemory({
        externalEditor: `${process.execPath} ${script} ${releasePath}`,
      });
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: cwd,
        settingsManager,
        // Load the source through installed Pi, including its fresh jiti module
        // evaluation on reload, rather than retaining a test-imported factory.
        additionalExtensionPaths: [join(import.meta.dirname, "../src/statusline.ts")],
        extensionFactories: [
          {
            name: "replacement-runtime-observer",
            factory: () => {
              factoryStarts++;
            },
          },
        ],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
        // The interactive runtime rebuilds resources for each replacement; do
        // not accidentally reuse the outgoing loader's extension runtime.
        await loader.reload();
        const result = await createAgentSession({
          ...options,
          model: { provider: "test", id: "test", reasoning: false } as Model<Api>,
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
        assert.ok(runtime);
        const runtimeHost = runtime;
        await session.bindExtensions({
          mode: "tui",
          uiContext: {
            custom: host.custom,
            setFooter(factory) {
              footer?.dispose?.();
              footer = factory?.(host.ui as never, {} as never, { onBranchChange: () => () => {} } as never);
            },
            setStatus() {},
            notify() {},
            getEditorText: () => host.editor.getText(),
            setEditorText: (text) => host.editor.setText(text),
          } as never,
          commandContextActions: {
            waitForIdle: () => session.waitForIdle(),
            newSession: (options) => runtimeHost.newSession(options),
            switchSession: (path, options) => runtimeHost.switchSession(path, options),
            fork: (entryId, options) => runtimeHost.fork(entryId, options),
            navigateTree: (entryId, options) => session.navigateTree(entryId, options),
            reload: () => session.reload(),
          },
        });
      };
      await bind(runtime.session);
      runtime.setRebindSession(bind);
      const oldSession = runtime.session;
      const oldContext = oldSession.extensionRunner.createCommandContext();
      const command = oldSession.extensionRunner.getCommand("statusline");
      assert.ok(command);
      const pending = command.handler("settings", oldContext);
      await Promise.resolve();
      const component = host.editorContainer.children[0];
      assert.ok(component instanceof ExtensionEditorComponent);
      const input = component.children.find((child) => child instanceof Editor);
      assert.ok(input instanceof Editor);
      const setText = input.setText.bind(input);
      externalCompleted = new Promise<void>((resolve) => {
        vi.spyOn(input, "setText").mockImplementation((text) => {
          setText(text);
          resolve();
        });
      });
      component.handleInput("\u0018"); // Native remapped external editor key.
      assert.equal(host.ui.stop.mock.calls.length, 1);
      const initialFactories = factoryStarts;
      if (transition.startsWith("new")) {
        await oldContext.newSession({ withSession: async () => host.editor.setText("replacement draft") });
      } else if (transition.startsWith("reload")) {
        await oldContext.reload();
        host.editor.setText("replacement draft");
      } else if (transition === "fork") {
        const entry = oldSession.sessionManager.appendMessage({ role: "user", content: "fork", timestamp: 1 });
        await oldContext.fork(entry, { withSession: async () => host.editor.setText("replacement draft") });
      } else if (transition === "resume") {
        const path = join(cwd, "target.jsonl");
        writeFileSync(
          path,
          `${JSON.stringify({ type: "session", version: 3, id: "target", timestamp: new Date().toISOString(), cwd })}\n`,
        );
        await oldContext.switchSession(path, { withSession: async () => host.editor.setText("replacement draft") });
      }
      if (transition !== "quit") {
        assert.ok(factoryStarts > initialFactories, "replacement must create fresh extension instances");
        assert.throws(() => oldContext.ui, /stale/u);
      }
      if (transition === "quit" || transition.endsWith("then-quit")) {
        await runtime.dispose();
        host.editor.setText("quit draft");
      }
      await pending;
      assert.deepEqual(host.editorContainer.children, [host.editor]);
      assert.equal(host.focus, host.editor);
      assert.equal(host.restores, 1);
      const expectedDraft =
        transition === "quit" || transition.endsWith("then-quit") ? "quit draft" : "replacement draft";
      const renders = host.ui.requestRender.mock.calls.length;
      writeFileSync(releasePath, "exit");
      await externalCompleted;
      assert.equal(host.ui.start.mock.calls.length, expectedDraft === "quit draft" ? 0 : 1);
      if (expectedDraft === "quit draft") assert.equal(host.ui.requestRender.mock.calls.length, renders);
      assert.equal(host.editor.getText(), expectedDraft);
      assert.equal(host.focus, host.editor);
      assert.equal(host.restores, 1);
      assert.equal(readFileSync(settingsPath, "utf8"), settingsDocument);
      // Even a captured callback cannot close or restore over a later dialog.
      input.onSubmit?.("obsolete edited value");
      assert.equal(host.editor.getText(), expectedDraft);
      assert.equal(host.restores, 1);
    } finally {
      writeFileSync(releasePath, "exit");
      await externalCompleted;
      await runtime?.dispose();
      footer?.dispose?.();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousVisual === undefined) delete process.env.VISUAL;
      else process.env.VISUAL = previousVisual;
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  10_000,
);
