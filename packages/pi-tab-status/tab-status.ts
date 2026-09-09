/**
 * Update the terminal tab title with a compact Pi run state.
 *
 * `legacy` keeps the original emoji suffixes. `ridgeline` is a text-only,
 * terminal-font-safe style that matches the Signalridge Pi presentation.
 */

import { basename } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import type {
  AgentEndEvent,
  AgentStartEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolResultEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";

type StatusState = "new" | "running" | "doneCommitted" | "doneNoCommit" | "timeout";
export type TabStatusStyle = "legacy" | "ridgeline";

type StatusTracker = {
  state: StatusState;
  running: boolean;
  sawCommit: boolean;
};

const STATUS_TEXT: Record<StatusState, string> = {
  new: ":new",
  running: ":running...",
  doneCommitted: ":✅",
  doneNoCommit: ":🚧",
  timeout: ":🛑",
};

const RIDGELINE_STATUS_TEXT: Record<StatusState, string> = {
  new: "new",
  running: "working",
  doneCommitted: "done",
  doneNoCommit: "review",
  timeout: "blocked",
};

const INACTIVE_TIMEOUT_MS = 180_000;
const GIT_COMMIT_RE = /\bgit\b[^\n]*\bcommit\b/;

/**
 * Read the configured style on each call rather than freezing it at import time,
 * so the value stays a runtime input instead of a module-load side effect.
 */
function resolveTabStatusStyle(): TabStatusStyle {
  return process.env.PI_TAB_STATUS_STYLE === "ridgeline" ? "ridgeline" : "legacy";
}

/**
 * The title is written as an OSC escape sequence, so a directory name is not just
 * untrusted display text: a BEL or ST inside it terminates the sequence early and
 * the remainder lands on the terminal as commands. Neutralize every C0/C1 control
 * and bidi override, then collapse the whitespace that leaves behind.
 *
 * Duplicated rather than shared, per the package boundary rule; `pi-stamp`'s
 * metadata sanitizer is the reference shape.
 */
export function sanitizeTitleText(value: string): string {
  let safe = "";
  for (const character of value) {
    safe += isUnsafeTerminalCodePoint(character.codePointAt(0) ?? 0) ? " " : character;
  }
  return safe.replace(/\s+/gu, " ").trim();
}

function isUnsafeTerminalCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function projectName(cwd: string): string {
  return sanitizeTitleText(basename(cwd || "pi")) || "pi";
}

export function formatIdleTabTitle(cwd: string, style: TabStatusStyle = resolveTabStatusStyle()): string {
  const project = projectName(cwd);
  return style === "ridgeline" ? `pi · ${project}` : `pi - ${project}`;
}

export function formatTabTitle(
  cwd: string,
  state: StatusState,
  style: TabStatusStyle = resolveTabStatusStyle(),
): string {
  const project = projectName(cwd);
  return style === "ridgeline"
    ? `pi · ${project} · ${RIDGELINE_STATUS_TEXT[state]}`
    : `pi - ${project}${STATUS_TEXT[state]}`;
}

export default function (pi: ExtensionAPI) {
  const status: StatusTracker = {
    state: "new",
    running: false,
    sawCommit: false,
  };
  const commitCandidates = new Set<string>();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let finalStopReason: StopReason | undefined;
  let settlementTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  const cancelSettlement = () => {
    generation++;
    if (settlementTimer !== undefined) clearTimeout(settlementTimer);
    settlementTimer = undefined;
  };
  const nativeClearTimeout = globalThis.clearTimeout;

  const setTitle = (ctx: ExtensionContext, next: StatusState): void => {
    status.state = next;
    if (!ctx.hasUI) return;
    ctx.ui.setTitle(formatTabTitle(ctx.cwd, next));
  };

  const clearTabTimeout = (): void => {
    if (timeoutId === undefined) return;
    nativeClearTimeout(timeoutId);
    timeoutId = undefined;
  };

  const resetTimeout = (ctx: ExtensionContext): void => {
    clearTabTimeout();
    timeoutId = setTimeout(() => {
      if (status.running && status.state === "running") {
        setTitle(ctx, "timeout");
      }
    }, INACTIVE_TIMEOUT_MS);
  };

  const markActivity = (ctx: ExtensionContext): void => {
    if (status.state === "timeout") {
      setTitle(ctx, "running");
    }
    if (!status.running) return;
    resetTimeout(ctx);
  };

  const resetState = (ctx: ExtensionContext, next: StatusState): void => {
    cancelSettlement();
    status.running = false;
    finalStopReason = undefined;
    commitCandidates.clear();
    status.sawCommit = false;
    clearTabTimeout();
    setTitle(ctx, next);
  };

  const beginRun = (ctx: ExtensionContext): void => {
    cancelSettlement();
    if (!status.running) {
      commitCandidates.clear();
      status.sawCommit = false;
    }
    finalStopReason = undefined;
    status.running = true;
    setTitle(ctx, "running");
    resetTimeout(ctx);
  };

  const getStopReason = (messages: AgentMessage[]): StopReason | undefined => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role === "assistant") {
        return (message as AssistantMessage).stopReason;
      }
    }
    return undefined;
  };

  pi.on("session_start", async (_event: SessionStartEvent, ctx) => {
    resetState(ctx, "new");
  });
  pi.on("before_agent_start", async (_event: BeforeAgentStartEvent, ctx) => {
    markActivity(ctx);
  });
  pi.on("agent_start", async (_event: AgentStartEvent, ctx) => {
    beginRun(ctx);
  });
  pi.on("turn_start", async (_event: TurnStartEvent, ctx) => {
    markActivity(ctx);
  });
  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    if (event.toolName === "bash" || event.toolName === "powershell") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      if (command && GIT_COMMIT_RE.test(command)) commitCandidates.add(event.toolCallId);
    }
    markActivity(ctx);
  });
  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    if (commitCandidates.delete(event.toolCallId) && !event.isError) status.sawCommit = true;
    markActivity(ctx);
  });
  pi.on("agent_end", async (event: AgentEndEvent) => {
    finalStopReason = getStopReason(event.messages);
  });
  const settle = (ctx: ExtensionContext, owner: number): void => {
    if (owner !== generation) return;
    // A prior observer can start manual compaction, whose terminal hook runs
    // before isIdle flips and does not cause another agent_settled event.
    if (!ctx.isIdle()) {
      settlementTimer = setTimeout(() => settle(ctx, owner), 25);
      settlementTimer.unref?.();
      return;
    }
    settlementTimer = undefined;
    status.running = false;
    commitCandidates.clear();
    clearTabTimeout();
    if (finalStopReason === "error") {
      setTitle(ctx, "timeout");
      return;
    }
    setTitle(ctx, status.sawCommit ? "doneCommitted" : "doneNoCommit");
  };
  pi.on("agent_settled", async (_event, ctx) => {
    cancelSettlement();
    settle(ctx, generation);
  });
  pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx) => {
    cancelSettlement();
    status.running = false;
    status.sawCommit = false;
    finalStopReason = undefined;
    commitCandidates.clear();
    clearTabTimeout();
    if (!ctx.hasUI) return;
    ctx.ui.setTitle(formatIdleTabTitle(ctx.cwd));
  });
}
