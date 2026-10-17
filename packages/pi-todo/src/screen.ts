import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { commandCharacter, DraftInput } from "./draft-input.js";
import type { Snapshot } from "./state.js";
import { columns, display, SourceViewport } from "./ui.js";

export { display } from "./ui.js";
export type ViewAction = { action: "add" | "edit" | "status" | "remove" | "clear"; id?: string } | undefined;
const HELP = [
  "Session Todo help",
  "Up/Down: select a task or scroll details/help.",
  "PgUp/PgDn: page. Home/End: first/last.",
  "n/p: scroll details/help one row (works at width 1).",
  "Enter: inspect/back. All ID, status, title, description and dependencies are scrollable in details.",
  "a: add. e: edit. s: status (pending reopens).",
  "d: remove selected task. D: clear checklist.",
  "Destructive actions need distinct y confirmation; repeating d/D cancels.",
  "Esc: back/close. Ctrl+C: close. No model turn.",
  "?: help/back. Resize reflows from the same source position.",
  "? substitutes a glyph wider than the viewport; resize restores the original glyph.",
].join("\n");
export class TodoScreen implements Component {
  focused = false;
  selectedId?: string;
  private detail = false;
  private help = false;
  private readonly details = new SourceViewport();
  private readonly helpView = new SourceViewport();
  private readonly confirmView = new SourceViewport();
  private confirmation?: "remove" | "clear";
  private closed = false;
  private capacity = 1;
  private readonly commands = new DraftInput(display, (data, paste) => {
    // Consume complete AND split bracketed pastes without invoking commands.
    if (!paste) this.handleKey(data);
  });
  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly snapshot: Snapshot,
    selectedId: string | undefined,
    private readonly done: (action: ViewAction) => void,
  ) {
    this.selectedId = snapshot.tasks.some((task) => task.id === selectedId) ? selectedId : snapshot.tasks[0]?.id;
  }
  close(action?: ViewAction) {
    if (this.closed) return;
    this.dispose();
    this.done(action);
  }
  dispose() {
    this.closed = true;
    this.commands.dispose();
  }
  invalidate() {}
  handleInput(data: string) {
    this.commands.handleInput(data);
  }
  private handleKey(data: string) {
    if (this.closed) return;
    const char = commandCharacter(data);
    if (matchesKey(data, "ctrl+c")) this.close();
    else if (matchesKey(data, "escape")) {
      if (this.confirmation) this.confirmation = undefined;
      else if (this.help) this.help = false;
      else if (this.detail) this.detail = false;
      else this.close();
    } else if (this.confirmation) {
      if (!this.confirmView.navigate(data)) {
        // Repeating d/D never confirms. A distinct y is required.
        const action = this.confirmation;
        this.confirmation = undefined;
        if (char === "y") this.close({ action, id: this.selectedId });
      }
    } else if (char === "?") {
      this.help = !this.help;
      this.helpView.reset();
    } else if (this.help) this.helpView.navigate(data);
    else if (char === "d" && this.selectedId) {
      this.confirmation = "remove";
      this.confirmView.reset();
    } else if (char === "D") {
      this.confirmation = "clear";
      this.confirmView.reset();
    } else if (char === "a") this.close({ action: "add" });
    else if (char === "e" && this.selectedId) this.close({ action: "edit", id: this.selectedId });
    else if (char === "s" && this.selectedId) this.close({ action: "status", id: this.selectedId });
    else if (matchesKey(data, "return")) {
      this.detail = !this.detail;
      this.details.reset();
    } else if (this.detail) this.details.navigate(data);
    else {
      let index = this.snapshot.tasks.findIndex((task) => task.id === this.selectedId);
      if (matchesKey(data, "up")) index--;
      else if (matchesKey(data, "down")) index++;
      else if (matchesKey(data, "pageUp")) index -= this.capacity;
      else if (matchesKey(data, "pageDown")) index += this.capacity;
      else if (matchesKey(data, "home")) index = 0;
      else if (matchesKey(data, "end")) index = this.snapshot.tasks.length - 1;
      this.selectedId = this.snapshot.tasks[Math.max(0, Math.min(index, this.snapshot.tasks.length - 1))]?.id;
    }
    this.tui.requestRender();
  }
  render(width: number): string[] {
    const height = Math.max(1, this.tui.terminal.rows);
    const w = Math.max(1, width);
    // All narrow-width help and confirmation text is pageable, not clipped footer suffixes.
    if (this.confirmation)
      return this.confirmView.render(
        `${this.confirmation}\ny: confirm\nEsc/other: cancel\nUp/Down or p/n: scroll`,
        w,
        height,
      );
    if (this.help) return this.helpView.render(HELP, w, height);
    const task = this.snapshot.tasks.find((task) => task.id === this.selectedId);
    const completed = this.snapshot.tasks.filter((task) => task.status === "completed").length;
    const header =
      w >= 24 && height >= 8
        ? [
            `Session Todo r${this.snapshot.revision}`,
            `${completed}/${this.snapshot.tasks.length} completed | ${this.detail ? "Item details" : "Current branch"}`,
          ].flatMap((line) => columns(line, w).map((row) => this.theme.fg("accent", row.text)))
        : [];
    const controls = columns(
      `Up/Down PgUp/PgDn Home/End: ${this.detail ? "scroll" : "select"}\nEnter: inspect | ?: help | Esc: close\na:add e:edit s:status/reopen\nd:remove D:clear`,
      w,
    ).map((row) => row.text);
    const footer =
      controls.length + header.length + 1 <= height && w >= 36 ? controls : w >= 12 ? ["?:help Esc"] : ["?"];
    this.capacity = Math.max(1, height - header.length - footer.length);
    let body: string[];
    if (this.detail && task) {
      const source = [
        `ID: ${task.id}`,
        `Status: ${task.status}`,
        `Title: ${display(task.title)}`,
        `Description: ${display(task.description ?? "(no description)")}`,
        "Dependencies:",
        ...task.dependencies.map(
          (id) => `${id}\n${display(this.snapshot.tasks.find((item) => item.id === id)?.title ?? "missing")}`,
        ),
      ].join("\n");
      body = this.details.render(source, w, this.capacity);
    } else {
      const index = this.snapshot.tasks.findIndex((task) => task.id === this.selectedId);
      const start = Math.max(
        0,
        Math.min(index - Math.floor(this.capacity / 2), this.snapshot.tasks.length - this.capacity),
      );
      body = this.snapshot.tasks.slice(start, start + this.capacity).map((item) => {
        const label = `${item.id === this.selectedId ? ">" : " "} [${item.status}] ${display(item.title).replaceAll("\n", " ")} (${item.dependencies.length} deps)`;
        const preview = truncateToWidth(label, w, "…");
        return item.id === this.selectedId ? this.theme.fg("accent", preview) : preview;
      });
      if (!this.snapshot.tasks.length)
        body = columns("Empty checklist. a: add a session task. ?: help.", w)
          .slice(0, this.capacity)
          .map((row) => row.text);
    }
    const lines = [...header, ...body];
    while (lines.length < height - footer.length) lines.push("");
    lines.push(...footer);
    return lines.slice(0, height).map((line) => truncateToWidth(line, w, ""));
  }
}
