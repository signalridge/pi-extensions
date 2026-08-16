import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ModelRegistry } from "../src/model-resolver.js";
import type { AgentConfig } from "../src/types.js";
import { resolveWorkflowTier } from "../src/workflow-tiers.js";


const parent = {
  id: "parent",
  name: "Parent",
  provider: "test",
  reasoning: true,
} as unknown as Model<any>;
const fast = {
  id: "fast",
  name: "Fast",
  provider: "test",
  reasoning: true,
  thinkingLevelMap: { high: null, xhigh: null, max: null },
} as unknown as Model<any>;
const registryModels = [parent, fast];
const registry: ModelRegistry<Model<any>> = {
  find: (provider, id) => registryModels.find((model) => model.provider === provider && model.id === id),
  getAll: () => registryModels,
  getAvailable: () => registryModels,
};

function config(fields: Partial<AgentConfig>): AgentConfig {
  return {
    name: "worker",
    description: "worker",
    ...fields,
  };
}

describe("workflow tier resolution", () => {
  it("uses the default tier profile and records an audit snapshot", () => {
    const result = resolveWorkflowTier({
      tier: "medium",
      parentModel: parent,
      parentThinking: "low",
      modelRegistry: registry,
    });

    expect(result.model).toBe(parent);
    expect(result.thinkingLevel).toBe("medium");
    expect(result.snapshot).toMatchObject({
      tier: "medium",
      model: "test/parent",
      thinking: "medium",
      modelSource: "parent",
      thinkingSource: "tier",
    });
  });

  it("lets frontmatter fill precedence independently for model and thinking", () => {
    const result = resolveWorkflowTier({
      tier: "large",
      agentConfig: config({ model: "test/fast", thinking: "low" }),
      parentModel: parent,
      parentThinking: "medium",
      modelRegistry: registry,
    });

    expect(result.model).toBe(fast);
    expect(result.thinkingLevel).toBe("low");
    expect(result.snapshot).toMatchObject({
      modelSource: "frontmatter",
      thinkingSource: "frontmatter",
      configuredModel: "test/fast",
      configuredThinking: "low",
    });
  });

  it("clamps thinking to the selected model capabilities", () => {
    const result = resolveWorkflowTier({
      tier: "large",
      agentConfig: config({ model: "test/fast" }),
      parentModel: parent,
      modelRegistry: registry,
    });

    expect(result.thinkingLevel).toBe("medium");
    expect(result.snapshot).toMatchObject({
      thinking: "medium",
      requestedThinking: "high",
      clamped: true,
    });
  });

  it("inherits the parent Thinking level when a tier says inherit", () => {
    const result = resolveWorkflowTier({
      tier: "small",
      settings: { tiers: { small: { model: "inherit", thinking: "inherit" } } },
      parentModel: parent,
      parentThinking: "high",
      modelRegistry: registry,
    });

    expect(result.thinkingLevel).toBe("high");
    expect(result.snapshot).toMatchObject({
      configuredThinking: "inherit",
      requestedThinking: "high",
      thinkingSource: "parent",
    });
  });

  it("fails closed when the configured default tier is malformed", () => {
    expect(() =>
      resolveWorkflowTier({
        settings: { blockedDefaultTier: true },
        parentModel: parent,
        modelRegistry: registry,
      }),
    ).toThrow(/workflow defaultTier is blocked by malformed configuration/);
  });

  it("fails closed when a configured tier model is unavailable", () => {
    expect(() =>
      resolveWorkflowTier({
        tier: "small",
        settings: { tiers: { small: { model: "test/missing", thinking: "low" } } },
        parentModel: parent,
        modelRegistry: registry,
      }),
    ).toThrow(/workflow tier "small" has an unavailable model/);
  });
});
