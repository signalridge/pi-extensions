import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  addWorktree,
  administrativeHistoryOids,
  administrativePruneCandidates,
  durableRefsContaining,
  listWorktrees,
  localBranchExists,
  removeWorktree,
  resolveCommit,
  validateBranch,
  worktreeAdministrativeDirectory,
  worktreeInventory,
} from "../src/git.js";
import { removeWorktreeSafely } from "../src/safe-remove.js";

const pi = {
  async exec(command: string, args: string[], options?: { cwd?: string }): Promise<ExecResult> {
    const result = spawnSync(command, args, {
      cwd: options?.cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
    if (result.error) throw result.error;
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.status ?? 1,
      killed: Boolean(result.signal),
    };
  },
};

test("Git service creates a nested-root worktree, inventories it, and removes it while preserving branch", async () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-git-")));
  const main = join(temporary, "repo");
  const linked = join(temporary, ".worktrees", "repo", "feature-test");
  try {
    git(temporary, ["init", "--initial-branch=main", main]);
    git(main, ["config", "user.name", "Pi Worktree Test"]);
    git(main, ["config", "user.email", "pi-worktree@example.invalid"]);
    writeFileSync(join(main, ".gitignore"), "*.ignored\n");
    writeFileSync(join(main, "README.md"), "main\n");
    git(main, ["add", ".gitignore", "README.md"]);
    git(main, ["commit", "-m", "initial"]);

    assert.equal(await validateBranch(pi, main, "feature/test"), "feature/test");
    assert.equal(await localBranchExists(pi, main, "feature/test"), false);
    const startOid = await resolveCommit(pi, main, "main");
    await addWorktree(pi, main, { path: linked, branch: "feature/test", startOid });
    assert.equal(await localBranchExists(pi, main, "feature/test"), true);
    assert.equal((await listWorktrees(pi, main))[1]?.branch, "feature/test");

    writeFileSync(join(linked, "draft.txt"), "draft\n");
    writeFileSync(join(linked, "cache.ignored"), "cache\n");
    const inventory = await worktreeInventory(pi, linked);
    assert.ok(inventory.some((line) => line.includes("draft.txt")));
    assert.ok(inventory.some((line) => line.includes("cache.ignored")));
    rmSync(join(linked, "draft.txt"));
    rmSync(join(linked, "cache.ignored"));
    assert.deepEqual(await worktreeInventory(pi, linked), []);
    const administrative = await worktreeAdministrativeDirectory(pi, linked);
    for (const historyOid of await administrativeHistoryOids(pi, main, administrative)) {
      assert.ok((await durableRefsContaining(pi, main, historyOid)).length > 0);
    }

    writeFileSync(join(linked, "cache.ignored"), "disposable cache\n");
    const ignoredInventory = await worktreeInventory(pi, linked);
    assert.ok(ignoredInventory.some((line) => line.includes("cache.ignored")));
    assert.ok(ignoredInventory.every((line) => line.startsWith("!! ")));
    await removeWorktree(pi, main, linked);
    assert.equal((await listWorktrees(pi, main)).length, 1);
    assert.equal(await localBranchExists(pi, main, "feature/test"), true);

    await addWorktree(pi, main, { path: linked, branch: "feature/test" });
    assert.equal((await listWorktrees(pi, main))[1]?.branch, "feature/test");
    await removeWorktree(pi, main, linked);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("safe removal keeps data recreated at the original path after Git quarantine move", async () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-safe-remove-git-")));
  const main = join(temporary, "repo");
  const linked = join(temporary, "repo-feature");
  try {
    git(temporary, ["init", "--initial-branch=main", main]);
    git(main, ["config", "user.name", "Pi Worktree Test"]);
    git(main, ["config", "user.email", "pi-worktree@example.invalid"]);
    writeFileSync(join(main, ".gitignore"), "late-cache\n");
    writeFileSync(join(main, "README.md"), "main\n");
    git(main, ["add", ".gitignore", "README.md"]);
    git(main, ["commit", "-m", "initial"]);
    git(main, ["worktree", "add", "-b", "feature", linked, "HEAD"]);

    const calls: string[][] = [];
    const racePi = {
      async exec(command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeout?: number }) {
        const result = await pi.exec(command, args, options);
        calls.push([...args]);
        if (args[0] === "worktree" && args[1] === "move" && result.code === 0) {
          mkdirSync(linked);
          writeFileSync(join(linked, "late-cache"), "must survive\n");
        }
        return result;
      },
    };

    await removeWorktreeSafely(racePi, main, linked, undefined, async () => {});

    const quarantine = calls[0]?.[3];
    assert.ok(quarantine);
    assert.deepEqual(
      calls.filter((args) => args[0] === "worktree"),
      [
        ["worktree", "move", linked, quarantine],
        ["worktree", "list", "--porcelain", "-z"],
        ["worktree", "prune", "--dry-run", "--verbose", "--expire", "now"],
        ["worktree", "list", "--porcelain", "-z"],
      ],
    );
    assert.equal(await localBranchExists(pi, main, "feature"), true);
    assert.equal((await listWorktrees(pi, main)).length, 1);
    assert.equal(existsSync(join(linked, "late-cache")), true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
test("safe removal refuses a worktree restored after candidate scanning", async () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-restored-after-scan-")));
  const main = join(temporary, "repo");
  const linked = join(temporary, "repo-feature");
  try {
    git(temporary, ["init", "--initial-branch=main", main]);
    git(main, ["config", "user.name", "Pi Worktree Test"]);
    git(main, ["config", "user.email", "pi-worktree@example.invalid"]);
    writeFileSync(join(main, "README.md"), "main\n");
    git(main, ["add", "README.md"]);
    git(main, ["commit", "-m", "initial"]);
    git(main, ["worktree", "add", "-b", "feature", linked, "HEAD"]);

    const administrativeRoot = join(main, ".git", "worktrees");
    const administrativeName = readdirSync(administrativeRoot)[0];
    assert.ok(administrativeName);
    const administrativePath = join(administrativeRoot, administrativeName);
    let quarantinePath: string | undefined;
    let dryRunHooked = false;
    const racePi = {
      async exec(command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeout?: number }) {
        const result = await pi.exec(command, args, options);
        if (args[0] === "worktree" && args[1] === "move" && args[2] === linked && args[3]) {
          quarantinePath = args[3];
        }
        if (args[0] === "worktree" && args[1] === "prune" && args[2] === "--dry-run") {
          dryRunHooked = true;
          assert.ok(quarantinePath);
          rmSync(quarantinePath, { recursive: true, force: true });
          mkdirSync(quarantinePath);
          writeFileSync(join(quarantinePath, ".git"), `gitdir: ${administrativePath}\n`);
        }
        return result;
      },
    };

    await assert.rejects(
      removeWorktreeSafely(racePi, main, linked, undefined, async () => {}),
      /quarantine path was recreated|quarantine reservation changed|became valid/i,
    );
    assert.equal(dryRunHooked, true);
    assert.ok(quarantinePath);
    assert.ok(readdirSync(temporary).some((name) => name.endsWith(".pi-worktree-quarantine.pi-worktree-tombstone")));
    assert.ok(readdirSync(temporary).some((name) => name.endsWith(".pi-worktree-reservation")));
    assert.equal(existsSync(administrativePath), true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("safe removal refuses unrelated hidden stale administrative records", async () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-hidden-safe-remove-")));
  const main = join(temporary, "repo");
  const linked = join(temporary, "repo-feature");
  try {
    git(temporary, ["init", "--initial-branch=main", main]);
    git(main, ["config", "user.name", "Pi Worktree Test"]);
    git(main, ["config", "user.email", "pi-worktree@example.invalid"]);
    writeFileSync(join(main, "README.md"), "main\n");
    git(main, ["add", "README.md"]);
    git(main, ["commit", "-m", "initial"]);
    git(main, ["worktree", "add", "-b", "feature", linked, "HEAD"]);

    const adminRoot = join(main, ".git", "worktrees");
    const targetAdminName = readdirSync(adminRoot)[0];
    assert.ok(targetAdminName);
    const targetAdmin = join(adminRoot, targetAdminName);
    const hidden = join(adminRoot, "hidden-stale");
    mkdirSync(hidden);
    for (const name of ["commondir", "index"] as const) {
      copyFileSync(join(targetAdmin, name), join(hidden, name));
    }
    writeFileSync(join(hidden, "HEAD"), `${git(main, ["rev-parse", "HEAD"]).stdout.trim()}\n`);

    await assert.rejects(
      removeWorktreeSafely(pi, main, linked, undefined, async () => {}),
      /stale administrative records/u,
    );
    assert.equal(existsSync(linked), true);
    assert.equal((await listWorktrees(pi, main)).length, 2);
    assert.equal(existsSync(hidden), true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("real Git metadata removal preserves data created inside the tombstone", async () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-safe-remove-tombstone-git-")));
  const main = join(temporary, "repo");
  const linked = join(temporary, "repo-feature");
  try {
    git(temporary, ["init", "--initial-branch=main", main]);
    git(main, ["config", "user.name", "Pi Worktree Test"]);
    git(main, ["config", "user.email", "pi-worktree@example.invalid"]);
    writeFileSync(join(main, ".gitignore"), "late-cache\n");
    writeFileSync(join(main, "README.md"), "main\n");
    git(main, ["add", ".gitignore", "README.md"]);
    git(main, ["commit", "-m", "initial"]);
    git(main, ["worktree", "add", "-b", "feature", linked, "HEAD"]);

    const calls: string[][] = [];
    const racePi = {
      async exec(command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeout?: number }) {
        const result = await pi.exec(command, args, options);
        calls.push([...args]);
        return result;
      },
    };

    await assert.rejects(
      removeWorktreeSafely(
        racePi,
        main,
        linked,
        undefined,
        async () => {},
        async (entryPath) => {
          if (entryPath.endsWith(".pi-worktree-tombstone"))
            writeFileSync(join(entryPath, "late-cache"), "must survive\n");
        },
      ),
      /quarantine was retained/,
    );
    const retainedName = readdirSync(temporary).find((name) => name.endsWith(".pi-worktree-delete"));
    assert.ok(retainedName, "late tombstone data must be retained");
    assert.equal(existsSync(join(temporary, retainedName, "late-cache")), true);
    assert.deepEqual(
      calls.filter((args) => args[0] === "worktree"),
      [
        ["worktree", "move", linked, calls[0]?.[3] ?? ""],
        ["worktree", "list", "--porcelain", "-z"],
        ["worktree", "prune", "--dry-run", "--verbose", "--expire", "now"],
        ["worktree", "list", "--porcelain", "-z"],
      ],
    );
    assert.equal(await localBranchExists(pi, main, "feature"), true);
    assert.equal((await listWorktrees(pi, main)).length, 1);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("worktree inventory reports clean initialized submodules", async () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-submodule-")));
  const main = join(temporary, "repo");
  const linked = join(temporary, "repo-feature");
  const module = join(temporary, "module");
  try {
    git(temporary, ["init", "--initial-branch=main", module]);
    git(module, ["config", "user.name", "Pi Worktree Test"]);
    git(module, ["config", "user.email", "pi-worktree@example.invalid"]);
    writeFileSync(join(module, "module.txt"), "module\n");
    git(module, ["add", "module.txt"]);
    git(module, ["commit", "-m", "module"]);

    git(temporary, ["init", "--initial-branch=main", main]);
    git(main, ["config", "user.name", "Pi Worktree Test"]);
    git(main, ["config", "user.email", "pi-worktree@example.invalid"]);
    writeFileSync(join(main, "README.md"), "main\n");
    git(main, ["add", "README.md"]);
    git(main, ["commit", "-m", "initial"]);
    git(main, ["-c", "protocol.file.allow=always", "submodule", "add", module, "deps/module"]);
    git(main, ["commit", "-am", "add submodule"]);
    git(main, ["worktree", "add", "-b", "feature", linked, "HEAD"]);
    git(linked, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"]);

    const inventory = await worktreeInventory(pi, linked);
    assert.ok(inventory.some((line) => /initialized submodule.*deps\/module/i.test(line)));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("worktree inventory reports assume-unchanged and skip-worktree index flags", async () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-index-flags-")));
  const main = join(temporary, "repo");
  const linked = join(temporary, "repo-feature");
  try {
    git(temporary, ["init", "--initial-branch=main", main]);
    git(main, ["config", "user.name", "Pi Worktree Test"]);
    git(main, ["config", "user.email", "pi-worktree@example.invalid"]);
    writeFileSync(join(main, "assume.txt"), "base\n");
    writeFileSync(join(main, "skip.txt"), "base\n");
    git(main, ["add", "assume.txt", "skip.txt"]);
    git(main, ["commit", "-m", "initial"]);
    git(main, ["worktree", "add", "-b", "feature", linked, "HEAD"]);
    git(linked, ["update-index", "--assume-unchanged", "assume.txt"]);
    git(linked, ["update-index", "--skip-worktree", "skip.txt"]);
    writeFileSync(join(linked, "assume.txt"), "hidden change\n");
    writeFileSync(join(linked, "skip.txt"), "hidden change\n");

    assert.equal(git(linked, ["status", "--porcelain=v1"]).stdout, "");
    const inventory = await worktreeInventory(pi, linked);
    assert.ok(inventory.some((line) => /assume-unchanged.*assume\.txt/i.test(line)));
    assert.ok(inventory.some((line) => /skip-worktree.*skip\.txt/i.test(line)));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("worktree inventory ignores clean sparse-checkout-managed index flags", async () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-sparse-inventory-")));
  const main = join(temporary, "repo");
  const linked = join(temporary, "repo-feature");
  try {
    git(temporary, ["init", "--initial-branch=main", main]);
    git(main, ["config", "user.name", "Pi Worktree Test"]);
    git(main, ["config", "user.email", "pi-worktree@example.invalid"]);
    mkdirSync(join(main, "keep"));
    mkdirSync(join(main, "drop"));
    writeFileSync(join(main, "keep", "a.txt"), "keep\n");
    writeFileSync(join(main, "drop", "b.txt"), "drop\n");
    git(main, ["add", "keep/a.txt", "drop/b.txt"]);
    git(main, ["commit", "-m", "initial"]);
    git(main, ["worktree", "add", "-b", "feature", linked, "HEAD"]);
    git(linked, ["sparse-checkout", "set", "keep"]);

    assert.equal(git(linked, ["status", "--porcelain=v1"]).stdout, "");
    assert.match(git(linked, ["ls-files", "-v"]).stdout, /^S drop\/b\.txt$/m);
    assert.deepEqual(await worktreeInventory(pi, linked), []);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("administrative history exposes a clean attached worktree's reflog-only commit", async () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-history-")));
  const main = join(temporary, "repo");
  const linked = join(temporary, "repo-feature");
  try {
    git(temporary, ["init", "--initial-branch=main", main]);
    git(main, ["config", "user.name", "Pi Worktree Test"]);
    git(main, ["config", "user.email", "pi-worktree@example.invalid"]);
    writeFileSync(join(main, "README.md"), "main\n");
    git(main, ["add", "README.md"]);
    git(main, ["commit", "-m", "initial"]);
    git(main, ["worktree", "add", "-b", "feature", linked, "HEAD"]);
    git(linked, ["checkout", "--detach"]);
    writeFileSync(join(linked, "unique.txt"), "reflog only\n");
    git(linked, ["add", "unique.txt"]);
    git(linked, ["commit", "-m", "unique detached"]);
    const unique = git(linked, ["rev-parse", "HEAD"]).stdout.trim();
    git(linked, ["checkout", "feature"]);
    const tree = git(linked, ["write-tree"]).stdout.trim();
    const perRefOnly = git(linked, ["commit-tree", tree, "-m", "per-ref only"]).stdout.trim();
    const rewrittenOnly = git(linked, ["commit-tree", tree, "-m", "rewritten only"]).stdout.trim();
    git(linked, ["update-ref", "refs/rewritten/recovery", rewrittenOnly]);
    git(linked, ["update-ref", "--create-reflog", "refs/worktree/safety", perRefOnly]);
    const durable = git(linked, ["rev-parse", "feature"]).stdout.trim();
    git(linked, ["update-ref", "refs/worktree/safety", durable]);

    const administrative = await worktreeAdministrativeDirectory(pi, linked);
    const history = await administrativeHistoryOids(pi, main, administrative);
    assert.ok(history.includes(unique));
    assert.ok(history.includes(perRefOnly));
    assert.ok(history.includes(rewrittenOnly));
    assert.deepEqual(await durableRefsContaining(pi, main, unique), []);
    assert.deepEqual(await durableRefsContaining(pi, main, perRefOnly), []);
    assert.deepEqual(await worktreeInventory(pi, linked), []);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("administrative history uses backend-neutral reflogs for reftable worktrees", async () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-reftable-history-")));
  const main = join(temporary, "repo");
  const linked = join(temporary, "repo-feature");
  try {
    try {
      git(temporary, ["init", "--ref-format=reftable", "--initial-branch=main", main]);
    } catch (error) {
      if (/ref-format|unknown option|unsupported/iu.test(String(error))) return;
      throw error;
    }
    git(main, ["config", "user.name", "Pi Worktree Test"]);
    git(main, ["config", "user.email", "pi-worktree@example.invalid"]);
    writeFileSync(join(main, "README.md"), "main\n");
    git(main, ["add", "README.md"]);
    git(main, ["commit", "-m", "initial"]);
    git(main, ["worktree", "add", "-b", "feature", linked, "HEAD"]);
    git(linked, ["checkout", "--detach"]);
    writeFileSync(join(linked, "reftable.txt"), "reftable history\n");
    git(linked, ["add", "reftable.txt"]);
    git(linked, ["commit", "-m", "reftable history"]);
    const unique = git(linked, ["rev-parse", "HEAD"]).stdout.trim();
    git(linked, ["checkout", "feature"]);
    const administrative = await worktreeAdministrativeDirectory(pi, linked);
    const history = await administrativeHistoryOids(pi, main, administrative);
    assert.ok(history.includes(unique));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("administrative history includes commits referenced only by per-worktree FETCH_HEAD", async () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-fetch-head-")));
  const main = join(temporary, "repo");
  const linked = join(temporary, "repo-feature");
  const remote = join(temporary, "remote");
  try {
    git(temporary, ["init", "--initial-branch=main", remote]);
    git(remote, ["config", "user.name", "Pi Worktree Test"]);
    git(remote, ["config", "user.email", "pi-worktree@example.invalid"]);
    writeFileSync(join(remote, "remote.txt"), "fetch only\n");
    git(remote, ["add", "remote.txt"]);
    git(remote, ["commit", "-m", "fetch only"]);
    const fetchedOid = git(remote, ["rev-parse", "HEAD"]).stdout.trim();

    git(temporary, ["init", "--initial-branch=main", main]);
    git(main, ["config", "user.name", "Pi Worktree Test"]);
    git(main, ["config", "user.email", "pi-worktree@example.invalid"]);
    writeFileSync(join(main, "README.md"), "main\n");
    git(main, ["add", "README.md"]);
    git(main, ["commit", "-m", "initial"]);
    git(main, ["worktree", "add", "-b", "feature", linked, "HEAD"]);
    git(linked, ["fetch", remote, fetchedOid]);

    const administrative = await worktreeAdministrativeDirectory(pi, linked);
    const history = await administrativeHistoryOids(pi, main, administrative);
    assert.ok(history.includes(fetchedOid));
    assert.deepEqual(await durableRefsContaining(pi, main, fetchedOid), []);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("administrative prune scanning finds an unreachable detached HEAD omitted from porcelain", async () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-hidden-prune-")));
  const main = join(temporary, "repo");
  const linked = join(temporary, "repo-detached");
  try {
    git(temporary, ["init", "--initial-branch=main", main]);
    git(main, ["config", "user.name", "Pi Worktree Test"]);
    git(main, ["config", "user.email", "pi-worktree@example.invalid"]);
    writeFileSync(join(main, "README.md"), "main\n");
    git(main, ["add", "README.md"]);
    git(main, ["commit", "-m", "initial"]);
    git(main, ["worktree", "add", "--detach", linked, "HEAD"]);
    writeFileSync(join(linked, "hidden.txt"), "unique\n");
    git(linked, ["add", "hidden.txt"]);
    git(linked, ["commit", "-m", "hidden detached"]);
    const hiddenHead = git(linked, ["rev-parse", "HEAD"]).stdout.trim();
    const adminRoot = join(main, ".git", "worktrees");
    const adminName = readdirSync(adminRoot)[0];
    assert.ok(adminName);
    const admin = join(adminRoot, adminName);
    rmSync(join(admin, "gitdir"));
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(admin, old, old);

    assert.equal((await listWorktrees(pi, main)).length, 1);
    const preview = git(main, ["worktree", "prune", "--dry-run", "--verbose"]);
    assert.match(`${preview.stdout}${preview.stderr}`, /Removing/);
    assert.deepEqual(await administrativePruneCandidates(pi, main), [
      {
        id: admin.split("/").at(-1),
        administrativePath: admin,
        head: hiddenHead,
        indexDirty: false,
      },
    ]);
    assert.deepEqual(await durableRefsContaining(pi, main, hiddenHead), []);
    assert.equal(readdirSync(adminRoot).length, 1);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("administrative prune scanning detects staged-only state before metadata removal", async () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-staged-prune-")));
  const main = join(temporary, "repo");
  const linked = join(temporary, "repo-feature");
  try {
    git(temporary, ["init", "--initial-branch=main", main]);
    git(main, ["config", "user.name", "Pi Worktree Test"]);
    git(main, ["config", "user.email", "pi-worktree@example.invalid"]);
    writeFileSync(join(main, "README.md"), "main\n");
    git(main, ["add", "README.md"]);
    git(main, ["commit", "-m", "initial"]);
    git(main, ["worktree", "add", "-b", "feature", linked, "HEAD"]);
    writeFileSync(join(linked, "staged.txt"), "not committed\n");
    git(linked, ["add", "staged.txt"]);
    const adminRoot = join(main, ".git", "worktrees");
    const adminName = readdirSync(adminRoot)[0];
    assert.ok(adminName);
    const admin = join(adminRoot, adminName);
    rmSync(join(linked, ".git"));
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(admin, old, old);

    const preview = git(main, ["worktree", "prune", "--dry-run", "--verbose"]);
    assert.match(`${preview.stdout}${preview.stderr}`, /Removing/);
    assert.deepEqual(await administrativePruneCandidates(pi, main), [
      {
        id: adminName,
        administrativePath: admin,
        branchRef: "refs/heads/feature",
        indexDirty: true,
      },
    ]);
    assert.equal(readdirSync(adminRoot).length, 1);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("durableRefsContaining distinguishes an unreachable detached commit", async () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-detached-")));
  const main = join(temporary, "repo");
  const linked = join(temporary, "repo-detached");
  try {
    git(temporary, ["init", "--initial-branch=main", main]);
    git(main, ["config", "user.name", "Pi Worktree Test"]);
    git(main, ["config", "user.email", "pi-worktree@example.invalid"]);
    writeFileSync(join(main, "README.md"), "main\n");
    git(main, ["add", "README.md"]);
    git(main, ["commit", "-m", "initial"]);
    git(main, ["worktree", "add", "--detach", linked, "HEAD"]);
    writeFileSync(join(linked, "detached.txt"), "unique\n");
    git(linked, ["add", "detached.txt"]);
    git(linked, ["commit", "-m", "detached"]);
    const head = git(linked, ["rev-parse", "HEAD"]).stdout.trim();
    assert.deepEqual(await durableRefsContaining(pi, main, head), []);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result;
}
