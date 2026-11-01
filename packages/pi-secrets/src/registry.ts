import { type LiteralSecret, type SecretPattern, type SecretSource, SOURCE_ORDER, safeLabel } from "./patterns.js";
import {
  buildPlaceholder,
  hmacDigest,
  MIN_SECRET_LENGTH,
  PLACEHOLDER_PATTERN,
  type SecretDigest,
} from "./placeholder.js";

export interface SecretRegistryOptions {
  readonly key: string;
  readonly literals: readonly LiteralSecret[];
  readonly patterns: readonly SecretPattern[];
  readonly digest?: SecretDigest;
}

const MAX_COLLISION_ATTEMPTS = 16;
type ReservedSpan = readonly [number, number];

interface Candidate {
  readonly start: number;
  readonly end: number;
  readonly label: string;
  /** Undefined for a merged span, which is derived rather than a secret of its own. */
  readonly source: SecretSource | undefined;
  /** Lower ranks win label ties: literals first, then patterns in declaration order. */
  readonly rank: number;
}

export interface TextResult {
  readonly text: string;
  readonly count: number;
}

/**
 * Maps secret values to deterministic placeholders and back. A value keeps the
 * first placeholder it receives for the registry's lifetime, so the same history
 * renders to the same bytes on every request.
 */
export class SecretRegistry {
  readonly #key: string;
  readonly #digest: SecretDigest;
  readonly #literals: readonly LiteralSecret[];
  readonly #patterns: readonly SecretPattern[];
  readonly #learned = new Map<string, { label: string; source: SecretSource; rank: number }>();
  readonly #placeholderByValue = new Map<string, string>();
  readonly #valueByPlaceholder = new Map<string, string>();
  readonly #sourceByValue = new Map<string, SecretSource>();

