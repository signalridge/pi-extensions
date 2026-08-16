import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { isGitRepo } from "./git.js";
import { hasCommand, isMarkdownPath, stripLeadingEmptyLines } from "./utils.js";

const DIFF_CONTENT_PREFIXES = new Set(["+", "-", " "]);

function isDiffContentLine(line: string): boolean {
  if (!line) return false;
  if (!DIFF_CONTENT_PREFIXES.has(line[0])) return false;
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return false;
  return true;
}

/**
 * Diff rows wrap at a hard column so the +/-/space markers stay aligned, but the
 * column is a terminal cell, not a JS code unit: slicing by `.length` overflows
 * the pane on CJK (two cells per character) and splits emoji surrogate pairs.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function wrapLine(line: string, width: number): string[] {
  if (width <= 0 || visibleWidth(line) <= width) {
    return [line];
  }
  const wrapped: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const { segment } of GRAPHEMES.segment(line)) {
    const cellWidth = visibleWidth(segment);
    // A single grapheme wider than the whole column still has to go somewhere.
    if (current && currentWidth + cellWidth > width) {
      wrapped.push(current);
      current = "";
      currentWidth = 0;
    }
    current += segment;
    currentWidth += cellWidth;
  }
  if (current) wrapped.push(current);
  return wrapped.length > 0 ? wrapped : [line];
}

export function wrapDiffLines(lines: string[], width: number): string[] {
  if (width <= 0) return lines;
  const wrapped: string[] = [];
  for (const line of lines) {
    if (visibleWidth(line) <= width) {
      wrapped.push(line);
      continue;
    }
    if (isDiffContentLine(line)) {
      const prefix = line[0];
      const content = line.slice(1);
      const contentWidth = Math.max(width - 1, 1);
      for (const chunk of wrapLine(content, contentWidth)) {
        wrapped.push(prefix + chunk);
      }
    } else {
      wrapped.push(...wrapLine(line, width));
    }
  }
  return wrapped;
}

function extractAnsiCode(str: string, pos: number): { length: number } | null {
  if (pos >= str.length || str[pos] !== "\x1b") return null;
  const next = str[pos + 1];
  if (next === "[") {
    let j = pos + 2;
    while (j < str.length && !/[mGKHJ]/.test(str[j])) j++;
    if (j < str.length) return { length: j + 1 - pos };
    return null;
  }
  if (next === "]") {
    let j = pos + 2;
    while (j < str.length) {
      if (str[j] === "\x07") return { length: j + 1 - pos };
      if (str[j] === "\x1b" && str[j + 1] === "\\") return { length: j + 2 - pos };
      j++;
    }
    return null;
  }
  if (next === "_") {
    let j = pos + 2;
    while (j < str.length) {
      if (str[j] === "\x07") return { length: j + 1 - pos };
      if (str[j] === "\x1b" && str[j + 1] === "\\") return { length: j + 2 - pos };
      j++;
    }
    return null;
  }
  return null;
}

function stripAnsiCodes(line: string): string {
  let result = "";
  for (let i = 0; i < line.length; ) {
    const ansi = extractAnsiCode(line, i);
    if (ansi) {
      i += ansi.length;
      continue;
    }
    result += line[i];
    i += 1;
  }
  return result;
}

function splitByVisibleWidth(line: string, width: number): { prefix: string; rest: string } {
  if (width <= 0) return { prefix: "", rest: line };
  let visible = 0;
  let i = 0;
  while (i < line.length) {
    const ansi = extractAnsiCode(line, i);
    if (ansi) {
      i += ansi.length;
      continue;
    }
    const charWidth = visibleWidth(line[i]);
    if (visible + charWidth > width) break;
    visible += charWidth;
    i += 1;
  }
  return { prefix: line.slice(0, i), rest: line.slice(i) };
}

function maskDigits(line: string): string {
  let result = "";
  for (let i = 0; i < line.length; ) {
    const ansi = extractAnsiCode(line, i);
    if (ansi) {
      result += line.slice(i, i + ansi.length);
      i += ansi.length;
      continue;
    }
    const char = line[i];
    result += char >= "0" && char <= "9" ? " " : char;
    i += 1;
  }
  return result;
}

function wrapDeltaLine(line: string, width: number): string[] {
  const clean = stripAnsiCodes(line);
  let separatorIndex = clean.indexOf("│");
  if (separatorIndex === -1) separatorIndex = clean.indexOf("|");
  if (separatorIndex === -1) return wrapTextWithAnsi(line, width);

  let prefixWidth = visibleWidth(clean.slice(0, separatorIndex + 1));
  if (clean[separatorIndex + 1] === " ") prefixWidth += 1;
  if (prefixWidth >= width) return wrapTextWithAnsi(line, width);

  const { prefix, rest } = splitByVisibleWidth(line, prefixWidth);
  const contentWidth = Math.max(width - visibleWidth(prefix), 1);
  const continuationPrefix = maskDigits(prefix);
  const wrappedContent = wrapTextWithAnsi(rest, contentWidth);

  return wrappedContent.map((chunk, index) => (index === 0 ? prefix : continuationPrefix) + chunk);
}

export function wrapDeltaLines(lines: string[], width: number): string[] {
  if (width <= 0) return lines;
  const wrapped: string[] = [];
  for (const line of lines) {
    wrapped.push(...wrapDeltaLine(line, width));
  }
  return wrapped;
}

/**
 * Which revision a `git diff` invocation compares the working tree against.
 */
