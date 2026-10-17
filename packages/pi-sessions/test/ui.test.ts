import {
  type ExtensionCommandContext,
  InteractiveMode,
  initTheme,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  KeybindingsManager,
  type Terminal,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { HANDOFF_TYPE, readHandoff } from "../src/handoff.js";
import { Owner } from "../src/ownership.js";
import { messageText, plain, recentText, SHARE_BYTES, SUMMARY_BYTES, validSummary } from "../src/text.js";
import { HumanUI, Picker, rowsFrom, type SessionRow, safeLines } from "../src/ui.js";
import { deferred, fixture, model, response } from "./support.js";

initTheme("dark", false);
const terminal: Terminal = {
  columns: 80,
  rows: 24,
  kittyProtocolActive: false,
  start() {},
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
};

function nativeUi(mode: "regular" | "fullscreen") {
  const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
  let draft = "original unsent draft";
  let editorWrites = 0;
  const editor = {
    getText: () => draft,
    setText: (text: string) => {
      draft = text;
      editorWrites++;
    },
  };
  const host = Object.assign(Object.create(InteractiveMode.prototype) as object, {
    editor,
    ui: tui,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
    editorContainer: {
      clear() {
        throw new Error("Main editor must not be replaced");
      },
      addChild() {
        throw new Error("Main editor must not be replaced");
      },
    },
  }) as unknown as { showExtensionCustom: ExtensionCommandContext["ui"]["custom"] };
  const custom: ExtensionCommandContext["ui"]["custom"] = (factory, options) =>
    host.showExtensionCustom(factory, options);
  return {
    tui,
    editor,
    custom,
    get draft() {
      return draft;
    },
    set draft(value: string) {
      draft = value;
    },
    get editorWrites() {
      return editorWrites;
    },
  };
}

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode} actual native custom factory cannot pop foreign overlay or restore later draft`, async () => {
    const ui = nativeUi(mode);
    const foreign: Component = { render: () => ["Foreign dialog"], invalidate() {} };
    const foreignHandle = ui.tui.showOverlay(foreign);
    const foreignHide = vi.spyOn(foreignHandle, "hide");
    const f = await fixture({
      mode: "tui",
      ui: { custom: ui.custom, getEditorText: () => ui.draft, setEditorText: (text) => ui.editor.setText(text) },
    });
    const owner = new Owner(f.source.extensionRunner.createCommandContext(), true);
    try {
      const pending = new HumanUI(owner).confirm("Our dialog", "Inert preview 中\x1b[2J");
      await vi.waitFor(() => expect(ui.tui.getFocusedComponent()).not.toBe(foreign));
      const owned = ui.tui.getFocusedComponent();
      expect(owned).not.toBeNull();
      const laterForeign: Component = { render: () => ["Later foreign dialog"], invalidate() {} };
      const later = ui.tui.showOverlay(laterForeign);
      ui.draft = "later editor draft";
      owner.retire();
      await expect(pending).rejects.toThrow("retired");
      expect(ui.tui.getFocusedComponent()).toBe(laterForeign);
      expect(foreignHide).not.toHaveBeenCalled();
      expect(ui.draft).toBe("later editor draft");
      expect(ui.editorWrites).toBe(0);
      later.hide();
      expect(ui.tui.getFocusedComponent()).toBe(foreign);
      foreignHandle.hide();
      expect(ui.tui.hasOverlay()).toBe(false);
    } finally {
      owner.finish();
      await f.cleanup();
      ui.tui.stop();
    }
  });

  test(`${mode} live loader Escape aborts only its request and owned modal`, async () => {
    const ui = nativeUi(mode);
    const f = await fixture({ mode: "tui", ui: { custom: ui.custom, getEditorText: () => ui.draft } });
    const owner = new Owner(f.source.extensionRunner.createCommandContext(), true);
    let signal: AbortSignal | undefined;
    const work = deferred<string>();
    try {
      const pending = new HumanUI(owner).loading("Generating", (input) => {
        signal = input;
        return work.promise;
      });
      await vi.waitFor(() => expect(signal).toBeDefined());
      ui.tui.getFocusedComponent()?.handleInput?.("\x1b");
      expect(await pending).toBeUndefined();
      expect(signal?.aborted).toBe(true);
      expect(ui.tui.hasOverlay()).toBe(false);
      work.resolve("late answer");
      await work.promise;
      expect(ui.editorWrites).toBe(0);
    } finally {
      owner.finish();
      work.resolve("late");
      await f.cleanup();
      ui.tui.stop();
    }
  });

  test(`${mode} later TUI draft or custom-editor ownership invalidates handoff before mutation`, async () => {
    const ui = nativeUi(mode);
    const f = await fixture({ mode: "tui", ui: { custom: ui.custom, getEditorText: () => ui.draft } });
    try {
      const pending = f.command("handoff", "continue");
      await vi.waitFor(() => expect(ui.tui.hasOverlay()).toBe(true));
      ui.draft = "later human draft";
      await pending;
      expect(ui.draft).toBe("later human draft");
      expect(ui.tui.hasOverlay()).toBe(false);
      expect(f.withSessions).toBe(0);
      expect(f.generationCalls).toBe(0);
    } finally {
      await f.cleanup();
      ui.tui.stop();
    }
  });

  test.each([false, true])(
    `${mode} async loading failure=%s cannot continue over a foreign focused overlay`,
    async (failure) => {
      const ui = nativeUi(mode);
      const f = await fixture({ mode: "tui", ui: { custom: ui.custom, getEditorText: () => ui.draft } });
      const owner = new Owner(f.source.extensionRunner.createCommandContext(), true);
      const work = deferred<string>();
      const human = new HumanUI(owner);
      try {
        const continued = vi.fn();
        const pending = (async () => {
          let value: string | undefined;
          try {
            value = await human.loading("Generating", () => work.promise);
          } catch {
            // Match handoff's manual fallback: only a still-current owner may
            // offer another dialog after a provider error.
            if (owner.current()) {
              continued();
              void human.confirm("Must not open", "Manual fallback?").catch(() => {});
            }
            return;
          }
          if (value !== undefined) {
            continued();
            // A real handoff would open its review here, stealing foreign focus.
            void human.editor("Must not open", value).catch(() => {});
          }
        })();
        void pending.catch(() => {});
        await vi.waitFor(() => expect(ui.tui.hasOverlay()).toBe(true));
        const foreign: Component = { render: () => ["Foreign review"], invalidate() {} };
        const foreignHandle = ui.tui.showOverlay(foreign);
        if (failure) work.reject(new Error("provider unavailable"));
        else work.resolve("completed generation");
        await pending.catch(() => {});
        expect(continued).not.toHaveBeenCalled();
        expect(ui.tui.getFocusedComponent()).toBe(foreign);
        expect(foreignHandle.isFocused()).toBe(true);
        expect(ui.draft).toBe("original unsent draft");
        expect(ui.editorWrites).toBe(0);
        foreignHandle.hide();
      } finally {
        owner.finish();
        work.resolve("late");
        await f.cleanup();
        ui.tui.stop();
      }
    },
  );

  test.each(["branch", "model"] as const)(
    `${mode} source %s revocation during native preflight cannot authorize TUI prefill`,
    async (boundary) => {
      const ui = nativeUi(mode);
      const entered = deferred<void>();
      const permit = deferred<void>();
      const f = await fixture({
        mode: "tui",
        memory: true,
        ui: { custom: ui.custom, getEditorText: () => ui.draft, setEditorText: (text) => ui.editor.setText(text) },
        extra: (pi) =>
          pi.on("session_before_switch", async (_event, ctx) => {
            if (ctx.sessionManager === f.manager) {
              entered.resolve();
              await permit.promise;
            }
          }),
      });
      let running: Promise<void> | undefined;
      try {
        running = f.command("handoff", "continue");
        let previous: Component | null = null;
        for (const keys of [
          ["\r"],
          ["\x1b[B", "\r"],
          ["approved recovery summary", "\r"],
          ["\x1b[B", "\r"],
          ["\x1b[B", "\r"],
        ]) {
          await vi.waitFor(() => {
            expect(ui.tui.getFocusedComponent()).not.toBeNull();
            expect(ui.tui.getFocusedComponent()).not.toBe(previous);
          });
          previous = ui.tui.getFocusedComponent();
          previous?.render(80);
          for (const key of keys) previous?.handleInput?.(key);
        }
        await entered.promise;
        if (boundary === "branch") {
          f.manager.appendCustomEntry("new source branch state");
          await new Promise((resolve) => setTimeout(resolve, 120));
        } else {
          vi.spyOn(f.runtime.services.modelRuntime, "checkAuth").mockResolvedValue({ type: "api_key" });
          await f.source.setModel({ ...model, id: "changed" });
          expect(f.source.model?.id).toBe("changed");
        }
        permit.resolve();
        await running;
        expect(f.runtime.session).not.toBe(f.source);
        const entry = f.runtime.session.sessionManager
          .getBranch()
          .find((item) => item.type === "custom" && item.customType === HANDOFF_TYPE);
        const saved = entry?.type === "custom" ? readHandoff(entry.data) : undefined;
        expect(saved?.summary).toBe("approved recovery summary");
        expect(saved?.prefill).toBeUndefined();
        expect(ui.draft).toBe("original unsent draft");
        expect(ui.editorWrites).toBe(0);
        expect(f.destinationTurns).toBe(0);
      } finally {
        permit.resolve();
        await running;
        vi.restoreAllMocks();
        await f.cleanup();
        ui.tui.stop();
      }
    },
  );
}

test.each(["regular", "fullscreen"] as const)(
  "%s native multiline review commits only editor prefill and preserves a foreign later draft",
  async (mode) => {
    for (const laterWriter of [false, true]) {
      const ui = nativeUi(mode);
      const f = await fixture({
        memory: true,
        mode: "tui",
        ui: {
          custom: ui.custom,
          getEditorText: () => ui.draft,
          setEditorText: (text) => ui.editor.setText(text),
        },
        extra: (pi) =>
          pi.on("session_shutdown", (event) => {
            if (laterWriter && event.reason === "new") ui.draft = "foreign destination draft";
          }),
      });
      try {
        let prior: Component | null = null;
        const step = async (keys: string[]) => {
          await vi.waitFor(() => {
            expect(ui.tui.getFocusedComponent()).not.toBeNull();
            expect(ui.tui.getFocusedComponent()).not.toBe(prior);
          });
          const component = ui.tui.getFocusedComponent() as Component;
          prior = component;
          for (const width of [1, 2, 12, 80]) {
            for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
          }
          for (const key of keys) component.handleInput?.(key);
        };
        const running = f.command("handoff", "continue");
        await step(["\r"]); // decline provider synthesis
        await step(["\x1b[B", "\r"]); // manual editor consent
        await step(["\x1b[200~Human reviewed summary\n中文 next steps\x1b[201~", "\r"]);
        await step(["\x1b[B", "\r"]); // draft replacement consent
        await step(["\x1b[B", "\r"]); // final linked-session confirmation
        await running;
        expect(f.withSessions).toBe(1);
        expect(f.generationCalls).toBe(0);
        expect(f.destinationTurns).toBe(0);
        expect(f.runtime.session.sessionManager.buildSessionContext().messages).toEqual([]);
        expect(ui.draft).toBe(laterWriter ? "foreign destination draft" : "Human reviewed summary\n中文 next steps");
        expect(ui.tui.hasOverlay()).toBe(false);
      } finally {
        await f.cleanup();
        ui.tui.stop();
      }
    }
  },
);

test.each([1, 2, 8, 20, 80])("picker/preview terminal columns <= %s with ANSI, CJK and bidi", (width) => {
  let selected: SessionRow | undefined;
  const picker = new Picker(
    (row) => {
      selected = row;
    },
    () => {},
  );
  picker.focused = true;
  const rows: SessionRow[] = Array.from({ length: 200 }, (_, i) => ({
    id: `id${i}`,
    path: `/session/${i}`,
    cwd: "/中/workspace",
    name: "中\x1b[2J\x1b]0;evil\x07\u202eevil",
    messageCount: 1,
    modified: "2026",
  }));
  picker.update(rows, 200, 200, true);
  const rendered = picker.render(width);
  expect(rendered.length).toBeLessThanOrEqual(24); // actual row budget, not fixed PAGE_ROWS
  for (const line of rendered) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(line).not.toContain("\x1b[2J");
    expect(line).not.toContain("\u202e");
  }
  picker.handleInput("\x1b[B");
  const expected = rows[1];
  picker.update([rows[2], expected, rows[0]], 3, 3, true);
  if (width < 12) {
    picker.handleInput("\r");
    expect(selected).toBeUndefined(); // a clipped/resize-only view cannot approve
    picker.render(80);
  }
  picker.handleInput("\r");
  expect(selected?.id).toBe(expected.id);
  for (const line of safeLines(["中中\x1b]52;c;secret\x07", "\u202eunsafe"], width))
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
});

test("live default picker hides foreign progress rows and Escape aborts the SDK list", async () => {
  const ui = nativeUi("regular");
  const f = await fixture({ mode: "tui", ui: { custom: ui.custom, getEditorText: () => ui.draft } });
  const list = deferred<Awaited<ReturnType<typeof SessionManager.list>>>();
  let signal: AbortSignal | undefined;
  try {
    vi.spyOn(SessionManager, "list").mockImplementation(async (_cwd, _directory, progress, input) => {
      signal = input;
      const metadata = {
        messageCount: 1,
        allMessagesText: "excluded bulk",
        firstMessage: "first",
        created: new Date(1),
        modified: new Date(2),
      };
      progress?.(2, 2, [
        { ...metadata, path: "/foreign-session", id: "foreign-id", cwd: "/foreign", name: "foreign hidden" },
        { ...metadata, path: "/local-session", id: "local-id", cwd: f.cwd, name: "local visible" },
      ]);
      return list.promise;
    });
    const running = f.command("sessions");
    await vi.waitFor(() => expect(signal).toBeDefined());
    const component = ui.tui.getFocusedComponent() as Component;
    const preview = component.render(120).join("\n");
    expect(preview).toContain("local visible");
    expect(preview).not.toContain("foreign hidden");
    component.handleInput?.("\x1b");
    await running;
    expect(signal?.aborted).toBe(true);
    expect(ui.tui.hasOverlay()).toBe(false);
    expect(f.runtime.session).toBe(f.source);
    list.resolve([]);
  } finally {
    list.resolve([]);
    vi.restoreAllMocks();
    await f.cleanup();
    ui.tui.stop();
  }
});

test("display rows discard bulk SDK fields and cap retained rows; filter selects stable identity", () => {
  const sessions = Array.from({ length: 1000 }, (_, i) => ({
    id: `${i}`,
    path: `/s/${i}`,
    cwd: "/workspace",
    messageCount: 2,
    firstMessage: "中".repeat(3000),
    allMessagesText: "SECRET BULK".repeat(1000),
    created: new Date(1),
    modified: new Date(2),
  }));
  const rows = rowsFrom(sessions);
  expect(rows.length).toBe(200);
  expect(JSON.stringify(rows)).not.toContain("SECRET BULK");
  expect(Buffer.byteLength(rows[0].name ?? "")).toBeLessThanOrEqual(180);
  let chosen: SessionRow | undefined;
  const picker = new Picker(
    (row) => {
      chosen = row;
    },
    () => {},
  );
  picker.update(rows, 1000, 1000, true);
  picker.handleInput("199");
  picker.handleInput("\r");
  expect(chosen?.id).toBe("199");
});

test("text transfer excludes tool/image/system/custom/thinking and common credentials; approved UTF8 limit rejects", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({
    role: "user",
    content: [
      { type: "text", text: "api_key=DO_NOT_COPY 中" },
      { type: "image", data: "BULK_IMAGE", mimeType: "image/png" },
    ],
    timestamp: 1,
  });
  manager.appendMessage({
    ...response("visible assistant"),
    content: [
      { type: "text", text: "visible assistant" },
      { type: "thinking", thinking: "PRIVATE_THINKING" },
    ],
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "call",
    toolName: "bash",
    isError: false,
    content: [{ type: "text", text: "PRIVATE_TOOL" }],
    timestamp: 2,
  });
  manager.appendMessage({ role: "system", content: "PRIVATE_SYSTEM", timestamp: 3 });
  manager.appendCustomEntry("test", { text: "PRIVATE_CUSTOM" });
  const text = recentText(manager.getBranch());
  for (const excluded of [
    "DO_NOT_COPY",
    "BULK_IMAGE",
    "PRIVATE_THINKING",
    "PRIVATE_TOOL",
    "PRIVATE_SYSTEM",
    "PRIVATE_CUSTOM",
  ])
    expect(text).not.toContain(excluded);
  expect(text).toContain("visible assistant");
  expect(text).toContain("中");
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(SHARE_BYTES);
  expect(validSummary("a".repeat(SUMMARY_BYTES))).toBe(true);
  expect(validSummary("中".repeat(5462))).toBe(false);
  expect(plain("中\x1b]52;c;data\x07\u202e文")).toBe("中文");
  expect(messageText({ type: "message", message: { role: "custom", content: "excluded" } })).toBeUndefined();
});
