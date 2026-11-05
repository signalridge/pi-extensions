/**
 * Persistent History + Ctrl+R Fuzzy Popup (fzf / atuin style)
 *
 * - Loads recent prompts from previous sessions into up/down history on startup.
 * - Ctrl+R opens a large two-pane popup: a filterable list on the left (row
 *   number + age + one-line summary) and the FULL text of the highlighted entry
 *   on the right, `fzf --preview` style. Newest entry sits at the top.
 *
 * Hotkeys while searching:
 * - ↑ / Ctrl+P / Ctrl+S : move up (toward newer)
 * - ↓ / Ctrl+N / Ctrl+R : move down (toward older — "press ctrl+R again to go further back")
 * - Ctrl+D / Ctrl+U     : scroll the preview pane
 * - <type>              : fuzzy-filter (subsequence, space = multi-token)
 * - Enter               : accept selection (fills editor)
 * - Esc / Ctrl+G / Ctrl+C : cancel
 */

import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import type { UserMessage } from "@earendil-works/pi-ai";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  migrateSessionEntries,
  parseSessionEntries,
  SessionManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type EditorComponent,
  type Focusable,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { installEditor } from "./editor-install.js";

const MAX_MESSAGES = 100;
/** Repeat presses while the history scan is pending cannot grow without bound. */
const MAX_QUEUED_STEPS = 100;

/** Popup footprint, as a fraction of the terminal. */
const POPUP_WIDTH = "90%";
const POPUP_MAX_HEIGHT = "85%";
/** Same fraction as POPUP_MAX_HEIGHT — used to size the list to the popup. */
const POPUP_HEIGHT_FRACTION = 0.85;
/** Two frame rows, one visible result and the query. Requires at least five terminal rows. */
const MIN_POPUP_ROWS = 4;

/** Share of the popup interior handed to the preview pane. */
const PREVIEW_FRACTION = 0.42;
/** Columns the preview never drops below, and the list never drops below. */
const MIN_PREVIEW_WIDTH = 24;
const MIN_LIST_WIDTH = 30;
/** Under this total width there is no room to split; the list goes full-width. */
const MIN_WIDTH_FOR_PREVIEW = 76;

/** Ceiling on the list height, so a very tall terminal does not get an absurd popup. */
const MAX_LIST_ROWS = 40;

/** Width of the right-aligned age column ("now", "59m", "23h", "364d"). */
const AGE_WIDTH = 4;

export interface HistoryEntry {
  text: string;
  /** Epoch ms taken from the session entry that recorded this prompt. */
  timestamp?: number;
}

interface ShortcutSearch {
  queuedSteps: number;
  popup?: HistoryPopupComponent;
  cancel?: () => void;
  cancelWait?: () => void;
}

