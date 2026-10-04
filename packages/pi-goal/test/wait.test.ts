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
import { currentTokenTotal } from "../src/accounting.js";
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

async function deliverPrompt(fixture: Awaited<ReturnType<typeof waitingGoal>>, prompt: string) {
  const before = requireLastGoal(fixture.mock);
  const result = await fixture.mock.events.get("before_agent_start")?.[0]?.(
    { prompt, systemPrompt: "base" },
    fixture.ctx,
  );
  if (before.status === "paused" && before.wait) {
    assert.equal(requireLastGoal(fixture.mock).id, before.id, "preflight must not rotate the waiting goal");
    assert.deepEqual(requireLastGoal(fixture.mock).wait, before.wait);
  }
  await fixture.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: prompt } }, fixture.ctx);
  return result;
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

  test("a deadline does not race an accepted real input awaiting authentication", async () => {
    const fixture = await waitingGoal(10_000);
    await vi.advanceTimersByTimeAsync(9_000);
    await fixture.mock.events.get("input")?.[0]?.({ source: "interactive", text: "Ready" }, fixture.ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
    assert.equal(fixture.mock.sentUserMessages.length, 0);
    await deliverPrompt(fixture, "Ready");
    assert.equal(requireLastGoal(fixture.mock).status, "active");
    assert.equal(fixture.mock.sentUserMessages.length, 0);
  });

  test("a slow accepted input keeps the deadline from starting a second prompt", async () => {
    const fixture = await waitingGoal(10_000);
    await vi.advanceTimersByTimeAsync(9_000);
    await fixture.mock.events.get("input")?.[0]?.({ source: "interactive", text: "Slow auth" }, fixture.ctx);
    await vi.advanceTimersByTimeAsync(121_000);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
    assert.equal(fixture.mock.sentUserMessages.length, 0);
    await deliverPrompt(fixture, "Slow auth");
    assert.equal(requireLastGoal(fixture.mock).status, "active");
    assert.equal(fixture.mock.sentUserMessages.length, 0);
  });

  test("an unconfirmed input defers a deadline until explicit recovery", async () => {
    const fixture = await waitingGoal(10_000);
    await vi.advanceTimersByTimeAsync(9_000);
    await fixture.mock.events.get("input")?.[0]?.({ source: "interactive", text: "No model" }, fixture.ctx);
    await vi.advanceTimersByTimeAsync(121_000);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
    assert.equal(fixture.mock.sentUserMessages.length, 0);
    await fixture.mock.commands.get("goal")?.handler("resume", fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "active");
    assert.equal(fixture.mock.sentUserMessages.length, 1);
  });

  test("ambiguous direct delivery retains protection for a real input still in preflight", async () => {
    const fixture = await waitingGoal(10_000);
    await fixture.mock.events.get("input")?.[0]?.({ source: "interactive", text: "A" }, fixture.ctx);
    await fixture.mock.events.get("input")?.[0]?.({ source: "extension", text: "A" }, fixture.ctx);
    await fixture.mock.events.get("before_agent_start")?.[0]?.({ prompt: "A", systemPrompt: "base" }, fixture.ctx);
    await fixture.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: "A" } }, fixture.ctx);
    await fixture.mock.events.get("agent_settled")?.[0]?.({}, fixture.ctx);
    await vi.advanceTimersByTimeAsync(130_000);
    assert.equal(fixture.mock.sentUserMessages.length, 0);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
    await fixture.mock.commands.get("goal")?.handler("resume", fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "active");
  });

  test("an unrelated prompt preflight cannot cancel the waiting deadline", async () => {
    const fixture = await waitingGoal(10_000);
    await fixture.mock.events.get("input")?.[0]?.({ source: "extension", text: "housekeeping" }, fixture.ctx);
    await fixture.mock.events.get("before_agent_start")?.[0]?.(
      { prompt: "housekeeping", systemPrompt: "base" },
      fixture.ctx,
    );
    // Image normalization or a later hook can fail before an agent run settles.
    await vi.advanceTimersByTimeAsync(10_000);
    assert.equal(fixture.mock.sentUserMessages.length, 1);
    assert.equal(requireLastGoal(fixture.mock).status, "active");
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
      assert.equal(requireLastGoal(fixture.mock).status, "paused");
      const result = (await deliverPrompt(fixture, "Review passed")) as { systemPrompt?: string };
      assert.equal(requireLastGoal(fixture.mock).status, "active");
      assert.equal(requireLastGoal(fixture.mock).wait, undefined);
      assert.match(result.systemPrompt ?? "", /finish after review/);
      await vi.advanceTimersByTimeAsync(60_000);
      assert.equal(fixture.mock.sentUserMessages.length, 0);
    });
  }

  test("a transformed queued extension message cannot claim a consumed direct input", async () => {
    const fixture = await waitingGoal();
    await fixture.mock.events.get("input")?.[0]?.({ source: "interactive", text: "Ready" }, fixture.ctx);
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "extension", text: "template", streamingBehavior: "followUp" },
      fixture.ctx,
    );
    await fixture.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: "Ready" } }, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
  });

  test("a transformed extension prompt cannot claim a consumed real input", async () => {
    const fixture = await waitingGoal();
    await fixture.mock.events.get("input")?.[0]?.({ source: "interactive", text: "Ready" }, fixture.ctx);
    // The real input is handled downstream; only the extension prompt starts.
    await fixture.mock.events.get("input")?.[0]?.({ source: "extension", text: "template" }, fixture.ctx);
    await deliverPrompt(fixture, "Ready");
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
  });

  test("a later handler consuming input leaves the wait intact", async () => {
    const fixture = await waitingGoal();
    const waitingId = requireLastGoal(fixture.mock).id;
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "interactive", text: "Consumed by another extension" },
      fixture.ctx,
    );
    // Pi never calls before_agent_start after another input handler returns handled.
    assert.equal(requireLastGoal(fixture.mock).id, waitingId);
    assert.deepEqual(requireLastGoal(fixture.mock).wait, { reason: "review result" });
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "extension", text: "Consumed by another extension" },
      fixture.ctx,
    );
    await fixture.mock.events.get("before_agent_start")?.[0]?.(
      { prompt: "Consumed by another extension", systemPrompt: "base" },
      fixture.ctx,
    );
    assert.equal(requireLastGoal(fixture.mock).id, waitingId);
    await fixture.mock.events.get("input")?.[0]?.({ source: "rpc", text: "Delivered" }, fixture.ctx);
    await fixture.mock.events.get("before_agent_start")?.[0]?.(
      { prompt: "Delivered", systemPrompt: "base" },
      fixture.ctx,
    );
    assert.equal(
      requireLastGoal(fixture.mock).id,
      waitingId,
      "mixed-source ambiguity remains stopped until explicit recovery",
    );
    await fixture.mock.commands.get("goal")?.handler("resume", fixture.ctx);
    assert.notEqual(requireLastGoal(fixture.mock).id, waitingId);
  });

  test("an owned prompt cannot consume a pending real input wake", async () => {
    const fixture = await startGoalForTest({}, "finish after review", UNLIMITED_SETTINGS_PATH);
    const ownedPrompt = fixture.mock.sentUserMessages[0]?.text ?? "";
    const goal = requireLastGoal(fixture.mock);
    await requireGoalTool(fixture.mock, "goal_wait").execute(
      "wait",
      { goal_id: goal.id, reason: "review result" },
      undefined,
      undefined,
      fixture.ctx,
    );
    await fixture.mock.events.get("input")?.[0]?.({ source: "interactive", text: "Ready" }, fixture.ctx);
    await fixture.mock.events.get("before_agent_start")?.[0]?.(
      { prompt: ownedPrompt, systemPrompt: "base" },
      fixture.ctx,
    );
    await deliverPrompt(fixture, "Ready");
    assert.equal(requireLastGoal(fixture.mock).status, "active");
    assert.notEqual(requireLastGoal(fixture.mock).id, goal.id);
  });

  test("an unresolved extension input makes a matching real wake fail closed", async () => {
    const fixture = await waitingGoal();
    await fixture.mock.events.get("input")?.[0]?.({ source: "interactive", text: "Ready" }, fixture.ctx);
    await fixture.mock.events.get("input")?.[0]?.({ source: "extension", text: "housekeeping" }, fixture.ctx);
    await deliverPrompt(fixture, "Ready");
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
  });

  test("a real input wakes after the extension's separate prompt is accounted for", async () => {
    const fixture = await waitingGoal();
    await fixture.mock.events.get("input")?.[0]?.({ source: "extension", text: "housekeeping" }, fixture.ctx);
    await fixture.mock.events.get("before_agent_start")?.[0]?.(
      { prompt: "housekeeping", systemPrompt: "base" },
      fixture.ctx,
    );
    await fixture.mock.events.get("input")?.[0]?.({ source: "interactive", text: "Ready" }, fixture.ctx);
    await deliverPrompt(fixture, "Ready");
    assert.equal(requireLastGoal(fixture.mock).status, "active");
  });

  test("accepted input still wakes after another handler transforms its text", async () => {
    const fixture = await waitingGoal();
    await fixture.mock.events.get("input")?.[0]?.({ source: "interactive", text: "/template review" }, fixture.ctx);
    const result = (await deliverPrompt(fixture, "Expanded review result")) as { systemPrompt?: string };
    assert.equal(requireLastGoal(fixture.mock).status, "active");
    assert.match(result.systemPrompt ?? "", /finish after review/);
  });

  test("a rejected prompt does not consume the wait before a later accepted input", async () => {
    const fixture = await waitingGoal();
    await fixture.mock.events.get("input")?.[0]?.({ source: "interactive", text: "No model" }, fixture.ctx);
    // Pi rejects this prompt during model/auth validation, before before_agent_start.
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
    await fixture.mock.events.get("input")?.[0]?.({ source: "interactive", text: "Ready" }, fixture.ctx);
    await deliverPrompt(fixture, "Ready");
    assert.equal(requireLastGoal(fixture.mock).status, "active");
  });

  test("a transformed real input wakes after an earlier prompt was rejected", async () => {
    const fixture = await waitingGoal();
    await fixture.mock.events.get("input")?.[0]?.({ source: "interactive", text: "No model" }, fixture.ctx);
    await fixture.mock.events.get("input")?.[0]?.({ source: "interactive", text: "/template review" }, fixture.ctx);
    await deliverPrompt(fixture, "Expanded review result");
    assert.equal(requireLastGoal(fixture.mock).status, "active");
  });

  test("idle-queued follow-up wakes when delivered inside another run", async () => {
    const fixture = await waitingGoal();
    await fixture.mock.events.get("input")?.[0]?.({ source: "rpc", text: "Ready" }, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
    // Pi's follow_up RPC omits streamingBehavior when queued while idle, then
    // may deliver the message inside another run without before_agent_start.
    await fixture.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: "Ready" } }, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "active");
  });

  test("an extension's accepted direct turn cannot claim a pending idle follow-up", async () => {
    const fixture = await waitingGoal();
    await fixture.mock.events.get("input")?.[0]?.({ source: "rpc", text: "Ready" }, fixture.ctx);
    await fixture.mock.events.get("input")?.[0]?.({ source: "extension", text: "housekeeping" }, fixture.ctx);
    await fixture.mock.events.get("before_agent_start")?.[0]?.(
      { prompt: "housekeeping", systemPrompt: "base" },
      fixture.ctx,
    );
    await fixture.mock.events.get("message_start")?.[0]?.(
      { message: { role: "user", content: "housekeeping" } },
      fixture.ctx,
    );
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
    await fixture.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: "Ready" } }, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "active");
  });

  test("ambiguous direct markers cannot lend identity to a queued real message", async () => {
    const fixture = await waitingGoal();
    await fixture.mock.events.get("input")?.[0]?.({ source: "interactive", text: "Ready" }, fixture.ctx);
    await fixture.mock.events.get("input")?.[0]?.({ source: "extension", text: "Ready" }, fixture.ctx);
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "rpc", text: "Ready", streamingBehavior: "followUp" },
      fixture.ctx,
    );
    await fixture.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: "Ready" } }, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
  });

  test("identical idle and streaming follow-ups wake when both inputs are real", async () => {
    const fixture = await waitingGoal();
    await fixture.mock.events.get("input")?.[0]?.({ source: "rpc", text: "Ready" }, fixture.ctx);
    await fixture.mock.events.get("input")?.[0]?.({ source: "extension", text: "housekeeping" }, fixture.ctx);
    await fixture.mock.events.get("before_agent_start")?.[0]?.(
      { prompt: "housekeeping", systemPrompt: "base" },
      fixture.ctx,
    );
    await fixture.mock.events.get("message_start")?.[0]?.(
      { message: { role: "user", content: "housekeeping" } },
      fixture.ctx,
    );
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "interactive", text: "Ready", streamingBehavior: "followUp" },
      fixture.ctx,
    );
    await fixture.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: "Ready" } }, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "active");
    const firstWakeId = requireLastGoal(fixture.mock).id;
    await requireGoalTool(fixture.mock, "goal_wait").execute(
      "wait-again",
      { goal_id: firstWakeId, reason: "second review" },
      undefined,
      undefined,
      fixture.ctx,
    );
    await fixture.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: "Ready" } }, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "active");
    assert.notEqual(requireLastGoal(fixture.mock).id, firstWakeId);
  });

  test("an idle-queued real input wakes a wait entered after it was queued", async () => {
    const fixture = await startGoalForTest({}, "finish after review", UNLIMITED_SETTINGS_PATH);
    const initialPrompt = fixture.mock.sentUserMessages[0]?.text ?? "";
    await fixture.mock.events.get("before_agent_start")?.[0]?.(
      { prompt: initialPrompt, systemPrompt: "base" },
      fixture.ctx,
    );
    await fixture.mock.events.get("message_start")?.[0]?.(
      { message: { role: "user", content: initialPrompt } },
      fixture.ctx,
    );
    const id = requireLastGoal(fixture.mock).id;
    await fixture.mock.events.get("input")?.[0]?.({ source: "rpc", text: "Ready" }, fixture.ctx);
    await requireGoalTool(fixture.mock, "goal_wait").execute(
      "wait",
      { goal_id: id, reason: "review" },
      undefined,
      undefined,
      fixture.ctx,
    );
    await fixture.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: "Ready" } }, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "active");
    assert.notEqual(requireLastGoal(fixture.mock).id, id);
  });

  test("explicit resume clears input markers owned by the previous goal instance", async () => {
    const fixture = await waitingGoal();
    await fixture.mock.events.get("input")?.[0]?.({ source: "extension", text: "handled housekeeping" }, fixture.ctx);
    await fixture.mock.commands.get("goal")?.handler("resume", fixture.ctx);
    const id = requireLastGoal(fixture.mock).id;
    await requireGoalTool(fixture.mock, "goal_wait").execute(
      "wait",
      { goal_id: id, reason: "next review" },
      undefined,
      undefined,
      fixture.ctx,
    );
    await fixture.mock.events.get("input")?.[0]?.({ source: "interactive", text: "Ready" }, fixture.ctx);
    await deliverPrompt(fixture, "Ready");
    await fixture.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: "Ready" } }, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "active");
    assert.notEqual(requireLastGoal(fixture.mock).id, id);
  });

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
    const context = (await fixture.mock.events.get("context")?.[0]?.(
      { messages: [{ role: "user", content: "Review passed" }] },
      fixture.ctx,
    )) as { messages: Array<{ content: string }> };
    const binding = context.messages.at(-1)?.content ?? "";
    assert.match(binding, /Active \/goal:.*finish after review/s);
    assert.equal(binding.match(/<goal_id>/g)?.length, 1);
  });

  test("an unambiguous transformed queued input wakes on delivery", async () => {
    const fixture = await waitingGoal();
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "rpc", text: "/template review", streamingBehavior: "followUp" },
      fixture.ctx,
    );
    await fixture.mock.events.get("message_start")?.[0]?.(
      { message: { role: "user", content: "Expanded review result" } },
      fixture.ctx,
    );
    assert.equal(requireLastGoal(fixture.mock).status, "active");
  });

  test("a transformed follow-up wakes when every queued candidate is real", async () => {
    const fixture = await waitingGoal();
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "rpc", text: "/template first", streamingBehavior: "followUp" },
      fixture.ctx,
    );
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "interactive", text: "/template second", streamingBehavior: "followUp" },
      fixture.ctx,
    );
    await fixture.mock.events.get("message_start")?.[0]?.(
      { message: { role: "user", content: "Expanded first" } },
      fixture.ctx,
    );
    assert.equal(requireLastGoal(fixture.mock).status, "active");
  });

  test("an extension follow-up cannot claim an undelivered real input with the same text", async () => {
    const fixture = await waitingGoal();
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "rpc", text: "Ready", streamingBehavior: "followUp" },
      fixture.ctx,
    );
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "extension", text: "Ready", streamingBehavior: "followUp" },
      fixture.ctx,
    );
    await fixture.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: "Ready" } }, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
  });

  test("a transformed direct extension message cannot claim a consumed queued input", async () => {
    const fixture = await waitingGoal();
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "rpc", text: "Ready", streamingBehavior: "followUp" },
      fixture.ctx,
    );
    await fixture.mock.events.get("input")?.[0]?.({ source: "extension", text: "template" }, fixture.ctx);
    await fixture.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: "Ready" } }, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
  });

  test("a consumed real steer cannot lend its identity to an extension follow-up", async () => {
    const fixture = await waitingGoal();
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "interactive", text: "Ready", streamingBehavior: "steer" },
      fixture.ctx,
    );
    // A later handler consumes the steer, leaving only the extension follow-up.
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "extension", text: "Ready", streamingBehavior: "followUp" },
      fixture.ctx,
    );
    await fixture.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: "Ready" } }, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
  });

  test("cross-transformed deliveries cannot reuse the other source's leftover marker", async () => {
    const fixture = await waitingGoal();
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "interactive", text: "A", streamingBehavior: "steer" },
      fixture.ctx,
    );
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "extension", text: "B", streamingBehavior: "followUp" },
      fixture.ctx,
    );
    // A later handler maps real A to B and extension B to C.
    await fixture.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: "B" } }, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
    await fixture.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: "C" } }, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
  });

  test("a same-text steer and extension follow-up stay waiting without delivery identity", async () => {
    const fixture = await waitingGoal();
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "interactive", text: "Ready", streamingBehavior: "steer" },
      fixture.ctx,
    );
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "extension", text: "Ready", streamingBehavior: "followUp" },
      fixture.ctx,
    );
    await fixture.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: "Ready" } }, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
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
      assert.equal(
        binding?.content,
        `Goal runtime binding update: real input resumed the waiting goal. This current goal_id supersedes the earlier binding.\n\n<goal_id>\n${resumedId}\n</goal_id>\nThis goal_id is only the goal_complete tool stale-turn guard, not part of the objective. If and only if the goal is fully complete, pass this exact goal_id to goal_complete with the completion summary.`,
      );
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

  test("accepted input wake publishes one safety reset", async () => {
    const fixture = await waitingGoal();
    const before = fixture.mock.entries.filter(({ customType }) => customType === "goal-state").length;
    await fixture.mock.events.get("input")?.[0]?.({ source: "interactive", text: "Ready" }, fixture.ctx);
    assert.equal(fixture.mock.entries.filter(({ customType }) => customType === "goal-state").length, before);
    await deliverPrompt(fixture, "Ready");
    assert.equal(fixture.mock.entries.filter(({ customType }) => customType === "goal-state").length, before + 1);
  });

  test("queued real follow-up publishes one safety reset when delivered", async () => {
    const fixture = await waitingGoal();
    const before = fixture.mock.entries.filter(({ customType }) => customType === "goal-state").length;
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "rpc", text: "Ready", streamingBehavior: "followUp" },
      fixture.ctx,
    );
    await fixture.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: "Ready" } }, fixture.ctx);
    assert.equal(fixture.mock.entries.filter(({ customType }) => customType === "goal-state").length, before + 1);
  });

  test("input-only waits survive restore without a timer", async () => {
    const fixture = restoreWait(await waitingGoal());
    await vi.advanceTimersByTimeAsync(86_400_000);
    assert.deepEqual(requireLastGoal(fixture.mock).wait, { reason: "review result" });
    assert.equal(fixture.mock.sentUserMessages.length, 0);
    await fixture.mock.events.get("input")?.[0]?.({ source: "interactive", text: "Ready" }, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
    await deliverPrompt(fixture, "Ready");
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

  test("an unaccepted steer leaves the waiting goal's stale-tool guard intact", async () => {
    const abort = vi.fn();
    const fixture = await waitingGoal(undefined, { abort });
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "interactive", text: "consumed steer", streamingBehavior: "steer" },
      fixture.ctx,
    );
    // A later input handler consumes the steer, so Pi never emits message_start.
    const result = fixture.mock.events.get("tool_call")?.[0]?.(
      { toolName: "bash", toolCallId: "stale", input: { command: "true" } },
      fixture.ctx,
    ) as { block?: boolean } | undefined;
    assert.equal(result?.block, true);
    assert.equal(abort.mock.calls.length, 1);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
  });

  test("pausing a waiting goal does not abort unrelated work", async () => {
    let idle = true;
    const abort = vi.fn();
    const fixture = await waitingGoal(10_000, { isIdle: () => idle, abort });
    idle = false;
    await fixture.mock.commands.get("goal")?.handler("pause", fixture.ctx);
    assert.equal(abort.mock.calls.length, 0);
    assert.equal(requireLastGoal(fixture.mock).wait, undefined);
    assert.equal(
      fixture.mock.events.get("tool_call")?.[0]?.(
        { toolName: "read", toolCallId: "unrelated", input: {} },
        fixture.ctx,
      ),
      undefined,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    assert.equal(fixture.mock.sentUserMessages.length, 0);
  });

  test("pausing a waiting goal does not abort an extension steer in its old run", async () => {
    let idle = true;
    const abort = vi.fn();
    const fixture = await startGoalForTest(
      { isIdle: () => idle, abort },
      "finish after review",
      UNLIMITED_SETTINGS_PATH,
    );
    const initialPrompt = fixture.mock.sentUserMessages[0]?.text ?? "";
    await fixture.mock.events.get("before_agent_start")?.[0]?.(
      { prompt: initialPrompt, systemPrompt: "base" },
      fixture.ctx,
    );
    const goal = requireLastGoal(fixture.mock);
    await requireGoalTool(fixture.mock, "goal_wait").execute(
      "wait",
      { goal_id: goal.id, reason: "external review" },
      undefined,
      undefined,
      fixture.ctx,
    );
    idle = false;
    await fixture.mock.events.get("input")?.[0]?.(
      { source: "extension", text: "housekeeping", streamingBehavior: "steer" },
      fixture.ctx,
    );
    await fixture.mock.events.get("message_start")?.[0]?.(
      { message: { role: "user", content: "housekeeping" } },
      fixture.ctx,
    );
    await fixture.mock.commands.get("goal")?.handler("pause", fixture.ctx);
    assert.equal(abort.mock.calls.length, 0);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
    assert.equal(requireLastGoal(fixture.mock).wait, undefined);
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

  test("input wake excludes unrelated usage accumulated during the wait", async () => {
    const branch = [{ type: "message", message: { role: "assistant", usage: { totalTokens: 123 } } }];
    const original = await waitingGoal(undefined, { sessionManager: { getBranch: () => branch } });
    const saved = structuredClone(requireLastGoal(original.mock));
    saved.tokensUsed = 23;
    saved.baselineTokens = 100;
    saved.tokenBudget = 50;
    const fixture = restoreStoredGoalForTest(saved, branch, "always", {}, UNLIMITED_SETTINGS_PATH);
    const restoredBranch = fixture.ctx.sessionManager.getBranch() as Array<Record<string, unknown>>;
    original.mock.events.get("session_shutdown")?.[0]?.({}, original.ctx);
    assert.equal(requireLastGoal(fixture.mock).tokensUsed, 23);
    assert.equal(requireLastGoal(fixture.mock).baselineTokens, 100);
    restoredBranch.push({ type: "message", message: { role: "assistant", usage: { totalTokens: 1_000 } } });
    await fixture.mock.events.get("input")?.[0]?.({ source: "interactive", text: "Review passed" }, fixture.ctx);
    await deliverPrompt(fixture, "Review passed");
    assert.equal(requireLastGoal(fixture.mock).status, "active");
    assert.equal(requireLastGoal(fixture.mock).tokensUsed, 23);
    assert.equal(requireLastGoal(fixture.mock).baselineTokens, 1_100);
    restoredBranch.push({ type: "message", message: { role: "assistant", usage: { totalTokens: 5 } } });
    assert.equal(currentTokenTotal(fixture.ctx), 1_128);
    await fixture.mock.events.get("tool_execution_end")?.[0]?.({}, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).tokensUsed, 28);
    assert.equal(requireLastGoal(fixture.mock).status, "active");
  });

  test("status and edit do not charge unrelated work to a waiting goal", async () => {
    const original = await waitingGoal();
    const saved = structuredClone(requireLastGoal(original.mock));
    saved.tokensUsed = 23;
    saved.baselineTokens = 100;
    const fixture = restoreStoredGoalForTest(saved, [
      { type: "message", message: { role: "assistant", usage: { totalTokens: 123 } } },
    ]);
    const branch = fixture.ctx.sessionManager.getBranch() as Array<Record<string, unknown>>;
    branch.push({ type: "message", message: { role: "assistant", usage: { totalTokens: 500 } } });
    await fixture.mock.commands.get("goal")?.handler("status", fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).tokensUsed, 23);
    await fixture.mock.commands.get("goal")?.handler("edit revised objective", fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).tokensUsed, 23);
  });

  test("a compacted session preserves cumulative usage when input wakes a wait", async () => {
    const original = await waitingGoal();
    const saved = structuredClone(requireLastGoal(original.mock));
    saved.tokensUsed = 10_000;
    saved.baselineTokens = 0;
    saved.tokenBudget = 20_000;
    const fixture = restoreStoredGoalForTest(saved, [
      { type: "message", message: { role: "assistant", usage: { totalTokens: 100 } } },
    ]);
    const branch = fixture.ctx.sessionManager.getBranch() as Array<Record<string, unknown>>;
    await fixture.mock.events.get("input")?.[0]?.({ source: "rpc", text: "Ready" }, fixture.ctx);
    await deliverPrompt(fixture, "Ready");
    branch.push({ type: "message", message: { role: "assistant", usage: { totalTokens: 7 } } });
    await fixture.mock.events.get("tool_execution_end")?.[0]?.({}, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).tokensUsed, 10_007);
    assert.equal(requireLastGoal(fixture.mock).status, "active");
    branch.splice(1);
    branch.push({ type: "message", message: { role: "assistant", usage: { totalTokens: 2 } } });
    await fixture.mock.events.get("tool_execution_end")?.[0]?.({}, fixture.ctx);
    branch.push({ type: "message", message: { role: "assistant", usage: { totalTokens: 5 } } });
    await fixture.mock.events.get("tool_execution_end")?.[0]?.({}, fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).tokensUsed, 10_012);
  });

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
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
    await fixture.mock.events.get("message_start")?.[0]?.(
      { message: { role: "user", content: "Review passed" } },
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

  test("accepted input does not override a restrictive active tool policy", async () => {
    const fixture = await waitingGoal();
    fixture.mock.rawPi.setActiveTools(["read"]);
    await fixture.mock.events.get("input")?.[0]?.({ source: "interactive", text: "Ready" }, fixture.ctx);
    await deliverPrompt(fixture, "Ready");
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
    assert.deepEqual(fixture.mock.rawPi.getActiveTools(), ["read"]);
  });

  test("a restrictive tool policy defers the deadline until tools return", async () => {
    const fixture = await waitingGoal(10_000);
    fixture.mock.rawPi.setActiveTools(["read"]);
    await vi.advanceTimersByTimeAsync(10_000);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
    assert.equal(fixture.mock.sentUserMessages.length, 0);
    fixture.mock.rawPi.setActiveTools(["read", "goal_complete", "goal_blocked", "goal_wait"]);
    await fixture.mock.events.get("agent_settled")?.[0]?.({}, fixture.ctx);
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(requireLastGoal(fixture.mock).status, "active");
    assert.equal(fixture.mock.sentUserMessages.length, 1);
  });

  test("an overdue wait wakes after tools return without another agent event", async () => {
    const fixture = await waitingGoal(10_000);
    fixture.mock.rawPi.setActiveTools(["read"]);
    await vi.advanceTimersByTimeAsync(10_000);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
    fixture.mock.rawPi.setActiveTools(["read", "goal_complete", "goal_blocked", "goal_wait"]);
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(requireLastGoal(fixture.mock).status, "active");
    assert.equal(fixture.mock.sentUserMessages.length, 1);
  });

  test("failed replacement restores the waiting goal without charging unrelated work", async () => {
    const original = await waitingGoal(10_000);
    const saved = structuredClone(requireLastGoal(original.mock));
    original.mock.events.get("session_shutdown")?.[0]?.({}, original.ctx);
    saved.tokensUsed = 23;
    saved.baselineTokens = 100;
    const fixture = restoreStoredGoalForTest(saved, [
      { type: "message", message: { role: "assistant", usage: { totalTokens: 123 } } },
    ]);
    const branch = fixture.ctx.sessionManager.getBranch() as Array<Record<string, unknown>>;
    branch.push({ type: "message", message: { role: "assistant", usage: { totalTokens: 500 } } });
    fixture.mock.rawPi.sendUserMessage = () => {
      throw new Error("delivery failed");
    };
    await fixture.mock.commands.get("goal")?.handler("replacement objective", fixture.ctx);
    const restored = requireLastGoal(fixture.mock);
    assert.equal(restored.id, saved.id);
    assert.equal(restored.status, "paused");
    assert.deepEqual(restored.wait, saved.wait);
    assert.equal(restored.tokensUsed, 23);
    assert.equal(vi.getTimerCount(), 1);
  });

  test("failed explicit resume preserves a waiting goal's future deadline", async () => {
    const fixture = await waitingGoal(10_000);
    const saved = structuredClone(requireLastGoal(fixture.mock));
    const send = fixture.mock.rawPi.sendUserMessage;
    fixture.mock.rawPi.sendUserMessage = () => {
      throw new Error("delivery failed");
    };
    await fixture.mock.commands.get("goal")?.handler("resume", fixture.ctx);
    assert.deepEqual(requireLastGoal(fixture.mock), saved);
    fixture.mock.rawPi.sendUserMessage = send;
    await vi.advanceTimersByTimeAsync(10_000);
    assert.equal(fixture.mock.sentUserMessages.length, 1);
    assert.equal(requireLastGoal(fixture.mock).status, "active");
  });

  test("failed explicit resume rechecks an overdue wait once", async () => {
    let idle = true;
    const fixture = await waitingGoal(10_000, { isIdle: () => idle });
    idle = false;
    await vi.advanceTimersByTimeAsync(10_000);
    idle = true;
    const send = fixture.mock.rawPi.sendUserMessage;
    fixture.mock.rawPi.sendUserMessage = () => {
      throw new Error("delivery failed");
    };
    await fixture.mock.commands.get("goal")?.handler("resume", fixture.ctx);
    assert.equal(requireLastGoal(fixture.mock).status, "paused");
    fixture.mock.rawPi.sendUserMessage = send;
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(fixture.mock.sentUserMessages.length, 1);
    assert.equal(requireLastGoal(fixture.mock).status, "active");
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
