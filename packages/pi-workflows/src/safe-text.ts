/**
 * Terminal-safety for untrusted text rendered by the `/workflows` navigator.
 *
 * Task results, task errors, and run errors originate in child agent sessions, so they are
 * attacker-influenced from this package's point of view. Duplicated rather than imported:
 * extensions must not depend on another extension's source (see docs/package-boundaries.md).
 */

/** Control, escape-introducing, and bidi-override code points a terminal would act on. */
function isUnsafeTerminalCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

/**
 * Replace every code point a terminal could interpret as control input with a space.
 * Neutralizing the introducer (ESC, and the 8-bit C1 forms such as `0x9b` CSI) is what makes
 * the remainder of a sequence inert payload text rather than a command.
 */
export function sanitizeTerminalText(value: string): string {
  return [...value]
    .map((character) => (isUnsafeTerminalCodePoint(character.codePointAt(0) ?? 0) ? " " : character))
    .join("");
}

/**
 * Single-line, bounded rendering of untrusted text.
 *
 * Sanitizing strictly before truncating is load-bearing: slicing first can cut through an
 * escape sequence and leave a dangling introducer that swallows whatever the terminal draws
 * next. Slicing by code point additionally avoids splitting a surrogate pair.
 */
export function sanitizeDisplayText(value: string, maximumLength: number): string {
  if (maximumLength < 1) return "";
  const safe = sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
  return [...safe].slice(0, maximumLength).join("");
}