// ─── Extension Entry ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let historyCache: HistoryEntry[] = [];
  let historyReady: Promise<void> = Promise.resolve();
  let loadGeneration = 0;
  let shortcutOwner: ShortcutSearch | undefined;
  let sessionEditors = new Set<EditorComponent>();

  const retireShortcut = () => {
    const owner = shortcutOwner;
    shortcutOwner = undefined;
    // Pi's resetExtensionUI hides an overlay without resolving ui.custom().
    // Close it via Pi's done callback while the old session still owns it.
    owner?.cancelWait?.();
    owner?.cancel?.();
  };

  pi.on("session_start", (_event, ctx) => {
    const generation = ++loadGeneration;
    retireShortcut();
    historyCache = [];
    sessionEditors.clear();
    historyReady = Promise.resolve();
    if (ctx.mode !== "tui" || !ctx.hasUI) return;

    const editors = new Set<EditorComponent>();
    sessionEditors = editors;
    let scanPending = true;
    const usedEditors = new Set<EditorComponent>();
    const populate = (editor: EditorComponent, items: HistoryEntry[]) => {
      // Native history is bounded. Appending old entries after a live submission
      // would put them ahead of it and can evict it; browsing also owns its cursor.
      if (usedEditors.has(editor)) return;
      for (let i = items.length - 1; i >= 0; i--) {
        editor.addToHistory?.(items[i]?.text);
      }
    };
    // Compose synchronously, preserving a completed startup paste through public
    // expanded text. When I/O finishes, seed existing instances, never replace them.
    const prevComponentFactory = ctx.ui.getEditorComponent();
    installEditor(ctx.ui, (tui, theme, keybindings) => {
      const editor =
        prevComponentFactory?.(tui, theme, keybindings) ??
        new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
      if (generation === loadGeneration && !editors.has(editor)) {
        editors.add(editor);
        const pending = () => scanPending && generation === loadGeneration;
        const addToHistory = editor.addToHistory?.bind(editor);
        if (addToHistory) {
          editor.addToHistory = (text) => {
            if (pending()) usedEditors.add(editor);
            addToHistory(text);
          };
        }
        const handleInput = editor.handleInput?.bind(editor);
        if (handleInput) {
          editor.handleInput = (data) => {
            const kb = getKeybindings();
            if (
              pending() &&
              (
                [
                  "tui.editor.historyPrevious",
                  "tui.editor.historyNext",
                  "tui.editor.cursorUp",
                  "tui.editor.cursorDown",
                ] as const
              ).some((action) => kb.matches(data, action))
            ) {
              usedEditors.add(editor);
            }
            handleInput(data);
          };
        }
        populate(editor, historyCache);
      }
      return editor;
    });
    historyReady = loadRecentPrompts(ctx.cwd, ctx.sessionManager.getSessionDir(), MAX_MESSAGES)
      .then((items) => {
        if (generation !== loadGeneration) return;
        scanPending = false;
        historyCache = items;
        for (const editor of editors) populate(editor, items);
      })
      .catch(() => {
        scanPending = false;
      });
  });

  pi.on("session_tree", () => {
    // A committed branch change invalidates the pending search, not the cross-session scan.
    // session_before_tree may still be cancelled, so retire only after navigation.
    retireShortcut();
  });

  pi.on("session_shutdown", () => {
    loadGeneration++;
    retireShortcut();
    historyCache = [];
    sessionEditors.clear();
    historyReady = Promise.resolve();
  });

  // Ctrl+R: fuzzy history popup (fzf / atuin style)
  pi.registerShortcut("ctrl+r", {
    description: "Fuzzy popup search through prompt history",
    handler: async (ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) return;
      // Own the entire scan → overlay → editor update. During the scan, repeat
      // presses become navigation steps; once open, Pi routes keys to the popup.
      if (shortcutOwner) {
        if (shortcutOwner.popup) shortcutOwner.popup.handleInput("\x12");
        else shortcutOwner.queuedSteps = Math.min(shortcutOwner.queuedSteps + 1, MAX_QUEUED_STEPS);
        return;
      }
      const owner: ShortcutSearch = { queuedSteps: 0 };
      shortcutOwner = owner;
      const generation = loadGeneration;
      const ready = historyReady;
      const cancelled = new Promise<void>((resolve) => {
        owner.cancelWait = resolve;
      });

      try {
        // If invoked during startup, wait for the background history scan rather
        // than briefly reporting an empty history. A switched session owns a new
        // scan; never merge its branch with an old scan's partial cache.
        await Promise.race([ready, cancelled]);
        if (generation !== loadGeneration || shortcutOwner !== owner) return;

        const branchHistory = collectBranchHistory(ctx);
        const merged = mergeHistory(branchHistory, historyCache);

        if (merged.length === 0) {
          ctx.ui.notify("No prompt history yet.", "info");
          return;
        }

        let overlayTui: TUI | undefined;
        const selected = await ctx.ui.custom<string | null>(
          (tui, theme, _kb, done) => {
            overlayTui = tui;
            owner.cancel = () => done(null);
            owner.popup = new HistoryPopupComponent(tui, theme, merged, done, owner.queuedSteps);
            return owner.popup;
          },
          {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              width: POPUP_WIDTH,
              minWidth: 40,
              maxHeight: POPUP_MAX_HEIGHT,
            },
          },
        );

        if (generation !== loadGeneration || shortcutOwner !== owner || selected === null) return;
        ctx.ui.setEditorText(selected);
        // Closing the overlay requests a render before this continuation updates the editor.
        // The editor setter only mutates text, so request another frame afterward.
        overlayTui?.requestRender();
      } finally {
        // An old scan or overlay must not release a newer session's shortcut.
        if (shortcutOwner === owner) shortcutOwner = undefined;
      }
    },
  });
}

