import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionUIContext,
  type KeybindingsManager as HostKeys,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Editor,
  KeybindingsManager,
  ScrollView,
  type Terminal,
  Text,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
} from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";

type View = Component & { dispose?(): void };
const identity = (text: string) => text;
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: identity,
  italic: identity,
  underline: identity,
  inverse: identity,
  strikethrough: identity,
  getFgAnsi: () => "",
  getBgAnsi: () => "",
  getColorMode: () => "truecolor",
} as unknown as Theme;

function terminalHost(fullscreen: boolean) {
  let input: (data: string) => void = () => {};
  const terminal = {
    columns: 120,
    rows: 40,
    kittyProtocolActive: false,
    start: (onInput: (data: string) => void) => {
      input = onInput;
    },
    stop() {},
    async drainInput() {},
    write() {},
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
    setProgramStatus() {},
  } satisfies Terminal;
  const tui = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
  const keys = new KeybindingsManager(TUI_KEYBINDINGS);
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
  const above = new Container();
  const below = new Container();
  const footer = new Container();
  const transcript = new ScrollView(new Text("Host transcript", 0, 0), { follow: "end", primary: true });
  const dock = new VStack([above, editor, below, footer].map((component) => ({ component, shrink: 1, minSize: 0 })));
  tui.addChild(transcript);
  tui.addChild(dock);
  if (tui instanceof TuiAltScreen) {
    tui.setLayoutRoot(
      new VStack([
        { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
      ]),
    );
  }
  tui.setFocus(editor);
  const statuses = new Map<string, string>();
  const widgets = new Map<string, { component: View; container: Container }>();
  const views: Array<{ component: View; close(): void }> = [];
  const transitions: string[] = [];
  let footerView: View | undefined;
  const custom: ExtensionUIContext["custom"] = (factory, options) =>
    new Promise((resolve, reject) => {
      const previous = tui.getFocusedComponent();
      let settled = false;
      let view: View | undefined;
      let interaction: { component: View; close(): void } | undefined;
      const finish = (value: Parameters<typeof resolve>[0]) => {
        if (settled) return;
        settled = true;
        view?.dispose?.();
        if (interaction) {
          transitions.push("close");
          const index = views.indexOf(interaction);
          if (index >= 0) views.splice(index, 1);
          tui.hideOverlay();
        }
        tui.setFocus(previous);
        tui.requestRender();
        resolve(value);
      };
      Promise.resolve(factory(tui, theme, keys as unknown as HostKeys, finish)).then((created) => {
        view = created;
        if (settled) {
          created.dispose?.();
          return;
        }
        interaction = { component: created, close: () => finish(undefined as Parameters<typeof resolve>[0]) };
        views.push(interaction);
        transitions.push("open");
        tui.showOverlay(
          created,
          typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions,
        );
        tui.requestRender();
      }, reject);
    });
  const ui = {
    theme,
    custom,
    notify: vi.fn(),
    getEditorText: () => editor.getText(),
    setEditorText: (text: string) => editor.setText(text),
    onTerminalInput: (listener: Parameters<typeof tui.addInputListener>[0]) => tui.addInputListener(listener),
    setStatus: (key: string, text: string | undefined) => {
      if (text === undefined) statuses.delete(key);
      else statuses.set(key, text);
      tui.requestRender();
    },
    setWidget: (
      key: string,
      content: string[] | Parameters<ExtensionUIContext["setWidget"]>[1],
      options?: { placement?: string },
    ) => {
      const previous = widgets.get(key);
      if (previous) {
        previous.container.removeChild(previous.component);
        previous.component.dispose?.();
        widgets.delete(key);
      }
      if (!content) return;
      const component = typeof content === "function" ? content(tui, theme) : new Text(content.join("\n"), 0, 0);
      const container = options?.placement === "belowEditor" ? below : above;
      container.addChild(component);
      widgets.set(key, { component, container });
      tui.requestRender();
    },
    setFooter: (factory: Parameters<ExtensionUIContext["setFooter"]>[0]) => {
      footerView?.dispose?.();
      footer.clear();
      footerView = factory?.(tui, theme, {
        getGitBranch: () => null,
        getAvailableProviderCount: () => 1,
        getExtensionStatuses: () => new Map(statuses),
        onBranchChange: () => () => {},
      });
      if (footerView) {
        footer.addChild(new Text("FOOTER", 0, 0));
        footer.addChild(footerView);
      }
    },
  } as unknown as ExtensionUIContext;
  tui.start();
  return {
    ui,
    statuses,
    transitions,
    editor,
    text: () => views.at(-1)?.component.render(120).map(stripVTControlCharacters).join("\n") ?? "",
    key: (key: string) => {
      input(key);
      tui.renderNow();
    },
    dock: () => dock.render(120).map((line) => stripVTControlCharacters(line).trimEnd()),
    close: () => views.at(-1)?.close(),
    dispose: () => {
      for (const view of [...views].reverse()) view.close();
      footerView?.dispose?.();
      tui.stop();
    },
  };
}

for (const fullscreen of [false, true]) {
  for (const reverse of [false, true]) {
    test(`loaded status owners preserve navigation, drafts and compact Fleet (${fullscreen ? "fullscreen" : "regular"}, ${reverse ? "providers-first" : "status-first"})`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "status-navigation-"));
      const agentDir = join(cwd, "agent");
      mkdirSync(agentDir);
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(join(agentDir, "pi-statusline.json"), JSON.stringify({ segments: ["model"] }));
      writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, fleetView: true }));
      const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const host = terminalHost(fullscreen);
      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
      const errors: unknown[] = [];
      try {
        const paths = [
          "pi-statusline/src/index.ts",
          "pi-background/src/extension.ts",
          "pi-subagents/src/index.ts",
          "pi-workflows/src/index.ts",
        ].map((path) => fileURLToPath(new URL(`../packages/${path}`, import.meta.url)));
        if (reverse) paths.reverse();
        const loader = new DefaultResourceLoader({
          cwd,
          agentDir,
          noExtensions: true,
          noSkills: true,
          noContextFiles: true,
          noThemes: true,
          noPromptTemplates: true,
          additionalExtensionPaths: paths,
        });
        await loader.reload();
        expect(loader.getExtensions().errors).toEqual([]);
        const faux = fauxProvider({ provider: "status-navigation-faux", models: [{ id: "acceptance" }] });
        const runtime = await ModelRuntime.create({
          authPath: join(agentDir, "auth.json"),
          modelsPath: null,
          allowModelNetwork: false,
        });
        runtime.registerNativeProvider(faux.provider);
        await runtime.refresh({ allowNetwork: false });
        const registry = new ModelRegistry(runtime);
        ({ session } = await createAgentSession({
          cwd,
          agentDir,
          resourceLoader: loader,
          modelRuntime: runtime,
          model: registry.find("status-navigation-faux", "acceptance"),
          sessionManager: SessionManager.inMemory(cwd),
          tools: [],
          settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
        }));
        await session.bindExtensions({ mode: "tui", uiContext: host.ui, onError: (error) => errors.push(error) });
        const runner = session.extensionRunner;
        const shell = runner.getToolDefinition("bash_background");
        const workflow = runner.getToolDefinition("workflow");
        expect(shell).toBeDefined();
        expect(workflow).toBeDefined();
        if (!shell || !workflow) throw new Error("Required UI owner tools were not loaded");
        await shell.execute(
          "shell",
          { command: "printf 'status-log\\n'; sleep 60", description: "shell navigation", notify: "off" },
          undefined,
          undefined,
          runner.createToolContext("shell", undefined),
        );
        const result = await workflow.execute(
          "workflow",
          {
            script:
              'export const meta = { name: "workflow navigation", description: "UI acceptance without model dispatch" }; return 42;',
            background: false,
          },
          undefined,
          undefined,
          runner.createToolContext("workflow", undefined),
        );
        expect(result.isError).not.toBe(true);
        await vi.waitFor(() => expect(host.statuses.has("pi-workflows")).toBe(true));
        expect(host.statuses.has("pi-background")).toBe(true);
        const settingsBefore = join(agentDir, "pi-statusline.json");
        const originalSettings = JSON.stringify({ segments: ["model"] });
        host.editor.setText("draft 中文 é 👩‍💻");
        const inspect = session.prompt(reverse ? "/statusline inspect" : "/statusline");
        if (!reverse) {
          await vi.waitFor(() => expect(host.text()).toContain("Inspect extension statuses"));
          for (let index = 0; index < 5; index++) host.key("\x1b[B");
          host.key("\r");
        }
        await vi.waitFor(() => expect(host.text()).toContain("Enter details"));
        const backgroundIndex = [...host.statuses.keys()].indexOf("pi-background");
        for (let index = 0; index < backgroundIndex; index++) host.key("\x1b[B");
        host.key("\r");
        await vi.waitFor(() => expect(host.text().startsWith("Background tasks")).toBe(true));
        expect(host.transitions.slice(-3)).toEqual(["open", "close", "open"]);
        expect(host.text()).toContain("shell navigation");
        expect(host.editor.getText()).toBe("draft 中文 é 👩‍💻");
        host.close();
        await inspect;
        expect(host.statuses.has("pi-background")).toBe(true);
        const next = session.prompt("/statusline inspect");
        await vi.waitFor(() => expect(host.text()).toContain("Enter details"));
        const workflowIndex = [...host.statuses.keys()].indexOf("pi-workflows");
        for (let index = 0; index < workflowIndex; index++) host.key("\x1b[B");
        host.key("\r");
        await vi.waitFor(() => expect(host.text().startsWith("╭")).toBe(true));
        expect(host.text()).toContain("Workflows");
        expect(host.text()).toContain("workflow navigation");
        host.close();
        await next;
        const lines = host.dock();
        const group = lines.findIndex((line) => line.includes("▸ workflow navigation"));
        const footer = lines.indexOf("FOOTER");
        expect(group).toBeGreaterThanOrEqual(0);
        expect(footer, JSON.stringify(lines)).toBeGreaterThan(group);
        expect(lines.slice(group + 1, footer)).toEqual([""]);
        expect(existsSync(settingsBefore)).toBe(true);
        expect(readFileSync(settingsBefore, "utf8")).toBe(originalSettings);
        expect(session.messages).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await session?.abort();
        if (session) {
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          session.dispose();
        }
        host.dispose();
        if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
        rmSync(cwd, { recursive: true, force: true });
      }
    }, 30_000);
  }
}
