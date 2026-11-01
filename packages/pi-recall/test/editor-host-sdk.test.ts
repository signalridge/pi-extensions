import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionCommandContext,
  InteractiveMode,
  initTheme,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createRecallExtension } from "../src/recall.js";

initTheme("dark", false);

// Test-only SDK host shell: retain actual showExtensionCustom savedText/restoreEditor.
function editorHost() {
  assert.ok(["1.0.4", "1.4.0"].includes(VERSION), `Unqualified Pi host version: ${VERSION}`);
  let text = "opening draft";
  let opened!: () => void;
  const mounted = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const editor = {
    getText: () => text,
    setText: (value: string) => {
      text = value;
    },
  };
  const host = Object.assign(Object.create(InteractiveMode.prototype) as object, {
    editor,
    editorContainer: {
      clear() {},
      addChild(component: Component) {
        if (component !== (editor as unknown as Component)) opened();
      },
    },
    ui: { setFocus() {}, requestRender() {}, terminal: { rows: 24, columns: 80 } },
    keybindings: { matches: () => false, getKeys: () => [] },
    // 1.0.4 mounts directly; 1.4.0 owns a dialog stack and terminal-status reporter.
    ...(VERSION === "1.4.0" ? { extensionDialogs: [], programStatus: { setBlocked() {} } } : {}),
  }) as { showExtensionCustom: ExtensionCommandContext["ui"]["custom"] };
  const custom: ExtensionCommandContext["ui"]["custom"] = (factory, options) =>
    host.showExtensionCustom(factory, options);
  return {
    editor,
    custom,
    mounted,
    get text() {
      return text;
    },
  };
}

test.each(["before", "after"] as const)(
  "Recall custom completion preserves a %s-Recall SDK destination writer",
  async (order) => {
    const cwd = await mkdtemp(join(tmpdir(), "recall-editor-sdk-"));
    const host = editorHost();
    let session: AgentSession | undefined;
    try {
      const settingsManager = SettingsManager.inMemory();
      const writer = {
        name: "destination-writer",
        factory: (pi: Parameters<ReturnType<typeof createRecallExtension>>[0]) => {
          pi.on("session_tree", () => {
            host.editor.setText("destination draft");
          });
        },
      };
      const recall = { name: "recall-editor", factory: createRecallExtension({ getAgentDir: () => cwd }) };
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: cwd,
        settingsManager,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: order === "before" ? [writer, recall] : [recall, writer],
      });
      await loader.reload();
      const manager = SessionManager.inMemory(cwd);
      const target = manager.appendMessage({ role: "user", content: "destination", timestamp: 1 });
      manager.appendCustomEntry("outgoing metadata");
      ({ session } = await createAgentSession({
        cwd,
        agentDir: cwd,
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
          setEditorText: (value: string) => host.editor.setText(value),
          notify() {},
        } as never,
      });
      const command = session.extensionRunner.getCommand("recall");
      assert.ok(command);
      const pending = command.handler("", session.extensionRunner.createCommandContext());
      await host.mounted;
      await session.navigateTree(target);
      await pending;
      assert.equal(host.text, "destination draft");
      // A later writer must not be replayed over by deferred wrapper cleanup.
      host.editor.setText("later destination draft");
      await Promise.resolve();
      assert.equal(host.text, "later destination draft");
    } finally {
      session?.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
