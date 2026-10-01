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
  MAX_GOAL_WAIT_DELAY_MS,
  MAX_GOAL_WAIT_REASON_LENGTH,
  MIN_GOAL_WAIT_DELAY_MS,
  normalizeGoalWait,
  resolveGoalWaitDelay,
} from "../src/wait.js";
import {
  requireGoalTool,
  requireLastGoal,
  restoreStoredGoalForTest,
  startGoalForTest,
  UNLIMITED_SETTINGS_PATH,
} from "./support/goal-fixture.js";

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

  test("deadlines beyond the timer range do not wake early", () => {
    vi.useFakeTimers();
    const timer = new GoalWaitTimer();
    let fired = 0;
    timer.schedule(Date.now() + MAX_GOAL_WAIT_DELAY_MS + 60_000, () => fired++);
    vi.advanceTimersByTime(MAX_GOAL_WAIT_DELAY_MS);
    assert.equal(fired, 0);
    vi.advanceTimersByTime(60_000);
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

async function waitingGoal(resumeAfterMs?: number, overrides: Record<string, unknown> = {}) {
  vi.useFakeTimers();
  const fixture = await startGoalForTest(overrides, "finish after review", UNLIMITED_SETTINGS_PATH);
  const goal = requireLastGoal(fixture.mock);
  const result = await requireGoalTool(fixture.mock, "goal_wait").execute(
    "wait-call",
    { goal_id: goal.id, reason: "review result", resume_after_ms: resumeAfterMs },
    undefined,
    undefined,
    fixture.ctx,
  );
  assert.equal(result.terminate, true);
  fixture.mock.sentUserMessages.length = 0;
  return fixture;
}

function restoreWait(fixture: Awaited<ReturnType<typeof waitingGoal>>, overrides: Record<string, unknown> = {}) {
  // Cross the JSON boundary: a fresh factory must not depend on the old timer or object.
  const saved = JSON.parse(JSON.stringify(requireLastGoal(fixture.mock)));
  fixture.mock.events.get("session_shutdown")?.[0]?.({}, fixture.ctx);
  assert.equal(vi.getTimerCount(), 0, "shutdown must cancel the old runtime's timer");
  return restoreStoredGoalForTest(saved, [], "always", overrides, UNLIMITED_SETTINGS_PATH);
}

describe("goal_wait lifecycle", () => {
  test("persists reason/deadline and re-arms a future wait in a fresh factory", async () => {
    const original = await waitingGoal(60_000);
    const saved = requireLastGoal(original.mock);
    assert.deepEqual(saved.wait, { reason: "review result", resumeAt: Date.now() + 60_000 });
    assert.match(original.statuses.get("goal") ?? "", /waiting.*Unlimited/);
    vi.advanceTimersByTime(20_000);
    const restored = restoreWait(original);
    await vi.advanceTimersByTimeAsync(39_999);
    assert.equal(restored.mock.sentUserMessages.length, 0);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(restored.mock.sentUserMessages.length, 1);
    const resumed = requireLastGoal(restored.mock);
    assert.equal(resumed.status, "active");
    assert.equal(resumed.wait, undefined);
    assert.notEqual(resumed.id, saved.id);
    assert.equal(resumed.text, saved.text);
    assert.equal(resumed.tokensUsed, saved.tokensUsed);
    assert.equal(resumed.timeUsedSeconds, saved.timeUsedSeconds);
    assert.match(restored.statuses.get("goal") ?? "", /Unlimited/);
    assert.equal(original.mock.sentUserMessages.length, 0);
    await restored.mock.events.get("agent_settled")?.[0]?.({}, restored.ctx);
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(restored.mock.sentUserMessages.length, 1);
  });

  test("consumes an overdue restored deadline once, after restore returns", async () => {
    const original = await waitingGoal(10_000);
    original.mock.events.get("session_shutdown")?.[0]?.({}, original.ctx);
    vi.advanceTimersByTime(60_000);
    const restored = restoreWait(original);
    assert.equal(requireLastGoal(restored.mock).status, "paused");
    assert.equal(restored.mock.sentUserMessages.length, 0);
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(requireLastGoal(restored.mock).status, "active");
    assert.equal(restored.mock.sentUserMessages.length, 1);
  });

  test("an elapsed deadline waits for settlement and pending messages", async () => {
    let idle = true;
    let pending = false;
    const fixture = await waitingGoal(10_000, { isIdle: () => idle, hasPendingMessages: () => pending });
    idle = false;
    await vi.advanceTimersByTimeAsync(10_000);
    assert.equal(fixture.mock.sentUserMessages.length, 0);
    idle = true;
    pending = true;
    await fixture.mock.events.get("agent_settled")?.[0]?.({}, fixture.ctx);
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(fixture.mock.sentUserMessages.length, 0);
    pending = false;
    await fixture.mock.events.get("agent_settled")?.[0]?.({}, fixture.ctx);
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(fixture.mock.sentUserMessages.length, 1);
  });

  for (const source of ["interactive", "rpc"]) {
    test(`${source} input wakes a restored wait without sending a second prompt`, async () => {
      const original = await waitingGoal(60_000);
      const fixture = restoreWait(original);
      await fixture.mock.events.get("input")?.[0]?.({ source, text: "Review passed" }, fixture.ctx);
      const result = (await fixture.mock.events.get("before_agent_start")?.[0]?.(
        { prompt: "Review passed", systemPrompt: "base" },
        fixture.ctx,
      )) as { systemPrompt?: string };
      assert.equal(requireLastGoal(fixture.mock).status, "active");
      assert.equal(requireLastGoal(fixture.mock).wait, undefined);
      assert.match(result.systemPrompt ?? "", /finish after review/);
      await vi.advanceTimersByTimeAsync(60_000);
      assert.equal(fixture.mock.sentUserMessages.length, 0);
    });
  }

  test("a queued real follow-up wakes only when delivered; extension input does not wake", async () => {
    const fixture = await waitingGoal();
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "extension", text: "housekeeping", streamingBehavior: "followUp" },
      fixture.ctx,
    );
    await fixture.mock.events.get("message_start")?.[0]?.(
      { message: { role: "user", content: "housekeeping" } },
      fixture.ctx,
    );
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "rpc", text: "Review passed", streamingBehavior: "followUp" },
      fixture.ctx,
    );
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
    await fixture.mock.events.get("message_start")?.[0]?.(
      { message: { role: "user", content: "Review passed" } },
      fixture.ctx,
    );
    assert.equal(requireLastGoal(fixture.mock).status, "active");
    assert.equal(fixture.mock.sentUserMessages.length, 0);
  });

  test("queued follow-up receives the rotated binding through context without another before_agent_start", async () => {
    vi.useFakeTimers();
    const fixture = await startGoalForTest({}, "queued wake probe", UNLIMITED_SETTINGS_PATH);
    const { mock, ctx } = fixture;
    const initialId = requireLastGoal(mock).id;
    const initialPrompt = mock.sentUserMessages[0].text;
    const initial = (await mock.events.get("before_agent_start")?.[0]?.(
      { prompt: initialPrompt, systemPrompt: "base" },
      ctx,
    )) as { systemPrompt: string };
    await mock.events.get("input")?.[0]?.({ source: "interactive", text: "ready", streamingBehavior: "followUp" }, ctx);
    await requireGoalTool(mock, "goal_wait").execute(
      "wait",
      { goal_id: initialId, reason: "queued result", resume_after_ms: 30_000 },
      undefined,
      undefined,
      ctx,
    );
    // Agent-core drains the queued message inside the same run: no fresh
    // before_agent_start, only message_start followed by provider context.
    await mock.events.get("message_start")?.[0]?.(
      { message: { role: "user", content: [{ type: "text", text: "ready" }] } },
      ctx,
    );
    const resumedId = requireLastGoal(mock).id;
    assert.notEqual(resumedId, initialId);
    const messages = [{ role: "user", content: "ready", timestamp: Date.now() }];
    for (let response = 0; response < 2; response++) {
      const result = (await mock.events.get("context")?.[0]?.({ messages }, ctx)) as {
        messages: Array<{ role: string; content: string; customType?: string }>;
      };
      assert.ok(result?.messages, "queued wake must supply the rotated binding before the next provider response");
      const binding = result.messages.at(-1);
      assert.equal(binding?.customType, "goal-input-wake");
      assert.ok(binding?.content.includes(`<goal_id>\n${resumedId}\n</goal_id>`));
      assert.ok(!binding?.content.includes(initialId));
    }
    assert.match(initial.systemPrompt, /later Goal runtime binding update/);
    assert.equal(messages.length, 1, "context update must not mutate the original message list");
    const complete = requireGoalTool(mock, "goal_complete");
    const stale = await complete.execute(
      "stale",
      { goal_id: initialId, summary: "Verified" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(stale.content?.[0]?.text ?? "", /goal_id does not match/);
    await complete.execute(
      "current",
      { goal_id: resumedId, summary: "Queued probe verified" },
      undefined,
      undefined,
      ctx,
    );
    await mock.events.get("agent_end")?.[0]?.({ messages: [] }, ctx);
    await mock.events.get("agent_settled")?.[0]?.({}, ctx);
    await vi.advanceTimersByTimeAsync(30_000);
    assert.equal(mock.sentUserMessages.length, 1, "only kickoff; no resume or automatic continuation prompt");
    assert.equal(await mock.events.get("context")?.[0]?.({ messages }, ctx), undefined);
  });

  test("input-only waits survive restore without a timer", async () => {
    const fixture = restoreWait(await waitingGoal());
    await vi.advanceTimersByTimeAsync(86_400_000);
    assert.deepEqual(requireLastGoal(fixture.mock).wait, { reason: "review result" });
    assert.equal(fixture.mock.sentUserMessages.length, 0);
    await fixture.mock.events.get("input")?.[0]?.({ source: "interactive", text: "Ready" }, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "active");
  });

  test("explicit pause cancels a wait durably and real input cannot resume the hold", async () => {
    const original = await waitingGoal(10_000);
    await original.mock.commands.get("goal")?.handler("pause", original.ctx);
    assert.equal(requireLastGoal(original.mock).wait, undefined);
    const fixture = restoreWait(original);
    await vi.advanceTimersByTimeAsync(60_000);
    await fixture.mock.events.get("input")?.[0]?.({ source: "rpc", text: "Ready" }, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
    assert.equal(fixture.mock.sentUserMessages.length, 0);
  });

  for (const command of ["clear", "edit revised objective", "replacement objective"]) {
    test(`${command} cancels the old deadline`, async () => {
      const fixture = await waitingGoal(10_000);
      await fixture.mock.commands.get("goal")?.handler(command, fixture.ctx);
      const count = fixture.mock.sentUserMessages.length;
      await vi.advanceTimersByTimeAsync(60_000);
      assert.equal(fixture.mock.sentUserMessages.length, count);
    });
  }

  for (const event of ["session_compact", "session_compact_failed"]) {
    test(`${event} rechecks a deadline missed while manual compaction was busy`, async () => {
      let idle = true;
      const fixture = await waitingGoal(10_000, { isIdle: () => idle });
      idle = false;
      await vi.advanceTimersByTimeAsync(10_000);
      assert.equal(fixture.mock.sentUserMessages.length, 0);
      await fixture.mock.events.get(event)?.[0]?.({}, fixture.ctx);
      idle = true;
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(fixture.mock.sentUserMessages.length, 1);
    });
  }

  test("real steering wakes a wait while preserving cumulative usage and Unlimited", async () => {
    const branch = [{ type: "message", message: { role: "assistant", usage: { totalTokens: 123 } } }];
    const original = await waitingGoal(10_000, { sessionManager: { getBranch: () => branch } });
    const saved = requireLastGoal(original.mock);
    saved.tokensUsed = 23;
    saved.baselineTokens = 100;
    saved.timeUsedSeconds = 17;
    const fixture = restoreStoredGoalForTest(saved, branch, "always", {}, UNLIMITED_SETTINGS_PATH);
    original.mock.events.get("session_shutdown")?.[0]?.({}, original.ctx);
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "interactive", text: "Review passed", streamingBehavior: "steer" },
      fixture.ctx,
    );
    const resumed = requireLastGoal(fixture.mock);
    assert.equal(resumed.status, "active");
    assert.equal(resumed.tokensUsed, 23);
    assert.equal(resumed.timeUsedSeconds, 17);
    assert.equal(resumed.text, saved.text);
    assert.notEqual(resumed.id, saved.id);
    assert.match(fixture.statuses.get("goal") ?? "", /Unlimited/);
    assert.equal(fixture.mock.sentUserMessages.length, 0);
  });

  for (const status of ["paused", "blocked", "usage_limited", "budget_limited"]) {
    test(`real input does not wake a restored ${status} without a wait`, async () => {
      const original = await waitingGoal();
      const saved = { ...requireLastGoal(original.mock), status, wait: undefined };
      const fixture = restoreStoredGoalForTest(saved);
      await fixture.mock.events.get("input")?.[0]?.({ source: "rpc", text: "Ready" }, fixture.ctx);
      assert.equal(requireLastGoal(fixture.mock).status, status);
      assert.equal(fixture.mock.sentUserMessages.length, 0);
    });
  }

  test("frozen queues do not arm waits or resume on input", async () => {
    const original = await waitingGoal(10_000);
    const saved = requireLastGoal(original.mock);
    original.mock.events.get("session_shutdown")?.[0]?.({}, original.ctx);
    const fixture = restoreStoredGoalForTest(saved, [
      {
        type: "custom",
        customType: "goal-state",
        data: {
          goal: saved,
          queue: [{ ...saved, id: "queued-tail", status: "queued", wait: undefined }],
        },
      },
    ]);
    assert.equal(fixture.statuses.get("goal"), "queue off");
    await vi.advanceTimersByTimeAsync(60_000);
    await fixture.mock.events.get("input")?.[0]?.({ source: "rpc", text: "Ready" }, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
    assert.equal(fixture.mock.sentUserMessages.length, 0);
  });

  test("an exhausted token budget prevents deadline and input wake", async () => {
    const original = await waitingGoal(10_000);
    const saved = { ...requireLastGoal(original.mock), tokenBudget: 10, tokensUsed: 10 };
    original.mock.events.get("session_shutdown")?.[0]?.({}, original.ctx);
    const fixture = restoreStoredGoalForTest(saved);
    await vi.advanceTimersByTimeAsync(10_000);
    await fixture.mock.events.get("input")?.[0]?.({ source: "rpc", text: "Ready" }, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
    assert.equal(requireLastGoal(fixture.mock).tokensUsed, 10);
    assert.equal(fixture.mock.sentUserMessages.length, 0);
  });

  test("a restrictive tool policy prevents deadline and input activation", async () => {
    const fixture = await waitingGoal(10_000);
    fixture.mock.rawPi.setActiveTools(["read"]);
    await vi.advanceTimersByTimeAsync(10_000);
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "rpc", text: "Ready", streamingBehavior: "steer" },
      {
        ...fixture.ctx,
        isIdle: () => false,
      },
    );
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
    assert.equal(fixture.mock.sentUserMessages.length, 0);
  });

  test("failed deadline delivery restores the exact wait, id and accounting without a timer loop", async () => {
    const fixture = await waitingGoal(10_000);
    const saved = structuredClone(requireLastGoal(fixture.mock));
    fixture.mock.rawPi.sendUserMessage = () => {
      throw new Error("delivery failed");
    };
    await vi.advanceTimersByTimeAsync(60_000);
    assert.deepEqual(requireLastGoal(fixture.mock), saved);
    assert.equal(vi.getTimerCount(), 0);
  });
});
