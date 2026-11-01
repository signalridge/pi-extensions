/**
 * Text that reaches the terminal inside an OSC escape sequence — the tab title
 * and desktop notifications — is not just untrusted display text: a BEL or ST
 * inside it terminates the sequence early and the remainder lands on the
 * terminal as commands. Neutralize every C0/C1 control and bidi override, then
 * collapse the whitespace that leaves behind.
 *
 * Duplicated rather than shared, per the package boundary rule; `pi-stamp`'s
 * metadata sanitizer is the reference shape.
 */
export function sanitizeTitleText(value: string): string {
  let safe = "";
  for (const character of value) {
    safe += isUnsafeTerminalCodePoint(character.codePointAt(0) ?? 0) ? " " : character;
  }
  return safe.replace(/\s+/gu, " ").trim();
}

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