// ─── Fuzzy History Popup ───────────────────────────────────────────────────────

type Done = (value: string | null) => void;

/** Subsequence fuzzy match: all chars in needle appear in haystack in order. */
export function subsequence(haystack: string, needle: string): boolean {
  return subsequencePositions(Array.from(haystack), needle) !== undefined;
}

function subsequencePositions(haystack: string[], needle: string): number[] | undefined {
  const positions: number[] = [];
  let start = 0;
  for (const point of needle) {
    const index = haystack.indexOf(point, start);
    if (index === -1) return undefined;
    positions.push(index);
    start = index + 1;
  }
  return positions;
}

export function fuzzyMatch(item: string, query: string): boolean {
  if (!query) return true;
  const lower = item.toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((t) => subsequence(lower, t));
}

export function toSingleLinePreview(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Compact age for the list gutter; "" when the session recorded no timestamp. */
export function relativeAge(timestamp: number | undefined, now: number): string {
  if (timestamp === undefined) return "";
  const diff = now - timestamp;
  if (diff < 60_000) return "now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
}

/** Highlight matched characters (subsequence) with underline + accent color. */
function highlightMatch(text: string, query: string, theme: Pick<Theme, "fg">, maxWidth: number): string {
  // Truncate plain text first to ensure it fits
  const truncated = truncateToWidth(text, maxWidth);
  // Strip any ANSI that truncateToWidth might have added for ellipsis
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR sequences are intentionally removed.
  const plain = truncated.replace(/\x1b\[[0-9;]*m/g, "");

  if (!query) return theme.fg("text", plain);

  // Search code points, but style whole graphemes (emoji/ZWJ/combining marks).
  const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(plain));
  // Lowercase the complete string, like filtering (context-sensitive final sigma).
  const points = Array.from(plain.toLowerCase());
  const owners: number[] = [];
  for (const [index, grapheme] of graphemes.entries()) {
    owners.push(...Array.from(grapheme.segment.toLowerCase(), () => index));
  }
  const matched = new Set<number>();
  for (const token of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    for (const position of subsequencePositions(points, token) ?? []) matched.add(owners[position]);
  }
  return graphemes
    .map(({ segment }, index) =>
      matched.has(index) ? `\x1b[4m${theme.fg("accent", segment)}\x1b[24m` : theme.fg("text", segment),
    )
    .join("");
}

/**
 * fzf-style two-pane popup. The list filters live as you type; the pane on the
 * right always shows the full, unsquashed text of the highlighted entry, which
 * is the whole point — one-line summaries cannot tell two long prompts apart.
 *
 * Layout (newest entry first, so the list reads top-down like a transcript):
 *   ╭─ history ────────────────────────┬──────────────────╮
 *   │    1  5m   newest match          │ full text of the │
 *   │ ▌  2  2h   selected match        │ highlighted      │
 *   │    3  1d   older match           │ entry, wrapped   │
 *   │ > query█                    2/57 │ and scrollable   │
 *   │ ↑↓ move · enter accept · …       │                  │
 *   ╰──────────────────────────────────┴──────────────────╯
 */
export class HistoryPopupComponent implements Component, Focusable {
  private _focused = false;
  private readonly input = new Input();
  /** Display/search copies are separate from the exact text accepted into the editor. */
  private readonly displayEntries: { preview: string; fullText: string; searchKey: string }[];

  private query = "";
  private closed = false;
  /** Indices into `history` that match the query, newest-first. */
  private matchIndices: number[] = [];
  /** Pointer into `matchIndices`; 0 = newest match = top row. */
  private matchPointer = 0;
  /** First visible preview line; reset whenever the selection moves. */
  private previewOffset = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly history: HistoryEntry[],
    private readonly done: Done,
    initialSelection = 0,
  ) {
    this.displayEntries = history.map(({ text }) => {
      const fullText = stripVTControlCharacters(text);
      return { fullText, preview: toSingleLinePreview(fullText), searchKey: fullText.toLowerCase() };
    });
    this.input.onEscape = () => this.finish(null);
    this.input.onSubmit = () => {
      this.finish(this.getCurrentEntry()?.text ?? null);
    };
    this.recomputeMatches(true);
    this.matchPointer = Math.min(initialSelection, Math.max(0, this.matchIndices.length - 1));
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  private recomputeMatches(resetPointer: boolean): void {
    const matches: number[] = [];
    for (let i = 0; i < this.history.length; i++) {
      if (fuzzyMatch(this.displayEntries[i]?.searchKey, this.query)) {
        matches.push(i);
      }
    }
    this.matchIndices = matches;
    if (resetPointer) this.matchPointer = 0;
    if (this.matchPointer >= this.matchIndices.length) {
      this.matchPointer = Math.max(0, this.matchIndices.length - 1);
    }
    this.previewOffset = 0;
  }

  private getCurrentEntry(): HistoryEntry | undefined {
    const historyIndex = this.matchIndices[this.matchPointer];
    return historyIndex === undefined ? undefined : this.history[historyIndex];
  }

  /** Move up the list, i.e. toward newer entries (clamped). */
  private moveUp(): void {
    if (this.matchIndices.length === 0) return;
    this.matchPointer = Math.max(this.matchPointer - 1, 0);
    this.previewOffset = 0;
  }

  /** Move down the list, i.e. toward older entries (clamped). */
  private moveDown(): void {
    if (this.matchIndices.length === 0) return;
    this.matchPointer = Math.min(this.matchPointer + 1, this.matchIndices.length - 1);
    this.previewOffset = 0;
  }

  private finish(value: string | null): void {
    if (this.closed) return;
    this.closed = true;
    this.done(value);
  }

  handleInput(data: string): void {
    if (this.closed) return;
    // Recheck before accepting input: a shrink may precede the next render.
    if (this.layout().cap < MIN_POPUP_ROWS) {
      this.finish(null);
      return;
    }
    // Newer: ↑ / Ctrl+P (previous line) / Ctrl+S (forward-search counterpart)
    if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p")) || matchesKey(data, Key.ctrl("s"))) {
      this.moveUp();
      this.tui.requestRender();
      return;
    }

    // Older: ↓ / Ctrl+N (next line) / Ctrl+R (press again to search further back)
    if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n")) || matchesKey(data, Key.ctrl("r"))) {
      this.moveDown();
      this.tui.requestRender();
      return;
    }

    // Preview scrolling — half a pane per press, like less/fzf.
    if (matchesKey(data, Key.ctrl("d"))) {
      this.previewOffset += Math.max(1, Math.floor(this.layout().rows / 2));
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.ctrl("u"))) {
      this.previewOffset = Math.max(0, this.previewOffset - Math.max(1, Math.floor(this.layout().rows / 2)));
      this.tui.requestRender();
      return;
    }

    // Cancel: Ctrl+G / Ctrl+C (Esc is handled via input.onEscape)
    if (matchesKey(data, Key.ctrl("g")) || matchesKey(data, Key.ctrl("c"))) {
      this.finish(null);
      return;
    }

    const before = this.input.getValue();
    this.input.handleInput(data);
    const after = this.input.getValue();

    if (after !== before) {
      this.query = after;
      this.recomputeMatches(true);
    }

    this.tui.requestRender();
  }

  /**
   * Rows the list gets, derived from the live terminal height. `render` only
   * receives a width, and the overlay sizes itself to whatever we return, so
   * the height budget has to be reconstructed from the same fraction the
   * overlay caps us at, minus the frame (2) and the query + help lines (2).
   */
  private layout(): { cap: number; rows: number; showHelp: boolean } {
    const terminalRows = this.tui.terminal?.rows ?? process.stdout.rows ?? 24;
    // Must mirror the overlay's own maths exactly: it resolves "85%" as
    // floor(termHeight * 85 / 100) and then hard-truncates anything taller with
    // `overlayLines.slice(0, maxHeight)` — from the BOTTOM, which would eat the
    // query line and leave a popup you cannot type into. So the cap is a
    // ceiling to fit under, never something to pad up to.
    const cap = Math.floor(terminalRows * POPUP_HEIGHT_FRACTION);
    // The frame (2) and the query line (1) are non-negotiable; the help line is
    // the first thing to drop when the terminal cannot afford it.
    const showHelp = cap >= 5;
    const rows = Math.max(1, Math.min(MAX_LIST_ROWS, cap - 3 - (showHelp ? 1 : 0)));
    return { cap, rows, showHelp };
  }

  /** Visible window over matchIndices, selection kept centered where possible. */
  private windowBounds(rows: number): { start: number; end: number } {
    const total = this.matchIndices.length;
    const size = Math.min(rows, total);
    const half = Math.floor(size / 2);
    const start = Math.max(0, Math.min(this.matchPointer - half, Math.max(0, total - size)));
    return { start, end: Math.min(start + size, total) };
  }

  /** Render one list row. The selected row becomes a full-width highlight bar. */
  private renderRow(matchIdx: number, isSelected: boolean, width: number, indexWidth: number, now: number): string {
    const t = this.theme;
    const historyIndex = this.matchIndices[matchIdx];
    const entry = historyIndex === undefined ? undefined : this.history[historyIndex];
    if (!entry) return "";
    const text = this.displayEntries[historyIndex]?.preview ?? "";

    const marker = isSelected ? "▌ " : "  ";
    const gutter = `${String(matchIdx + 1).padStart(indexWidth)} ${relativeAge(entry.timestamp, now).padStart(
      AGE_WIDTH,
    )}  `;
    const textWidth = Math.max(1, width - visibleWidth(marker) - visibleWidth(gutter));

    if (!isSelected) {
      return t.fg("border", marker) + t.fg("dim", gutter) + t.fg("muted", truncateToWidth(text, textWidth));
    }

    // Highlight matched chars, then pad to full width so the bar spans the row.
    const body = highlightMatch(text, this.query, t, textWidth);
    const used = visibleWidth(marker) + visibleWidth(gutter) + visibleWidth(body);
    const pad = " ".repeat(Math.max(0, width - used));
    return t.bg("selectedBg", t.fg("accent", marker) + t.fg("dim", gutter) + body + pad);
  }

  /** Full text of the selected entry, wrapped to the pane and scroll-clamped. */
  private renderPreview(width: number, height: number): string[] {
    const t = this.theme;
    const entry = this.getCurrentEntry();
    if (!entry || height <= 0) return [];

    const historyIndex = this.matchIndices[this.matchPointer];
    const wrapped = wrapTextWithAnsi(this.displayEntries[historyIndex]?.fullText ?? "", width);
    // Reserve the hint before computing the viewport, never overwrite payload rows.
    const showHint = wrapped.length > height && height > 1;
    const contentHeight = Math.max(1, height - (showHint ? 1 : 0));
    const maxOffset = Math.max(0, wrapped.length - contentHeight);
    // Clamp here rather than in the key handler: the pane height is only known
    // at render time, so Ctrl+D cannot know where the end is.
    this.previewOffset = Math.min(this.previewOffset, maxOffset);

    const lines = wrapped
      .slice(this.previewOffset, this.previewOffset + contentHeight)
      .map((line) => t.fg("text", line));

    if (showHint) {
      // Spend the last row on a scroll indicator — without it, a truncated
      // preview is indistinguishable from a short prompt.
      const remaining = maxOffset - this.previewOffset;
      const hint =
        remaining > 0 ? `↓ ${remaining} more line${remaining === 1 ? "" : "s"} · ctrl+d/u` : "↑ ctrl+u to scroll back";
      lines.push(t.fg("dim", truncateToWidth(hint, width)));
    }
    return lines;
  }

  /** Pad or truncate a (possibly ANSI-styled) string to exactly `w` columns. */
  private fit(text: string, w: number): string {
    const vis = visibleWidth(text);
    if (vis > w) return truncateToWidth(text, w);
    return text + " ".repeat(w - vis);
  }

  render(width: number): string[] {
    const t = this.theme;
    const border = (s: string) => t.fg("borderAccent", s);
    const total = this.matchIndices.length;
    const { cap, rows, showHelp } = this.layout();
    if (this.closed) return [];
    if (cap < MIN_POPUP_ROWS) {
      // Never leave an invisible selection answerable. Close after this frame
      // rather than mutating Pi's overlay stack during its render traversal.
      this.closed = true;
      queueMicrotask(() => this.done(null));
      return [];
    }
    const now = Date.now();

    // Two-pane frame spends 7 columns on chrome: "│ " + list + " │ " + preview + " │".
    // Single-pane spends 4: "│ " + list + " │".
    const twoPane = width >= MIN_WIDTH_FOR_PREVIEW;
    const usable = twoPane ? Math.max(10, width - 7) : Math.max(10, width - 4);
    let previewWidth = 0;
    let listWidth = usable;
    if (twoPane) {
      previewWidth = Math.max(
        MIN_PREVIEW_WIDTH,
        Math.min(Math.floor(usable * PREVIEW_FRACTION), usable - MIN_LIST_WIDTH),
      );
      listWidth = usable - previewWidth;
    }

    // ── Left pane: list + query + help ───────────────────────────────────────
    const left: string[] = [];
    if (total === 0) {
      left.push(t.fg("warning", "no match"));
      while (left.length < rows) left.push("");
    } else {
      const indexWidth = Math.max(2, String(total).length);
      const { start, end } = this.windowBounds(rows);
      for (let i = start; i < end; i++) {
        left.push(this.renderRow(i, i === this.matchPointer, listWidth, indexWidth, now));
      }
      while (left.length < rows) left.push("");
    }

    // The Input renders its OWN "> " prompt and pads to the width it is handed,
    // so the counter has to live in columns withheld from it — appending to a
    // full-width render is what produced the old "> >" bug.
    const counter = ` ${total > 0 ? `${this.matchPointer + 1}/${total}` : "0/0"}`;
    const queryWidth = Math.max(4, listWidth - visibleWidth(counter));
    left.push((this.input.render(queryWidth)[0] ?? "") + t.fg("dim", counter));
    if (showHelp) {
      left.push(t.fg("dim", "↑↓ move · enter accept · ctrl+d/u preview · esc cancel"));
    }

    // ── Right pane: full text of the selection ───────────────────────────────
    const preview = twoPane ? this.renderPreview(previewWidth, left.length) : [];

    // ── Frame ────────────────────────────────────────────────────────────────
    const title = " history ";
    const body = left.map((line, i) => {
      const listCell = `${border("│")} ${this.fit(line, listWidth)} `;
      if (!twoPane) return listCell + border("│");
      return `${listCell + border("│")} ${this.fit(preview[i] ?? "", previewWidth)} ${border("│")}`;
    });

    if (!twoPane) {
      const dashes = Math.max(0, width - 3 - visibleWidth(title));
      return [border(`╭─${title}${"─".repeat(dashes)}╮`), ...body, border(`╰${"─".repeat(Math.max(0, width - 2))}╯`)];
    }

    // Tee the borders where the panes meet so the split reads as one frame.
    const leadIn = listWidth + 3 - 2 - visibleWidth(title);
    const top =
      leadIn >= 0
        ? `╭─${title}${"─".repeat(leadIn)}┬${"─".repeat(previewWidth + 2)}╮`
        : `╭${"─".repeat(listWidth + 2)}┬${"─".repeat(previewWidth + 2)}╮`;
    const bottom = `╰${"─".repeat(listWidth + 2)}┴${"─".repeat(previewWidth + 2)}╯`;

    return [border(top), ...body, border(bottom)];
  }

  invalidate(): void {
    this.input.invalidate();
  }
}

