/** Atomic agent-file mutations and cooperative locking using only Node APIs. */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function tempPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
}


function recoveryPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.recovery`);
}

function reserveTempFile(path: string, mode: number): { path: string; fd: number } {
  for (let attempt = 0; attempt < 8; attempt++) {
    const tempPath = tempPathFor(path);
    try {
      return { path: tempPath, fd: openSync(tempPath, "wx", mode) };
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  throw new Error(`Unable to create a unique temporary file beside ${path}`);
}

function assertSourceMatches(path: string, expectedSource: string): void {
  try {
    if (readFileSync(path, "utf-8") === expectedSource) return;
  } catch {
    // Treat disappearance or an unreadable replacement as a conflict too.
  }
  throw new Error(`Refusing to modify ${path}: source changed since it was read`);
}

function writeAndFlush(fd: number, content: string, mode?: number): void {
  // Existing-file replacements pass the exact original mode. New files leave
  // the mode returned by openSync untouched so the process umask is honored.
  if (mode !== undefined) fchmodSync(fd, mode);
  const bytes = Buffer.from(content, "utf-8");
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(fd, bytes, offset, bytes.length - offset, null);
  }
  fsyncSync(fd);
  closeSync(fd);
}

const LOCK_OWNER_PREFIX = "owner-";
const FILE_LOCK_MAX_ATTEMPTS = 12;
const FILE_LOCK_RETRY_DELAY_MS = 25;

interface FileMutationLock {
  lockPath: string;
  ownerPath: string;
  token: string;
  directoryIdentity: { dev: number; ino: number };
}

/** The package-local, non-expiring lock directory used by agent-file mutations. */
export function agentFileLockPath(path: string): string {
  return `${path}.lock`;
}

function ownerFileName(token: string): string {
  // The token is generated locally, but keep this path-safe so diagnostics and
  // future callers cannot turn the owner path into a nested path.
  return `${LOCK_OWNER_PREFIX}${token.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function lockOwnerNames(lockPath: string): string[] {
  try {
    return readdirSync(lockPath)
      .filter(name => name.startsWith(LOCK_OWNER_PREFIX))
      .sort();
  } catch {
    return [];
  }
}

/** Describe token owners without reading untrusted owner-file contents. */
function describeLockOwnership(lockPath: string): string {
  try {
    const owners = readdirSync(lockPath)
      .filter(name => name.startsWith(LOCK_OWNER_PREFIX))
      .sort();
    if (owners.length === 0) return "no token owner file is present (the lock may be incomplete or orphaned)";
    const shown = owners.slice(0, 8).map(name => JSON.stringify(name));
    const suffix = owners.length > shown.length ? `, … and ${owners.length - shown.length} more` : "";
    return `token owner file(s): ${shown.join(", ")}${suffix}`;
  } catch (error: unknown) {
    return `token ownership could not be enumerated (${errorCode(error) ?? "unreadable lock directory"})`;
  }
}

/**
 * Return a token-specific owner path. With no token, resolve the sole owner in
 * an existing lock directory for diagnostics and tests; there is deliberately
 * no generic owner filename on disk.
 */
export function agentFileLockOwnerPath(path: string, token?: string): string {
  const lockPath = agentFileLockPath(path);
  if (token !== undefined) return join(lockPath, ownerFileName(token));
  const owners = lockOwnerNames(lockPath);
  if (owners.length === 1) return join(lockPath, owners[0]!);
  return join(lockPath, `${LOCK_OWNER_PREFIX}unknown`);
}

function directoryIdentity(path: string): { dev: number; ino: number } {
  const stats = statSync(path);
  return { dev: stats.dev, ino: stats.ino };
}

function verifyLockDirectory(lock: FileMutationLock): void {
  let current: { dev: number; ino: number };
  try {
    current = directoryIdentity(lock.lockPath);
  } catch (error: unknown) {
    throw new Error(
      `Cannot release agent-file lock at ${lock.lockPath}: cannot verify its identity; ` +
      `the lock was left in place for inspection/removal.`,
      { cause: error },
    );
  }
  if (current.dev !== lock.directoryIdentity.dev || current.ino !== lock.directoryIdentity.ino) {
    throw new Error(
      `Cannot release agent-file lock at ${lock.lockPath}: its directory identity changed; ` +
      `refusing to remove another owner's lock. Inspect and remove the lock manually if needed.`,
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function manualLockRecovery(lockPath: string): string {
  return `Manual cleanup (only after verifying the lock is orphaned): rm -rf -- ${shellQuote(lockPath)}`;
}

function lockUnavailable(path: string, lockPath: string): Error {
  return new Error(
    `Cannot acquire cooperative agent-file lock for ${path} at ${lockPath}: ` +
    `${describeLockOwnership(lockPath)}; another writer may hold it or it may be orphaned. ` +
    `${manualLockRecovery(lockPath)}`,
  );
}

interface DeadLockCandidate {
  lockPath: string;
  ownerPath: string;
  token: string;
  directoryIdentity: { dev: number; ino: number };
  pid: number;
}

function isDeadProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    return errorCode(error) === "ESRCH";
  }
}

/**
 * Return a reclaim candidate only when the lock has one well-formed owner,
 * that owner names the exact token file, and its PID is provably gone.
 */
function inspectDeadLock(lockPath: string): DeadLockCandidate | undefined {
  let identity: { dev: number; ino: number };
  try {
    const stats = lstatSync(lockPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return undefined;
    identity = { dev: stats.dev, ino: stats.ino };
  } catch {
    return undefined;
  }

  const owners = lockOwnerNames(lockPath);
  if (owners.length !== 1) return undefined;
  const ownerName = owners[0]!;
  const ownerPath = join(lockPath, ownerName);
  if (!ownerName.startsWith(LOCK_OWNER_PREFIX)) return undefined;

  let token: string;
  try {
    const ownerStats = lstatSync(ownerPath);
    if (!ownerStats.isFile() || ownerStats.isSymbolicLink()) return undefined;
    token = readFileSync(ownerPath, "utf-8");
  } catch {
    return undefined;
  }
  if (ownerFileName(token) !== ownerName) return undefined;

  const match = /^(\d+):([A-Za-z0-9_-]+)$/.exec(token);
  if (!match) return undefined;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 1 || !isDeadProcess(pid)) return undefined;

  return { lockPath, ownerPath, token, directoryIdentity: identity, pid };
}

/** Remove only the verified dead owner's token and then its empty lock directory. */
function reclaimDeadLock(lockPath: string): boolean {
  const candidate = inspectDeadLock(lockPath);
  if (!candidate) return false;

  try {
    const current = directoryIdentity(candidate.lockPath);
    if (current.dev !== candidate.directoryIdentity.dev || current.ino !== candidate.directoryIdentity.ino) return false;
    if (lockOwnerNames(candidate.lockPath).length !== 1) return false;
    if (readFileSync(candidate.ownerPath, "utf-8") !== candidate.token) return false;
    unlinkSync(candidate.ownerPath);
    const afterUnlink = directoryIdentity(candidate.lockPath);
    if (afterUnlink.dev !== candidate.directoryIdentity.dev || afterUnlink.ino !== candidate.directoryIdentity.ino) return false;
    if (readdirSync(candidate.lockPath).length !== 0) return false;
    rmdirSync(candidate.lockPath);
    return true;
  } catch {
    return false;
  }
}

async function acquireFileMutationLock(path: string): Promise<FileMutationLock> {
  const lockPath = agentFileLockPath(path);
  const token = `${process.pid}:${randomUUID()}`;
  const ownerPath = agentFileLockOwnerPath(path, token);

  for (let attempt = 0; attempt < FILE_LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      // mkdir is the atomic ownership claim. An existing lock is reclaimed only
      // after exact token/PID verification proves that its owner is dead.
      mkdirSync(lockPath, { mode: 0o700 });
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (reclaimDeadLock(lockPath)) {
        attempt--;
        continue;
      }
      if (attempt === FILE_LOCK_MAX_ATTEMPTS - 1) throw lockUnavailable(path, lockPath);
      await new Promise<void>((resolve) => setTimeout(resolve, FILE_LOCK_RETRY_DELAY_MS));
      continue;
    }

    try {
      writeFileSync(ownerPath, token, { encoding: "utf-8", flag: "wx", mode: 0o600 });
      chmodSync(ownerPath, 0o600);
      return {
        lockPath,
        ownerPath,
        token,
        directoryIdentity: directoryIdentity(lockPath),
      };
    } catch (error: unknown) {
      throw new Error(
        `Cannot initialize cooperative agent-file lock at ${lockPath}; ` +
        `${describeLockOwnership(lockPath)}. ${manualLockRecovery(lockPath)}`,
        { cause: error },
      );
    }
  }

  throw lockUnavailable(path, lockPath);
}

function releaseFileMutationLock(lock: FileMutationLock): void {
  verifyLockDirectory(lock);

  let ownerToken: string;
  try {
    ownerToken = readFileSync(lock.ownerPath, "utf-8");
  } catch (error: unknown) {
    throw new Error(
      `Cannot release agent-file lock at ${lock.lockPath}: cannot verify token ${basename(lock.ownerPath)}; ` +
      `${describeLockOwnership(lock.lockPath)}. The lock was left in place for inspection/removal.`,
      { cause: error },
    );
  }
  if (ownerToken !== lock.token) {
    throw new Error(
      `Cannot release agent-file lock at ${lock.lockPath}: owner token mismatch at ${basename(lock.ownerPath)}; ` +
      `refusing to remove another owner's lock. Inspect and remove it manually if needed.`,
    );
  }

  // The owner filename contains the unguessable token. Even if this directory
  // is removed and replaced after the checks above, unlinking this path cannot
  // remove a replacement owner's different token file.
  try {
    unlinkSync(lock.ownerPath);
  } catch (error: unknown) {
    throw new Error(
      `Cannot release agent-file lock at ${lock.lockPath}: cannot remove token ${basename(lock.ownerPath)}; ` +
      `${describeLockOwnership(lock.lockPath)}. The lock was left in place for inspection/removal.`,
      { cause: error },
    );
  }

  // Re-check the directory before attempting rmdir. The rmdir itself is also
  // non-recursive: a replacement owner token makes it fail with ENOTEMPTY.
  verifyLockDirectory(lock);
  try {
    rmdirSync(lock.lockPath);
  } catch (error: unknown) {
    throw new Error(
      `Cannot release agent-file lock at ${lock.lockPath}: the lock directory was not empty or ` +
      `could not be removed; ${describeLockOwnership(lock.lockPath)}. ` +
      `Inspect and remove it manually only if it is orphaned.`,
      { cause: error },
    );
  }
}

/** Hold the non-expiring cooperative lock across the complete mutation. */
export async function withAgentFileLock<T>(path: string, operation: () => T | PromiseLike<T>): Promise<T> {
  const lock = await acquireFileMutationLock(path);
  let operationFailed = false;
  let operationError: unknown;
  let result!: T;
  try {
    result = await operation();
  } catch (error: unknown) {
    operationFailed = true;
    operationError = error;
  }

  let releaseFailed = false;
  let releaseError: unknown;
  try {
    releaseFileMutationLock(lock);
  } catch (error: unknown) {
    releaseFailed = true;
    releaseError = error;
  }

  if (operationFailed) {
    if (releaseFailed) {
      throw new AggregateError(
        [operationError, releaseError],
        `Agent-file mutation failed and its lock could not be released: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
      );
    }
    throw operationError;
  }
  if (releaseFailed) throw releaseError;
  return result;
}

/**
 * Replace an existing agent file without exposing a partial write or discarding
 * an uncooperative editor save. The displaced inode stays in a hidden recovery
 * file: an editor with an already-open descriptor therefore writes recovery
 * data, while an atomic editor save recreates `path` and makes linkSync fail.
 * `expectedSource` is the content read before any UI or other work began.
 */
export async function atomicReplaceFile(path: string, content: string, expectedSource: string): Promise<void> {
  await withAgentFileLock(path, () => {
    assertSourceMatches(path, expectedSource);
    const mode = statSync(path).mode & 0o7777;
    const reserved = reserveTempFile(path, mode);
    let fd = reserved.fd;
    let tempPath: string | undefined = reserved.path;
    const recoveryPath = recoveryPathFor(path);
    let displaced = false;
    try {
      writeAndFlush(fd, content, mode);
      fd = -1;
      assertSourceMatches(path, expectedSource);
      renameSync(path, recoveryPath);
      displaced = true;
      // Unlike rename, link creation never replaces a target recreated by an
      // editor after the source was displaced.
      linkSync(tempPath, path);
      unlinkSync(tempPath);
      tempPath = undefined;
    } catch (error: unknown) {
      if (displaced) {
        throw new Error(
          `Refusing to publish replacement for ${path}: displaced source preserved at ${recoveryPath}`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      if (fd !== -1) {
        try { closeSync(fd); } catch { /* preserve the original write error */ }
      }
      if (tempPath !== undefined) {
        try { unlinkSync(tempPath); } catch { /* best-effort generated-temp cleanup */ }
      }
    }
  });
}

/** Write a newly-generated file atomically without clobbering an existing target. */
export async function atomicCreateFile(path: string, content: string): Promise<void> {
  await withAgentFileLock(path, () => {
    const reserved = reserveTempFile(path, 0o666);
    let fd = reserved.fd;
    let tempPath: string | undefined = reserved.path;
    try {
      // Do not fchmod a new file: openSync already applied process.umask().
      writeAndFlush(fd, content);
      fd = -1;
      if (existsSync(path)) {
        throw new Error(`Refusing to create ${path}: file already exists`);
      }
      // A hard-link creation is atomic and fails with EEXIST if another writer
      // created the target after the check. Both paths are in the same directory.
      linkSync(tempPath, path);
      unlinkSync(tempPath);
      tempPath = undefined;
    } finally {
      if (fd !== -1) {
        try { closeSync(fd); } catch { /* preserve the original write error */ }
      }
      if (tempPath !== undefined) {
        try { unlinkSync(tempPath); } catch { /* best-effort temp cleanup */ }
      }
    }
  });
}

/**
 * Remove an agent override only if the confirmed source is still unchanged.
 * The displaced inode remains in a hidden recovery file so an editor holding an
 * open descriptor cannot have a late save unlinked underneath it.
 */
export async function removeFileIfUnchanged(path: string, expectedSource: string): Promise<void> {
  await withAgentFileLock(path, () => {
    assertSourceMatches(path, expectedSource);
    const recoveryPath = recoveryPathFor(path);
    assertSourceMatches(path, expectedSource);
    renameSync(path, recoveryPath);
    if (existsSync(path)) {
      throw new Error(
        `Refusing to remove ${path}: a concurrent writer recreated it; displaced source preserved at ${recoveryPath}`,
      );
    }
  });
}
