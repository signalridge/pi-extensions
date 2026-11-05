/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Creates a temporary git worktree so the agent works on an isolated copy of the repo.
 * On completion, if no changes were made, the worktree is cleaned up.
 * If changes exist, a branch is created and returned in the result.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

export interface WorktreeInfo {
  /** Absolute path to the worktree directory (the copied repo's root). */
  path: string;
  /** Branch name created for this worktree (if changes exist). */
  branch: string;
  /** Commit SHA that the worktree was created from. */
  baseSha: string;
  /**
   * Where the agent should work inside the worktree: the equivalent of the
   * cwd the worktree was created from. Equals `path` when that cwd was the
   * repo root; points at the copied subdirectory when it was deeper (e.g. a
   * monorepo package), so the requested scoping survives isolation.
   */
  workPath: string;
  /** Nearest git root repository top-level. */
  repoRoot: string;
}

/**
 * Project-wide switch for worktree isolation (`worktreeIsolation` in
 * subagents.json). Default `true` — unchanged behaviour.
 *
 * The `"off"` isolation value gives a model a legal way to decline a worktree,
 * but it still depends on the model choosing it. This is the deterministic half
 * of the same fix: on a large repo where every worktree costs real time and
 * disk (#184), turning it off means no caller can create one, whatever it
 * passes.
 */
let worktreeIsolationEnabled = true;

export function setWorktreeIsolationEnabled(enabled: boolean): void {
  worktreeIsolationEnabled = enabled;
}

export function isWorktreeIsolationEnabled(): boolean {
  return worktreeIsolationEnabled;
}

