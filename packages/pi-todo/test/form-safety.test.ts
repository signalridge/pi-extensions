import { Editor, getKeybindings, Input, setKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { nativeTerminal } from "./native-terminal.js";

const attack = "X\x1b[31m\x1b]52;c;test\x07\u202e\x1b[2J";
for (const fullscreen of [false, true]) {
  const mode = fullscreen ? "fullscreen" : "regular";
  for (const field of ["title", "dependencies"] as const) {
    it.each([false, true])(
      `${mode} ${field} prefill Undo stops at the initial baseline after edits=%s`,
      async (edit) => {
        const f = await nativeTerminal(fullscreen);
        let running: Promise<void> | undefined;
        try {
          const prerequisite = f.store.mutate(f.ctx, {
            action: "add",
            baseRevision: 0,
            title: "Prerequisite",
            status: "completed",
          });
          const before = f.store.mutate(f.ctx, {
            action: "add",
            baseRevision: 1,
            title: "Keep 中文 title",
            dependencies: [prerequisite.tasks[0].id],
          });
          running = f.command.run(f.ctx);
          await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
          f.key("\x1b[F");
          f.key("e");
          await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
          if (field === "dependencies") {
            f.key("\t");
            f.key("\t");
          }
          if (edit) {
            f.key("X");
            f.key("\x1f");
          }
          f.key("\x1f"); // No user edit remains to undo: initialization is not an edit.
          f.key("\x13");
          await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
          expect(f.store.read(f.ctx)).toEqual(before);
          expect(f.session.messages).toEqual([]);
        } finally {
          f.command.retire();
          await running;
          await f.dispose();
        }
      },
    );
  }
  it.each([false, true])(
    `${mode} remapped End never edits prefill on three unchanged Enters (CJK/dependencies=%s)`,
    async (dependencies) => {
      const originalKeys = getKeybindings();
      const originalBindings = { ...originalKeys.getUserBindings() };
      const f = await nativeTerminal(fullscreen);
      let running: Promise<void> | undefined;
      try {
        const keys = getKeybindings();
        keys.setUserBindings({
          ...keys.getUserBindings(),
          "tui.editor.cursorLineEnd": "ctrl+e",
          "tui.editor.deleteCharForward": "end",
        });
        const prerequisite = f.store.mutate(f.ctx, {
          action: "add",
          baseRevision: 0,
          title: "Prerequisite",
          status: "completed",
        });
        const before = f.store.mutate(f.ctx, {
          action: "add",
          baseRevision: 1,
          title: dependencies ? "中文 abcd" : "abcd",
          description: "Keep 中文 description",
          dependencies: dependencies ? [prerequisite.tasks[0].id] : [],
        });
        running = f.command.run(f.ctx);
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
        f.key("\x1b[F");
        f.key("e");
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
        f.record("remapped-End-prefill", f.lines());
        f.key("\r");
        f.key("\r");
        f.key("\r");
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
        expect(f.store.read(f.ctx)).toEqual(before);
        f.record("remapped-End-unchanged-snapshot", f.lines());
        expect(getKeybindings()).toBe(keys);
        expect(keys.getUserBindings()).toMatchObject({
          "tui.editor.cursorLineEnd": "ctrl+e",
          "tui.editor.deleteCharForward": "end",
        });
        expect(f.session.messages).toEqual([]);
      } finally {
        f.command.retire();
        await running;
        await f.dispose();
        setKeybindings(originalKeys);
        originalKeys.setUserBindings(originalBindings);
      }
    },
  );
  it.each([false, true])(
    `${mode} remapped submit preserves description, native Undo and newline precedence (Enter newline=%s)`,
    async (enterNewline) => {
      const originalKeys = getKeybindings();
      const originalBindings = { ...originalKeys.getUserBindings() };
      const f = await nativeTerminal(fullscreen);
      let running: Promise<void> | undefined;
      try {
        const keys = getKeybindings();
        keys.setUserBindings({
          ...keys.getUserBindings(),
          "tui.input.submit": ["ctrl+g", "shift+enter"], // Newline must win the shared Shift+Enter binding.
          ...(enterNewline ? { "tui.input.newLine": ["enter", "shift+enter", "ctrl+j"] as const } : {}),
        });
        const before = f.store.mutate(f.ctx, {
          action: "add",
          baseRevision: 0,
          title: "Keep title",
          description: "  first line\nlast  ",
        });
        running = f.command.run(f.ctx);
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
        f.key("e");
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
        f.key("\t");
        f.key("\x1b[200~X\x1b[201~");
        f.key("Y");
        expect(f.lines().map(stripTerminalSequences).join("\n")).toContain("last  XY");
        f.key("\x07"); // Public configured tui.input.submit, not literal Return.
        expect(f.lines().join("\n")).toContain("Dependency UUIDs");
        f.key("\x1b[Z");
        expect(f.lines().map(stripTerminalSequences).join("\n")).toContain("last  XY");
        f.key("\x1f");
        expect(f.lines().map(stripTerminalSequences).join("\n")).toContain("last  X");
        expect(f.lines().map(stripTerminalSequences).join("\n")).not.toContain("last  XY");
        f.key("\x1f"); // Paste remains one native Undo step across field navigation.
        f.key(enterNewline ? "\r" : "\x1b[13;2u");
        expect(f.lines().join("\n")).toContain("Description (0-512");
        f.key("Z");
        f.key("\x07");
        f.key("\x13");
        await vi.waitFor(() => expect(f.store.read(f.ctx).revision).toBe(2));
        expect(f.store.read(f.ctx).tasks[0]).toMatchObject({ description: `${before.tasks[0].description}\nZ` });
      } finally {
        f.command.retire();
        await running;
        await f.dispose();
        setKeybindings(originalKeys);
        originalKeys.setUserBindings(originalBindings);
        expect(getKeybindings().getUserBindings()).toEqual(originalBindings);
        expect(getKeybindings()).toBe(originalKeys);
      }
    },
  );
  it(`${mode} sanitizes model-supplied edit prefill before native rendering and preserves unchanged state`, async () => {
    const f = await nativeTerminal(fullscreen);
    let running: Promise<void> | undefined;
    const inputs: string[] = [];
    const editors: string[] = [];
    const inputRender = Input.prototype.render;
    const editorRender = Editor.prototype.render;
    const inputSpy = vi.spyOn(Input.prototype, "render").mockImplementation(function (this: Input, width) {
      inputs.push(this.getValue());
      return inputRender.call(this, width);
    });
    const editorSpy = vi.spyOn(Editor.prototype, "render").mockImplementation(function (this: Editor, width) {
      editors.push(this.getExpandedText());
      return editorRender.call(this, width);
    });
    try {
      const before = f.store.mutate(f.ctx, {
        action: "add",
        baseRevision: 0,
        title: `${attack} task`,
        description: `${attack} description`,
      });
      running = f.command.run(f.ctx);
      await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
      f.key("e");
      await vi.waitFor(() => {
        f.lines();
        expect(inputs.length).toBeGreaterThan(0);
      });
      for (const unsafe of ["\x1b", "\u202e"]) expect(inputs.at(-1)).not.toContain(unsafe);
      f.key("\r");
      await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Description (0-512"));
      for (const unsafe of ["\x1b", "\u202e"]) expect(editors.at(-1)).not.toContain(unsafe);
      f.key("\r");
      f.key("\x13");
      await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
      expect(f.store.read(f.ctx)).toEqual(before); // Inert display must not silently rewrite saved task data.
    } finally {
      inputSpy.mockRestore();
      editorSpy.mockRestore();
      f.command.retire();
      await running;
      await f.dispose();
    }
  });

  it(`${mode} preserves a valid title that displays empty on unchanged and description-only edits`, async () => {
    const f = await nativeTerminal(fullscreen);
    let running: Promise<void> | undefined;
    try {
      const before = f.store.mutate(f.ctx, { action: "add", baseRevision: 0, title: "\u202e", description: "before" });
      running = f.command.run(f.ctx);
      await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
      f.key("e");
      await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
      f.key("\r");
      f.key("\r");
      f.key("\r");
      await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
      expect(f.store.read(f.ctx)).toEqual(before);
      f.key("e");
      await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
      f.key("\r");
      f.key("\x01");
      f.key("\x0b");
      f.key("after");
      f.key("\x13");
      await vi.waitFor(() => expect(f.store.read(f.ctx).revision).toBe(2));
      expect(f.store.read(f.ctx).tasks[0]).toMatchObject({ title: "\u202e", description: "after" });
    } finally {
      f.command.retire();
      await running;
      await f.dispose();
    }
  });

  for (const field of ["title", "description"] as const) {
    it.each([false, true])(
      `${mode} ${field} unsafe paste split=%s keeps native insertion and Undo clean`,
      async (split) => {
        const f = await nativeTerminal(fullscreen);
        let running: Promise<void> | undefined;
        const inputValues: string[] = [];
        const editorValues: string[] = [];
        const inputRender = Input.prototype.render;
        const editorRender = Editor.prototype.render;
        const inputSpy = vi.spyOn(Input.prototype, "render").mockImplementation(function (this: Input, width) {
          inputValues.push(this.getValue());
          return inputRender.call(this, width);
        });
        const editorSpy = vi.spyOn(Editor.prototype, "render").mockImplementation(function (this: Editor, width) {
          editorValues.push(this.getExpandedText());
          return editorRender.call(this, width);
        });
        try {
          f.store.mutate(f.ctx, { action: "add", baseRevision: 0, title: "abcd", description: "abcd" });
          running = f.command.run(f.ctx);
          await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
          f.key("e");
          await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
          if (field === "description") f.key("\r");
          f.key("\x01");
          if (split)
            for (const chunk of ["\x1b[20", "0~X\x1b[31m\x1b]52;c;", "test\x07\u202e\x1b[2J\x1b[20", "1~"])
              f.key(chunk);
          else f.key(`\x1b[200~${attack}\x1b[201~`);
          f.key("Y");
          f.lines();
          const current = () => (field === "title" ? inputValues : editorValues).at(-1);
          expect(current()).toBe("XYabcd");
          f.key("\x1f");
          f.lines();
          expect(current()).toBe("Xabcd");
          f.key("\x1f");
          f.lines();
          expect(current()).toBe("abcd");
        } finally {
          inputSpy.mockRestore();
          editorSpy.mockRestore();
          f.command.retire();
          await running;
          await f.dispose();
        }
      },
    );
  }
}
