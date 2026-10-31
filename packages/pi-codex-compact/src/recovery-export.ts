import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SystemMessage, Usage } from "@earendil-works/pi-ai";
import { CURRENT_SESSION_VERSION, parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  type CodexCheckpointDetails,
  fallbackSummary,
  parseCheckpointDetails,
  projectCheckpointContext,
} from "./checkpoint.js";
import { compactionError } from "./failure.js";
import { assertClosedToolPairs, type RecoveryMessage, resetHistoricalUsage } from "./recovery-snapshot.js";

const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
// Native JSONL omits optional undefined properties. Compare its persisted
// representation, never object-only metadata that cannot survive any reload.
function persisted<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
export interface RecoveryExportInput {
  cwd: string;
  sessionDir: string;
  sourceSessionId: string;
  sourceEntryIds: readonly string[];
  head: SystemMessage;
  details: CodexCheckpointDetails;
  suffix: readonly RecoveryMessage[];
  usage: Usage;
  signal: AbortSignal;
  isCurrent(): boolean;
  /** Absolute monotonic deadline checked before no-replace publication. */
  deadline?: number;
  /** Synchronous committed-success boundary, before any asynchronous cleanup. */
  onPublished?(result: RecoveryExportResult): void;
}
export interface RecoveryExportResult {
  sessionId: string;
  path: string;
  /** The complete file is usable even if its directory durability could not be confirmed. */
  durabilityConfirmed: boolean;
}

function assertDeadline(deadline: number | undefined): void {
  if (deadline !== undefined && (!Number.isFinite(deadline) || performance.now() >= deadline)) {
    throw compactionError("remote_timeout");
  }
}

function assertCurrent(input: RecoveryExportInput): void {
  input.signal.throwIfAborted();
  if (!input.isCurrent()) throw new Error("Recovery source changed");
}

/** Public append APIs construct an entirely new native graph, never a source fork. */
export function buildRecoverySession(input: RecoveryExportInput): SessionManager {
  const details = parseCheckpointDetails(input.details);
  if (!details || details.keptMessageFingerprints.length || details.retryTrimmedTail || !input.suffix.length) {
    throw new Error("Recovery requires a retain-none checkpoint and nonempty suffix");
  }
  assertClosedToolPairs(input.suffix);
  const manager = SessionManager.inMemory(input.cwd);
  if (manager.getSessionId() === input.sourceSessionId) throw new Error("Recovery identity collision");
  manager.appendMessage(persisted(input.head));
  manager.appendCompaction(fallbackSummary(details.checkpointId), null, 0, details, true, input.usage);
  for (const message of input.suffix) manager.appendMessage(persisted(resetHistoricalUsage(message)));
  // This is a fresh recovery choice, not copied automation state. Native resume
  // also infers selection from historical assistants, so our choice must be last.
  manager.appendModelChange(details.provider, details.modelId);
  validateRecoverySession(manager, input);
  return manager;
}

