/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Creates a temporary git worktree so the agent works on an isolated copy of the repo.
 * On completion, if no changes were made, the worktree is cleaned up.
 * If changes exist, a branch is created and returned in the result.
 */

import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface WorktreeInfo {
  /** Absolute path to the worktree directory (the copied repo's root). */
  path: string;
  /** Branch name created for this worktree (if changes exist). */
  branch: string;
  /** Commit SHA that the worktree was created from. */
  baseSha: string;
  /** Absolute path to the original repository's Git top-level. */
  repoRoot: string;
  /**
   * Where the agent should work inside the worktree: the equivalent of the
   * cwd the worktree was created from. Equals `path` when that cwd was deeper.
   */
  workPath: string;
  /** Internal safety invariant: the package temp root used to create `path`. */
  readonly tempRoot?: string;
  /** Internal safety invariant: the exact package-generated basename of `path`. */
  readonly tempName?: string;
}

export interface WorktreeCleanupResult {
  /** Whether changes were found in the worktree. */
  hasChanges: boolean;
  /** Branch name if changes were committed. */
  branch?: string;
  /** Worktree path if it was kept or if cleanup failed. */
  path?: string;
  /** Whether the worktree directory and Git registration were cleaned up. */
  cleanupSucceeded: boolean;
  /** Bounded diagnostic when inspection, preservation, or cleanup was incomplete. */
  cleanupDiagnostic?: string;
  /** Explicit commands a user can run to recover an unrecoverable cleanup. */
  recoveryCommands?: readonly string[];
  /** Whether Git's removal command completed successfully. */
  gitRemovalSucceeded?: boolean;
  /** Whether the safe package-owned filesystem fallback was attempted. */
  filesystemFallbackAttempted?: boolean;
  /** Whether the safe filesystem fallback removed the directory. */
  filesystemFallbackSucceeded?: boolean;
  /** Whether Git registration was verified absent (when Git allowed verification). */
  registrationCleanupVerified?: boolean;
  /** Whether the registration prune was attempted after fallback. */
  pruneAttempted?: boolean;
  /** Whether the attempted registration prune completed. */
  pruneSucceeded?: boolean;
}

/**
 * Create a temporary git worktree for an agent.
 * Returns the worktree path, or undefined if not in a git repo.
 */
export function createWorktree(cwd: string, agentId: string): WorktreeInfo | undefined {
  let baseSha: string;
  let repoRoot: string;
  let subdir: string;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "pipe", timeout: 5000 });
    baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: "pipe", timeout: 5000 })
      .toString()
      .trim();
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: "pipe", timeout: 5000 })
      .toString()
      .trim();
    repoRoot = realpathSync(topLevel);
    subdir = relative(repoRoot, realpathSync(cwd));
  } catch {
    return undefined;
  }

  const branch = `pi-agent-${agentId}`;
  const tempRoot = resolve(tmpdir());
  const tempName = `pi-agent-${agentId}-${randomUUID().slice(0, 8)}`;
  const worktreePath = join(tempRoot, tempName);

  try {
    execFileSync("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], {
      cwd,
      stdio: "pipe",
      timeout: 30000,
    });
    return {
      path: worktreePath,
      branch,
      baseSha,
      repoRoot,
      workPath: subdir ? join(worktreePath, subdir) : worktreePath,
      tempRoot,
      tempName,
    };
  } catch {
    return undefined;
  }
}

/**
 * Clean up a worktree after agent completion.
 *
 * Preservation is fail-closed: if status, add, commit, or branch creation
 * cannot prove that the changes are safe on a branch, the worktree is left in
 * place and the caller receives bounded recovery diagnostics. In particular,
 * no forced removal is attempted after a preservation operation fails.
 */
