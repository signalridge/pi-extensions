import { spyOn } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { sanitizeDisplayText } from "@signalridge/pi-ui";
import { createFileBrowser } from "../browser.js";
import { POLL_INTERVAL_MS } from "../constants.js";
import { buildFileTreeFromPaths, flattenTree } from "../file-tree.js";
import { getGitDiffStats, getGitFileList, getGitStatus, parseGitStatusZ } from "../git.js";
import type { CommentPayload } from "../viewer.js";
import { initRepo, skipWithoutGit as skip } from "./git-fixture.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await pause(10);
  assert.equal(check(), true);
}

// No active terminal byte survives this assertion; trusted theme is deliberately plain.
const hostile = "\u001b[2J\u001b]52;c;secret\u0007\u001bPpayload\u001b\\\u0001\u009b2J\u009d52;x\u0090x\u009c\u202e";

test("porcelain -z consumes rename/copy origins in either status column without changing target bytes", () => {
  const path = ' target\\quote"\n雪 -> literal ';
  for (const code of ["R ", " R", "C ", " C", "RM", "MC"]) {
    assert.deepEqual(parseGitStatusZ(`${code} ${path}\0?? misleading-origin\0?? next\0`), [
      { code: code.trim(), path },
      { code: "??", path: "next" },
    ]);
  }
});

test("Git status, inventory, tree and numstat preserve exact special filenames and cwd prefix", {
  skip: skip || process.platform === "win32",
}, (t) => {
  const { root, git } = initRepo(t);
  const sub = "sub space ";
  mkdirSync(join(root, sub));
  const names = [
    " leading and trailing ",
    "literal\\backslash.txt",
    'quote".txt',
    "line\nbreak.txt",
    "tab\t雪.txt",
    "old -> literal ",
    "report.ts",
    "report.ts ",
  ];
  for (const name of names) writeFileSync(join(root, sub, name), "one\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  const cwd = join(root, sub);
  for (const name of names) writeFileSync(join(cwd, name), "one\ntwo\n");
  const configBefore = readFileSync(join(root, ".git", "config"));
  const indexBefore = readFileSync(join(root, ".git", "index"));
  const status = getGitStatus(cwd);
  const files = getGitFileList(cwd);
  const stats = getGitDiffStats(cwd);
  for (const name of names) {
    assert.equal(status.get(name), "M");
    assert.ok(files.includes(name));
    assert.deepEqual(stats.get(name), { additions: 1, deletions: 0 });
  }
  const tree = buildFileTreeFromPaths(cwd, files, status, stats, new Set(), new Set());
  assert.deepEqual(
    flattenTree(tree)
      .map(({ node }) => node.name)
      .sort(),
    [...names].sort(),
  );
  assert.ok(flattenTree(tree).every(({ node }) => node.path === join(cwd, node.name)));
  assert.deepEqual(readFileSync(join(root, ".git", "config")), configBefore, "passive helpers do not configure Git");
  assert.deepEqual(
    readFileSync(join(root, ".git", "index")),
    indexBefore,
    "passive status does not refresh index locks/stat data",
  );
  const target = 'new\\target"\n雪 ';
  git("mv", `${sub}/${names[5]}`, `${sub}/${target}`);
  const renamed = getGitStatus(cwd);
  assert.equal(renamed.get(target), "RM");
  assert.equal(renamed.has(names[5]), false);
  assert.ok(getGitFileList(cwd).includes(target));
});

test("metadata display is inert while opening and commenting keep original filesystem path and source", {
  skip: skip || process.platform === "win32",
}, async (t) => {
  const { root, git } = initRepo(t, `browser-${hostile}-`);
  const name = `file-${hostile}-雪\\tail .txt`;
  writeFileSync(join(root, name), "source unchanged\nsecond");
  git("add", ".");
  git("commit", "-qm", "fixture");
  let payload: CommentPayload | undefined;
  const browser = createFileBrowser(
    root,
    new Set(),
    theme as never,
    () => {},
    (value) => {
      payload = value;
    },
    () => {},
  );
  try {
    await until(() => browser.render(2000).some((line) => line.includes(sanitizeDisplayText(name))));
    const lines = browser.render(2000);
    assert.ok(lines[0].includes(sanitizeDisplayText(root)));
    assert.ok(lines.some((line) => line.includes(sanitizeDisplayText(name))));
    assert.ok(lines.every((line) => !line.includes("\u001b") && !line.includes("\u009b") && !line.includes("\u202e")));
    browser.handleInput("\r");
    browser.handleInput("v");
    const viewer = browser.render(2000);
    assert.ok(viewer[0].includes(sanitizeDisplayText(name)));
    assert.ok(
      viewer.some((line) => line.includes("source unchanged")),
      "opened original path",
    );
    browser.handleInput("c");
    browser.handleInput("comment");
    browser.handleInput("\u0004");
    assert.equal(payload?.relPath, name);
    assert.equal(payload?.selectedText, "source unchanged");
    assert.equal(readFileSync(join(root, name), "utf8"), "source unchanged\nsecond");
  } finally {
    browser.dispose();
  }
});

test("open browser refreshes branch and clean tracked inventory, preserves exact selection and closes removed viewer", {
  skip,
}, async (t) => {
  const { root, git } = initRepo(t);
  writeFileSync(join(root, "a-removed.txt"), "removed");
  writeFileSync(join(root, "z-kept .txt"), "kept");
  git("add", ".");
  git("commit", "-qm", "A");
  git("branch", "-m", "A");
  git("checkout", "-qb", "B");
  rmSync(join(root, "a-removed.txt"));
  writeFileSync(join(root, "b-new-clean.txt"), "new");
  git("add", "-A");
  git("commit", "-qm", "B");
  git("checkout", "-q", "A");
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const browser = createFileBrowser(
    root,
    new Set(),
    theme as never,
    () => {},
    () => {},
    () => {},
  );
  try {
    await until(() => browser.render(200)[0].includes("(A)"));
    browser.handleInput("j"); // keep selection on the same exact trailing-space path
    git("checkout", "-q", "B");
    now += POLL_INTERVAL_MS + 1;
    browser.render(200); // Poll requests metadata without blocking this render.
    await until(() => browser.render(200)[0].includes("(B)"));
    const lines = browser.render(200);
    assert.ok(lines[0].includes("(B)"));
    assert.ok(lines.some((line) => line.includes("b-new-clean.txt")));
    assert.ok(!lines.some((line) => line.includes("a-removed.txt")));
    assert.ok(lines.some((line) => line.includes("2/2")));
    browser.handleInput("k");
    browser.handleInput("\r");
    browser.handleInput("v");
    assert.ok(browser.render(200)[0].includes("b-new-clean.txt"));
    git("checkout", "-q", "A");
    now += POLL_INTERVAL_MS + 1;
    browser.render(200);
    await until(() => browser.render(200)[0].includes("(A)"));
    const back = browser.render(200);
    assert.ok(back[0].includes("(A)"), "removed viewer no longer owns the display");
    assert.ok(back.some((line) => line.includes("a-removed.txt")));
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(), "A");
  } finally {
    browser.dispose();
    clock.mockRestore();
  }
});