  constructor(options: SecretRegistryOptions) {
    this.#key = options.key;
    this.#digest = options.digest ?? hmacDigest;
    this.#literals = options.literals
      .filter((literal) => literal.value.length >= MIN_SECRET_LENGTH)
      .map((literal) => ({ ...literal, label: safeLabel(literal.label, literal.value) }));
    this.#patterns = options.patterns;
    // Register configured values up front, in order, so their labels never depend on scan order.
    for (const literal of this.#literals) this.#placeholderFor(literal.value, literal.label, literal.source);
  }

  /** Tracked distinct values per source. */
  counts(): Record<SecretSource, number> {
    const counts = Object.fromEntries(SOURCE_ORDER.map((source) => [source, 0])) as Record<SecretSource, number>;
    for (const source of this.#sourceByValue.values()) counts[source] += 1;
    return counts;
  }

  /** Learn validated pattern values without rewriting text or issuing merged-span placeholders. */
  discover(text: string): void {
    if (text.length >= MIN_SECRET_LENGTH) this.#patternCandidates(text, this.#reserved(text));
  }

  /** Replace every secret occurrence in `text` with its placeholder. */
  obfuscate(text: string): TextResult {
    if (text.length < MIN_SECRET_LENGTH) return { text, count: 0 };
    const reserved = this.#reserved(text);
    const spans = this.#select(this.#candidates(text, reserved), reserved);
    if (spans.length === 0) return { text, count: 0 };
    let out = "";
    let cursor = 0;
    for (const span of spans) {
      out += text.slice(cursor, span.start);
      out += this.#placeholderFor(text.slice(span.start, span.end), span.label, span.source);
      cursor = span.end;
    }
    return { text: out + text.slice(cursor), count: spans.length };
  }

  /** Replace placeholders this registry issued with their values; unknown placeholders stay as written. */
  restore(text: string): TextResult {
    if (!text.includes("$$")) return { text, count: 0 };
    let count = 0;
    // A replacer function, never a replacement string: values may contain `$&` or `$$`.
    const restored = text.replace(PLACEHOLDER_PATTERN, (placeholder) => {
      const value = this.#valueByPlaceholder.get(placeholder);
      if (value === undefined) return placeholder;
      count += 1;
      return value;
    });
    return { text: restored, count };
  }

  #placeholderFor(value: string, label: string, source: SecretSource | undefined): string {
    const existing = this.#placeholderByValue.get(value);
    if (existing !== undefined) return existing;
    label = safeLabel(label, value);
    let attempt = 0;
    let placeholder = buildPlaceholder(this.#digest, this.#key, label, value, attempt);
    while (this.#valueByPlaceholder.has(placeholder)) {
      attempt += 1;
      // Unreachable with HMAC-SHA256; a broken digest must fail closed, not spin.
      if (attempt > MAX_COLLISION_ATTEMPTS) throw new Error("secret placeholder digest keeps colliding");
      placeholder = buildPlaceholder(this.#digest, this.#key, label, value, attempt);
    }
    this.#placeholderByValue.set(value, placeholder);
    this.#valueByPlaceholder.set(placeholder, value);
    if (source !== undefined) this.#sourceByValue.set(value, source);
    return placeholder;
  }

  // Snapshot verified issued spans before discovery: they must not become
  // new pattern secrets (for example a placeholder in a URL password field).
  #reserved(text: string): ReservedSpan[] {
    return text.includes("$$")
      ? [...text.matchAll(PLACEHOLDER_PATTERN)]
          .filter((match) => this.#valueByPlaceholder.has(match[0]))
          .map((match) => [match.index, match.index + match[0].length] as const)
      : [];
  }

  #patternCandidates(text: string, reserved: readonly ReservedSpan[]): Candidate[] {
    const candidates: Candidate[] = [];
    let lower: string | undefined;
    const lowercase = (): string => {
      lower ??= text.toLowerCase();
      return lower;
    };
    this.#patterns.forEach((pattern, index) => {
      if (pattern.prefixes !== undefined) {
        const haystack = pattern.regex.flags.includes("i") ? lowercase() : text;
        if (!pattern.prefixes.some((prefix) => haystack.includes(prefix))) return;
      }
      for (const match of text.matchAll(pattern.regex)) {
        let start = match.index;
        let end = match.index + match[0].length;
        if (pattern.group !== undefined) {
          const span = match.indices?.[pattern.group];
          if (span === undefined) continue;
          [start, end] = span;
        }
        if (end - start < MIN_SECRET_LENGTH) continue;
        if (reserved.some(([from, to]) => start < to && from < end)) continue;
        if (pattern.accept && !pattern.accept(text.slice(start, end))) continue;
        const value = text.slice(start, end);
        let learned = this.#learned.get(value);
        if (!learned) {
          learned = {
            label: safeLabel(pattern.label, value),
            source: pattern.source,
            rank: this.#literals.length + index,
          };
          this.#learned.set(value, learned);
          this.#placeholderFor(value, learned.label, learned.source);
        }
        candidates.push({ start, end, ...learned });
      }
    });
    return candidates;
  }

  #candidates(text: string, reserved: readonly ReservedSpan[]): Candidate[] {
    // Standalone obfuscation also learns contextual captures before literal scanning.
    const candidates = this.#patternCandidates(text, reserved);
    const literals = [
      ...this.#literals.map((literal, rank) => ({ ...literal, rank })),
      ...[...this.#learned].map(([value, metadata]) => ({ value, ...metadata })),
    ];
    for (const { value, label, source, rank } of literals) {
      for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
        candidates.push({ start: at, end: at + value.length, label, source, rank });
      }
    }
    return candidates;
  }

  /**
   * Drop candidates inside verified placeholders issued by this registry, then merge overlapping candidates
   * into one span: replacing only the first of two overlapping secrets would
   * leave the tail of the second in clear text. A merged span gets its own
   * placeholder, so it restores losslessly, but is not counted as a source.
   */
  #select(candidates: Candidate[], reserved: readonly ReservedSpan[]): Candidate[] {
    if (candidates.length === 0) return [];
    const open = candidates
      .filter((candidate) => !reserved.some(([start, end]) => candidate.start < end && start < candidate.end))
      .sort((a, b) => a.start - b.start || b.end - a.end || a.rank - b.rank);
    const merged: Candidate[] = [];
    for (const candidate of open) {
      const last = merged.at(-1);
      if (last === undefined || candidate.start >= last.end) {
        merged.push(candidate);
        continue;
      }
      if (candidate.end <= last.end) continue;
      const lead = candidate.rank < last.rank ? candidate : last;
      merged[merged.length - 1] = {
        ...lead,
        start: last.start,
        end: candidate.end,
        source: undefined,
      };
    }
    return merged;
  }
}
