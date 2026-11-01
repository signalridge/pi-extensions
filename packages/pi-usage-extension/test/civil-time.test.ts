import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

for (const [zone, phase] of [
  ["Asia/Kolkata", "monday"],
  ["Asia/Kathmandu", "monday"],
  ["UTC", "monday"],
  ["America/New_York", "spring"],
  ["America/New_York", "fall"],
  ["America/Santiago", "midnight"],
  ["America/Santiago", "midnight-today"],
  ["Australia/Lord_Howe", "partial-spring"],
  ["Australia/Lord_Howe", "partial-fall"],
]) {
  test(`${zone}/${phase}: civil-hour table, graph and CSV boundaries agree cold and warm`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "usage-civil-time-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const result = execFileSync(
      "bun",
      [fileURLToPath(new URL("./civil-time.fixture.ts", import.meta.url)), root, phase],
      {
        env: { ...process.env, TZ: zone },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    assert.equal(result, "");
  });
}

for (const [zone, phase] of [
  ["America/New_York", "lengths"],
  ["America/Asuncion", "skipped-midnight"],
]) {
  test(`${zone}/${phase}: This Month starts on the local first`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "usage-civil-month-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const result = execFileSync(
      "bun",
      [fileURLToPath(new URL("./civil-month.fixture.ts", import.meta.url)), root, phase],
      {
        env: { ...process.env, TZ: zone },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    assert.equal(result, "");
  });
}
