import assert from "node:assert/strict";
import { test } from "vitest";
import {
  configuredImplementationModel,
  configuredImplementationThinkingLevel,
  normalizePlanModeSettings,
  parseModelReference,
} from "../src/settings.js";
import { restorePlanModeState } from "../src/state.js";

test("implementation model settings accept provider/model-id and reject the whole file otherwise", () => {
  assert.deepEqual(parseModelReference(" openrouter/anthropic/claude-sonnet "), {
    provider: "openrouter",
    id: "anthropic/claude-sonnet",
  });
  const settings = normalizePlanModeSettings({
    implementationModel: "openai/gpt-5-mini",
    implementationThinkingLevel: "low",
  });
  assert.deepEqual(settings, {
    thinkingLevel: "inherit",
    implementationModel: "openai/gpt-5-mini",
    implementationThinkingLevel: "low",
  });
  assert.ok(settings);
  assert.deepEqual(configuredImplementationModel(settings), {
    provider: "openai",
    id: "gpt-5-mini",
  });
  assert.equal(configuredImplementationThinkingLevel(settings), "low");
  assert.equal(configuredImplementationThinkingLevel({ thinkingLevel: "high" }), undefined);
  assert.equal(
    configuredImplementationThinkingLevel({
      thinkingLevel: "high",
      implementationThinkingLevel: "inherit",
    }),
    undefined,
  );

  for (const implementationModel of ["gpt-5-mini", "/gpt", "openai/", "open ai/gpt", "openai/gpt\u0007", 42, ""]) {
    assert.equal(normalizePlanModeSettings({ implementationModel }), undefined, String(implementationModel));
  }
  assert.equal(normalizePlanModeSettings({ implementationThinkingLevel: "extreme" }), undefined);
});

test("a persisted model handoff is restored only outside Plan mode and only with complete pairs", () => {
  const restore = (enabled: boolean, modelHandoff: unknown) =>
    restorePlanModeState(
      [
        {
          type: "custom",
          customType: "plan-mode-state",
          data: { enabled, awaitingAction: false, modelHandoff },
        },
      ],
      "plan-mode-state",
    ).modelHandoff;
  const handoff = {
    appliedModel: { provider: "p", id: "builder" },
    previousModel: { provider: "p", id: "planner" },
    previousThinkingLevel: "high",
    appliedThinkingLevel: "low",
  };
  assert.deepEqual(restore(false, handoff), handoff);
  assert.equal(restore(true, handoff), undefined);
  assert.deepEqual(restore(false, { ...handoff, appliedThinkingLevel: "loud" }), {
    appliedModel: handoff.appliedModel,
    previousModel: handoff.previousModel,
  });
  // A previous model without the model it replaced cannot be restored safely.
  assert.deepEqual(
    restore(false, {
      previousModel: handoff.previousModel,
      appliedThinkingLevel: "low",
      previousThinkingLevel: "high",
    }),
    {
      appliedThinkingLevel: "low",
      previousThinkingLevel: "high",
    },
  );
  assert.equal(restore(false, { appliedModel: { provider: "", id: "x" } }), undefined);
  assert.equal(restore(false, "builder"), undefined);
});
