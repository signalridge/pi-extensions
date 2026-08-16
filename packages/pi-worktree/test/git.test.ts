import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";
import {
  buildAddArguments,
  currentWorktreePath,
  defaultWorktreePath,
  durableRefsContaining,
  formatWorktree,
  moveWorktree,
  parseWorktreePorcelain,
  prunePreview,
  sameWorktreeIdentity,
  stripTerminalControls,
  withWorktreeMutationLock,
  worktreeForBranch,
} from "../src/git.js";

const oid = "0123456789abcdef0123456789abcdef01234567";
const BIDI_CODE_POINTS = [
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
];

test("parseWorktreePorcelain parses NUL records without substring branch matching", () => {
  const output = [
    "worktree /repo with spaces",
    `HEAD ${oid}`,
    "branch refs/heads/main",
    "",
    "worktree /repo-feature",
    `HEAD ${oid.replace(/^0/, "1")}`,
    "branch refs/heads/feat/login",
    "locked in use by CI",
    "prunable gitdir file points to non-existent location",
    "",
    "worktree /repo-detached",
    `HEAD ${oid.replace(/^0/, "2")}`,
    "detached",
    "",
  ].join("\0");

  const records = parseWorktreePorcelain(output);
  assert.equal(records.length, 3);
  assert.deepEqual(records[0], {
    path: "/repo with spaces",
    head: oid,
    branchRef: "refs/heads/main",
    branch: "main",
    isMain: true,
    bare: false,
    detached: false,
  });
  assert.equal(records[1]?.lockedReason, "in use by CI");
  assert.equal(records[1]?.prunableReason, "gitdir file points to non-existent location");
  assert.equal(records[2]?.detached, true);
  assert.equal(worktreeForBranch(records, "feat/login")?.path, "/repo-feature");
  assert.equal(worktreeForBranch(records, "feat/log"), undefined);
});

test("parseWorktreePorcelain handles a bare main record and empty lock reasons", () => {
  const records = parseWorktreePorcelain(
    ["worktree /srv/repo.git", "bare", "", "worktree /repo", `HEAD ${oid}`, "detached", "locked", ""].join("\0"),
  );
  assert.equal(records[0]?.bare, true);
  assert.equal(records[0]?.isMain, true);
  assert.equal(records[1]?.lockedReason, "");
});

test("parseWorktreePorcelain rejects malformed fields before a worktree record", () => {
  assert.throws(() => parseWorktreePorcelain(`HEAD ${oid}\0`), /before worktree/i);
  assert.throws(() => parseWorktreePorcelain("worktree\0"), /missing path/i);
});

test("defaultWorktreePath derives a root/project/branch path and normalizes branch slashes", () => {
  assert.equal(
    defaultWorktreePath("/home/me/project", "feat/login", "/home/me/.worktrees"),
    join("/home/me", ".worktrees", "project", "feat-login"),
  );
  assert.equal(
    defaultWorktreePath("/home/me/project", "feat-login", "/home/me/.worktrees"),
    join("/home/me", ".worktrees", "project", "feat-login"),
  );
});

test("buildAddArguments emits only safe attach or create argv", () => {
  assert.deepEqual(buildAddArguments({ path: "/tmp/repo-feature", branch: "feature" }), [
    "worktree",
    "add",
    "/tmp/repo-feature",
    "feature",
  ]);
  assert.deepEqual(
    buildAddArguments({
      path: "/tmp/repo-feature",
      branch: "feature",
      startOid: oid,
    }),
    ["worktree", "add", "-b", "feature", "/tmp/repo-feature", oid],
  );
});

test("moveWorktree emits worktree-aware source and destination argv", async () => {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  await moveWorktree(
    {
      exec: async (command, args, options) => {
        calls.push({ command, args, cwd: options?.cwd });
        return { stdout: "", stderr: "", code: 0, killed: false };
      },
    },
    "/repo",
    "/repo-feature",
    "/repo-feature-quarantine",
  );
  assert.deepEqual(calls, [
    {
      command: "git",
      args: ["worktree", "move", "/repo-feature", "/repo-feature-quarantine"],
      cwd: "/repo",
    },
  ]);
});

test("formatWorktree strips terminal controls from Git-owned display values", () => {
  const rendered = formatWorktree({
    path: "/repo\u001b]8;;bad\u0007",
    head: oid,
    branch: "feature\nspoof\u009b2J",
    branchRef: "refs/heads/feature\nspoof\u009b2J",
    isMain: false,
    bare: false,
    detached: false,
    lockedReason: "reason\u001b[2J",
  });
  assert.equal(
    [...rendered].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    }),
    false,
  );
  // A newline becomes a space rather than vanishing, so two Git lines never weld together.
  assert.match(rendered, /feature spoof2J/);
});

