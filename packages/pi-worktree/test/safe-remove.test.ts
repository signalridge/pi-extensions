import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { removeWorktreeSafely } from "../src/safe-remove.js";

function result(stdout = "", code = 0, stderr = ""): ExecResult {
  return { stdout, stderr, code, killed: false };
}

function findFileWithContents(root: string, contents: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findFileWithContents(path, contents);
      if (nested) return nested;
      continue;
    }
    try {
      if (readFileSync(path, "utf8") === contents) return path;
    } catch {
      // The race fixture only cares that a retained regular file is discoverable.
    }
  }
  return undefined;
}

function emulateGitWorktreeMove(args: readonly string[]): void {
  const source = args[2];
  const destination = args[3];
  if (!source || !destination) throw new Error(`invalid worktree move: ${args.join(" ")}`);
  renameSync(source, destination);
}

function metadataList(path: string | undefined, pruned: boolean): ExecResult {
  if (!path || pruned) return result();
  return result(`worktree ${path}\0prunable gitdir file points to non-existent location\0\0`);
}

function metadataPreview(): ExecResult {
  return result("Removing worktrees/test: gitdir file points to non-existent location\n");
}

function metadataPreviewMultiple(): ExecResult {
  return result(
    "Removing worktrees/test: gitdir file points to non-existent location\nRemoving worktrees/hidden: missing gitdir\n",
  );
}

