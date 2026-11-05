import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBrowser } from "../browser.js";
import { LINE_COUNT_BATCH_SIZE, METADATA_CONCURRENCY } from "../constants.js";

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

for (const phase of ["readdir", "readFile"] as const) {
  test(`one ${phase === "readdir" ? "scan" : "count"} pump across re-root; retired work drains before exactly one reschedule`, async () => {
    const root = mkdtempSync(join(tmpdir(), "serialized-browser-"));
    const child = join(root, "child");
    mkdirSync(child);
    for (let i = 0; i < 16; i++) writeFileSync(join(child, `old-${i}.txt`), "old\n");
    writeFileSync(join(root, "new.txt"), "new\n");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    let newCalls = 0;
    let active = 0;
    let maximum = 0;
    const native = phase === "readdir" ? fsPromises.readdir : fsPromises.readFile;
    const work = spyOn(fsPromises, phase).mockImplementation((async (...args: Parameters<typeof native>) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        const result = await (native as (...input: Parameters<typeof native>) => Promise<unknown>)(...args);
        if (String(args[0]).startsWith(child)) {
          entered++;
          await gate;
        } else if (args[0] === (phase === "readdir" ? root : join(root, "new.txt"))) {
          newCalls++;
        }
        return result;
      } finally {
        active--;
      }
    }) as never);
    const timers = spyOn(globalThis, "setTimeout");
    const browser = createFileBrowser(
      child,
      new Set(),
      theme as never,
      () => {},
      () => {},
      () => {},
    );
    try {
      await until(() => entered === (phase === "readdir" ? 1 : LINE_COUNT_BATCH_SIZE));
      const beforeTimers = () =>
        timers.mock.calls.filter(
          ([callback]) => callback.name === (phase === "readdir" ? "processScanBatch" : "processLineCountBatch"),
        ).length;
      browser.handleInput("u");
      await pause(150);
      assert.equal(newCalls, 0, "new-generation pump cannot run while await outstanding");
      const before = beforeTimers();
      assert.equal(before, 1, "enqueue must not schedule a second pump timer while running");
      release();
      await until(() => newCalls > 0);
      await until(() => !browser.render(160)[0].includes("counts") && !browser.render(160)[0].includes("scanning"));
      assert.ok(browser.render(160).some((line) => line.includes("new.txt")));
      assert.ok(maximum <= (phase === "readdir" ? 1 : LINE_COUNT_BATCH_SIZE));
      assert.equal(newCalls, 1, "one new-root operation, no duplicate reschedule");
    } finally {
      release();
      browser.dispose();
      await until(() => active === 0);
      work.mockRestore();
      timers.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("slow sibling metadata is bounded and deterministic, with symlink cycles and injected rows reconciled", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-siblings-"));
  for (let i = 0; i < 8; i++) {
    const directory = join(root, `row-dir-${i}`);
    mkdirSync(directory);
    writeFileSync(join(directory, `row-file-${i}`), "one\ntwo");
  }
  symlinkSync(root, join(root, "row-cycle"));
  symlinkSync(join(root, "row-dir-0", "row-file-0"), join(root, "row-link"));
  let active = 0;
  let maximum = 0;
  let totalActive = 0;
  let totalMaximum = 0;
  let entered = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const nativeStat = fsPromises.stat;
  const stats = spyOn(fsPromises, "stat").mockImplementation(async (...args) => {
    totalActive++;
    totalMaximum = Math.max(totalMaximum, totalActive);
    try {
      return await nativeStat(...args);
    } finally {
      totalActive--;
    }
  });
  const native = fsPromises.realpath;
  const metadata = spyOn(fsPromises, "realpath").mockImplementation(async (...args) => {
    active++;
    maximum = Math.max(maximum, active);
    totalActive++;
    totalMaximum = Math.max(totalMaximum, totalActive);
    try {
      const result = await native(...args);
      if (String(args[0]).startsWith(join(root, "row-dir-"))) {
        entered = true;
        await gate;
        // Different completion order must not determine visible/queue order.
        await pause((8 - Number(String(args[0]).slice(-1))) * 2);
      }
      return result;
    } finally {
      active--;
      totalActive--;
    }
  });
  const readdir = spyOn(fsPromises, "readdir");
  const observed = new Set<string>();
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const browser = createFileBrowser(
    root,
    new Set(),
    theme as never,
    () => {},
    () => {},
    () => {},
    root,
    observed,
  );
  let slowRows: string[] = [];
  try {
    await until(() => entered && active === METADATA_CONCURRENCY);
    const injected = join(root, "row-dir-0", "row-injected");
    writeFileSync(injected, "injected");
    observed.add(injected);
    // A tool can observe a path through the cycle while metadata is in flight.
    // Retain that exact row without recursively scanning its injected ancestors.
    observed.add(join(root, "row-cycle", "row-dir-0", "row-file-0"));
    now += 3100;
    browser.render(240);
    release();
    browser.handleInput("+");
    browser.handleInput("+");
    browser.handleInput("+");
    browser.handleInput("/");
    browser.handleInput("row-");
    await until(
      () =>
        browser.render(240).some((line) => line.includes("row-file-7")) &&
        !browser.render(240)[0].includes("counts") &&
        !browser.render(240)[0].includes("scanning"),
    );
    slowRows = browser.render(240);
    assert.ok(maximum <= METADATA_CONCURRENCY);
    assert.ok(maximum > 1);
    assert.ok(totalMaximum <= METADATA_CONCURRENCY + LINE_COUNT_BATCH_SIZE, "shared filesystem metadata budget");
    assert.equal(slowRows.filter((line) => line.includes("row-injected")).length, 1);
    assert.ok(slowRows.some((line) => line.includes("row-injected ~")));
    assert.ok(
      !readdir.mock.calls.some(([path]) => String(path).startsWith(join(root, "row-cycle"))),
      "ancestor-realpath cycle is never scanned",
    );
    assert.equal(readdir.mock.calls.length, 9, "root and each ordinary child only");
  } finally {
    browser.dispose();
    release();
    await until(() => active === 0);
    metadata.mockRestore();
    stats.mockRestore();
    readdir.mockRestore();
    clock.mockRestore();
  }
  // Compare a complete cold scan with no delays and the same observed input.
  const fast = createFileBrowser(
    root,
    new Set(),
    theme as never,
    () => {},
    () => {},
    () => {},
    root,
    observed,
  );
  try {
    fast.handleInput("+");
    fast.handleInput("+");
    fast.handleInput("+");
    fast.handleInput("/");
    fast.handleInput("row-");
    await until(
      () =>
        fast.render(240).some((line) => line.includes("row-injected")) &&
        !fast.render(240)[0].includes("counts") &&
        !fast.render(240)[0].includes("scanning"),
    );
    assert.deepEqual(fast.render(240), slowRows);
  } finally {
    fast.dispose();
    // All scans finished above; no in-flight work can consult a removed fixture.
    rmSync(root, { recursive: true, force: true });
  }
});