/** Validate the native current-format reload, not just our input objects. */
export function validateRecoverySession(manager: SessionManager, input: RecoveryExportInput): void {
  const header = manager.getHeader();
  if (
    !header ||
    header.version !== CURRENT_SESSION_VERSION ||
    header.parentSession ||
    header.cwd !== input.cwd ||
    header.id === input.sourceSessionId
  )
    throw new Error("Invalid recovery header");
  if (!/^[a-f0-9-]{36}$/u.test(header.id)) throw new Error("Invalid recovery session ID");
  const entries = manager.getEntries();
  const expectedSuffix = persisted(input.suffix.map(resetHistoricalUsage));
  if (
    entries.length !== expectedSuffix.length + 3 ||
    entries[0]?.type !== "message" ||
    !isDeepStrictEqual(entries[0].message, persisted(input.head))
  )
    throw new Error("Invalid recovery envelope");
  const checkpoint = entries[1];
  if (
    checkpoint?.type !== "compaction" ||
    checkpoint.firstKeptEntryId !== checkpoint.id ||
    checkpoint.summary !== fallbackSummary(input.details.checkpointId) ||
    !isDeepStrictEqual(parseCheckpointDetails(checkpoint.details), input.details) ||
    !isDeepStrictEqual(checkpoint.usage, input.usage)
  )
    throw new Error("Invalid recovery checkpoint");
  const sourceIds = new Set(input.sourceEntryIds);
  let parentId: string | null = null;
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry.id || ids.has(entry.id) || sourceIds.has(entry.id) || entry.parentId !== parentId) {
      throw new Error("Invalid fresh recovery lineage");
    }
    ids.add(entry.id);
    parentId = entry.id;
  }
  if (
    !isDeepStrictEqual(
      entries.slice(2, -1).map((entry) => (entry.type === "message" ? entry.message : null)),
      expectedSuffix,
    )
  ) {
    throw new Error("Recovery suffix changed");
  }
  const selection = entries.at(-1);
  if (
    selection?.type !== "model_change" ||
    selection.provider !== input.details.provider ||
    selection.modelId !== input.details.modelId ||
    !isDeepStrictEqual(manager.buildSessionContext().model, {
      provider: input.details.provider,
      modelId: input.details.modelId,
    })
  )
    throw new Error("Invalid recovery model selection");
  const replay = projectCheckpointContext(manager.buildSessionContext().messages, input.details, "full");
  if (
    replay?.filter((message) => message.role === "system").length !== 1 ||
    !isDeepStrictEqual(
      replay.filter((message) => message.role === "system")[0],
      persisted({ ...input.head, timestamp: checkpoint.systemMessage?.timestamp }),
    ) ||
    !isDeepStrictEqual(replay.filter((message) => message.role !== "system").slice(1), expectedSuffix) ||
    replay.length !== expectedSuffix.length + 2
  )
    throw new Error("Recovery canonical replay changed");
}

function sameInode(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}
function pinnedPath(path: string, identity: fs.BigIntStats, directory = false): void {
  const current = fs.lstatSync(path, { bigint: true });
  if (
    !sameInode(current, identity) ||
    current.isSymbolicLink() ||
    (directory ? !current.isDirectory() : !current.isFile())
  )
    throw new Error("Recovery staging identity changed");
}

/**
 * Pinned descriptor validation and synchronous no-replace publication. Final
 * checks detect observed swaps; portable path-based link/unlink cannot exclude
 * a malicious same-UID process racing inside the final synchronous syscalls.
 */
