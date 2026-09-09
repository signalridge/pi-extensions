import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createFileBrowser } from "../browser.js";
import { buildFileTreeFromPaths } from "../file-tree.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

test("observed changes propagate ancestry without claiming agent authorship", () => {
  const root = buildFileTreeFromPaths(
    "/project",
    ["folder/file.ts"],
    new Map(),
    new Map(),
    new Set(),
    new Set(),
    new Set(["/project/folder/file.ts"]),
  );
  const folder = root.children?.[0];
  assert.equal(root.hasChangedChildren, true);
  assert.equal(folder?.hasChangedChildren, true);
  assert.equal(folder?.children?.[0].observedChanged, true);
  assert.equal(folder?.children?.[0].agentModified, false);
});

test("non-Git browser refreshes uncertain changes, filters and navigates, then promotes confirmed writes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "observed-browser-"));
  mkdirSync(join(cwd, "folder"));
  writeFileSync(join(cwd, "ordinary.ts"), "unchanged");
  const agent = new Set<string>();
  const observed = new Set<string>();
  const browser = createFileBrowser(
    cwd,
    agent,
    theme as never,
    () => {},
    () => {},
    () => {},
    cwd,
    observed,
  );
  try {
    // Allow the progressive filesystem scan to settle before a later tool writes.
    await new Promise((resolve) => setTimeout(resolve, 150));
    browser.render(120);
    const path = join(cwd, "folder", "later.ts");
    writeFileSync(path, "possibly cancelled after write");
    observed.add(path);
    observed.add(join(cwd, "..", "outside.ts"));
    // Exercise real poll-driven refresh, including discovering a newly created path.
    await new Promise((resolve) => setTimeout(resolve, 3100));
    browser.render(120);
    browser.handleInput("c");
    browser.handleInput("]");
    const uncertain = browser.render(120).join("\n");
    assert.match(uncertain, /later\.ts.*~/);
    assert.doesNotMatch(uncertain, /ordinary\.ts|outside\.ts|🤖/u);
    browser.handleInput("[");
    assert.match(browser.render(120).join("\n"), /later\.ts/);
    agent.add(path);
    observed.delete(path);
    await new Promise((resolve) => setTimeout(resolve, 3100));
    const promoted = browser.render(120).join("\n");
    assert.match(promoted, /later\.ts.*🤖/u);
    agent.clear();
    observed.clear();
    await new Promise((resolve) => setTimeout(resolve, 3100));
    assert.doesNotMatch(browser.render(120).join("\n"), /later\.ts/);
  } finally {
    browser.handleInput("q");
    rmSync(cwd, { recursive: true, force: true });
  }
}, 15000);

