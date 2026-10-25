import assert from "node:assert/strict";
import { test } from "vitest";
import { GOAL_SAFETY_PAUSE_CONTEXT_TYPE } from "../src/prompts.js";
import { createGoal, GoalRuntime } from "../src/runtime.js";
import { registerGoalTools } from "../src/tools.js";
import {
  pickSafetyState,
  requireGoalTool,
  requireLastGoal,
  restoreGoalForTest,
  startGoalForTest,
} from "./support/goal-fixture.js";
import { createMockContext, createMockPi } from "./support.js";

const response = { role: "assistant", stopReason: "stop", content: [] };
const limitMessage = /Goal paused: continuation_limit \(25\/25\)\. Explicit resume required: run \/goal resume\./;
type ContextResult = { messages: Array<{ role: string; customType?: string; content?: unknown }> } | undefined;

async function reachLimit() {
  const f = await startGoalForTest();
  const fire = (name: string, event: unknown) => f.mock.events.get(name)?.[0]?.(event, f.ctx);
  fire("before_agent_start", { prompt: f.mock.sentUserMessages.at(-1)?.text, systemPrompt: "base" });
  await fire("agent_end", { messages: [response] });
  await fire("agent_settled", {});
  fire("before_agent_start", { prompt: f.mock.sentUserMessages.at(-1)?.text, systemPrompt: "base" });
  for (let turn = 0; turn < 25; turn++) fire("turn_end", { message: response, toolResults: [] });
  assert.equal(requireLastGoal(f.mock).status, "paused");
  return { ...f, fire };
}

for (const delivery of ["queued-custom", "queued-user", "direct-extension", "real-input"] as const) {
  test(`safety pause remains authoritative through ${delivery} notification handling until explicit resume`, async () => {
    const f = await reachLimit();
    const stopped = requireLastGoal(f.mock);
    const safety = pickSafetyState(stopped);
    const callsBeforeNotice = f.mock.sentUserMessages.length;
    const notice = { role: "custom", customType: "background-complete", content: "Background job finished" };
    if (delivery === "queued-custom") {
      // A queued custom message can start without before_agent_start or input.
      f.fire("agent_start", {});
      f.fire("message_start", { message: notice });
    } else {
      f.fire("input", {
        source: delivery === "real-input" ? "interactive" : "extension",
        text: "Background job finished",
        ...(delivery === "queued-user" ? { streamingBehavior: "followUp" } : {}),
      });
      if (delivery !== "queued-user") {
        f.fire("before_agent_start", { prompt: "Background job finished", systemPrompt: "base" });
      }
      f.fire("message_start", { message: { role: "user", content: "Background job finished" } });
    }
    const entriesBeforeContext = f.mock.entries.length;
    const context = f.fire("context", { messages: [notice] }) as ContextResult;
    assert.equal(context?.messages.length, 2);
    const snapshot = context?.messages.at(-1);
    assert.equal(snapshot?.customType, GOAL_SAFETY_PAUSE_CONTEXT_TYPE);
    assert.match(String(snapshot?.content), limitMessage);
    assert.match(String(snapshot?.content), /not Goal automatic execution/);
    assert.match(String(snapshot?.content), /Do not claim the Goal is running/);
    assert.match(String(snapshot?.content), /supersedes earlier active Goal instructions/);
    const nextContext = f.fire("context", { messages: context?.messages }) as ContextResult;
    assert.equal(nextContext?.messages.length, 2, "request snapshots must not accumulate");
    assert.equal(f.mock.entries.length, entriesBeforeContext, "context notices must not persist");

    // All terminal tools must diagnose the stopped state before run ownership,
    // even when the notification model reuses an older ID.
    for (const name of ["goal_complete", "goal_blocked", "goal_wait"]) {
      const result = await requireGoalTool(f.mock, name).execute(
        `notice-${name}`,
        { goal_id: "stale-id", summary: "Verified", reason: "Wait for review", evidence: "Denied", repeated_turns: 3 },
        undefined,
        undefined,
        f.ctx,
      );
      assert.match(result.content?.[0]?.text ?? "", limitMessage);
      assert.doesNotMatch(result.content?.[0]?.text ?? "", /does not own/);
      assert.equal(result.terminate, undefined);
    }
    f.fire("turn_end", { message: response, toolResults: [] });
    await f.fire("agent_end", { messages: [response] });
    await f.fire("agent_settled", {});
    assert.equal(requireLastGoal(f.mock).status, "paused");
    assert.equal(requireLastGoal(f.mock).id, stopped.id);
    assert.deepEqual(pickSafetyState(requireLastGoal(f.mock)), safety);
    assert.equal(f.mock.sentUserMessages.length, callsBeforeNotice);

    await f.mock.commands.get("goal")?.handler("resume", f.ctx);
    const resumed = requireLastGoal(f.mock);
    assert.equal(resumed.status, "active");
    assert.notEqual(resumed.id, stopped.id);
    assert.equal(f.mock.sentUserMessages.length, callsBeforeNotice + 1);
    f.fire("before_agent_start", { prompt: f.mock.sentUserMessages.at(-1)?.text, systemPrompt: "base" });
    assert.equal(requireLastGoal(f.mock).automaticModelTurns, 0);
    assert.equal(requireLastGoal(f.mock).safetyPauseCause, undefined);
    const resumedContext = f.fire("context", { messages: context?.messages }) as ContextResult;
    assert.equal(
      resumedContext?.messages.some((m) => m.customType === GOAL_SAFETY_PAUSE_CONTEXT_TYPE),
      false,
    );
    const stale = await requireGoalTool(f.mock, "goal_wait").execute(
      "stale-after-resume",
      { goal_id: stopped.id, reason: "review" },
      undefined,
      undefined,
      f.ctx,
    );
    assert.match(stale.content?.[0]?.text ?? "", /goal_id does not match/);
    await f.fire("agent_end", { messages: [response] });
    await f.fire("agent_settled", {});
    await f.fire("agent_settled", {});
    assert.equal(f.mock.sentUserMessages.length, callsBeforeNotice + 2, "resume produces exactly one continuation");
    assert.match(f.mock.sentUserMessages.at(-1)?.text ?? "", /pi-goal-continuation:/);
    assert.equal(requireLastGoal(f.mock).id, resumed.id);
  });
}

