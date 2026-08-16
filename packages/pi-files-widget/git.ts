import { execFileSync } from "node:child_process";

import type { DiffStats } from "./types.js";

/**
 * Every git call goes through argv rather than `/bin/sh`. None of the current
 * arguments are caller-controlled, but keeping the whole module shell-free means
 * a future pathspec parameter cannot quietly reintroduce a command injection.
 */
function runGit(cwd: string, args: string[], timeoutMs: number): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: "pipe",
  });
}

export function isGitRepo(cwd: string): boolean {
  try {
    runGit(cwd, ["rev-parse", "--is-inside-work-tree"], 2000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Path of `cwd` relative to the repository top-level (e.g. "app/"), or "" when
 * `cwd` is the top-level itself. `git status --porcelain` reports paths relative
 * to the repository root, while `git ls-files` (and this widget's node keys) are
 * relative to `cwd` — this prefix lets us translate between the two.
 */
function getGitPathPrefix(cwd: string): string {
  try {
    return runGit(cwd, ["rev-parse", "--show-prefix"], 2000).trim();
  } catch {
    return "";
  }
}

/** Convert a repo-root-relative path to a cwd-relative one; null if outside cwd. */
function stripPathPrefix(filePath: string, prefix: string): string | null {
  if (!prefix) return filePath;
  if (filePath.startsWith(prefix)) return filePath.slice(prefix.length);
  return null;
}

export function getGitStatus(cwd: string, options: { includeIgnored?: boolean } = {}): Map<string, string> {
  const status = new Map<string, string>();
  const prefix = getGitPathPrefix(cwd);

  const collect = (args: string[]): void => {
    try {
      const output = runGit(cwd, args, 5000);
      for (const line of output.split("\n")) {
        if (line.length < 3) continue;
        const statusCode = line.slice(0, 2).trim() || "?";
        const filePath = stripPathPrefix(line.slice(3), prefix);
        if (filePath === null || !filePath) continue;
        status.set(filePath, statusCode);
      }
    } catch {}
  };

  // `-uall` mirrors getGitFileList, so every untracked file the browser lists
  // also carries a badge — including files inside an untracked directory — and
  // neither helper is at the mercy of the user's `status.showUntrackedFiles`.
  collect(["status", "--porcelain", "-uall"]);
  if (options.includeIgnored !== false) {
    // Ignored paths need a second pass at the default `-unormal`: `--ignored`
    // together with `-uall` enumerates every file under an ignored directory
    // (tens of thousands of `node_modules` entries) instead of collapsing them
    // into a single `!! node_modules/` row.
    collect(["status", "--porcelain", "--ignored"]);
  }

  return status;
}

export function getGitFileList(cwd: string): string[] {
  const files = new Set<string>();
  try {
    const tracked = runGit(cwd, ["ls-files", "-z"], 5000);
    for (const entry of tracked.split("\0")) {
      if (entry) files.add(entry);
    }
  } catch {}

  try {
    const prefix = getGitPathPrefix(cwd);
    const statusOutput = runGit(cwd, ["status", "--porcelain", "-uall", "-z"], 5000);
    const entries = statusOutput.split("\0");
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const statusCode = entry.slice(0, 2).trim();
      let filePath = entry.slice(3);
      if ((statusCode.startsWith("R") || statusCode.startsWith("C")) && entries[i + 1]) {
        // `-z` reverses rename/copy entries to `XY <new>\0<old>`, so the entry we
        // already read is the surviving path. Consume the origin field anyway, or
        // the next iteration would parse it as a status entry.
        i += 1;
      } else if (filePath.includes(" -> ")) {
        filePath = filePath.split(" -> ").pop() || filePath;
      }
      const relPath = filePath ? stripPathPrefix(filePath, prefix) : null;
      if (relPath) {
        files.add(relPath);
      }
    }
  } catch {}

  return Array.from(files);
}

export function getGitBranch(cwd: string): string {
  try {
    return runGit(cwd, ["branch", "--show-current"], 2000).trim();
  } catch {
    return "";
  }
}

export function getGitDiffStats(cwd: string): Map<string, DiffStats> {
  const stats = new Map<string, DiffStats>();
  try {
    // Get diff stats for modified files. --relative keeps paths relative to cwd
    // (and scoped to it) so they match the widget's cwd-relative node keys even
    // when cwd is a subdirectory of the repository. --no-ext-diff pins the
    // output format against a configured `diff.external`.
    const output = runGit(cwd, ["diff", "--no-ext-diff", "--relative", "--numstat", "HEAD"], 5000);
    for (const line of output.split("\n")) {
      const parts = line.split("\t");
      if (parts.length >= 3) {
        const additions = parseInt(parts[0], 10) || 0;
        const deletions = parseInt(parts[1], 10) || 0;
        const filePath = parts[2];
        stats.set(filePath, { additions, deletions });
      }
    }
    // `diff HEAD` already spans index + worktree, so the cached pass only fills
    // in paths it missed — a change that is staged and then reverted in the
    // worktree. Adding the two would count every staged line twice.
    const stagedOutput = runGit(cwd, ["diff", "--no-ext-diff", "--relative", "--numstat", "--cached"], 5000);
    for (const line of stagedOutput.split("\n")) {
      const parts = line.split("\t");
      if (parts.length >= 3) {
        const additions = parseInt(parts[0], 10) || 0;
        const deletions = parseInt(parts[1], 10) || 0;
        const filePath = parts[2];
        if (!stats.has(filePath)) {
          stats.set(filePath, { additions, deletions });
        }
      }
    }
  } catch {}
  return stats;
}
