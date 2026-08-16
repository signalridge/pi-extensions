import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createWorktime, formatDuration } from "../src/core.js";

describe("formatDuration", () => {
  test("uses seconds below one minute", () => {
    assert.equal(formatDuration(0), "0s");
    assert.equal(formatDuration(999), "0s");
    assert.equal(formatDuration(1_000), "1s");
    assert.equal(formatDuration(59_999), "59s");
  });

  test("uses minutes and seconds below one hour", () => {
    assert.equal(formatDuration(60_000), "1m 0s");
    assert.equal(formatDuration(125_000), "2m 5s");
    assert.equal(formatDuration(3_599_999), "59m 59s");
  });

  test("uses hours, minutes, and seconds at one hour and above", () => {
    assert.equal(formatDuration(3_600_000), "1h 0m 0s");
    assert.equal(formatDuration(3_723_000), "1h 2m 3s");
  });

  test("clamps invalid and negative values", () => {
    assert.equal(formatDuration(-1), "0s");
    assert.equal(formatDuration(Number.NaN), "0s");
    assert.equal(formatDuration(Number.POSITIVE_INFINITY), "0s");
    assert.equal(formatDuration(Number.NEGATIVE_INFINITY), "0s");
  });
});

describe("createWorktime", () => {
  test("accumulates active spans and excludes idle time", () => {
    let now = 0;
    const worktime = createWorktime(() => now);

    worktime.start();
    now = 5_000;
    worktime.end();
    now = 20_000;
    worktime.start();
    now = 23_000;
    assert.equal(worktime.elapsed(), 8_000);
    worktime.end();

    assert.equal(worktime.elapsed(), 8_000);
    assert.equal(worktime.running, false);
  });

  test("start and end are idempotent", () => {
    let now = 100;
    const worktime = createWorktime(() => now);

    worktime.start();
    now = 500;
    worktime.start();
    assert.equal(worktime.elapsed(), 400);
    worktime.end();
    now = 900;
    worktime.end();

    assert.equal(worktime.elapsed(), 400);
    assert.equal(worktime.running, false);
  });

  test("reset while running starts a fresh active span", () => {
    let now = 0;
    const worktime = createWorktime(() => now);

    worktime.start();
    now = 8_000;
    worktime.reset();
    assert.equal(worktime.running, true);
    now = 11_000;
    assert.equal(worktime.elapsed(), 3_000);
    worktime.end();
    assert.equal(worktime.elapsed(), 3_000);
  });

  test("reset while idle clears accumulated time", () => {
    let now = 0;
    const worktime = createWorktime(() => now);

    worktime.start();
    now = 4_000;
    worktime.end();
    worktime.reset();

    assert.equal(worktime.running, false);
    assert.equal(worktime.elapsed(), 0);
  });

  test("backward clocks never produce a negative duration", () => {
    let now = 1_000;
    const worktime = createWorktime(() => now);

    worktime.start();
    now = 500;
    assert.equal(worktime.elapsed(), 0);
    worktime.end();

    assert.equal(worktime.elapsed(), 0);
    assert.equal(worktime.running, false);
  });

  test("keeps elapsed nondecreasing across backward then forward corrections", () => {
    const samples = [100, 500, 200, 900, 900];
    const worktime = createWorktime(() => samples.shift() ?? 900);

    worktime.start();
    assert.equal(worktime.elapsed(), 400);
    assert.equal(worktime.elapsed(), 400);
    assert.equal(worktime.elapsed(), 800);
    worktime.end();
    assert.equal(worktime.elapsed(), 800);
  });

  test("NaN and infinite clock samples do not poison public duration", () => {
    let now = 0;
    const worktime = createWorktime(() => now);

    worktime.start();
    now = Number.NaN;
    assert.equal(worktime.elapsed(), 0);
    now = Number.POSITIVE_INFINITY;
    assert.equal(worktime.elapsed(), 0);
    now = 2_000;
    worktime.end();

    assert.equal(Number.isFinite(worktime.elapsed()), true);
    assert.equal(worktime.elapsed(), 2_000);
  });

  test("an invalid starting sample remains safe", () => {
    const samples = [Number.NaN, 100];
    const worktime = createWorktime(() => samples.shift() ?? 100);

    worktime.start();
    assert.equal(worktime.elapsed(), 0);
    worktime.end();

    assert.equal(worktime.elapsed(), 0);
    assert.equal(worktime.running, false);
  });

  test("saturates overflow to a finite nonnegative duration", () => {
    let now = -Number.MAX_VALUE;
    const worktime = createWorktime(() => now);

    worktime.start();
    now = Number.MAX_VALUE;
    worktime.end();

    assert.equal(worktime.elapsed(), Number.MAX_VALUE);
    assert.equal(Number.isFinite(worktime.elapsed()), true);
    assert.equal(worktime.elapsed() >= 0, true);
  });
});
