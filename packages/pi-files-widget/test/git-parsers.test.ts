import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getGitBranch, getGitDiffStats, getGitFileList, getGitStatus } from "../git.ts";
import { initRepo, skipWithoutGit as skip } from "./git-fixture.ts";

function write(root: string, relPath: string, contents: string): void {
  writeFileSync(join(root, relPath), contents);
}

test("getGitStatus reports two-letter codes trimmed per path", { skip }, (t) => {
  const { root, git } = initRepo(t);
  write(root, ".gitignore", "ignored.txt\n");
  write(root, "tracked.txt", "one\n");
  git("add", ".gitignore", "tracked.txt");
  git("commit", "-qm", "init");

  write(root, "tracked.txt", "one\ntwo\n");
  write(root, "added.txt", "new\n");
  git("add", "added.txt");
  write(root, "untracked.txt", "loose\n");
  write(root, "ignored.txt", "hidden\n");

  const status = getGitStatus(root);
  assert.equal(status.get("tracked.txt"), "M");
  assert.equal(status.get("added.txt"), "A");
  assert.equal(status.get("untracked.txt"), "??");
  assert.equal(status.get("ignored.txt"), "!!");
  assert.equal(status.get(".gitignore"), undefined, "clean files are absent from the map");

  const withoutIgnored = getGitStatus(root, { includeIgnored: false });
  assert.equal(withoutIgnored.get("ignored.txt"), undefined);
  assert.equal(withoutIgnored.get("untracked.txt"), "??");
});

test("getGitStatus rewrites repo-root paths to the cwd via --show-prefix", { skip }, (t) => {
  const { root, git } = initRepo(t);
  mkdirSync(join(root, "sub"));
  write(root, "top.txt", "top\n");
  write(root, "sub/nested.txt", "nested\n");
  git("add", "top.txt", "sub/nested.txt");
  git("commit", "-qm", "init");
  write(root, "top.txt", "top changed\n");
  write(root, "sub/nested.txt", "nested changed\n");

  const status = getGitStatus(join(root, "sub"));
  assert.equal(status.get("nested.txt"), "M", "the prefix is stripped from in-scope paths");
  assert.equal(status.get("sub/nested.txt"), undefined);
  assert.equal(status.get("top.txt"), undefined, "paths outside the cwd are dropped");
});

test("getGitStatus badges the files getGitFileList lists inside an untracked directory", { skip }, (t) => {
  const { root, git } = initRepo(t);
  write(root, "tracked.txt", "one\n");
  git("add", "tracked.txt");
  git("commit", "-qm", "init");
  mkdirSync(join(root, "fresh"));
  write(root, "fresh/loose.txt", "loose\n");

  // The default `-unormal` collapses the directory into one `?? fresh/` row, so
  // the file the browser lists from getGitFileList would carry no status badge.
  assert.deepEqual(getGitFileList(root).sort(), ["fresh/loose.txt", "tracked.txt"]);
  const status = getGitStatus(root);
  assert.equal(status.get("fresh/loose.txt"), "??");
  assert.equal(status.get("fresh/"), "??", "the collapsed directory row survives too");
});

test("getGitStatus collapses ignored directories instead of enumerating them", { skip }, (t) => {
  const { root, git } = initRepo(t);
  write(root, ".gitignore", "vendor/\n");
  git("add", ".gitignore");
  git("commit", "-qm", "init");
  mkdirSync(join(root, "vendor"));
  write(root, "vendor/a.txt", "a\n");
  write(root, "vendor/b.txt", "b\n");

  // Asking for `--ignored` and `-uall` in one pass expands every ignored file —
  // tens of thousands of node_modules rows in a real repository — so the
  // untracked pass must stay separate from the ignored one.
  const status = getGitStatus(root);
  assert.equal(status.get("vendor/"), "!!");
  assert.equal(status.get("vendor/a.txt"), undefined);
});

test("getGitFileList keeps the surviving path of a -z rename entry", { skip }, (t) => {
  const { root, git } = initRepo(t);
  write(root, "old.txt", "one\n");
  write(root, "keep.txt", "keep\n");
  git("add", "old.txt", "keep.txt");
  git("commit", "-qm", "init");
  git("mv", "old.txt", "new.txt");

  const files = getGitFileList(root).sort();
  // `git status --porcelain -z` emits `R  new.txt\0old.txt\0`; the origin field
  // must be consumed, never surfaced as a node for a file that no longer exists.
  assert.deepEqual(files, ["keep.txt", "new.txt"]);
});

