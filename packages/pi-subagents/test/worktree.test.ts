import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorktreeInfo } from "../src/worktree.js";
import { cleanupWorktree, cleanupWorktreeAsync, createWorktree, pruneWorktrees } from "../src/worktree.js";

/**
 * Helper: create a temporary git repo with an initial commit.
 */
function initGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-test-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# Test repo");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "pipe" });
  return dir;
}

function initGitRepoAt(dir: string): string {
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# Detached worktree");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "pipe" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, stdio: "pipe" }).toString().trim();
}

describe("worktree", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = initGitRepo();
  });

  afterEach(() => {
    // Clean up any lingering worktrees first, then remove repo
    try { pruneWorktrees(repoDir); } catch { /* ignore */ }
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe("createWorktree", () => {
    it("creates a worktree in tmpdir", () => {
      const wt = createWorktree(repoDir, "test-id-1");
      expect(wt).toBeDefined();
      expect(existsSync(wt!.path)).toBe(true);
      expect(wt!.branch).toBe("pi-agent-test-id-1");
      expect(wt!.repoRoot).toBe(realpathSync(repoDir));
      expect(wt!.baseSha).toBe(execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim());

      // Verify it's a valid worktree with the repo's files
      expect(existsSync(join(wt!.path, "README.md"))).toBe(true);

      // Cleanup
      try { execFileSync("git", ["worktree", "remove", "--force", wt!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("returns undefined for non-git directory", () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        const wt = createWorktree(nonGit, "test-id-2");
        expect(wt).toBeUndefined();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });

    it("returns undefined for git repo with no commits", () => {
      const emptyRepo = mkdtempSync(join(tmpdir(), "pi-wt-empty-"));
      try {
        execFileSync("git", ["init"], { cwd: emptyRepo, stdio: "pipe" });
        const wt = createWorktree(emptyRepo, "no-commits");
        expect(wt).toBeUndefined();
      } finally {
        rmSync(emptyRepo, { recursive: true, force: true });
      }
    });

    it("workPath equals path when created from the repo root", () => {
      const wt = createWorktree(repoDir, "root-wp")!;
      expect(wt.workPath).toBe(wt.path);
      try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("workPath preserves subdirectory scoping (monorepo package cwd)", () => {
      mkdirSync(join(repoDir, "packages", "api"), { recursive: true });
      writeFileSync(join(repoDir, "packages", "api", "index.ts"), "export {}");
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "add package"], { cwd: repoDir, stdio: "pipe" });

      const wt = createWorktree(join(repoDir, "packages", "api"), "subdir-wp")!;
      expect(wt).toBeDefined();
      expect(wt.repoRoot).toBe(realpathSync(repoDir));
      expect(wt.workPath).toBe(join(wt.path, "packages", "api"));
      expect(existsSync(wt.workPath)).toBe(true);
      try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("uses the nearest Git root when cwd is inside a nested repository", () => {
      const nestedRepo = join(repoDir, "packages", "nested");
      mkdirSync(nestedRepo, { recursive: true });
      execFileSync("git", ["init"], { cwd: nestedRepo, stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: nestedRepo, stdio: "pipe" });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: nestedRepo, stdio: "pipe" });
      writeFileSync(join(nestedRepo, "README.md"), "# Nested repo");
      execFileSync("git", ["add", "README.md"], { cwd: nestedRepo, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "nested initial"], { cwd: nestedRepo, stdio: "pipe" });

      const wt = createWorktree(nestedRepo, "nested-root")!;
      expect(wt.repoRoot).toBe(realpathSync(nestedRepo));
      expect(wt.workPath).toBe(wt.path);
      try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: nestedRepo, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("uses unique paths for multiple worktrees", () => {
      const wt1 = createWorktree(repoDir, "multi-1");
      const wt2 = createWorktree(repoDir, "multi-2");
      expect(wt1).toBeDefined();
      expect(wt2).toBeDefined();
      expect(wt1!.path).not.toBe(wt2!.path);

      // Cleanup
      try { execFileSync("git", ["worktree", "remove", "--force", wt1!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
      try { execFileSync("git", ["worktree", "remove", "--force", wt2!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });
  });

  describe("cleanupWorktree", () => {
    it("removes worktree when no changes made", () => {
      const wt = createWorktree(repoDir, "clean-1")!;
      expect(wt).toBeDefined();

      const result = cleanupWorktree(repoDir, wt, "test cleanup");
      expect(result.hasChanges).toBe(false);
      expect(result.branch).toBeUndefined();
    });


    it("does not report success for a dangling symlink that replaced the worktree", () => {
      const tempRoot = resolve(tmpdir());
      const tempName = "pi-agent-fallback-deadc0de";
      const path = join(tempRoot, tempName);
      symlinkSync(join(tempRoot, `${tempName}-missing`), path, "dir");
      const wt: WorktreeInfo = {
        path,
        branch: "pi-agent-fallback",
        baseSha: "missing",
        repoRoot: realpathSync(repoDir),
        workPath: path,
        tempRoot,
        tempName,
      };

      try {
        const result = cleanupWorktree(repoDir, wt, "dangling symlink cleanup");
        expect(result.cleanupSucceeded).toBe(false);
        expect(result.filesystemFallbackAttempted).toBe(false);
        expect(result.pruneAttempted).toBe(true);
        expect(result.cleanupDiagnostic).toContain(path);
        expect(result.cleanupDiagnostic).toContain("symlink");
        expect(result.recoveryCommands?.join(" ")).toContain(path);
        expect(lstatSync(path).isSymbolicLink()).toBe(true);
      } finally {
        unlinkSync(path);
      }
    });

    it("does not follow or remove a live symlink that replaced the worktree", () => {
      const tempRoot = resolve(tmpdir());
      const tempName = "pi-agent-fallback-feedface";
      const path = join(tempRoot, tempName);
      const target = mkdtempSync(join(tmpdir(), "pi-wt-live-target-"));
      writeFileSync(join(target, "keep.txt"), "keep");
      symlinkSync(target, path, "dir");
      const wt: WorktreeInfo = {
        path,
        branch: "pi-agent-fallback",
        baseSha: "missing",
        repoRoot: realpathSync(repoDir),
        workPath: path,
        tempRoot,
        tempName,
      };

      try {
        const result = cleanupWorktree(repoDir, wt, "live symlink cleanup");
        expect(result.cleanupSucceeded).toBe(false);
        expect(result.filesystemFallbackAttempted).toBe(false);
        expect(result.cleanupDiagnostic).toContain(path);
        expect(result.cleanupDiagnostic).toContain("symlink");
        expect(lstatSync(path).isSymbolicLink()).toBe(true);
        expect(existsSync(join(target, "keep.txt"))).toBe(true);
      } finally {
        unlinkSync(path);
        rmSync(target, { recursive: true, force: true });
      }
    });

    it("does not report success for a special file that replaced the worktree", () => {
      const tempRoot = resolve(tmpdir());
      const tempName = "pi-agent-fallback-cafebabe";
      const path = join(tempRoot, tempName);
      writeFileSync(path, "replacement");
      const wt: WorktreeInfo = {
        path,
        branch: "pi-agent-fallback",
        baseSha: "missing",
        repoRoot: realpathSync(repoDir),
        workPath: path,
        tempRoot,
        tempName,
      };

      try {
        const result = cleanupWorktree(repoDir, wt, "special file cleanup");
        expect(result.cleanupSucceeded).toBe(false);
        expect(result.filesystemFallbackAttempted).toBe(false);
        expect(result.cleanupDiagnostic).toContain(path);
        expect(result.cleanupDiagnostic).toContain("special file");
        expect(existsSync(path)).toBe(true);
      } finally {
        rmSync(path, { force: true });
      }
    });

    it("keeps an absent directory cleanup result verifiable", () => {
      const tempRoot = resolve(tmpdir());
      const tempName = "pi-agent-fallback-ab5e0000";
      const path = join(tempRoot, tempName);
      const wt: WorktreeInfo = {
        path,
        branch: "pi-agent-fallback",
        baseSha: "missing",
        repoRoot: realpathSync(repoDir),
        workPath: path,
        tempRoot,
        tempName,
      };

      const result = cleanupWorktree(repoDir, wt, "already absent cleanup");
      expect(result.cleanupSucceeded).toBe(true);
      expect(result.filesystemFallbackSucceeded).toBe(true);
      expect(existsSync(path)).toBe(false);
    });

    it("fails closed when lstat cannot verify the worktree path", () => {
      const errorRoot = mkdtempSync(join(tmpdir(), "pi-wt-lstat-error-"));
      const path = join(errorRoot, "worktree");
      const wt: WorktreeInfo = {
        path,
        branch: "pi-agent-lstat-error",
        baseSha: "missing",
        repoRoot: realpathSync(repoDir),
        workPath: path,
      };
      chmodSync(errorRoot, 0o000);

      try {
        const result = cleanupWorktree(repoDir, wt, "lstat error cleanup");
        expect(result.cleanupSucceeded).toBe(false);
        expect(result.filesystemFallbackAttempted).toBe(false);
        expect(result.cleanupDiagnostic).toContain(path);
        expect(result.cleanupDiagnostic).toContain("could not be verified");
        expect(result.recoveryCommands?.join(" ")).toContain(path);
      } finally {
        chmodSync(errorRoot, 0o700);
        rmSync(errorRoot, { recursive: true, force: true });
      }
    });

    it("falls back to safe filesystem removal and prunes registration after Git removal fails", () => {
      const tempRoot = resolve(tmpdir());
      const tempName = "pi-agent-fallback-deadbeef";
      const path = join(tempRoot, tempName);
      mkdirSync(path);
      const baseSha = initGitRepoAt(path);
      const wt: WorktreeInfo = {
        path,
        branch: "pi-agent-fallback",
        baseSha,
        repoRoot: realpathSync(repoDir),
        workPath: path,
        tempRoot,
        tempName,
      };

      try {
        const result = cleanupWorktree(repoDir, wt, "fallback cleanup");
        expect(result.cleanupSucceeded).toBe(true);
        expect(result.gitRemovalSucceeded).toBe(false);
        expect(result.filesystemFallbackAttempted).toBe(true);
        expect(result.filesystemFallbackSucceeded).toBe(true);
        expect(result.pruneAttempted).toBe(true);
        expect(result.pruneSucceeded).toBe(true);
        expect(result.registrationCleanupVerified).toBe(true);
        expect(existsSync(path)).toBe(false);
      } finally {
        rmSync(path, { recursive: true, force: true });
      }
    });

    it("retains diagnostic recovery metadata when Git and filesystem removal both fail", () => {
      const tempRoot = resolve(tmpdir());
      const tempName = "pi-agent-fallback-badf000d";
      const path = join(tempRoot, tempName);
      mkdirSync(path);
      let baseSha = initGitRepoAt(path);
      const lockedDirectory = join(path, "locked");
      mkdirSync(lockedDirectory, { recursive: true });
      writeFileSync(join(lockedDirectory, "file.txt"), "locked");
      execFileSync("git", ["add", "-A"], { cwd: path, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "add locked file"], { cwd: path, stdio: "pipe" });
      baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, stdio: "pipe" }).toString().trim();
      const wt: WorktreeInfo = {
        path,
        branch: "pi-agent-fallback",
        baseSha,
        repoRoot: realpathSync(repoDir),
        workPath: path,
        tempRoot,
        tempName,
      };
      chmodSync(lockedDirectory, 0o500);

      try {
        const result = cleanupWorktree(repoDir, wt, "failed cleanup");
        expect(result.cleanupSucceeded).toBe(false);
        expect(result.path).toBe(path);
        expect(result.filesystemFallbackAttempted).toBe(true);
        expect(result.filesystemFallbackSucceeded).toBe(false);
        expect(result.pruneAttempted).toBe(true);
        expect(result.cleanupDiagnostic).toContain(path);
        expect(result.cleanupDiagnostic).toContain("filesystem fallback failed");
        expect(result.recoveryCommands?.join(" ")).toContain(path);
        expect(existsSync(path)).toBe(true);
      } finally {
        chmodSync(lockedDirectory, 0o700);
        rmSync(path, { recursive: true, force: true });
      }
    });

    it("does not use direct rm for an arbitrary worktree path", () => {
      const path = join(repoDir, "not-a-package-worktree");
      mkdirSync(path);
      const wt: WorktreeInfo = {
        path,
        branch: "pi-agent-arbitrary",
        baseSha: "missing",
        repoRoot: realpathSync(repoDir),
        workPath: path,
      };

      try {
        const result = cleanupWorktree(repoDir, wt, "unsafe cleanup");
        expect(result.cleanupSucceeded).toBe(false);
        expect(result.filesystemFallbackAttempted).toBe(false);
        expect(result.cleanupDiagnostic).toContain("not a verified package-created worktree");
        expect(existsSync(path)).toBe(true);
      } finally {
        rmSync(path, { recursive: true, force: true });
      }
    });

    it("commits changes and creates branch when changes exist", () => {
      const wt = createWorktree(repoDir, "dirty-1")!;
      expect(wt).toBeDefined();

      // Make a change in the worktree
      writeFileSync(join(wt.path, "new-file.txt"), "agent wrote this");

      const result = cleanupWorktree(repoDir, wt, "added new file");
      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBeDefined();
      expect(result.branch).toContain("pi-agent-dirty-1");

      // Verify the branch exists in the main repo
      const branches = execFileSync("git", ["branch", "--list", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(branches).toContain(result.branch!);

      // Verify the commit message
      const log = execFileSync("git", ["log", "--oneline", "-1", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(log).toContain("pi-agent: added new file");

      // Cleanup branch
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });


    it("async cleanup detects and preserves changes from the worktree cwd", async () => {
      const wt = createWorktree(repoDir, "async-dirty-1")!;
      writeFileSync(join(wt.path, "async-file.txt"), "preserve me");

      const result = await cleanupWorktreeAsync(repoDir, wt, "async added file");

      expect(result.cleanupSucceeded).toBe(true);
      expect(result.hasChanges).toBe(true);
      expect(result.branch).toContain("pi-agent-async-dirty-1");
      expect(existsSync(wt.path)).toBe(false);
      const preserved = execFileSync("git", ["show", `${result.branch}:async-file.txt`], {
        cwd: repoDir, stdio: "pipe",
      }).toString();
      expect(preserved).toBe("preserve me");

      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("commits changes even when a pre-commit hook rejects (--no-verify)", () => {
      // A failing pre-commit hook in the main repo also applies to its
      // worktrees — without --no-verify it would abort the preservation commit.
      const hookPath = join(repoDir, ".git", "hooks", "pre-commit");
      writeFileSync(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

      const wt = createWorktree(repoDir, "hooked-1")!;
      expect(wt).toBeDefined();
      writeFileSync(join(wt.path, "hooked-file.txt"), "agent wrote this");

      const result = cleanupWorktree(repoDir, wt, "hook should not block");
      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBe("pi-agent-hooked-1");

      // Cleanup branch
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("creates branch when worktree is clean but HEAD moved", () => {
      const wt = createWorktree(repoDir, "committed-1")!;
      expect(wt).toBeDefined();

      writeFileSync(join(wt.path, "committed-file.txt"), "agent committed this");
      execFileSync("git", ["add", "committed-file.txt"], { cwd: wt.path, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "agent commit"], { cwd: wt.path, stdio: "pipe" });
      const agentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: wt.path, stdio: "pipe",
      }).toString().trim();

      const result = cleanupWorktree(repoDir, wt, "already committed");
      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBeDefined();
      expect(result.branch).toBe("pi-agent-committed-1");

      const branchCommit = execFileSync("git", ["rev-parse", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(branchCommit).toBe(agentCommit);
      expect(existsSync(wt.path)).toBe(false);

      // Cleanup branch
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("does not force-overwrite existing branch", () => {
      // Create first worktree, make changes, cleanup → creates branch
      const wt1 = createWorktree(repoDir, "conflict-1")!;
      writeFileSync(join(wt1.path, "file1.txt"), "first run");
      const result1 = cleanupWorktree(repoDir, wt1, "first");
      expect(result1.branch).toBe("pi-agent-conflict-1");

      // Create second worktree with same agent ID, make changes
      const wt2 = createWorktree(repoDir, "conflict-1")!;
      writeFileSync(join(wt2.path, "file2.txt"), "second run");
      const result2 = cleanupWorktree(repoDir, wt2, "second");

      // Should use a different branch name (timestamp suffix)
      expect(result2.hasChanges).toBe(true);
      expect(result2.branch).toBeDefined();
      expect(result2.branch).not.toBe("pi-agent-conflict-1");
      expect(result2.branch).toContain("pi-agent-conflict-1-");

      // Both branches should exist
      const branches = execFileSync("git", ["branch", "--list", "pi-agent-conflict-1*"], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(branches).toContain("pi-agent-conflict-1");
      expect(branches).toContain(result2.branch!);

      // Cleanup
      try { execFileSync("git", ["branch", "-D", result1.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
      try { execFileSync("git", ["branch", "-D", result2.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("handles already-deleted worktree gracefully", () => {
      const wt = createWorktree(repoDir, "gone-1")!;
      // Manually delete the worktree directory
      rmSync(wt.path, { recursive: true, force: true });

      const result = cleanupWorktree(repoDir, wt, "already gone");
      expect(result.hasChanges).toBe(false);
    });

    it("truncates commit message at 200 chars", () => {
      const wt = createWorktree(repoDir, "long-msg")!;
      writeFileSync(join(wt.path, "change.txt"), "something");
      const longDesc = "x".repeat(300);
      const result = cleanupWorktree(repoDir, wt, longDesc);
      expect(result.hasChanges).toBe(true);

      const log = execFileSync("git", ["log", "--oneline", "-1", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      // "pi-agent: " prefix (10 chars) + 200 chars of x = 210 total max
      expect(log.length).toBeLessThanOrEqual(220); // some slack for hash prefix

      // Cleanup
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });
  });

  describe("pruneWorktrees", () => {
    it("does not throw on a clean repo", () => {
      expect(() => pruneWorktrees(repoDir)).not.toThrow();
    });

    it("does not throw on non-git directory", () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        expect(() => pruneWorktrees(nonGit)).not.toThrow();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });
  });
});
