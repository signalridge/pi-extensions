import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { completeGoalArguments, parseCommand } from "./command.js";
import type { GoalCommandController } from "./commands.js";
import { notifyTerminal, safeTerminalText } from "./errors.js";
import type { GoalRuntime } from "./runtime.js";

type GoalManagerModule = Pick<typeof import("./menu.js"), "showGoalManager">;
type GoalSettingsModule = Pick<typeof import("./settings-ui.js"), "showGoalSettings">;

export interface GoalCommandRegistrationOptions {
  settingsPath?: string;
  loadGoalManager?: () => Promise<GoalManagerModule>;
  loadGoalSettings?: () => Promise<GoalSettingsModule>;
}

export function registerGoalCommand(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  commands: GoalCommandController,
  options: GoalCommandRegistrationOptions = {},
) {
  const loadGoalManager = cachedModuleLoader(options.loadGoalManager ?? (() => import("./menu.js")));
  const loadGoalSettings = cachedModuleLoader(options.loadGoalSettings ?? (() => import("./settings-ui.js")));

  pi.registerCommand("goal", {
    description: "Run a goal to completion: /goal [--tokens 100k] <goal_to_complete>",
    getArgumentCompletions: (prefix) =>
      completeGoalArguments(prefix, {
        experimentalGoals: runtime.settings.experimental.goals,
      }),
    handler: async (args, ctx) => {
      const result = parseCommand(args, {
        experimentalGoals: runtime.settings.experimental.goals,
      });
      if (typeof result === "string") {
        reportCommandError(result, ctx);
        return;
      }
      if (result.kind === "show" && args.trim() === "") {
        const menuIsCurrent = captureMenuOwnership(runtime);
        let managerModule: GoalManagerModule;
        try {
          managerModule = await loadGoalManager();
        } catch (error) {
          if (!menuIsCurrent()) return;
          throw error;
        }
        if (!menuIsCurrent()) return;
        const { showGoalManager } = managerModule;
        await showGoalManager(runtime, commands, ctx, async (menuCtx, target) => {
          const settingsAreCurrent = captureMenuOwnership(runtime);
          let settingsModule: GoalSettingsModule;
          try {
            settingsModule = await loadGoalSettings();
          } catch (error) {
            if (!settingsAreCurrent()) return;
            throw error;
          }
          if (!settingsAreCurrent()) return;
          const { showGoalSettings } = settingsModule;
          await showGoalSettings(runtime, menuCtx, {
            settingsPath: options.settingsPath,
            initialScreen: target,
            onQueueUnfrozen: async (settingsCtx) => {
              await commands.resumeQueueAfterUnfreeze(settingsCtx);
            },
          });
        });
        return;
      }
      if (runtime.queueFrozen) {
        if (result.kind === "show") commands.showGoal(ctx);
        else if (result.kind === "clear") commands.clearGoal(ctx);
        else commands.notifyFrozenQueue(ctx);
        return;
      }
      if (runtime.pendingQueueAction && result.kind !== "show" && result.kind !== "clear") {
        notifyTerminal(ctx.ui, "A queued goal change is waiting for Pi to settle. Retry after it finishes.", "warning");
        return;
      }

      switch (result.kind) {
        case "show":
          commands.showGoal(ctx);
          return;
        case "pause":
          commands.pauseGoal(ctx);
          return;
        case "resume":
          await commands.resumeGoal(ctx);
          return;
        case "clear":
          commands.clearGoal(ctx);
          return;
        case "edit":
          await commands.editGoal(result.objective ?? "", result.tokenBudget, ctx);
          return;
        case "add":
          await commands.addGoal(result.objective ?? "", result.tokenBudget, ctx);
          return;
        case "prioritize":
          await commands.prioritizeGoal(result.objective ?? "", result.tokenBudget, ctx);
          return;
        case "drop-last":
          commands.dropLastGoal(ctx);
          return;
        case "skip":
          await commands.skipGoal(ctx);
          return;
        case "start":
          await commands.startGoal(result.objective ?? "", result.tokenBudget, ctx);
          return;
      }
    },
  });
}

function reportCommandError(message: string, ctx: ExtensionCommandContext) {
  const safeMessage = safeTerminalText(message);
  if (ctx.mode === "print" || ctx.mode === "json") throw new Error(safeMessage);
  notifyTerminal(ctx.ui, safeMessage, "warning");
}

function captureMenuOwnership(runtime: GoalRuntime): () => boolean {
  const generation = runtime.menuGeneration;
  const controller = runtime.menuController;
  return () =>
    runtime.menuGeneration === generation && runtime.menuController === controller && !controller.signal.aborted;
}

function cachedModuleLoader<Module>(load: () => Promise<Module>): () => Promise<Module> {
  let pending: Promise<Module> | undefined;
  return () => {
    if (!pending) {
      pending = load().catch((error) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };
}
