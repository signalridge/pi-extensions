import { readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeDisplayText } from "@signalridge/pi-ui";

import { DEFAULT_VIEWER_HEIGHT, MAX_VIEWER_HEIGHT, MIN_PANEL_HEIGHT, SEARCH_SCROLL_OFFSET } from "./constants.js";
import { loadFileContent } from "./file-viewer.js";
import { createTextInputBuffer } from "./input-utils.js";
import { layoutSearchSource } from "./source-search.js";
import type { FileNode } from "./types.js";
import { isMarkdownPath, isUntrackedStatus } from "./utils.js";

const COMMENT_EDITOR_MAX_VISIBLE_LINES = 4;

export interface CommentPayload {
  relPath: string;
  lineRange: string;
  ext: string;
  selectedText: string;
}

export type ViewerAction = { type: "none" } | { type: "close" } | { type: "navigate"; direction: 1 | -1 };

type ViewerMode = "normal" | "select" | "search" | "comment";

interface ViewerState {
  file: FileNode | null;
  content: string[];
  rawContent: string;
  scroll: number;
  diffMode: boolean;
  renderMarkdown: boolean;
  mode: ViewerMode;
  selectStart: number;
  selectEnd: number;
  commentText: string;
  searchQuery: string;
  searchMatches: number[];
  searchRows: number[];
  searchIndex: number;
  lastRenderWidth: number;
  lastLoadedMtimeMs: number | null;
  height: number;
}

export interface ViewerController {
  isOpen(): boolean;
  getFile(): FileNode | null;
  setFile(file: FileNode): void;
  updateFileRef(file: FileNode | null): void;
  close(): void;
  render(width: number): string[];
  handleInput(data: string): ViewerAction;
}

export interface ViewerConfig {
  getRoot: () => string;
  projectCwd: string;
}