test("quarantined removal deletes the observed tree after Git metadata removal", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-safe-remove-"));
  const worktree = join(root, "worktree");
  try {
    mkdirSync(worktree);
    writeFileSync(join(worktree, "tracked.txt"), "tracked\n");
    const calls: string[][] = [];
    let quarantinePath: string | undefined;
    let pruned = false;
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        if (args[1] === "move") {
          quarantinePath = args[3];
          emulateGitWorktreeMove(args);
        }
        if (args[1] === "list") return metadataList(quarantinePath, pruned);
        if (args[1] === "prune") {
          if (args[2] === "--dry-run") return metadataPreview();
          pruned = true;
        }
        return result();
      },
    };

    await removeWorktreeSafely(pi as never, root, worktree, undefined, async () => {});

    const quarantine = calls[0]?.[3];
    assert.ok(quarantine);
    assert.deepEqual(calls, [
      ["worktree", "move", worktree, quarantine],
      ["worktree", "list", "--porcelain", "-z"],
      ["worktree", "prune", "--dry-run", "--verbose", "--expire", "now"],
      ["worktree", "prune", "--expire", "now"],
      ["worktree", "list", "--porcelain", "-z"],
    ]);
    assert.equal(existsSync(worktree), false);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multiple prune preview records fail closed before metadata deletion", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-safe-remove-multiple-preview-"));
  const worktree = join(root, "worktree");
  try {
    mkdirSync(worktree);
    writeFileSync(join(worktree, "tracked.txt"), "tracked\n");
    let quarantinePath: string | undefined;
    let pruned = false;
    const pi = {
      exec: async (_command: string, args: string[]) => {
        if (args[1] === "move") {
          quarantinePath = args[3];
          emulateGitWorktreeMove(args);
        }
        if (args[1] === "list") return metadataList(quarantinePath, pruned);
        if (args[1] === "prune") {
          if (args[2] === "--dry-run") return metadataPreviewMultiple();
          pruned = true;
        }
        return result();
      },
    };

    await assert.rejects(
      removeWorktreeSafely(pi as never, root, worktree, undefined, async () => {}),
      /stale-record preview changed/u,
    );
    assert.equal(pruned, false);
    assert.equal(existsSync(worktree), true);
    assert.deepEqual(readdirSync(root), ["worktree"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("data recreated at the original path after the Git move survives metadata removal", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-safe-remove-original-race-"));
  const worktree = join(root, "worktree");
  try {
    mkdirSync(worktree);
    writeFileSync(join(worktree, "tracked.txt"), "tracked\n");
    const calls: string[][] = [];
    let quarantinePath: string | undefined;
    let pruned = false;
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        if (args[1] === "move") {
          quarantinePath = args[3];
          emulateGitWorktreeMove(args);
          mkdirSync(worktree);
          writeFileSync(join(worktree, "late-cache"), "must survive\n");
        }
        if (args[1] === "list") return metadataList(quarantinePath, pruned);
        if (args[1] === "prune") {
          if (args[2] === "--dry-run") return metadataPreview();
          pruned = true;
        }
        return result();
      },
    };

    await removeWorktreeSafely(pi as never, root, worktree, undefined, async () => {});

    assert.deepEqual(calls, [
      ["worktree", "move", worktree, calls[0]?.[3] ?? ""],
      ["worktree", "list", "--porcelain", "-z"],
      ["worktree", "prune", "--dry-run", "--verbose", "--expire", "now"],
      ["worktree", "prune", "--expire", "now"],
      ["worktree", "list", "--porcelain", "-z"],
    ]);
    assert.equal(existsSync(join(worktree, "late-cache")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("late quarantine data is retained instead of being recursively deleted", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-safe-remove-race-"));
  const worktree = join(root, "worktree");
  try {
    mkdirSync(worktree);
    writeFileSync(join(worktree, "tracked.txt"), "tracked\n");
    const calls: string[][] = [];
    let quarantinePath: string | undefined;
    let pruned = false;
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        if (args[1] === "move") {
          quarantinePath = args[3];
          emulateGitWorktreeMove(args);
          return result();
        }
        if (args[1] === "list") return metadataList(quarantinePath, pruned);
        if (args[1] === "prune") {
          if (args[2] === "--dry-run") return metadataPreview();
          const tombstoneName = readdirSync(root).find((name) => name.endsWith(".pi-worktree-tombstone"));
          if (!tombstoneName) throw new Error("tombstone was not created before metadata prune");
          writeFileSync(join(root, tombstoneName, "late-cache"), "must survive\n");
          pruned = true;
        }
        return result();
      },
    };

    await assert.rejects(
      removeWorktreeSafely(pi as never, root, worktree, undefined, async () => {}),
      /quarantine was retained/,
    );

    assert.equal(existsSync(worktree), false);
    const quarantines = readdirSync(root);
    assert.equal(quarantines.length, 1);
    const quarantine = quarantines[0];
    assert.ok(quarantine);
    assert.deepEqual(calls[0]?.slice(0, 3), ["worktree", "move", worktree]);
    assert.deepEqual(calls[1]?.slice(0, 3), ["worktree", "list", "--porcelain"]);
    assert.deepEqual(calls[2]?.slice(0, 3), ["worktree", "prune", "--dry-run"]);
    assert.deepEqual(calls[3]?.slice(0, 3), ["worktree", "prune", "--expire"]);
    assert.equal(existsSync(join(root, quarantine, "late-cache")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tombstone disappearance reports an unknown outcome instead of success", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-safe-remove-disappeared-"));
  const worktree = join(root, "worktree");
  try {
    mkdirSync(worktree);
    writeFileSync(join(worktree, "tracked.txt"), "tracked\n");
    let quarantinePath: string | undefined;
    let pruned = false;
    const pi = {
      exec: async (_command: string, args: string[]) => {
        if (args[1] === "move") {
          quarantinePath = args[3];
          emulateGitWorktreeMove(args);
        }
        if (args[1] === "list") return metadataList(quarantinePath, pruned);
        if (args[1] === "prune") {
          if (args[2] === "--dry-run") return metadataPreview();
          const tombstoneName = readdirSync(root).find((name) => name.endsWith(".pi-worktree-tombstone"));
          if (!tombstoneName) throw new Error("tombstone was not created before metadata prune");
          renameSync(join(root, tombstoneName), join(root, "moved-away"));
          pruned = true;
        }
        return result();
      },
    };

    await assert.rejects(
      removeWorktreeSafely(pi as never, root, worktree, undefined, async () => {}),
      /outcome is unknown/u,
    );
    assert.equal(existsSync(worktree), false);
    assert.equal(existsSync(join(root, "moved-away", "tracked.txt")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registered quarantine replacement is retained after metadata prune", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-safe-remove-registered-race-"));
  const worktree = join(root, "worktree");
  try {
    mkdirSync(worktree);
    writeFileSync(join(worktree, "tracked.txt"), "tracked\n");
    const calls: string[][] = [];
    let quarantinePath: string | undefined;
    let pruned = false;
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        if (args[1] === "move") {
          quarantinePath = args[3];
          emulateGitWorktreeMove(args);
        }
        if (args[1] === "list") return metadataList(quarantinePath, pruned);
        if (args[1] === "prune") {
          if (args[2] === "--dry-run") return metadataPreview();
          if (!quarantinePath) throw new Error("quarantine path was not allocated");
          rmSync(quarantinePath, { force: true });
          mkdirSync(quarantinePath);
          writeFileSync(join(quarantinePath, "late-cache"), "must survive\n");
          pruned = true;
        }
        return result();
      },
    };

    await assert.rejects(
      removeWorktreeSafely(pi as never, root, worktree, undefined, async () => {}),
      /quarantine was retained/,
    );
    assert.ok(quarantinePath);
    assert.ok(findFileWithContents(root, "must survive\n"), "the replacement must remain retained");
    assert.equal(existsSync(`${quarantinePath}.pi-worktree-tombstone`), true);
    assert.deepEqual(
      calls.slice(0, 3).map((args) => args.slice(0, 2)),
      [
        ["worktree", "move"],
        ["worktree", "list"],
        ["worktree", "prune"],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quarantine validation rejects data that appeared after the final inventory", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-safe-remove-validator-"));
  const worktree = join(root, "worktree");
  try {
    mkdirSync(worktree);
    writeFileSync(join(worktree, "tracked.txt"), "tracked\\n");
    const calls: string[][] = [];
    const pi = {
      exec: async (_command: string, args: string[]) => {
        calls.push(args);
        if (args[1] === "move") emulateGitWorktreeMove(args);
        return result();
      },
    };
    await assert.rejects(
      removeWorktreeSafely(pi as never, root, worktree, undefined, async (quarantinePath) => {
        writeFileSync(join(quarantinePath, "late-cache"), "must survive\\n");
        throw new Error("ignored local data appeared after quarantine");
      }),
      /ignored local data appeared/,
    );
    assert.deepEqual(calls, [
      ["worktree", "move", worktree, calls[0]?.[3] ?? ""],
      ["worktree", "move", calls[0]?.[3] ?? "", worktree],
    ]);
    assert.equal(existsSync(worktree), true);
    assert.equal(existsSync(join(worktree, "late-cache")), true);
    assert.deepEqual(readdirSync(root), ["worktree"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains a file replaced after identity validation instead of deleting the replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-safe-remove-entry-race-"));
  const worktree = join(root, "worktree");
  try {
    mkdirSync(worktree);
    writeFileSync(join(worktree, "tracked.txt"), "tracked\n");
    let quarantinePath: string | undefined;
    let pruned = false;
    const pi = {
      exec: async (_command: string, args: string[]) => {
        if (args[1] === "move") {
          quarantinePath = args[3];
          emulateGitWorktreeMove(args);
        }
        if (args[1] === "list") return metadataList(quarantinePath, pruned);
        if (args[1] === "prune") {
          if (args[2] === "--dry-run") return metadataPreview();
          pruned = true;
        }
        // Leave the quarantined tree in place so the exact-entry deletion path runs.
        return result();
      },
    };

    await assert.rejects(
      removeWorktreeSafely(
        pi as never,
        root,
        worktree,
        undefined,
        async () => {},
        async (entryPath) => {
          if (entryPath.endsWith("tracked.txt")) {
            writeFileSync(entryPath, "replacement\n");
          }
        },
      ),
      /quarantine was retained/,
    );

    const retained = findFileWithContents(root, "replacement\n");
    assert.ok(retained, "the replacement must remain in the quarantine");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
