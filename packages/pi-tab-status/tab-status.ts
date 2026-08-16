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
  SessionBeforeSwitchEvent,
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
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
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
    status.running = false;
    status.sawCommit = false;
    clearTabTimeout();
    setTitle(ctx, next);
  };

  const beginRun = (ctx: ExtensionContext): void => {
    status.running = true;
    status.sawCommit = false;
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
  pi.on("session_before_switch", async (event: SessionBeforeSwitchEvent, ctx) => {
    resetState(ctx, event.reason === "new" ? "new" : "doneCommitted");
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
    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      if (command && GIT_COMMIT_RE.test(command)) status.sawCommit = true;
    }
    markActivity(ctx);
  });
  pi.on("tool_result", async (_event: ToolResultEvent, ctx) => {
    markActivity(ctx);
  });
  pi.on("agent_end", async (event: AgentEndEvent, ctx) => {
    status.running = false;
    clearTabTimeout();
    const stopReason = getStopReason(event.messages);
    if (stopReason === "error") {
      setTitle(ctx, "timeout");
      return;
    }
    setTitle(ctx, status.sawCommit ? "doneCommitted" : "doneNoCommit");
  });
  pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx) => {
    clearTabTimeout();
    if (!ctx.hasUI) return;
    ctx.ui.setTitle(formatIdleTabTitle(ctx.cwd));
  });
}