test("getGitFileList consumes the rename origin field instead of misparsing it", { skip }, (t) => {
  const { root, git } = initRepo(t);
  write(root, "alpha.txt", "a\n");
  git("add", "alpha.txt");
  git("commit", "-qm", "init");
  git("mv", "alpha.txt", "beta.txt");
  // A second untracked entry after the rename would be shifted onto the origin
  // field if the two-entry record were not consumed as a pair.
  write(root, "zeta.txt", "z\n");

  const files = getGitFileList(root).sort();
  assert.deepEqual(files, ["beta.txt", "zeta.txt"]);
});

test("getGitFileList lists untracked files and strips the cwd prefix", { skip }, (t) => {
  const { root, git } = initRepo(t);
  mkdirSync(join(root, "sub"));
  write(root, "top.txt", "top\n");
  write(root, "sub/tracked.txt", "tracked\n");
  git("add", "top.txt", "sub/tracked.txt");
  git("commit", "-qm", "init");
  write(root, "sub/untracked.txt", "loose\n");
  write(root, "outside.txt", "loose\n");

  const files = getGitFileList(join(root, "sub")).sort();
  assert.deepEqual(files, ["tracked.txt", "untracked.txt"]);
});

test("getGitDiffStats counts each staged line once when merging the numstat passes", { skip }, (t) => {
  const { root, git } = initRepo(t);
  write(root, "both.txt", "a\nb\nc\n");
  write(root, "staged-only.txt", "a\n");
  write(root, "worktree-only.txt", "a\n");
  git("add", ".");
  git("commit", "-qm", "init");

  // both.txt gets one staged addition and, on top of it, one unstaged addition.
  write(root, "both.txt", "a\nb\nc\nstaged\n");
  write(root, "staged-only.txt", "a\nstaged\nstaged2\n");
  git("add", "both.txt", "staged-only.txt");
  write(root, "both.txt", "a\nb\nc\nstaged\nunstaged\n");
  write(root, "worktree-only.txt", "");

  const stats = getGitDiffStats(root);
  // `diff HEAD` already spans index + worktree; the cached pass must not add
  // the staged lines a second time.
  assert.deepEqual(stats.get("both.txt"), { additions: 2, deletions: 0 });
  assert.deepEqual(stats.get("staged-only.txt"), {
    additions: 2,
    deletions: 0,
  });
  assert.deepEqual(stats.get("worktree-only.txt"), {
    additions: 0,
    deletions: 1,
  });
});

test("getGitDiffStats falls back to the cached pass for staged-then-reverted files", { skip }, (t) => {
  const { root, git } = initRepo(t);
  write(root, "reverted.txt", "a\n");
  git("add", ".");
  git("commit", "-qm", "init");

  write(root, "reverted.txt", "a\nstaged\n");
  git("add", "reverted.txt");
  write(root, "reverted.txt", "a\n"); // worktree back at HEAD, index ahead

  const stats = getGitDiffStats(root);
  assert.deepEqual(stats.get("reverted.txt"), { additions: 1, deletions: 0 });
});

test("getGitDiffStats scopes paths to the cwd via --relative", { skip }, (t) => {
  const { root, git } = initRepo(t);
  mkdirSync(join(root, "sub"));
  write(root, "top.txt", "a\n");
  write(root, "sub/nested.txt", "a\n");
  git("add", ".");
  git("commit", "-qm", "init");
  write(root, "top.txt", "a\nb\n");
  write(root, "sub/nested.txt", "a\nb\n");

  const stats = getGitDiffStats(join(root, "sub"));
  assert.deepEqual(stats.get("nested.txt"), { additions: 1, deletions: 0 });
  assert.equal(stats.get("top.txt"), undefined);
  assert.equal(stats.get("sub/nested.txt"), undefined);
});

test("git helpers degrade to empty results outside a repository", { skip }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "files-widget-nogit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.equal(getGitBranch(root), "");
  assert.equal(getGitStatus(root).size, 0);
  assert.equal(getGitDiffStats(root).size, 0);
  assert.deepEqual(getGitFileList(root), []);
});
