/**
 * agent-display.ts — Shared formatting for every surface that shows an agent.
 *
 * The FleetView list, the conversation viewer, and the Agent tool's transcript
 * rows all label agents through this module, so a name, a stat, or a status
 * reads the same wherever it appears, and untrusted text passes through one
 * sanitizer on the way out.
 */

import { getConfig } from "../agent-types.js";
import type { AgentInvocation, SubagentType } from "../types.js";
import type { LifetimeUsage, SessionLike } from "../usage.js";
import { sanitizeDisplayText, truncateCodePoints } from "./safe-text.js";

// ---- Constants ----

/**
 * Frames for the running indicator.
 *
 * Every frame is exactly one column wide, and that is the point: the frame is
 * followed on the same line by the activity description, so a frame whose width
 * changes drags that text sideways on every tick. The previous frames
 * ("Thinking" through "Thinking...") swung between 8 and 11 columns twelve
 * times a second, which is what made the row look like it was shaking.
 */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** How often to advance SPINNER; one frame per 80ms reads as a smooth rotation. */
export const SPINNER_INTERVAL_MS = 80;

/** Statuses that indicate an error/non-success outcome. */
export const ERROR_STATUSES = new Set(["error", "aborted", "steered", "stopped"]);

/** Tool name → human-readable action for activity descriptions. */
const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

/** Per-agent live activity state. */
export interface AgentActivity {
  activeTools: Map<string, string>;
  toolUses: number;
  responseText: string;
  session?: SessionLike;
  /** Current turn count. */
  turnCount: number;
  /** Effective max turns for this agent (undefined = unlimited). */
  maxTurns?: number;
  /** Lifetime usage breakdown — see LifetimeUsage docs. */
  lifetimeUsage: LifetimeUsage;
}

/** Metadata attached to Agent tool results for custom rendering. */
export interface AgentDetails {
  displayName: string;
  description: string;
  subagentType: string;
  toolUses: number;
  tokens: string;
  durationMs: number;
  /** `queued` is a waiting background run; `background` means it has started. */
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error" | "background";
  /** Human-readable description of what the agent is currently doing. */
  activity?: string;
  /** Current spinner frame index (for animated running indicator). */
  spinnerFrame?: number;
  /** Short model name if different from parent (e.g. "haiku", "sonnet"). */
  modelName?: string;
  /** Notable config tags (e.g. ["thinking: high", "isolated"]). */
  tags?: string[];
  /** Current turn count. */
  turnCount?: number;
  /** Effective max turns (undefined = unlimited). */
  maxTurns?: number;
  agentId?: string;
  error?: string;
}

// ---- Formatting helpers ----

/** Apply foreground styling while restoring it after nested foreground/full ANSI resets. */
export function fgPreservingNestedStyles(theme: Theme, color: string, text: string): string {
  const styledEmpty = theme.fg(color, "");
  const styleStart = styledEmpty.replace(/\u001b\[(?:0|39)m/g, "");
  return theme.fg(color, text.replace(/\u001b\[(?:0|39)m/g, reset => `${reset}${styleStart}`));
}

/** Format a token count compactly: "33.8k tokens", "1.2M tokens". */
export function formatTokens(count: number): string {
  const unit = count === 1 ? "token" : "tokens";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M ${unit}`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k ${unit}`;
  return `${count} ${unit}`;
}

/**
 * Token count with optional context-fill % and compaction-count annotations.
 * Thresholds for percent: <70% dim, 70–85% warning, ≥85% error.
 * Compactions are rendered as plain text metadata.
 *
 *   "12.3k tokens"              — no annotations
 *   "12.3k tokens (45%)"        — percent only
 *   "12.3k tokens (compactions 2)" — compactions only
 *   "12.3k tokens (45% · compactions 2)" — both
 */
export function formatSessionTokens(
  tokens: number,
  percent: number | null,
  theme: Theme,
  compactions = 0,
): string {
  const tokenStr = formatTokens(tokens);
  const annotations: string[] = [];
  if (percent !== null) {
    const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
    annotations.push(theme.fg(color, `${Math.round(percent)}%`));
  }
  if (compactions > 0) {
    annotations.push(theme.fg("dim", `compactions ${compactions}`));
  }
  if (annotations.length === 0) return tokenStr;
  return `${tokenStr} (${annotations.join(" · ")})`;
}

/** Format turn count with optional max limit: "turns 5 of 30" or "turns 5". */
export function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null ? `turns ${turnCount} of ${maxTurns}` : `turns ${turnCount}`;
}

/** Format milliseconds as human-readable duration. */
export function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format duration from start/completed timestamps. */
export function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return formatMs(completedAt - startedAt);
  return `${formatMs(Date.now() - startedAt)} (running)`;
}

/**
 * Get display name for any agent type (built-in or custom).
 *
 * Sanitized here as well as at the loader: the fallback when an agent file omits
 * `display_name` is the file's own basename, and a filename is as untrusted as
 * its frontmatter. Every surface labels agents through this one function.
 */
export function getDisplayName(type: SubagentType): string {
  return sanitizeDisplayText(getConfig(type).displayName);
}

/** Short label for prompt mode: "twin" for append, nothing for replace (the default). */
export function getPromptModeLabel(type: SubagentType): string | undefined {
  const config = getConfig(type);
  return config.promptMode === "append" ? "twin" : undefined;
}

/** Mode label is not included — callers add it where they want it. */
export function buildInvocationTags(
  invocation: AgentInvocation | undefined,
): { modelName?: string; tags: string[] } {
  const tags: string[] = [];
  if (!invocation) return { tags };
  if (invocation.tier) tags.push(`tier: ${invocation.tier}`);
  if (invocation.thinking) tags.push(`thinking: ${invocation.thinking}`);
  if (invocation.isolated) tags.push("isolated");
  if (invocation.isolation === "worktree") tags.push("worktree");
  if (invocation.inheritContext) tags.push("inherit context");
  if (invocation.runInBackground) tags.push("background");
  if (invocation.maxTurns != null) tags.push(`max turns: ${invocation.maxTurns}`);
  return { modelName: invocation.modelName, tags };
}

/** Truncate untrusted text to a single inert line, max `len` chars. */
function truncateLine(text: string, len = 60): string {
  const line = sanitizeDisplayText(text.split("\n").find(l => l.trim()) ?? "");
  return truncateCodePoints(line, len);
}

/** Build a human-readable activity string from currently-running tools or response text. */
export function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
  if (activeTools.size > 0) {
    const groups = new Map<string, number>();
    for (const toolName of activeTools.values()) {
      const action = TOOL_DISPLAY[toolName] ?? sanitizeDisplayText(toolName);
      groups.set(action, (groups.get(action) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [action, count] of groups) {
      if (count > 1) {
        parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
      } else {
        parts.push(action);
      }
    }
    return `${parts.join(" · ")}...`;
  }

  if (responseText && responseText.trim().length > 0) {
    return truncateLine(responseText);
  }

  return "Thinking...";
}
