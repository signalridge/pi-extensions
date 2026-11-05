import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  CustomEditor,
  DefaultResourceLoader,
  type ExtensionContext,
  ExtensionRunner,
  InteractiveMode,
  initTheme,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type Component, type EditorComponent, TuiMainScreen } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";

type Factory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

initTheme("dark", false);

for (const order of [
  ["pi-input-history", "pi-input-prefix"],
  ["pi-input-prefix", "pi-input-history"],
]) {
  for (const draft of [" normal\n draft ", `  ${"completed 😃😀 paste\n".repeat(150)}  `]) {
    test(`SDK ${order.join(" → ")} preserves an existing ${draft.length > 100 ? "completed large paste" : "normal draft"}`, async () => {
      const directory = mkdtempSync(`${tmpdir()}/history-startup-`);
      try {
        // Use the public extension loader, not cross-package implementation imports.
        const loader = new DefaultResourceLoader({
          cwd: directory,
          agentDir: `${directory}/agent`,
          settingsManager: SettingsManager.inMemory(),
          additionalExtensionPaths: order.map((name) =>
            fileURLToPath(new URL(`../../${name}/src/index.ts`, import.meta.url)),
          ),
          noExtensions: true,
          noSkills: true,
          noThemes: true,
          noPromptTemplates: true,
          noContextFiles: true,
        });
        await loader.reload();
        const loaded = loader.getExtensions();
        assert.deepEqual(loaded.errors, []);
        const session = SessionManager.create(directory, `${directory}/sessions`);
        const recalled = "  😀 e\u0301 👩‍💻\n recalled payload  ";
        session.appendMessage({ role: "user", content: recalled, timestamp: Date.now() });
        const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, directory, session, {} as never);
        const terminal = { rows: 40, columns: 100, hideCursor() {} };
        const tui = new TuiMainScreen(terminal as never);
        vi.spyOn(tui, "requestRender").mockImplementation(() => {});
        const identity = (text: string) => text;
        const theme = {
          borderColor: identity,
          selectList: {
            selectedText: identity,
            selectedPrefix: identity,
            description: identity,
            scrollInfo: identity,
            noMatch: identity,
          },
        };
        const kb = { matches: () => false } as never;
        let active: EditorComponent = new CustomEditor(tui, theme, kb);
        active.handleInput(`\x1b[200~${draft}\x1b[201~`);
        if (draft.length > 100) assert.notEqual(active.getText(), draft);
        tui.setFocus(active);
        let factory: Factory | undefined;
        let mounts = 0;
        let popup: Component | undefined;
        // Run the real SDK custom-overlay closure and real TUI focus handling.
        // No provider is bound or called by this rendering-only fixture.
        const host = Object.create(InteractiveMode.prototype, {
          editor: { get: () => active },
          ui: { value: tui },
          keybindings: { value: kb },
        }) as { showExtensionCustom: ExtensionContext["ui"]["custom"] };
        const custom: ExtensionContext["ui"]["custom"] = (make, options) => {
          assert.equal(options?.overlay, true);
          assert.equal(options.blocked, undefined, "history is not an inline blocking question");
          return host.showExtensionCustom(async (...args) => {
            const component = await make(...args);
            popup = component;
            return component;
          }, options);
        };
        runner.setUIContext(
          {
            getEditorComponent: () => factory,
            custom,
            setEditorText: (text: string) => active.setText(text),
            getEditorText: () => active.getText(),
            setEditorComponent(next: Factory) {
              const text = active.getText();
              factory = next;
              active = next(tui, theme, kb);
              // Mirror the SDK host's synchronous text copy after factory creation.
              active.setText(text);
              tui.setFocus(active);
              mounts++;
            },
          } as never,
          "tui",
        );
        await runner.emit({ type: "session_start" });
        assert.equal(mounts, 2);
        assert.equal(active.getExpandedText?.(), draft);
        assert.equal(tui.getFocusedComponent(), active);
        active.handleInput("queued streaming input");
        await Promise.resolve();
        assert.equal(active.getExpandedText?.(), `${draft}queued streaming input`);
        assert.equal(mounts, 2);
        const unchanged = active.getExpandedText?.();
        const shortcut = runner.getShortcuts({}).get("ctrl+r");
        assert.ok(shortcut, "Ctrl+R remains the default shortcut");
        const open = async (rows: number) => {
          terminal.rows = rows;
          popup = undefined;
          const pending = shortcut.handler(runner.createContext());
          await vi.waitFor(() => {
            assert.ok(popup);
            assert.equal(tui.getFocusedComponent(), popup);
          });
          assert.ok(popup);
          return { pending, component: popup };
        };
        for (const rows of [0, 1, 2, 3, 4]) {
          const { pending, component } = await open(rows);
          assert.deepEqual(component.render(90), []);
          component.handleInput?.("\r");
          await pending;
          assert.equal(active.getExpandedText?.(), unchanged);
          assert.equal(tui.getFocusedComponent(), active);
        }
        const shrinking = await open(40);
        assert.ok(shrinking.component.render(90).length > 0);
        terminal.rows = 3;
        shrinking.component.handleInput?.("\r"); // Shrink before the host's next frame.
        await shrinking.pending;
        assert.equal(active.getExpandedText?.(), unchanged);
        for (const rows of [5, 6, 7]) {
          const { pending, component } = await open(rows);
          const lines = component.render(90);
          assert.ok(lines.length <= Math.floor(rows * 0.85));
          assert.ok(
            lines.some((line) => line.includes("> ")),
            "query prompt is visible",
          );
          component.handleInput?.("\r");
          await pending;
          assert.equal(active.getExpandedText?.(), recalled);
          assert.equal(tui.getFocusedComponent(), active);
        }
        assert.equal(mounts, 2, "search never replaces either composed editor factory");
        await runner.emit({ type: "session_shutdown" });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