test("stale-call blocking keeps its abort guard and explains the safety pause", async () => {
  let aborts = 0;
  const f = await startGoalForTest({ abort: () => aborts++ });
  const fire = (name: string, event: unknown) => f.mock.events.get(name)?.[0]?.(event, f.ctx);
  await fire("agent_end", { messages: [response] });
  await fire("agent_settled", {});
  fire("before_agent_start", { prompt: f.mock.sentUserMessages.at(-1)?.text, systemPrompt: "base" });
  for (let turn = 0; turn < 25; turn++) fire("turn_end", { message: response, toolResults: [] });
  const before = aborts;
  const blocked = fire("tool_call", { toolName: "goal_wait", toolCallId: "stale", input: {} }) as {
    block: boolean;
    reason: string;
  };
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, limitMessage);
  assert.equal(aborts, before + 1);
});

test("active terminal tools still reject a run without Goal ownership", async () => {
  const mock = createMockPi();
  const runtime = new GoalRuntime(mock.pi);
  const { ctx } = createMockContext();
  runtime.activeGoal = createGoal("finish", undefined, 0);
  runtime.beginAgentRun(null, undefined);
  registerGoalTools(mock.pi, runtime);
  const before = structuredClone(runtime.activeGoal);
  for (const name of ["goal_complete", "goal_blocked", "goal_wait"]) {
    const result = await requireGoalTool(mock, name).execute(
      `unowned-${name}`,
      { goal_id: before.id, summary: "Verified", reason: "review", evidence: "denied", repeated_turns: 3 },
      undefined,
      undefined,
      ctx,
    );
    assert.match(result.content?.[0]?.text ?? "", /current run does not own the active goal/);
    assert.deepEqual(runtime.activeGoal, before);
    assert.equal(result.terminate, undefined);
  }
});

test("no-progress pauses report the repeat threshold rather than ownership", async () => {
  const f = restoreGoalForTest("paused", { toolFreeRepeatCount: 3, safetyPauseCause: "no_progress" });
  f.mock.events.get("message_start")?.[0]?.(
    { message: { role: "custom", customType: "background-complete", content: "done" } },
    f.ctx,
  );
  const result = await requireGoalTool(f.mock, "goal_wait").execute(
    "wait-after-no-progress",
    { goal_id: f.sessionGoal.id, reason: "review" },
    undefined,
    undefined,
    f.ctx,
  );
  assert.match(result.content?.[0]?.text ?? "", /Goal paused: no_progress \(3\/3\)\. Explicit resume required/);
  const context = f.mock.events.get("context")?.[0]?.({ messages: [] }, f.ctx) as ContextResult;
  assert.match(String(context?.messages.at(-1)?.content), /no_progress \(3\/3\)/);
});
