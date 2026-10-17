import { decodeKittyPrintable, isKeyRelease, parseKey } from "@earendil-works/pi-tui";

const BEGIN = "\x1b[200~";
const END = "\x1b[201~";

/** Decode character commands without collapsing Ctrl/Alt/Super or Shift case. */
export function commandCharacter(data: string): string | undefined {
  if (isKeyRelease(data)) return undefined;
  const printable = decodeKittyPrintable(data) ?? (data.length === 1 ? data : undefined);
  // CSI-u may omit the shifted alternate codepoint (e.g. Shift+d => 100;2u).
  return parseKey(data)?.startsWith("shift+") ? printable?.toUpperCase() : printable;
}

/** Task-form input boundary. Keep native key semantics and atomic paste Undo,
 * but never insert untrusted paste controls into a native Input/Editor. */
export class DraftInput {
  private prefix = "";
  private paste: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  constructor(
    private readonly clean: (text: string) => string,
    private readonly dispatch: (data: string, paste: boolean) => void,
  ) {}
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.prefix = "";
    this.paste = undefined;
  }
  handleInput(data: string): void {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const prefix = this.prefix;
    let remaining = prefix + data;
    this.prefix = "";
    // A following complete key disambiguates Escape from a partial paste marker.
    if (prefix && !BEGIN.startsWith(remaining) && !remaining.startsWith(BEGIN)) {
      this.key(prefix);
      remaining = data;
    }
    while (remaining && !this.disposed) {
      if (this.paste !== undefined) {
        this.paste += remaining;
        const end = this.paste.indexOf(END);
        if (end < 0) return;
        const text = this.clean(this.paste.slice(0, end).replace(/\r\n?/gu, "\n").replace(/\t/gu, "    "));
        remaining = this.paste.slice(end + END.length);
        this.paste = undefined;
        if (text) this.dispatch(`${BEGIN}${text}${END}`, true);
        continue;
      }
      const begin = remaining.indexOf(BEGIN);
      if (begin >= 0) {
        this.key(remaining.slice(0, begin));
        remaining = remaining.slice(begin + BEGIN.length);
        this.paste = "";
        continue;
      }
      let size = Math.min(remaining.length, BEGIN.length - 1);
      while (size && !BEGIN.startsWith(remaining.slice(-size))) size--;
      this.key(remaining.slice(0, remaining.length - size));
      if (size && !this.disposed) {
        this.prefix = remaining.slice(-size);
        this.timer = setTimeout(() => {
          const key = this.prefix;
          this.prefix = "";
          this.timer = undefined;
          this.key(key);
        }, 30);
        this.timer.unref();
      }
      return;
    }
  }
  private key(data: string): void {
    if (!data || this.disposed) return;
    // Preserve public native keyboard decoding, rejecting unsafe encoded text
    // before it can enter Undo or a renderable value.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal keyboard protocol
    const modified = /^\x1b\[27;\d+;(\d+)~$/u.exec(data);
    const code = modified ? Number(modified[1]) : -1;
    const printable =
      decodeKittyPrintable(data) ?? (code >= 32 && code <= 0x10ffff ? String.fromCodePoint(code) : undefined);
    if (printable !== undefined) {
      if (printable === "\x7f" || this.clean(printable) === printable) this.dispatch(data, false);
      return;
    }
    const safe = data.charCodeAt(0) < 32 || data.charCodeAt(0) === 127 ? data : this.clean(data);
    if (safe) this.dispatch(safe, false);
  }
}
