import { createHash } from "node:crypto";
import { type BigIntStats, closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { MAX_BYTES, STATE_TYPE } from "./state.js";

type SessionReader = ExtensionContext["sessionManager"];

export const VOLATILE = "in-memory, not persistent after process exit";
export const NOT_READY = "Send an ordinary message first, or use explicit --no-session for volatile Todo state.";
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function isState(entry: SessionEntry): boolean {
  return entry.type === "custom" && entry.customType === STATE_TYPE;
}
export interface Durability {
  kind: "volatile" | "pending" | "file";
  /** Complete native records of every type, not just Todo authority. */
  committed: ReadonlySet<string>;
  conversation: boolean;
  incomplete: boolean;
}
const LINE_LIMIT = MAX_BYTES * 2;
const CHUNK_BYTES = 32 * 1024;
function identity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(":");
}
function persistedConversation(manager: SessionReader, committed: ReadonlySet<string>): boolean {
  return manager
    .getEntries()
    .some(
      (entry) =>
        entry.type === "message" &&
        (entry.message.role === "user" || entry.message.role === "assistant") &&
        committed.has(fingerprint(entry)),
    );
}

/** Read-only verification of public JSONL records, never a transaction or native rollback.
 * Unchanged file identities reuse only the disk index, never trust new native memory.
 * Scans buffer bounded lines for parsed comparison. Huge records are stream-hashed
 * as native canonical JSON with optional terminal CR, not arbitrary JSON whitespace.
 */
export class Persistence {
  private cache?: {
    manager: SessionReader;
    path: string;
    identity: string;
    header: string;
    result: Durability;
  };
  inspect(manager: SessionReader): Durability {
    const path = manager.getSessionFile();
    if (!path) return { kind: "volatile", committed: new Set(), conversation: false, incomplete: false };
    const header = manager.getHeader();
    if (!header || header.id !== manager.getSessionId())
      throw new Error("Todo unavailable: native session header mismatch.");
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        !manager
          .getEntries()
          .some((e) => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"))
      )
        return { kind: "pending", committed: new Set(), conversation: false, incomplete: false };
      throw new Error("Todo unavailable: session file is not readable; repair storage and reconcile/reload.");
    }
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile()) throw new Error("Todo unavailable: session path is not a regular file.");
      const key = identity(before);
      const headerKey = fingerprint(header);
      const cached = this.cache;
      if (
        cached &&
        cached.manager === manager &&
        cached.path === path &&
        cached.identity === key &&
        cached.header === headerKey
      ) {
        if (identity(statSync(path, { bigint: true })) !== key)
          throw new Error("Todo unavailable: session file changed during verification.");
        return { ...cached.result, conversation: persistedConversation(manager, cached.result.committed) };
      }
      const committed = new Set<string>();
      let headerSeen = false;
      let lineBytes = 0;
      let pieces: Buffer[] = [];
      let digest = createHash("sha256");
      let trailing = Buffer.alloc(0); // Hold one byte across chunks so CRLF hashes exactly like LF.
      const chunk = Buffer.alloc(CHUNK_BYTES);
      const finish = () => {
        if (trailing[0] !== 13) digest.update(trailing);
        const hash = digest.digest("hex");
        if (lineBytes <= LINE_LIMIT) {
          const line = Buffer.concat(pieces).toString("utf8");
          let entry: unknown;
          try {
            entry = JSON.parse(line);
          } catch {
            /* Incomplete/malformed records confer no authority. */
          }
          // Native JSONL accepts CRLF and legal JSON whitespace. Compare parsed
          // bounded records as we do headers/state; never parse huge messages.
          if (!headerSeen) {
            if (fingerprint(entry ?? null) !== headerKey)
              throw new Error("Todo unavailable: persisted session header mismatch.");
            headerSeen = true;
          } else if (entry && typeof entry === "object") {
            committed.add(fingerprint(entry));
          }
        } else {
          if (!headerSeen) throw new Error("Todo unavailable: oversized session header.");
          committed.add(hash);
        }
        lineBytes = 0;
        pieces = [];
        digest = createHash("sha256");
        trailing = Buffer.alloc(0);
      };
      if (before.size > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error("Todo unavailable: session file is too large to verify safely.");
      const size = Number(before.size);
      let position = 0;
      while (position < size) {
        const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
        if (!count) throw new Error("Todo unavailable: session file truncated during verification.");
        position += count;
        let start = 0;
        while (start < count) {
          const newline = chunk.indexOf(10, start);
          const end = newline >= 0 && newline < count ? newline : count;
          const piece = chunk.subarray(start, end);
          if (piece.length) {
            digest.update(trailing);
            digest.update(piece.subarray(0, -1));
            trailing = Buffer.from(piece.subarray(-1));
          }
          lineBytes += piece.length;
          if (lineBytes <= LINE_LIMIT) pieces.push(Buffer.from(piece));
          else pieces = [];
          if (end < count) finish();
          start = end + 1;
        }
      }
      if (!headerSeen) throw new Error("Todo unavailable: no complete matching session header.");
      if (identity(fstatSync(fd, { bigint: true })) !== key || identity(statSync(path, { bigint: true })) !== key)
        throw new Error("Todo unavailable: session file changed during verification.");
      const result: Durability = {
        kind: "file",
        committed,
        conversation: persistedConversation(manager, committed),
        incomplete: lineBytes > 0,
      };
      this.cache = { manager, path, identity: key, header: headerKey, result };
      return result;
    } finally {
      closeSync(fd);
    }
  }
  requireWritable(result: Durability) {
    if (result.kind === "volatile") return;
    if (!result.conversation) throw new Error(`Todo not persisted yet. ${NOT_READY}`);
    if (result.incomplete)
      throw new Error("Todo unavailable: incomplete session JSONL tail; repair storage and reconcile/reload.");
  }
  includes(result: Durability, entry: SessionEntry): boolean {
    return result.kind === "volatile" || result.committed.has(fingerprint(entry));
  }
}