// ─── History Collection ────────────────────────────────────────────────────────

export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Collect user messages from the current session branch (for up-to-date search). */
function collectBranchHistory(ctx: ExtensionContext): HistoryEntry[] {
  const history: HistoryEntry[] = [];
  try {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const message = entry.message as { role?: unknown; content?: unknown };
      if (message.role !== "user") continue;
      const text = extractText(message.content as UserMessage["content"]);
      if (text?.trim()) {
        history.push({ text, timestamp: parseTimestamp(entry.timestamp) });
      }
    }
  } catch {
    // Best-effort history recovery: a session file that is missing, truncated,
    // or mid-write yields whatever was read so far rather than failing the
    // history surface entirely.
  }
  return history.reverse(); // newest first
}

/** Merge branch history (current session) with cached cross-session history, deduplicated. */
export function mergeHistory(branchHistory: HistoryEntry[], cached: HistoryEntry[]): HistoryEntry[] {
  const seen = new Set<string>();
  const merged: HistoryEntry[] = [];
  for (const entry of [...branchHistory, ...cached]) {
    if (seen.has(entry.text)) continue;
    seen.add(entry.text);
    merged.push(entry);
  }
  return merged;
}

async function loadRecentPrompts(cwd: string, sessionDir: string, maxMessages: number): Promise<HistoryEntry[]> {
  try {
    const sessions = await SessionManager.list(cwd, sessionDir);
    const sorted = sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    const allMessages: HistoryEntry[] = [];
    const seen = new Set<string>();

    for (const session of sorted) {
      if (allMessages.length >= maxMessages) break;
      const userMessages = extractUserMessages(session.path);
      for (const msg of userMessages) {
        if (allMessages.length >= maxMessages) break;
        if (msg.text.trim() && !seen.has(msg.text)) {
          seen.add(msg.text);
          allMessages.push(msg);
        }
      }
    }
    return allMessages;
  } catch {
    return [];
  }
}

function extractUserMessages(sessionPath: string): HistoryEntry[] {
  try {
    // Opening a persistent SessionManager repairs/migrates the file. History is
    // inspection only: parse and migrate a private in-memory copy instead.
    const entries = parseSessionEntries(readFileSync(sessionPath, "utf8"));
    migrateSessionEntries(entries);
    const messages: HistoryEntry[] = [];
    for (const entry of entries) {
      if (entry.type !== "message" || entry.message.role !== "user") continue;
      const text = extractText(entry.message.content);
      if (text) {
        messages.push({ text, timestamp: parseTimestamp(entry.timestamp) });
      }
    }
    // Reverse so newest messages come first within each session
    return messages.reverse();
  } catch {
    return [];
  }
}

export function extractText(content: UserMessage["content"]): string | null {
  if (typeof content === "string") return content || null;
  // Text-only recall: image parts cannot be restored by the editor text API.
  const text = content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  return text || null;
}
