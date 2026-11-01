/** UTF-16 offsets, excluding LF, CRLF and lone CR from line contents. */
export function textLines(text: string): Array<{ start: number; end: number }> {
  const lines: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "\r" && text[index] !== "\n") continue;
    lines.push({ start, end: index });
    if (text[index] === "\r" && text[index + 1] === "\n") index++;
    start = index + 1;
  }
  lines.push({ start, end: text.length });
  return lines;
}

export function splitLines(text: string): string[] {
  return textLines(text).map(({ start, end }) => text.slice(start, end));
}
