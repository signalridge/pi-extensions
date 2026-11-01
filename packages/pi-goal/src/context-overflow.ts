import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findFinalAssistantMessage, isGoalContextOverflow } from "./errors.js";

/**
 * A goal turn started while the latest response on the branch overflowed the model's context
 * window, with no compaction after it, resends the same over-window context and fails again.
 */
export interface OverflowContext {
  sessionManager?: unknown;
  modelRegistry?: { find(provider: string, model: string): { contextWindow?: number } | undefined };
}

/**
 * The first overflowed response of the current episode: the latest meaningful response on the
 * branch overflowed and neither compaction nor a successful response followed. Aborted and
 * transient error responses say nothing about the context size and are skipped.
 */
export function contextOverflowEpisode(ctx: OverflowContext): string | undefined {
  let branch: unknown;
  let projected: Set<string> | undefined;
  try {
    const manager = ctx.sessionManager as Partial<ExtensionContext["sessionManager"]> | undefined;
    branch = manager?.getBranch?.();
    const projection = manager?.buildSessionProjection?.();
    projected = projection
      ? new Set(
          projection.entries
            .filter((entry) => entry.messages.some((message) => message.role === "assistant"))
            .map((entry) => entry.sourceEntry.id),
        )
      : undefined;
  } catch {
    // A replaced session's context is stale; never stop a goal on a guess.
    return undefined;
  }
  if (!Array.isArray(branch)) return undefined;
  let contextEdited = false;
  let episode: string | undefined;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry: unknown = branch[index];
    if (!entry || typeof entry !== "object") continue;
    const { type, id, message } = entry as { type?: unknown; id?: unknown; message?: unknown };
    if (type === "compaction") break;
    if (type === "context_edit") {
      contextEdited = true;
      continue;
    }
    if (type !== "message" || typeof id !== "string") continue;
    const assistant = findFinalAssistantMessage([message]);
    if (!assistant || assistant.stopReason === "aborted") continue;
    const explicit = assistant.stopReason === "error" && isGoalContextOverflow(assistant);
    if (assistant.stopReason === "error" && !explicit) continue;
    // Omitting a failed recovery attempt without successful compaction does not
    // repair its oversized input. Projection invalidation applies to usage.
    if (!explicit && projected && !projected.has(id)) break;
    const contextWindow =
      assistant.provider && assistant.model
        ? ctx.modelRegistry?.find(assistant.provider, assistant.model)?.contextWindow
        : undefined;
    if (!explicit && (contextEdited || !isGoalContextOverflow(assistant, contextWindow))) {
      if (assistant.stopReason === "error") continue;
      break;
    }
    episode = id;
  }
  return episode;
}

/** The compaction commands this session offers. */
export function compactCommands(pi: Pick<ExtensionAPI, "getCommands">): string {
  try {
    if (pi.getCommands().some((command) => command.name === "codex-compact")) return "/compact or /codex-compact";
  } catch {
    // Commands are unavailable before the session binds; /compact always exists.
  }
  return "/compact";
}
