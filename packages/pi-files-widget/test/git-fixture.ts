import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// The helpers only describe real `git` output, so there is nothing meaningful to
// assert without the binary; skip rather than fail on a git-less machine.
export const skipWithoutGit: false | string = gitAvailable() ? false : "git is not available on PATH";

/**
 * Repository-local settings that pin every ambient git behaviour these tests
 * depend on. Local config outranks the developer's global and system config, so
 * this is what keeps a machine-wide `core.hooksPath` (pre-commit, git-secrets,
 * husky), `commit.gpgsign`, `core.excludesFile`, `core.autocrlf` or
 * `status.showUntrackedFiles` from deciding whether the suite passes.
 *
 * Config is the isolation mechanism rather than `GIT_CONFIG_GLOBAL=/dev/null`
 * because the helpers under test spawn `git` themselves: they would need the
 * variables in the *process* environment, and Bun does not propagate
 * `process.env` mutations to child processes (verified on bun 1.3.14). Local
 * config also covers those spawns, and needs no POSIX-only shell prelude.
 */
const ISOLATING_CONFIG: Array<[string, string]> = [
  ["user.email", "files-widget@example.invalid"],
  ["user.name", "Files Widget Test"],
  ["commit.gpgsign", "false"],
  ["core.excludesFile", "/dev/null"],
  ["core.attributesFile", "/dev/null"],
  ["core.autocrlf", "false"],
  ["core.safecrlf", "false"],
  ["core.fsmonitor", "false"],
  ["status.showUntrackedFiles", "normal"],
];

export interface Repo {
  root: string;
  git: (...args: string[]) => void;
}

/** A throwaway repository with deterministic identity, torn down with the test. */
export function initRepo(t: TestContext, prefix = "files-widget-git-"): Repo {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "pipe", timeout: 10000 });
  };
  git("init", "-q", "-b", "main");
  for (const [key, value] of ISOLATING_CONFIG) {
    git("config", key, value);
  }
  // Pointing at a directory that does not exist disables hooks outright,
  // including any that `init.templateDir` just copied into .git/hooks.
  git("config", "core.hooksPath", join(root, ".git", "hooks-disabled"));
  return { root, git };
}
