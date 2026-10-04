import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { afterEach, test, vi } from "vitest";
import { createGoal } from "../src/runtime.js";
import {
  assistantUsageEntry,
  requireGoalTool,
  requireLastGoal,
  restoreStoredGoalForTest,
  settingsPath,
} from "./support/goal-fixture.js";

afterEach(() => vi.useRealTimers());

function restoredBranchGoal() {
  const goal = { ...createGoal("first branch", undefined, 100), tokensUsed: 20 };
  const fixture = restoreStoredGoalForTest(goal, [assistantUsageEntry({ totalTokens: 120 })]);
  const branch = fixture.ctx.sessionManager.getBranch() as Array<Record<string, unknown>>;
  return { ...fixture, branch, goal };
}

test("tree navigation checkpoints the source branch's active elapsed time", async () => {
  vi.useFakeTimers();
  const fixture = restoredBranchGoal();
  await vi.advanceTimersByTimeAsync(5_000);
  await fixture.mock.events.get("session_before_tree")?.[0]?.(
    { preparation: { targetId: "other", oldLeafId: "source" } },
    fixture.ctx,
  );
  const checkpoint = requireLastGoal(fixture.mock);
  assert.equal(checkpoint.timeUsedSeconds, 5);
  fixture.branch.splice(0, fixture.branch.length, {
    type: "custom",
    customType: "goal-state",
    data: { goal: createGoal("other branch", undefined, 0) },
  });
  await fixture.mock.events.get("session_tree")?.[0]?.({ oldLeafId: "source", newLeafId: "other" }, fixture.ctx);
  fixture.branch.splice(0, fixture.branch.length, {
    type: "custom",
    customType: "goal-state",
    data: { goal: checkpoint },
  });
  await fixture.mock.events.get("session_tree")?.[0]?.({ oldLeafId: "other", newLeafId: "checkpoint" }, fixture.ctx);
  assert.equal(requireLastGoal(fixture.mock).timeUsedSeconds, 5);
});

test("tree navigation rebases an active goal before charging new work on a higher-total branch", async () => {
  const fixture = restoredBranchGoal();
  fixture.branch.splice(0, fixture.branch.length, assistantUsageEntry({ totalTokens: 1_000 }), {
    type: "custom",
    customType: "goal-state",
    data: { goal: fixture.goal },
  });
  await fixture.mock.events.get("session_tree")?.[0]?.({ oldLeafId: "old", newLeafId: "new" }, fixture.ctx);
  const rebased = requireLastGoal(fixture.mock);
  assert.equal(rebased.tokensUsed, 20);
  assert.equal(rebased.baselineTokens, 980);
  fixture.branch.push(assistantUsageEntry({ totalTokens: 5 }));
  await fixture.mock.events.get("tool_execution_end")?.[0]?.({}, fixture.ctx);
  assert.equal(requireLastGoal(fixture.mock).tokensUsed, 25);
});

test("tree navigation includes goal-owned assistant usage after the last state checkpoint", async () => {
  const fixture = restoredBranchGoal();
  fixture.branch.splice(
    0,
    fixture.branch.length,
    assistantUsageEntry({ totalTokens: 120 }),
    { type: "custom", customType: "goal-state", data: { goal: fixture.goal } },
    assistantUsageEntry({ totalTokens: 5 }),
  );
  await fixture.mock.events.get("session_tree")?.[0]?.({ oldLeafId: "old", newLeafId: "unfinished" }, fixture.ctx);
  assert.equal(requireLastGoal(fixture.mock).tokensUsed, 25);
  fixture.branch.push(assistantUsageEntry({ totalTokens: 7 }));
  await fixture.mock.events.get("tool_execution_end")?.[0]?.({}, fixture.ctx);
  assert.equal(requireLastGoal(fixture.mock).tokensUsed, 32);
});

test("unaccounted destination usage enforces the goal token budget", async () => {
  const fixture = restoredBranchGoal();
  const budgeted = { ...fixture.goal, tokenBudget: 22 };
  fixture.branch.splice(
    0,
    fixture.branch.length,
    assistantUsageEntry({ totalTokens: 120 }),
    { type: "custom", customType: "goal-state", data: { goal: budgeted } },
    assistantUsageEntry({ totalTokens: 5 }),
  );
  await fixture.mock.events.get("session_tree")?.[0]?.({ oldLeafId: "old", newLeafId: "budget" }, fixture.ctx);
  assert.equal(requireLastGoal(fixture.mock).tokensUsed, 25);
  assert.equal(requireLastGoal(fixture.mock).status, "budget_limited");
});

