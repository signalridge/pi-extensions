import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { GoalRuntime, STATUS_KEY } from "../src/runtime.js";
import { createMockContext, createMockPi } from "./support.js";

afterEach(() => vi.useRealTimers());

function fixture() {
  const mock = createMockPi();
  const runtime = new GoalRuntime(mock.pi);
  const context = createMockContext();
  return { runtime, ...context };
}

test("the passive completion banner does not retain the Node event loop", () => {
  const { runtime, ctx, statuses } = fixture();
  try {
    runtime.showCompletionStatus(ctx);
    assert.equal(statuses.get(STATUS_KEY), "complete");
    assert.equal(runtime.completionStatusTimer?.hasRef(), false);
  } finally {
    runtime.clearCompletionStatusTimer();
  }
});

test("completion banner expiry and replacement keep the original eight-second lifetime", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { runtime, ctx, statuses } = fixture();
  runtime.showCompletionStatus(ctx);
  const first = runtime.completionStatusTimer;
  await vi.advanceTimersByTimeAsync(4_000);
  runtime.showCompletionStatus(ctx);
  assert.notEqual(runtime.completionStatusTimer, first);
  assert.equal(vi.getTimerCount(), 1);
  await vi.advanceTimersByTimeAsync(7_999);
  assert.equal(statuses.get(STATUS_KEY), "complete");
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(statuses.get(STATUS_KEY), undefined);
  assert.equal(runtime.completionStatusTimer, undefined);
  assert.equal(vi.getTimerCount(), 0);
});

test("retiring a completion timer prevents later status writes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { runtime, ctx, statuses } = fixture();
  runtime.showCompletionStatus(ctx);
  runtime.clearCompletionStatusTimer();
  assert.equal(runtime.completionStatusTimer, undefined);
  assert.equal(vi.getTimerCount(), 0);
  await vi.advanceTimersByTimeAsync(8_000);
  assert.equal(statuses.get(STATUS_KEY), "complete");
});
