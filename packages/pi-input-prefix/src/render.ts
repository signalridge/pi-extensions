import { visibleWidth } from "@earendil-works/pi-tui";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR sequences are intentionally removed.
const ANSI_SGR = /\u001B\[[0-9;]*m/g;

/** Zero-width marker used by pi-tui to place the hardware cursor for IME. */
export const HARDWARE_CURSOR_MARKER = "\x1b_pi:c\x07";

/**
 * Zero-width markers pi-tui 1.2+ draws around the cell shown as the software
 * cursor; the TUI turns them into reverse video (or drops them when only the
 * hardware cursor is shown). Earlier hosts emitted reverse-video SGR directly.
 * Defined here rather than imported so older hosts still load this module.
 */
export const FAKE_CURSOR_START = "\x1b_pi:fc\x07";
export const FAKE_CURSOR_END = "\x1b_pi:/fc\x07";
const ZERO_WIDTH_MARKERS = [HARDWARE_CURSOR_MARKER, FAKE_CURSOR_START, FAKE_CURSOR_END];

/** Prompt glyph used whenever the configured override is absent or unusable. */
const DEFAULT_PROMPT_MARKER = ">";

/**
 * Resolve the prompt glyph from its configured override.
 *
 * The overlay reserves exactly one column, so whatever is returned must measure
 * one cell or Pi's cursor math desynchronises. Three candidates are tried in
 * order of fidelity to what the user configured:
 *
 * 1. the first grapheme cluster, so a decomposed `é` keeps its accent and a
 *    non-BMP glyph such as `𝄞` is not split into a lone surrogate;
 * 2. its first code point, which recovers the base glyph when a variation
 *    selector widens the cluster to two cells (`✔️` still renders as `✔`);
 * 3. the default, for anything genuinely wide — a CJK glyph, a ZWJ sequence.
 */
export function resolvePromptMarker(configured: string | undefined): string {
  const source = configured || DEFAULT_PROMPT_MARKER;
  const cluster = firstGraphemeCluster(source);
  if (visibleWidth(cluster) === 1) return cluster;
  const codePoint = [...cluster][0] ?? DEFAULT_PROMPT_MARKER;
  return visibleWidth(codePoint) === 1 ? codePoint : DEFAULT_PROMPT_MARKER;
}

function firstGraphemeCluster(value: string): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { segment } of segmenter.segment(value)) return segment;
  return DEFAULT_PROMPT_MARKER;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: Pi's shell prompt marker is ANSI encoded.