test("tree restoration does not charge the replaced run's late response to its successor", async () => {
  const fixture = restoredBranchGoal();
  const successor = { ...createGoal("successor", 5, 120), usageBaselinePending: true };
  fixture.branch.splice(
    0,
    fixture.branch.length,
    assistantUsageEntry({ totalTokens: 120 }),
    { type: "custom", customType: "goal-state", data: { goal: successor } },
    assistantUsageEntry({ totalTokens: 12 }),
  );
  await fixture.mock.events.get("session_tree")?.[0]?.(
    { oldLeafId: "old", newLeafId: "late-old-response" },
    fixture.ctx,
  );
  assert.equal(requireLastGoal(fixture.mock).tokensUsed, 0);
  assert.equal(requireLastGoal(fixture.mock).status, "active");
  assert.equal(requireLastGoal(fixture.mock).baselineTokens, 132);
});

test("tree navigation restores the destination branch's own goal", async () => {
  const fixture = restoredBranchGoal();
  const destination = { ...createGoal("destination branch", undefined, 30), tokensUsed: 7 };
  fixture.branch.splice(0, fixture.branch.length, assistantUsageEntry({ totalTokens: 37 }), {
    type: "custom",
    customType: "goal-state",
    data: { goal: destination },
  });
  await fixture.mock.events.get("session_tree")?.[0]?.({ oldLeafId: "old", newLeafId: "new" }, fixture.ctx);
  assert.equal(requireLastGoal(fixture.mock).id, destination.id);
  assert.equal(requireLastGoal(fixture.mock).tokensUsed, 7);
});

test("tree navigation arms the destination branch's waiting deadline", async () => {
  vi.useFakeTimers();
  const fixture = restoredBranchGoal();
  const waiting = {
    ...createGoal("destination wait", undefined, 0),
    status: "paused" as const,
    activeStartedAt: undefined,
    wait: { reason: "review", resumeAt: Date.now() + 10_000 },
  };
  fixture.branch.splice(0, fixture.branch.length, {
    type: "custom",
    customType: "goal-state",
    data: { goal: waiting },
  });
  await fixture.mock.events.get("session_tree")?.[0]?.({ oldLeafId: "old", newLeafId: "wait" }, fixture.ctx);
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(requireLastGoal(fixture.mock).status, "active");
  assert.equal(fixture.mock.sentUserMessages.length, 1);
});

test("tree navigation starts a queued destination head after Pi becomes idle", async () => {
  vi.useFakeTimers();
  const path = settingsPath("tree-queued-enabled.json");
  writeFileSync(path, '{"toolVisibility":"always","experimental":{"goals":true}}\n');
  let navigating = false;
  const goal = createGoal("old head", undefined, 0);
  const fixture = restoreStoredGoalForTest(goal, [], "always", { isIdle: () => !navigating }, path);
  const branch = fixture.ctx.sessionManager.getBranch() as Array<Record<string, unknown>>;
  const queued = { ...createGoal("queued destination", undefined, 0), status: "queued" as const };
  branch.splice(0, branch.length, { type: "custom", customType: "goal-state", data: { goal: queued } });
  navigating = true;
  await fixture.mock.events.get("session_tree")?.[0]?.({ oldLeafId: "old", newLeafId: "queued" }, fixture.ctx);
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(fixture.mock.sentUserMessages.length, 0);
  navigating = false;
  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(requireLastGoal(fixture.mock).text, "queued destination");
  assert.equal(requireLastGoal(fixture.mock).status, "active");
  assert.equal(fixture.mock.sentUserMessages.length, 1);
});

test("activating a queued destination excludes work performed while it was queued", async () => {
  vi.useFakeTimers();
  const path = settingsPath("tree-queued-usage.json");
  writeFileSync(path, '{"toolVisibility":"always","experimental":{"goals":true}}\n');
  const fixture = restoreStoredGoalForTest(createGoal("source", undefined, 0), [], "always", {}, path);
  const branch = fixture.ctx.sessionManager.getBranch() as Array<Record<string, unknown>>;
  const queued = { ...createGoal("queued destination", 10, 0), status: "queued" as const, tokensUsed: 3 };
  branch.splice(
    0,
    branch.length,
    { type: "custom", customType: "goal-state", data: { goal: queued } },
    assistantUsageEntry({ totalTokens: 100 }),
  );
  await fixture.mock.events.get("session_tree")?.[0]?.({ oldLeafId: "source", newLeafId: "queued" }, fixture.ctx);
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(requireLastGoal(fixture.mock).tokensUsed, 3);
  assert.equal(requireLastGoal(fixture.mock).status, "active");
  assert.equal(fixture.mock.sentUserMessages.length, 1);
});

