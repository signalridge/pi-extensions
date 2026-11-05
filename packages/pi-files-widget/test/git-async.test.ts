import { spyOn } from "bun:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createFileBrowser } from "../browser.js";
import { POLL_INTERVAL_MS } from "../constants.js";
import { getGitDiffStats, getGitFileList, getGitStatus } from "../git.js";
import * as gitAsync from "../git-async.js";
import { initRepo, skipWithoutGit as skip } from "./git-fixture.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await pause(10);
  assert.equal(check(), true);
}
function snapshot(branch: string, files: string[] = []): gitAsync.GitMetadata {
  return { repo: true, status: new Map(), stats: new Map(), branch, files };
}

// Use real executable fixtures: production spawn must kill AND drain a child,
// not merely stop awaiting a mocked promise. No shell or PATH mutation needed.
function executableFixture(): { root: string; executable: string; gate: string; log: string; dispose(): void } {
  const root = mkdtempSync(join(tmpdir(), "async-git-executable-"));
  const executable = join(root, "git-fixture");
  const gate = join(root, "gate");
  const log = join(root, "calls");
  writeFileSync(
    executable,
    `#!${process.execPath}
import { appendFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, pid: process.pid }) + '\\n');
if (args[0] === 'rev-parse') { process.stdout.write('true\\n\\n'); }
else if (args.includes('status')) {
  while (existsSync(${JSON.stringify(gate)})) await new Promise(r => setTimeout(r, 10));
  if (existsSync(${JSON.stringify(join(root, "overflow"))})) process.stdout.write('x'.repeat(2 * 1024 * 1024));
  else process.stdout.write(' M changed.txt\\0');
}
else if (args[0] === 'ls-files') process.stdout.write('changed.txt\\0');
else if (args[0] === 'branch') process.stdout.write('fixture\\n');
`,
  );
  chmodSync(executable, 0o755);
  return { root, executable, gate, log, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("Node inherited-pipe timeout/cancel/reroot ownership", { timeout: 15000 }, async () => {
  // Bun emits close at direct-child exit, unlike Node. Run the bundled production
  // modules under Node to exercise genuinely inherited, still-open pipes.
  const root = mkdtempSync(join(tmpdir(), "git-pipe-node-"));
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "git-pipe-ownership.fixture.ts")],
      outdir: root,
      naming: "fixture.mjs",
      target: "node",
    });
    assert.equal(build.success, true, String(build.logs));
    const result = childProcess.spawnSync("node", ["--test", join(root, "fixture.mjs")], {
      encoding: "utf8",
      timeout: 12000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const killOutcome of [true, false, "throw"] as const) {
  test(`kill ${killOutcome} or a kill error cannot release an unconfirmed direct child`, async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        if (killOutcome === "throw") throw new Error("kill denied");
        return killOutcome;
      },
    });
    const spawn = spyOn(childProcess, "spawn").mockReturnValue(child as never);
    const controller = new AbortController();
    let settled = false;
    const pending = gitAsync.readGitMetadata("/unused", "/fake/git", controller.signal).finally(() => {
      settled = true;
    });
    const rejected = assert.rejects(pending, /cancelled/);
    try {
      controller.abort();
      child.emit("error", Object.assign(new Error("kill denied"), { code: "EPERM" }));
      await pause(30);
      assert.equal(settled, false);
      assert.equal(child.stdout.destroyed, false);
      assert.equal(child.stderr.destroyed, false);
      child.emit("exit", null, "SIGKILL");
      await pause(30);
      assert.equal(settled, true, "confirmed direct exit releases the cancelled query without a pipe close");
      assert.equal(child.stdout.destroyed, true);
      assert.equal(child.stderr.destroyed, true);
      child.emit("close", null, "SIGKILL");
    } finally {
      child.emit("exit", null, "SIGKILL");
      child.emit("close", null, "SIGKILL");
      await rejected;
      spawn.mockRestore();
    }
  });
}

