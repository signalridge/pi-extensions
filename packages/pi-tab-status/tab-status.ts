/**
 * Update the terminal tab title with a compact Pi run state.
 *
 * `legacy` keeps the original emoji suffixes. `ridgeline` is a text-only,
 * terminal-font-safe style that matches the Signalridge Pi presentation.
 *
 * With `PI_TAB_STATUS_NOTIFY` set, the same settled and blocked transitions
 * also raise a desktop notification.
 */

import { basename } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import type {
  AgentEndEvent,
  AgentSettledEvent,
  AgentStartEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolResultEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { sendDesktopNotification } from "./notify.js";
import { sanitizeTitleText } from "./terminal-text.js";

export { sanitizeTitleText };

// `cancelled` carries no label: a run the user aborted needs no attention, so
// the tab returns to its bare project title.
type StatusState = "new" | "running" | "doneCommitted" | "doneNoCommit" | "timeout" | "cancelled";
type LabelledState = Exclude<StatusState, "cancelled">;
export type TabStatusStyle = "legacy" | "ridgeline";

type StatusTracker = {
  state: StatusState;
  running: boolean;
  sawCommit: boolean;
};

const STATUS_TEXT: Record<LabelledState, string> = {
  new: ":new",
  running: ":running...",
  doneCommitted: ":✅",
  doneNoCommit: ":🚧",
  timeout: ":🛑",
};

const RIDGELINE_STATUS_TEXT: Record<LabelledState, string> = {
  new: "new",
  running: "working",
  doneCommitted: "done",
  doneNoCommit: "review",
  timeout: "blocked",
};

const INACTIVE_TIMEOUT_MS = 180_000;

// Fixed text only: like Pi's native program status, a notification never
// carries prompts or model output.
const NOTIFICATION_BODY = {
  committed: "Finished with a commit",
  review: "Finished, ready for review",
  error: "Run ended with an error",
  stalled: "No activity for 3 minutes",
} as const;
const GIT_COMMIT_RE = /\bgit\b[^\n]*\bcommit\b/;

/**
 * Read the configured style on each call rather than freezing it at import time,
 * so the value stays a runtime input instead of a module-load side effect.
 */
function resolveTabStatusStyle(): TabStatusStyle {
  return process.env.PI_TAB_STATUS_STYLE === "ridgeline" ? "ridgeline" : "legacy";
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
  if (state === "cancelled") return formatIdleTabTitle(cwd, style);
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
  let finalStopReason: StopReason | undefined;
  let settlementTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  // A tool that is still executing is work in progress even when it emits no
  // intermediate events, which is the normal shape of a long shell command.
  // Pi tracks in-flight executions as a set of tool call ids, so the absence of
  // activity is only real inactivity once this set is empty.
  const activeToolCallIds = new Set<string>();
  const cancelSettlement = () => {
    generation++;
    if (settlementTimer !== undefined) clearTimeout(settlementTimer);
    settlementTimer = undefined;
  };
  const nativeClearTimeout = globalThis.clearTimeout;

  const retire = (): void => {
    cancelSettlement();
    clearTabTimeout();
    activeToolCallIds.clear();
    status.running = false;
    status.sawCommit = false;
    finalStopReason = undefined;
  };

  const isTui = (ctx: ExtensionContext): boolean => {
    try {
      return ctx.mode === "tui";
    } catch {
      // SDK disposal invalidates contexts without emitting session_shutdown.
      retire();
      return false;
    }
  };

  const setTitle = (ctx: ExtensionContext, next: StatusState): void => {
    status.state = next;
    if (!isTui(ctx)) return;
    try {
      ctx.ui.setTitle(formatTabTitle(ctx.cwd, next));
    } catch {
      // Timer callbacks must not access a retired context or throw into the host.
      retire();
    }
  };

  // Called only where a state is entered, never from a title refresh, so one
  // transition raises at most one notification. Subagent children and other
  // non-TUI sessions stay silent.
  const notifyDesktop = (ctx: ExtensionContext, body: string): void => {
    if (!isTui(ctx)) return;
    let title: string;
    try {
      title = formatIdleTabTitle(ctx.cwd);
    } catch {
      retire();
      return;
    }
    sendDesktopNotification(title, body);
  };

  const clearTabTimeout = (): void => {
    if (timeoutId === undefined) return;
    nativeClearTimeout(timeoutId);
    timeoutId = undefined;
  };

  const resetTimeout = (ctx: ExtensionContext): void => {
    clearTabTimeout();
    if (!isTui(ctx) || !status.running) return;
    const timer = setTimeout(() => {
      if (timeoutId !== timer) return;
      timeoutId = undefined;
      // Silence from an in-flight tool is not inactivity: a long command may run
      // for minutes without emitting any event, and it must not be reported as
      // blocked while it still holds the run open.
      if (status.running && status.state === "running" && activeToolCallIds.size === 0) {
        setTitle(ctx, "timeout");
        notifyDesktop(ctx, NOTIFICATION_BODY.stalled);
      }
    }, INACTIVE_TIMEOUT_MS);
    timeoutId = timer;
    timer.unref?.();
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
    activeToolCallIds.clear();
    status.running = false;
    finalStopReason = undefined;
    status.sawCommit = false;
    clearTabTimeout();
    setTitle(ctx, next);
  };

  const beginRun = (ctx: ExtensionContext): void => {
    cancelSettlement();
    if (!status.running) {
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
  pi.on("tool_call", async (_event: ToolCallEvent, ctx) => {
    markActivity(ctx);
  });
  pi.on("tool_execution_start", async (event: ToolExecutionStartEvent, ctx) => {
    activeToolCallIds.add(event.toolCallId);
    markActivity(ctx);
  });
  pi.on("tool_execution_end", async (event: ToolExecutionEndEvent, ctx) => {
    activeToolCallIds.delete(event.toolCallId);
    markActivity(ctx);
  });
  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    // Later tool_call hooks may rewrite the command. Only the executed input
    // and its successful result can establish that this run committed.
    // Hypa returns its process outcome in details, including nonzero exits
    // without isError. A successful tool invocation alone is not command success.
    const details = event.details;
    const successfulHypa =
      event.toolName === "hypa_shell" &&
      typeof details === "object" &&
      details !== null &&
      !Array.isArray(details) &&
      "source" in details &&
      details.source === "hypa-cli" &&
      "exitCode" in details &&
      details.exitCode === 0;
    if (!event.isError && (event.toolName === "bash" || event.toolName === "powershell" || successfulHypa)) {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      if (GIT_COMMIT_RE.test(command)) status.sawCommit = true;
    }
    markActivity(ctx);
  });
  pi.on("message_update", async (_event, ctx) => markActivity(ctx));
  pi.on("tool_execution_update", async (_event, ctx) => markActivity(ctx));
  pi.on("message_end", async (_event, ctx) => markActivity(ctx));
  pi.on("session_info_changed", async (_event, ctx) => setTitle(ctx, status.state));
  pi.on("agent_end", async (event: AgentEndEvent) => {
    finalStopReason = getStopReason(event.messages);
    // No tool can still be executing here: the agent finishes its tool batch
    // before it reports the run's end, and a failed or aborted run reports that
    // end without the in-flight tool's own end event. Such an id can therefore
    // never be cleared later, and a retry reusing this tracker would stay
    // running forever.
    activeToolCallIds.clear();
  });
  const settle = (ctx: ExtensionContext, owner: number, hostAborted: boolean | undefined): void => {
    if (owner !== generation) return;
    // A prior observer can start manual compaction, whose terminal hook runs
    // before isIdle flips and does not cause another agent_settled event.
    let idle: boolean;
    try {
      idle = ctx.isIdle();
    } catch {
      retire();
      return;
    }
    if (!idle) {
      settlementTimer = setTimeout(() => settle(ctx, owner, hostAborted), 25);
      settlementTimer.unref?.();
      return;
    }
    settlementTimer = undefined;
    status.running = false;
    clearTabTimeout();
    // The run is fully settled, so nothing can still be in flight; clearing here
    // keeps a tool that never reported its end from suppressing later timeouts.
    activeToolCallIds.clear();
    // Pi 1.1+ reports the abort itself; an abort can also surface as an error
    // stop reason. Older hosts omit the flag, so infer it from the last stop reason.
    // The user who aborted a run is already looking at it, so it settles silently.
    if (hostAborted ?? finalStopReason === "aborted") {
      setTitle(ctx, "cancelled");
      return;
    }
    if (finalStopReason === "error") {
      setTitle(ctx, "timeout");
      notifyDesktop(ctx, NOTIFICATION_BODY.error);
      return;
    }
    setTitle(ctx, status.sawCommit ? "doneCommitted" : "doneNoCommit");
    notifyDesktop(ctx, status.sawCommit ? NOTIFICATION_BODY.committed : NOTIFICATION_BODY.review);
  };
  pi.on("agent_settled", async (event: AgentSettledEvent, ctx) => {
    cancelSettlement();
    const aborted: unknown = (event as { aborted?: unknown }).aborted;
    settle(ctx, generation, typeof aborted === "boolean" ? aborted : undefined);
  });
  pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx) => {
    cancelSettlement();
    activeToolCallIds.clear();
    status.running = false;
    status.sawCommit = false;
    finalStopReason = undefined;
    clearTabTimeout();
    if (!isTui(ctx)) return;
    try {
      ctx.ui.setTitle(formatIdleTabTitle(ctx.cwd));
    } catch {
      retire();
    }
  });
}