export function cleanupWorktree(
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): WorktreeCleanupResult {
  const initialPathEntry = inspectDirectoryEntry(worktree.path);
  const initialPathFailure = directoryEntryFailure(worktree.path, initialPathEntry);
  if (initialPathFailure) {
    return cleanupResult(
      worktree,
      false,
      undefined,
      removeWorktree(cwd, worktree),
      `Worktree path could not be safely inspected: ${initialPathFailure}`,
    );
  }
  if (!initialPathEntry.present) {
    return cleanupResult(worktree, false, undefined, removeWorktree(cwd, worktree));
  }

  let status: string;
  try {
    status = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktree.path,
      stdio: "pipe",
      timeout: 10000,
    }).toString().trim();
  } catch (error: unknown) {
    return preservationFailure(worktree, false, "status", error, cwd);
  }

  if (status) {
    try {
      execFileSync("git", ["add", "-A"], { cwd: worktree.path, stdio: "pipe", timeout: 10000 });
    } catch (error: unknown) {
      return preservationFailure(worktree, true, "git add", error, cwd);
    }
    try {
      const safeDesc = agentDescription.slice(0, 200);
      execFileSync("git", ["commit", "--no-verify", "-m", `pi-agent: ${safeDesc}`], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 10000,
      });
    } catch (error: unknown) {
      return preservationFailure(worktree, true, "git commit", error, cwd);
    }
  } else {
    let currentSha: string;
    try {
      currentSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5000,
      }).toString().trim();
    } catch (error: unknown) {
      return preservationFailure(worktree, false, "HEAD inspection", error, cwd);
    }

    if (currentSha === worktree.baseSha) {
      return cleanupResult(worktree, false, undefined, removeWorktree(cwd, worktree));
    }
  }

  let branchName = worktree.branch;
  try {
    execFileSync("git", ["branch", branchName], {
      cwd: worktree.path,
      stdio: "pipe",
      timeout: 5000,
    });
  } catch {
    branchName = `${worktree.branch}-${Date.now()}`;
    try {
      execFileSync("git", ["branch", branchName], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch (error: unknown) {
      return preservationFailure(worktree, true, "git branch", error, cwd);
    }
  }

  worktree.branch = branchName;
  return cleanupResult(worktree, true, branchName, removeWorktree(cwd, worktree));
}

/** Async counterpart used by manager shutdown so Git cleanup never blocks the event loop. */
export async function cleanupWorktreeAsync(
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): Promise<WorktreeCleanupResult> {
  const initialPathEntry = inspectDirectoryEntry(worktree.path);
  const initialPathFailure = directoryEntryFailure(worktree.path, initialPathEntry);
  if (initialPathFailure) {
    return cleanupResult(
      worktree,
      false,
      undefined,
      await removeWorktreeAsync(cwd, worktree),
      `Worktree path could not be safely inspected: ${initialPathFailure}`,
    );
  }
  if (!initialPathEntry.present) {
    return cleanupResult(worktree, false, undefined, await removeWorktreeAsync(cwd, worktree));
  }

  let status: string;
  try {
    status = (await execFileAsync("git", ["status", "--porcelain"], worktree.path, 10000)).toString().trim();
  } catch (error: unknown) {
    return preservationFailure(worktree, false, "status", error, cwd);
  }

  if (status) {
    try {
      await execFileAsync("git", ["add", "-A"], worktree.path, 10000);
    } catch (error: unknown) {
      return preservationFailure(worktree, true, "git add", error, cwd);
    }
    try {
      const safeDesc = agentDescription.slice(0, 200);
      await execFileAsync("git", ["commit", "--no-verify", "-m", `pi-agent: ${safeDesc}`], worktree.path, 10000);
    } catch (error: unknown) {
      return preservationFailure(worktree, true, "git commit", error, cwd);
    }
  } else {
    let currentSha: string;
    try {
      currentSha = (await execFileAsync("git", ["rev-parse", "HEAD"], worktree.path, 5000)).toString().trim();
    } catch (error: unknown) {
      return preservationFailure(worktree, false, "HEAD inspection", error, cwd);
    }

    if (currentSha === worktree.baseSha) {
      return cleanupResult(worktree, false, undefined, await removeWorktreeAsync(cwd, worktree));
    }
  }

  let branchName = worktree.branch;
  try {
    await execFileAsync("git", ["branch", branchName], worktree.path, 5000);
  } catch {
    branchName = `${worktree.branch}-${Date.now()}`;
    try {
      await execFileAsync("git", ["branch", branchName], worktree.path, 5000);
    } catch (error: unknown) {
      return preservationFailure(worktree, true, "git branch", error, cwd);
    }
  }

  worktree.branch = branchName;
  return cleanupResult(worktree, true, branchName, await removeWorktreeAsync(cwd, worktree));
}

function cleanupResult(
  worktree: WorktreeInfo,
  hasChanges: boolean,
  branch: string | undefined,
  removal: WorktreeRemovalResult,
  operationDiagnostic?: string,
): WorktreeCleanupResult {
  const diagnostic = [operationDiagnostic, removal.cleanupDiagnostic].filter(Boolean).join(" ");
  return {
    hasChanges,
    ...(branch === undefined ? {} : { branch }),
    path: worktree.path,
    cleanupSucceeded: removal.cleanupSucceeded,
    ...(diagnostic ? { cleanupDiagnostic: diagnostic.slice(0, WORKTREE_DIAGNOSTIC_LIMIT) } : {}),
    ...(removal.recoveryCommands ? { recoveryCommands: removal.recoveryCommands } : {}),
    gitRemovalSucceeded: removal.gitRemovalSucceeded,
    filesystemFallbackAttempted: removal.filesystemFallbackAttempted,
    ...(removal.filesystemFallbackSucceeded === undefined ? {} : { filesystemFallbackSucceeded: removal.filesystemFallbackSucceeded }),
    ...(removal.registrationCleanupVerified === undefined ? {} : { registrationCleanupVerified: removal.registrationCleanupVerified }),
    pruneAttempted: removal.pruneAttempted,
    ...(removal.pruneSucceeded === undefined ? {} : { pruneSucceeded: removal.pruneSucceeded }),
  };
}

function preservationFailure(
  worktree: WorktreeInfo,
  hasChanges: boolean,
  operation: string,
  error: unknown,
  cwd: string,
): WorktreeCleanupResult {
  return {
    hasChanges,
    path: worktree.path,
    cleanupSucceeded: false,
    cleanupDiagnostic: `Worktree preservation failed during ${operation}; the worktree was kept in place: ${errorMessage(error)}`,
    recoveryCommands: recoveryCommands(cwd, worktree.path),
  };
}

interface WorktreeRegistration {
  verified: boolean;
  registered: boolean;
  error?: string;
}

interface WorktreeRemovalResult {
  cleanupSucceeded: boolean;
  cleanupDiagnostic?: string;
  recoveryCommands?: readonly string[];
  gitRemovalSucceeded: boolean;
  filesystemFallbackAttempted: boolean;
  filesystemFallbackSucceeded?: boolean;
  registrationCleanupVerified?: boolean;
  pruneAttempted: boolean;
  pruneSucceeded?: boolean;
}

const WORKTREE_DIAGNOSTIC_LIMIT = 2_000;

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, WORKTREE_DIAGNOSTIC_LIMIT);
}

