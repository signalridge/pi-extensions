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
    return runGit(cwd, ["rev-parse", "--show-prefix"], 2000).replace(/\n$/, "");
  } catch {
    return "";
  }
}

/** Convert a repo-root-relative path to a cwd-relative one; null if outside cwd. */
export function stripPathPrefix(filePath: string, prefix: string): string | null {
  if (!prefix) return filePath;
  if (filePath.startsWith(prefix)) return filePath.slice(prefix.length);
  return null;
}

/** Porcelain v1 -z has target first, then a separate origin for R/C in either column. */
export function parseGitStatusZ(output: string): Array<{ code: string; path: string }> {
  const result: Array<{ code: string; path: string }> = [];
  const entries = output.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4 || entry[2] !== " ") continue;
    const xy = entry.slice(0, 2);
    result.push({ code: xy.trim() || "?", path: entry.slice(3) });
    if (/[RC]/u.test(xy)) i += 1;
  }
  return result;
}

export function getGitStatus(cwd: string, options: { includeIgnored?: boolean } = {}): Map<string, string> {
  const status = new Map<string, string>();
  const prefix = getGitPathPrefix(cwd);

  const collect = (args: string[]): void => {
    try {
      const output = runGit(cwd, args, 5000);
      for (const entry of parseGitStatusZ(output)) {
        const filePath = stripPathPrefix(entry.path, prefix);
        if (filePath === null || !filePath) continue;
        status.set(filePath, entry.code);
      }
    } catch {}
  };

  // `-uall` mirrors getGitFileList, so every untracked file the browser lists
  // also carries a badge — including files inside an untracked directory — and
  // neither helper is at the mercy of the user's `status.showUntrackedFiles`.
  collect(["--no-optional-locks", "status", "--porcelain", "-z", "-uall"]);
  if (options.includeIgnored !== false) {
    // Ignored paths need a second pass at the default `-unormal`: `--ignored`
    // together with `-uall` enumerates every file under an ignored directory
    // (tens of thousands of `node_modules` entries) instead of collapsing them
    // into a single `!! node_modules/` row.
    collect(["--no-optional-locks", "status", "--porcelain", "-z", "--ignored"]);
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
    const statusOutput = runGit(cwd, ["--no-optional-locks", "status", "--porcelain", "-uall", "-z"], 5000);
    for (const entry of parseGitStatusZ(statusOutput)) {
      const relPath = stripPathPrefix(entry.path, prefix);
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

export function parseNumstatZ(output: string): Map<string, DiffStats> {
  const stats = new Map<string, DiffStats>();
  const entries = output.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const match = /^([^\t]+)\t([^\t]+)\t([\s\S]*)$/u.exec(entries[i]);
    if (!match) continue;
    let path = match[3];
    if (!path) {
      // A rename has an empty path followed by origin and target NUL fields.
      path = entries[i + 2];
      i += 2;
    }
    if (path) stats.set(path, { additions: parseInt(match[1], 10) || 0, deletions: parseInt(match[2], 10) || 0 });
  }
  return stats;
}

export function getGitDiffStats(cwd: string): Map<string, DiffStats> {
  const stats = new Map<string, DiffStats>();
  try {
    // Get diff stats for modified files. --relative keeps paths relative to cwd
    // (and scoped to it) so they match the widget's cwd-relative node keys even
    // when cwd is a subdirectory of the repository. --no-ext-diff pins the
    // output format against a configured `diff.external`.
    const output = runGit(cwd, ["diff", "--no-ext-diff", "--relative", "--numstat", "-z", "HEAD"], 5000);
    for (const [path, counts] of parseNumstatZ(output)) stats.set(path, counts);
    // `diff HEAD` already spans index + worktree, so the cached pass only fills
    // in paths it missed — a change that is staged and then reverted in the
    // worktree. Adding the two would count every staged line twice.
    const stagedOutput = runGit(cwd, ["diff", "--no-ext-diff", "--relative", "--numstat", "-z", "--cached"], 5000);
    for (const [path, counts] of parseNumstatZ(stagedOutput)) {
      if (!stats.has(path)) stats.set(path, counts);
    }
  } catch {}
  return stats;
}