export type GitDiffScope = "worktree" | "staged" | "head";

/**
 * Argv builders for the external tools this viewer shells out to.
 *
 * Paths reach us from `git ls-files`/`git status`, so any cloned repository can
 * name a file `report$(id).md` or `a"b.txt`. These builders exist so every path
 * is handed to `execFileSync` as one opaque argv element that no shell ever
 * parses, and so that argv construction stays assertable without spawning.
 */
export function gitDiffArgs(filePath: string, scope: GitDiffScope): string[] {
  const scopeArgs = scope === "staged" ? ["--cached"] : scope === "head" ? ["HEAD"] : [];
  // `--no-ext-diff` is not cosmetic: this viewer renders the diff itself (delta,
  // then wrapDiffLines), so a configured `diff.external`/`GIT_EXTERNAL_DIFF`
  // would substitute a side-by-side renderer for the unified diff we parse — and
  // would re-expose `-`-prefixed filenames, which git forwards to the external
  // tool as bare positionals with no `--` of their own.
  return ["diff", "--no-color", "--no-ext-diff", ...scopeArgs, "--", filePath];
}

export function deltaArgs(termWidth: number): string[] {
  return [
    "--no-gitconfig",
    `--width=${termWidth}`,
    "--line-numbers",
    "--wrap-max-lines=unlimited",
    "--max-line-length=0",
  ];
}

export function glowArgs(filePath: string, termWidth: number): string[] {
  return ["-s", "dark", "-w", String(termWidth), "--", filePath];
}

/** `wrap` selects the first tier of bat's fallback; the retry drops `--wrap=auto`. */
export function batArgs(filePath: string, termWidth: number, wrap: boolean): string[] {
  return [
    "--style=numbers",
    "--color=always",
    "--paging=never",
    ...(wrap ? ["--wrap=auto"] : []),
    `--terminal-width=${termWidth}`,
    "--",
    filePath,
  ];
}

export interface LoadedFileContent {
  lines: string[];
  renderedMarkdown: boolean;
}

