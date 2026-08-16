import assert from "node:assert/strict";
import { test } from "vitest";
import { GoalToolPolicy } from "../src/tool-policy.js";
import { createMockContext, createMockPi } from "./support.js";

test("tool policy hides and restores only Goal tools it owns", () => {
  const mock = createMockPi({ activeTools: ["read", "goal_complete", "goal_blocked"] });
  const policy = new GoalToolPolicy(mock.pi);

  policy.hideIfLocked();
  assert.deepEqual(mock.rawPi.getActiveTools(), ["read"]);
  mock.rawPi.setActiveTools(["read", "external"]);
  policy.restoreHidden();

  assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "external", "goal_complete", "goal_blocked"]);
  assert.equal(policy.hasHiddenTools(), false);
});

test("tool policy activation rollback restores exact external active-tool state", () => {
  const mock = createMockPi({ activeTools: ["read"] });
  const policy = new GoalToolPolicy(mock.pi);
  const before = policy.snapshot();
  const context = createMockContext({ isIdle: () => true });

  policy.prepareActivation("after-first-goal", context.ctx);
  assert.equal(policy.toolsAvailable(), true);
  policy.restore(before);

  assert.deepEqual(mock.rawPi.getActiveTools(), ["read"]);
  assert.equal(policy.isUnlocked(), false);
});

test("tool policy refuses to widen a busy lazy activation", () => {
  const mock = createMockPi({ activeTools: ["read"] });
  const policy = new GoalToolPolicy(mock.pi);
  const context = createMockContext({ isIdle: () => false });

  assert.throws(() => policy.prepareActivation("after-first-goal", context.ctx), /wait until Pi is idle/i);
  assert.deepEqual(mock.rawPi.getActiveTools(), ["read"]);
});
