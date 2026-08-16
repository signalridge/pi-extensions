import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GoalToolVisibility } from "./settings.js";

export const GOAL_COMPLETE_TOOL = "goal_complete";
export const GOAL_BLOCKED_TOOL = "goal_blocked";
export const GOAL_TOOL_NAMES = [GOAL_COMPLETE_TOOL, GOAL_BLOCKED_TOOL] as const;

export interface GoalToolVisibilitySnapshot {
  activeTools: string[];
  goalToolsUnlocked: boolean;
  goalToolsHiddenByPolicy: string[];
}

interface ToolPolicyContext {
  isIdle?: () => boolean;
}

export class GoalToolPolicy {
  private unlocked = false;
  private readonly hiddenByPolicy = new Set<string>();
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  isUnlocked() {
    return this.unlocked;
  }

  hasHiddenTools() {
    return this.hiddenByPolicy.size > 0;
  }

  isGoalToolName(name: string) {
    return (GOAL_TOOL_NAMES as readonly string[]).includes(name);
  }

  toolsAvailable() {
    const active = new Set(this.pi.getActiveTools());
    return GOAL_TOOL_NAMES.every((name) => active.has(name));
  }

  lock() {
    this.unlocked = false;
  }

  unlock() {
    this.unlocked = true;
  }

  unlockAndForgetHidden() {
    this.unlocked = true;
    this.hiddenByPolicy.clear();
  }

  hideIfLocked() {
    if (this.unlocked) return;
    const active = this.pi.getActiveTools();
    const hidden = active.filter((name) => this.isGoalToolName(name));
    if (hidden.length === 0) return;
    this.pi.setActiveTools(active.filter((name) => !this.isGoalToolName(name)));
    for (const name of hidden) this.hiddenByPolicy.add(name);
  }

  restoreHidden() {
    const activeBeforeRestore = this.pi.getActiveTools();
    const activeSet = new Set(activeBeforeRestore);
    const missingOwnedTools = [...this.hiddenByPolicy].filter((name) => !activeSet.has(name));
    if (missingOwnedTools.length === 0) {
      this.hiddenByPolicy.clear();
      return;
    }
    try {
      this.pi.setActiveTools([...activeBeforeRestore, ...missingOwnedTools]);
      const restored = new Set(this.pi.getActiveTools());
      if (missingOwnedTools.some((name) => !restored.has(name))) {
        throw new Error("the active tool policy rejected a previously hidden goal tool");
      }
      this.hiddenByPolicy.clear();
    } catch (error) {
      this.pi.setActiveTools(activeBeforeRestore);
      throw error;
    }
  }

  prepareActivation(visibility: GoalToolVisibility, ctx: ToolPolicyContext) {
    if (visibility === "after-first-goal") {
      if (!this.toolsAvailable() && ctx.isIdle?.() !== true) {
        throw new Error("wait until Pi is idle before revealing the goal tools");
      }
      this.reveal();
      return;
    }
    this.assertAvailable();
  }

  prepareSessionStart(visibility: GoalToolVisibility, previous: GoalToolVisibility) {
    if (visibility === "after-first-goal" && previous === "always") this.lock();
    if (visibility !== "always") return;
    try {
      if (this.hasHiddenTools()) this.restoreHidden();
    } finally {
      // Always mode remains unlocked even when an external restrictive policy
      // prevents restoration; retained ownership lets a later session retry.
      this.unlock();
    }
  }

  reconcileRestoredState(visibility: GoalToolVisibility, hasUnfinishedGoal: boolean) {
    if (visibility !== "after-first-goal") return;
    if (hasUnfinishedGoal) this.unlockAndForgetHidden();
    else if (!this.unlocked) this.hideIfLocked();
  }

  applyVisibilityChange(
    previous: GoalToolVisibility,
    next: GoalToolVisibility,
    hasUnfinishedGoal: boolean,
    ctx: ToolPolicyContext,
  ) {
    if (previous === next) return;
    if (next === "always") {
      if (this.hasHiddenTools() && ctx.isIdle?.() !== true) {
        throw new Error("Wait for Pi to become idle before revealing Goal tools.");
      }
      this.restoreHidden();
      this.unlock();
      return;
    }
    if (hasUnfinishedGoal) {
      this.unlockAndForgetHidden();
      return;
    }
    if (ctx.isIdle?.() !== true) {
      throw new Error("Wait for Pi to become idle before hiding Goal tools.");
    }
    this.lock();
    this.hideIfLocked();
  }

  snapshot(): GoalToolVisibilitySnapshot {
    return {
      activeTools: this.pi.getActiveTools(),
      goalToolsUnlocked: this.unlocked,
      goalToolsHiddenByPolicy: [...this.hiddenByPolicy],
    };
  }

  restore(snapshot: GoalToolVisibilitySnapshot) {
    this.pi.setActiveTools(snapshot.activeTools);
    this.unlocked = snapshot.goalToolsUnlocked;
    this.hiddenByPolicy.clear();
    for (const name of snapshot.goalToolsHiddenByPolicy) this.hiddenByPolicy.add(name);
  }

  private reveal() {
    const snapshot = this.snapshot();
    try {
      const active = this.pi.getActiveTools();
      const activeSet = new Set(active);
      const missing = GOAL_TOOL_NAMES.filter((name) => !activeSet.has(name));
      if (missing.length > 0) this.pi.setActiveTools([...active, ...missing]);
      this.assertAvailable();
      this.unlockAndForgetHidden();
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  private assertAvailable() {
    if (this.toolsAvailable()) return;
    throw new Error(
      "goal_complete and goal_blocked are unavailable; include them in the active tool allowlist or leave the restrictive tool mode first.",
    );
  }
}
