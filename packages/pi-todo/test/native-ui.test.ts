import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { OwnedOverlay } from "../src/ui.js";
import { nativeTerminal } from "./native-terminal.js";

for (const fullscreen of [true, false])
  describe(`SDK 1.0.4 native ${fullscreen ? "fullscreen" : "regular"} UI`, () => {
    it("runs Kitty encoded character commands, confirmation and p/n scrolling without accepting modified keys or paste", async () => {
      const f = await nativeTerminal(fullscreen);
      let running: Promise<void> | undefined;
      const kitty = (char: string) => `\x1b[${char.codePointAt(0)}u`;
      try {
        running = f.command.run(f.ctx);
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
        f.key(kitty("a"));
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
        f.key("Encoded task");
        f.key("\x13");
        await vi.waitFor(() => expect(f.store.read(f.ctx).revision).toBe(1));
        for (const data of [
          "\x1b[97;2u",
          "\x1b[97;3u",
          "\x1b[97;5u",
          "\x1b[97;9u",
          "\x1b[65;2u",
          "\x1b[200~a\x1b[201~",
        ])
          f.key(data);
        for (const chunk of ["\x1b[20", "0~", "a", "\x1b[20", "1~"]) f.key(chunk);
        expect(f.lines().join("\n")).toContain("Session Todo");
        f.key(kitty("e"));
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
        f.key(" edited");
        f.key("\x13");
        await vi.waitFor(() => expect(f.store.read(f.ctx).revision).toBe(2));
        expect(f.store.read(f.ctx).tasks[0].title).toBe("Encoded task edited");
        f.key(kitty("s"));
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task status"));
        f.resize(1, 12);
        const statusTop = f.lines();
        f.key(kitty("n"));
        expect(f.lines()).not.toEqual(statusTop);
        f.key(kitty("p"));
        expect(f.lines()).toEqual(statusTop);
        for (const chunk of ["\x1b[200~", "n", "\r", "\x1b[201~"]) f.key(chunk);
        expect(f.lines()).toEqual(statusTop);
        expect(f.store.read(f.ctx).revision).toBe(2);
        f.resize(80, 24);
        f.key("\x1b[B");
        f.key("\r");
        await vi.waitFor(() => expect(f.store.read(f.ctx).tasks[0].status).toBe("in_progress"));
        f.key("\x1b[47:63;2u"); // Shift+/ reports '?' through the public decoder.
        expect(f.lines().join("\n")).toContain("Session Todo help");
        f.resize(1, 12);
        const top = f.lines();
        f.key(kitty("n"));
        expect(f.lines()).not.toEqual(top);
        f.key(kitty("p"));
        expect(f.lines()).toEqual(top);
        for (const data of ["\x1b[110;2u", "\x1b[110;3u", "\x1b[110;5u", "\x1b[110;9u", "\x1b[200~n\x1b[201~"])
          f.key(data);
        for (const chunk of ["\x1b[200~", "n", "\x1b[201~"]) f.key(chunk);
        expect(f.lines()).toEqual(top);
        f.key(kitty("?"));
        f.resize(80, 24);
        f.key(kitty("d"));
        expect(f.lines().join("\n")).toContain("y: confirm");
        f.key("\x1b[121;5u"); // Modified y cancels but never confirms.
        f.key(kitty("y"));
        expect(f.store.read(f.ctx).revision).toBe(3);
        f.key(kitty("d"));
        f.key(kitty("y"));
        await vi.waitFor(() => expect(f.store.read(f.ctx)).toMatchObject({ revision: 4, tasks: [] }));
        f.key(kitty("a"));
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
        f.key("Clear target");
        f.key("\x13");
        await vi.waitFor(() => expect(f.store.read(f.ctx).revision).toBe(5));
        f.key(fullscreen ? "\x1b[100:68;2u" : "\x1b[100;2u"); // Preserve Shift+d as D with/without shifted keycode.
        expect(
          f
            .lines()
            .map((line) => stripTerminalSequences(line).trimEnd())
            .join("\n"),
        ).toContain("clear\ny: confirm");
        f.resize(1, 12);
        const confirmation = f.lines();
        f.key(kitty("n"));
        expect(f.lines()).not.toEqual(confirmation);
        f.key(kitty("p"));
        expect(f.lines()).toEqual(confirmation);
        f.key("\x1b[200~y\x1b[201~");
        for (const chunk of ["\x1b[200~", "y", "\x1b[201~"]) f.key(chunk);
        expect(f.store.read(f.ctx).revision).toBe(5);
        f.key(kitty("y"));
        await vi.waitFor(() => expect(f.store.read(f.ctx)).toMatchObject({ revision: 6, tasks: [] }));
        f.key("\x1b");
        await running;
        expect(f.session.messages).toEqual([]);
        expect(f.session.getActiveToolNames()).toEqual([]);
      } finally {
        f.command.retire();
        await running;
        await f.dispose();
      }
    });
    it("preserves actual edit values on three unchanged Enters, not mocked placeholder responses", async () => {
      const f = await nativeTerminal(fullscreen);
      try {
        f.store.mutate(f.ctx, { action: "add", baseRevision: 0, title: "Prerequisite", status: "completed" });
        const first = f.store.read(f.ctx).tasks[0];
        f.store.mutate(f.ctx, {
          action: "add",
          baseRevision: 1,
          title: "中文 existing",
          description: "Keep description",
          dependencies: [first.id],
        });
        const original = f.store.read(f.ctx);
        const view = f.command.run(f.ctx);
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
        f.key("\x1b[F");
        f.key("e");
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
        f.record("actual-values-edit-screen", f.lines());
        expect(f.lines().join("\n")).toContain("中文 existing");
        f.key("\r");
        await new Promise<void>((r) => setImmediate(r));
        f.key("\r");
        await new Promise<void>((r) => setImmediate(r));
        f.key("\r");
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
        expect(f.store.read(f.ctx)).toEqual(original);
        f.key("\x1b[H");
        f.key("e");
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
        f.key("\r");
        f.key("\r");
        f.key("\r");
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
        expect(f.store.read(f.ctx)).toEqual(original); // Missing description stays absent, not an added empty field.
        f.key("\x1b");
        await view;
      } finally {
        await f.dispose();
      }
    });

    it("keeps a native CJK input cursor, preserves multiline description, and clears description/dependencies only explicitly", async () => {
      const f = await nativeTerminal(fullscreen);
      try {
        f.resize(40, 12);
        f.store.mutate(f.ctx, { action: "add", baseRevision: 0, title: "Prerequisite", status: "completed" });
        const prerequisite = f.store.read(f.ctx).tasks[0].id;
        f.store.mutate(f.ctx, {
          action: "add",
          baseRevision: 1,
          title: "中文题",
          description: " first line\nsecond line  ",
          dependencies: [prerequisite],
        });
        const view = f.command.run(f.ctx);
        await vi.waitFor(() => expect(f.focus()).toBeInstanceOf(OwnedOverlay));
        const owner = f.focus();
        if (!(owner instanceof OwnedOverlay)) throw new Error("No owned overlay");
        expect(owner.getBounds()).toMatchObject({ width: 40, height: 12 });
        const chrome = f.lines().map(stripTerminalSequences).join("\n");
        for (const control of [
          "a:add",
          "e:edit",
          "s:status/reopen",
          "d:remove",
          "D:clear",
          "Enter: inspect",
          "Esc: close",
          "?: help",
        ])
          expect(chrome).toContain(control);
        expect(chrome).not.toContain("fixture"); // Native host footer is covered, not just component row bounds.
        f.record("40x12-all-controls-and-covered-native-chrome", f.lines());
        f.key("\x1b[F");
        f.key("e");
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
        f.key("\x1b[D");
        f.key("X");
        f.resize(1, 12);
        expect(f.lines().map(stripTerminalSequences).join("")).toContain("Resize to 16");
        f.record("width-1-responsive-form-message", f.lines());
        f.key("\x13"); // An unusably narrow form cannot submit invisibly.
        expect(f.store.read(f.ctx).revision).toBe(2);
        f.resize(40, 12);
        f.key("Y"); // The native wide-character cursor/draft survives reflow.
        f.key("\r");
        f.key("\r");
        f.key("\r");
        await vi.waitFor(() => expect(f.store.read(f.ctx).revision).toBe(3));
        expect(f.store.read(f.ctx).tasks[1]).toMatchObject({
          title: "中文XY题",
          description: " first line\nsecond line  ",
          dependencies: [prerequisite],
        });
        // Replace description via native multiline paste (no model/editor replacement).
        f.key("e");
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
        f.key("\r");
        // Native Editor starts at the end. Clear both lines using its public keyboard bindings.
        f.key("\x01");
        f.key("\x0b");
        f.key("\x7f");
        f.key("\x01");
        f.key("\x0b");
        f.key("\r");
        f.key("\x01");
        f.key("\x0b");
        f.key("\r");
        await vi.waitFor(() => expect(f.store.read(f.ctx).revision).toBe(4));
        expect(f.store.read(f.ctx).tasks[1]).toMatchObject({ description: "", dependencies: [] });
        f.key("\x1b");
        await view;
        expect(f.session.messages).toEqual([]);
      } finally {
        await f.dispose();
      }
    });

    it("runs explicit native add/status/reopen/remove/clear controls with no model activation", async () => {
      const f = await nativeTerminal(fullscreen);
      try {
        f.resize(40, 12);
        const view = f.command.run(f.ctx);
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
        f.key("a");
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
        f.key("Human task");
        f.key("\r");
        f.key("Human description");
        f.key("\r");
        f.key("\r");
        await vi.waitFor(() => expect(f.store.read(f.ctx).revision).toBe(1));
        expect(f.store.read(f.ctx).tasks[0]).toMatchObject({ title: "Human task", description: "Human description" });
        for (const [i, status] of ["in_progress", "completed", "pending"].entries()) {
          f.key("s");
          await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task status"));
          f.key("\x1b[H");
          for (let down = 0; down < [1, 2, 0][i]; down++) f.key("\x1b[B");
          f.key("\r");
          await vi.waitFor(() => expect(f.store.read(f.ctx).revision).toBe(i + 2));
          expect(f.store.read(f.ctx).tasks[0].status).toBe(status);
        }
        f.key("d");
        f.key("d");
        f.key("y");
        expect(f.store.read(f.ctx).revision).toBe(4);
        f.key("d");
        expect(
          f
            .lines()
            .map((line) => stripTerminalSequences(line).trimEnd())
            .join("\n"),
        ).toContain("remove\n");
        expect(f.lines().map(stripTerminalSequences).join("\n")).toContain("y: confirm");
        f.key("y");
        await vi.waitFor(() => expect(f.store.read(f.ctx).revision).toBe(5));
        f.key("a");
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
        f.key("Human clear target");
        f.key("\x13");
        await vi.waitFor(() => expect(f.store.read(f.ctx).revision).toBe(6));
        f.key("D");
        f.key("y");
        await vi.waitFor(() => expect(f.store.read(f.ctx)).toMatchObject({ revision: 7, tasks: [] }));
        f.key("\x1b");
        await view;
        expect(f.session.messages).toEqual([]);
        expect(f.session.getActiveToolNames()).toEqual([]);
      } finally {
        await f.dispose();
      }
    });

    it("keeps every draft field after a dependency graph error and allows correction in the same native form", async () => {
      const f = await nativeTerminal(fullscreen);
      try {
        f.store.mutate(f.ctx, { action: "add", baseRevision: 0, title: "Prerequisite", status: "completed" });
        const prerequisite = f.store.read(f.ctx).tasks[0].id;
        const view = f.command.run(f.ctx);
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
        f.key("a");
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
        f.key("\x1b[200~Retained 中文 title\x1b[201~");
        f.key("\r");
        f.key("\x1b[200~Retained description\x1b[201~");
        f.key("\r");
        f.key("00000000-0000-4000-8000-000000000099");
        f.key("\r");
        expect(f.lines().map(stripTerminalSequences).join("\n")).toContain("Missing or self dependency");
        expect(f.store.read(f.ctx).revision).toBe(1);
        f.key("\r"); // Return to the same dependency draft, not the checklist.
        f.key("\x01");
        f.key("\x0b");
        f.key(prerequisite);
        f.key("\r");
        await vi.waitFor(() => expect(f.store.read(f.ctx).revision).toBe(2));
        expect(f.store.read(f.ctx).tasks[1]).toMatchObject({
          title: "Retained 中文 title",
          description: "Retained description",
          dependencies: [prerequisite],
        });
        f.key("\x1b");
        await view;
        expect(f.session.messages).toEqual([]);
      } finally {
        await f.dispose();
      }
    });

    it("does not steal foreign focus or overwrite a root draft changed during the native bridge await", async () => {
      const f = await nativeTerminal(fullscreen);
      try {
        f.key("\x1b[200~root中文draft\x1b[201~");
        f.key("\x1b[D");
        f.key("\x1b[D");
        const root = f.focus();
        const draftRace = f.command.run(f.ctx);
        f.key("X"); // Real user input while the non-capturing bridge is awaiting mount/completion.
        await draftRace;
        expect(f.ctx.ui.getEditorText()).toBe("root中文draXft");
        expect(f.focus()).toBe(root);
        expect(f.tui.hasOverlay()).toBe(false);
        const focusRace = f.command.run(f.ctx);
        const b = f.ctx.ui.select("Foreign race B", ["accepted"]);
        const ownerB = f.focus();
        await focusRace;
        expect(f.focus()).toBe(ownerB);
        expect(f.lines().map(stripTerminalSequences).join("\n")).toContain("Foreign race B");
        f.key("\r");
        expect(await b).toBe("accepted");
        expect(f.focus()).toBe(root);
        expect(f.ctx.ui.getEditorText()).toBe("root中文draXft");
        expect(f.session.messages).toEqual([]);
      } finally {
        await f.dispose();
      }
    });

    for (const foreign of ["none", "overlay", "dialog"] as const)
      it(`retires a pending form promptly on public authority append without lifecycle events under ${foreign}`, async () => {
        const f = await nativeTerminal(fullscreen);
        try {
          f.key("\x1b[200~root中文draft\x1b[201~");
          f.key("\x1b[D");
          f.key("\x1b[D");
          const root = f.focus();
          const view = f.command.run(f.ctx);
          let settled = false;
          void view.then(() => {
            settled = true;
          });
          await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
          f.key("a");
          await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
          f.key("Unsubmitted stale task");
          const owner = f.focus();
          if (!(owner instanceof OwnedOverlay)) throw new Error("No pending owned form");
          const b =
            foreign === "none"
              ? undefined
              : foreign === "overlay"
                ? f.ctx.ui.custom<string>(
                    (_tui, _theme, _keys, done) => ({
                      render: () => ["Foreign B: press Enter"],
                      invalidate() {},
                      handleInput(data) {
                        if (data === "\r") done("B accepted");
                      },
                    }),
                    { overlay: true },
                  )
                : f.ctx.ui.select("Foreign B: choose", ["B accepted", "B rejected"]);
          await new Promise<void>((resolve) => setImmediate(resolve));
          const focus = f.focus();
          f.record(`authority-${foreign}-before`, f.lines());
          f.api.appendEntry("pi-todo:state", { schemaVersion: 1, revision: 99, tasks: [] });
          // No close key, store reconciliation, or lifecycle event may be required.
          await vi.waitFor(() => expect(settled).toBe(true), { timeout: 600, interval: 10 });
          await view;
          expect(owner.getBounds()).toBeUndefined();
          owner.handleInput("LATE_MUST_NOT_COMMIT");
          owner.handleInput("\x13");
          expect(f.session.sessionManager.getBranch().at(-1)).toMatchObject({
            customType: "pi-todo:state",
            data: { revision: 99, tasks: [] },
          });
          f.record(`authority-${foreign}-after`, f.lines());
          if (b) {
            expect(f.focus()).toBe(focus);
            expect(f.lines().join("\n")).toContain("Foreign B");
            f.key("\r");
            expect(await b).toBe("B accepted");
          }
          expect(f.focus()).toBe(root);
          expect(f.tui.hasOverlay()).toBe(false);
          expect(f.ctx.ui.getEditorText()).toBe("root中文draft");
          f.key("X");
          expect(f.ctx.ui.getEditorText()).toBe("root中文draXft");
          expect(f.session.messages).toEqual([]);
        } finally {
          await f.dispose();
        }
      });

    for (const retirement of ["revision", "generation", "branch", "session", "manager", "draft"] as const)
      it(`monitors native ${retirement} retirement while a form is pending`, async () => {
        const f = await nativeTerminal(fullscreen);
        try {
          if (retirement === "branch") f.api.appendEntry("ordinary", {});
          const context = { ...f.ctx };
          const view = f.command.run(context);
          let settled = false;
          void view.then(() => {
            settled = true;
          });
          await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
          f.key("a");
          await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
          const owner = f.focus();
          if (!(owner instanceof OwnedOverlay)) throw new Error("No pending form");
          if (retirement === "revision")
            f.store.mutate(f.ctx, { action: "add", baseRevision: 0, title: "Concurrent task" });
          else if (retirement === "generation") f.store.retire();
          else if (retirement === "branch") f.session.sessionManager.resetLeaf();
          else if (retirement === "session") f.session.sessionManager.newSession();
          else if (retirement === "manager") context.sessionManager = SessionManager.inMemory();
          else f.ctx.ui.setEditorText("Replacement root draft");
          await vi.waitFor(() => expect(settled).toBe(true), { timeout: 600, interval: 10 });
          await view;
          expect(owner.getBounds()).toBeUndefined();
          expect(f.tui.hasOverlay()).toBe(false);
          if (retirement === "draft") expect(f.ctx.ui.getEditorText()).toBe("Replacement root draft");
          expect(f.session.messages).toEqual([]);
        } finally {
          await f.dispose();
        }
      });

    it("does not reread persistence on liveness ticks or retire for an ordinary native append", async () => {
      const f = await nativeTerminal(fullscreen);
      try {
        const view = f.command.run(f.ctx);
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
        f.key("a");
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
        const owner = f.focus();
        const reads = vi.spyOn(f.store, "read");
        const assertions = vi.spyOn(f.store, "assert");
        f.api.appendEntry("ordinary", { harmless: true });
        await new Promise<void>((resolve) => setTimeout(resolve, 320));
        expect(assertions.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(reads).not.toHaveBeenCalled();
        expect(f.focus()).toBe(owner);
        expect(f.lines().join("\n")).toContain("Task title");
        f.command.retire();
        await view;
        const count = assertions.mock.calls.length;
        await new Promise<void>((resolve) => setTimeout(resolve, 170));
        expect(assertions).toHaveBeenCalledTimes(count);
        expect(f.tui.hasOverlay()).toBe(false);
      } finally {
        await f.dispose();
      }
    });

    it("rejects an awaited stale draft revision without writes or a model turn", async () => {
      const f = await nativeTerminal(fullscreen);
      try {
        const view = f.command.run(f.ctx);
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
        f.key("a");
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
        f.key("Stale title");
        f.store.mutate(f.ctx, { action: "add", baseRevision: 0, title: "Concurrent human task" });
        f.key("\x13");
        await view;
        expect(f.store.read(f.ctx)).toMatchObject({ revision: 1, tasks: [{ title: "Concurrent human task" }] });
        expect(f.tui.hasOverlay()).toBe(false);
        expect(f.session.messages).toEqual([]);
      } finally {
        await f.dispose();
      }
    });

    for (const phase of ["screen", "pending form"] as const)
      for (const foreign of ["overlay", "dialog"] as const)
        it(`retires ${phase} by handle without removing a native foreign ${foreign}, resolves immediately and restores root cursor only after B`, async () => {
          const f = await nativeTerminal(fullscreen);
          try {
            f.key("\x1b[200~root中文draft\x1b[201~");
            f.key("\x1b[D");
            f.key("\x1b[D");
            const root = f.focus();
            const originalText = f.ctx.ui.getEditorText();
            const view = f.command.run(f.ctx);
            let settled = false;
            void view.then(() => {
              settled = true;
            });
            await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
            if (phase === "pending form") {
              f.key("a");
              await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
              f.key("Unsubmitted owned input");
            }
            const b =
              foreign === "overlay"
                ? f.ctx.ui.custom<string>(
                    (_tui, _theme, _keys, done) => ({
                      render: () => ["Foreign B: press Enter"],
                      invalidate() {},
                      handleInput(data) {
                        if (data === "\r") done("B accepted");
                      },
                    }),
                    { overlay: true },
                  )
                : f.ctx.ui.select("Foreign B: choose", ["B accepted", "B rejected"]);
            await vi.waitFor(() => expect(f.focus()).not.toBe(root));
            await new Promise<void>((r) => setImmediate(r));
            const ownerB = f.focus();
            f.record(`${phase}-foreign-${foreign}-before-retirement`, f.lines());
            f.command.retire();
            await new Promise<void>((r) => setImmediate(r));
            f.record(`${phase}-foreign-${foreign}-after-retirement`, f.lines());
            expect(f.focus()).toBe(ownerB);
            expect(settled).toBe(true);
            expect(f.lines().join("\n")).toContain("Foreign B");
            f.key("\r");
            expect(await b).toBe("B accepted");
            await vi.waitFor(() => expect(settled).toBe(true));
            expect(f.focus()).toBe(root);
            expect(f.tui.hasOverlay()).toBe(false);
            expect(f.ctx.ui.getEditorText()).toBe(originalText);
            f.key("X");
            expect(f.ctx.ui.getEditorText()).toBe("root中文draXft");
            f.record(`${phase}-foreign-${foreign}-closed-root-CJK-cursor-preserved`, f.lines());
            expect(f.session.messages).toEqual([]);
          } finally {
            await f.dispose();
          }
        });

    it("aborts an owned pending native form under a later passive overlay without popping it", async () => {
      const f = await nativeTerminal(fullscreen);
      try {
        const root = f.focus();
        const view = f.command.run(f.ctx);
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
        f.key("a");
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
        f.key("Unsubmitted draft");
        // B is deliberately non-capturing: focused === Todo does NOT mean Todo is last on the stack.
        const handle = f.tui.showOverlay(
          { render: () => ["Passive foreign B"], invalidate() {} },
          { nonCapturing: true, width: 30 },
        );
        f.tui.renderNow();
        f.command.retire();
        await view;
        expect(f.focus()).toBe(root);
        expect(handle.getBounds()).toBeDefined();
        expect(f.lines().map(stripTerminalSequences).join("\n")).toContain("Passive foreign B");
        expect(f.store.read(f.ctx).tasks).toEqual([]);
        handle.hide();
        expect(f.tui.hasOverlay()).toBe(false);
      } finally {
        await f.dispose();
      }
    });

    it("disposes a pending native form and settles on actual host shutdown without a model turn", async () => {
      const f = await nativeTerminal(fullscreen);
      try {
        const view = f.command.run(f.ctx);
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
        f.key("a");
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
        f.key("Unsubmitted shutdown draft");
        const owner = f.focus();
        if (!(owner instanceof OwnedOverlay)) throw new Error("No pending owned form");
        const b = f.tui.showOverlay({ render: () => ["Foreign B"], invalidate() {} }, { width: 30 });
        await f.shutdown();
        await view;
        expect(owner.getBounds()).toBeUndefined();
        expect(f.tui.hasOverlay()).toBe(false);
        expect(f.session.messages).toEqual([]);
        b.hide(); // Already detached by the native host, not by Todo's retirement.
      } finally {
        await f.dispose();
      }
    });

    it("keeps bounds and reachable contents in real native chrome through 40x12, width 1 and 100x30 resize", async () => {
      const f = await nativeTerminal(fullscreen);
      try {
        f.store.mutate(f.ctx, { action: "add", baseRevision: 0, title: "界", description: "界" });
        const id = f.store.read(f.ctx).tasks[0].id;
        const view = f.command.run(f.ctx);
        await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
        for (const [width, height] of [
          [40, 12],
          [1, 12],
          [100, 30],
        ]) {
          f.resize(width, height);
          const owner = f.focus();
          if (!(owner instanceof OwnedOverlay)) throw new Error("Todo lost focus");
          expect(owner.getBounds()).toMatchObject({ width, height });
          expect(f.lines()).toHaveLength(height);
          expect(f.lines().every((line) => visibleWidth(line) <= width)).toBe(true);
        }
        f.resize(1, 12);
        f.key("\r");
        const observed: string[] = [];
        for (let i = 0; i < 120; i++) {
          observed.push(stripTerminalSequences(f.lines()[0]).trimEnd());
          f.key("n");
        }
        const contents = observed.join("");
        expect(contents).toContain(id);
        expect(contents).toContain("pending");
        expect(contents).toContain("?"); // Explicit oversized-grapheme fallback, not a blank dropped CJK glyph.
        f.key("?");
        f.key("\x1b[F");
        const help = f.lines().map(stripTerminalSequences).join("");
        expect(help).not.toContain("界");
        f.key("?");
        f.key("\x1b[H");
        f.resize(100, 30);
        expect(f.lines().map(stripTerminalSequences).join("\n")).toContain("Description: 界");
        f.key("\x1b");
        f.key("\x1b");
        await view;
      } finally {
        await f.dispose();
      }
    });
  });
