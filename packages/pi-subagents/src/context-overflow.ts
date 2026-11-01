/**
 * Overflow-aware waking. After a response overflowed the model's context window and no
 * compaction followed, any turn this extension starts resends the same over-window context
 * and fails again, and each failure is still a billed request. Wakes are held until a
 * compaction or a later successful response ends the episode.
 */
import { isContextOverflow } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type OverflowContext = Pick<ExtensionContext, "sessionManager" | "model" | "hasUI" | "ui">;

/**
 * The first overflowed response of the current episode: the latest meaningful response on the
 * branch overflowed and neither compaction nor a successful response followed. Aborted and
 * transient error responses say nothing about the context size and are skipped.
 */
export function overflowEpisode(ctx: Pick<ExtensionContext, "sessionManager" | "model">): string | undefined {
  try {
    const branch = ctx.sessionManager.getBranch();
    const contextWindow = ctx.model?.contextWindow;
    let episode: string | undefined;
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry.type === "compaction") break;
      if (entry.type !== "message" || entry.message.role !== "assistant" || entry.message.stopReason === "aborted") continue;
      if (!isContextOverflow(entry.message, contextWindow)) {
        if (entry.message.stopReason === "error") continue;
        break;
      }
      episode = entry.id;
    }
    return episode;
  } catch {
    // A replaced session's context is stale; never hold a wake on a guess.
    return undefined;
  }
}

export function overflowNotice(held: string, codexCompact: boolean): string {
  return `Context exceeds the model's window; ${held} without starting a turn. ` +
    `Run ${codexCompact ? "/compact or /codex-compact" : "/compact"}, or start a new session.`;
}

/** One guard per extension instance, so the user sees one notice per overflow episode. */
export class OverflowWakeGuard {
  private noticed: string | undefined;
  constructor(private readonly pi: Pick<ExtensionAPI, "getCommands">, private readonly held: string) {}

  /** True while a turn must not start; the first hold of an episode tells the user why. */
  holds(ctx: OverflowContext | undefined): boolean {
    const episode = ctx ? overflowEpisode(ctx) : undefined;
    if (!ctx || episode === undefined) return false;
    if (episode !== this.noticed) {
      this.noticed = episode;
      try {
        if (ctx.hasUI) ctx.ui.notify(overflowNotice(this.held, this.hasCommand("codex-compact")), "warning");
      } catch {
        // A disposed UI must not block the delivery that follows.
      }
    }
    return true;
  }

  private hasCommand(name: string): boolean {
    try {
      return this.pi.getCommands().some(command => command.name === name);
    } catch {
      return false;
    }
  }
}
