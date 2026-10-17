import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  AgentSessionRuntime,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
  InteractiveMode,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { type Terminal, type TUI, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { TodoCommand } from "../src/command.js";
import { TodoStore } from "../src/store.js";

/** Real InteractiveMode.init(): no replacement ui.custom/input/select or SDK patches. */
export async function nativeTerminal(fullscreen = true) {
  if (VERSION !== "1.0.4") throw new Error(`Native lifetime proof requires SDK 1.0.4, got ${VERSION}`);
  const cwd = mkdtempSync(join(tmpdir(), "todo-native-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir);
  let input = (_data: string) => {};
  let resized = () => {};
  let writes = "";
  const terminal = {
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    start: (onInput, onResize) => {
      input = onInput;
      resized = onResize;
    },
    stop: () => {},
    drainInput: async () => {},
    write: (data) => {
      writes += data;
    },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
  } satisfies Terminal;
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const faux = fauxProvider({ provider: "todo-native", models: [{ id: "fixture" }] });
  runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({ allowNetwork: false });
  const model = new ModelRegistry(runtime).find("todo-native", "fixture");
  if (!model) throw new Error("Missing local fixture model");
  let api!: ExtensionAPI;
  let ctx!: ExtensionCommandContext;
  let store!: TodoStore;
  let command!: TodoCommand;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noContextFiles: true,
    noThemes: true,
    noPromptTemplates: true,
    extensionFactories: [
      {
        name: "native-todo-proof",
        factory: (pi) => {
          api = pi;
          store = new TodoStore(pi);
          command = new TodoCommand(store, () => {});
          pi.on("session_start", (_event, context) => {
            store.reconcile(context);
          });
          pi.on("session_shutdown", () => {
            command.retire();
          });
          pi.registerCommand("capture-todo-context", {
            description: "Test capture",
            handler: async (_args, context) => {
              ctx = context;
            },
          });
        },
      },
    ],
  });
  await loader.reload();
  const settingsManager = SettingsManager.inMemory({
    quietStartup: true,
    theme: "dark",
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    tools: [],
  });
  const host = new AgentSessionRuntime(
    session,
    { cwd, agentDir, modelRuntime: runtime, settingsManager, resourceLoader: loader, diagnostics: [] },
    async () => {
      throw new Error("Replacement not used by native UI fixture");
    },
  );
  const interactive = new InteractiveMode(host, { terminal, tuiMode: fullscreen ? "fullscreen" : "regular" });
  await interactive.init();
  await session.prompt("/capture-todo-context");
  let tui!: TUI;
  const captured = ctx.ui.custom<void>(
    (native, _theme, _keys, done) => {
      tui = native;
      return { render: () => ["Capture native renderer"], invalidate() {}, handleInput: () => done() };
    },
    { overlay: true },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  input("\r");
  await captured;
  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    interactive.stop(); // Public host teardown; also releases process/terminal listeners.
    await host.dispose(); // Emits real session_shutdown even after the terminal stopped.
  };
  return {
    api,
    ctx,
    store,
    command,
    session,
    host,
    tui,
    terminal,
    shutdown,
    key(data: string) {
      input(data);
      tui.renderNow();
    },
    resize(columns: number, rows: number) {
      terminal.columns = columns;
      terminal.rows = rows;
      resized();
      tui.renderNow();
    },
    lines() {
      tui.renderNow();
      if (tui instanceof TuiAltScreen) return tui.getScreenLines();
      if (tui instanceof TuiMainScreen) {
        const state = tui.captureRenderState();
        return state.previousLines.slice(state.previousViewportTop, state.previousViewportTop + terminal.rows);
      }
      throw new Error("Unknown native renderer");
    },
    writes: () => writes,
    record(label: string, lines: string[]) {
      const path = process.env.PI_TODO_NATIVE_UI_EVIDENCE;
      if (path)
        appendFileSync(
          path,
          `${JSON.stringify({ label, sdk: VERSION, mode: tui.mode, columns: terminal.columns, rows: terminal.rows, editorDraft: ctx.ui.getEditorText(), lines })}\n`,
        );
    },
    focus: () => (tui instanceof TuiAltScreen || tui instanceof TuiMainScreen ? tui.getFocusedComponent() : null),
    async dispose() {
      try {
        await shutdown();
      } finally {
        command.retire();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}
