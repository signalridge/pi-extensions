import { type ExtensionCommandContext, InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  getKeybindings,
  Input,
  KeybindingsManager,
  setKeybindings,
  type Terminal,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { Owner } from "../src/ownership.js";
import { plain } from "../src/text.js";
import { HumanUI, type SessionRow, safeLines } from "../src/ui.js";
import { fixture } from "./support.js";

initTheme("dark", false);

/** Real public SDK renderers and native custom-dialog factory, not a CLI/PTY.
 * Read their public post-composition frame APIs, after overlay clipping and
 * cursor extraction. Terminal transport is deterministic and in-memory. */
async function screen(mode: "regular" | "fullscreen", columns: number, rows: number) {
  let input: (data: string) => void = () => {};
  let resize = () => {};
  const size = { columns, rows };
  const writes: string[] = [];
  const terminal: Terminal = {
    get columns() {
      return size.columns;
    },
    get rows() {
      return size.rows;
    },
    kittyProtocolActive: false,
    start(onInput, onResize) {
      input = onInput;
      resize = onResize;
    },
    stop() {},
    async drainInput() {},
    write: (text) => writes.push(text),
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  };
  const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
  // Include a real underlying document, so regular-mode viewport composition
  // is exercised with scrollback as well as fullscreen composition.
  tui.addChild({
    render: (width) =>
      safeLines(
        Array.from({ length: 50 }, (_, i) => `host row ${i}`),
        width,
      ),
    invalidate() {},
  });
  const host = Object.assign(Object.create(InteractiveMode.prototype) as object, {
    ui: tui,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
    editor: {
      getText: () => "foreign draft",
      setText: () => {
        throw new Error("Must not touch draft");
      },
    },
  }) as unknown as { showExtensionCustom: ExtensionCommandContext["ui"]["custom"] };
  const f = await fixture({
    mode: "tui",
    ui: {
      custom: (factory, options) => host.showExtensionCustom(factory, options),
      getEditorText: () => "foreign draft",
    },
  });
  const owner = new Owner(f.source.extensionRunner.createCommandContext(), true);
  tui.start();
  return {
    ui: new HumanUI(owner),
    tui,
    writes,
    key: (data: string) => input(data),
    resize(columns: number, rows: number) {
      size.columns = columns;
      size.rows = rows;
      resize();
    },
    async opened() {
      await vi.waitFor(() => expect(tui.hasOverlay()).toBe(true));
    },
    frame() {
      tui.renderNow(true);
      const lines =
        tui instanceof TuiMainScreen
          ? tui.captureRenderState().previousLines.slice(-terminal.rows)
          : tui.getScreenLines();
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(terminal.columns);
      return lines;
    },
    async cleanup() {
      owner.retire();
      owner.finish();
      tui.stop();
      await f.cleanup();
    },
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: verify native terminal cursor SGR
const inverseCell = /\x1b\[7m[^\x1b]+\x1b\[(?:0|27)m/u;
const prefill = Array.from({ length: 35 }, (_, i) => `line-${String(i).padStart(2, "0")} 中文`).join("\n");
const sessions: SessionRow[] = Array.from({ length: 40 }, (_, i) => ({
  id: `id-${i}`,
  path: `/session/${i}`,
  cwd: "/workspace",
  name: `session-${i}`,
  messageCount: 1,
  modified: "2026",
}));

test("renderer sanitizer only retains inverse/reset and IME marker, keeping the insertion cell in bounds", () => {
  for (const width of [1, 2, 40]) {
    const [line] = safeLines(
      [`中文${CURSOR_MARKER}\x1b[7m \x1b[0m\x1b[31mRED\x1b[8mHIDDEN\x1b[2J\x1b]52;c;secret\x07\u202e\u0000`],
      width,
    );
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(line).toContain(CURSOR_MARKER);
    expect(line).toMatch(inverseCell);
    const text = line.replaceAll(CURSOR_MARKER, "").replaceAll("\x1b[7m", "").replaceAll("\x1b[0m", "");
    expect(text).toBe(plain(text));
    expect(line).not.toContain("secret");
  }
});

for (const mode of ["regular", "fullscreen"] as const) {
  test.each([false, true])(`${mode} paste cancels pending native character jump; undo=%s`, async (undo) => {
    const s = await screen(mode, 40, 12);
    try {
      const pending = s.ui.editor("Review jump and paste", "abc");
      void pending.catch(() => {});
      await s.opened();
      s.frame();
      s.key("d"); // Earlier history must survive the paste and both Undo steps.
      s.key("\x1d"); // Native Ctrl+] waits for one character to jump to.
      s.key("\x1b[200~X\x1b[201~");
      s.key("Y");
      expect(plain(s.frame().join("\n"))).toContain("abcdXY");
      if (undo) {
        s.key("\x1f");
        expect(plain(s.frame().join("\n"))).toContain("abcdX");
        s.key("\x1f");
        const restored = plain(s.frame().join("\n"));
        expect(restored).toContain("abcd");
        expect(restored).not.toContain("abcdX");
        s.key("\x1f");
        const earlier = plain(s.frame().join("\n"));
        expect(earlier).toContain("abc");
        expect(earlier).not.toContain("abcd");
      }
      s.key("\r");
      expect(await pending).toBe(undo ? "abc" : "abcdXY");
    } finally {
      await s.cleanup();
    }
  });
  test(`${mode} approval preserves exact leading/trailing whitespace, including expanded large paste`, async () => {
    const s = await screen(mode, 40, 12);
    try {
      const text = "    return value\n";
      const pending = s.ui.editor("Review exact document", text);
      void pending.catch(() => {});
      await s.opened();
      s.frame();
      s.key("\r");
      expect(await pending).toBe(text);
      const large = `  ${prefill}\n\n`;
      const pasted = s.ui.editor("Review exact paste");
      void pasted.catch(() => {});
      const settled = vi.fn();
      void pasted.then(settled, () => {});
      await s.opened();
      s.key(`\x1b[200~${large}\x1b[201~`);
      expect(plain(s.frame().join("\n"))).not.toContain("[paste #");
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      s.key("\r");
      expect(await pasted).toBe(large);
    } finally {
      await s.cleanup();
    }
  });

  test.each([false, true])(
    `${mode} unsafe paste split=%s preserves mid-document cursor and native Undo`,
    async (split) => {
      const s = await screen(mode, 40, 12);
      try {
        const pending = s.ui.editor("Review insertion", "abcd");
        void pending.catch(() => {});
        await s.opened();
        s.frame();
        s.key("\x01");
        const attack = "X\x1b[31m\x1b]52;c;secret\x07\u202e\x1b[A\x03";
        if (split)
          for (const chunk of ["\x1b[2", "00~X\x1b[31", "m\x1b]52;c;secret", "\x07\u202e\x1b[A\x03\x1b[20", "1~"])
            s.key(chunk);
        else s.key(`\x1b[200~${attack}\x1b[201~`);
        s.key("Y");
        expect(plain(s.frame().join("\n"))).toContain("XYabcd");
        s.key("\x1f");
        expect(plain(s.frame().join("\n"))).toContain("Xabcd");
        s.key("\x1f");
        const undone = plain(s.frame().join("\n"));
        expect(undone).toContain("abcd");
        expect(undone).not.toContain("Xabcd");
        s.key("\r");
        expect(await pending).toBe("abcd");
      } finally {
        await s.cleanup();
      }
    },
  );

  test(`${mode} repeated Undo removes unsafe paste rather than re-snapshotting dirty input`, async () => {
    const s = await screen(mode, 40, 12);
    try {
      const pending = s.ui.editor("Review Undo", "abcd");
      void pending.catch(() => {});
      await s.opened();
      s.frame();
      s.key("\x01");
      s.key("\x1b[200~X\u202e\x1b[201~");
      for (const expected of ["abcd", "", ""]) {
        s.key("\x1f");
        const lines = s.frame();
        expect(plain(lines.join("\n"))).not.toContain("Xabcd");
        if (expected) expect(plain(lines.join("\n"))).toContain(expected);
        else expect(plain(lines.join("\n"))).not.toContain("abcd");
      }
      s.key("\r");
      expect(await pending).toBe("");
    } finally {
      await s.cleanup();
    }
  });

  test.each([false, true])(`${mode} picker split=%s inserts sanitized paste at the native cursor`, async (split) => {
    const s = await screen(mode, 40, 12);
    try {
      const pending = s.ui.pick(async (publish) => {
        const rows = [
          { ...sessions[0], name: "XYabcd" },
          { ...sessions[1], name: "XaYbcd" },
        ];
        publish(rows, 2, 2, true);
        return rows;
      });
      void pending.catch(() => {});
      await s.opened();
      s.frame();
      s.key("abcd");
      s.key("\x01");
      if (split) for (const chunk of ["\x1b[20", "0~X\u202e\x1b[2", "01~"]) s.key(chunk);
      else s.key("\x1b[200~X\u202e\x1b[201~");
      s.key("Y");
      const frame = plain(s.frame().join("\n"));
      expect(frame).toContain("XYabcd");
      expect(frame).not.toContain("XaYbcd");
      s.key("\r");
      expect((await pending)?.id).toBe(sessions[0].id);
    } finally {
      await s.cleanup();
    }
  });

  test(`${mode} safe native Kitty/IME text, backspace and newline precedence survive the input adapter`, async () => {
    const s = await screen(mode, 40, 12);
    try {
      const pending = s.ui.editor("Review keys", "abcd");
      void pending.catch(() => {});
      const settled = vi.fn();
      void pending.then(settled, () => {});
      await s.opened();
      s.frame();
      s.key("\x01");
      s.key("\x1b[88u"); // native Kitty printable X
      s.key("\x1b[8238u"); // encoded bidi must never enter native Undo
      s.key("\x1b[27;1;8238~"); // modifyOtherKeys unsafe printable
      s.key("中文"); // ordinary IME commit
      s.key("\x1b[127u"); // native Kitty backspace deletes one grapheme
      s.key("Y");
      expect(plain(s.frame().join("\n"))).toContain("X中Yabcd");
      s.key("\x1b[13;2u"); // native Shift+Enter is newline, not approval
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      s.frame();
      s.key("\r");
      expect(await pending).toBe("X中Y\nabcd");
    } finally {
      await s.cleanup();
    }
  });

  test.each(["summary\\", "    summary\\", "\\", "  summary\\\nnext\n"])(
    `${mode} remapped native backslash submission preserves edits and exact whitespace: %j`,
    async (text) => {
      const previousKeys = getKeybindings();
      const s = await screen(mode, 40, 12);
      setKeybindings(
        new KeybindingsManager(TUI_KEYBINDINGS, {
          "tui.input.newLine": "enter",
          "tui.input.submit": "shift+enter",
        }),
      );
      try {
        const pending = s.ui.editor("Review remapped keys", text);
        void pending.catch(() => {});
        await s.opened();
        s.frame();
        if (text.includes("\n")) {
          s.key("\x1b[A");
          s.key("\x1b[A");
          s.key("\x05");
        }
        s.key("\r"); // Native escape removes the backslash before submission.
        expect(await pending).toBe(text.replace("\\", ""));
      } finally {
        setKeybindings(previousKeys);
        await s.cleanup();
      }
    },
  );

  test(`${mode} raw terminal Backspace edits the reviewed document`, async () => {
    const s = await screen(mode, 40, 12);
    try {
      const pending = s.ui.editor("Review Backspace", "abc");
      void pending.catch(() => {});
      await s.opened();
      s.frame();
      s.key("\x7f");
      s.key("\r");
      expect(await pending).toBe("ab");
    } finally {
      await s.cleanup();
    }
  });

  test(`${mode} backslash Enter remains native newline rather than premature approval`, async () => {
    const s = await screen(mode, 40, 12);
    try {
      const pending = s.ui.editor("Review native newline", "abcd\\");
      void pending.catch(() => {});
      const settled = vi.fn();
      void pending.then(settled, () => {});
      await s.opened();
      s.frame();
      s.key("\r");
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      s.frame();
      s.key("\r");
      expect(await pending).toBe("abcd\n");
    } finally {
      await s.cleanup();
    }
  });

  test(`${mode} software cursor survives SDK overlay composition with hardware cursor disabled`, async () => {
    const s = await screen(mode, 40, 12);
    try {
      expect(s.tui.getShowHardwareCursor()).toBe(false);
      const pending = s.ui.editor("Review", "abc");
      void pending.catch(() => {});
      await s.opened();
      expect(s.frame().join("\n")).toMatch(inverseCell);
      s.key("\x1b");
      expect(await pending).toBeUndefined();
    } finally {
      await s.cleanup();
    }
  });

  test(`${mode} 40x12 and 100x30 composited review keeps last line and navigation visible across resize`, async () => {
    const s = await screen(mode, 40, 12);
    try {
      const pending = s.ui.editor(
        "Review summary and all next steps before approving this handoff. ".repeat(3),
        prefill,
      );
      void pending.catch(() => {});
      await s.opened();
      for (const [width, height] of [
        [40, 12],
        [100, 30],
        [40, 12],
      ]) {
        s.resize(width, height);
        const frame = s.frame().join("\n");
        expect(plain(frame)).toContain("line-34 中文");
        expect(frame).toMatch(inverseCell);
        expect(plain(frame)).toMatch(/cancel/i);
        expect(plain(frame)).toMatch(/accept|submit/i);
      }
      // Native cursor navigation makes every logical line reviewable.
      const seen = new Set<string>();
      for (let i = 0; i < 40; i++) {
        for (const match of plain(s.frame().join("\n")).matchAll(/line-\d{2}/gu)) seen.add(match[0]);
        s.key("\x1b[A");
      }
      expect(seen.size).toBe(35);
      for (let i = 0; i < 40; i++) {
        s.key("\x1b[B");
        s.frame();
      }
      expect(plain(s.frame().join("\n"))).toContain("line-34 中文");
      s.key("\r");
      expect(await pending).toBe(prefill);
    } finally {
      await s.cleanup();
    }
  });

  test(`${mode} picker filter cursor and essential help fit actual overlay height, including resize`, async () => {
    const s = await screen(mode, 40, 12);
    try {
      const pending = s.ui.pick(async (publish) => {
        publish(sessions, 40, 40, true);
        return sessions;
      });
      void pending.catch(() => {});
      await s.opened();
      for (const [width, height] of [
        [40, 12],
        [100, 30],
        [40, 12],
      ]) {
        s.resize(width, height);
        const frame = s.frame().join("\n");
        expect(plain(frame)).toMatch(/cancel/i);
        expect(plain(frame)).toMatch(/preview/i);
        expect(frame).toMatch(inverseCell);
      }
      s.key("39");
      expect(plain(s.frame().join("\n"))).toContain("session-39");
      s.key("\r");
      expect((await pending)?.id).toBe("id-39");
    } finally {
      await s.cleanup();
    }
  });

  test(`${mode} resize-before-render cannot approve editor, picker or confirmation`, async () => {
    const s = await screen(mode, 40, 12);
    try {
      for (const open of [
        () => s.ui.editor("Review", prefill),
        () =>
          s.ui.pick(async (publish) => {
            publish(sessions, 40, 40, true);
            return sessions;
          }),
        () => s.ui.confirm("Confirm", prefill),
      ]) {
        const pending = open();
        void pending.catch(() => {});
        const settled = vi.fn();
        void pending.then(settled, () => {});
        await s.opened();
        s.frame();
        s.resize(1, 12);
        s.key("\r"); // no render/tick between resize and Enter
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
        expect(s.tui.hasOverlay()).toBe(true);
        s.key("\x1b[5~");
        s.key("\x1b[6~");
        s.resize(40, 12);
        s.frame();
        s.key("\x1b");
        await pending;
      }
    } finally {
      await s.cleanup();
    }
  });

  test(`${mode} tiny resize cannot approve hidden content; CJK and oversized graphemes return intact`, async () => {
    const s = await screen(mode, 100, 30);
    try {
      const text = `中文😀${"中".repeat(120)}\nlast line 中文😀`;
      const pending = s.ui.editor("Review", text);
      void pending.catch(() => {});
      const settled = vi.fn();
      void pending.then(settled, () => {});
      await s.opened();
      for (const [width, height] of [
        [1, 12],
        [2, 12],
        [40, 6],
        [100, 30],
        [40, 12],
      ]) {
        s.resize(width, height);
        const frame = s.frame().join("\n");
        if (width < 12 || height < 8) {
          s.key("\r");
          await Promise.resolve();
          expect(settled).not.toHaveBeenCalled();
          expect(s.tui.hasOverlay()).toBe(true);
        } else {
          expect(plain(frame)).toContain("last line 中文😀");
          expect(frame).toMatch(inverseCell);
        }
      }
      // Native Emacs movement and insertion still work after resize.
      s.key("\x01"); // Ctrl+A
      s.key("注");
      expect(plain(s.frame().join("\n"))).toContain("注last line 中文😀");
      s.key("\x05"); // Ctrl+E
      s.key("\r");
      expect(await pending).toBe(text.replace("last line", "注last line"));
    } finally {
      await s.cleanup();
    }
  });

  test(`${mode} large bracketed paste is immediately expanded for review, with every line reachable`, async () => {
    const s = await screen(mode, 40, 12);
    try {
      const pending = s.ui.editor("Review paste");
      void pending.catch(() => {});
      const settled = vi.fn();
      void pending.then(settled, () => {});
      await s.opened();
      s.key(`\x1b[200~${prefill.slice(0, 30)}`);
      s.frame(); // incomplete paste remains in SafeInput's buffer
      s.key(`${prefill.slice(30)}\x1b[201~`);
      expect(plain(s.frame().join("\n"))).not.toContain("[paste #");
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      expect(plain(s.frame().join("\n"))).toContain("line-34 中文");
      const seen = new Set<string>();
      for (let i = 0; i < 40; i++) {
        for (const match of plain(s.frame().join("\n")).matchAll(/line-\d{2}/gu)) seen.add(match[0]);
        s.key("\x1b[A");
      }
      expect(seen.size).toBe(35);
      s.key("\r");
      expect(await pending).toBe(prefill);
    } finally {
      await s.cleanup();
    }
  });

  test(`${mode} untrusted prefill, metadata, split paste and undo are plain before native rendering`, async () => {
    const s = await screen(mode, 40, 12);
    const editorRender = Editor.prototype.render;
    const inputRender = Input.prototype.render;
    const editorSpy = vi.spyOn(Editor.prototype, "render").mockImplementation(function (this: Editor, width) {
      expect(this.getExpandedText()).toBe(plain(this.getExpandedText()));
      return editorRender.call(this, width);
    });
    const inputSpy = vi.spyOn(Input.prototype, "render").mockImplementation(function (this: Input, width) {
      expect(this.getValue()).toBe(plain(this.getValue()));
      return inputRender.call(this, width);
    });
    const attack = `中\x1b[7mFAKE\x1b[0m\x1b[2J\x1b[3A\x1b]52;c;secret\x07\u202e\u009b2J${CURSOR_MARKER}\u0000`;
    const assertFrame = () => {
      const frame = s.frame().join("\n");
      expect(frame).toMatch(inverseCell);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: malicious terminal instructions must be absent
      expect(frame).not.toMatch(/\x1b\[(?:2J|3A)|\x1b\]52|[\u202e\u009b\u0000]/u);
      const raw = s.tui.getFocusedComponent()?.render(40).join("\n") ?? "";
      expect(raw.split(CURSOR_MARKER)).toHaveLength(2); // only the real IME cursor
      expect(
        raw
          .replaceAll(CURSOR_MARKER, "")
          // biome-ignore lint/suspicious/noControlCharactersInRegex: only these renderer-owned cursor styles are allowed
          .replace(/\x1b\[(?:0|7|27)m/gu, "")
          .replaceAll("\n", ""),
      ).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    };
    try {
      const pending = s.ui.editor(attack, `prefill ${attack}`);
      void pending.catch(() => {});
      await s.opened();
      assertFrame();
      s.key(`\x1b[200~paste ${attack.slice(0, 10)}`);
      s.frame();
      s.key(`${attack.slice(10)}\x1b[201~`);
      assertFrame();
      s.key("\x1f"); // native undo
      assertFrame();
      s.key("\x1b");
      expect(await pending).toBeUndefined();
      const pick = s.ui.pick(async (publish) => {
        const rows = [{ ...sessions[0], name: attack, cwd: attack }];
        publish(rows, 1, 1, true);
        return rows;
      });
      void pick.catch(() => {});
      await s.opened();
      assertFrame();
      s.key(`\x1b[200~${attack.slice(0, 13)}`);
      s.frame();
      s.key(`${attack.slice(13)}\x1b[201~`);
      assertFrame();
      s.key("\x1f");
      assertFrame();
      s.key("\x1b");
      expect(await pick).toBeUndefined();
      expect(editorSpy).toHaveBeenCalled();
      expect(inputSpy).toHaveBeenCalled();
    } finally {
      editorSpy.mockRestore();
      inputSpy.mockRestore();
      await s.cleanup();
    }
  });

  test(`${mode} long confirmation preview scrolls to tail without hiding choices or controls`, async () => {
    const s = await screen(mode, 40, 12);
    try {
      const pending = s.ui.confirm("Confirm", `${prefill}\nEND OF PREVIEW`);
      void pending.catch(() => {});
      await s.opened();
      for (const [width, height] of [
        [40, 12],
        [100, 30],
        [40, 12],
      ]) {
        s.resize(width, height);
        for (let i = 0; i < 40; i++) {
          s.frame();
          s.key("\x1b[6~");
        }
        const frame = plain(s.frame().join("\n"));
        expect(frame).toContain("END OF PREVIEW");
        expect(frame).toContain("No");
        expect(frame).toContain("Yes");
        expect(frame).toMatch(/cancel/i);
      }
      s.key("\x1b[B");
      s.key("\r");
      expect(await pending).toBe(true);
    } finally {
      await s.cleanup();
    }
  });

  test(`${mode} expanded large paste Undo retains nonempty document and earlier edits`, async () => {
    const s = await screen(mode, 40, 12);
    try {
      const pending = s.ui.editor("Review Undo history", "original");
      void pending.catch(() => {});
      await s.opened();
      s.frame();
      s.key(" earlier");
      s.key(`\x1b[200~${"X".repeat(1100)}\x1b[201~`);
      s.frame();
      // Expansion is either immediate, or requires a non-destructive review step.
      if (plain(s.frame().join("\n")).includes("expand paste")) s.key("\r");
      s.key("\x1f");
      const restored = plain(s.frame().join("\n"));
      expect(restored).toContain("original earlier");
      expect(restored).not.toContain("XXXX");
      s.key("\x1f");
      expect(plain(s.frame().join("\n"))).toContain("original");
      s.key("\r");
      expect(await pending).toBe("original");
    } finally {
      await s.cleanup();
    }
  });

  test(`${mode} remapped selection actions govern choice and picker without default acceptance`, async () => {
    const previousKeys = getKeybindings();
    const s = await screen(mode, 80, 24);
    setKeybindings(
      new KeybindingsManager(TUI_KEYBINDINGS, {
        "tui.select.confirm": "ctrl+y",
        "tui.select.cancel": "ctrl+x",
        "tui.select.up": "ctrl+k",
        "tui.select.down": "ctrl+j",
        "tui.select.pageUp": "ctrl+u",
        "tui.select.pageDown": "ctrl+d",
      }),
    );
    try {
      const load = async (publish: (rows: SessionRow[], loaded: number, total: number, complete: boolean) => void) => {
        publish(sessions, sessions.length, sessions.length, true);
        return sessions;
      };
      for (const kind of ["choice", "picker"] as const) {
        const pending = kind === "choice" ? s.ui.confirm("Confirm", prefill) : s.ui.pick(load);
        void pending.catch(() => {});
        const settled = vi.fn();
        void pending.then(settled, () => {});
        await s.opened();
        await vi.waitFor(() => expect(plain(s.frame().join("\n"))).toContain("ctrl+y"));
        expect(plain(s.frame().join("\n"))).toContain("ctrl+x");
        for (const key of ["\r", "\x1b", "\x1b[B"]) s.key(key);
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(settled).not.toHaveBeenCalled();
        s.key("\x0a"); // configured down, not a submit
        s.key("\x0b"); // configured up returns to No/first row
        s.key("\x0a");
        s.key("\x04"); // configured page down scrolls preview/moves picker
        s.key("\x15"); // configured page up restores selection
        s.frame();
        s.frame();
        s.key("\x19");
        expect(await pending).toEqual(kind === "choice" ? true : sessions[1]);
        const cancelled = kind === "choice" ? s.ui.confirm("Cancel", "prompt") : s.ui.pick(load);
        void cancelled.catch(() => {});
        await s.opened();
        s.key("\x18");
        expect(await cancelled).toBe(kind === "choice" ? false : undefined);
      }
    } finally {
      setKeybindings(previousKeys);
      await s.cleanup();
    }
  });
}