function execFileAsync(command: string, args: readonly string[], cwd: string, timeout: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, [...args], { cwd, timeout }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
}

type DirectoryEntryKind = "directory" | "symlink" | "special";

interface DirectoryEntryState {
  present: boolean;
  verified: boolean;
  kind?: DirectoryEntryKind;
  error?: string;
}

/** Inspect one lexical directory entry without following symlinks. */
function inspectDirectoryEntry(path: string): DirectoryEntryState {
  try {
    const stats = lstatSync(path);
    return {
      present: true,
      verified: true,
      kind: stats.isSymbolicLink() ? "symlink" : stats.isDirectory() ? "directory" : "special",
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false, verified: true };
    return { present: true, verified: false, error: `lstat failed: ${errorMessage(error)}` };
  }
}

function directoryEntryFailure(path: string, entry: DirectoryEntryState): string | undefined {
  if (!entry.verified) return `path ${path} could not be verified: ${entry.error ?? "unknown lstat failure"}`;
  if (!entry.present || entry.kind === "directory") return undefined;
  if (entry.kind === "symlink") return `path ${path} is a symlink; refusing recursive filesystem fallback`;
  return `path ${path} is a special file; refusing recursive filesystem fallback`;
}

function directoryEntryDescription(entry: DirectoryEntryState): string {
  if (!entry.verified) return `unverifiable${entry.error ? ` (${entry.error})` : ""}`;
  if (!entry.present) return "absent";
  return entry.kind ?? "present";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function recoveryCommands(cwd: string, worktreePath: string): readonly string[] {
  return Object.freeze([
    `git -C ${shellQuote(cwd)} worktree remove --force ${shellQuote(worktreePath)}`,
    `rm -rf -- ${shellQuote(worktreePath)}`,
    `git -C ${shellQuote(cwd)} worktree prune`,
  ]);
}

/** Only a path returned by createWorktree may be removed directly. */
function isPackageCreatedWorktree(worktree: WorktreeInfo): { verified: boolean; reason?: string } {
  const refuse = (reason: string): { verified: false; reason: string } => ({
    verified: false,
    reason: `path ${worktree.path}: ${reason}`,
  });

  if (!isAbsolute(worktree.path) || !isAbsolute(worktree.repoRoot) || !isAbsolute(worktree.workPath)) {
    return refuse("worktree paths are not absolute");
  }
  if (!worktree.tempRoot || !worktree.tempName) return refuse("package creation metadata is missing");

  const expectedRoot = resolve(tmpdir());
  const path = resolve(worktree.path);
  if (resolve(worktree.tempRoot) !== expectedRoot) return refuse("temporary root is not the package temp directory");
  if (dirname(path) !== expectedRoot || worktree.path !== join(expectedRoot, worktree.tempName)) {
    return refuse("path is not the exact package-created worktree path");
  }
  if (basename(path) !== worktree.tempName) return refuse("path basename does not match package creation metadata");
  if (!/^pi-agent-[A-Za-z0-9._-]+-[0-9a-f]{8}$/.test(worktree.tempName)) {
    return refuse("temporary name is not package-generated");
  }
  if (typeof worktree.branch !== "string" || !worktree.branch.startsWith("pi-agent-")) {
    return refuse("branch is not package-generated");
  }

  const workPathRelative = relative(path, resolve(worktree.workPath));
  if (isAbsolute(workPathRelative) || workPathRelative === ".." || workPathRelative.startsWith(`..${sep}`)) {
    return refuse("work path escapes the worktree");
  }

  const entry = inspectDirectoryEntry(path);
  const entryFailure = directoryEntryFailure(path, entry);
  if (entryFailure) return { verified: false, reason: entryFailure };
  return { verified: true };
}

function inspectWorktreeRegistration(cwd: string, worktreePath: string): WorktreeRegistration {
  try {
    const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      stdio: "pipe",
      timeout: 5000,
    }).toString();
    const expectedPath = resolve(worktreePath);
    const registered = output.split(/\r?\n/).some((line) =>
      line.startsWith("worktree ") && resolve(line.slice("worktree ".length).trim()) === expectedPath,
    );
    return { verified: true, registered };
  } catch (error: unknown) {
    return { verified: false, registered: false, error: errorMessage(error) };
  }
}

