import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { WorkflowEngine } from "./engine.js";
import type { ScriptRun } from "./journal.js";
import { sanitizeDisplayText } from "./safe-text.js";

/** Bounds, in code points, for untrusted strings rendered into the navigator. */
const MAX_NAME_CHARS = 200;
const MAX_ID_CHARS = 128;
const MAX_RESULT_CHARS = 300;
const MAX_RUN_ERROR_CHARS = 500;
const MAX_DESCRIPTION_CHARS = 120;

/**
 * Pure snapshot render layer shared by the navigator, the live widget, and any
 * inline render site. All child-agent output passes through sanitizeDisplayText
 * BEFORE truncation so a live escape introducer is never cut mid-sequence.
 */
export function snapshotRunLine(run: ScriptRun): string {
  return formatWorkflowRunLabel(run);
}

/** Live-widget lines for all non-terminal runs (A10). */
export function liveWidgetLines(runs: readonly ScriptRun[]): string[] {
  const active = runs.filter((run) => !isTerminal(run.status));
  if (active.length === 0) return [];
  return ["Workflows", ...active.slice(0, 6).map((run) => `  ${snapshotRunLine(run)}`)].slice(0, 8);
}

export type RunStatus = ScriptRun["status"];

function elapsed(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

export function formatWorkflowRunLabel(run: ScriptRun): string {
  const phases = run.meta.phases && run.meta.phases.length > 0 ? ` · phases ${run.meta.phases.length}` : "";
  const calls = Object.keys(run.callResults).length;
  const name = sanitizeDisplayText(run.meta.name, MAX_NAME_CHARS);
  return `${name} · ${run.status}${phases} · ${calls} calls · ${elapsed(Math.max(0, (isTerminal(run.status) ? run.updatedAt : Date.now()) - run.startedAt))}`;
}

export function formatWorkflowDetail(engine: WorkflowEngine, runId: string): string {
  const state = engine.getState(runId);
  if (!state) return "Workflow run is no longer available.";
  const run = state.run;
  const tokenValues = Object.values(run.callResults)
    .map((result) => result.tokenCount)
    .filter((value): value is number => value !== undefined);
  const tokenCount = tokenValues.length > 0 ? tokenValues.reduce((total, value) => total + value, 0) : undefined;
  const lines = [
    `${sanitizeDisplayText(run.meta.name, MAX_NAME_CHARS)} [${run.status}]`,
    `run: ${sanitizeDisplayText(run.runId, MAX_ID_CHARS)}`,
    `elapsed: ${elapsed(Math.max(0, (isTerminal(run.status) ? run.updatedAt : Date.now()) - run.startedAt))}`,
    "",
    ...(tokenCount === undefined ? [] : [`tokens: ${tokenCount}`]),
  ];
  for (const phase of run.meta.phases ?? []) {
    lines.push(`Phase: ${sanitizeDisplayText(phase.title, MAX_NAME_CHARS)}`);
  }
  const calls = Object.entries(run.callStatus)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([nodeId, status]) => {
      const result = run.callResults[nodeId];
      const agent = run.agentIds[nodeId] ? ` agent=${sanitizeDisplayText(run.agentIds[nodeId], MAX_ID_CHARS)}` : "";
      const compact = run.compactions[nodeId] ? ` compactions=${run.compactions[nodeId]}` : "";
      const parts = [`  ${status.padEnd(11)} call ${sanitizeDisplayText(nodeId, MAX_ID_CHARS)}${agent}${compact}`];
      if (result?.error) parts.push(`    error: ${sanitizeDisplayText(result.error, MAX_RESULT_CHARS)}`);
      if (result?.result !== undefined && result.status === "completed") {
        parts.push(`    result: ${sanitizeDisplayText(String(result.result), MAX_RESULT_CHARS)}`);
      }
      return parts.join("\n");
    });
  if (calls.length > 0) {
    lines.push("Calls:");
    lines.push(...calls);
  }
  lines.push("", "Live agent conversations remain available through pi-subagents FleetView.");
  if (run.error) lines.push(`Error: ${sanitizeDisplayText(run.error, MAX_RUN_ERROR_CHARS)}`);
  return lines.join("\n");
}

