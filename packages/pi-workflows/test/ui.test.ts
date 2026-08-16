import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { WorkflowEngine, WorkflowSummary } from "../src/engine.js";
import type { WorkflowRun } from "../src/journal.js";
import type { WorkflowDefinition } from "../src/schema.js";
import { isTerminalWorkflow, WORKFLOW_STATUSES } from "../src/state-machine.js";
import { formatWorkflowDetail, formatWorkflowRunLabel, type WorkflowAction, workflowActionsFor } from "../src/ui.js";

const definition: WorkflowDefinition = {
  name: "workflow with a deliberately long name that must remain width safe",
  phases: [{ id: "phase", title: "A phase with a deliberately long title" }],
  tasks: [
    {
      id: "task",
      phase: "phase",
      subagent_type: "Explore",
      description: "Find files",
      prompt: "Find files",
      depends_on: [],
    },
  ],
  synthesis: { subagent_type: "general-purpose", prompt: "Synthesize" },
  background: false,
};

function expectFits(text: string, width: number): void {
  expect(new Text(text).render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
}

describe("workflow TUI formatting", () => {
  it("wraps long run labels within the terminal width", () => {
    const summary: WorkflowSummary = {
      runId: "run-1",
      name: "workflow ".repeat(20),
      status: "running",
      startedAt: 0,
      updatedAt: 1_000,
      elapsedMs: 1_000,
      taskCount: 128,
      phaseCount: 32,
      completedPhases: 4,
      completedTasks: 12,
      failedTasks: 0,
      activeTasks: 3,
      tokenCount: 123_456,
    };

    expectFits(formatWorkflowRunLabel(summary), 36);
  });

  it("wraps detail output containing long IDs, results, and errors", () => {
    const run: WorkflowRun = {
      runId: `run-${"x".repeat(80)}`,
      schemaVersion: 1,
      definition,
      status: "failed",
      taskStatus: { task: "failed" },
      agentIds: { task: `agent-${"y".repeat(80)}` },
      taskResults: {
        task: {
          status: "failed",
          agentId: "agent-1",
          error: "error ".repeat(100),
          text: "result ".repeat(100),
          compactionCount: 3,
          updatedAt: 1_000,
        },
      },
      compactions: { task: 3 },
      startedAt: 0,
      updatedAt: 1_000,
      error: "workflow error ".repeat(100),
    };
    const engine = { getRun: () => run } as unknown as WorkflowEngine;

    expectFits(formatWorkflowDetail(engine, run.runId), 36);
  });
});

const ESC = "";
const BEL = "";
/** Real payloads: CSI clear-screen, an OSC 8 hyperlink, an 8-bit CSI, and a bidi override. */
const CSI_CLEAR = `${ESC}[2J${ESC}[H`;
const OSC8 = `${ESC}]8;;https://evil.example${BEL}totally-safe${ESC}]8;;${BEL}`;
const C1_CSI = "31m";
const RTL_OVERRIDE = "‮";

function hostileRun(): WorkflowRun {
  return {
    runId: `run-${CSI_CLEAR}1`,
    schemaVersion: 1,
    definition: {
      name: `wf ${OSC8}`,
      phases: [{ id: "phase", title: `phase ${C1_CSI}title` }],
      tasks: [
        {
          id: `task${RTL_OVERRIDE}`,
          phase: "phase",
          subagent_type: "Explore",
          description: "Find files",
          prompt: "Find files",
          depends_on: [],
        },
      ],
      background: false,
    },
    status: "failed",
    taskStatus: { [`task${RTL_OVERRIDE}`]: "failed" },
    agentIds: { [`task${RTL_OVERRIDE}`]: `agent${CSI_CLEAR}` },
    taskResults: {
      [`task${RTL_OVERRIDE}`]: {
        status: "failed",
        agentId: "agent-1",
        // The CSI introducer sits at index 298, so a slice(0, 300) would keep a dangling "ESC [".
        error: `${"e".repeat(298)}${CSI_CLEAR}${"e".repeat(200)}`,
        text: `${"r".repeat(298)}${CSI_CLEAR}${"r".repeat(200)}`,
        compactionCount: 0,
        updatedAt: 1_000,
      },
    },
    compactions: {},
    startedAt: 0,
    updatedAt: 1_000,
    error: `${"w".repeat(498)}${CSI_CLEAR}${"w".repeat(200)}`,
  };
}

describe("terminal safety of rendered child-agent output", () => {
  it("strips escape and bidi sequences from every untrusted detail field", () => {
    const run = hostileRun();
    const engine = { getRun: () => run } as unknown as WorkflowEngine;

    const detail = formatWorkflowDetail(engine, run.runId);

    for (const unsafe of [ESC, BEL, "", RTL_OVERRIDE]) {
      expect(detail).not.toContain(unsafe);
    }
    // Neutralized, not dropped: the payload survives as inert characters.
    expect(detail).toContain("totally-safe");
    expect(detail).toContain("[2J");
  });

  it("sanitizes before truncating so a straddling escape never reaches the terminal", () => {
    const run = hostileRun();
    const engine = { getRun: () => run } as unknown as WorkflowEngine;

    const detail = formatWorkflowDetail(engine, run.runId);
    const lines = detail.split("\n");
    const resultLine = lines.find((line) => line.includes("result: "));
    const errorLine = lines.find((line) => line.includes("error: "));
    const runErrorLine = lines.find((line) => line.startsWith("Error: "));
    if (!resultLine || !errorLine || !runErrorLine) throw new Error("detail is missing a bounded line");

    // A naive slice-then-render keeps the introducer; sanitize-then-slice cannot.
    expect(run.taskResults[`task${RTL_OVERRIDE}`]?.text?.slice(0, 300)).toContain(ESC);
    expect(resultLine).not.toContain(ESC);
    expect(errorLine).not.toContain(ESC);
    expect(runErrorLine).not.toContain(ESC);
    expect([...resultLine.replace("    result: ", "")]).toHaveLength(300);
    expect([...runErrorLine.replace("Error: ", "")]).toHaveLength(500);
  });

  it("sanitizes the run label rendered in the run list", () => {
    const summary: WorkflowSummary = {
      runId: "run-1",
      name: `wf ${CSI_CLEAR}${RTL_OVERRIDE}name`,
      status: "failed",
      startedAt: 0,
      updatedAt: 1_000,
      elapsedMs: 1_000,
      taskCount: 1,
      phaseCount: 0,
      completedPhases: 0,
      completedTasks: 0,
      failedTasks: 1,
      activeTasks: 0,
    };

    const label = formatWorkflowRunLabel(summary);
    expect(label).not.toContain(ESC);
    expect(label).not.toContain(RTL_OVERRIDE);
    expect(label).toContain("failed");
  });
});

function values(status: Parameters<typeof workflowActionsFor>[0]): WorkflowAction[] {
  return workflowActionsFor(status).map((item) => item.value);
}

describe("workflowActionsFor", () => {
  it("pending offers stop but neither pause nor resume", () => {
    expect(values("pending")).toEqual(["refresh", "stop", "back"]);
  });

  it("running offers pause and stop but not resume", () => {
    expect(values("running")).toEqual(["refresh", "pause", "stop", "back"]);
  });

  it("pausing offers stop but not pause again", () => {
    expect(values("pausing")).toEqual(["refresh", "stop", "back"]);
  });

  it("paused offers resume and stop but not pause", () => {
    expect(values("paused")).toEqual(["refresh", "resume", "stop", "back"]);
  });

  it("synthesizing offers stop only", () => {
    expect(values("synthesizing")).toEqual(["refresh", "stop", "back"]);
  });

  it("stopping still offers an idempotent stop but no pause or resume", () => {
    expect(values("stopping")).toEqual(["refresh", "stop", "back"]);
  });

  it("interrupted offers resume and stop", () => {
    expect(values("interrupted")).toEqual(["refresh", "resume", "stop", "back"]);
  });

  it("completed, failed, and stopped offer no lifecycle control", () => {
    expect(values("completed")).toEqual(["refresh", "back"]);
    expect(values("failed")).toEqual(["refresh", "back"]);
    expect(values("stopped")).toEqual(["refresh", "back"]);
  });

  it("covers every workflow status with a well-formed menu", () => {
    expect(WORKFLOW_STATUSES).toHaveLength(10);
    for (const status of WORKFLOW_STATUSES) {
      const items = workflowActionsFor(status);
      expect(items[0]?.value).toBe("refresh");
      expect(items.at(-1)?.value).toBe("back");
      expect(items.every((item) => item.label.length > 0)).toBe(true);
      expect(new Set(items.map((item) => item.value)).size).toBe(items.length);
    }
  });

  it("never offers stop on a terminal status and always offers it otherwise", () => {
    for (const status of WORKFLOW_STATUSES) {
      expect(values(status).includes("stop")).toBe(!isTerminalWorkflow(status));
    }
  });

  it("offers pause and resume exactly where control() accepts them", () => {
    for (const status of WORKFLOW_STATUSES) {
      expect(values(status).includes("resume")).toBe(status === "paused" || status === "interrupted");
      expect(values(status).includes("pause")).toBe(status === "running");
    }
  });
});