async function inspectWorktreeRegistrationAsync(cwd: string, worktreePath: string): Promise<WorktreeRegistration> {
  try {
    const output = (await execFileAsync("git", ["worktree", "list", "--porcelain"], cwd, 5000)).toString();
    const expectedPath = resolve(worktreePath);
    const registered = output.split(/\r?\n/).some((line) =>
      line.startsWith("worktree ") && resolve(line.slice("worktree ".length).trim()) === expectedPath,
    );
    return { verified: true, registered };
  } catch (error: unknown) {
    return { verified: false, registered: false, error: errorMessage(error) };
  }
}

function pruneWorktreeRegistration(cwd: string): { succeeded: boolean; error?: string } {
  try {
    execFileSync("git", ["worktree", "prune"], { cwd, stdio: "pipe", timeout: 5000 });
    return { succeeded: true };
  } catch (error: unknown) {
    return { succeeded: false, error: errorMessage(error) };
  }
}

async function pruneWorktreeRegistrationAsync(cwd: string): Promise<{ succeeded: boolean; error?: string }> {
  try {
    await execFileAsync("git", ["worktree", "prune"], cwd, 5000);
    return { succeeded: true };
  } catch (error: unknown) {
    return { succeeded: false, error: errorMessage(error) };
  }
}

function removeWorktree(cwd: string, worktree: WorktreeInfo): WorktreeRemovalResult {
  const path = worktree.path;
  let pathEntry = inspectDirectoryEntry(path);
  const wasPresent = pathEntry.present;
  let pathSafetyFailure = directoryEntryFailure(path, pathEntry);
  let gitRemovalSucceeded = false;
  let gitRemovalError: string | undefined;

  if (pathSafetyFailure) {
    gitRemovalError = `refusing Git removal: ${pathSafetyFailure}`;
  } else {
    try {
      execFileSync("git", ["worktree", "remove", "--force", path], { cwd, stdio: "pipe", timeout: 10000 });
      gitRemovalSucceeded = true;
    } catch (error: unknown) {
      gitRemovalError = errorMessage(error);
    }
  }

  let filesystemFallbackAttempted = false;
  let filesystemFallbackSucceeded: boolean | undefined;
  let filesystemFallbackError: string | undefined;
  let pruneAttempted = false;
  let pruneSucceeded: boolean | undefined;
  let pruneError: string | undefined;
  let registration = inspectWorktreeRegistration(cwd, path);

  pathEntry = inspectDirectoryEntry(path);
  pathSafetyFailure ??= directoryEntryFailure(path, pathEntry);
  const needsFallback =
    !gitRemovalSucceeded ||
    !pathEntry.verified ||
    pathEntry.present ||
    !registration.verified ||
    registration.registered ||
    pathSafetyFailure !== undefined;
  if (needsFallback) {
    const packageWorktree = isPackageCreatedWorktree(worktree);
    if (packageWorktree.verified) {
      filesystemFallbackAttempted = true;
      const fallbackBefore = inspectDirectoryEntry(path);
      const fallbackBeforeFailure = directoryEntryFailure(path, fallbackBefore);
      if (fallbackBeforeFailure) {
        filesystemFallbackSucceeded = false;
        filesystemFallbackError = fallbackBeforeFailure;
        pathSafetyFailure ??= fallbackBeforeFailure;
      } else {
        try {
          rmSync(path, { recursive: true, force: true });
          const fallbackAfter = inspectDirectoryEntry(path);
          const fallbackAfterFailure = directoryEntryFailure(path, fallbackAfter);
          if (fallbackAfterFailure) pathSafetyFailure ??= fallbackAfterFailure;
          if (!fallbackAfter.verified) {
            filesystemFallbackSucceeded = false;
            filesystemFallbackError = fallbackAfterFailure ?? `path ${path} could not be verified after filesystem fallback`;
          } else if (fallbackAfter.present) {
            filesystemFallbackSucceeded = false;
            filesystemFallbackError = `path ${path} remained ${directoryEntryDescription(fallbackAfter)} after filesystem fallback`;
          } else {
            filesystemFallbackSucceeded = true;
          }
        } catch (error: unknown) {
          filesystemFallbackSucceeded = false;
          filesystemFallbackError = errorMessage(error);
        }
      }
    } else {
      filesystemFallbackError = `direct filesystem fallback refused: not a verified package-created worktree (${packageWorktree.reason ?? "path validation failed"})`;
    }

    pruneAttempted = true;
    const prune = pruneWorktreeRegistration(cwd);
    pruneSucceeded = prune.succeeded;
    pruneError = prune.error;
    registration = inspectWorktreeRegistration(cwd, path);
  }

  pathEntry = inspectDirectoryEntry(path);
  pathSafetyFailure ??= directoryEntryFailure(path, pathEntry);
  const directoryAbsent = pathEntry.verified && !pathEntry.present;
  const registrationAbsent = registration.verified && !registration.registered;
  const removalMethodSucceeded = pathSafetyFailure === undefined &&
    (gitRemovalSucceeded || filesystemFallbackSucceeded === true || (!wasPresent && pathEntry.verified));
  const cleanupSucceeded = removalMethodSucceeded && directoryAbsent && registrationAbsent;

  if (cleanupSucceeded) {
    return {
      cleanupSucceeded: true,
      gitRemovalSucceeded,
      filesystemFallbackAttempted,
      ...(filesystemFallbackSucceeded === undefined ? {} : { filesystemFallbackSucceeded }),
      ...(registration.verified ? { registrationCleanupVerified: !registration.registered } : {}),
      pruneAttempted,
      ...(pruneSucceeded === undefined ? {} : { pruneSucceeded }),
    };
  }

  return removalFailure(
    path,
    gitRemovalSucceeded,
    gitRemovalError,
    filesystemFallbackAttempted,
    filesystemFallbackSucceeded,
    filesystemFallbackError,
    pruneAttempted,
    pruneSucceeded,
    pruneError,
    pathEntry,
    pathSafetyFailure,
    registration,
    cwd,
  );
}

