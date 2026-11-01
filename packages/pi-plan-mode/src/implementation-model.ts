import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  configuredImplementationModel,
  configuredImplementationThinkingLevel,
  type PlanModeFixedThinkingLevel,
  type PlanModeModelReference,
  type PlanModeSettings,
} from "./settings.js";

type SessionModel = NonNullable<ExtensionContext["model"]>;

/** What an implementation handoff changed, so ending it can undo exactly that. */
export interface ImplementationModelHandoff {
  previousModel?: PlanModeModelReference;
  appliedModel?: PlanModeModelReference;
  previousThinkingLevel?: PlanModeFixedThinkingLevel;
  appliedThinkingLevel?: PlanModeFixedThinkingLevel;
}

export type ImplementationModelTarget =
  | { kind: "none" }
  | {
      kind: "target";
      model?: SessionModel;
      thinkingLevel?: PlanModeFixedThinkingLevel;
    }
  | { kind: "unavailable"; message: string };

export type ImplementationModelSwitch =
  | { kind: "applied"; handoff?: ImplementationModelHandoff; warning?: string }
  | { kind: "failed"; message: string }
  | { kind: "obsolete" };

export type PlanningModelRestore =
  | { kind: "restored"; message?: string; warning?: string }
  | { kind: "kept" }
  | { kind: "obsolete" }
  | { kind: "unavailable"; message: string };

interface ImplementationModelDependencies {
  pi: Pick<ExtensionAPI, "setModel" | "getThinkingLevel">;
  /** The package's owned thinking setter, so its own change is not taken for a manual one. */
  setThinkingLevel(level: PlanModeFixedThinkingLevel): void;
}

/**
 * Callers keep the persisted handoff absent while a switch is in flight, so the
 * pending selection lease tracks its expected model and subsequent selections,
 * including choosing away and back. Unattributed thinking changes before model
 * observation are ambiguous, never assumed to be automatic or extension-owned.
 */
