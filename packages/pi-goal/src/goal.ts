import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGoalCommand } from "./command-registration.js";
import { GoalCommandController } from "./commands.js";
import { registerGoalLifecycle } from "./lifecycle.js";
import { GoalRunController } from "./run-protocol.js";
import { GoalRuntime } from "./runtime.js";
import { registerGoalTools } from "./tools.js";

interface GoalOptions {
  settingsPath?: string;
}

function registerGoalRuntime(pi: ExtensionAPI, options: GoalOptions = {}) {
  const runtime = new GoalRuntime(pi);
  const commands = new GoalCommandController(runtime);
  const runController = new GoalRunController(runtime, commands);

  // A `goal_wait` deadline resumes through the SAME path as `/goal resume`:
  // tool-policy preparation, recovery clearing and prompt delivery all have to
  // happen, and a shortcut would be a second, worse resume path drifting from
  // the real one. Wired here because the controller owns it and the runtime,
  // which arms the timer, deliberately does not depend on the controller.
  runtime.onGoalWaitElapsed = (ctx) => {
    void commands.resumeGoal(ctx);
  };

  // Keep registration order explicit: managed-run bus listeners exist before tools,
  // command routing, and session lifecycle bind the per-factory runtime.
  runController.register(pi);
  registerGoalTools(pi, runtime);
  registerGoalCommand(pi, runtime, commands, options);
  registerGoalLifecycle(pi, runtime, commands, runController, options);
}

export default function goal(pi: ExtensionAPI, options: GoalOptions = {}) {
  registerGoalRuntime(pi, options);
}

export {
  assistantUsageTokens,
  cumulativeAssistantTokens,
  formatDuration,
  formatTokenCount,
} from "./accounting.js";

export {
  completeGoalArguments,
  parseCommand,
  parseTokenBudget,
  validateObjective,
} from "./command.js";

export { buildGoalSystemPrompt } from "./prompts.js";

export {
  findFinalAssistantMessage,
  formatStatus,
  isContradictoryCompletionSummary,
  isRetryableGoalInterruption,
  isUsageLimitedGoalInterruption,
} from "./runtime.js";