export interface WorktreeCleanupResult {
  /** Whether changes were found in the worktree. */
  hasChanges: boolean;
  /** Branch name if changes were committed. */
  branch?: string;
  /** Worktree path if it was kept. */
  path?: string;
  /** Diagnostic status indicator for cleanup forensics. */
  cleanupSucceeded?: boolean;
  /** Detailed error message or diagnostic if cleanup encountered issues. */
  cleanupDiagnostic?: string;
  /** Remediation shell commands if cleanup failed. */
  recoveryCommands?: readonly string[] | string[];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Create a temporary git worktree for an agent.
 * Returns the worktree path, or undefined if not in a git repo.
 */
export function createWorktree(cwd: string, agentId: string): WorktreeInfo | undefined {
  // Verify we're in a git repo with at least one commit (HEAD must exist)
  let baseSha: string;
  let subdir: string;
  let topLevel: string;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "pipe", timeout: 5000 });
    baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: "pipe", timeout: 5000 })
      .toString()
      .trim();
    // Where cwd sits inside the repo ("" at the root): the agent must work at
    // the same subdirectory inside the copy, or a monorepo-package cwd would
    // silently widen to the whole repo. realpath both sides — git emits
    // resolved paths while cwd may arrive through a symlink (macOS /tmp).
    topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: "pipe", timeout: 5000 })
      .toString()
      .trim();
    subdir = relative(realpathSync(topLevel), realpathSync(cwd));
  } catch {
    return undefined;
  }

  const branch = `pi-agent-${agentId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);

  try {
    // Create detached worktree at HEAD
    execFileSync("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], {
      cwd,
      stdio: "pipe",
      timeout: 30000,
    });
    return { path: worktreePath, branch, baseSha, workPath: subdir ? join(worktreePath, subdir) : worktreePath, repoRoot: topLevel };
  } catch {
    // If worktree creation fails, return undefined (agent runs in normal cwd)
    return undefined;
  }
}

/**
 * Clean up a worktree after agent completion.
 * - If no changes: remove worktree entirely.
 * - If changes exist: create a branch, commit changes, return branch info.
 */
export function cleanupWorktree(
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): WorktreeCleanupResult {
  let hasChanges = false;
  let preservedBranch: string | undefined;
  try {
    if (!existsSync(worktree.path)) {
      // A vanished directory can still have recoverable detached HEAD/index
      // state. Only an already-deregistered checkout is a confirmed no-op.
      removeWorktree(cwd, worktree.path);
      return { hasChanges: false, cleanupSucceeded: true };
    }
    // Check for uncommitted changes in the worktree
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktree.path,
      stdio: "pipe",
      timeout: 10000,
    }).toString().trim();

    if (status) {
      hasChanges = true;
      // Changes exist — stage, commit, and create a branch
      execFileSync("git", ["add", "-A"], { cwd: worktree.path, stdio: "pipe", timeout: 10000 });
      // Truncate description for commit message (no shell sanitization needed — execFileSync uses argv)
      const safeDesc = agentDescription.slice(0, 200);
      const commitMsg = `pi-agent: ${safeDesc}`;
      execFileSync("git", ["commit", "--no-verify", "-m", commitMsg], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 10000,
      });
    } else {
      const currentSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5000,
      }).toString().trim();

      if (currentSha === worktree.baseSha) {
        // No changes — remove worktree
        removeWorktree(cwd, worktree.path);
        return { hasChanges: false, cleanupSucceeded: true };
      }
      hasChanges = true;
    }

    // Create a branch pointing to the worktree's HEAD.
    // If the branch already exists, append a suffix to avoid overwriting previous work.
    let branchName = worktree.branch;
    try {
      execFileSync("git", ["branch", branchName], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch {
      // Branch already exists — use a unique suffix
      branchName = `${worktree.branch}-${Date.now()}`;
      execFileSync("git", ["branch", branchName], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5000,
      });
    }
    // Update branch name in worktree info for the caller
    worktree.branch = branchName;
    preservedBranch = branchName;

    // Remove the worktree (branch persists in main repo)
    removeWorktree(cwd, worktree.path);

    return {
      hasChanges: true,
      branch: worktree.branch,
      path: worktree.path,
      cleanupSucceeded: true,
    };
  } catch (error) {
    // Preservation failed or removal was refused. Keep the checkout and Git
    // registration as recovery references; never remove unpreserved work here.
    return {
      hasChanges,
      ...(preservedBranch ? { branch: preservedBranch } : {}),
      path: worktree.path,
      cleanupSucceeded: false,
      cleanupDiagnostic: error instanceof Error ? error.message : String(error),
      recoveryCommands: [
        `git -C ${shellQuote(cwd)} worktree list --porcelain`,
        `git -C ${shellQuote(worktree.path)} status --short`,
        `git -C ${shellQuote(worktree.path)} log -5 --oneline`,
        "# Inspect and copy the checkout (including untracked files) to a safe location before repairing Git or retrying cleanup.",
      ],
    };
  }
}

/**
 * Async counterpart for cleanupWorktree.
 */
export async function cleanupWorktreeAsync(
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): Promise<WorktreeCleanupResult> {
  return cleanupWorktree(cwd, worktree, agentDescription);
}

function worktreeRegistration(cwd: string, worktreePath: string): string[] | undefined {
  // Git reports canonical paths (e.g. /private/var on macOS). Resolve the
  // parent so verification also works after the directory has disappeared.
  const canonicalPath = join(realpathSync(dirname(worktreePath)), basename(worktreePath));
  return execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
    cwd,
    stdio: "pipe",
    timeout: 5000,
  }).toString().split("\0\0").map((record) => record.split("\0")).find((fields) =>
    fields.some((field) => field.startsWith("worktree ") && [canonicalPath, resolve(worktreePath)].includes(field.slice(9))),
  );
}

/** A continuation may reuse a verified clean checkout, never manufacture a replacement. */
export function assertReusableWorktree(worktree: WorktreeInfo): void {
  const guidance = `Inspect the original checkout and Git registration (${worktree.path}) with git worktree list --porcelain and git status. Restore/repair it explicitly, or start a new Agent with a sanitized summary; no replacement worktree is created.`;
  try {
    if (!existsSync(worktree.path) || !existsSync(worktree.workPath)) throw new Error("original isolated checkout is missing");
    if (realpathSync(worktree.path) === realpathSync(worktree.repoRoot) ||
      !worktreeRegistration(worktree.repoRoot, worktree.path)) throw new Error("isolated checkout has unknown Git ownership");
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: worktree.workPath, stdio: "pipe", timeout: 5000 }).toString().trim();
    if (realpathSync(root) !== realpathSync(worktree.path)) throw new Error("working directory no longer belongs to the isolated checkout");
    const commonDirectory = (cwd: string) => realpathSync(resolve(cwd, execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, stdio: "pipe", timeout: 5000 }).toString().trim()));
    if (commonDirectory(worktree.repoRoot) !== commonDirectory(worktree.workPath)) throw new Error("isolated checkout now belongs to another Git repository");
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: worktree.path, stdio: "pipe", timeout: 5000 }).toString().trim();
    if (dirty) throw new Error("original isolated checkout is dirty; preserve and review its changes first");
  } catch (error) {
    throw new Error(`Cannot continue isolated agent: ${error instanceof Error ? error.message : String(error)}. ${guidance}`);
  }
}

/**
 * Protect observed missing-checkout metadata, even while execution is pinned.
 * Only inspects registration and establishes a Git recovery lock; never stages,
 * commits, removes, or unlocks anything. Lock failures propagate to the owner.
 */
export function protectMissingWorktree(cwd: string, worktreePath: string): string | undefined {
  if (existsSync(worktreePath)) return undefined;
  const registered = worktreeRegistration(cwd, worktreePath);
  if (!registered) return undefined;
  // A Git-owned lock survives manager/session replacement. Preserve existing
  // locks and never automatically unlock them, including after repair/retry.
  if (!registered.some((field) => field === "locked" || field.startsWith("locked "))) {
    try {
      execFileSync("git", ["worktree", "lock", "--reason", "pi-subagents: missing checkout retained for HEAD/index recovery", worktreePath], {
        cwd,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch (error) {
      throw new Error(`Missing worktree recovery registration could not be locked for ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return `Worktree checkout is missing; its Git registration remains locked for HEAD/index recovery: ${worktreePath}`;
}

/** Remove a preserved/unchanged checkout and positively verify deregistration. */
function removeWorktree(cwd: string, worktreePath: string): void {
  const recoveryDiagnostic = protectMissingWorktree(cwd, worktreePath);
  if (recoveryDiagnostic) throw new Error(recoveryDiagnostic);
  if (worktreeRegistration(cwd, worktreePath) || existsSync(worktreePath)) {
    // One --force permits a preserved dirty checkout, but does not override a
    // Git worktree lock. Propagate refusal rather than pretending prune fixed it.
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd,
      stdio: "pipe",
      timeout: 10000,
    });
  }
  if (existsSync(worktreePath) || worktreeRegistration(cwd, worktreePath)) {
    throw new Error(`Worktree removal was not confirmed for ${worktreePath}`);
  }
}

/**
 * Prune any orphaned worktrees (crash recovery).
 */
export function pruneWorktrees(cwd: string): void {
  try {
    execFileSync("git", ["worktree", "prune"], { cwd, stdio: "pipe", timeout: 5000 });
  } catch { /* ignore */ }
}

/**
 * Async crash recovery counterpart.
 */
export async function pruneWorktreesAsync(cwd: string): Promise<void> {
  pruneWorktrees(cwd);
}