test("async metadata matches sync semantics for staged deletion, rename, revert, NUL names, and subdirectory symlink", {
  skip,
}, async (t) => {
  const { root, git } = initRepo(t);
  const sub = "sub \nspace";
  mkdirSync(join(root, sub));
  for (const name of ["old\nname", "deleted", "reverted", "ordinary"]) writeFileSync(join(root, sub, name), "one\n");
  writeFileSync(join(root, sub, "deleted"), "unique deletion\n");
  writeFileSync(join(root, "outside"), "one\n");
  writeFileSync(join(root, ".gitignore"), "ignored\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  git("mv", `${sub}/old\nname`, `${sub}/new\tname`);
  git("rm", `${sub}/deleted`);
  writeFileSync(join(root, sub, "reverted"), "one\nstaged\n");
  git("add", ".");
  writeFileSync(join(root, sub, "reverted"), "one\n");
  writeFileSync(join(root, sub, "ordinary"), "one\nworktree\n");
  writeFileSync(join(root, sub, "untracked "), "new");
  writeFileSync(join(root, "outside"), "outside changed\n");
  writeFileSync(join(root, "ignored"), "hidden");
  const alias = join(root, "alias");
  symlinkSync(join(root, sub), alias);
  const executable = await gitAsync.resolveGitExecutable();
  assert.equal(isAbsolute(executable), true);
  for (const cwd of [root, join(root, sub), alias]) {
    const result = await gitAsync.readGitMetadata(cwd, executable, new AbortController().signal);
    assert.equal(result.repo, true);
    assert.deepEqual(result.status, getGitStatus(cwd, { includeIgnored: false }));
    assert.deepEqual(result.stats, getGitDiffStats(cwd));
    assert.deepEqual(result.files.sort(), getGitFileList(cwd).sort());
  }
  const result = await gitAsync.readGitMetadata(join(root, sub), executable, new AbortController().signal);
  assert.equal(result.status.get("deleted"), "D");
  assert.ok(result.files.includes("deleted"));
  assert.equal(result.status.get("new\tname"), "R");
  assert.equal(result.files.includes("old\nname"), false);
});

test("async discovery handles unborn repositories and non-repositories without replacing sync exports", {
  skip,
}, async (t) => {
  const { root, git } = initRepo(t);
  writeFileSync(join(root, "first"), "first\n");
  git("add", ".");
  const executable = await gitAsync.resolveGitExecutable();
  const result = await gitAsync.readGitMetadata(root, executable, new AbortController().signal);
  assert.equal(result.status.get("first"), "A");
  assert.deepEqual(result.stats.get("first"), { additions: 1, deletions: 0 });
  assert.ok(Array.isArray(getGitFileList(root)));
  assert.ok(getGitStatus(root) instanceof Map);
  const fixture = executableFixture();
  try {
    const outside = await gitAsync.readGitMetadata(fixture.root, executable, new AbortController().signal);
    assert.equal(outside.repo, false);
  } finally {
    fixture.dispose();
  }
});

test("async Git is bounded, skips ignored/redundant status queries, and rejects overflow instead of clean results", async () => {
  const fixture = executableFixture();
  const native = childProcess.spawn;
  let active = 0;
  let maximum = 0;
  const spawn = spyOn(childProcess, "spawn").mockImplementation(((...args: Parameters<typeof native>) => {
    const child = native(...args);
    active++;
    maximum = Math.max(maximum, active);
    child.once("close", () => active--);
    return child;
  }) as typeof native);
  try {
    const result = await gitAsync.readGitMetadata(fixture.root, fixture.executable, new AbortController().signal);
    assert.equal(result.status.get("changed.txt"), "M");
    assert.ok(maximum <= 4);
    assert.equal(active, 0);
    const calls = readFileSync(fixture.log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[] });
    assert.equal(calls.filter(({ args }) => args.includes("status")).length, 1);
    assert.ok(calls.every(({ args }) => !args.includes("--ignored")));
    writeFileSync(join(fixture.root, "overflow"), "");
    await assert.rejects(
      gitAsync.readGitMetadata(fixture.root, fixture.executable, new AbortController().signal),
      /limit/,
    );
    assert.equal(active, 0, "all failed siblings drained before rejection");
  } finally {
    spawn.mockRestore();
    fixture.dispose();
  }
});

