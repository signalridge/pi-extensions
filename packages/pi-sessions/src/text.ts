import { stripVTControlCharacters } from "node:util";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const SUMMARY_BYTES = 16 * 1024;
export const PREVIEW_BYTES = 6 * 1024;
export const SHARE_BYTES = 16 * 1024;
export const ROW_LIMIT = 200;
export const PAGE_ROWS = 12;

/** Remove terminal instructions, bidi/format controls and unpaired surrogates; keep CJK and newlines. */
export function plain(text: string): string {
  return stripVTControlCharacters(text.replace(/\p{Surrogate}/gu, "")).replace(/[\p{Cc}\p{Cf}]/gu, (c) =>
    c === "\n" ? "\n" : c === "\t" ? " " : "",
  );
}

/** UTF-8 prefix, never a broken code point. Only used for unapproved previews/input context. */
export function bounded(text: string, bytes: number): string {
  let result = "";
  let used = 0;
  for (const c of text) {
    const size = Buffer.byteLength(c);
    if (used + size > bytes) break;
    result += c;
    used += size;
  }
  return result;
}

export function label(text: string, bytes = 180): string {
  return bounded(plain(text).replace(/\s+/gu, " ").trim(), bytes);
}

/** Conservative defaults, not a promise to identify every secret in prose. Human review is required. */
export function redact(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu, "[private key omitted]")
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{16,}|AKIA[A-Z0-9]{16})\b/gu, "[credential omitted]")
    .replace(
      /(\b(?:authorization|api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/giu,
      "$1[omitted]",
    );
}

export function messageText(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object" || !("type" in entry) || entry.type !== "message") return;
  if (!("message" in entry) || !entry.message || typeof entry.message !== "object") return;
  const message = entry.message;
  if (!("role" in message) || (message.role !== "user" && message.role !== "assistant")) return;
  if (!("content" in message)) return;
  const content = message.content;
  let text = typeof content === "string" ? bounded(content, 8192) : "";
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        text = bounded(`${text}${text ? "\n" : ""}${bounded(block.text, 2048)}`, 8192);
        if (Buffer.byteLength(text) >= 8192) break;
      }
    }
  }
  return `${message.role}: ${bounded(redact(plain(bounded(text, 8192))), 2048)}`;
}

export function recentText(branch: readonly SessionEntry[], maxBytes = SHARE_BYTES): string {
  const parts: string[] = [];
  let remaining = maxBytes;
  for (let index = branch.length - 1; index >= 0 && parts.length < 12 && remaining > 2; index--) {
    const text = messageText(branch[index]);
    if (text) {
      const selected = bounded(text, remaining - (parts.length ? 2 : 0));
      remaining -= Buffer.byteLength(selected) + (parts.length ? 2 : 0);
      parts.unshift(selected);
    }
  }
  return parts.join("\n\n");
}

export function validSummary(text: string): boolean {
  return !!text.trim() && Buffer.byteLength(text) <= SUMMARY_BYTES && plain(text) === text;
}
