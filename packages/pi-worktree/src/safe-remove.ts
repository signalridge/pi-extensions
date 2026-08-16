import { randomUUID } from "node:crypto";
import { lstat, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { moveWorktree, removeWorktreeMetadata, withWorktreeMutationLock } from "./git.js";

interface TreeSnapshot {
  kind: "directory" | "leaf";
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  children?: Map<string, TreeSnapshot>;
}

class QuarantineRetainedError extends Error {
  constructor(
    readonly path: string,
    message: string,
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = "QuarantineRetainedError";
  }
}

function sameIdentity(
  actual: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  expected: TreeSnapshot,
): boolean {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) return false;
  if (expected.kind === "directory") return true;
  return actual.size === expected.size && actual.mtimeMs === expected.mtimeMs && actual.ctimeMs === expected.ctimeMs;
}

function sameIdentityAfterRename(
  actual: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  expected: TreeSnapshot,
): boolean {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) return false;
  if (expected.kind === "directory") return true;
  // On macOS, renaming a leaf changes ctime even though its inode and content
  // are unchanged. The pre-rename identity check already covered ctime.
  return actual.size === expected.size && actual.mtimeMs === expected.mtimeMs;
}

async function snapshotTree(path: string): Promise<TreeSnapshot> {
  const stat = await lstat(path);
  const metadata = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  if (!stat.isDirectory()) return { kind: "leaf", ...metadata };
  const children = new Map<string, TreeSnapshot>();
  for (const name of await readdir(path)) {
    children.set(name, await snapshotTree(join(path, name)));
  }
  return { kind: "directory", ...metadata, children };
}

function sameSnapshotAfterGitMove(actual: TreeSnapshot, expected: TreeSnapshot, name?: string): boolean {
  if (actual.kind !== expected.kind) return false;
  if (actual.kind === "leaf") {
    if (name === ".git") {
      // Git updates this linked-worktree metadata file while moving the worktree.
      return actual.dev === expected.dev && actual.ino === expected.ino && actual.size === expected.size;
    }
    return sameIdentity(actual, expected);
  }
  if (!sameIdentity(actual, expected)) return false;
  const actualChildren = actual.children ?? new Map<string, TreeSnapshot>();
  const expectedChildren = expected.children ?? new Map<string, TreeSnapshot>();
  if (actualChildren.size !== expectedChildren.size) return false;
  for (const [childName, expectedChild] of expectedChildren) {
    const actualChild = actualChildren.get(childName);
    if (!actualChild || !sameSnapshotAfterGitMove(actualChild, expectedChild, childName)) return false;
  }
  return true;
}
async function claimFinalDeletion(path: string, expected: TreeSnapshot): Promise<string> {
  const claimed = join(dirname(path), `.${randomUUID()}.pi-worktree-final-delete`);
  try {
    await rename(path, claimed);
    const stat = await lstat(claimed);
    if (!sameIdentityAfterRename(stat, expected)) {
      throw new QuarantineRetainedError(claimed, `quarantine entry changed before final deletion: ${path}`);
    }
    return claimed;
  } catch (error: unknown) {
    if (error instanceof QuarantineRetainedError) throw error;
    if (isNotFound(error)) {
      throw new QuarantineRetainedError(
        claimed,
        `quarantine entry disappeared before final deletion; removal outcome is unknown: ${path}`,
        true,
      );
    }
    throw error;
  }
}