test("tree navigation dispatches a restored priority action after Pi becomes idle", async () => {
  vi.useFakeTimers();
  const path = settingsPath("tree-queue-enabled.json");
  writeFileSync(path, '{"toolVisibility":"always","experimental":{"goals":true}}\n');
  let navigating = false;
  const goal = createGoal("old head", undefined, 0);
  const fixture = restoreStoredGoalForTest(goal, [], "always", { isIdle: () => !navigating }, path);
  const branch = fixture.ctx.sessionManager.getBranch() as Array<Record<string, unknown>>;
  branch.splice(0, branch.length, {
    type: "custom",
    customType: "goal-state",
    data: { goal, pendingAction: { kind: "prioritize", objective: "urgent goal" } },
  });
  navigating = true;
  await fixture.mock.events.get("session_tree")?.[0]?.({ oldLeafId: "old", newLeafId: "priority" }, fixture.ctx);
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(requireLastGoal(fixture.mock).text, "old head");
  navigating = false;
  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(requireLastGoal(fixture.mock).text, "urgent goal");
  assert.equal(requireLastGoal(fixture.mock).status, "active");
});

test("leaving a queued branch cancels its deferred navigation work", async () => {
  vi.useFakeTimers();
  const path = settingsPath("tree-cancel-enabled.json");
  writeFileSync(path, '{"toolVisibility":"always","experimental":{"goals":true}}\n');
  const fixture = restoreStoredGoalForTest(createGoal("old head", undefined, 0), [], "always", {}, path);
  const branch = fixture.ctx.sessionManager.getBranch() as Array<Record<string, unknown>>;
  const queued = { ...createGoal("queued destination", undefined, 0), status: "queued" as const };
  branch.splice(0, branch.length, { type: "custom", customType: "goal-state", data: { goal: queued } });
  await fixture.mock.events.get("session_tree")?.[0]?.({ oldLeafId: "old", newLeafId: "queued" }, fixture.ctx);
  assert.equal(vi.getTimerCount(), 1);
  branch.splice(0);
  await fixture.mock.events.get("session_tree")?.[0]?.({ oldLeafId: "queued", newLeafId: "empty" }, fixture.ctx);
  assert.equal(vi.getTimerCount(), 0);
  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(fixture.mock.sentUserMessages.length, 0);
});

test("an old completion timer cannot clear a frozen destination status", async () => {
  vi.useFakeTimers();
  const fixture = restoredBranchGoal();
  const active = requireLastGoal(fixture.mock);
  await requireGoalTool(fixture.mock, "goal_complete").execute(
    "finish",
    { goal_id: active.id, summary: "The previous branch is complete." },
    undefined,
    undefined,
    fixture.ctx,
  );
  fixture.branch.splice(0, fixture.branch.length, {
    type: "custom",
    customType: "goal-state",
    data: {
      goal: { ...active, status: "paused" },
      queue: [{ ...createGoal("queued goal", undefined, 0), status: "queued" }],
    },
  });
  await fixture.mock.events.get("session_tree")?.[0]?.({ oldLeafId: "old", newLeafId: "frozen" }, fixture.ctx);
  assert.equal(fixture.statuses.get("goal"), "queue off");
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(fixture.statuses.get("goal"), "queue off");
});

test("budget enforcement does not strand a restored priority action", async () => {
  vi.useFakeTimers();
  const path = settingsPath("tree-budget-priority-enabled.json");
  writeFileSync(path, '{"toolVisibility":"always","experimental":{"goals":true}}\n');
  let navigating = false;
  const goal = { ...createGoal("budgeted head", 20, 0), tokensUsed: 10 };
  const fixture = restoreStoredGoalForTest(goal, [], "always", { isIdle: () => !navigating }, path);
  const branch = fixture.ctx.sessionManager.getBranch() as Array<Record<string, unknown>>;
  branch.splice(
    0,
    branch.length,
    assistantUsageEntry({ totalTokens: 10 }),
    {
      type: "custom",
      customType: "goal-state",
      data: { goal, pendingAction: { kind: "prioritize", objective: "urgent goal" } },
    },
    assistantUsageEntry({ totalTokens: 15 }),
  );
  navigating = true;
  await fixture.mock.events.get("session_tree")?.[0]?.({ oldLeafId: "old", newLeafId: "priority" }, fixture.ctx);
  assert.equal(requireLastGoal(fixture.mock).status, "budget_limited");
  navigating = false;
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(requireLastGoal(fixture.mock).text, "urgent goal");
  assert.equal(requireLastGoal(fixture.mock).status, "active");
});

test("tree navigation to a branch without a goal clears the active status", async () => {
  const fixture = restoredBranchGoal();
  fixture.branch.splice(0);
  await fixture.mock.events.get("session_tree")?.[0]?.({ oldLeafId: "old", newLeafId: "root" }, fixture.ctx);
  await fixture.mock.commands.get("goal")?.handler("status", fixture.ctx);
  assert.match(fixture.notifications.at(-1)?.message ?? "", /no goal is currently set/i);
  assert.equal(fixture.statuses.get("goal"), undefined);
});
