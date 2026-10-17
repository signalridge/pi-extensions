import { randomUUID } from "node:crypto";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { TodoScreen, type ViewAction } from "../src/screen.js";
import { type Snapshot, validateSnapshot } from "../src/state.js";
import { columns } from "../src/ui.js";
import { terminalFixture } from "./terminal.js";

for (const fullscreen of [true, false])
  describe(`40-item screen on native ${fullscreen ? "fullscreen" : "regular"} chrome`, () => {
    it("uses stable IDs with all navigation keys and scrolls a full description plus 16 dependency labels", async () => {
      const native = terminalFixture(fullscreen);
      native.resize(40, 12);
      const state: Snapshot = {
        schemaVersion: 1,
        revision: 17,
        tasks: Array.from({ length: 40 }, (_, index) => ({
          id: randomUUID(),
          title: `Task ${index} 中文`,
          status: "completed",
          dependencies: [],
        })),
      };
      state.tasks[39].description = "界".repeat(512);
      state.tasks[39].dependencies = state.tasks.slice(0, 16).map((task) => task.id);
      const snapshot = validateSnapshot(state);
      let screen!: TodoScreen;
      const completed = native.ui.custom<ViewAction>(
        (tui, theme, _keys, done) => {
          screen = new TodoScreen(tui, theme, snapshot, undefined, done);
          return screen;
        },
        { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "top-left" } },
      );
      try {
        await vi.waitFor(() => expect(native.active()).toBeDefined());
        expect(screen.selectedId).toBe(state.tasks[0].id);
        native.key("\x1b[B");
        expect(screen.selectedId).toBe(state.tasks[1].id);
        native.key("\x1b[6~");
        expect(screen.selectedId).toBe(state.tasks[7].id);
        native.key("\x1b[5~");
        expect(screen.selectedId).toBe(state.tasks[1].id);
        native.key("\x1b[A");
        expect(screen.selectedId).toBe(state.tasks[0].id);
        native.key("\x1b[F");
        expect(screen.selectedId).toBe(state.tasks[39].id);
        native.key("\r");
        native.key("\x1b[F");
        expect(screen.selectedId).toBe(state.tasks[39].id);
        expect(native.lines().join("\n")).toContain("Task 15 中文");
        native.key("\x1b[H");
        expect(native.lines().join("\n")).toContain(state.tasks[39].id);
        native.resize(1, 12);
        native.key("\x1b[6~");
        expect(native.lines().every((line) => visibleWidth(line) <= 1)).toBe(true);
        native.resize(100, 30);
        native.key("\x1b[F");
        expect(native.lines().join("\n")).toContain("Task 15 中文");
        native.key("\x1b");
        native.key("\x1b[H");
        expect(screen.selectedId).toBe(state.tasks[0].id);
        native.key("\x1b");
        expect(await completed).toBeUndefined();
        expect(native.tui.getFocusedComponent()).toBe(native.draft);
        expect(native.draft.getValue()).toBe("Keep this root draft");
        screen.handleInput("D");
        screen.handleInput("y"); // Retired component cannot invoke another action.
      } finally {
        native.dispose();
      }
    });

    it("reaches every selected field, 512-character description and all 16 full dependency IDs at widths 20 and 1", () => {
      const native = terminalFixture(fullscreen);
      try {
        const state: Snapshot = {
          schemaVersion: 1,
          revision: 9,
          tasks: Array.from({ length: 40 }, (_, index) => ({
            id: randomUUID(),
            title: `Task ${index} 中文`,
            status: "completed",
            dependencies: [],
          })),
        };
        state.tasks[39].description = `BEGIN${"界".repeat(503)}TAIL`;
        state.tasks[39].dependencies = state.tasks.slice(0, 16).map((task) => task.id);
        const task = state.tasks[39];
        const source = [
          `ID: ${task.id}`,
          `Status: ${task.status}`,
          `Title: ${task.title}`,
          `Description: ${task.description}`,
          "Dependencies:",
          ...task.dependencies.map((id) => `${id}\n${state.tasks.find((item) => item.id === id)?.title}`),
        ].join("\n");
        for (const width of [20, 1]) {
          native.resize(width, 12);
          const screen = new TodoScreen(native.tui, native.ui.theme, validateSnapshot(state), task.id, () => {});
          screen.handleInput("\r");
          const rowCount = columns(source, width).length;
          const firstRows: string[] = [];
          for (let i = 0; i < Math.max(0, rowCount - 11); i++) {
            firstRows.push(stripTerminalSequences(screen.render(width)[0]));
            screen.handleInput("\x1b[B");
          }
          firstRows.push(...screen.render(width).slice(0, 11).map(stripTerminalSequences));
          expect(firstRows.join("")).toBe(
            source
              .replaceAll("\n", "")
              .replaceAll("界", width === 1 ? "?" : "界")
              .replaceAll("中", width === 1 ? "?" : "中")
              .replaceAll("文", width === 1 ? "?" : "文"),
          );
          expect(screen.render(width).every((row) => visibleWidth(row) <= width)).toBe(true);
          screen.dispose();
        }
      } finally {
        native.dispose();
      }
    });

    it("shows all 40x12 controls, distinct destructive confirmation, and labeled paginated width-1 help", () => {
      const native = terminalFixture(fullscreen);
      try {
        native.resize(40, 12);
        const done = vi.fn();
        const state: Snapshot = {
          schemaVersion: 1,
          revision: 1,
          tasks: [{ id: randomUUID(), title: "界", status: "pending", dependencies: [] }],
        };
        const screen = new TodoScreen(native.tui, native.ui.theme, state, undefined, done);
        const contents = screen.render(40).map(stripTerminalSequences).join("\n");
        for (const action of [
          "a:add",
          "e:edit",
          "s:status/reopen",
          "d:remove",
          "D:clear",
          "Enter: inspect",
          "Esc: close",
          "?: help",
        ])
          expect(contents).toContain(action);
        screen.handleInput("d");
        expect(screen.render(40).join("\n")).toContain("remove\ny: confirm");
        screen.handleInput("d");
        screen.handleInput("y");
        expect(done).not.toHaveBeenCalled();
        native.resize(1, 12);
        screen.handleInput("?");
        let help = "";
        for (let i = 0; i < 1200; i++) {
          help += stripTerminalSequences(screen.render(1)[0]);
          screen.handleInput("n");
        }
        help += screen.render(1).join("");
        expect(help).toContain("? substitutes a glyph wider than the viewport");
        screen.handleInput("?");
        screen.handleInput("D");
        expect(screen.render(1).join("")).toContain("cleary");
        expect(screen.render(1).every((line) => visibleWidth(line) <= 1)).toBe(true);
        screen.handleInput("y");
        expect(done).toHaveBeenCalledExactlyOnceWith({ action: "clear", id: state.tasks[0].id });
      } finally {
        native.dispose();
      }
    });
  });
