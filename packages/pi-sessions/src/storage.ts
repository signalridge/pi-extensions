import { createHash, randomUUID } from "node:crypto";
import { constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type FileHandle, open, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
  buildSessionProjection,
  CURRENT_SESSION_VERSION,
  estimateTokens,
  migrateSessionEntries,
  type SessionEntry,
  type SessionHeader,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { validateEntryPayload } from "./session-payload.js";
import { bounded, messageText, PREVIEW_BYTES } from "./text.js";

const FILE_BYTES = 32 * 1024 * 1024;
const LINE_BYTES = 4 * 1024 * 1024;
const ENTRY_TYPES = new Set([
  "message",
  "model_change",
  "thinking_level_change",
  "usage",
  "compaction",
  "branch_summary",
  "custom",
  "label",
  "custom_message",
  "context_edit",
  "session_info",
]);
export interface Candidate {
  path: string;
  header: SessionHeader;
  digest: string;
  preview: string;
  entries: readonly SessionEntry[];
}

/** Read through a fixed byte budget, even if an external writer grows the file.
 * The extra byte is only an oversize probe; check cancellation between chunks. */
async function readBounded(handle: FileHandle, signal: AbortSignal): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= FILE_BYTES) {
    signal.throwIfAborted();
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, FILE_BYTES + 1 - total));
    const { bytesRead } = await handle.read({ buffer, offset: 0, length: buffer.length, position: total });
    signal.throwIfAborted();
    if (!bytesRead) break;
    total += bytesRead;
    if (total > FILE_BYTES) throw new Error("Oversized session");
    chunks.push(buffer.subarray(0, bytesRead));
  }
  const bytes = Buffer.concat(chunks, total);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error("Invalid UTF-8 session");
  return text;
}

/** Vet without opening a SessionManager (which can initialize/rewrite malformed files).
 * Limits apply to our validation/preview, not to the SDK's list implementation. */
export async function vetSession(path: string, expectedId: string, signal: AbortSignal): Promise<Candidate> {
  signal.throwIfAborted();
  if (!isAbsolute(path)) throw new Error("Session path must be absolute");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !before.size || before.size > FILE_BYTES)
      throw new Error("Unreadable or oversized session");
    const body = await readBounded(handle, signal);
    signal.throwIfAborted();
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error("Session changed while reading");
    const lines = body.trimEnd().split("\n");
    let header: SessionHeader | undefined;
    const recent: string[] = [];
    const ids = new Set<string>();
    const entries: SessionEntry[] = [];
    const byId = new Map<string, SessionEntry>();
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (Buffer.byteLength(line) > LINE_BYTES) throw new Error("Oversized session entry");
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value) || !("type" in value))
        throw new Error("Malformed session entry");
      if (index === 0) {
        if (
          value.type !== "session" ||
          !("id" in value) ||
          value.id !== expectedId ||
          !("cwd" in value) ||
          typeof value.cwd !== "string" ||
          !isAbsolute(value.cwd) ||
          !("timestamp" in value) ||
          typeof value.timestamp !== "string" ||
          !Number.isFinite(Date.parse(value.timestamp)) ||
          !("version" in value) ||
          (value.version !== 2 && value.version !== CURRENT_SESSION_VERSION)
        ) {
          throw new Error("Session identity/header no longer matches");
        }
        header = value as SessionHeader;
      } else {
        if (
          typeof value.type !== "string" ||
          !ENTRY_TYPES.has(value.type) ||
          !("id" in value) ||
          typeof value.id !== "string" ||
          !value.id ||
          ids.has(value.id) ||
          !("parentId" in value) ||
          (value.parentId !== null && (typeof value.parentId !== "string" || !ids.has(value.parentId))) ||
          !("timestamp" in value) ||
          typeof value.timestamp !== "string" ||
          !Number.isFinite(Date.parse(value.timestamp))
        )
          throw new Error("Malformed session tree");
        entries.push(value as SessionEntry);
        ids.add(value.id);
      }
    }
    if (!header) throw new Error("Missing session header");
    // Migrations mutate their argument. Keep raw header/bytes for identity and
    // digest, and normalize only a clone before native payload validation.
    const normalized = structuredClone([header, ...entries]);
    migrateSessionEntries(normalized);
    const migrated = normalized.slice(1) as SessionEntry[];
    for (const entry of migrated) {
      validateEntryPayload(entry as unknown as Record<string, unknown>, byId);
      byId.set(entry.id, entry);
      const text = messageText(entry);
      if (text) {
        recent.push(text);
        if (recent.length > 6) recent.shift();
      }
    }
    // Public pure replay and estimation exercise the footer's consumed shape,
    // not just projection. Never open/repair a manager during preflight.
    const projection = buildSessionProjection(migrated, undefined, byId);
    const system = getCurrentSystemMessage(projection.messages);
    if (system) estimateTokens(system);
    for (const message of projection.messages) if (message.role !== "system") estimateTokens(message);
    if (!(await stat(header.cwd)).isDirectory()) throw new Error("Session workspace unavailable");
    signal.throwIfAborted();
    return {
      path: resolve(path),
      header,
      digest: createHash("sha256").update(body).digest("hex"),
      preview: bounded(recent.join("\n\n"), PREVIEW_BYTES),
      entries: migrated,
    };
  } finally {
    await handle.close();
  }
}

export interface Snapshot {
  path: string;
  id: string;
  cleanup(): void;
}
export function snapshotBranch(cwd: string, branch: readonly SessionEntry[], parentSession?: string): Snapshot {
  const directory = mkdtempSync(join(tmpdir(), "pi-sessions-parent-"));
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  try {
    const id = randomUUID();
    const path = join(directory, `${id}.jsonl`);
    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id,
      cwd,
      timestamp: new Date().toISOString(),
      ...(parentSession ? { parentSession } : {}),
    };
    writeFileSync(path, `${[header, ...structuredClone(branch)].map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return { path, id, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Pi 1.0.4 defers custom-only sessions until the first human turn. Materialize
 * exactly the public native header/entries, then re-open through the public API
 * to keep subsequent append persistence coherent. No synthetic model message. */
export function persistHandoff(manager: SessionManager): string {
  let path = manager.getSessionFile();
  if (!path) {
    const directory = mkdtempSync(join(tmpdir(), "pi-sessions-handoff-"));
    path = join(directory, `${manager.getSessionId()}.jsonl`);
  }
  const header = manager.getHeader();
  if (!header) throw new Error("Missing destination header");
  const entries = manager.getEntries();
  // Never remove a file after native replacement: it may already be the only
  // recovery record. Exclusive creation cannot overwrite pre-existing history.
  writeFileSync(path, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  manager.setSessionFile(path);
  return path;
}