export function createViewer(
  config: ViewerConfig,
  theme: Theme,
  requestComment: (payload: CommentPayload, comment: string) => void,
): ViewerController {
  const { getRoot, projectCwd } = config;
  const searchInput = createTextInputBuffer();
  const commentInput = createTextInputBuffer({ preserveNewlines: true });

  const state: ViewerState = {
    file: null,
    content: [],
    rawContent: "",
    scroll: 0,
    diffMode: false,
    renderMarkdown: true,
    mode: "normal",
    selectStart: 0,
    selectEnd: 0,
    commentText: "",
    searchQuery: "",
    searchMatches: [],
    searchRows: [],
    searchIndex: 0,
    lastRenderWidth: 0,
    lastLoadedMtimeMs: null,
    height: DEFAULT_VIEWER_HEIGHT,
  };

  function isMarkdownFile(): boolean {
    return !!state.file && isMarkdownPath(state.file.path);
  }

  function isRenderedMarkdownMode(): boolean {
    return isMarkdownFile() && !state.diffMode && state.renderMarkdown;
  }

  function switchMarkdownToRaw(): boolean {
    if (!isRenderedMarkdownMode()) return false;
    state.renderMarkdown = false;
    const width = state.lastRenderWidth || process.stdout.columns || 80;
    reloadContent(width);
    return true;
  }

  function toggleMarkdownMode(): void {
    if (!isMarkdownFile() || state.diffMode) return;
    state.renderMarkdown = !state.renderMarkdown;
    state.lastRenderWidth = 0;
    resetSearch();
    setMode("normal");
    clampScroll();
  }

  function isSourceSearchMode(): boolean {
    return state.mode === "search" || !!state.searchQuery;
  }

  function resetSearch(): void {
    if (isSourceSearchMode()) state.lastRenderWidth = 0;
    state.searchRows = [];
    state.searchQuery = "";
    state.searchMatches = [];
    state.searchIndex = 0;
  }

  function resetComment(): void {
    state.commentText = "";
  }

  function clearSelection(): void {
    state.selectStart = 0;
    state.selectEnd = 0;
  }

  function isSourceSelectionMode(): boolean {
    return state.mode === "select" || state.mode === "comment";
  }

  function setMode(mode: ViewerMode): void {
    if (isSourceSelectionMode() && mode === "normal") {
      // Selection content is a source snapshot, not the ordinary rendered rows.
      state.lastRenderWidth = 0;
    }
    if (mode !== state.mode) {
      searchInput.reset();
      commentInput.reset();
    }

    state.mode = mode;
    if (mode === "select" || mode === "comment") resetSearch();
    if (mode !== "comment") resetComment();
    if (mode === "normal") {
      clearSelection();
    }
  }

  function getMaxScroll(): number {
    return Math.max(0, state.content.length - state.height);
  }

  function refreshRawContent(): void {
    if (!state.file) return;

    try {
      const fileStat = statSync(state.file.path);
      state.rawContent = readFileSync(state.file.path, "utf-8");
      state.file.lineCount = state.rawContent.split("\n").length;
      state.lastLoadedMtimeMs = fileStat.mtimeMs;
    } catch {
      state.rawContent = "";
      state.file.lineCount = undefined;
      state.lastLoadedMtimeMs = null;
    }
  }

  function hasFileChangedOnDisk(): boolean {
    if (!state.file) return false;

    try {
      return state.lastLoadedMtimeMs === null || statSync(state.file.path).mtimeMs !== state.lastLoadedMtimeMs;
    } catch {
      return state.lastLoadedMtimeMs !== null;
    }
  }

  function clampScroll(): void {
    state.scroll = Math.min(getMaxScroll(), Math.max(0, state.scroll));
  }

  function reloadContent(width: number): void {
    if (!state.file) return;
    if (isSourceSelectionMode()) {
      // Resizing must not replace the source snapshot or change its indices.
      state.lastRenderWidth = width;
      clampScroll();
      return;
    }
    refreshRawContent();
    if (isSourceSearchMode()) {
      reloadSearchContent(width);
    } else {
      const hasChanges = !!state.file.gitStatus;
      const result = loadFileContent(
        state.file.path,
        getRoot(),
        state.diffMode,
        hasChanges,
        width,
        state.renderMarkdown,
      );
      state.content = result.lines;
      state.renderMarkdown = result.renderedMarkdown;
    }
    state.lastRenderWidth = width;
    clampScroll();
    if (state.searchQuery) {
      updateSearchMatches({ preserveActiveMatch: true });
    }
  }

  function reloadSearchContent(width: number): void {
    const layout = layoutSearchSource(state.rawContent, width, state.searchQuery);
    state.content = layout.lines;
    state.searchRows = layout.matchRows;
  }

  function revealSearchMatch(): void {
    const sourceLine = state.searchMatches[state.searchIndex];
    const row = state.searchRows[sourceLine];
    if (row !== undefined) state.scroll = Math.max(0, row - SEARCH_SCROLL_OFFSET);
    clampScroll();
  }

  function updateSearchMatches(options: { preserveActiveMatch?: boolean } = {}): void {
    const activeMatch = options.preserveActiveMatch ? state.searchMatches[state.searchIndex] : undefined;
    reloadSearchContent(state.lastRenderWidth || process.stdout.columns || 80);

    state.searchMatches = [];
    if (!state.searchQuery) {
      state.searchIndex = 0;
      return;
    }

    const q = state.searchQuery.toLowerCase();
    const rawLines = state.rawContent.split("\n");
    for (let i = 0; i < rawLines.length; i++) {
      if (rawLines[i].toLowerCase().includes(q)) {
        state.searchMatches.push(i);
      }
    }

    if (state.searchMatches.length === 0) {
      state.searchIndex = 0;
      return;
    }

    if (activeMatch === undefined) {
      state.searchIndex = 0;
    } else {
      let nearestIndex = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (let i = 0; i < state.searchMatches.length; i++) {
        const distance = Math.abs(state.searchMatches[i] - activeMatch);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = i;
        }
      }
      state.searchIndex = nearestIndex;
    }

    revealSearchMatch();
  }

  function jumpToNextMatch(direction: 1 | -1): void {
    if (state.searchMatches.length === 0) return;
    state.searchIndex += direction;
    if (state.searchIndex < 0) state.searchIndex = state.searchMatches.length - 1;
    if (state.searchIndex >= state.searchMatches.length) state.searchIndex = 0;
    revealSearchMatch();
  }

  function buildCommentPayload(): CommentPayload | null {
    if (!state.file || state.diffMode || !isSourceSelectionMode()) return null;

    // These are the very same source lines displayed in the selection view.
    const selectedText = state.content.slice(state.selectStart, state.selectEnd + 1).join("\n");
    const rel = relative(projectCwd, state.file.path);
    const relPath = !rel || rel.startsWith("..") ? state.file.path : rel;
    const lineRange =
      state.selectStart === state.selectEnd
        ? `line ${state.selectStart + 1}`
        : `lines ${state.selectStart + 1}-${state.selectEnd + 1}`;
    const ext = state.file.name.split(".").pop() || "";

    return { relPath, lineRange, ext, selectedText };
  }

  function sendComment(comment: string): void {
    const payload = buildCommentPayload();
    if (!payload) return;

    requestComment(payload, comment);
    setMode("normal");
  }

  function renderHeader(width: number): string {
    if (!state.file) return "";
    const isUntracked = isUntrackedStatus(state.file.gitStatus);

    let header = theme.bold(sanitizeDisplayText(state.file.name));
    if (isSourceSearchMode()) {
      header += theme.fg("accent", " [SOURCE SEARCH]");
    } else if (isUntracked) {
      header += theme.fg("dim", " [UNTRACKED]");
    } else if (state.diffMode) {
      header += theme.fg("warning", " [DIFF]");
    } else if (isMarkdownFile()) {
      header += theme.fg("accent", state.renderMarkdown ? " [RENDERED]" : " [RAW]");
    }
    if (state.mode === "select" || state.mode === "comment") {
      header += theme.fg("accent", ` [SOURCE SELECT ${state.selectStart + 1}-${state.selectEnd + 1}]`);
    }

    if (state.file.diffStats) {
      if (state.file.diffStats.additions > 0) {
        header += theme.fg("success", ` +${state.file.diffStats.additions}`);
      }
      if (state.file.diffStats.deletions > 0) {
        header += theme.fg("error", ` -${state.file.diffStats.deletions}`);
      }
    } else if (isUntracked && state.file.lineCount !== undefined) {
      header += theme.fg("success", ` +${state.file.lineCount}`);
    }

    if (state.file.lineCount !== undefined) {
      header += theme.fg("dim", ` ${state.file.lineCount}L`);
    }

    if (state.mode === "search") {
      header += theme.fg("accent", `  /${state.searchQuery}█`);
    } else if (state.searchQuery && state.searchMatches.length > 0) {
      header += theme.fg("dim", ` [${state.searchIndex + 1}/${state.searchMatches.length}]`);
    }

    return truncateToWidth(header, width);
  }

  function renderCommentEditor(width: number): string[] {
    const contentWidth = Math.max(1, width - 2);
    const wrappedLines: string[] = [];
    const logicalLines = state.commentText.split("\n");

    for (const line of logicalLines) {
      if (line.length === 0) {
        wrappedLines.push("");
        continue;
      }
      wrappedLines.push(...wrapTextWithAnsi(line, contentWidth));
    }

    if (wrappedLines.length === 0) {
      wrappedLines.push("");
    }

    const lastIndex = wrappedLines.length - 1;
    wrappedLines[lastIndex] = `${wrappedLines[lastIndex]}█`;

    const overflow = Math.max(0, wrappedLines.length - COMMENT_EDITOR_MAX_VISIBLE_LINES);
    const visibleLines = wrappedLines.slice(-COMMENT_EDITOR_MAX_VISIBLE_LINES);
    if (overflow > 0 && visibleLines.length > 0) {
      visibleLines[0] = `…${visibleLines[0]}`;
    }

    return [
      truncateToWidth(theme.fg("accent", "Comment:"), width),
      ...visibleLines.map((line) => truncateToWidth(`  ${line}`, width)),
    ];
  }

  function renderFooter(width: number): string[] {
    const lines: string[] = [];
    const pct =
      state.content.length > 0
        ? Math.round((state.scroll / Math.max(1, state.content.length - state.height)) * 100)
        : 0;

    if (state.mode === "comment") {
      lines.push(...renderCommentEditor(width));
      lines.push(theme.fg("borderAccent", "─".repeat(width)));
    }

    let help: string;
    if (state.mode === "comment") {
      help = theme.fg("dim", "Enter: newline  Ctrl+Enter/Ctrl+D: send  Esc: cancel");
    } else if (state.mode === "select") {
      help = theme.fg("dim", "Source lines (unwrapped, clipped)  j/k: extend  c: comment  Esc: cancel");
    } else if (state.mode === "search") {
      help = theme.fg("dim", "Wrapped source search  Enter: confirm  Esc: cancel");
    } else {
      const isUntracked = state.file && isUntrackedStatus(state.file.gitStatus);
      const markdownHelp = isMarkdownFile() && !state.diffMode ? "m: raw/render  " : "";
      if (state.diffMode) {
        lines.push(
          truncateToWidth(theme.fg("dim", "Selection/comments disabled in diff; press d for raw source."), width),
        );
      }
      help = theme.fg(
        "dim",
        `j/k: scroll  ${state.diffMode ? "" : "v: source select  "}/: search  n/N: next/prev match  ${markdownHelp}[]: files  ${state.file?.gitStatus && !isUntracked ? "d: diff  " : ""}q: back  ${pct}%`,
      );
    }
    lines.push(truncateToWidth(help, width));

    return lines;
  }

  return {
    isOpen(): boolean {
      return !!state.file;
    },

    getFile(): FileNode | null {
      return state.file;
    },

    setFile(file: FileNode): void {
      state.file = file;
      state.scroll = 0;
      state.diffMode = !!file.gitStatus && !isUntrackedStatus(file.gitStatus);
      state.renderMarkdown = isMarkdownPath(file.path);
      resetSearch();
      setMode("normal");
      state.content = [];
      state.lastRenderWidth = 0;
      state.lastLoadedMtimeMs = null;
      refreshRawContent();
    },

    updateFileRef(file: FileNode | null): void {
      state.file = file;
    },

    close(): void {
      state.file = null;
      state.content = [];
      state.rawContent = "";
      state.renderMarkdown = true;
      state.lastLoadedMtimeMs = null;
      resetSearch();
      setMode("normal");
    },

    render(width: number): string[] {
      if (!state.file) return [];

      const shouldAutoRefresh = state.mode !== "select" && state.mode !== "comment";
      if (
        state.lastRenderWidth !== width ||
        state.content.length === 0 ||
        (shouldAutoRefresh && hasFileChangedOnDisk())
      ) {
        reloadContent(width);
      }

      const lines: string[] = [];
      lines.push(renderHeader(width));
      lines.push(theme.fg("borderAccent", "─".repeat(width)));

      const visible = state.content.slice(state.scroll, state.scroll + state.height);
      for (let i = 0; i < state.height; i++) {
        if (i < visible.length) {
          const lineIdx = state.scroll + i;
          const row = isSourceSelectionMode() ? `${String(lineIdx + 1).padStart(4)} │ ${visible[i]}` : visible[i];
          let line = truncateToWidth(row || "", width);
          if (
            (state.mode === "select" || state.mode === "comment") &&
            lineIdx >= state.selectStart &&
            lineIdx <= state.selectEnd
          ) {
            line = theme.bg("selectedBg", line);
          }
          lines.push(line);
        } else {
          lines.push(theme.fg("dim", "~"));
        }
      }

      lines.push(theme.fg("borderAccent", "─".repeat(width)));
      lines.push(...renderFooter(width));

      return lines;
    },

    handleInput(data: string): ViewerAction {
      if (!state.file) return { type: "none" };

      if (state.mode === "comment") {
        if (matchesKey(data, "ctrl+enter") || matchesKey(data, "ctrl+d") || matchesKey(data, "alt+enter")) {
          const comment = state.commentText.trim();
          if (comment) {
            sendComment(comment);
          } else {
            setMode("normal");
          }
        } else if (matchesKey(data, Key.enter) || matchesKey(data, "shift+enter")) {
          state.commentText += "\n";
        } else if (matchesKey(data, Key.escape)) {
          setMode("normal");
        } else if (matchesKey(data, Key.backspace)) {
          state.commentText = state.commentText.slice(0, -1);
        } else {
          const text = commentInput.push(data);
          if (text) {
            state.commentText += text;
          }
        }
        return { type: "none" };
      }

      if (state.mode === "search") {
        if (matchesKey(data, Key.enter)) {
          if (!state.searchQuery) state.lastRenderWidth = 0;
          setMode("normal");
        } else if (matchesKey(data, Key.escape)) {
          resetSearch();
          setMode("normal");
        } else if (matchesKey(data, Key.backspace)) {
          state.searchQuery = state.searchQuery.slice(0, -1);
          updateSearchMatches();
        } else {
          const text = searchInput.push(data);
          if (text) {
            state.searchQuery += text;
            updateSearchMatches();
          }
        }
        return { type: "none" };
      }

      if (matchesKey(data, "q") && state.mode !== "select") {
        return { type: "close" };
      }
      if (matchesKey(data, Key.escape)) {
        if (state.mode === "select") {
          setMode("normal");
        } else if (state.searchQuery) {
          resetSearch();
        } else {
          return { type: "close" };
        }
        return { type: "none" };
      }
      if (matchesKey(data, "/") && state.mode !== "select") {
        const width = state.lastRenderWidth || process.stdout.columns || 80;
        resetSearch();
        switchMarkdownToRaw();
        setMode("search");
        reloadContent(width);
        return { type: "none" };
      }
      if (matchesKey(data, "n") && state.mode !== "select" && state.searchMatches.length > 0) {
        jumpToNextMatch(1);
        return { type: "none" };
      }
      if (matchesKey(data, Key.shift("n")) && state.mode !== "select" && state.searchMatches.length > 0) {
        jumpToNextMatch(-1);
        return { type: "none" };
      }
      if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
        if (state.mode === "select") {
          state.selectEnd = Math.min(state.content.length - 1, state.selectEnd + 1);
          if (state.selectEnd >= state.scroll + state.height) {
            state.scroll = state.selectEnd - state.height + 1;
          }
        } else {
          state.scroll = Math.min(getMaxScroll(), state.scroll + 1);
        }
        return { type: "none" };
      }
      if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
        if (state.mode === "select") {
          state.selectEnd = Math.max(state.selectStart, state.selectEnd - 1);
          if (state.selectEnd < state.scroll) state.scroll = state.selectEnd;
        } else {
          state.scroll = Math.max(0, state.scroll - 1);
        }
        return { type: "none" };
      }
      if (matchesKey(data, Key.pageDown)) {
        state.scroll = Math.min(getMaxScroll(), state.scroll + state.height);
        return { type: "none" };
      }
      if (matchesKey(data, Key.pageUp)) {
        state.scroll = Math.max(0, state.scroll - state.height);
        return { type: "none" };
      }
      if (matchesKey(data, "g")) {
        state.scroll = 0;
        return { type: "none" };
      }
      if (matchesKey(data, "shift+g")) {
        state.scroll = getMaxScroll();
        return { type: "none" };
      }
      if (matchesKey(data, "+") || matchesKey(data, "=")) {
        state.height = Math.min(MAX_VIEWER_HEIGHT, state.height + 5);
        clampScroll();
        return { type: "none" };
      }
      if (matchesKey(data, "-") || matchesKey(data, "_")) {
        state.height = Math.max(MIN_PANEL_HEIGHT, state.height - 5);
        clampScroll();
        return { type: "none" };
      }
      if (
        matchesKey(data, "d") &&
        state.mode !== "select" &&
        state.file.gitStatus &&
        !isUntrackedStatus(state.file.gitStatus)
      ) {
        resetSearch();
        state.diffMode = !state.diffMode;
        state.lastRenderWidth = 0;
        state.scroll = 0;
        return { type: "none" };
      }
      if (matchesKey(data, "m") && state.mode !== "select") {
        toggleMarkdownMode();
        return { type: "none" };
      }
      if (matchesKey(data, "v") && state.mode !== "select") {
        if (state.diffMode || switchMarkdownToRaw()) {
          return { type: "none" };
        }
        refreshRawContent();
        setMode("select");
        state.content = state.rawContent.split("\n");
        // Rendered rows (including bat continuations) cannot locate source lines.
        // Start at the top rather than silently reinterpret the previous scroll.
        state.scroll = 0;
        state.selectStart = 0;
        state.selectEnd = 0;
        return { type: "none" };
      }
      if (matchesKey(data, "c") && state.mode === "select" && !state.diffMode) {
        setMode("comment");
        state.commentText = "";
        return { type: "none" };
      }
      if (matchesKey(data, "]") && state.mode !== "select") {
        return { type: "navigate", direction: 1 };
      }
      if (matchesKey(data, "[") && state.mode !== "select") {
        return { type: "navigate", direction: -1 };
      }

      return { type: "none" };
    },
  };
}