export async function exportRecoverySession(input: RecoveryExportInput): Promise<RecoveryExportResult> {
  // Capture before callbacks/path pinning; no input getter runs at publication.
  const deadline = input.deadline;
  assertDeadline(deadline);
  assertCurrent(input);
  if (!isAbsolute(input.cwd) || !isAbsolute(input.sessionDir)) throw new Error("Recovery needs absolute paths");
  const manager = buildRecoverySession(input);
  const header = manager.getHeader();
  if (!header) throw new Error("Missing recovery header");
  const bytes = `${[header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  if (Buffer.byteLength(bytes) > MAX_EXPORT_BYTES) throw new Error("Recovery export exceeds byte bound");
  const filename = `${header.timestamp.replace(/[:.]/g, "-")}_${header.id}.jsonl`;
  if (basename(filename) !== filename || !/^[0-9a-fTZ_-]+\.jsonl$/u.test(filename))
    throw new Error("Invalid recovery filename");
  const destination = join(input.sessionDir, filename);
  const destinationIdentity = fs.lstatSync(input.sessionDir, { bigint: true });
  pinnedPath(input.sessionDir, destinationIdentity, true);
  const dir = fs.openSync(input.sessionDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let directory: string | undefined;
  let directoryIdentity: fs.BigIntStats | undefined;
  let fileIdentity: fs.BigIntStats | undefined;
  let handle: fsPromises.FileHandle | undefined;
  try {
    if (!sameInode(fs.fstatSync(dir, { bigint: true }), destinationIdentity))
      throw new Error("Recovery directory changed");
    // Create and pin without yielding: an async creation completion must not
    // adopt a directory replaced before its first identity observation.
    directory = fs.mkdtempSync(join(input.sessionDir, ".codex-recovery-"));
    directoryIdentity = fs.lstatSync(directory, { bigint: true });
    pinnedPath(input.sessionDir, destinationIdentity, true);
    pinnedPath(directory, directoryIdentity, true);
    // No .jsonl staging name, even if a selector traverses private subdirectories.
    const staged = join(directory, "session.pending");
    assertCurrent(input);
    handle = await fsPromises.open(
      staged,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fileIdentity = await handle.stat({ bigint: true });
    pinnedPath(directory, directoryIdentity, true);
    pinnedPath(staged, fileIdentity);
    await handle.writeFile(bytes, "utf8");
    assertCurrent(input);
    await handle.sync();
    assertCurrent(input);
    const size = Buffer.byteLength(bytes);
    const descriptor = handle.fd;
    const validatedIdentity = fs.fstatSync(descriptor, { bigint: true });
    if (validatedIdentity.size !== BigInt(size)) throw new Error("Recovery staging changed");
    const unchanged = () => {
      const current = fs.fstatSync(descriptor, { bigint: true });
      if (
        !sameInode(current, validatedIdentity) ||
        current.size !== validatedIdentity.size ||
        current.mtimeNs !== validatedIdentity.mtimeNs ||
        current.ctimeNs !== validatedIdentity.ctimeNs
      )
        throw new Error("Recovery staging changed");
    };
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
      if (!bytesRead) throw new Error("Recovery staging truncated");
      offset += bytesRead;
    }
    unchanged(); // Compare against PRE-read metadata, not a post-parse baseline.
    const readBytes = buffer.toString("utf8");
    if (readBytes !== bytes) throw new Error("Recovery staging changed");
    // Parse bytes from the owned descriptor, never file-open an unchecked path:
    // native file opening may repair malformed/header-only files in place.
    const reopened = SessionManager.inMemory(input.cwd, undefined, parseSessionEntries(readBytes));
    if (
      reopened.getSessionId() !== manager.getSessionId() ||
      !isDeepStrictEqual(reopened.getEntries(), persisted(manager.getEntries()))
    )
      throw new Error("Recovery reload changed");
    validateRecoverySession(reopened, input);
    fs.fsyncSync(dir);
    assertCurrent(input); // Last user callback: path checks MUST follow it.
    pinnedPath(input.sessionDir, destinationIdentity, true);
    pinnedPath(directory, directoryIdentity, true);
    pinnedPath(staged, fileIdentity);
    unchanged();
    // Pure clock check after path validation. Publication begun in budget stays
    // successful even if its syscall/durability/cleanup finishes after deadline.
    assertDeadline(deadline);
    fs.linkSync(staged, destination); // EEXIST (including symlinks) never overwrites.
    let durabilityConfirmed = true;
    try {
      fs.fsyncSync(dir);
    } catch {
      durabilityConfirmed = false;
    }
    const result = { sessionId: manager.getSessionId(), path: destination, durabilityConfirmed };
    try {
      input.onPublished?.(result);
    } catch {
      /* Observer failure cannot undo completed publication or skip owned cleanup. */
    }
    return result;
  } finally {
    // Keep the descriptor pinned through cleanup; never recursively remove a
    // replacement directory or unlink an observed foreign file/symlink.
    try {
      if (directory && directoryIdentity) {
        pinnedPath(input.sessionDir, destinationIdentity, true);
        pinnedPath(directory, directoryIdentity, true);
        if (fileIdentity) {
          const staged = join(directory, "session.pending");
          pinnedPath(staged, fileIdentity);
          fs.unlinkSync(staged);
        }
        fs.rmdirSync(directory); // Empty only; foreign content is never removed.
      }
    } catch {
      /* Uncertain ownership leaves artifacts rather than deleting foreign data. */
    }
    try {
      await handle?.close();
    } catch {
      /* Completed publication remains usable. */
    }
    try {
      fs.closeSync(dir);
    } catch {
      /* Completed publication remains usable. */
    }
  }
}
