import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowUiRunSummary } from "@signalridge/pi-subagents-protocol";
import type { ScriptRun } from "./journal.js";
import { sanitizeDisplayText } from "./safe-text.js";
import { callIndexes, isTerminal, statusMark } from "./ui-presentation.js";

export const OVERVIEW_LINGER_MS = 4_000;

/** Terminal history remains in /workflows, not an indefinitely growing passive list. */
export function overviewRuns(runs: readonly ScriptRun[], now = Date.now()): ScriptRun[] {
  return runs.filter((run) => !isTerminal(run.status) || now - run.updatedAt < OVERVIEW_LINGER_MS);
}

function statusColor(status: string): "success" | "error" | "warning" | "accent" | "muted" {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (["paused", "pausing", "interrupted", "stopping", "stopped"].includes(status)) return "warning";
  return status === "running" ? "accent" : "muted";
}

function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

/**
 * The workflow owner's passive overview. Authority/phase/settled usage come from
 * its existing projection, never from child records or in-flight usage polling.
 * No keyboard listener: /workflows is the sole workflow navigator.
 */
export function workflowOverviewLines(
  runs: readonly ScriptRun[],
  summaries: readonly WorkflowUiRunSummary[],
  theme: Pick<Theme, "fg" | "bold">,
  width: number,
  maxRows: number,
  mode: "compact" | "detailed" = "compact",
  maxAgentsShown = 6,
  now = Date.now(),
): string[] {
  if (!Number.isFinite(width) || width < 1 || !Number.isFinite(maxRows) || maxRows < 1) return [];
  const columns = Math.floor(width);
  const rows = Math.min(32, Math.floor(maxRows));
  const max = Number.isFinite(maxAgentsShown) ? Math.max(1, Math.min(32, Math.floor(maxAgentsShown))) : 6;
  const available = new Map(overviewRuns(runs, now).map((run) => [run.runId, run]));
  const entries = summaries.filter((summary) => available.has(summary.runId));
  if (!available.size) return [];
  // The peer bridge caps publication at 256 summaries. It supplies bounded row
  // metadata, never authority over how many owner-side runs exist or are live.
  const active = [...available.values()].filter((run) => !isTerminal(run.status)).length;
  const lines = [theme.fg("muted", `Workflows · ${active} active · /workflows`)];
  if (rows === 1) return lines.map((line) => truncateToWidth(line, columns));
  let shown = Math.min(max, entries.length, rows - 1);
  if (available.size > shown && shown + 2 > rows) shown = Math.max(0, shown - 1);
  const hidden = available.size - shown;
  for (const [index, summary] of entries.slice(0, shown).entries()) {
    const run = available.get(summary.runId);
    if (!run) continue;
    const color = statusColor(summary.status);
    const phase = summary.currentPhase ? ` · ${sanitizeDisplayText(summary.currentPhase, 80)}` : "";
    const stats = `${summary.runningCalls}/${summary.callCount} in flight · ${summary.completedCalls} done · ${summary.failedCalls} failed`;
    // These are settled-call totals (including explicit zero), NOT live usage.
    const usage = summary.tokenCount === undefined ? "" : ` · ${tokens(summary.tokenCount)} settled tokens`;
    const metadata = `${phase} · ${stats}${summary.restored ? " · restored" : ""}`;
    const left = `  ${theme.fg(color, "▸")} ${theme.bold(sanitizeDisplayText(summary.name, 80))} · ${theme.fg(color, summary.status)}${theme.fg("muted", metadata)}`;
    const right = theme.fg("muted", `${Math.floor(summary.elapsedMs / 1_000)}s${usage}`);
    const runLine = lines.length;
    if (columns >= 48) {
      // Preserve elapsed/settled usage on ordinary terminals, but never let
      // secondary stats consume the primary name on a narrow viewport.
      const boundedRight = truncateToWidth(right, Math.floor(columns / 3));
      const boundedLeft = truncateToWidth(left, columns - visibleWidth(boundedRight) - 1);
      const gap = Math.max(1, columns - visibleWidth(boundedLeft) - visibleWidth(boundedRight));
      lines.push(boundedLeft + " ".repeat(gap) + boundedRight);
    } else lines.push(`${left} ${right}`);
    if (mode !== "detailed") continue;
    const calls = callIndexes(run);
    const live = calls.filter((id) => run.callStatus[id] === "running");
    const liveIds = new Set(live);
    const prioritized = [...live, ...calls.filter((id) => !liveIds.has(id))];
    const reserved = shown - index - 1 + (hidden > 0 ? 1 : 0);
    const callRows = Math.max(0, Math.min(max, rows - lines.length - reserved));
    const visible = prioritized.slice(0, callRows);
    for (const id of visible) {
      const status = run.callStatus[id] ?? run.callResults[id]?.status ?? "unknown";
      lines.push(`    ${theme.fg(statusColor(status), statusMark(status))} ${theme.fg("muted", `${id}: ${status}`)}`);
    }
    const omitted = calls.length - visible.length;
    if (omitted > 0)
      lines[visible.length ? lines.length - 1 : runLine] += theme.fg("muted", ` · ${omitted} more calls`);
  }
  if (hidden > 0) lines.push(theme.fg("muted", `  ${hidden} more workflows · /workflows`));
  if (lines.length < rows) lines.push(""); // One separator before the next dock/footer surface.
  return lines.map((line) => truncateToWidth(line, columns));
}
