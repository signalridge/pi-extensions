/**
 * fleet-list.ts — Claude Code-style "FleetView" list rendered below the editor.
 *
 * Shows `main` + each running/queued subagent as a navigable list. Pressing down (or
 * left) at an empty prompt activates the list; up/down move the selection,
 * Enter opens the selected agent's live conversation overlay, Esc returns to the prompt.
 * A viewer stays open when its agent finishes; finished agents linger briefly in the list.
 *
 * Mechanics (see plan): the list is a `belowEditor` widget (render-only), and ALL key
 * handling goes through `onTerminalInput` — which fires before the focused editor and
 * can `consume` keys — gated on `getEditorText() === ""` so normal typing is untouched.
 */

import { type Component, isKeyRelease, Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { borderedComponent, sanitizeDisplayText } from "@signalridge/pi-ui";
import { renderAgentName } from "../agent-color.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal } from "../usage.js";
import { type AgentActivity, type Theme } from "./agent-display.js";
import { ConversationViewer, getConversationOverlayOptions, getConversationViewerMode } from "./conversation-viewer.js";
import { type OwnerGroup, OwnerGroupViewer, workflowGroupId } from "./owner-group.js";
import { getAgentStatusColor, getAgentStatusLabel, getAgentStatusMark } from "./status-label.js";
import type { ViewerKeybindings } from "./viewer-keys.js";
import type { WorkflowUiClient } from "./workflow-ui-client.js";

/** Immutable selection, including the attempt generation on a reusable native thread. */
export function captureAgentSelection(manager: AgentManager, record: AgentRecord, isCurrent: () => boolean = () => true) {
  const session = record.session;
  const owner = record.owner ? { ...record.owner } : undefined;
  const snapshot = { ...record, owner, lifetimeUsage: { ...record.lifetimeUsage } };
  const current = (): AgentRecord | undefined => isCurrent() ? manager.listAgentsMutable().find(candidate =>
    candidate.id === snapshot.id && candidate.session === session && !candidate.detached &&
    candidate.owner?.extension === owner?.extension && candidate.owner?.runId === owner?.runId &&
    candidate.owner?.nodeId === owner?.nodeId && candidate.owner?.attemptId === owner?.attemptId) : undefined;
  return { snapshot, session, owner, current };
}
export type AgentSelection = ReturnType<typeof captureAgentSelection>;

/** Widget key for the below-editor fleet list. */
const FLEET_KEY = "fleet";
/** Max agent rows shown at once; extras collapse into a "↓ N more" indicator. */
const MAX_AGENT_ROWS = 5;
/** Re-render cadence so elapsed/token stats tick while agents run. */
const TICK_MS = 200;
/** How long a finished agent lingers in the list before it drops out. */
const FINISHED_LINGER_MS = 4000;

/** Minimal UI surface the FleetView needs from `ctx.ui` (structural subset). */
export type FleetUICtx = {
  setWidget(
    key: string,
    content: undefined | ((tui: TUI, theme: Theme) => { render(width: number): string[]; invalidate(): void; dispose?(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: TUI, theme: Theme, keybindings: ViewerKeybindings, done: (result: T) => void) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
  ): Promise<T>;
};

type MainEntry = { kind: "main"; id: string };
type AgentEntry = { kind: "agent"; id: string; record: AgentRecord };
type FleetEntry = MainEntry | AgentEntry;

/** `11s` — integer seconds, no decimal/suffix (matches Claude Code, unlike formatMs). */
export function formatFleetElapsed(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** Compact token magnitude with a plain text label. */
export function formatFleetTokens(count: number): string {
  let compact: string;
  if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
  else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
  else compact = `${count}`;
  return `${compact} ${count === 1 ? "token" : "tokens"}`;
}

/**
 * Place `right` flush to `width`, truncating `left` first so the stats survive.
 * The final clamp guarantees the line never exceeds `width` (which would wrap and
 * desync pi's line-diff → flicker) even on a terminal too narrow for the stats.
 */
function rightAlign(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(0, width - rightW - 1);
  const leftClamped = truncateToWidth(left, maxLeft);
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

export class FleetList {
  private ui: FleetUICtx | undefined;
  private tui: TUI | undefined;
  private inputUnsub: (() => void) | undefined;
  private widgetRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  private enabled = true;
  /** Whether arrow keys currently navigate the list (vs. flow to the editor). */
  private active = false;
  /** 0 = `main`, 1..N = subagents. */
  private selectedIndex = 0;
  private selectedId = "main";
  private overlayGeneration = 0;
  /** Set while a conversation overlay is open; calling it closes the overlay. */
  private viewerClose: (() => void) | undefined;
  private viewingAgentId: string | undefined;
  private workflowClient: WorkflowUiClient | undefined;
  private externalOpening = false;
  private externalViewingId: string | undefined;
  private externalTimer: ReturnType<typeof setTimeout> | undefined;

  setWorkflowClient(client: WorkflowUiClient | undefined): void {
    this.workflowClient = client;
    this.update();
  }

  /** Shared exact-attempt opener for user selections and the workflow UI endpoint. */
  canOpenConversation(selection: AgentSelection): boolean {
    return !!this.ui && !this.viewerClose && !!selection.session && !!selection.current();
  }

  openConversation(selection: AgentSelection, deferConstruction = false): boolean {
    if (!this.canOpenConversation(selection)) return false;
    this.viewingAgentId = selection.snapshot.id;
    void this.openOverlay((tui, theme, keys, done) => {
      if (!selection.current()) { done(undefined); return { render: () => [], invalidate: () => {} }; }
      return this.conversation(selection, tui, theme, keys, done, undefined, getConversationViewerMode(tui));
    }, "auto", deferConstruction);
    return true;
  }

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
  ) {}

  conversationMode(): "fullscreen" | "overlay" { return getConversationViewerMode(this.tui); }

  // ---- Lifecycle ----

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.active = false;
    this.update();
  }

  /** Capture the UI context and (re)register the global input handler. */
  setUICtx(ui: FleetUICtx): void {
    if (ui === this.ui) return;
    this.dispose();
    this.ui = ui;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.inputUnsub = ui.onTerminalInput(data => this.handleKey(data));
  }

  /** Ensure the re-render timer is running (called when an agent spawns). */
  ensureTimer(): void {
    if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
  }

  /**
   * Called when an agent finishes. The viewer (if open on it) stays open so the
   * final output remains readable, and the row lingers in the list — just refresh.
   */
  onAgentFinished(_id: string): void {
    this.update();
  }

  dispose(): void {
    this.overlayGeneration++;
    if (this.externalTimer) clearTimeout(this.externalTimer);
    this.externalTimer = undefined;
    this.externalOpening = false;
    this.externalViewingId = undefined;
    this.workflowClient = undefined;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    if (this.viewerClose) { this.viewerClose(); this.viewerClose = undefined; }
    this.viewingAgentId = undefined;
    if (this.ui && this.widgetRegistered) this.ui.setWidget(FLEET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.active = false;
    // Null last so a `viewerClose()` microtask above can't re-register the widget.
    this.ui = undefined;
  }

  /** Re-register/refresh the below-editor widget; clears it when no agents remain. */
  update(): void {
    if (!this.ui) return;
    if (this.externalViewingId && !this.externalOpening && this.editorHasFocus()) this.externalViewingId = undefined;
    const hasAgents = this.enabled && this.roster().length > 1;

    if (!hasAgents) {
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      this.active = false;
      this.selectedIndex = 0;
      this.selectedId = "main";
      return;
    }

    this.clampSelection();
    this.ensureTimer(); // keep stats ticking whenever the list is shown (e.g. after a re-enable)

    if (!this.widgetRegistered) {
      this.ui.setWidget(FLEET_KEY, (tui, theme) => {
        this.tui = tui;
        return {
          render: (w: number) => this.renderBar(w, theme),
          invalidate: () => { /* no render cache; mounting/focus remain owned */ },
          dispose: () => { if (this.tui === tui) { this.widgetRegistered = false; this.tui = undefined; } },
        };
      }, { placement: "belowEditor" });
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  // ---- Roster ----

  /**
   * Agents shown in the list, ordered earliest-launched first so the ones you
   * started sooner sit at the top. Every row is openable (has a session), so Enter
   * never dead-ends. Included: running/queued, plus the agent currently being
   * viewed, plus recently-finished ones (they linger briefly before dropping out).
   * Pending agents with no session yet are hidden until they start.
   * (`listAgents()` is newest-first, so we re-sort.)
   */
  private agentRecords(): AgentRecord[] {
    const now = Date.now();
    return this.manager.listAgentsMutable()
      .filter(a => !a.parentAgentId && !a.detached && !workflowGroupId(a) && a.session && (
        a.status === "running" || a.status === "queued"
        || a.id === this.viewingAgentId
        || (a.completedAt != null && now - a.completedAt < FINISHED_LINGER_MS)
      ))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Explicit /agents fallback only; workflow rows never enter the passive Fleet. */
  retainedWorkflowGroups(): OwnerGroup[] {
    const groups = new Map<string, OwnerGroup>();
    for (const record of this.manager.listAgentsMutable()) {
      if (record.parentAgentId || record.detached) continue;
      const id = workflowGroupId(record);
      if (!id) continue;
      let group = groups.get(id);
      if (!group) { group = { id, runId: record.owner!.runId, records: [] }; groups.set(id, group); }
      group.records.push(record);
    }
    for (const group of groups.values()) group.records.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
    return [...groups.values()];
  }

  private roster(): FleetEntry[] {
    return [
      { kind: "main", id: "main" },
      ...this.agentRecords().map(record => ({ kind: "agent" as const, id: `agent:${record.id}`, record })),
    ];
  }

  private clampSelection(roster = this.roster()): void {
    const index = roster.findIndex(entry => entry.id === this.selectedId);
    // Missing identity returns explicitly to main, never to a different child.
    this.selectedIndex = index >= 0 ? index : 0;
    this.selectedId = roster[this.selectedIndex].id;
  }

  private select(index: number): void {
    const roster = this.roster();
    this.selectedIndex = Math.max(0, Math.min(roster.length - 1, index));
    this.selectedId = roster[this.selectedIndex].id;
  }

  // ---- Key handling ----

  /** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.enabled || !this.ui) return undefined;
    // Input listeners receive BOTH key-press and key-release (the kitty protocol
    // emits both, and matchesKey matches either) — act on press only, or every
    // tap would move/fire twice. Repeats still pass through for held-key nav.
    if (isKeyRelease(data)) return undefined;
    // While an overlay is open, let it own all input.
    if (this.viewerClose || this.externalOpening) return undefined;
    // Input listeners fire BEFORE the focused component, and dialogs
    // (ctx.ui.select/confirm/input, pi's own menus) swap the prompt editor out
    // while getEditorText() still reads the detached — empty — editor. So when
    // anything but the editor owns the keyboard, stay out of its keys (#123).
    if (!this.editorHasFocus()) {
      if (this.active && !this.externalViewingId) this.deactivate();
      return undefined;
    }
    this.externalViewingId = undefined;

    if (!this.active && this.ui.getEditorText() === "" && matchesKey(data, "ctrl+b")) {
      const candidates = this.manager.listAgentsMutable().filter(record => !record.detached && !record.parentAgentId &&
        !record.owner && record.isBackground === false && record.status === "running");
      const eligible = candidates.filter(record => this.manager.canHandoff(record.id));
      if (eligible.length > 1) this.ui.notify("Multiple foreground agents; select a conversation and press b to hand off explicitly.", "info");
      else if (eligible.length === 1) this.handoff(captureAgentSelection(this.manager, eligible[0]));
      else if (candidates.length) this.ui.notify(this.manager.handoffUnavailableReason(candidates[0].id) ?? "No eligible foreground agent.", "warning");
      else return undefined;
      return { consume: true };
    }

    if (!this.active) {
      // Activate: ↓ or ← at an empty prompt moves focus into the list.
      const isActivator = matchesKey(data, "down") || matchesKey(data, "left");
      if (isActivator && this.roster().length > 1 && this.ui.getEditorText() === "") {
        this.active = true;
        this.select(0);
        this.update();
        return { consume: true };
      }
      return undefined;
    }

    // Reconcile identity before both navigation and opening, even between ticks.
    this.clampSelection();
    // Active — arrows navigate, Enter opens, Esc / Up-past-top exits.
    if (matchesKey(data, "down")) {
      const max = this.roster().length - 1;
      this.select(Math.min(max, this.selectedIndex + 1));
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "up")) {
      if (this.selectedIndex === 0) { this.deactivate(); return { consume: true }; }
      this.select(this.selectedIndex - 1);
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) { this.deactivate(); return { consume: true }; }
    if (matchesKey(data, Key.enter)) { this.openSelected(); return { consume: true }; }

    // Any other key cancels navigation and flows to the editor.
    this.deactivate();
    return undefined;
  }

  /**
   * True when pi's prompt editor owns the keyboard. The editor is pluggable
   * (ui.setEditorComponent) and need not extend `Editor` (#374), so match pi-tui's
   * `EditorComponent` contract instead: `getText` + `setText`, which pi calls on
   * every editor and none of pi's dialogs, selectors or overlays implement.
   * Use the public structural focus getter (not present in every TUI interface
   * declaration). Unknown focus retains the initial editor fallback.
   */
  private editorHasFocus(): boolean {
    const focusHost = this.tui as { getFocusedComponent?: () => unknown } | undefined;
    const focused = typeof focusHost?.getFocusedComponent === "function" ? focusHost.getFocusedComponent() : undefined;
    if (focused == null) return true;
    const c = focused as { getText?: unknown; setText?: unknown };
    return typeof c.getText === "function" && typeof c.setText === "function";
  }

  private deactivate(): void {
    this.active = false;
    this.select(0);
    this.update();
  }

  private openSelected(): void {
    const roster = this.roster();
    this.clampSelection(roster);
    const entry = roster[this.selectedIndex];
    if (!entry || entry.kind === "main") {
      // `main` = return to the prompt; the native transcript is already shown.
      this.deactivate();
      return;
    }
    if (!this.ui) return;
    const record = entry.record;
    if (!record.session) {
      this.ui.notify(`Agent is ${record.status}; no session available.`, "info");
      return;
    }
    this.openConversation(captureAgentSelection(this.manager, record));
  }

  conversation(selection: AgentSelection, tui: TUI, theme: Theme, keys: ViewerKeybindings, done: (result: undefined) => void,
    notify = (message: string) => this.ui?.notify(message, "info"), mode: "fullscreen" | "overlay" = "overlay"): ConversationViewer {
    const { snapshot: record, session, owner, current } = selection;
    if (!session || !current()) throw new Error("Conversation selection is no longer active");
    let last = record;
    return new ConversationViewer(tui, session, record, this.agentActivity.get(record.id), theme, done,
      () => { if (current() && this.manager.abort(record.id)) notify(`Stopped "${sanitizeDisplayText(record.description)}".`); },
      keys,
      message => current() ? this.manager.steerAccepted(record.id, message, { session, owner }) : Promise.resolve(false),
      () => {
        const fresh = current();
        if (fresh) { last = { ...fresh, owner, lifetimeUsage: { ...fresh.lifetimeUsage } }; return fresh; }
        return { ...last, detached: true };
      },
      { mode, canHandoff: () => !!current() && this.manager.canHandoff(record.id), onHandoff: () => this.handoff(selection) },
    );
  }

  private handoff(selection: AgentSelection): boolean {
    if (!selection.current()) return false;
    const id = selection.snapshot.id;
    if (!this.manager.handoff(id)) {
      this.ui?.notify(this.manager.handoffUnavailableReason(id) ?? "Cannot hand off this agent.", "warning");
      return false;
    }
    this.ui?.notify(`Agent ${sanitizeDisplayText(id)} continues in background.`, "info");
    this.update();
    return true;
  }

  /** Owner navigation is explicit; direct child inspection also works with Fleet disabled. */
  async openRetainedWorkflow(runId: string, preferOwner = true): Promise<void> {
    const group = this.retainedWorkflowGroups().find(candidate => candidate.runId === runId);
    if (!group) { this.ui?.notify("No retained child conversations for this workflow.", "info"); return; }
    const client = this.workflowClient;
    const summary = preferOwner ? client?.runs(new Set([runId])).find(run => run.runId === runId) : undefined;
    const ui = this.ui;
    const generation = this.overlayGeneration;
    if (summary && client) {
      this.externalOpening = true;
      try {
        await client.open(summary);
        if (generation === this.overlayGeneration && ui === this.ui) this.externalViewingId = group.runId;
        // Admission precedes the peer's dialog factory. Yield through its next
        // macrotask, then rely on public TUI focus for the entire interaction.
        if (generation === this.overlayGeneration && ui === this.ui) {
          this.externalTimer = setTimeout(() => { this.externalTimer = undefined; this.externalOpening = false; this.update(); }, 0);
        }
        return;
      } catch {
        if (generation !== this.overlayGeneration || ui !== this.ui) return;
        ui?.notify("Workflow inspector unavailable; showing retained children only (no workflow controls).", "warning");
      } finally {
        if (!this.externalTimer && generation === this.overlayGeneration) this.externalOpening = false;
      }
    }
    if (generation !== this.overlayGeneration || ui !== this.ui) return;
    if (preferOwner && !summary) ui?.notify("Workflow inspector unavailable; showing retained children only (no workflow controls).", "warning");
    if (!group.records.length) { ui?.notify("No retained child conversations for this workflow.", "info"); return; }
    await this.openOverlay((tui, theme, keys, done) => new OwnerGroupViewer(tui, theme, group.runId,
      () => this.retainedWorkflowGroups().find(candidate => candidate.id === group.id)?.records ?? [],
      (record, back) => this.conversation(captureAgentSelection(this.manager, record), tui, theme, keys, back),
      () => done(undefined), keys));
  }

  private async openOverlay(factory: (tui: TUI, theme: Theme, keys: ViewerKeybindings, done: (result: undefined) => void) => Component,
    mode: "fullscreen" | "overlay" | "auto" = "overlay", deferConstruction = false): Promise<void> {
    const ui = this.ui;
    if (!ui) return;
    const generation = ++this.overlayGeneration;
    this.viewerClose = () => {}; // reserve input during asynchronous construction
    let mountedMode: "fullscreen" | "overlay" = "overlay";
    try {
      if (deferConstruction) await Promise.resolve();
      if (generation !== this.overlayGeneration || ui !== this.ui) return;
      await ui.custom<undefined>((tui, theme, keys, done) => {
        if (generation !== this.overlayGeneration || ui !== this.ui) {
          done(undefined);
          return { render: () => [], invalidate: () => {} };
        }
        this.viewerClose = () => done(undefined);
        mountedMode = mode === "auto" ? getConversationViewerMode(tui) : mode;
        const component = factory(tui, theme, keys, done);
        return mountedMode === "fullscreen" ? component : borderedComponent(component, text => theme.fg("borderAccent", text));
      }, { overlay: true, overlayOptions: () => getConversationOverlayOptions({ mode: mountedMode === "fullscreen" ? "fullscreen" : undefined }) });
    } catch {
      if (generation === this.overlayGeneration) ui.notify("Cannot open conversation; try again.", "error");
    } finally {
      if (generation === this.overlayGeneration) this.clearViewer();
    }
  }

  /** Reset overlay state and return to the list (on close, auto-close, or error). */
  private clearViewer(): void {
    // Keep the cursor on the agent we were viewing — re-resolve by id so it
    // still feels natural if the list reordered (an earlier agent finished)
    // while the overlay was open. If that agent is gone, leave the index for
    // update()'s clamp to settle.
    if (this.viewingAgentId) {
      const idx = this.roster().findIndex(e => e.kind === "agent" && e.record.id === this.viewingAgentId);
      if (idx >= 0) this.select(idx);
    }
    this.viewerClose = undefined;
    this.viewingAgentId = undefined;
    this.update();
  }

  // ---- Rendering ----

  private renderBar(width: number, theme: Theme): string[] {
    if (width <= 0) return [];
    const roster = this.roster();
    this.clampSelection(roster);
    const agents = roster.slice(1);
    if (agents.length === 0) return [];
    const sel = this.selectedIndex;

    // Key names read as proper nouns, the verbs after them stay lowercase, and
    // segments are separated by " · " — the same shape every hint line in the
    // package uses, so the eye stops parsing it after the first time.
    const hint = this.active
      ? "↑↓ navigate · Enter view · Esc back"
      : "Esc interrupt · ← agents · ↓ manage";
    const height = Math.max(0, Math.floor((this.tui?.terminal.rows ?? 24) / 2));
    if (height === 0) return [];
    const lines: string[] = [];
    if (height >= 7) {
      lines.push(truncateToWidth(`  ${theme.fg("dim", hint)}`, width));
      lines.push("");
    }

    const mainColor = sel === 0 ? "accent" : "dim";
    const main = sel === 0
      ? theme.bold(theme.fg("accent", "main"))
      : theme.fg("muted", "main");
    // `main` carries a mark too, so every row's name starts in the same column.
    const mainMark = theme.fg(mainColor, getAgentStatusMark("running"));
    lines.push(truncateToWidth(`  ${mainMark} ${main} ${theme.fg("dim", "·")} ${theme.fg("dim", "current")}`, width));

    const rowBudget = Math.max(1, Math.floor((this.tui?.terminal.rows ?? 24) / 2) - 7);
    const visible = Math.min(MAX_AGENT_ROWS, rowBudget, agents.length);
    const selAgent = Math.max(0, sel - 1);
    const start = selAgent < visible ? 0 : selAgent - visible + 1;
    const hiddenBelow = agents.length - (start + visible);

    if (start > 0) lines.push(rightAlign("", theme.fg("dim", `${start} more above`), width));
    for (let a = start; a < start + visible; a++) {
      const entry = agents[a];
      if (entry.kind === "agent") lines.push(this.renderAgentRow(a + 1, sel, entry.record, width, theme));
    }
    if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `${hiddenBelow} more below`), width));

    // One separator belongs to Fleet; do not stack two empty rows before the footer.
    return [...lines.slice(0, height - 1), ""].map(line => truncateToWidth(line, Math.max(0, width)));
  }

  private renderAgentRow(rosterIndex: number, sel: number, record: AgentRecord, width: number, theme: Theme): string {
    const selected = rosterIndex === sel;
    const status = getAgentStatusLabel(record.status);
    const nameText = renderAgentName(record.type, theme, {
      fallbackColor: selected ? "accent" : "muted",
      bold: selected,
    });
    const description = sanitizeDisplayText(record.description);
    const descriptionText = selected ? theme.fg("accent", description) : description;
    const semanticStatusColor = getAgentStatusColor(record.status);
    const statusColor = ["steered", "aborted", "error"].includes(record.status)
      ? semanticStatusColor
      : selected ? "accent" : "dim";
    const statusText = theme.fg(statusColor, status);
    // The mark leads the row and is colored by outcome, so the roster scans
    // vertically: one glance down the column says which agents are still going,
    // which finished, and which failed, without reading any labels.
    const mark = theme.fg(statusColor, getAgentStatusMark(record.status));
    const left = `  ${mark} ${nameText} ${theme.fg("dim", "·")} ${descriptionText} ${theme.fg("dim", "·")} ${statusText}`;
    const tokens = getLifetimeTotal(this.agentActivity.get(record.id)?.lifetimeUsage ?? record.lifetimeUsage);
    const elapsedMs = (record.completedAt ?? Date.now()) - record.startedAt;
    const right = theme.fg("dim", `${formatFleetElapsed(elapsedMs)} · ${formatFleetTokens(tokens)}`);
    return rightAlign(left, right, width);
  }
}
