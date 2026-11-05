/** Live, session-owned conversation observer. Controls remain runtime-owned callbacks. */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, isKeyRelease, isKeyRepeat, Markdown, type MarkdownTheme, matchesKey, type OverlayOptions, stripTerminalSequences, type TUI, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeDisplayText } from "@signalridge/pi-ui";
import { renderAgentName } from "../agent-color.js";
import type { AgentRecordSnapshot } from "../types.js";
import { getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import { type AgentActivity, buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatDuration, formatSessionTokens, getPromptModeLabel, type Theme } from "./agent-display.js";
import { PREVIEW_SCAN_LIMIT, safeTerminalText, truncateCodePoints } from "./safe-text.js";
import { getAgentStatusColor, getAgentStatusLabel, getAgentStatusMark } from "./status-label.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

/** Height ceiling shared by the floating overlay and its internal viewport. */
export const VIEWPORT_HEIGHT_PCT = 70;

/** Only the public renderer mode selects native fullscreen; old hosts float. */
export type ConversationViewerHost = { readonly mode?: string };
export function getConversationViewerMode(host: ConversationViewerHost = {}, options: Pick<ViewerOptions, "mode"> = {}): "fullscreen" | "overlay" {
  return options.mode !== "overlay" && host.mode === "fullscreen" ? "fullscreen" : "overlay";
}
export function getConversationOverlayOptions(host: ConversationViewerHost = {}, options: Pick<ViewerOptions, "mode"> = {}): OverlayOptions {
  return getConversationViewerMode(host, options) === "fullscreen"
    ? { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 }
    : { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` };
}
export interface ViewerOptions {
  /** Runtime-owned eligibility for an exact running, unmanaged foreground run. */
  canHandoff?: () => boolean;
  // biome-ignore lint/suspicious/noConfusingVoidType: preserve void-returning control callbacks.
  onHandoff?: () => boolean | void;
  /** Fullscreen still requires a public fullscreen renderer. */
  mode?: "fullscreen" | "overlay";
}
// biome-ignore lint/suspicious/noConfusingVoidType: preserve existing void-returning steering callbacks.
export type SteerAcceptance = boolean | void;
export type SteerHandler = (message: string) => SteerAcceptance | Promise<SteerAcceptance>;

const MAX_MESSAGES = 64;
const MAX_MESSAGE_CHARS = 8_192;
const MAX_MESSAGE_ROWS = 256;
const MAX_CONTENT_ROWS = 4_096;
const MAX_BLOCKS = 64;
const PREVIEW_CHARS = 500;
type Message = AgentSession["messages"][number];
type TextCursor = { block: number; offset: number };
type MessagePage = { cursor: TextCursor; row: number };
type RawProjection = { text: string; calls: string[]; command: string; role: string; width: number; row: number; block: number; offset: number; next?: TextCursor };
type LayoutEntry = { raw: RawProjection; text: string; signature: string; sourceLength: number; lines: string[]; fitted?: { width: number; lines: string[]; padded: (string | undefined)[] }; failed: boolean; next?: TextCursor; moreRows: boolean; markdown?: Markdown };
type RowAnchor = { message: Message; index: number; row: number };

/** Reject invalid geometry before allocation; terminal-sized work has a hard ceiling. */
function dimension(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(4_096, Math.floor(value))) : 0; }
type Viewport = { top: number; height: number; width: number; maxScroll: number; thumbTop: number; thumbHeight: number };
type BashExecutionMessage = { role: "bashExecution"; command: string; output: string };
function isBashExecutionMessage(message: { role: string }): message is BashExecutionMessage {
  return message.role === "bashExecution" && "command" in message && typeof message.command === "string"
    && "output" in message && typeof message.output === "string";
}

/** Cut only the already bounded prefix; source-row omissions remain reachable on the next page. */
function sourceEnd(text: string, offset: number, limit: number): number {
  let end = Math.min(text.length, offset + limit);
  const prefix = text.slice(offset, end);
  let rows = 0;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] === "\n" && ++rows === 128) { end = offset + i + 1; break; }
  }
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
  return end;
}

/** Read a bounded source page without joining/scanning earlier or omitted text. */
function boundedMessageText(message: Message, limit: number, cursor: TextCursor): { text: string; calls: string[]; next?: TextCursor; sourceLength: number } {
  const content = isBashExecutionMessage(message) ? message.output : "content" in message ? message.content : "";
  if (typeof content === "string") {
    const end = sourceEnd(content, cursor.offset, limit);
    return { text: content.slice(cursor.offset, end), calls: [], sourceLength: content.length,
      next: end < content.length ? { block: 0, offset: end } : undefined };
  }
  if (!Array.isArray(content)) return { text: "", calls: [], sourceLength: 0 };
  let text = "";
  const calls: string[] = [];
  let sourceLength = 0;
  let spent = 0;
  let blockIndex = cursor.block;
  let offset = cursor.offset;
  for (let visited = 0; blockIndex < content.length && visited < MAX_BLOCKS; visited++, blockIndex++) {
    const block = content[blockIndex];
    const part = block.type === "text" ? block.text : block.type === "toolCall" && message.role === "assistant" ? block.name : undefined;
    if (part === undefined) { offset = 0; continue; }
    sourceLength += part.length;
    const remaining = limit - spent - 1;
    if (remaining <= 0) break;
    const end = sourceEnd(part, offset, remaining);
    const chunk = part.slice(offset, end);
    if (block.type === "text") text += (text ? "\n" : "") + chunk;
    else calls.push(chunk);
    spent += chunk.length + 1;
    if (end < part.length) { offset = end; break; }
    offset = 0;
  }
  return { text, calls, sourceLength, next: blockIndex < content.length ? { block: blockIndex, offset } : undefined };
}

export class ConversationViewer implements Component, Focusable {
  private hasFocus = false;
  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) {
    this.hasFocus = value;
    if (this.composer) this.composer.focused = value;
  }
  private readonly fullscreen: boolean;
  private layouts = new Map<Message, LayoutEntry>();
  private pages = new Map<Message, MessagePage>();
  private rowAnchors: (RowAnchor | undefined)[] = [];
  private anchor: RowAnchor | undefined;
  /** Explicit text selection is independent of the viewport's first-row anchor. */
  private textTarget: Message | undefined;
  private windowStart = 0;
  private windowEnd = 0;
  private windowBackwards = true;
  private composerRow = -1;
  private layoutWidth = 0;
  private compactionCount = 0;
  private firstMessage: Message | undefined;
  private messageCount = 0;
  private newMessages = 0;
  private controlError: string | undefined;
  private handoffArmed = false;
  private viewport: Viewport | undefined;
  private scrollbarGrabOffset: number | undefined;
  private footerTargets: { start: number; end: number; key: string }[] = [];
  private footerRow = -1;
  private latestTarget: { row: number; start: number; end: number } | undefined;
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  private stopArmed = false;
  private keys: ViewerKeys;
  private composer: Input | undefined;
  private steerError: string | undefined;
  private sending = false;

  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecordSnapshot,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    private onStop?: () => void,
    keybindings?: ViewerKeybindings,
    private onSteer?: SteerHandler,
    private getRecord?: () => AgentRecordSnapshot | undefined,
    private options: ViewerOptions = {},
  ) {
    this.fullscreen = getConversationViewerMode(tui, options) === "fullscreen";
    this.keys = createViewerKeys(keybindings);
    this.unsubscribe = session.subscribe(() => {
      if (!this.closed) this.tui.requestRender();
    });
  }

  private refreshRecord(): AgentRecordSnapshot {
    try {
      const current = this.getRecord?.();
      // Never bind controls/status to a different agent if the owner changes selection.
      if (current?.id === this.record.id) this.record = current;
    } catch { /* a disposed owner cannot erase the retained snapshot */ }
    return this.record;
  }

  handleInput(data: string): void {
    if (this.closed || isKeyRelease(data)) return;
    // Ctrl+End is observer-owned even while composing; plain End stays an editing key.
    if (matchesKey(data, "ctrl+end")) { this.jumpToLatest(); return; }
    if (this.composer) {
      if (!this.sending || matchesKey(data, "escape")) this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "escape") && (this.stopArmed || this.handoffArmed)) {
      this.stopArmed = false; this.handoffArmed = false; this.controlError = undefined;
      this.tui.requestRender(); return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.dispose(); this.done(undefined); return;
    }
    // A DIFFERENT key confirms. Legacy raw typematic b/b, x/x and Enter cannot execute controls.
    if (matchesKey(data, "y") && (this.stopArmed || this.handoffArmed)) {
      if (isKeyRepeat(data)) return;
      if (this.handoffArmed) {
        if (!this.canHandoff()) this.controlError = "Handoff unavailable; still foreground · y retry · Esc cancel";
        else {
          try {
            if (this.options.onHandoff?.() === false) this.controlError = "Handoff failed; still foreground · y retry · Esc cancel";
            else { this.handoffArmed = false; this.controlError = undefined; }
          } catch { this.controlError = "Handoff failed; still foreground · y retry · Esc cancel"; }
        }
      } else if (!this.isStoppable()) this.controlError = "Stop unavailable · y retry · Esc cancel";
      else {
        try { this.onStop?.(); this.stopArmed = false; this.controlError = undefined; }
        catch { this.controlError = "Stop failed · y retry · Esc cancel"; }
      }
      this.tui.requestRender(); return;
    }
    if (matchesKey(data, "b") && this.canHandoff()) {
      if (!isKeyRepeat(data)) { this.stopArmed = false; this.handoffArmed = true; this.controlError = undefined; }
      this.tui.requestRender(); return;
    }
    // An unavailable b is an ordinary navigation key and disarms BOTH controls.
    if (matchesKey(data, "x") && this.isStoppable()) {
      if (!isKeyRepeat(data)) { this.handoffArmed = false; this.stopArmed = true; this.controlError = undefined; }
      this.tui.requestRender(); return;
    }
    if (matchesKey(data, "enter") && (this.stopArmed || this.handoffArmed)) return;
    this.stopArmed = false; this.handoffArmed = false; this.controlError = undefined;
    if (matchesKey(data, "enter") && this.canSteer()) { this.openComposer(); return; }
    if (matchesKey(data, "]") || matchesKey(data, "[")) {
      this.pageMessage(matchesKey(data, "]")); return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.buildContentLines(this.lastInnerW);
      const candidates = this.pagingCandidates();
      const target = this.pagingAnchor();
      const current = candidates.findIndex(row => row.message === target?.message);
      const step = matchesKey(data, "shift+tab") ? -1 : 1;
      const index = current < 0 ? step > 0 ? 0 : candidates.length - 1 : (current + step + candidates.length) % candidates.length;
      const selected = candidates[index];
      if (selected) { this.textTarget = selected.message; this.autoScroll = false; this.rememberAnchor(); }
      this.tui.requestRender(); return;
    }
    const height = Math.max(1, this.viewportHeight());
    if (this.keys.scrollUp(data)) this.moveScroll(-1);
    else if (this.keys.scrollDown(data)) this.moveScroll(1);
    else if (this.keys.pageUp(data)) this.moveScroll(-height);
    else if (this.keys.pageDown(data)) this.moveScroll(height);
    else if (matchesKey(data, "home")) {
      this.autoScroll = false; this.windowBackwards = false; this.windowStart = 0;
      this.anchor = undefined; this.textTarget = undefined; this.pages.clear(); this.scrollOffset = 0;
      this.buildContentLines(this.lastInnerW); this.rememberAnchor();
    } else if (matchesKey(data, "end")) { this.jumpToLatest(); return; }
    this.tui.requestRender();
  }

  private jumpToLatest(): void {
    this.autoScroll = true;
    this.anchor = undefined;
    this.textTarget = undefined;
    this.windowBackwards = true;
    this.scrollOffset = Math.max(0, this.buildContentLines(this.lastInnerW).length - this.viewportHeight());
    this.newMessages = 0;
    this.stopArmed = false;
    this.handoffArmed = false;
    this.controlError = undefined;
    this.tui.requestRender();
  }

  private rememberAnchor(): void {
    let index = this.scrollOffset;
    while (index < this.rowAnchors.length && !this.rowAnchors[index]) index++;
    if (index === this.rowAnchors.length) {
      index = Math.min(this.scrollOffset, this.rowAnchors.length - 1);
      while (index >= 0 && !this.rowAnchors[index]) index--;
    }
    const anchor = this.rowAnchors[index];
    this.anchor = anchor ? { ...anchor, row: anchor.row + this.scrollOffset - index } : undefined;
  }

  private moveScroll(delta: number): void {
    let lines = this.buildContentLines(this.lastInnerW);
    const height = Math.max(1, this.viewportHeight());
    let max = Math.max(0, lines.length - height);
    let target = this.scrollOffset + delta;
    this.autoScroll = false;
    if (target < 0 && this.windowStart > 0) {
      const overlap = this.windowStart;
      this.windowEnd = overlap + 1;
      this.windowBackwards = true; this.anchor = undefined;
      lines = this.buildContentLines(this.lastInnerW);
      max = Math.max(0, lines.length - height);
      const start = this.rowAnchors.findIndex(row => row?.index === overlap);
      target = Math.max(0, start) + target;
    } else if (target > max && this.windowEnd < this.messageCount) {
      this.windowStart = this.windowEnd;
      this.windowBackwards = false; this.anchor = undefined;
      lines = this.buildContentLines(this.lastInnerW);
      target = Math.max(0, target - max - 1);
      max = Math.max(0, lines.length - height);
    }
    this.scrollOffset = Math.max(0, Math.min(max, target));
    this.autoScroll = delta > 0 && this.scrollOffset === max && this.windowEnd === this.messageCount;
    if (this.autoScroll) this.newMessages = 0;
    this.rememberAnchor();
  }

  private canPageMessage(message: Message): boolean {
    const entry = this.layouts.get(message);
    return !!(entry?.moreRows || entry?.next || this.pages.has(message));
  }

  /** Only visible messages with source/render continuation or a retained page are selectable. */
  private pagingCandidates(): RowAnchor[] {
    const seen = new Set<Message>();
    return this.rowAnchors.slice(this.scrollOffset, this.scrollOffset + this.viewportHeight()).filter((row): row is RowAnchor => {
      if (!row || seen.has(row.message) || !this.canPageMessage(row.message)) return false;
      seen.add(row.message); return true;
    });
  }

  private pagingAnchor(): RowAnchor | undefined {
    // Never silently switch an explicit selection, even at its final page.
    if (this.textTarget) {
      const visible = this.rowAnchors.find(row => row?.message === this.textTarget);
      if (visible) return visible;
      const index = this.session.messages.indexOf(this.textTarget);
      return index >= 0 ? { message: this.textTarget, index, row: 0 } : undefined;
    }
    const entry = this.anchor && this.layouts.get(this.anchor.message);
    if (entry?.moreRows || entry?.next) return this.anchor;
    const candidates = this.pagingCandidates();
    return candidates.find(row => {
      const layout = this.layouts.get(row.message);
      return layout?.moreRows || layout?.next;
    }) ?? candidates[0];
  }

  /** ] advances the selected bounded row/source page; [ returns to its first page. */
  private pageMessage(next: boolean): void {
    this.buildContentLines(this.lastInnerW);
    this.rememberAnchor();
    const anchor = this.pagingAnchor();
    if (!anchor) return;
    if (!this.rowAnchors.some(row => row?.message === anchor.message)) {
      // Restore an evicted selection without laying out any intervening history.
      this.autoScroll = false;
      this.anchor = { ...anchor, row: 0 };
      this.windowStart = anchor.index; this.windowBackwards = false;
      this.buildContentLines(this.lastInnerW);
      this.tui.requestRender();
    }
    const entry = this.layouts.get(anchor.message);
    const page = this.pages.get(anchor.message) ?? { cursor: { block: 0, offset: 0 }, row: 0 };
    if (!next) this.pages.delete(anchor.message);
    else if (entry?.moreRows) this.pages.set(anchor.message, { ...page, row: page.row + MAX_MESSAGE_ROWS - 2 });
    else if (entry?.next) this.pages.set(anchor.message, { cursor: entry.next, row: 0 });
    else return;
    this.autoScroll = false;
    this.textTarget = anchor.message;
    this.anchor = { ...anchor, row: 0 };
    this.layouts.delete(anchor.message);
    this.buildContentLines(this.lastInnerW);
    this.tui.requestRender();
  }

  /** Public normalized events only; regular terminals retain terminal-owned mouse input. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
    // Floating viewers on native fullscreen hosts still receive normalized overlay-local events.
    if (getConversationViewerMode(this.tui) !== "fullscreen") return { handled: false };
    if (this.closed) return { handled: true, render: false };
    if (event.type === "press" && event.button === "left") {
      if (event.y === this.footerRow) {
        const target = this.footerTargets.find(t => event.x >= t.start && event.x < t.end);
        if (target) this.handleInput(target.key);
        return { handled: true, focus: true, render: true };
      }
      if (this.composer && event.y === this.composerRow && !this.sending) {
        // Input's public mouse contract currently reserves two prompt columns even for prompt:"".
        const left = this.fullscreen ? event.width < 3 ? 0 : 1 : 2;
        const result = this.composer.handleMouse({ ...event, x: event.x - left + 2, y: 0, width: this.lastInnerW, height: 1 });
        return { ...result, handled: true, render: result?.render ?? true };
      }
    }
    // Footer/composer remain interactive even when there is no transcript viewport.
    if (!this.viewport) return { handled: true, render: false };
    const view = this.viewport;
    const onRail = event.x === view.width - 1 && event.y >= view.top && event.y < view.top + view.height && view.maxScroll > 0;
    const scrollTo = (offset: number, up = false): void => {
      this.moveScroll(offset - this.scrollOffset);
      if (up) this.autoScroll = false;
      this.rememberAnchor();
      this.stopArmed = false;
      this.handoffArmed = false;
      this.controlError = undefined;
      this.tui.requestRender();
    };
    if (event.type === "wheel") {
      const delta = event.wheelDelta ?? 0;
      scrollTo(this.scrollOffset + delta, delta < 0);
      return { handled: true, render: true };
    }
    if (event.type === "release") {
      this.scrollbarGrabOffset = undefined;
      return { handled: true, render: true };
    }
    if (event.type === "drag" && this.scrollbarGrabOffset !== undefined) {
      const travel = view.height - view.thumbHeight;
      const position = Math.max(0, Math.min(travel, event.y - view.top - this.scrollbarGrabOffset));
      scrollTo(travel > 0 ? Math.round(position / travel * view.maxScroll) : 0);
      return { handled: true, render: true };
    }
    // Act on press, never again on the renderer's synthesized click/release.
    if (event.type === "press" && event.button === "left") {
      const latest = this.latestTarget;
      if (latest && event.y === latest.row && event.x >= latest.start && event.x < latest.end) this.jumpToLatest();
      else if (onRail) {
        const y = event.y - view.top;
        if (y >= view.thumbTop && y < view.thumbTop + view.thumbHeight) this.scrollbarGrabOffset = y - view.thumbTop;
        else {
          scrollTo(this.scrollOffset + (y < view.thumbTop ? -view.height : view.height), y < view.thumbTop);
          this.scrollbarGrabOffset = Math.floor(view.thumbHeight / 2);
        }
        return { handled: true, capture: true, render: true };
      } else if (!this.composer && event.y >= view.top && event.y < view.top + view.height) {
        const selected = this.rowAnchors[this.scrollOffset + event.y - view.top];
        if (selected && this.canPageMessage(selected.message)) {
          this.textTarget = selected.message; this.autoScroll = false; this.rememberAnchor();
          this.stopArmed = false; this.handoffArmed = false; this.controlError = undefined;
          this.tui.requestRender();
        }
      }
      return { handled: true, render: true };
    }
    return { handled: true, render: false };
  }

  render(width: number): string[] {
    this.footerTargets = [];
    this.latestTarget = undefined;
    this.viewport = undefined;
    this.footerRow = -1; this.composerRow = -1;
    if (this.closed) return [];
    width = dimension(width);
    if (!this.fullscreen && width < 6) return [];
    const rows = this.maxOverlayRows();
    if (width === 0) return this.fullscreen ? Array.from({ length: rows }, () => "") : [];
    this.refreshRecord();
    if (!this.fullscreen && rows < this.chromeLines() + 1) return [];
    if (rows === 0) return [];
    const th = this.theme;
    const innerW = this.fullscreen ? width < 3 ? width : width - 2 : width - 4;
    this.lastInnerW = innerW;
    const row = (content: string, rail = " ", cached?: string) => {
      const fitted = cached ?? truncateToWidth(content, innerW, "…", true);
      return this.fullscreen ? width < 3 ? fitted : ` ${fitted}${rail}` : `${th.fg("borderAccent", "│")} ${fitted} ${th.fg("borderAccent", "│")}`;
    };
    const rule = (left: string, right: string) => th.fg("borderAccent", `${left}${"─".repeat(Math.max(0, width - 2))}${right}`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));
    const lines: string[] = [];
    if (!this.fullscreen) lines.push(rule("╭", "╮"));
    const name = renderAgentName(this.record.type, th, { bold: true });
    const modeLabel = getPromptModeLabel(this.record.type);
    const stats: string[] = [formatDuration(this.record.startedAt, this.record.completedAt)];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) stats.unshift(`tools ${toolUses}`);
    const tokens = getLifetimeTotal(this.activity?.lifetimeUsage ?? this.record.lifetimeUsage);
    if (tokens > 0 || this.record.compactionCount > 0) {
      stats.push(formatSessionTokens(tokens, getSessionContextPercent(this.activity?.session ?? this.session), th, this.record.compactionCount));
    }
    const headerParts = [
      th.fg(getAgentStatusColor(this.record.status), `${getAgentStatusMark(this.record.status)} ${getAgentStatusLabel(this.record.status)}`),
      name,
      modeLabel ? th.fg("dim", `mode ${modeLabel}`) : undefined,
      th.fg("muted", sanitizeDisplayText(this.record.description.slice(0, MAX_MESSAGE_CHARS))),
      fgPreservingNestedStyles(th, "dim", stats.join(" · ")),
    ].filter((part): part is string => part !== undefined);
    lines.push(row(headerParts.join(th.fg("dim", " · "))));
    const invocation = this.invocationLine();
    if (invocation) lines.push(row(invocation));
    lines.push(hrMid);
    const contentLines = this.buildContentLines(innerW);
    const height = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - height);
    this.scrollOffset = this.autoScroll ? maxScroll : Math.min(this.scrollOffset, maxScroll);
    if (this.autoScroll) this.newMessages = 0;
    this.rememberAnchor();
    const textTarget = this.pagingAnchor();
    if (textTarget && !this.composer) {
      const entry = this.layouts.get(textTarget.message);
      const continuation = entry?.moreRows || entry?.next;
      lines[lines.length - 1] = row(th.fg("dim", `Text #${textTarget.index + 1} ${textTarget.message.role} · ${continuation ? "] next · " : ""}[ first · Tab/Shift+Tab target · click message`));
    }
    const visible = contentLines.slice(this.scrollOffset, this.scrollOffset + height);
    const thumbHeight = Math.min(height, Math.max(2, Math.round(height * height / Math.max(1, contentLines.length))));
    const thumbTop = maxScroll > 0 ? Math.round(this.scrollOffset / maxScroll * (height - thumbHeight)) : 0;
    this.viewport = { width, top: lines.length, height, maxScroll, thumbTop, thumbHeight };
    for (let i = 0; i < height; i++) {
      const thumb = i >= thumbTop && i < thumbTop + thumbHeight;
      const rail = this.fullscreen && maxScroll > 0 ? th.fg(thumb ? "accent" : "dim", thumb ? "┃" : "│") : " ";
      const anchor = this.rowAnchors[this.scrollOffset + i];
      const entry = anchor && this.layouts.get(anchor.message);
      const fitted = entry?.fitted;
      let padded: string | undefined;
      if (anchor && fitted?.width === innerW) {
        padded = fitted.padded[anchor.row];
        if (padded === undefined) {
          padded = truncateToWidth(visible[i] ?? "", innerW, "…", true);
          fitted.padded[anchor.row] = padded;
        }
      }
      // Only transcript fitting is cached; rails, chrome and runtime state stay live.
      lines.push(row(visible[i] ?? "", rail, padded));
    }
    if (!this.autoScroll && (maxScroll > 0 || this.windowEnd < this.messageCount)) {
      const text = this.newMessages > 0 ? `${this.newMessages} new message${this.newMessages === 1 ? "" : "s"}` : "Jump to latest";
      const label = truncateToWidth(`[ ↓ ${text} · Ctrl+End ]`, innerW, "…");
      const labelWidth = visibleWidth(label);
      const padding = Math.floor((innerW - labelWidth) / 2);
      this.latestTarget = { row: lines.length, start: padding + 1, end: padding + 1 + labelWidth };
      lines.push(row(th.fg("dim", "─".repeat(padding)) + th.fg("accent", label) + th.fg("dim", "─".repeat(innerW - padding - labelWidth))));
    } else lines.push(hrMid);
    const footerActions: { label: string; key: string }[] = [];
    if (this.composer) {
      this.composer.focused = this.focused;
      lines.push(row(this.composer.render(innerW)[0] ?? ""));
      footerActions.push({ label: "Enter send", key: "\r" }, { label: "Esc cancel", key: "\x1b" });
      lines.push(row(th.fg(this.steerError ? "error" : "dim", this.sending ? "Sending... · Esc cancel" : this.steerError ?? "Enter send · Esc cancel")));
    } else {
      if (this.canSteer()) footerActions.push({ label: "Enter chat", key: "\r" });
      if (this.stopArmed || this.handoffArmed) {
        footerActions.length = 0;
        footerActions.push({ label: this.controlError ? "y retry" : this.stopArmed ? "y confirm STOP" : "y confirm background", key: "y" }, { label: "Esc cancel", key: "\x1b" });
      } else {
        if (this.isStoppable()) footerActions.push({ label: "x stop", key: "x" });
        if (this.canHandoff()) footerActions.push({ label: "b background", key: "b" });
        footerActions.push({ label: "Esc close", key: "\x1b" });
      }
      const actions = footerActions.map(action => th.fg(action.key === "y" ? "warning" : "dim", action.label));
      const percent = contentLines.length <= height ? 100 : Math.round((this.scrollOffset + height) / contentLines.length * 100);
      const controls = actions.join(th.fg("dim", " · "));
      const navigation = th.fg("dim", `↑↓ scroll · PgUp/PgDn · Home first · End latest · ] next text · [ first text · ${percent}% window`);
      const gap = Math.max(1, innerW - visibleWidth(controls) - visibleWidth(navigation));
      lines.push(row(this.controlError ? th.fg("error", this.controlError) : controls + " ".repeat(gap) + navigation));
    }
    const footer = lines.pop() ?? row("");
    const composerLine = this.composer ? lines.pop() : undefined;
    // At heights 1–5 chrome yields to the footer and, at >=2 rows, the actual draft/cursor.
    const reserved = composerLine !== undefined && rows >= 2 ? 2 : 1;
    const output = this.fullscreen
      ? [...lines.slice(0, Math.max(0, rows - reserved)), ...(reserved === 2 ? [composerLine ?? row("")] : []), footer]
      : [...lines, ...(composerLine !== undefined ? [composerLine] : []), footer, rule("╰", "╯")];
    this.footerRow = output.length - (this.fullscreen ? 1 : 2);
    this.composerRow = composerLine !== undefined && (!this.fullscreen || reserved === 2) ? this.footerRow - 1 : -1;
    if (this.viewport.top + this.viewport.height > (this.composerRow >= 0 ? this.composerRow : this.footerRow) || this.viewport.height === 0) this.viewport = undefined;
    const footerText = stripTerminalSequences(footer);
    for (const action of footerActions) {
      const index = footerText.indexOf(action.label);
      if (index < 0) continue;
      const start = visibleWidth(footerText.slice(0, index));
      this.footerTargets.push({ start, end: start + visibleWidth(action.label), key: action.key });
    }
    return output;
  }

  private canHandoff(): boolean {
    const record = this.refreshRecord();
    if (record.status !== "running" || record.detached || !this.options.onHandoff) return false;
    try { return this.options.canHandoff?.() === true; } catch { return false; }
  }
  private isStoppable(): boolean {
    const record = this.refreshRecord();
    return !record.detached && !!this.onStop && (record.status === "running" || record.status === "queued");
  }
  private canSteer(): boolean {
    const record = this.refreshRecord();
    return !record.detached && !!this.onSteer && (record.status === "running" || record.status === "queued");
  }

  private openComposer(): void {
    const input = new Input({ prompt: "" });
    this.controlError = undefined;
    input.focused = this.focused;
    this.steerError = undefined;
    this.handoffArmed = false;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      if (!message) { this.composer = undefined; this.tui.requestRender(); return; }
      if (!this.canSteer()) {
        this.steerError = "Agent finished; draft retained · Esc cancel";
        this.tui.requestRender();
        return;
      }
      this.steerError = undefined;
      const settle = (accepted: SteerAcceptance): void => {
        if (this.closed || this.composer !== input) return;
        this.sending = false;
        if (accepted === false) this.steerError = "Steering rejected; draft retained · Esc cancel";
        else this.composer = undefined;
        this.tui.requestRender();
      };
      try {
        const result = this.onSteer?.(message);
        if (result && typeof result === "object") { this.sending = true; void result.then(settle, () => settle(false)); }
        else settle(result);
      } catch { settle(false); }
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.steerError = undefined;
      this.sending = false;
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  invalidate(): void { this.layouts.clear(); this.composer?.invalidate(); }
  dispose(): void {
    this.closed = true;
    this.layouts.clear();
    this.pages.clear(); this.rowAnchors = []; this.anchor = undefined; this.textTarget = undefined;
    this.composer = undefined;
    this.viewport = undefined;
    this.footerTargets = [];
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
  private maxOverlayRows(): number {
    const rows = dimension(this.tui.terminal.rows);
    return this.fullscreen ? rows : Math.floor(rows * VIEWPORT_HEIGHT_PCT / 100);
  }
  private viewportHeight(): number { return Math.max(this.fullscreen ? 0 : 1, this.maxOverlayRows() - this.chromeLines()); }
  private chromeLines(): number { return (this.fullscreen ? 4 : 6) + (this.invocationLine() ? 1 : 0) + (this.composer ? 1 : 0); }
  private invocationLine(): string | undefined {
    const { modelName, tags } = buildInvocationTags(this.record.invocation);
    const parts = modelName ? [modelName, ...tags] : tags;
    if (parts.length === 0) return undefined;
    return this.theme.fg("dim", `  invocation · ${parts.map(part => sanitizeDisplayText(part.slice(0, MAX_MESSAGE_CHARS))).join(" · ")}`);
  }

  private markdownTheme(): MarkdownTheme {
    const fg = (color: string) => (text: string) => this.theme.fg(color, text);
    return { heading: this.theme.bold.bind(this.theme), link: fg("accent"), linkUrl: fg("dim"), code: fg("accent"),
      codeBlock: fg("text"), codeBlockBorder: fg("dim"), quote: fg("muted"), quoteBorder: fg("dim"), hr: fg("dim"),
      listBullet: fg("accent"), bold: this.theme.bold.bind(this.theme), italic: fg("text"), strikethrough: fg("dim"), underline: fg("text") };
  }

  private messageLines(msg: Message, width: number): string[] {
    const preview = msg.role === "toolResult" || isBashExecutionMessage(msg);
    let page = this.pages.get(msg) ?? { cursor: { block: 0, offset: 0 }, row: 0 };
    const content = isBashExecutionMessage(msg) ? msg.output : "content" in msg ? msg.content : "";
    const block = Array.isArray(content) ? content[page.cursor.block] : undefined;
    const part = typeof content === "string" ? content : block?.type === "text" ? block.text : block?.type === "toolCall" ? block.name : undefined;
    // A shortened/replaced source must not leave a retained cursor beyond all available text.
    if (page.cursor.offset > 0 && (part === undefined || page.cursor.offset >= part.length) || Array.isArray(content) && page.cursor.block >= content.length) {
      this.pages.delete(msg);
      page = { cursor: { block: 0, offset: 0 }, row: 0 };
    }
    // Narrow widths reduce the raw input bound, BEFORE Markdown/wrapping can expand it.
    const source = boundedMessageText(msg, preview ? PREVIEW_SCAN_LIMIT : Math.min(MAX_MESSAGE_CHARS, Math.max(128, width * 16)), preview ? { block: 0, offset: 0 } : page.cursor);
    const commandSource = isBashExecutionMessage(msg) ? msg.command.slice(0, MAX_MESSAGE_CHARS) : "";
    let entry = this.layouts.get(msg);
    const shortened = !!entry && source.sourceLength < entry.sourceLength;
    const raw: RawProjection = { text: source.text, calls: source.calls, command: commandSource, role: msg.role, width,
      row: page.row, block: page.cursor.block, offset: page.cursor.offset, next: source.next };
    const previous = entry?.raw;
    // Compare bounded VALUES, not message/block identity: streams mutate existing objects.
    // Keep the sanitized-signature/failure path below for every raw projection change.
    if (entry && previous && !shortened && previous.text === raw.text && previous.command === raw.command
      && previous.role === raw.role && previous.width === raw.width && previous.row === raw.row
      && previous.block === raw.block && previous.offset === raw.offset
      && previous.next?.block === raw.next?.block && previous.next?.offset === raw.next?.offset
      && previous.calls.length === raw.calls.length && previous.calls.every((call, i) => call === raw.calls[i])) {
      entry.sourceLength = source.sourceLength; entry.next = preview ? undefined : source.next; return entry.lines;
    }
    const safe = safeTerminalText(source.text);
    const capped = preview ? truncateCodePoints(safe, PREVIEW_CHARS, "") : safe;
    const text = capped.trim();
    const omitted = !!source.next || capped.length < safe.length;
    const calls = source.calls.map(call => sanitizeDisplayText(call));
    const command = commandSource ? sanitizeDisplayText(commandSource) : "";
    const signature = `${msg.role}\0${text}\0${omitted}\0${command}\0${calls.join("\0")}\0${page.row}\0${page.cursor.block}:${page.cursor.offset}`;
    if (entry?.signature === signature && !shortened) { entry.raw = raw; entry.sourceLength = source.sourceLength; entry.next = preview ? undefined : source.next; return entry.lines; }
    const failed = !!entry?.failed && !shortened && text.startsWith(entry.text);
    entry = { raw, text, signature, sourceLength: source.sourceLength, lines: [], failed, next: preview ? undefined : source.next, moreRows: false, markdown: entry?.markdown };
    if (!this.layouts.has(msg) && this.layouts.size >= MAX_MESSAGES) this.layouts.delete(this.layouts.keys().next().value as Message);
    this.layouts.set(msg, entry);
    if (!text && calls.length === 0 && !command && !source.next) return [];
    const heading = msg.role === "user" ? this.theme.fg("accent", "User") : msg.role === "assistant" ? this.theme.bold("Assistant")
      : msg.role === "toolResult" ? this.theme.fg("dim", "Result") : this.theme.fg("muted", `Command: ${command}`);
    let body: string[] = [];
    if (text) {
      if (msg.role === "assistant" && !entry.failed) {
        try {
          entry.markdown ??= new Markdown(text, 0, 0, this.markdownTheme());
          entry.markdown.setText(text);
          body = entry.markdown.render(width);
        } catch { entry.failed = true; }
      }
      if (msg.role !== "assistant" || entry.failed) body = wrapTextWithAnsi(text, width);
    }
    if (preview) body = body.map(line => this.theme.fg("dim", line));
    const rendered = [...body, ...calls.flatMap(name => wrapTextWithAnsi(`Tool: ${name}`, width).map(line => this.theme.fg("muted", line)))];
    const capacity = MAX_MESSAGE_ROWS - 2; // ALWAYS reserve heading and an accurate paging/omission marker.
    const pageStart = Math.min(page.row, Math.max(0, rendered.length - 1));
    entry.moreRows = pageStart + capacity < rendered.length;
    const more = entry.moreRows || (!preview && omitted);
    const marker = more ? "] next text · [ first text (more available)" : preview && omitted ? "... (truncated preview)" : page.cursor.block || page.cursor.offset || page.row ? "[ first text" : "";
    // Even at one content column, > denotes available continuation, ~ a truncated preview.
    const markerLine = width < 8 ? more ? ">" : preview && omitted ? "~" : "[" : marker;
    entry.lines = [heading, ...rendered.slice(pageStart, pageStart + capacity), ...(marker ? [this.theme.fg("dim", markerLine)] : [])]
      .map(line => truncateToWidth(line, width));
    return entry.lines;
  }

  private buildContentLines(width: number): string[] {
    width = dimension(width);
    if (width <= 0) return [];
    let messages: AgentSession["messages"];
    try { messages = this.session.messages; } catch { messages = []; }
    const compacted = messages.length < this.messageCount || messages[0] !== this.firstMessage || this.compactionCount !== this.record.compactionCount;
    const resized = width !== this.layoutWidth;
    if (resized || compacted) this.layouts.clear();
    if (resized) {
      // Wrapping rows belong to the old width/source bound, unlike raw cursors.
      // Repeating the current source chunk is safer than skipping unread text.
      for (const [message, page] of this.pages) if (page.row) this.pages.set(message, { ...page, row: 0 });
    }
    if (this.textTarget && !messages.includes(this.textTarget)) this.textTarget = undefined;
    if (!this.autoScroll && !compacted) this.newMessages += Math.max(0, messages.length - this.messageCount);
    if (compacted) this.newMessages = 0;
    this.messageCount = messages.length;
    this.firstMessage = messages[0];
    this.compactionCount = this.record.compactionCount;
    this.layoutWidth = width;
    // Only references are searched; no global text layout, joining or length scans.
    if (!this.autoScroll && this.anchor) {
      let index = messages.indexOf(this.anchor.message);
      if (index < 0) index = Math.min(this.anchor.index, Math.max(0, messages.length - 1));
      const message = messages[index];
      if (message) {
        this.anchor = { ...this.anchor, message, index };
        if (compacted || index < this.windowStart || index >= this.windowEnd) {
          this.windowStart = index; this.windowBackwards = false;
        }
      }
    }
    if (this.autoScroll) { this.windowEnd = messages.length; this.windowBackwards = true; }
    this.windowStart = Math.max(0, Math.min(this.windowStart, Math.max(0, messages.length - 1)));
    this.windowEnd = Math.max(0, Math.min(this.windowEnd, messages.length));
    const groups: { message: Message; index: number; lines: string[] }[] = [];
    let count = 0;
    const backwards = this.windowBackwards;
    let index = backwards ? this.windowEnd - 1 : this.windowStart;
    let visited = 0;
    while (index >= 0 && index < messages.length && visited < MAX_MESSAGES) {
      const message = messages[index];
      visited++;
      if (["user", "assistant", "toolResult", "bashExecution"].includes(message.role)) {
        const group = this.messageLines(message, width);
        if (count + group.length + 1 > MAX_CONTENT_ROWS - 4) { this.layouts.delete(message); break; }
        groups.push({ message, index, lines: group });
        count += group.length + 1;
      }
      index += backwards ? -1 : 1;
    }
    if (backwards) { this.windowStart = Math.max(0, index + 1); groups.reverse(); }
    else this.windowEnd = Math.min(messages.length, index);
    const current = new Set(groups.map(group => group.message));
    for (const message of this.layouts.keys()) if (!current.has(message)) this.layouts.delete(message);
    // At most the current window's pages plus one explicitly selected cursor.
    for (const message of this.pages.keys()) if (!current.has(message) && message !== this.textTarget) this.pages.delete(message);
    const lines: string[] = [];
    this.rowAnchors = [];
    const append = (line: string, anchor?: RowAnchor): void => { lines.push(truncateToWidth(line, width)); this.rowAnchors.push(anchor); };
    if (this.windowStart > 0) append(width < 8 ? "↑" : "↑ older messages available · scroll up / Home");
    for (const group of groups) {
      if (!group.lines.length) continue;
      if (lines.length) append("");
      const entry = this.layouts.get(group.message);
      // Retain the independent second width safeguard, but fit each layout only once.
      const fitted = entry?.fitted?.width === width ? entry.fitted.lines : group.lines.map(line => truncateToWidth(line, width));
      if (entry && entry.fitted?.width !== width) entry.fitted = { width, lines: fitted, padded: [] };
      fitted.forEach((line, row) => { lines.push(line); this.rowAnchors.push({ message: group.message, index: group.index, row }); });
    }
    if (this.windowEnd < messages.length) append(width < 8 ? "↓" : "↓ newer messages available · scroll down / End");
    if (!messages.length) append(this.theme.fg("dim", "waiting for first message"));
    if (this.windowEnd === messages.length && this.record.status === "running" && this.activity) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText.slice(0, MAX_MESSAGE_CHARS));
      append(""); append(`${this.theme.fg("accent", "Thinking...")}${this.theme.fg("dim", ` · ${act}`)}`);
    }
    if (!this.autoScroll && this.anchor) {
      const anchor = this.anchor;
      const start = this.rowAnchors.findIndex(row => row?.message === anchor.message);
      if (start >= 0) {
        const length = groups.find(group => group.message === anchor.message)?.lines.length ?? 1;
        this.scrollOffset = Math.max(0, start + Math.min(anchor.row, Math.max(0, length - 1)));
      }
    }
    return lines;
  }
}