async function removeWorktreeAsync(cwd: string, worktree: WorktreeInfo): Promise<WorktreeRemovalResult> {
  const path = worktree.path;
  let pathEntry = inspectDirectoryEntry(path);
  const wasPresent = pathEntry.present;
  let pathSafetyFailure = directoryEntryFailure(path, pathEntry);
  let gitRemovalSucceeded = false;
  let gitRemovalError: string | undefined;

  if (pathSafetyFailure) {
    gitRemovalError = `refusing Git removal: ${pathSafetyFailure}`;
  } else {
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", path], cwd, 10000);
      gitRemovalSucceeded = true;
    } catch (error: unknown) {
      gitRemovalError = errorMessage(error);
    }
  }

  let filesystemFallbackAttempted = false;
  let filesystemFallbackSucceeded: boolean | undefined;
  let filesystemFallbackError: string | undefined;
  let pruneAttempted = false;
  let pruneSucceeded: boolean | undefined;
  let pruneError: string | undefined;
  let registration = await inspectWorktreeRegistrationAsync(cwd, path);

  pathEntry = inspectDirectoryEntry(path);
  pathSafetyFailure ??= directoryEntryFailure(path, pathEntry);
  const needsFallback =
    !gitRemovalSucceeded ||
    !pathEntry.verified ||
    pathEntry.present ||
    !registration.verified ||
    registration.registered ||
    pathSafetyFailure !== undefined;
  if (needsFallback) {
    const packageWorktree = isPackageCreatedWorktree(worktree);
    if (packageWorktree.verified) {
      filesystemFallbackAttempted = true;
      const fallbackBefore = inspectDirectoryEntry(path);
      const fallbackBeforeFailure = directoryEntryFailure(path, fallbackBefore);
      if (fallbackBeforeFailure) {
        filesystemFallbackSucceeded = false;
        filesystemFallbackError = fallbackBeforeFailure;
        pathSafetyFailure ??= fallbackBeforeFailure;
      } else {
        try {
          await rm(path, { recursive: true, force: true });
          const fallbackAfter = inspectDirectoryEntry(path);
          const fallbackAfterFailure = directoryEntryFailure(path, fallbackAfter);
          if (fallbackAfterFailure) pathSafetyFailure ??= fallbackAfterFailure;
          if (!fallbackAfter.verified) {
            filesystemFallbackSucceeded = false;
            filesystemFallbackError = fallbackAfterFailure ?? `path ${path} could not be verified after filesystem fallback`;
          } else if (fallbackAfter.present) {
            filesystemFallbackSucceeded = false;
            filesystemFallbackError = `path ${path} remained ${directoryEntryDescription(fallbackAfter)} after filesystem fallback`;
          } else {
            filesystemFallbackSucceeded = true;
          }
        } catch (error: unknown) {
          filesystemFallbackSucceeded = false;
          filesystemFallbackError = errorMessage(error);
        }
      }
    } else {
      filesystemFallbackError = `direct filesystem fallback refused: not a verified package-created worktree (${packageWorktree.reason ?? "path validation failed"})`;
    }

    pruneAttempted = true;
    const prune = await pruneWorktreeRegistrationAsync(cwd);
    pruneSucceeded = prune.succeeded;
    pruneError = prune.error;
    registration = await inspectWorktreeRegistrationAsync(cwd, path);
  }

  pathEntry = inspectDirectoryEntry(path);
  pathSafetyFailure ??= directoryEntryFailure(path, pathEntry);
  const directoryAbsent = pathEntry.verified && !pathEntry.present;
  const registrationAbsent = registration.verified && !registration.registered;
  const removalMethodSucceeded = pathSafetyFailure === undefined &&
    (gitRemovalSucceeded || filesystemFallbackSucceeded === true || (!wasPresent && pathEntry.verified));
  const cleanupSucceeded = removalMethodSucceeded && directoryAbsent && registrationAbsent;

  if (cleanupSucceeded) {
    return {
      cleanupSucceeded: true,
      gitRemovalSucceeded,
      filesystemFallbackAttempted,
      ...(filesystemFallbackSucceeded === undefined ? {} : { filesystemFallbackSucceeded }),
      ...(registration.verified ? { registrationCleanupVerified: !registration.registered } : {}),
      pruneAttempted,
      ...(pruneSucceeded === undefined ? {} : { pruneSucceeded }),
    };
  }

  return removalFailure(
    path,
    gitRemovalSucceeded,
    gitRemovalError,
    filesystemFallbackAttempted,
    filesystemFallbackSucceeded,
    filesystemFallbackError,
    pruneAttempted,
    pruneSucceeded,
    pruneError,
    pathEntry,
    pathSafetyFailure,
    registration,
    cwd,
  );
}

