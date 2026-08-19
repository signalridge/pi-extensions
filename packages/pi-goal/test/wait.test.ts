/**
 * wait.test.ts — `goal_wait`'s delay arithmetic, validation, and timer.
 *
 * The minimum delay is the load-bearing part: without a floor, a model asked to
 * "wait a moment" passes 100ms and the tool becomes the polling loop it exists
 * to replace. The timer's generation counter is the other one — a callback
 * already in flight cannot be un-fired, so it has to recognize that it is stale.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import {
  createGoalWait,
  GoalWaitTimer,
  MAX_GOAL_WAIT_REASON_LENGTH,
  MIN_GOAL_WAIT_DELAY_MS,
  normalizeGoalWait,
  resolveGoalWaitDelay,
} from "../src/wait.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveGoalWaitDelay", () => {
  test("reports nothing when no deadline was requested", () => {
    assert.deepEqual(resolveGoalWaitDelay(undefined), {});
  });

  // Reported separately so a caller can tell the model its number was raised,
  // rather than silently substituting a different one.
  test("reports the requested and the effective delay separately", () => {
    assert.deepEqual(resolveGoalWaitDelay(60_000), {
      requestedMs: 60_000,
      effectiveMs: 60_000,
    });
  });

  test("clamps a delay below the floor rather than refusing it", () => {
    assert.deepEqual(resolveGoalWaitDelay(100), {
      requestedMs: 100,
      effectiveMs: MIN_GOAL_WAIT_DELAY_MS,
    });
  });

  test("leaves a delay exactly at the floor alone", () => {
    assert.equal(resolveGoalWaitDelay(MIN_GOAL_WAIT_DELAY_MS).effectiveMs, MIN_GOAL_WAIT_DELAY_MS);
  });
});

describe("createGoalWait", () => {
  test("records the reason with no deadline when none was asked for", () => {
    assert.deepEqual(createGoalWait("waiting for CI", undefined, 1_000), {
      reason: "waiting for CI",
    });
  });

  test("turns a delay into an absolute wake time", () => {
    assert.deepEqual(createGoalWait("waiting for CI", 60_000, 1_000), {
      reason: "waiting for CI",
      resumeAt: 61_000,
    });
  });

  test("applies the floor to the wake time too", () => {
    assert.equal(createGoalWait("r", 100, 1_000).resumeAt, 1_000 + MIN_GOAL_WAIT_DELAY_MS);
  });
});

// Rejected rather than repaired: a malformed `resumeAt` read back from disk
// would otherwise schedule a wake at an arbitrary moment, and a goal that wakes
// at the wrong time is worse than one that waits for a real message.
describe("normalizeGoalWait", () => {
  test("accepts a wait with no deadline", () => {
    assert.deepEqual(normalizeGoalWait({ reason: "waiting" }), {
      reason: "waiting",
    });
  });

  test("accepts a wait with a valid deadline", () => {
    assert.deepEqual(normalizeGoalWait({ reason: "waiting", resumeAt: 1_000 }), {
      reason: "waiting",
      resumeAt: 1_000,
    });
  });

  test("trims the reason", () => {
    assert.deepEqual(normalizeGoalWait({ reason: "  waiting  " }), {
      reason: "waiting",
    });
  });

  test("rejects a missing or empty reason", () => {
    assert.equal(normalizeGoalWait({}), undefined);
    assert.equal(normalizeGoalWait({ reason: "   " }), undefined);
    assert.equal(normalizeGoalWait({ reason: 42 }), undefined);
  });

  test("rejects an over-long reason", () => {
    assert.equal(
      normalizeGoalWait({
        reason: "x".repeat(MAX_GOAL_WAIT_REASON_LENGTH + 1),
      }),
      undefined,
    );
  });

  test("rejects a non-integer, negative, or absurd deadline", () => {
    assert.equal(normalizeGoalWait({ reason: "r", resumeAt: "soon" }), undefined);
    assert.equal(normalizeGoalWait({ reason: "r", resumeAt: 1.5 }), undefined);
    assert.equal(normalizeGoalWait({ reason: "r", resumeAt: -1 }), undefined);
    assert.equal(normalizeGoalWait({ reason: "r", resumeAt: Number.MAX_SAFE_INTEGER }), undefined);
  });

  test("rejects a non-record", () => {
    assert.equal(normalizeGoalWait(null), undefined);
    assert.equal(normalizeGoalWait("waiting"), undefined);
    assert.equal(normalizeGoalWait([{ reason: "r" }]), undefined);
  });
});

describe("GoalWaitTimer", () => {
  test("fires at the deadline", () => {
    vi.useFakeTimers();
    const timer = new GoalWaitTimer();
    let fired = 0;
    timer.schedule(Date.now() + 60_000, () => fired++);

    vi.advanceTimersByTime(59_999);
    assert.equal(fired, 0);
    vi.advanceTimersByTime(1);
    assert.equal(fired, 1);
  });

  test("fires promptly for a deadline already in the past", () => {
    vi.useFakeTimers();
    const timer = new GoalWaitTimer();
    let fired = 0;
    timer.schedule(Date.now() - 60_000, () => fired++);
    vi.advanceTimersByTime(1);
    assert.equal(fired, 1);
  });

  test("clearing prevents the callback", () => {
    vi.useFakeTimers();
    const timer = new GoalWaitTimer();
    let fired = 0;
    timer.schedule(Date.now() + 1_000, () => fired++);
    timer.clear();
    vi.advanceTimersByTime(10_000);
    assert.equal(fired, 0);
  });

  test("scheduling again replaces the pending wake rather than adding one", () => {
    vi.useFakeTimers();
    const timer = new GoalWaitTimer();
    const fired: string[] = [];
    timer.schedule(Date.now() + 1_000, () => fired.push("first"));
    timer.schedule(Date.now() + 2_000, () => fired.push("second"));
    vi.advanceTimersByTime(10_000);
    assert.deepEqual(fired, ["second"]);
  });

  test("is reusable after clearing", () => {
    vi.useFakeTimers();
    const timer = new GoalWaitTimer();
    let fired = 0;
    timer.schedule(Date.now() + 1_000, () => fired++);
    timer.clear();
    timer.schedule(Date.now() + 1_000, () => fired++);
    vi.advanceTimersByTime(2_000);
    assert.equal(fired, 1);
  });

  test("clearing twice is harmless", () => {
    const timer = new GoalWaitTimer();
    assert.doesNotThrow(() => {
      timer.clear();
      timer.clear();
    });
  });
});