/** Actions the `/workflows` detail menu can offer, in display order. */
export type WorkflowAction = "refresh" | "pause" | "resume" | "stop" | "back";

export interface WorkflowActionItem {
  value: WorkflowAction;
  label: string;
}

const REFRESH: WorkflowActionItem = { value: "refresh", label: "Refresh" };
const PAUSE: WorkflowActionItem = { value: "pause", label: "Pause" };
const RESUME: WorkflowActionItem = { value: "resume", label: "Resume" };
const STOP: WorkflowActionItem = { value: "stop", label: "Stop" };
const BACK: WorkflowActionItem = { value: "back", label: "Back" };

/**
 * Menu actions legal for a run in `status`. Exhaustive by construction.
 */
export function workflowActionsFor(status: RunStatus): readonly WorkflowActionItem[] {
  switch (status) {
    case "pending":
    case "pausing":
    case "stopping":
      return [REFRESH, STOP, BACK];
    case "running":
      return [REFRESH, PAUSE, STOP, BACK];
    case "paused":
    case "interrupted":
      return [REFRESH, RESUME, STOP, BACK];
    case "completed":
    case "failed":
    case "stopped":
      return [REFRESH, BACK];
  }
  const unreachable: never = status;
  return unreachable;
}

async function selectList<T>(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[],
  renderExtra: (theme: Pick<Theme, "fg">) => string,
): Promise<T | undefined> {
  if (ctx.mode !== "tui") return undefined;
  return ctx.ui.custom<T | undefined>((_tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(new Text(theme.fg("dim", renderExtra(theme)), 1, 0));
    const list = new SelectList(items, Math.min(12, Math.max(1, items.length)), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    list.onSelect = (item) => done(item.value as T);
    list.onCancel = () => done(undefined);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "↑↓ select · enter confirm · esc back"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => list.handleInput(data),
    };
  });
}

/** Interactive `/workflows` navigator. TUI-only by design. */
export async function showWorkflowNavigator(ctx: ExtensionCommandContext, engine: WorkflowEngine): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/workflows requires TUI mode; use workflow_control for machine-readable access.", "warning");
    return;
  }
  while (true) {
    const states = engine
      .list()
      .map((summary) => engine.getRun(String(summary.runId)))
      .filter((run): run is ScriptRun => run !== undefined)
      .sort((a, b) => b.startedAt - a.startedAt);
    const selected = await selectList<string>(
      ctx,
      "Workflow runs",
      states.map((run) => ({
        value: run.runId,
        label: formatWorkflowRunLabel(run),
        description: run.error === undefined ? undefined : sanitizeDisplayText(run.error, MAX_DESCRIPTION_CHARS),
      })),
      (theme) =>
        states.length > 0
          ? theme.fg("dim", "Select a run to inspect.")
          : theme.fg("muted", "No workflow runs in this session."),
    );
    if (!selected) return;
    while (true) {
      const run = engine.getRun(selected);
      if (!run) break;
      const name = sanitizeDisplayText(run.meta.name, MAX_NAME_CHARS);
      const action = await selectList<WorkflowAction>(
        ctx,
        `${name} · ${run.status}`,
        workflowActionsFor(run.status).map((item) => ({
          value: item.value,
          label: item.label,
        })),
        () => formatWorkflowDetail(engine, selected),
      );
      if (action === undefined || action === "back") break;
      if (action === "refresh") continue;
      if (action === "stop") {
        const confirmed = await ctx.ui.confirm("Stop workflow", `Stop ${name}? The run will be non-resumable.`);
        if (!confirmed) continue;
      }
      try {
        await engine.control(action, selected);
        ctx.ui.notify(`Workflow ${action} requested.`, "info");
      } catch (error: unknown) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
  }
}