export function createImplementationModelCoordinator({ pi, setThinkingLevel }: ImplementationModelDependencies) {
  function thinkingLevel() {
    return pi.getThinkingLevel() as PlanModeFixedThinkingLevel;
  }

  let selection:
    | {
        model?: PlanModeModelReference;
        observed: boolean;
        ambiguousThinking: boolean;
        invalid: boolean;
        audit(): void;
        ownedThinkingEntries: Set<string>;
      }
    | undefined;

  function setOwnedThinking(ctx: ExtensionContext, level: PlanModeFixedThinkingLevel) {
    const pending = selection;
    const before = ctx.sessionManager.getBranch().length;
    setThinkingLevel(level);
    // The setter appends its own entry before dispatching callbacks. Exclude
    // only that first entry, not any nested changes another handler may make.
    const ownEntry = ctx.sessionManager
      .getBranch()
      .slice(before)
      .find((entry) => entry.type === "thinking_level_change");
    if (ownEntry) pending?.ownedThinkingEntries.add(ownEntry.id);
  }

  return {
    /** The caller retains this lease through awaits AND final handoff publication. */
    captureSelection(ctx: ExtensionContext, target: PlanModeModelReference | undefined) {
      const original = ctx.model ? modelReference(ctx.model) : undefined;
      const branch = ctx.sessionManager.getBranch().map((entry) => entry.id);
      let scanned = branch.length;
      let modelChangeSeen = false;
      const owned = {
        model: target ?? original,
        observed: !target || Boolean(original && sameModel(original, target)),
        ambiguousThinking: false,
        invalid: false,
        ownedThinkingEntries: new Set<string>(),
        audit() {
          const live = ctx.sessionManager.getBranch();
          if (!branch.every((id, index) => live[index]?.id === id) || live.length < scanned) {
            owned.invalid = true;
            return;
          }
          for (const entry of live.slice(scanned)) {
            branch.push(entry.id);
            if (entry.type === "model_change") {
              if (!target || modelChangeSeen || !sameModel({ provider: entry.provider, id: entry.modelId }, target)) {
                owned.invalid = true;
              }
              modelChangeSeen = true;
            } else if (entry.type === "thinking_level_change" && !owned.ownedThinkingEntries.has(entry.id)) {
              if (owned.observed) owned.invalid = true;
              else owned.ambiguousThinking = true;
            }
          }
          scanned = live.length;
        },
      };
      selection = owned;
      return {
        isCurrent: () => {
          if (selection !== owned) return false;
          try {
            owned.audit();
            if (owned.invalid) return false;
            const expected = owned.observed ? owned.model : original;
            return expected ? Boolean(ctx.model && sameModel(ctx.model, expected)) : ctx.model === undefined;
          } catch {
            return false;
          }
        },
        release: () => {
          if (selection === owned) selection = undefined;
        },
      };
    },
    // Pi appends model-default thinking before model_select, but the public
    // thinking event has no source and either dispatch can be delayed by other
    // handlers. Audit native entries before observing the expected model: even
    // a genuine default transition is ambiguous and cannot grant ownership.
    modelSelected(model: PlanModeModelReference): void {
      if (!selection) return;
      selection.audit();
      if (!selection.observed && selection.model && sameModel(model, selection.model)) {
        selection.observed = true;
      } else selection.invalid = true;
    },
    thinkingSelected(): void {
      // Entries, unlike callbacks, are synchronous with the mutation. A delayed
      // callback for an already audited change must not invalidate a new lease.
      selection?.audit();
    },
    /** Check the configured target before any Plan state changes, so an unusable one leaves the plan ready. */
    resolve(ctx: ExtensionContext, settings: PlanModeSettings): ImplementationModelTarget {
      const reference = configuredImplementationModel(settings);
      const thinking = configuredImplementationThinkingLevel(settings);
      if (!reference) return thinking ? { kind: "target", thinkingLevel: thinking } : { kind: "none" };
      const label = formatModel(reference);
      const model = ctx.modelRegistry.find(reference.provider, reference.id);
      if (!model)
        return { kind: "unavailable", message: `Implementation model ${label} is not in Pi's model registry.` };
      if (ctx.model && sameModel(ctx.model, model)) {
        return thinking ? { kind: "target", thinkingLevel: thinking } : { kind: "none" };
      }
      if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
        return {
          kind: "unavailable",
          message: `Implementation model ${label} has no configured credentials.`,
        };
      }
      return { kind: "target", model, thinkingLevel: thinking };
    },

    async apply(
      ctx: ExtensionContext,
      target: Extract<ImplementationModelTarget, { kind: "target" }>,
      isCurrent: () => boolean,
    ): Promise<ImplementationModelSwitch> {
      if (!isCurrent()) return { kind: "obsolete" };
      const pending = selection;
      const previousModel = ctx.model ? modelReference(ctx.model) : undefined;
      const previousThinkingLevel = thinkingLevel();
      if (target.model) {
        const label = formatModel(target.model);
        let switched: boolean;
        try {
          switched = await pi.setModel(target.model);
        } catch (error: unknown) {
          if (!isCurrent()) return { kind: "obsolete" };
          return { kind: "failed", message: `${label}: ${errorDetail(error)}` };
        }
        if (!isCurrent()) return { kind: "obsolete" };
        if (!switched) return { kind: "failed", message: `${label} has no configured credentials` };
      }
      if (!isCurrent()) return { kind: "obsolete" };
      const ambiguous = pending?.ambiguousThinking;
      if (!ambiguous && target.thinkingLevel && thinkingLevel() !== target.thinkingLevel) {
        setOwnedThinking(ctx, target.thinkingLevel);
      }
      if (!isCurrent()) return { kind: "obsolete" };
      const appliedModel = target.model ? modelReference(target.model) : undefined;
      const appliedThinkingLevel = thinkingLevel();
      if (!appliedModel && appliedThinkingLevel === previousThinkingLevel) return { kind: "applied" };
      return {
        kind: "applied",
        ...(ambiguous ? { warning: ambiguousThinkingWarning("implementation thinking application") } : {}),
        handoff: {
          ...(appliedModel ? { appliedModel, ...(previousModel ? { previousModel } : {}) } : {}),
          ...(!ambiguous ? { previousThinkingLevel, appliedThinkingLevel } : {}),
        },
      };
    },

    /**
     * Undo a handoff only where the session still shows what it applied. A model
     * selected since then is the user's, together with its thinking level.
     * Restore thinking only without ambiguous model-switch changes; otherwise
     * keep the current level, which may itself be the model's new default.
     */
    async restore(
      ctx: ExtensionContext,
      handoff: ImplementationModelHandoff,
      isCurrent: () => boolean,
    ): Promise<PlanningModelRestore> {
      if (!isCurrent()) return { kind: "obsolete" };
      const pending = selection;
      const levelBefore = thinkingLevel();
      const desiredThinkingLevel =
        handoff.appliedThinkingLevel !== undefined && levelBefore === handoff.appliedThinkingLevel
          ? handoff.previousThinkingLevel
          : levelBefore;
      let message: string | undefined;
      if (handoff.appliedModel) {
        const current = ctx.model;
        if (!current || !sameModel(current, handoff.appliedModel)) return { kind: "kept" };
        if (handoff.previousModel) {
          const label = formatModel(handoff.previousModel);
          const staying = `staying on ${formatModel(current)}`;
          const planning = ctx.modelRegistry.find(handoff.previousModel.provider, handoff.previousModel.id);
          if (!planning) {
            return {
              kind: "unavailable",
              message: `Planning model ${label} is no longer available; ${staying}.`,
            };
          }
          let restored: boolean;
          try {
            restored = await pi.setModel(planning);
          } catch (error: unknown) {
            if (!isCurrent()) return { kind: "obsolete" };
            return {
              kind: "unavailable",
              message: `Planning model ${label} could not be restored (${errorDetail(error)}); ${staying}.`,
            };
          }
          if (!isCurrent()) return { kind: "obsolete" };
          if (!restored) {
            return {
              kind: "unavailable",
              message: `Planning model ${label} has no configured credentials; ${staying}.`,
            };
          }
          message = `Restored planning model ${label}.`;
        }
      }
      if (!isCurrent()) return { kind: "obsolete" };
      const ambiguous = pending?.ambiguousThinking;
      if (!ambiguous && desiredThinkingLevel && thinkingLevel() !== desiredThinkingLevel) {
        setOwnedThinking(ctx, desiredThinkingLevel);
      }
      if (!isCurrent()) return { kind: "obsolete" };
      return {
        kind: "restored",
        ...(message ? { message } : {}),
        ...(ambiguous ? { warning: ambiguousThinkingWarning("planning thinking restoration") } : {}),
      };
    },
  };
}

export function describeImplementationHandoff(handoff: ImplementationModelHandoff) {
  const restores = "/plan exit or a new plan restores";
  if (handoff.appliedModel) {
    const implementing = `Implementing on ${formatModel(handoff.appliedModel)}.`;
    return handoff.previousModel
      ? `${implementing} ${restores} ${formatModel(handoff.previousModel)} unless you select another model first.`
      : implementing;
  }
  return `Implementation thinking: ${handoff.appliedThinkingLevel}. ${restores} ${handoff.previousThinkingLevel}.`;
}

export function sameModel(left: PlanModeModelReference, right: PlanModeModelReference) {
  return left.provider === right.provider && left.id === right.id;
}

function ambiguousThinkingWarning(action: string) {
  return `Skipped ${action}: model-switch thinking provenance is ambiguous; kept the current level.`;
}

function modelReference(model: PlanModeModelReference): PlanModeModelReference {
  return { provider: model.provider, id: model.id };
}

function formatModel(model: PlanModeModelReference) {
  return `${model.provider}/${model.id}`;
}

function errorDetail(error: unknown) {
  const detail = (error instanceof Error ? error.message : String(error))
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return detail.length > 300 ? `${detail.slice(0, 299)}…` : detail || "unknown error";
}
