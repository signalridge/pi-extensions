import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEngine } from "../src/engine.js";
import type { ScriptRun } from "../src/journal.js";
import { buildWorkflowUiSnapshot } from "../src/ui-bus.js";
import { OVERVIEW_LINGER_MS, overviewRuns, workflowOverviewLines } from "../src/ui-overview.js";

const now = 50_000;
const theme = {
  fg: (_color: string, text: string) => `\x1b[90m${text}\x1b[39m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};
function run(id = "run", status: ScriptRun["status"] = "running", calls = 0): ScriptRun {
  return {
    runId: id,
    status,
    startedAt: now - 3000,
    updatedAt: now,
    meta: { name: `工作流 ${id}`, description: "test", phases: [{ title: "declared, not entered" }] },
    callStatus: Object.fromEntries(
      Array.from({ length: calls }, (_, index) => [String(index), index === 6 ? "running" : "completed"]),
    ),
    callResults: {},
  } as unknown as ScriptRun;
}
function render(
  runs: ScriptRun[],
  mode: "compact" | "detailed" = "compact",
  max = 6,
  rows = 12,
  width = 200,
  phase?: string,
  restored = false,
  at = now,
) {
  const engine = {
    list: () => runs.map((item) => ({ runId: item.runId })),
    getRun: (id: string) => runs.find((item) => item.runId === id),
    getInspectionHeader: () => ({ currentPhase: phase, restored }),
  } as unknown as WorkflowEngine;
  const snapshot = buildWorkflowUiSnapshot(engine, "surface");
  return workflowOverviewLines(runs, snapshot.runs, theme, width, rows, mode, max, at);
}
const plain = (lines: string[]) => stripVTControlCharacters(lines.join("\n"));

describe("Workflows-owned rich below-editor overview formatting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());
  it.each([
    "pending",
    "running",
    "pausing",
    "paused",
    "interrupted",
    "stopping",
    "completed",
    "failed",
    "stopped",
  ] as const)("shows childless %s authority and keeps the name primary", (status) => {
    const record = run("empty", status);
    const lines = render([record]);
    const text = plain(lines);
    expect(text).toContain(`▸ 工作流 empty · ${status} · 0/0 in flight · 0 done · 0 failed`);
    expect(lines[1]).toContain("\x1b[1m工作流 empty\x1b[22m");
    expect(text).not.toContain("declared, not entered");
    expect(text).not.toContain("tokens");
  });

  it("uses only observed current-phase attribution and settled-call tokens, distinguishing unknown from explicit zero", () => {
    const record = run("usage", "running", 3);
    record.callStatus = { "0": "running", "1": "completed", "2": "failed" };
    record.callResults = {
      "1": { status: "completed", tokenCount: 0, compactionCount: 0, updatedAt: now },
      "2": { status: "failed", tokenCount: 12, compactionCount: 0, updatedAt: now },
    };
    const before = JSON.stringify(record);
    const text = plain(render([record], "compact", 6, 12, 240, "Observed phase", true));
    expect(text).toContain("Observed phase · 1/3 in flight · 1 done · 1 failed");
    expect(text).toContain("12 settled tokens");
    expect(text).toContain("restored");
    expect(text).not.toContain("live tokens");
    delete record.callResults["2"];
    expect(plain(render([record]))).toContain("0 settled tokens");
    record.callResults = {};
    expect(plain(render([record]))).not.toContain("tokens");
    record.callResults = JSON.parse(before).callResults;
    expect(JSON.stringify(record)).toBe(before);
  });

  it("keeps elapsed and settled usage visible at ordinary terminal width without replacing the primary name", () => {
    const record = run("brief");
    record.callResults = { "0": { status: "completed", tokenCount: 1234, compactionCount: 0, updatedAt: now } };
    const text = plain(render([record], "compact", 6, 12, 80));
    expect(text).toContain("工作流 brief");
    expect(text).toContain("1.2k settled tokens");
    expect(text).toMatch(/\d+s · 1\.2k settled tokens/);
  });

  it.each([1, 2, 3, 6, 12, 24, 32])("bounds combined runs and details to %s rows and reports overflow", (rows) => {
    const records = Array.from({ length: 40 }, (_, index) => run(String(index), "running", 1000));
    const lines = render(records, "detailed", 32, rows);
    expect(lines.length).toBeLessThanOrEqual(rows);
    expect(plain(lines)).toContain("40 active");
    if (rows > 1) expect(plain(lines)).toContain("more workflows");
  });

  it.each([1, 2, 3, 6, 12, 24, 32])(
    "counts all 257 childless active runs beyond the bridge cap within %i rows",
    (rows) => {
      const records = Array.from({ length: 257 }, (_, index) => run(String(index)));
      const engine = {
        list: () => records.map((item) => ({ runId: item.runId })),
        getRun: (id: string) => records.find((item) => item.runId === id),
        getInspectionHeader: () => ({ currentPhase: "Observed phase", restored: false }),
      } as unknown as WorkflowEngine;
      const summaries = buildWorkflowUiSnapshot(engine, "surface").runs;
      expect(summaries).toHaveLength(256);
      for (const mode of ["compact", "detailed"] as const) {
        const lines = workflowOverviewLines(records, summaries, theme, 240, rows, mode, 32, now);
        expect(lines.length).toBeLessThanOrEqual(rows);
        const text = plain(lines);
        expect(text).toContain("257 active");
        if (rows > 1) {
          const displayed = lines.filter((line) => stripVTControlCharacters(line).includes("▸")).length;
          expect(text).toContain(`${257 - displayed} more workflows`);
          if (displayed) expect(text).toContain("Observed phase");
        }
      }
    },
  );

  it("counts uncapped active authority but expires only terminal linger, without counting old bridge history", () => {
    const records = Array.from({ length: 260 }, (_, index) => run(String(index)));
    const expired = run("expired", "failed");
    expired.updatedAt = now - OVERVIEW_LINGER_MS;
    records.push(run("recent", "completed"), expired);
    const lines = render(records, "compact", 2, 6);
    expect(plain(lines)).toContain("260 active");
    expect(plain(lines)).toContain("259 more workflows");
    expect(lines).toHaveLength(5);
  });

  it("preserves compact/detailed ceilings and prioritizes live calls with explicit omitted counts", () => {
    const record = run("calls", "running", 30);
    expect(plain(render([record], "compact"))).not.toContain("6: running");
    const detailed = render([record], "detailed", 6, 3);
    expect(detailed).toHaveLength(3);
    expect(plain(detailed)).toContain("6: running");
    expect(plain(detailed)).toContain("29 more calls");
    const many = Array.from({ length: 10 }, (_, index) => run(String(index)));
    expect(plain(render(many, "compact", 2))).toContain("8 more workflows");
  });

  it("bounds ANSI/CJK/combining/control text for narrow, fractional, zero and invalid geometry without mutating source", () => {
    const record = run();
    record.meta.name = "中文 é \x1b[2J\u202e".repeat(100);
    const before = JSON.stringify(record);
    for (const width of [0, 1, 2, 4, 12, 20, 80, 120.5, NaN, Infinity]) {
      for (const rows of [0, 1, 2, 3, 6, 12, NaN]) {
        const lines = render([record], "detailed", NaN, rows, width, "阶段\x1b[2J");
        if (!Number.isFinite(width) || !Number.isFinite(rows) || width < 1 || rows < 1) expect(lines).toEqual([]);
        else {
          expect(lines.length).toBeLessThanOrEqual(rows);
          expect(lines.every((line) => visibleWidth(line) <= Math.floor(width))).toBe(true);
        }
        expect(plain(lines)).not.toContain("\x1b");
        expect(plain(lines)).not.toContain("\u202e");
      }
    }
    expect(JSON.stringify(record)).toBe(before);
  });

  it("uses semantic status colors and muted metadata, never painting the primary name as secondary text", () => {
    const colors: Array<[string, string]> = [];
    const palette = {
      fg: (color: string, text: string) => {
        colors.push([color, text]);
        return text;
      },
      bold: (text: string) => text,
    };
    const records = [run("failure", "failed"), run("done", "completed"), run("paused", "paused")];
    const engine = {
      list: () => records.map((item) => ({ runId: item.runId })),
      getRun: (id: string) => records.find((item) => item.runId === id),
      getInspectionHeader: () => ({ restored: false }),
    } as unknown as WorkflowEngine;
    workflowOverviewLines(
      records,
      buildWorkflowUiSnapshot(engine, "surface").runs,
      palette,
      200,
      12,
      "compact",
      6,
      now,
    );
    expect(colors).toContainEqual(["error", "failed"]);
    expect(colors).toContainEqual(["success", "completed"]);
    expect(colors).toContainEqual(["warning", "paused"]);
    expect(colors.some(([color, text]) => color === "muted" && text.includes("0/0 in flight"))).toBe(true);
    expect(colors.some(([, text]) => text.startsWith("工作流"))).toBe(false);
  });

  it("expires recent terminal rows without relingering restored history, while paused/stopping runs never expire", () => {
    const records = [run("old", "completed"), run("paused", "paused"), run("stop", "stopping")];
    expect(overviewRuns(records, now + OVERVIEW_LINGER_MS - 1)).toHaveLength(3);
    expect(overviewRuns(records, now + OVERVIEW_LINGER_MS).map((item) => item.runId)).toEqual(["paused", "stop"]);
    expect(plain(render([records[0]], "compact", 6, 12, 200, undefined, true, now + OVERVIEW_LINGER_MS))).toBe("");
  });
});
