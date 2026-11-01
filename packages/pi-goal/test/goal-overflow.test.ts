import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { lastGoalStatus, requireGoalTool, requireLastGoal, startGoalForTest } from "./support/goal-fixture.js";

const OVERFLOW_NOTICE = /context exceeds the model's window/;

function usage(input: number) {
  return { input, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: input + 10 };
}

// A provider that accepts an over-window request and still answers: Pi recognizes it from usage.
const silentOverflow = {
  role: "assistant",
  stopReason: "stop",
  content: [{ type: "text", text: "partial" }],
  usage: usage(250_000),
};

async function overflowedGoal() {
  const branch: Array<Record<string, unknown>> = [];
  const f = await startGoalForTest({
    sessionManager: { getBranch: () => branch, getEntries: () => branch },
    model: { contextWindow: 200_000 },
  });
  branch.push({ type: "message", id: "overflowed", message: silentOverflow });
  branch.push({
    type: "message",
    id: "transient",
    message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 503 temporarily unavailable" },
  });
  await f.mock.events.get("agent_end")?.[0]?.({ messages: [silentOverflow] }, f.ctx);
  return { ...f, branch };
}

test("a silently overflowed goal turn blocks with compaction advice instead of continuing", async () => {
  const f = await overflowedGoal();
  const prompts = f.mock.sentUserMessages.length;

  await f.mock.events.get("agent_settled")?.[0]?.({}, f.ctx);

  assert.equal(f.mock.sentUserMessages.length, prompts);
  assert.equal(lastGoalStatus(f.mock), "blocked");
  assert.deepEqual(
    f.notifications.filter(({ message }) => OVERFLOW_NOTICE.test(message)),
    [
      {
        message:
          "Goal blocked: the context exceeds the model's window. Run /compact, or start a new session, then /goal resume.",
        level: "warning",
      },
    ],
  );
});

test("a compaction after the overflow lets the continuation run", async () => {
  const f = await overflowedGoal();
  const prompts = f.mock.sentUserMessages.length;
  f.branch.push({ type: "compaction", id: "compacted" });

  await f.mock.events.get("agent_settled")?.[0]?.({}, f.ctx);

  assert.equal(f.mock.sentUserMessages.length, prompts + 1);
  assert.match(f.mock.sentUserMessages.at(-1)?.text ?? "", /pi-goal-continuation/);
  assert.equal(lastGoalStatus(f.mock), "active");
  assert.equal(
    f.notifications.some(({ message }) => OVERFLOW_NOTICE.test(message)),
    false,
  );
});

test("a due wait stays paused while overflowed, notices once, and wakes after compaction", async () => {
  vi.useFakeTimers();
  try {
    const branch: Array<Record<string, unknown>> = [];
    const f = await startGoalForTest({
      sessionManager: { getBranch: () => branch, getEntries: () => branch },
      model: { contextWindow: 200_000 },
    });
    await requireGoalTool(f.mock, "goal_wait").execute(
      "wait",
      { goal_id: requireLastGoal(f.mock).id, reason: "review", resume_after_ms: 10_000 },
      undefined,
      undefined,
      f.ctx,
    );
    // A run nobody owns overflowed while the goal waited.
    branch.push({
      type: "message",
      id: "overflowed",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "Your input exceeds the context window of this model",
      },
    });
    branch.push({
      type: "message",
      id: "transient",
      message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 429 rate limit" },
    });
    const prompts = f.mock.sentUserMessages.length;

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(120_000);
    assert.equal(f.mock.sentUserMessages.length, prompts);
    assert.equal(lastGoalStatus(f.mock), "paused");
    assert.deepEqual(
      f.notifications.filter(({ message }) => OVERFLOW_NOTICE.test(message)).map(({ message }) => message),
      [
        "Goal wait is due, but the context exceeds the model's window; the goal stays paused. Run /compact, or start a new session.",
      ],
    );

    branch.push({ type: "compaction", id: "compacted" });
    await f.mock.events.get("session_compact")?.[0]?.({ reason: "manual", willRetry: false }, f.ctx);
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(f.mock.sentUserMessages.length, prompts + 1);
    assert.equal(lastGoalStatus(f.mock), "active");
  } finally {
    vi.useRealTimers();
  }
});