test("close remains responsive during real deferred Git and drains every child without late rendering", async () => {
  const fixture = executableFixture();
  writeFileSync(fixture.gate, "");
  const executable = spyOn(gitAsync, "resolveGitExecutable").mockResolvedValue(fixture.executable);
  const native = childProcess.spawn;
  let active = 0;
  const spawn = spyOn(childProcess, "spawn").mockImplementation(((...args: Parameters<typeof native>) => {
    const child = native(...args);
    active++;
    child.once("close", () => active--);
    return child;
  }) as typeof native);
  let renders = 0;
  let closes = 0;
  const browser = createFileBrowser(
    fixture.root,
    new Set(),
    theme as never,
    () => closes++,
    () => {},
    () => renders++,
  );
  try {
    await until(() => existsSync(fixture.log) && readFileSync(fixture.log, "utf8").includes("status"));
    assert.match(browser.render(120)[0], /Git loading/);
    browser.handleInput("/");
    browser.handleInput("input stays live");
    assert.match(browser.render(120).join("\n"), /input stays live/);
    browser.handleInput("\x1b");
    browser.handleInput("q");
    assert.equal(closes, 1);
    const before = renders;
    await until(() => active === 0);
    assert.equal(renders, before);
    assert.deepEqual(browser.render(120), []);
  } finally {
    browser.dispose();
    executable.mockRestore();
    spawn.mockRestore();
    fixture.dispose();
  }
});

test("re-root waits for the retired Git request to drain and fences its result; stale failures retain badges", async () => {
  const root = mkdtempSync(join(tmpdir(), "git-generation-"));
  const child = join(root, "child");
  mkdirSync(child);
  writeFileSync(join(root, "changed.txt"), "one");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const executable = spyOn(gitAsync, "resolveGitExecutable").mockResolvedValue("/resolved/git");
  let calls = 0;
  let oldSignal: AbortSignal | undefined;
  let fail = false;
  const metadata = spyOn(gitAsync, "readGitMetadata").mockImplementation(async (cwd, _exe, signal) => {
    calls++;
    if (cwd === child) {
      oldSignal = signal;
      await gate; // Deliberately ignores cancellation until drained.
      return snapshot("obsolete");
    }
    if (fail) throw new Error("overflow or query error");
    const next = snapshot("current", ["changed.txt"]);
    next.status.set("changed.txt", "M");
    return next;
  });
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const browser = createFileBrowser(
    child,
    new Set(),
    theme as never,
    () => {},
    () => {},
    () => {},
  );
  try {
    await until(() => calls === 1);
    browser.handleInput("u");
    assert.equal(oldSignal?.aborted, true);
    await pause(40);
    assert.equal(calls, 1, "new request cannot overlap a retired request");
    assert.doesNotMatch(browser.render(120)[0], /obsolete/);
    release();
    await until(() => calls === 2 && browser.render(120)[0].includes("current"));
    assert.ok(browser.render(120).some((line) => line.includes("changed.txt M")));
    fail = true;
    now += POLL_INTERVAL_MS + 1;
    browser.render(120);
    await until(() => browser.render(120)[0].includes("stale"));
    assert.ok(browser.render(120).some((line) => line.includes("changed.txt M")));
    assert.equal(executable.mock.calls.length, 1);
  } finally {
    release();
    browser.dispose();
    metadata.mockRestore();
    executable.mockRestore();
    clock.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