const INVERSE_BANG = /^\x1b\[7m!\x1b\[(?:0|27)m/;
const FAKE_CURSOR_BANG = `${FAKE_CURSOR_START}!${FAKE_CURSOR_END}`;
const EDITOR_LEFT_PADDING = "    ";

export type Paint = (text: string) => string;

export interface DetachedShellPrompt {
  line: string;
  cursorOnPrompt: boolean;
  /** The cursor on the bang used pi-tui's software-cursor markers, not inline reverse video. */
  fakeCursor: boolean;
  hardwareCursorMarker: string;
  detached: boolean;
}

function stripSgr(text: string): string {
  return text.replace(ANSI_SGR, "");
}

/**
 * Remove Pi's semantic leading `!` from the rendered content row so it can be
 * displayed as a prompt token without changing the editor buffer.
 * The removed cell is restored at the right edge to preserve rendered width.
 */
export function detachLeadingShellBang(line: string): DetachedShellPrompt {
  if (!line.startsWith(EDITOR_LEFT_PADDING)) {
    return {
      line,
      cursorOnPrompt: false,
      fakeCursor: false,
      hardwareCursorMarker: "",
      detached: false,
    };
  }

  const prefix = line.slice(0, EDITOR_LEFT_PADDING.length);
  const originalRest = line.slice(EDITOR_LEFT_PADDING.length);
  let rest = originalRest;
  let hardwareCursorMarker = "";

  if (rest.startsWith(HARDWARE_CURSOR_MARKER)) {
    hardwareCursorMarker = HARDWARE_CURSOR_MARKER;
    rest = rest.slice(HARDWARE_CURSOR_MARKER.length);
  }

  if (rest.startsWith(FAKE_CURSOR_BANG)) {
    return {
      line: `${prefix + rest.slice(FAKE_CURSOR_BANG.length)} `,
      cursorOnPrompt: true,
      fakeCursor: true,
      hardwareCursorMarker,
      detached: true,
    };
  }

  const cursorBang = rest.match(INVERSE_BANG);
  if (cursorBang?.[0]) {
    return {
      line: `${prefix + rest.slice(cursorBang[0].length)} `,
      cursorOnPrompt: true,
      fakeCursor: false,
      hardwareCursorMarker,
      detached: true,
    };
  }

  if (hardwareCursorMarker === "" && rest.startsWith("!")) {
    return {
      line: `${prefix + rest.slice(1)} `,
      cursorOnPrompt: false,
      fakeCursor: false,
      hardwareCursorMarker: "",
      detached: true,
    };
  }

  return {
    line,
    cursorOnPrompt: false,
    fakeCursor: false,
    hardwareCursorMarker: "",
    detached: false,
  };
}

/**
 * Overlay a one-cell prompt symbol at column 2 while preserving Pi's editor
 * layout and cursor math. Requires the editor to use at least four columns of
 * horizontal padding.
 */
export function injectPromptSymbol(line: string, symbol: string): string | undefined {
  if (!line.startsWith(EDITOR_LEFT_PADDING)) return undefined;
  return `  ${symbol} ${line.slice(EDITOR_LEFT_PADDING.length)}`;
}

function stripVisualControls(text: string): string {
  return ZERO_WIDTH_MARKERS.reduce((plain, marker) => plain.replaceAll(marker, ""), stripSgr(text));
}

function mapVisibleIndexToRaw(line: string, visibleIndex: number): number {
  const sgrAtCursor = new RegExp(ANSI_SGR.source, "y");
  let rawIndex = 0;
  let visibleCount = 0;

  while (rawIndex < line.length && visibleCount < visibleIndex) {
    const marker = ZERO_WIDTH_MARKERS.find((candidate) => line.startsWith(candidate, rawIndex));
    if (marker !== undefined) {
      rawIndex += marker.length;
      continue;
    }

    sgrAtCursor.lastIndex = rawIndex;
    const sgr = sgrAtCursor.exec(line);
    if (sgr !== null) {
      rawIndex += sgr[0].length;
      continue;
    }

    rawIndex++;
    visibleCount++;
  }

  return rawIndex;
}

/** Bold-colour the leading slash-command token with the supplied theme painter. */
export function highlightLeadingSlashToken(line: string, paint: Paint): string | undefined {
  const visible = stripVisualControls(line);
  const slashIndex = visible.indexOf("/");
  if (slashIndex < 0) return undefined;

  for (let index = 0; index < slashIndex; index++) {
    if (visible[index] !== " " && visible[index] !== "\t") return undefined;
  }

  let tokenEnd = slashIndex + 1;
  while (tokenEnd < visible.length) {
    const character = visible[tokenEnd];
    if (character === " " || character === "\t") break;
    tokenEnd++;
  }

  const rawStart = mapVisibleIndexToRaw(line, slashIndex);
  const rawEnd = mapVisibleIndexToRaw(line, tokenEnd);
  return line.slice(0, rawStart) + paint(line.slice(rawStart, rawEnd)) + line.slice(rawEnd);
}

/**
 * Turn pi-tui's horizontal editor rules into a rounded full border.
 * Content and autocomplete rows retain their existing theme styling; only the
 * outer cells are replaced.
 */
export function wrapWithRoundedBorder(
  lines: string[],
  paint: Paint,
  options: { readonly label?: string } = {},
): string[] {
  let seenTop = false;

  return lines.map((line) => {
    const plain = stripSgr(line);
    if (plain.length > 0 && plain[0] === "─") {
      const isTop = !seenTop;
      const leftCorner = seenTop ? "╰" : "╭";
      const rightCorner = seenTop ? "╯" : "╮";
      seenTop = true;

      if (plain.length === 1) return paint(leftCorner);

      const middle = plain.slice(1, -1);
      if (isTop && options.label !== undefined && /^─+$/.test(middle)) {
        const labelWidth = stripSgr(options.label).length;
        if (labelWidth <= middle.length) {
          return paint(leftCorner) + options.label + paint("─".repeat(middle.length - labelWidth)) + paint(rightCorner);
        }
      }

      return paint(leftCorner + middle + rightCorner);
    }

    if (line.length === 0) return line;

    const first = line[0];
    const last = line.at(-1);
    const head = first === " " ? paint("│") : (first ?? "");
    const tail = line.length > 1 && last === " " ? paint("│") : (last ?? "");
    if (line.length === 1) return head;
    return head + line.slice(1, -1) + tail;
  });
}