test("formatWorktree drops bidi overrides that reorder the worktree the user acts on", () => {
  const rlo = String.fromCodePoint(0x202e);
  for (const codePoint of BIDI_CODE_POINTS) {
    assert.equal(
      stripTerminalControls(`/repo/${String.fromCodePoint(codePoint)}feature`),
      "/repo/feature",
      codePoint.toString(16),
    );
  }
  const rendered = formatWorktree({
    path: `/repo/${rlo}gnp.exe`,
    head: oid,
    branch: `feature/${rlo}txt.hs`,
    branchRef: `refs/heads/feature/${rlo}txt.hs`,
    isMain: false,
    bare: false,
    detached: false,
    lockedReason: `held${rlo}`,
  });
  assert.equal(
    [...rendered].some((character) => BIDI_CODE_POINTS.includes(character.codePointAt(0) ?? 0)),
    false,
  );
  assert.match(rendered, /\/repo\/gnp\.exe/);
  assert.match(rendered, /feature\/txt\.hs/);
  const book = String.fromCodePoint(0x1f4d6);
  assert.equal(stripTerminalControls(`${book}${rlo}${book}`), `${book}${book}`);
});

test("published git source loads with Node strip-only TypeScript", () => {
  const moduleUrl = pathToFileURL(fileURLToPath(new URL("../src/git.ts", import.meta.url))).href;
  const loaded = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", `await import(${JSON.stringify(moduleUrl)})`],
    { encoding: "utf8" },
  );
  assert.equal(loaded.status, 0, loaded.stderr);
});

test("sameWorktreeIdentity binds path, HEAD, branch ref, detached, main, and bare state", () => {
  const record = {
    path: "/repo-feature",
    head: oid,
    branch: "feature",
    branchRef: "refs/heads/feature",
    isMain: false,
    bare: false,
    detached: false,
  };
  assert.equal(sameWorktreeIdentity(record, { ...record }), true);
  for (const changed of [
    { path: "/other" },
    { head: oid.replace(/^0/, "1") },
    { branchRef: "refs/heads/other" },
    { detached: true },
    { isMain: true },
    { bare: true },
  ]) {
    assert.equal(sameWorktreeIdentity(record, { ...record, ...changed }), false);
  }
});

test("currentWorktreePath preserves valid trailing spaces while removing Git's line ending", async () => {
  const path = await currentWorktreePath(
    {
      exec: async () => ({
        stdout: "/repo trailing  \n",
        stderr: "",
        code: 0,
        killed: false,
      }),
    },
    "/repo trailing  ",
  );
  assert.equal(path, "/repo trailing  ");
});

test("durable ref checks reject malformed porcelain OIDs without invoking Git", async () => {
  let calls = 0;
  await assert.rejects(
    durableRefsContaining(
      {
        exec: async () => {
          calls += 1;
          return { stdout: "", stderr: "", code: 0, killed: false };
        },
      },
      "/repo",
      "--format=%(objectname)",
    ),
    /invalid HEAD object/i,
  );
  assert.equal(calls, 0);
});

test("prune preview includes Git stderr because verbose prune may write there", async () => {
  const preview = await prunePreview(
    {
      exec: async () => ({
        stdout: "stdout line\n",
        stderr: "stderr line\n",
        code: 0,
        killed: false,
      }),
    },
    "/repo",
  );
  assert.equal(preview, "stdout line\nstderr line");
});

test("mutation locks use the shared common directory for separate-git-dir worktrees", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-lock-key-"));
  const main = join(root, "main");
  const linked = join(root, "linked");
  const common = join(root, "separate.git");
  const linkedAdmin = join(common, "worktrees", "linked");
  mkdirSync(main);
  mkdirSync(linked);
  mkdirSync(linkedAdmin, { recursive: true });
  writeFileSync(join(main, ".git"), `gitdir: ${common}\n`);
  writeFileSync(join(linked, ".git"), `gitdir: ${linkedAdmin}\n`);
  writeFileSync(join(linkedAdmin, "commondir"), "../..\n");
  let release!: () => void;
  let resolveEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    resolveEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let secondEntered = false;
  const first = withWorktreeMutationLock(main, async () => {
    resolveEntered();
    await gate;
  });
  try {
    await entered;
    const second = withWorktreeMutationLock(linked, async () => {
      secondEntered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(secondEntered, false);
    release();
    await first;
    await second;
    assert.equal(secondEntered, true);
  } finally {
    release();
    await first;
    rmSync(root, { recursive: true, force: true });
  }
});

test("stripTerminalControls substitutes a space for every line separator", () => {
  // Multi-line Git output reaches DESTRUCTIVE confirmation bodies. Dropping the separators glued
  // "Removing worktrees/a: reason" onto "Removing worktrees/b: reason", changing what the user
  // reads before approving an irreversible prune or removal.
  for (const codePoint of [0x09, 0x0a, 0x0d, 0x85, 0x2028, 0x2029]) {
    assert.equal(stripTerminalControls(`a${String.fromCodePoint(codePoint)}b`), "a b", codePoint.toString(16));
  }
  const prunePreview = [
    "Removing worktrees/feature-a: gitdir file points to non-existent location",
    "Removing worktrees/feature-b: gitdir file points to non-existent location",
  ].join("\n");
  assert.equal(
    stripTerminalControls(prunePreview),
    "Removing worktrees/feature-a: gitdir file points to non-existent location Removing worktrees/feature-b: gitdir file points to non-existent location",
  );
  const inventory = ["!! src/secret.env", "!! dist/build.log"].join("\n");
  assert.equal(stripTerminalControls(inventory), "!! src/secret.env !! dist/build.log");
});