export function loadFileContent(
  filePath: string,
  cwd: string,
  diffMode: boolean,
  hasChanges: boolean,
  width?: number,
  renderMarkdown = true,
): LoadedFileContent {
  const isMarkdown = isMarkdownPath(filePath);
  const termWidth = width || process.stdout.columns || 80;

  try {
    try {
      if (statSync(filePath).isDirectory()) {
        return {
          lines: ["Directory selected - expand it in the file tree instead of opening it."],
          renderedMarkdown: false,
        };
      }
    } catch {
      // Ignore stat errors and fall through to normal handling
    }

    if (diffMode && hasChanges && isGitRepo(cwd)) {
      try {
        // Try different diff strategies
        let diffOutput = "";

        // First try: unstaged changes
        const unstaged = execFileSync("git", gitDiffArgs(filePath, "worktree"), {
          cwd,
          encoding: "utf-8",
          timeout: 10000,
          stdio: "pipe",
        });
        if (unstaged.trim()) {
          diffOutput = unstaged;
        } else {
          // Second try: staged changes
          const staged = execFileSync("git", gitDiffArgs(filePath, "staged"), {
            cwd,
            encoding: "utf-8",
            timeout: 10000,
            stdio: "pipe",
          });
          if (staged.trim()) {
            diffOutput = staged;
          } else {
            // Third try: diff against HEAD (for new files that are staged)
            const headDiff = execFileSync("git", gitDiffArgs(filePath, "head"), {
              cwd,
              encoding: "utf-8",
              timeout: 10000,
              stdio: "pipe",
            });
            if (headDiff.trim()) {
              diffOutput = headDiff;
            }
          }
        }

        if (!diffOutput.trim()) {
          return {
            lines: ["No diff available - file may be untracked or unchanged"],
            renderedMarkdown: false,
          };
        }

        if (hasCommand("delta")) {
          // Pipe through delta with line numbers for better readability
          try {
            const deltaOutput = execFileSync("delta", deltaArgs(termWidth), {
              cwd,
              encoding: "utf-8",
              timeout: 10000,
              input: diffOutput,
              stdio: ["pipe", "pipe", "pipe"],
            });
            return {
              lines: wrapDeltaLines(stripLeadingEmptyLines(deltaOutput.split("\n")), termWidth),
              renderedMarkdown: false,
            };
          } catch {
            // Fall back to raw diff
          }
        }

        return {
          lines: wrapDiffLines(stripLeadingEmptyLines(diffOutput.split("\n")), termWidth),
          renderedMarkdown: false,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { lines: [`Diff error: ${message}`], renderedMarkdown: false };
      }
    }

    if (isMarkdown && renderMarkdown && hasCommand("glow")) {
      try {
        // Capture stderr instead of inheriting it: these failures are meant to
        // fall through silently, and an inherited write would land in the
        // alternate screen and corrupt the frame.
        const output = execFileSync("glow", glowArgs(filePath, termWidth), {
          encoding: "utf-8",
          timeout: 10000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (output.trim()) {
          return {
            lines: stripLeadingEmptyLines(output.split("\n")),
            renderedMarkdown: true,
          };
        }
      } catch {
        // Fall through to bat
      }
    }

    if (hasCommand("bat")) {
      try {
        return {
          lines: execFileSync("bat", batArgs(filePath, termWidth, true), {
            encoding: "utf-8",
            timeout: 10000,
            stdio: ["ignore", "pipe", "pipe"],
          }).split("\n"),
          renderedMarkdown: false,
        };
      } catch {
        try {
          return {
            lines: execFileSync("bat", batArgs(filePath, termWidth, false), {
              encoding: "utf-8",
              timeout: 10000,
              stdio: ["ignore", "pipe", "pipe"],
            }).split("\n"),
            renderedMarkdown: false,
          };
        } catch {
          // Fall through to raw file read
        }
      }
    }

    const raw = readFileSync(filePath, "utf-8");
    return {
      lines: raw.split("\n").map((line, i) => `${String(i + 1).padStart(4)} │ ${line}`),
      renderedMarkdown: false,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      lines: [`Error loading file: ${message}`],
      renderedMarkdown: false,
    };
  }
}