function removalFailure(
  path: string,
  gitRemovalSucceeded: boolean,
  gitRemovalError: string | undefined,
  filesystemFallbackAttempted: boolean,
  filesystemFallbackSucceeded: boolean | undefined,
  filesystemFallbackError: string | undefined,
  pruneAttempted: boolean,
  pruneSucceeded: boolean | undefined,
  pruneError: string | undefined,
  pathEntry: DirectoryEntryState,
  pathSafetyFailure: string | undefined,
  registration: WorktreeRegistration,
  cwd: string,
): WorktreeRemovalResult {
  const directoryAbsent = pathEntry.verified && !pathEntry.present;
  const details = [
    gitRemovalSucceeded ? "git removal completed" : `git removal failed${gitRemovalError ? `: ${gitRemovalError}` : ""}`,
    filesystemFallbackAttempted
      ? filesystemFallbackSucceeded ? "filesystem fallback removed the directory" : `filesystem fallback failed${filesystemFallbackError ? `: ${filesystemFallbackError}` : ""}`
      : `filesystem fallback not used${filesystemFallbackError ? ` (${filesystemFallbackError})` : ""}`,
    pruneAttempted ? pruneSucceeded ? "git worktree prune completed" : `git worktree prune failed${pruneError ? `: ${pruneError}` : ""}` : "git worktree prune not required",
    `directory ${directoryAbsent ? "absent" : "still present"}`,
    `path entry ${directoryEntryDescription(pathEntry)}`,
    registration.verified
      ? `registration ${registration.registered ? "still present" : "removed"}`
      : `registration could not be verified${registration.error ? `: ${registration.error}` : ""}`,
    ...(pathSafetyFailure ? [`path safety check failed: ${pathSafetyFailure}`] : []),
  ];
  return {
    cleanupSucceeded: false,
    cleanupDiagnostic: `Worktree cleanup failed for ${path}: ${details.join("; ")}`.slice(0, WORKTREE_DIAGNOSTIC_LIMIT),
    recoveryCommands: recoveryCommands(cwd, path),
    gitRemovalSucceeded,
    filesystemFallbackAttempted,
    ...(filesystemFallbackSucceeded === undefined ? {} : { filesystemFallbackSucceeded }),
    ...(registration.verified ? { registrationCleanupVerified: !registration.registered } : {}),
    pruneAttempted,
    ...(pruneSucceeded === undefined ? {} : { pruneSucceeded }),
  };
}

/** Prune any orphaned worktrees (crash recovery). */
export function pruneWorktrees(cwd: string): void {
  try {
    execFileSync("git", ["worktree", "prune"], { cwd, stdio: "pipe", timeout: 5000 });
  } catch {
    // Crash recovery is best effort; cleanup callers retain their own failure snapshot.
  }
}

/** Async crash recovery counterpart used during manager shutdown. */
export async function pruneWorktreesAsync(cwd: string): Promise<void> {
  try {
    await execFileAsync("git", ["worktree", "prune"], cwd, 5000);
  } catch {
    // Crash recovery is best effort; cleanup callers retain their own failure snapshot.
  }
}
