/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type Component, Input, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import { extractText } from "../context.js";
import type { AgentRecordSnapshot } from "../types.js";
import { getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import type { Theme } from "./agent-display.js";
import { type AgentActivity, buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatDuration, formatSessionTokens, getPromptModeLabel } from "./agent-display.js";
import { PREVIEW_SCAN_LIMIT, safeTerminalText, sanitizeDisplayText, truncateCodePoints } from "./safe-text.js";
import { getAgentStatusColor, getAgentStatusLabel, getAgentStatusMark } from "./status-label.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

/** Base lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
/** Height ceiling shared by the overlay's `maxHeight` and the viewer's internal viewport cap. */
export const VIEWPORT_HEIGHT_PCT = 70;

type BashExecutionMessage = {
  role: "bashExecution";
  command: string;
  output: string;
};

/** Characters of a tool result or command output the transcript shows inline. */
const PREVIEW_LINE_LIMIT = 500;

/**
 * Reduce an untrusted blob to a bounded, inert preview.
 *
 * Scrub before truncating — a cut through a live escape sequence would leave a
 * dangling introducer, and only the scrubber decides where a sequence ends. The
 * raw prefix bound keeps a megabyte-sized tool result from being scrubbed in
 * full just to show 500 characters of it, and is large enough that even
 * escape-dense output still yields a full preview.
 */
function previewText(raw: string): string {
  const scanned = raw.length > PREVIEW_SCAN_LIMIT ? raw.slice(0, PREVIEW_SCAN_LIMIT) : raw;
  const safe = safeTerminalText(scanned);
  if (scanned.length === raw.length && safe.length <= PREVIEW_LINE_LIMIT) return safe;
  return `${truncateCodePoints(safe, PREVIEW_LINE_LIMIT, "")}... (truncated)`;
}

function isBashExecutionMessage(message: { role: string }): message is BashExecutionMessage {
  return message.role === "bashExecution"
    && "command" in message
    && typeof message.command === "string"
    && "output" in message
    && typeof message.output === "string";
}

export class ConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
  private stopArmed = false;
  private keys: ViewerKeys;
  /** Steering composer — present while the user is typing a message to the agent. */
  private composer: Input | undefined;

  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecordSnapshot,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    /** Abort the agent shown here. Omitted → no stop affordance (e.g. read-only history). */
    private onStop?: () => void,
    /** User keybindings from `ctx.ui.custom()`. Omitted → hardcoded defaults. */
    keybindings?: ViewerKeybindings,
    /** Send a steering message to the agent. Omitted → no compose affordance. */
    private onSteer?: (message: string) => void,
    /** Retrieve a fresh public snapshot so the viewer reflects status changes. */
    private getRecord?: () => AgentRecordSnapshot | undefined,
  ) {
    this.keys = createViewerKeys(keybindings);
    this.unsubscribe = session.subscribe(() => {
      if (this.closed) return;
      this.tui.requestRender();
    });
  }

  private refreshRecord(): AgentRecordSnapshot {
    const current = this.getRecord?.();
    if (current) this.record = current;
    return this.record;
  }

  handleInput(data: string): void {
    // While composing a steer message, the input owns all keys (Enter sends,
    // Esc cancels — both wired in openComposer()). Editing keys flow through.
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    // Enter opens the steering composer (only while the agent can still be
    // steered) — then type + Enter sends, Esc or an empty submit returns. When
    // not steerable, fall through so the key still disarms a pending stop.
    if (matchesKey(data, "enter") && this.canSteer()) {
      this.stopArmed = false;
      this.openComposer();
      return;
    }

    // Stop/abort the agent (only while it can still be stopped). Two-press:
    // first "x" arms, second confirms — any other key disarms.
    if (matchesKey(data, "x")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.onStop?.();
        } else {
          this.stopArmed = true;
        }
        this.tui.requestRender();
      }
      return;
    }
    if (this.stopArmed) this.stopArmed = false;

    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (this.keys.scrollUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.scrollDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.pageUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (this.keys.pageDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  render(width: number): string[] {
    if (width < 6) return [];
    this.refreshRecord();
    const th = this.theme;
    const innerW = width - 2;
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) => {
      const fitted = truncateToWidth(pad(content, innerW), innerW, "...", true);
      return ` ${fitted} `;
    };
    // Two full-width rules, top and bottom, and none in between. The overlay
    // floats over the transcript, so without them there is no telling where the
    // agent's conversation ends and the parent's resumes. An inner rule would be
    // a third horizontal line competing with the two that mark the boundary, and
    // a four-sided box would cost two columns on every row for the same job.
    const rule = () => th.fg("border", "─".repeat(Math.max(0, width)));
    const hrMid = row("");

    lines.push(rule());
    lines.push(row(th.bold("Agent conversation")));
    const name = renderAgentName(this.record.type, th, { bold: true });
    const modeLabel = getPromptModeLabel(this.record.type);
    const modeTag = modeLabel ? th.fg("dim", `mode ${modeLabel}`) : undefined;
    const statusText = getAgentStatusLabel(this.record.status);
    const statusColor = getAgentStatusColor(this.record.status);
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);

    const headerStats: string[] = [duration];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) headerStats.unshift(`tools ${toolUses}`);
    const tokens = getLifetimeTotal(this.activity?.lifetimeUsage);
    if (tokens > 0) {
      const percent = getSessionContextPercent(this.activity?.session);
      headerStats.push(formatSessionTokens(tokens, percent, th, this.record.compactionCount));
    }

    const headerParts = [
      th.fg(statusColor, `${getAgentStatusMark(this.record.status)} ${statusText}`),
      name,
      modeTag,
      th.fg("muted", sanitizeDisplayText(this.record.description)),
      fgPreservingNestedStyles(th, "dim", headerStats.join(" · ")),
    ].filter((part): part is string => part !== undefined);
    lines.push(row(headerParts.join(th.fg("dim", " · "))));

    const invocationLine = this.invocationLine();
    if (invocationLine) lines.push(row(invocationLine));
    lines.push(hrMid);

    const contentLines = this.buildContentLines(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);

    for (let i = 0; i < viewportHeight; i++) {
      lines.push(row(visible[i] ?? ""));
    }

    lines.push(hrMid);
    if (this.composer) {
      const renderedComposer = this.composer.render(innerW)[0] ?? "";
      const composerLine = renderedComposer.startsWith("> ") ? renderedComposer.slice(2) : renderedComposer;
      lines.push(row(composerLine));
      const composeHint = th.fg("dim", "Enter send · Esc cancel");
      const composeLeft = th.fg("accent", "steer");
      const composeGap = Math.max(1, innerW - visibleWidth(composeLeft) - visibleWidth(composeHint));
      lines.push(row(composeLeft + " ".repeat(composeGap) + composeHint));
    } else {
      const sep = th.fg("dim", " · ");
      const actions: string[] = [];
      if (this.canSteer()) actions.push(th.fg("dim", "Enter steer"));
      if (this.isStoppable()) {
        actions.push(this.stopArmed ? th.fg("error", "x again to STOP") : th.fg("dim", "x stop"));
      }
      const footerRight = th.fg("dim", "up/down scroll · page up/page down or shift up/down · esc close");

      const scrollPct = contentLines.length <= viewportHeight
        ? "100%"
        : `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
      const count = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`);
      const withCount = [count, ...actions].join(sep);
      const footerLeft = visibleWidth(withCount) + visibleWidth(footerRight) + 1 <= innerW
        ? withCount
        : actions.join(sep);

      const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
      lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
    }
    lines.push(rule());

    return lines;
  }

  /** Stoppable only when a stop handler exists and the agent is still active. */
  private isStoppable(): boolean {
    const record = this.refreshRecord();
    return !!this.onStop && (record.status === "running" || record.status === "queued");
  }

  /** Steerable only when a steer handler exists and the agent is still active. */
  private canSteer(): boolean {
    const record = this.refreshRecord();
    return !!this.onSteer && (record.status === "running" || record.status === "queued");
  }

  /** Open the inline steering composer and route subsequent input to it. */
  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      this.composer = undefined;
      if (message) this.onSteer?.(message);
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  invalidate(): void { /* no cached state to clear */ }

  dispose(): void {
    this.closed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- Private ----

  private viewportHeight(): number {
    // Cap mirrors the overlay's maxHeight — otherwise the viewer would render
    // more lines than the overlay shows and clip the footer.
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    // The composer adds one row above the footer hint while it's open.
    return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0) + (this.composer ? 1 : 0);
  }

  private invocationLine(): string | undefined {
    const { modelName, tags } = buildInvocationTags(this.record.invocation);
    const parts = modelName ? [modelName, ...tags] : tags;
    if (parts.length === 0) return undefined;
    return this.theme.fg("dim", `  invocation · ${parts.join(" · ")}`);
  }

  private buildContentLines(width: number): string[] {
    if (width <= 0) return [];

    const th = this.theme;
    const messages = this.session.messages;
    const lines: string[] = [];

    if (messages.length === 0) {
      lines.push(th.fg("dim", "waiting for first message"));
      return lines;
    }

    let needsSeparator = false;
    for (const msg of messages) {
      if (msg.role === "user") {
        const text = safeTerminalText(typeof msg.content === "string"
          ? msg.content
          : extractText(msg.content));
        if (!text.trim()) continue;
        if (needsSeparator) lines.push("");
        lines.push(th.fg("accent", "User"));
        for (const line of wrapTextWithAnsi(text.trim(), width)) {
          lines.push(line);
        }
      } else if (msg.role === "assistant") {
        const textParts: string[] = [];
        const toolCalls: string[] = [];
        for (const c of msg.content) {
          if (c.type === "text" && c.text) textParts.push(c.text);
          else if (c.type === "toolCall") toolCalls.push(c.name);
        }
        if (needsSeparator) lines.push("");
        lines.push(th.bold("Assistant"));
        if (textParts.length > 0) {
          for (const line of wrapTextWithAnsi(safeTerminalText(textParts.join("\n")).trim(), width)) {
            lines.push(line);
          }
        }
        for (const name of toolCalls) {
          lines.push(truncateToWidth(th.fg("muted", `Tool: ${sanitizeDisplayText(name)}`), width));
        }
      } else if (msg.role === "toolResult") {
        const truncated = previewText(extractText(msg.content));
        if (!truncated.trim()) continue;
        if (needsSeparator) lines.push("");
        lines.push(th.fg("dim", "Result"));
        for (const line of wrapTextWithAnsi(truncated.trim(), width)) {
          lines.push(th.fg("dim", line));
        }
      } else if (isBashExecutionMessage(msg)) {
        if (needsSeparator) lines.push("");
        lines.push(truncateToWidth(th.fg("muted", `Command: ${sanitizeDisplayText(msg.command)}`), width));
        const out = previewText(msg.output);
        if (out.trim()) {
          for (const line of wrapTextWithAnsi(out.trim(), width)) {
            lines.push(th.fg("dim", line));
          }
        }
      } else {
        continue;
      }
      needsSeparator = true;
    }

    if (this.record.status === "running" && this.activity) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText);
      lines.push("");
      lines.push(truncateToWidth(`${th.fg("accent", "Thinking...")}${th.fg("dim", " · ")}${th.fg("dim", act)}`, width));
    }

    return lines.map(l => truncateToWidth(l, width));
  }
}
