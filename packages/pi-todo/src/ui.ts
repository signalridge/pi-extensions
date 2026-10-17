import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  Editor,
  type Focusable,
  getKeybindings,
  Input,
  matchesKey,
  type OverlayHandle,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { commandCharacter, DraftInput } from "./draft-input.js";
import type { NativeUI } from "./native-ui.js";
import type { Status, Task } from "./state.js";

/** User data is never interpreted as terminal instructions. Preserve line breaks for details. */
export function display(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/[\p{Bidi_Control}\p{Surrogate}]/gu, "")
    .replace(/[^\S\n]/gu, " ")
    .replace(/\p{Cc}/gu, (char) => (char === "\n" ? char : " "));
}
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export interface SourceRow {
  text: string;
  start: number;
}
/** Hard-wrap without losing spaces, UUID suffixes, or source positions on resize.
 * A grapheme wider than the entire viewport is represented by '?'; the original
 * source is retained and reappears at a sufficient width. Help labels this fallback.
 */
export function columns(source: string, width: number): SourceRow[] {
  const w = Math.max(1, width);
  const rows: SourceRow[] = [];
  let text = "";
  let start = 0;
  let size = 0;
  for (const part of segmenter.segment(source)) {
    if (part.segment === "\n") {
      rows.push({ text, start });
      text = "";
      size = 0;
      start = part.index + part.segment.length;
      continue;
    }
    const glyph = visibleWidth(part.segment) > w ? "?" : part.segment;
    const n = visibleWidth(glyph);
    if (size + n > w && text) {
      rows.push({ text, start });
      text = "";
      size = 0;
      start = part.index;
    }
    text += glyph;
    size += n;
  }
  rows.push({ text, start });
  return rows;
}
export class SourceViewport {
  private anchor = 0;
  private rows: SourceRow[] = [];
  private offset = 0;
  private capacity = 1;
  reset() {
    this.anchor = 0;
  }
  render(source: string, width: number, capacity: number): string[] {
    this.rows = columns(source, width);
    this.capacity = Math.max(1, capacity);
    this.offset = 0;
    for (let i = 0; i < this.rows.length && this.rows[i].start <= this.anchor; i++) this.offset = i;
    this.offset = Math.min(this.offset, this.maxOffset);
    return this.rows.slice(this.offset, this.offset + this.capacity).map((row) => row.text);
  }
  private get maxOffset() {
    return Math.max(0, this.rows.length - this.capacity);
  }
  navigate(data: string): boolean {
    const char = commandCharacter(data);
    let next = this.offset;
    if (matchesKey(data, "up") || char === "p") next--;
    else if (matchesKey(data, "down") || char === "n") next++;
    else if (matchesKey(data, "pageUp")) next -= this.capacity;
    else if (matchesKey(data, "pageDown")) next += this.capacity;
    else if (matchesKey(data, "home")) next = 0;
    else if (matchesKey(data, "end")) next = this.maxOffset;
    else return false;
    this.offset = Math.max(0, Math.min(next, this.maxOffset));
    this.anchor = this.rows[this.offset]?.start ?? 0;
    return true;
  }
}

/** Own a raw TUI overlay, NOT an overlay created by ui.custom(). Its public
 * handle can be removed specifically even under foreign overlays/dialogs; it
 * retargets native focus restoration without touching the main editor draft.
 * Abort disposes the draft and settles the promise synchronously on retirement.
 */
