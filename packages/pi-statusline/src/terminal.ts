const ESC = 0x1b;
const BEL = 0x07;
const CSI = 0x9b;
const SOS = 0x98;
const ST = 0x9c;
const OSC = 0x9d;
const DCS = 0x90;
const PM = 0x9e;
const APC = 0x9f;

/**
 * Layout-preserving sanitizer contract (shared shape with pi-worktree, deliberately different from
 * pi-recall's prose contract, and duplicated per the package boundary rule):
 * - complete escape/control sequences are dropped together with their payload;
 * - line separators become one space so multi-line input cannot glue words together;
 * - every other unsafe code point (C0, DEL/C1, bidi overrides) is dropped with no replacement,
 *   because the footer is width-sensitive and a substitution would shift every later segment;
 * - whitespace is neither collapsed nor trimmed — segment spacing belongs to the renderer.
 */
export function sanitizeTerminalText(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index) ?? 0;
    const width = codePoint > 0xffff ? 2 : 1;
    if (codePoint === ESC) {
      index = skipEscapeSequence(value, index);
      continue;
    }
    if (codePoint === CSI) {
      index = skipControlSequence(value, index + width);
      continue;
    }
    // DCS/OSC/PM/APC/SOS carry a payload that must be dropped with its introducer, not rendered as text.
    if (codePoint === OSC || codePoint === DCS || codePoint === PM || codePoint === APC || codePoint === SOS) {
      index = skipStringSequence(value, index + width, codePoint === OSC);
      continue;
    }
    if (isLineSeparator(codePoint)) {
      result += " ";
      index += width;
      continue;
    }
    // Bidi overrides are dropped rather than replaced: the footer is width-sensitive and a
    // substitution would shift the layout of every segment after it.
    if (isControl(codePoint) || isBidiControl(codePoint)) {
      index += width;
      continue;
    }
    result += String.fromCodePoint(codePoint);
    index += width;
  }
  return result;
}

function skipEscapeSequence(value: string, start: number): number {
  const introducer = value.charCodeAt(start + 1);
  if (introducer === 0x5b) return skipControlSequence(value, start + 2);
  if (introducer === 0x5d) return skipStringSequence(value, start + 2, true);
  if (introducer === 0x50 || introducer === 0x58 || introducer === 0x5e || introducer === 0x5f) {
    return skipStringSequence(value, start + 2, false);
  }
  let index = start + 1;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x2f) break;
    index += 1;
  }
  const final = value.charCodeAt(index);
  return final >= 0x30 && final <= 0x7e ? index + 1 : start + 1;
}

// An introducer with no terminator is not a sequence. Scanning to end-of-string would hand an
// attacker a one-character primitive that erases the rest of the branch name or path, so the scan
// fails open: only the introducer is dropped and the tail is sanitized as ordinary text.
function skipControlSequence(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
    // Parameter and intermediate bytes only; anything else proves this is not a control sequence.
    if (code < 0x20 || code > 0x3f) return start;
  }
  return start;
}

function skipStringSequence(value: string, start: number, bellTerminates: boolean): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (bellTerminates && code === BEL) return index + 1;
    if (code === ST) return index + 1;
    if (code === ESC && value.charCodeAt(index + 1) === 0x5c) return index + 2;
  }
  return start;
}

function isLineSeparator(codePoint: number): boolean {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    codePoint === 0x85 ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  );
}

function isControl(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function isBidiControl(codePoint: number): boolean {
  return (
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}
