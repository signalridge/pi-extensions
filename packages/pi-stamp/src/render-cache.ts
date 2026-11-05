import { stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// One current value/width per mounted component, with a session-wide LRU bound.
// Snapshots contain primitives, never entry objects or historical branch data.
export const MAX_STAMP_RENDER_CACHE_ENTRIES = 1024;
export const MAX_STAMP_RENDER_CACHE_BYTES = 4 * 1024 * 1024;
export const MAX_STAMP_RENDER_VALUE_BYTES = 32 * 1024;
const MAX_SNAPSHOT_TOKENS = 256;
const OBJECT = Symbol("object");
const ARRAY = Symbol("array");
type Token = string | number | boolean | null | undefined | symbol;
export type StampRenderSnapshot = Token[];

interface Row {
  text: string;
  padding: string;
}
export interface StampForeground {
  prefix: string;
  suffix: string;
}
interface CachedValue {
  snapshot: StampRenderSnapshot;
  lines: readonly string[];
  width?: number;
  rows?: Row[];
  foreground?: StampForeground;
  bytes: number;
}

/** Value-based, bounded comparison also observes in-place nested mutations and
 * added/removed keys. Uncacheable input must go through the ordinary validator.
 * No JSON/canonical formatter keys are built on unchanged repaint paths.
 */
export function stampRenderSnapshot(data: unknown, context: Token[]): StampRenderSnapshot | undefined {
  let bytes = context.reduce<number>((sum, token) => sum + (typeof token === "string" ? token.length * 2 : 8), 0);
  if (context.length > MAX_SNAPSHOT_TOKENS || bytes > MAX_STAMP_RENDER_VALUE_BYTES) return undefined;
  const push = (token: Token): boolean => {
    bytes += typeof token === "string" ? token.length * 2 : 8;
    context.push(token);
    return context.length <= MAX_SNAPSHOT_TOKENS && bytes <= MAX_STAMP_RENDER_VALUE_BYTES;
  };
  const visit = (value: unknown, depth: number): boolean => {
    if (typeof value !== "object" || value === null) {
      return (
        (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)) && push(value as Token)
      );
    }
    if (depth > 5) return false;
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) return false;
    // Validation reads hidden own fields; metadata spreads also depend on
    // enumerability. Accessors bypass caching without extra getter invocations.
    const keys = Object.getOwnPropertyNames(value);
    if (keys.length > MAX_SNAPSHOT_TOKENS || !push(array ? ARRAY : OBJECT) || !push(keys.length)) {
      return false;
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        !push(key) ||
        !push(descriptor.enumerable) ||
        !visit(descriptor.value, depth + 1)
      )
        return false;
    }
    return true;
  };
  return visit(data, 0) ? context : undefined;
}

export class StampRenderCache {
  private values = new Map<symbol, CachedValue>();
  private bytes = 0;
  private retired = false;

  clear(retire = false): void {
    this.values.clear();
    this.bytes = 0;
    this.retired ||= retire;
  }

  delete(key: symbol): void {
    const value = this.values.get(key);
    if (value) this.bytes -= value.bytes;
    this.values.delete(key);
  }

  lines(
    key: symbol,
    snapshot: StampRenderSnapshot | undefined,
    format: () => readonly string[] | undefined,
  ): readonly string[] {
    const previous = this.values.get(key);
    if (
      !this.retired &&
      snapshot &&
      previous &&
      snapshot.length === previous.snapshot.length &&
      snapshot.every((token, index) => Object.is(token, previous.snapshot[index]))
    ) {
      this.values.delete(key);
      this.values.set(key, previous);
      return previous.lines;
    }
    this.delete(key);
    const lines = format();
    // A transient formatting failure is not a successful empty result. In
    // particular, an OS probe can fail after the snapshot's epoch was read.
    if (!lines) return [];
    if (!this.retired && snapshot) {
      const bytes =
        snapshot.reduce<number>((sum, token) => sum + (typeof token === "string" ? token.length * 2 : 8), 0) +
        lines.reduce((sum, line) => sum + line.length * 2, 0);
      this.store(key, { snapshot, lines, bytes });
    }
    return lines;
  }

  rows(key: symbol, lines: readonly string[], width: number, foreground?: StampForeground): readonly Row[] {
    const value = this.values.get(key);
    if (
      value?.lines === lines &&
      value.width === width &&
      value.rows &&
      value.foreground?.prefix === foreground?.prefix &&
      value.foreground?.suffix === foreground?.suffix
    )
      return value.rows;
    const rows = lines.flatMap((text) =>
      // Preserve Pi's ANSI-aware wrapping semantics (including whitespace-only
      // rows at very narrow widths), but retain only uncoloured wrapped text.
      wrapTextWithAnsi(`${foreground?.prefix ?? ""}${text}${foreground?.suffix ?? ""}`, width).map((line) => ({
        text: stripTerminalSequences(line),
        padding: " ".repeat(Math.max(0, width - visibleWidth(line))),
      })),
    );
    if (value?.lines === lines) {
      // Replace, never accumulate old widths.
      const oldBytes = value.rows?.reduce((sum, row) => sum + (row.text.length + row.padding.length) * 2 + 32, 0) ?? 0;
      const rowBytes = rows.reduce((sum, row) => sum + (row.text.length + row.padding.length) * 2 + 32, 0);
      const oldStyleBytes = ((value.foreground?.prefix.length ?? 0) + (value.foreground?.suffix.length ?? 0)) * 2;
      const styleBytes = ((foreground?.prefix.length ?? 0) + (foreground?.suffix.length ?? 0)) * 2;
      this.delete(key);
      this.store(key, {
        ...value,
        width,
        rows,
        foreground,
        bytes: value.bytes - oldBytes - oldStyleBytes + rowBytes + styleBytes,
      });
    }
    return rows;
  }

  private store(key: symbol, value: CachedValue): void {
    if (value.bytes > MAX_STAMP_RENDER_VALUE_BYTES) return;
    this.values.set(key, value);
    this.bytes += value.bytes;
    while (this.values.size > MAX_STAMP_RENDER_CACHE_ENTRIES || this.bytes > MAX_STAMP_RENDER_CACHE_BYTES) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }
}