export class OwnedOverlay<T> implements Component, Focusable {
  private handle?: OverlayHandle;
  private finished = false;
  private _focused = false;
  constructor(
    private readonly tui: TUI,
    private readonly child: Component & Partial<Focusable> & { dispose?(): void },
    private readonly done: (result: T | undefined) => void,
    private readonly signal: AbortSignal,
  ) {
    signal.addEventListener("abort", this.abort, { once: true });
  }
  get focused() {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.child.focused = value;
  }
  bind(handle: OverlayHandle) {
    this.handle = handle;
    if (this.finished) handle.hide();
    else if (this.signal.aborted) this.close();
  }
  getBounds() {
    return this.handle?.getBounds();
  }
  ownsFocus() {
    return !this.finished && this._focused && !!this.handle?.isFocused();
  }
  private abort = () => {
    this.close();
  };
  close(result?: T) {
    if (this.finished) return;
    const value = !this.signal.aborted && this.ownsFocus() ? result : undefined;
    this.finished = true;
    this.signal.removeEventListener("abort", this.abort);
    try {
      // This is a raw showOverlay handle. Never hide a ui.custom-created handle.
      this.handle?.hide();
    } finally {
      try {
        this.child.dispose?.();
      } finally {
        this.done(value);
      }
    }
  }
  private useChild<R>(run: () => R): R {
    try {
      return run();
    } catch (error) {
      this.close();
      throw error;
    }
  }
  handleInput(data: string) {
    if (this.ownsFocus()) this.useChild(() => this.child.handleInput?.(data));
  }
  render(width: number) {
    // An ordinary native dialog replaces host editor chrome, not the overlay.
    // Leave it visible while it owns focus, without hiding or stealing focus.
    if (!this._focused || this.finished) return [];
    const height = Math.max(1, this.tui.terminal.rows);
    const lines = this.useChild(() => this.child.render(width)).slice(0, height);
    while (lines.length < height) lines.push("");
    return lines;
  }
  invalidate() {
    this.useChild(() => this.child.invalidate());
  }
  dispose() {
    this.close();
  }
}
export async function ownedUI<T>(
  host: NativeUI,
  signal: AbortSignal,
  guard: () => void,
  currentOwner: () => void,
  factory: (tui: TUI, theme: Theme, close: (value?: T) => void, ownsFocus: () => boolean) => Component,
): Promise<T | undefined> {
  signal.throwIfAborted();
  guard();
  host.checkFocus();
  const result = await new Promise<T | undefined>((resolve, reject) => {
    let owner: OwnedOverlay<T> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let settled = false;
    const finish = (value?: T) => {
      settled = true;
      clearInterval(timer);
      resolve(value);
    };
    const fail = (error: unknown) => {
      // Reject first so close's completion cannot turn a liveness error into success.
      reject(error);
      try {
        owner?.close();
      } catch {
        // Preserve the original rejected error even if child disposal also fails.
      } finally {
        settled = true;
        clearInterval(timer);
      }
    };
    try {
      const child = factory(
        host.tui,
        host.theme,
        (value) => owner?.close(value),
        () => owner?.ownsFocus() ?? false,
      );
      owner = new OwnedOverlay(host.tui, child, finish, signal);
      // A factory can synchronously retire the session or open a foreign dialog.
      signal.throwIfAborted();
      currentOwner();
      host.checkFocus();
      owner.bind(host.tui.showOverlay(owner, { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 }));
      if (!settled)
        timer = setInterval(() => {
          try {
            // Never poll the full persistence guard or require focus: foreign
            // dialogs may legitimately sit above this owned raw overlay.
            currentOwner();
          } catch (error) {
            fail(error);
          }
        }, 75);
    } catch (error) {
      fail(error);
    }
  });
  guard();
  host.checkFocus();
  return result;
}
export interface TaskDraft {
  title: string;
  description?: string;
  dependencies: string[];
}

/** Establish data without an undoable edit, then position through the public
 * pointer API. Neither remapped action keys nor a paste Undo entry are invoked.
 * Rendering a full-width preview makes the final blank cell a safe end target;
 * no terminal output or TUI focus change is performed here. */
