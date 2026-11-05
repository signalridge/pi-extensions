// Compile-only consumer contract for the published source deep import.
import { buildNewAgentFile, type NewAgentInput } from "@signalridge/pi-subagents/src/agent-file-toggle.ts";

export function subagentInputCompatibilityFixture(): string[] {
  const explicitInput: NewAgentInput = {
    description: "Typed legacy consumer",
    tools: "read",
    model: "synthetic-model",
    thinking: "off",
    systemPrompt: "Prompt",
  };
  class LegacyPrototypeInput {
    description = "Prototype legacy consumer";
    tools = "read";
    systemPrompt = "Prompt";
    get model(): string {
      return "synthetic-model";
    }
    get thinking(): string {
      return "off";
    }
  }
  const inheritedInput: NewAgentInput = new LegacyPrototypeInput();
  const model: string | undefined = explicitInput.model;
  const thinking: string | undefined = explicitInput.thinking;
  void [model, thinking];

  return [
    buildNewAgentFile({
      description: "Fresh model literal",
      tools: "read",
      model: "synthetic-model",
      systemPrompt: "Prompt",
    }),
    buildNewAgentFile({
      description: "Fresh thinking literal",
      tools: "read",
      thinking: "off",
      systemPrompt: "Prompt",
    }),
    buildNewAgentFile(explicitInput),
    buildNewAgentFile(inheritedInput),
    buildNewAgentFile({
      description: "Current tier consumer",
      tools: "read",
      tier: "review",
      systemPrompt: "Prompt",
    }),
  ];
}
