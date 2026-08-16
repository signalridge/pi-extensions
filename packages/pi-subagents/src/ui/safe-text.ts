/**
 * safe-text.ts — neutralize untrusted child-agent text before it reaches the
 * parent's terminal.
 *
 * Every preview, row and transcript line this package renders is text we did not
 * author: a subagent can read a poisoned file, fetch a hostile page, or be
 * prompt-injected into emitting cursor moves, screen clears, scroll-region
 * changes, OSC 8 hyperlinks or bidi overrides. Those bytes are interpreted by the
 * PARENT terminal, so child-derived strings are scrubbed here before any theme
 * wrapper adds our own styling — never after, or the styling would be scrubbed
 * along with the payload.
 */

/** Rendered in place of content that is not text at all. */
const BINARY_CONTENT_PLACEHOLDER = "[binary content omitted]";

/**
 * Shortest string the binary verdict applies to. Below it the placeholder costs
 * more than it saves: a handful of controls renders as a few [U+00XX] names,
 * while discarding the string hides whatever readable text sat around them —
 * six backspaces in a short tool result must not delete the result.
 */
const MIN_BINARY_VERDICT_LENGTH = 64;

/** Code units a code point occupies — astral planes advance the index by two. */
function codePointWidth(codePoint: number): 1 | 2 {
  return codePoint > 0xffff ? 2 : 1;
}

function isWhitespaceOrControl(codePoint: number): boolean {
  if (codePoint <= 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true;
  return String.fromCodePoint(codePoint).trim().length === 0;
}

/**
 * How far a scanner walks looking for a terminator. Past this the bytes are not
 * a sequence any terminal would still be parsing, and an unbounded rescan of the
 * tail per introducer would be quadratic on a hostile string.
 */
const MAX_ESCAPE_SCAN = 512;

/** Introducers that abort whatever sequence is being parsed and start their own. */
function isControlIntroducer(codePoint: number): boolean {
  return codePoint === 0x9b || codePoint === 0x90 || codePoint === 0x98
    || codePoint === 0x9d || codePoint === 0x9e || codePoint === 0x9f;
}

/**
 * Skip a control string (OSC/DCS/SOS/PM/APC) up to BEL, ST or 8-bit ST.
 *
 * Returning `start` means no terminator was found within the bound, so these
 * bytes were never a control string and the caller keeps them as literal text.
 * Consuming to the end instead would let a bare two-byte introducer delete the
 * rest of the message — display integrity traded for silent content suppression.
 */
function consumeControlString(value: string, start: number, osc: boolean): number {
  let index = start;
  let scanned = 0;
  while (index < value.length && scanned < MAX_ESCAPE_SCAN) {
    const codePoint = value.codePointAt(index) ?? 0;
    const width = codePointWidth(codePoint);
    if (osc && codePoint === 0x07) return index + width;
    if (codePoint === 0x9c) return index + width;
    if (codePoint === 0x1b) {
      // ESC \ is ST; any other ESC aborts the string, so hand the nested
      // introducer back to the dispatcher instead of eating past it.
      return value.charCodeAt(index + 1) === 0x5c ? index + 2 : index;
    }
    if (isControlIntroducer(codePoint)) return index;
    index += width;
    scanned++;
  }
  return start;
}

/** Skip a CSI sequence up to its final byte, under the same bound. */
function consumeCsi(value: string, start: number): number {
  let index = start;
  let scanned = 0;
  while (index < value.length && scanned < MAX_ESCAPE_SCAN) {
    const codePoint = value.codePointAt(index) ?? 0;
    const width = codePointWidth(codePoint);
    // A nested introducer is not a final byte even though '[' sits in the range.
    if (codePoint === 0x1b || codePoint === 0x9c || isControlIntroducer(codePoint)) return index;
    if (codePoint >= 0x40 && codePoint <= 0x7e) return index + width;
    index += width;
    scanned++;
  }
  return start;
}

/**
 * Drop every escape sequence, collapsing each to a single space.
 *
 * `collapseWhitespace` additionally folds runs of whitespace and stray controls
 * into one space, which is what single-line previews want. Multi-line callers
 * pass `false` so newlines and tabs survive for the layout code that splits on
 * them; the leftover controls are mapped by `safeTerminalText` instead.
 */
function scrubEscapeSequences(value: string, collapseWhitespace: boolean): string {
  const output: string[] = [];
  let pendingSpace = false;

  // A space is only worth emitting between two kept runs, so a leading or
  // trailing sequence disappears instead of padding the line.
  const appendSpace = (): void => {
    if (output.length > 0) pendingSpace = true;
  };
  const appendText = (text: string): void => {
    // Whitespace the source already provides stands in for the consumed
    // sequence; emitting both would widen every colorized line by a space.
    if (pendingSpace && text.trim().length > 0) output.push(" ");
    output.push(text);
    pendingSpace = false;
  };

  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index) ?? 0;
    const width = codePointWidth(codePoint);

    if (codePoint === 0x1b) {
      const next = value.charCodeAt(index + 1);
      appendSpace();
      if (next === 0x5b) {
        index = consumeCsi(value, index + 2);
        continue;
      }
      if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        index = consumeControlString(value, index + 2, next === 0x5d);
        continue;
      }
      index += Number.isNaN(next) ? 1 : 2;
      continue;
    }

    // 8-bit C1 introducers reach the terminal just as their ESC-prefixed forms do.
    if (codePoint === 0x9b) {
      appendSpace();
      index = consumeCsi(value, index + width);
      continue;
    }
    if (codePoint === 0x90 || codePoint === 0x98 || codePoint === 0x9d || codePoint === 0x9e || codePoint === 0x9f) {
      appendSpace();
      index = consumeControlString(value, index + width, codePoint === 0x9d);
      continue;
    }

    if (collapseWhitespace && isWhitespaceOrControl(codePoint)) appendSpace();
    else appendText(String.fromCodePoint(codePoint));
    index += width;
  }

  return output.join("");
}