for (const source of ["observed", "agent"] as const) {
  test(`injected ${source} paths do not mark a safe-mode lazy directory scanned`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lazy-observed-"));
    mkdirSync(join(cwd, "folder"));
    writeFileSync(join(cwd, "folder", "ordinary.ts"), "ordinary");
    // Trigger the real safe-mode threshold without crawling these ignored entries.
    for (let i = 0; i < 200; i++) writeFileSync(join(cwd, `.ignored-${i}`), "");
    const agent = new Set<string>();
    const observed = new Set<string>();
    const browser = createFileBrowser(
      cwd,
      agent,
      theme as never,
      () => {},
      () => {},
      () => {},
      cwd,
      observed,
    );
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.match(browser.render(120).join("\n"), /partial/);
      const path = join(cwd, "folder", "later.ts");
      writeFileSync(path, "later");
      (source === "agent" ? agent : observed).add(path);
      now += 3100;
      browser.render(120);
      browser.handleInput("c");
      if (source === "observed") browser.handleInput("]");
      browser.handleInput("c");
      if (source === "agent") browser.handleInput("l");
      await new Promise((resolve) => setTimeout(resolve, 250));
      const lines = browser.render(120).join("\n");
      assert.match(lines, /ordinary\.ts/);
      assert.equal(lines.split("later.ts").length - 1, 1);
      assert.ok(lines.includes(source === "agent" ? "🤖" : " ~"));
    } finally {
      clock.mockRestore();
      browser.handleInput("q");
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("in-flight directory scan merges injected paths and retains nested attribution", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "inflight-observed-"));
  mkdirSync(join(cwd, "folder"));
  writeFileSync(join(cwd, "folder", "ordinary.ts"), "ordinary");
  const observed = new Set<string>();
  let release = () => {};
  let entered = false;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const nativeReaddir = fsPromises.readdir;
  const read = spyOn(fsPromises, "readdir").mockImplementation(async (...args) => {
    const entries = await nativeReaddir(...args);
    if (args[0] === cwd) {
      entered = true;
      await pending;
    }
    return entries;
  });
  const browser = createFileBrowser(
    cwd,
    new Set(),
    theme as never,
    () => {},
    () => {},
    () => {},
    cwd,
    observed,
  );
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(entered, true);
    for (const path of [join(cwd, "new.ts"), join(cwd, "folder", "nested.ts")]) {
      writeFileSync(path, "injected");
      observed.add(path);
    }
    now += 3100;
    browser.render(120);
    release();
    await new Promise((resolve) => setTimeout(resolve, 250));
    browser.handleInput("]");
    const lines = browser.render(120).join("\n");
    assert.match(lines, /ordinary\.ts/);
    for (const name of ["new.ts", "nested.ts"]) {
      assert.equal(lines.split(name).length - 1, 1);
      assert.ok(browser.render(120).some((line) => line.includes(`${name} ~`)));
    }
  } finally {
    release();
    read.mockRestore();
    clock.mockRestore();
    browser.handleInput("q");
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("in-flight symlink file scan retains injected attribution through promotion and clearing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "inflight-symlink-observed-"));
  const path = join(cwd, "linked.ts");
  writeFileSync(join(cwd, "ordinary.ts"), "target content");
  symlinkSync(join(cwd, "ordinary.ts"), path);
  const agent = new Set<string>();
  const observed = new Set<string>();
  let release = () => {};
  let entered = false;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const nativeStat = fsPromises.stat;
  const stat = spyOn(fsPromises, "stat").mockImplementation(async (...args) => {
    const result = await nativeStat(...args);
    if (args[0] === path && !entered) {
      entered = true;
      await pending;
    }
    return result;
  });
  const browser = createFileBrowser(
    cwd,
    agent,
    theme as never,
    () => {},
    () => {},
    () => {},
    cwd,
    observed,
  );
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    for (let attempt = 0; attempt < 100 && !entered; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(entered, true);
    observed.add(path);
    now += 3100;
    assert.match(browser.render(120).join("\n"), /linked\.ts.*~/);
    release();
    await new Promise((resolve) => setTimeout(resolve, 250));
    browser.handleInput("c");
    browser.handleInput("]");
    const uncertain = browser.render(120).join("\n");
    assert.equal(uncertain.split("linked.ts").length - 1, 1);
    assert.match(uncertain, /linked\.ts.*~/);
    assert.doesNotMatch(uncertain, /ordinary\.ts|🤖/u);

    agent.add(path);
    observed.delete(path);
    now += 3100;
    browser.render(120);
    browser.handleInput("[");
    const promoted = browser.render(120).join("\n");
    assert.equal(promoted.split("linked.ts").length - 1, 1);
    assert.match(promoted, /linked\.ts.*🤖/u);
    assert.doesNotMatch(promoted, /linked\.ts.*~/);
    browser.handleInput("\r");
    assert.match(stripVTControlCharacters(browser.render(120).join("\n")), /target content/);
    browser.handleInput("q");

    agent.clear();
    observed.clear();
    now += 3100;
    assert.doesNotMatch(browser.render(120).join("\n"), /linked\.ts/);
    browser.handleInput("]");
    browser.handleInput("[");
    assert.doesNotMatch(browser.render(120).join("\n"), /linked\.ts/);
    browser.handleInput("c");
    const cleared = browser.render(120).join("\n");
    assert.equal(cleared.split("linked.ts").length - 1, 1);
    assert.doesNotMatch(cleared, /linked\.ts.*(?:~|🤖)/u);
  } finally {
    release();
    stat.mockRestore();
    clock.mockRestore();
    browser.handleInput("q");
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const name of ["later.ts ", ...(process.platform === "win32" ? [] : ["back\\slash.ts"])]) {
  test(`observed filesystem path remains exact: ${JSON.stringify(name)}`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "exact-observed-"));
    const observed = new Set<string>();
    const browser = createFileBrowser(
      cwd,
      new Set(),
      theme as never,
      () => {},
      () => {},
      () => {},
      cwd,
      observed,
    );
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      browser.render(120);
      writeFileSync(join(cwd, name), "exact file");
      observed.add(join(cwd, name));
      now += 3100;
      browser.render(120);
      browser.handleInput("c");
      browser.handleInput("]");
      assert.ok(browser.render(120).some((line) => line.includes(`${name} ~`)));
      browser.handleInput("\r");
      assert.ok(stripVTControlCharacters(browser.render(120).join("\n")).includes("exact file"));
      browser.handleInput("q");
    } finally {
      clock.mockRestore();
      browser.handleInput("q");
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