function initializeInput(input: Input, value: string): void {
  input.setValue(value);
  const width = Math.max(4, visibleWidth(value) + 4);
  input.render(width);
  input.handleMouse({
    type: "press",
    button: "left",
    x: width - 1,
    y: 0,
    screenX: width - 1,
    screenY: 0,
    width,
    height: 1,
    shift: false,
    alt: false,
    ctrl: false,
  });
}
export class TaskForm implements Component, Focusable {
  private readonly title = new Input({ prompt: "" });
  private readonly description: Editor;
  private readonly dependencies = new Input({ prompt: "" });
  private readonly originalTitle?: string;
  private readonly normalizedTitle: string;
  private readonly originalDescription?: string;
  private readonly normalizedDescription: string;
  private readonly safeInput = new DraftInput(display, (data, paste) => this.handleSafeInput(data, paste));
  private field = 0;
  private error = "";
  private showingError = false;
  private _focused = false;
  private readonly message = new SourceViewport();
  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    task: Task | undefined,
    private readonly submit: (draft: TaskDraft) => void,
    private readonly cancel: () => void,
  ) {
    this.originalTitle = task?.title;
    this.normalizedTitle = display(task?.title ?? "").replace(/\n/gu, " ");
    initializeInput(this.title, this.normalizedTitle);
    initializeInput(this.dependencies, display(task?.dependencies.join(",") ?? ""));
    this.originalDescription = task?.description;
    this.description = new Editor(
      tui,
      {
        borderColor: (text) => theme.fg("border", text),
        selectList: {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      },
      { paddingX: 0 },
    );
    // Embedded drafts must never enter Editor's trimming/clearing submit path.
    this.description.disableSubmit = true;
    this.description.setText(display((task?.description ?? "").replace(/\t/gu, "    ")));
    this.normalizedDescription = this.description.getExpandedText();
    this.title.onSubmit = () => this.move(1);
    // Submission navigates fields below without destroying the native Undo stack.
    this.dependencies.onSubmit = () => this.save();
  }
  private get input() {
    return [this.title, this.description, this.dependencies][this.field];
  }
  get focused() {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.title.focused = false;
    this.description.focused = false;
    this.dependencies.focused = false;
    this.input.focused = value;
  }
  private move(delta: number) {
    this.field = (this.field + delta + 3) % 3;
    this.focused = this._focused;
    this.error = "";
    this.message.reset();
    this.tui.requestRender();
  }
  private save() {
    const enteredTitle = this.title.getValue();
    const unchangedTitle = this.originalTitle !== undefined && enteredTitle === this.normalizedTitle;
    const title = unchangedTitle ? (this.originalTitle ?? enteredTitle) : enteredTitle;
    if (!title.trim() || [...title].length > 160 || (!unchangedTitle && /[\r\n\u2028\u2029]/u.test(title))) {
      this.field = 0;
      this.focused = this._focused;
      this.fail("Title: 1-160 characters, no line breaks.");
      return;
    }
    const description = this.description.getExpandedText();
    this.submit({
      title,
      description: description === this.normalizedDescription ? this.originalDescription : description,
      dependencies: this.dependencies.getValue().trim()
        ? this.dependencies
            .getValue()
            .split(",")
            .map((id) => id.trim())
        : [],
    });
  }
  fail(message: string) {
    this.error = display(message);
    this.showingError = true;
    this.message.reset();
    this.tui.requestRender();
  }
  handleInput(data: string) {
    this.safeInput.handleInput(data);
  }
  dispose() {
    this.safeInput.dispose();
  }
  private handleSafeInput(data: string, paste: boolean) {
    if (paste) {
      if (!this.showingError && this.tui.terminal.columns >= 16 && this.tui.terminal.rows >= 12)
        this.input.handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "ctrl+c")) this.cancel();
    else if (this.showingError) {
      if (matchesKey(data, "escape") || matchesKey(data, "return") || matchesKey(data, "tab"))
        this.showingError = false;
      else this.message.navigate(data);
    } else if (matchesKey(data, "escape")) this.cancel();
    else if (this.tui.terminal.columns < 16 || this.tui.terminal.rows < 12) this.message.navigate(data);
    else if (this.field === 1 && getKeybindings().matches(data, "tui.input.newLine"))
      this.description.handleInput(data);
    else if (matchesKey(data, "tab")) this.move(1);
    else if (matchesKey(data, "shift+tab")) this.move(-1);
    else if (matchesKey(data, "ctrl+s")) this.save();
    else if (this.field === 1 && (getKeybindings().matches(data, "tui.input.submit") || matchesKey(data, "return")))
      this.move(1);
    else this.input.handleInput(data);
    this.tui.requestRender();
  }
  render(width: number): string[] {
    const height = Math.max(1, this.tui.terminal.rows);
    if (this.showingError)
      return this.message.render(
        `Error: ${this.error}\nDraft kept. Enter/Tab/Esc: correct fields.\nUp/Down, PgUp/PgDn, Home/End or p/n: scroll error. Ctrl+C: cancel.`,
        width,
        height,
      );
    if (width < 16 || height < 12)
      return this.message.render(
        "Resize to 16x12 to edit. Esc cancels. Up/Down or p/n scroll this message.",
        width,
        height,
      );
    const labels = [
      "Task title (1-160; no line breaks)",
      "Description (0-512; empty clears)",
      "Dependency UUIDs (comma-separated; empty clears)",
    ];
    const footer = columns(
      "Enter: next/save | Tab/Shift+Tab: field\nCtrl+S: save | Esc: cancel\nDescription: Shift+Enter adds a line",
      width,
    ).map((row) => row.text);
    const header = columns(labels[this.field], width).map((row) => this.theme.fg("accent", row.text));
    const input = this.input.render(width);
    const available = Math.max(1, height - header.length - footer.length);
    const cursor = input.findIndex((line) => line.includes(CURSOR_MARKER));
    const start = Math.max(0, cursor - available + 1);
    return [...header, ...input.slice(start, start + available), ...footer].slice(0, height);
  }
  invalidate() {
    this.title.invalidate();
    this.description.invalidate();
    this.dependencies.invalidate();
  }
}
export class StatusForm implements Component {
  focused = false;
  private index: number;
  private readonly viewport = new SourceViewport();
  private readonly commands = new DraftInput(display, (data, paste) => {
    if (!paste) this.handleKey(data);
  });
  private readonly choices: Status[] = ["pending", "in_progress", "completed"];
  constructor(
    private readonly tui: TUI,
    status: Status,
    private readonly done: (status?: Status) => void,
  ) {
    this.index = this.choices.indexOf(status);
  }
  handleInput(data: string) {
    this.commands.handleInput(data);
  }
  dispose() {
    this.commands.dispose();
  }
  private handleKey(data: string) {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.done();
    else if (matchesKey(data, "return")) this.done(this.choices[this.index]);
    else if (matchesKey(data, "up")) this.index = Math.max(0, this.index - 1);
    else if (matchesKey(data, "down")) this.index = Math.min(2, this.index + 1);
    else if (matchesKey(data, "home")) this.index = 0;
    else if (matchesKey(data, "end")) this.index = 2;
    else this.viewport.navigate(data);
    this.tui.requestRender();
  }
  render(width: number) {
    return this.viewport.render(
      `Task status (pending reopens)\n${this.choices.map((status, i) => `${i === this.index ? ">" : " "} ${status}`).join("\n")}\nUp/Down choose; Enter saves; Esc cancels. p/n scroll.`,
      width,
      this.tui.terminal.rows,
    );
  }
  invalidate() {}
}
