import { expect, test } from "vitest";
import { requireLastGoal, startGoalForTest } from "./support/goal-fixture.js";

test("in-run compaction leaves iteration and continuation numbering to agent_end", async () => {
  let idle = true;
  const { mock, ctx } = await startGoalForTest({ isIdle: () => idle });
  for (let iteration = 1; iteration <= 2; iteration++) {
    const prompt = mock.sentUserMessages.at(-1)?.text ?? "";
    idle = false;
    await mock.events.get("before_agent_start")?.[0]?.({ prompt, systemPrompt: "base" }, ctx);
    await mock.events.get("agent_start")?.[0]?.({}, ctx);
    const assistant = { role: "assistant", stopReason: "toolUse", content: [] };
    await mock.events.get("turn_end")?.[0]?.({ message: assistant }, ctx);
    await mock.events.get("tool_execution_end")?.[0]?.({}, ctx);
    await mock.events.get("session_before_compact")?.[0]?.({ reason: "threshold", willRetry: false }, ctx);
    await mock.events.get("session_compact")?.[0]?.({ reason: "threshold", willRetry: false }, ctx);
    expect(requireLastGoal(mock).iteration).toBe(iteration - 1);
    expect(mock.sentUserMessages).toHaveLength(iteration);
    const final = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `progress ${iteration}` }] };
    await mock.events.get("turn_end")?.[0]?.({ message: final }, ctx);
    await mock.events.get("agent_end")?.[0]?.({ messages: [assistant, final] }, ctx);
    expect(requireLastGoal(mock).iteration).toBe(iteration);
    // Response accounting is per turn, not per compaction or low-level run.
    expect(requireLastGoal(mock).automaticModelTurns).toBe(iteration === 1 ? 0 : 2);
    idle = true;
    await mock.events.get("agent_settled")?.[0]?.({}, ctx);
    expect(mock.sentUserMessages).toHaveLength(iteration + 1);
    expect(mock.sentUserMessages.at(-1)?.text).toContain(`automatic continuation #${iteration}.`);
  }
  await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
});