test("branch replacement fences a deferred old count and its completion/render timers", { skip }, async (t) => {
  const { root, git } = initRepo(t);
  const path = join(root, "same.txt");
  writeFileSync(path, Array.from({ length: 99 }, () => "old").join("\n"));
  git("add", ".");
  git("commit", "-qm", "A");
  git("branch", "-m", "A");
  git("checkout", "-qb", "B");
  writeFileSync(path, "new\n");
  git("add", ".");
  git("commit", "-qm", "B");
  git("checkout", "-q", "A");
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let entered = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const nativeRead = fsPromises.readFile;
  const deferred = spyOn(fsPromises, "readFile").mockImplementation((async (...args: Parameters<typeof nativeRead>) => {
    const result = await nativeRead(...args);
    if (args[0] === path && !entered) {
      entered = true;
      await gate;
    }
    return result;
  }) as typeof nativeRead);
  let renders = 0;
  const browser = createFileBrowser(
    root,
    new Set(),
    theme as never,
    () => {},
    () => {},
    () => {
      renders++;
    },
  );
  try {
    await until(() => entered);
    git("checkout", "-q", "B");
    now += POLL_INTERVAL_MS + 1;
    browser.render(200);
    await until(() => browser.render(200)[0].includes("(B)"));
    // The replacement root queues counts but cannot start a second count pump
    // while the retired generation is still awaiting readFile.
    assert.ok(!browser.render(200).some((line) => line.includes("99L")));
    const before = renders;
    release();
    await until(() => browser.render(200).some((line) => line.includes("2L")));
    assert.ok(renders > before, "only the replacement batch publishes fresh counts");
    assert.ok(
      !browser.render(200).some((line) => line.includes("99L")),
      "old count never mutates or populates replacement cache",
    );
  } finally {
    release();
    browser.dispose();
    deferred.mockRestore();
    clock.mockRestore();
  }
});