function isUnsafeTerminalCodePoint(codePoint: number): boolean {
  const terminalControl = (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a)
    || (codePoint >= 0x7f && codePoint <= 0x9f);
  const bidiControl = codePoint === 0x061c
    || codePoint === 0x200e
    || codePoint === 0x200f
    || (codePoint >= 0x202a && codePoint <= 0x202e)
    || (codePoint >= 0x2066 && codePoint <= 0x2069);
  const privateUse = (codePoint >= 0xe000 && codePoint <= 0xf8ff)
    || (codePoint >= 0xf0000 && codePoint <= 0xffffd)
    || (codePoint >= 0x100000 && codePoint <= 0x10fffd);
  const loneSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
  const nonCharacter = (codePoint >= 0xfdd0 && codePoint <= 0xfdef)
    || (codePoint & 0xffff) === 0xfffe
    || (codePoint & 0xffff) === 0xffff;
  return terminalControl || bidiControl || privateUse || loneSurrogate || nonCharacter;
}

/**
 * Decide whether the content is binary rather than text. Runs on already-scrubbed
 * text so heavily colorized-but-legitimate tool output is not mistaken for a blob.
 */
function looksLikeBinaryContent(text: string): boolean {
  if (text.includes("\0")) return true;
  let suspiciousControls = 0;
  let replacementCharacters = 0;
  let codePoints = 0;
  for (const character of text) {
    codePoints++;
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x08 || (codePoint >= 0x0e && codePoint <= 0x1f)) suspiciousControls++;
    if (codePoint === 0xfffd) replacementCharacters++;
  }
  if (codePoints < MIN_BINARY_VERDICT_LENGTH) return false;
  return (suspiciousControls >= 4 && suspiciousControls / codePoints >= 0.1)
    || (replacementCharacters >= 3 && replacementCharacters / codePoints >= 0.1);
}

/** Surface anything still able to steer the terminal as its own code point. */
function nameUnsafeCodePoints(value: string): string {
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    safe += isUnsafeTerminalCodePoint(codePoint)
      ? `[U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}]`
      : character;
  }
  return safe;
}

/**
 * Flatten untrusted text to one inert line: escape sequences are consumed and
 * every whitespace run — newlines included — becomes a single space. Use for
 * widget rows, fleet rows and other single-line previews, which reorder just as
 * badly under a bidi override as a full transcript does.
 */
export function sanitizeDisplayText(value: string): string {
  return nameUnsafeCodePoints(scrubEscapeSequences(value, true));
}

/**
 * Make untrusted text safe to hand to the wrapping/truncation layout, keeping the
 * newlines and tabs it depends on. Escape sequences are consumed; anything still
 * able to move the cursor, reorder the line or confuse width accounting is shown
 * as its own code point.
 */
export function safeTerminalText(value: string): string {
  const scrubbed = scrubEscapeSequences(value.replace(/\r\n/g, "\n"), false);
  if (looksLikeBinaryContent(scrubbed)) return BINARY_CONTENT_PLACEHOLDER;
  return nameUnsafeCodePoints(scrubbed);
}

/**
 * Cut sanitized text to `max` code points, appending `suffix` when it had to.
 *
 * Sanitized text is still sliceable text, and `String.slice` counts UTF-16 code
 * units — cutting an emoji in half puts back exactly the lone surrogate the
 * sanitizer just named. Iterating by code point cannot split a pair.
 */
export function truncateCodePoints(value: string, max: number, suffix = "..."): string {
  if (value.length <= max) return value;  // code units bound code points
  const codePoints = [...value];
  if (codePoints.length <= max) return value;
  return codePoints.slice(0, Math.max(0, max - [...suffix].length)).join("") + suffix;
}

/**
 * Longest raw prefix worth sanitizing for a bounded preview. Scrubbing a 500KB
 * tool result to then show 500 characters of it is pure waste; the prefix is
 * kept far larger than any preview so escape-dense content still yields enough
 * readable text to fill one.
 */
export const PREVIEW_SCAN_LIMIT = 16_384;