async function removeSnapshot(
  path: string,
  expected: TreeSnapshot,
  beforeDeleteEntry?: (entryPath: string) => Promise<void>,
): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (error: unknown) {
    if (isNotFound(error)) {
      throw new QuarantineRetainedError(
        path,
        `quarantine entry disappeared before deletion; removal outcome is unknown: ${path}`,
        true,
      );
    }
    throw error;
  }
  if (!sameIdentity(stat, expected)) throw new Error(`quarantine entry changed: ${path}`);

  // Claim every entry, including directories, under a private tombstone before
  // deleting descendants. A late writer can recreate the public path, but it
  // can no longer cause this remover to delete a replacement tree there.
  await beforeDeleteEntry?.(path);
  const tombstone = join(dirname(path), `.${randomUUID()}.pi-worktree-delete`);
  try {
    await rename(path, tombstone);
  } catch (error: unknown) {
    if (isNotFound(error)) {
      throw new QuarantineRetainedError(
        path,
        `quarantine entry disappeared before it could be claimed; removal outcome is unknown: ${path}`,
        true,
      );
    }
    throw error;
  }
  try {
    const tombstoneStat = await lstat(tombstone);
    if (!sameIdentityAfterRename(tombstoneStat, expected)) {
      throw new Error(`quarantine entry changed while deleting: ${path}`);
    }

    if (expected.kind === "leaf") {
      const claimed = await claimFinalDeletion(tombstone, expected);
      await unlink(claimed);
      return;
    }
    const children = expected.children ?? new Map<string, TreeSnapshot>();
    const actualNames = await readdir(tombstone);
    const expectedNames = new Set(children.keys());
    const unexpectedNames = actualNames.filter((name) => !expectedNames.has(name));
    const missingNames = [...expectedNames].filter((name) => !actualNames.includes(name) && name !== ".git");
    if (unexpectedNames.length > 0 || missingNames.length > 0) {
      throw new Error(`new quarantine data appeared: ${tombstone}`);
    }
    for (const [name, child] of children) {
      if (name === ".git" && !actualNames.includes(name)) continue;
      // Git may remove or rewrite this administrative pointer while
      // deregistering the linked worktree; it is not user data. Snapshot its
      // post-deregistration identity only for the guarded filesystem delete.
      const deletionSnapshot = name === ".git" ? await snapshotTree(join(tombstone, name)) : child;
      await removeSnapshot(join(tombstone, name), deletionSnapshot, beforeDeleteEntry);
    }
    await rmdir(await claimFinalDeletion(tombstone, expected));
  } catch (error: unknown) {
    if (error instanceof QuarantineRetainedError) throw error;
    if (isNotFound(error)) {
      throw new QuarantineRetainedError(
        tombstone,
        `quarantine entry disappeared during deletion; removal outcome is unknown: ${tombstone}`,
        true,
      );
    }
    throw new QuarantineRetainedError(tombstone, errorDetail(error));
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function reserveQuarantinePath(path: string): Promise<TreeSnapshot> {
  // Keep a non-directory entry at the registered Git path. Creating it with
  // the exclusive wx flag means a late writer that wins the brief rename
  // window makes this operation fail closed instead of giving Git a recursive
  // target.
  await writeFile(path, `${randomUUID()}\n`, { flag: "wx", mode: 0o600 });
  return snapshotTree(path);
}

async function releaseQuarantineReservation(path: string, expected: TreeSnapshot): Promise<void> {
  // Move the name to a private unique path before checking identity again. If a
  // writer replaces the reservation after the first check, rename moves that
  // replacement into retention instead of unlinking it through the public name.
  const releasePath = join(dirname(path), `.${randomUUID()}.pi-worktree-reservation`);
  try {
    await rename(path, releasePath);
  } catch (error: unknown) {
    if (isNotFound(error)) return;
    throw error;
  }
  const stat = await lstat(releasePath);
  if (!sameIdentityAfterRename(stat, expected)) {
    throw new QuarantineRetainedError(releasePath, `quarantine reservation changed: ${path}`);
  }
  await unlink(releasePath);
}

async function restoreQuarantine(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  quarantinePath: string,
  originalPath: string,
): Promise<boolean> {
  if (await pathExists(originalPath)) return false;
  await moveWorktree(pi, cwd, quarantinePath, originalPath);
  return true;
}
async function classifyMoveOutcome(
  sourcePath: string,
  quarantinePath: string,
): Promise<"not-moved" | "moved" | "unknown"> {
  const sourceExists = await pathExists(sourcePath);
  const quarantineExists = await pathExists(quarantinePath);
  if (sourceExists && !quarantineExists) return "not-moved";
  if (!sourceExists && quarantineExists) return "moved";
  return "unknown";
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Remove Git metadata without giving Git a recursive path that may have changed
 * since the last inventory. Git first moves the registered worktree to a quarantine
 * path; the real tree then moves to a private tombstone before metadata-only
 * deregistration. Any late-created or replaced entry leaves the tombstone intact.
 */
export type QuarantineValidator = (quarantinePath: string) => Promise<void>;
export type QuarantineDeleteObserver = (entryPath: string) => Promise<void>;

export async function removeWorktreeSafely(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  path: string,
  signal: AbortSignal | undefined,
  validateQuarantine: QuarantineValidator,
  beforeDeleteEntry?: QuarantineDeleteObserver,
  validateRegisteredWorktree?: () => Promise<void>,
): Promise<void> {
  return withWorktreeMutationLock(
    cwd,
    async () => {
      if (signal?.aborted) throw new Error("worktree removal aborted");
      const quarantinePath = join(dirname(path), `.${randomUUID()}.pi-worktree-quarantine`);
      let metadataRemoved = false;
      let moved = false;
      let tombstonePath: string | undefined;
      let moveOutcomeUnknown = false;
      let quarantineReservation: TreeSnapshot | undefined;
      try {
        await validateRegisteredWorktree?.();
        const beforeSnapshot = await snapshotTree(path);
        await moveWorktree(pi, cwd, path, quarantinePath, signal);
        moved = true;
        const snapshot = await snapshotTree(quarantinePath);
        if (!sameSnapshotAfterGitMove(snapshot, beforeSnapshot)) {
          throw new Error("worktree changed while entering quarantine");
        }
        await validateQuarantine(quarantinePath);

        // Keep the real tree on a guarded tombstone. The registered path is reserved
        // with an exclusive non-directory entry so Git never receives an unprotected
        // absent path that a late writer can turn into a recursive target.
        tombstonePath = `${quarantinePath}.pi-worktree-tombstone`;
        await rename(quarantinePath, tombstonePath);
        quarantineReservation = await reserveQuarantinePath(quarantinePath);
        const reservedPath = await lstat(quarantinePath);
        if (!sameIdentity(reservedPath, quarantineReservation)) {
          throw new QuarantineRetainedError(quarantinePath, `quarantine reservation changed: ${quarantinePath}`);
        }
        await removeWorktreeMetadata(
          pi,
          cwd,
          quarantinePath,
          signal,
          () => {
            metadataRemoved = true;
          },
          true,
        );
        await releaseQuarantineReservation(quarantinePath, quarantineReservation);
        quarantineReservation = undefined;
        if (!tombstonePath || !(await pathExists(tombstonePath))) {
          throw new QuarantineRetainedError(
            tombstonePath ?? quarantinePath,
            `quarantine tombstone disappeared before deletion; removal outcome is unknown: ${tombstonePath ?? quarantinePath}`,
            true,
          );
        }
        await removeSnapshot(tombstonePath, snapshot, beforeDeleteEntry);
      } catch (error: unknown) {
        if (!tombstonePath && !metadataRemoved) {
          try {
            const outcome = await classifyMoveOutcome(path, quarantinePath);
            if (outcome === "moved") moved = true;
            else if (outcome === "not-moved") moved = false;
            else moveOutcomeUnknown = true;
          } catch {
            moveOutcomeUnknown = true;
          }
        }
        let reservationError: unknown;
        if (quarantineReservation) {
          try {
            await releaseQuarantineReservation(quarantinePath, quarantineReservation);
            quarantineReservation = undefined;
          } catch (candidateError: unknown) {
            reservationError = candidateError;
          }
        }
        const primaryError = reservationError ?? error;
        if (moveOutcomeUnknown) {
          throw new Error(
            `Git worktree move outcome is unknown; inspect ${path} and ${quarantinePath} before retrying: ${errorDetail(primaryError)}`,
          );
        }
        if (moved && !metadataRemoved) {
          let restoreError: unknown = reservationError;
          let restored = false;
          if (!reservationError) {
            try {
              if (!(await pathExists(path))) {
                if (tombstonePath && (await pathExists(tombstonePath))) {
                  if (await pathExists(quarantinePath)) {
                    throw new Error(`quarantine path was recreated before restoration: ${quarantinePath}`);
                  }
                  await rename(tombstonePath, quarantinePath);
                }
                restored = await restoreQuarantine(pi, cwd, quarantinePath, path);
              }
            } catch (candidateError: unknown) {
              restoreError = candidateError;
            }
          }
          if (restored) throw primaryError;
          const retainedPath =
            primaryError instanceof QuarantineRetainedError
              ? primaryError.path
              : tombstonePath && (await pathExists(tombstonePath))
                ? tombstonePath
                : quarantinePath;
          throw new Error(
            `Git worktree removal failed: ${errorDetail(primaryError)}; quarantine retained at ${retainedPath}${
              restoreError ? ` (${errorDetail(restoreError)})` : ". The original path was recreated."
            }`,
          );
        }
        if (metadataRemoved && tombstonePath) {
          if (primaryError instanceof QuarantineRetainedError && primaryError.outcomeUnknown) {
            throw new Error(
              `Worktree metadata was removed, but quarantine outcome is unknown: ${errorDetail(primaryError)}`,
            );
          }
          const retainedPath =
            primaryError instanceof QuarantineRetainedError
              ? primaryError.path
              : (await pathExists(tombstonePath))
                ? tombstonePath
                : undefined;
          if (retainedPath) {
            throw new Error(
              `Worktree metadata was removed, but quarantine was retained at ${retainedPath}: ${errorDetail(primaryError)}`,
            );
          }
        }
        throw primaryError;
      }
    },
    signal,
  );
}
