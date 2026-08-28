/**
 * journal.test.ts — schema-v3 script-run journal replay.
 *
 * Acceptance coverage from the optimization spec (A3):
 *  - run_created carries script text + hash + meta
 *  - node identity is the call index
 *  - schema v2 runs are quarantined rather than replayed
 *  - recovery events rotate call generations
 *  - buildResumeJournal reconstructs the runtime's cache map
 */

import { describe, expect, it } from "vitest";
import {
  applyRecoveryEvent,
  applyTerminalRecoveryEvent,
  buildResumeJournal,
  JOURNAL_SCHEMA_VERSION,
  type RunRecoveryEvent,
  replayJournal,
  type TerminalRecoveryEvent,
} from "../src/journal.js";

const SCRIPT = `export const meta = { name: "demo", description: "d" };
const a = await agent("first");
return a;`;

const runCreated = (runId: string, overrides: Record<string, unknown> = {}) => ({
  type: "custom" as const,
  customType: "pi-workflows:journal",
  data: {
    kind: "run_created",
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    runId,
    script: SCRIPT,
    scriptHash: "h".repeat(64),
    meta: { name: "demo", description: "d" },
    timestamp: 1,
    ...overrides,
  },
});

const runArgs = (runId: string, args: unknown, timestamp: number) => ({
  type: "custom" as const,
  customType: "pi-workflows:journal",
  data: {
    kind: "run_args",
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    runId,
    args,
    timestamp,
  },
});

const transition = (runId: string, status: string, timestamp: number, overrides: Record<string, unknown> = {}) => ({
  type: "custom" as const,
  customType: "pi-workflows:journal",
  data: {
    kind: "workflow_transition",
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    runId,
    status,
    timestamp,
    ...overrides,
  },
});

const callResult = (runId: string, nodeId: string, timestamp: number, overrides: Record<string, unknown> = {}) => ({
  type: "custom" as const,
  customType: "pi-workflows:journal",
  data: {
    kind: "call_result",
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    runId,
    nodeId,
    result: { status: "completed", compactionCount: 0, updatedAt: timestamp },
    callHash: `hash-${nodeId}`,
    timestamp,
    ...overrides,
  },
});

const workflowResult = (runId: string, nodeId: string, timestamp: number, overrides: Record<string, unknown> = {}) => ({
  type: "custom" as const,
  customType: "pi-workflows:journal",
  data: {
    kind: "workflow_result",
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    runId,
    nodeId,
    result: { status: "completed", result: { nested: true }, compactionCount: 0, updatedAt: timestamp },
    generation: 1,
    callHash: `workflow-hash-${nodeId}`,
    timestamp,
    ...overrides,
  },
});

describe("workflow journal replay (schema v3)", () => {
  it("replays a run_created with script text, hash, meta, and frozen args", () => {
    const runs = replayJournal([runCreated("r1", { args: { target: "x" }, frozenArgsPresent: true })]);
    const run = runs.get("r1");
    expect(run).toBeDefined();
    expect(run?.script).toBe(SCRIPT);
    expect(run?.scriptHash).toBe("h".repeat(64));
    expect(run?.meta.name).toBe("demo");
    expect(run?.args).toEqual({ target: "x" });
    expect(run?.frozenArgsPresent).toBe(true);
    expect(run?.status).toBe("pending");
  });

  it("deduplicates matching args facts and quarantines conflicting facts", () => {
    const matching = replayJournal([
      runCreated("args-fact"),
      runArgs("args-fact", { target: "stable" }, 2),
      runArgs("args-fact", { target: "stable" }, 3),
    ]);
    expect(matching.get("args-fact")?.args).toEqual({ target: "stable" });

    const diagnostics: string[] = [];
    const conflicting = replayJournal(
      [
        runCreated("args-conflict"),
        runArgs("args-conflict", { target: "one" }, 2),
        runArgs("args-conflict", { target: "two" }, 3),
      ],
      { onInvalid: (diagnostic) => diagnostics.push(diagnostic) },
    );
    expect(conflicting.has("args-conflict")).toBe(false);
    expect(diagnostics.some((diagnostic) => diagnostic.includes("conflicting workflow run args"))).toBe(true);
  });

  it("freezes current omitted args and rejects run_args fallback for marked runs", () => {
    const current = replayJournal([runCreated("current-omitted", { frozenArgsPresent: false })]).get("current-omitted");
    expect(current).toMatchObject({ frozenArgsPresent: false });
    expect(current?.args).toBeUndefined();

    const diagnostics: string[] = [];
    const rejected = replayJournal(
      [
        runCreated("current-fallback", { frozenArgsPresent: false }),
        runArgs("current-fallback", { target: "must-not-apply" }, 2),
      ],
      { onInvalid: (diagnostic) => diagnostics.push(diagnostic) },
    );
    expect(rejected.has("current-fallback")).toBe(false);
    expect(diagnostics.some((diagnostic) => diagnostic.includes("cannot override frozen workflow args presence"))).toBe(
      true,
    );
  });

  it("validates frozen args marker consistency and conflicting duplicate markers", () => {
    const inconsistent = replayJournal([
      runCreated("inconsistent", { frozenArgsPresent: false, args: { target: "x" } }),
    ]);
    expect(inconsistent.has("inconsistent")).toBe(false);

    const duplicate = replayJournal([
      runCreated("duplicate-marker", { frozenArgsPresent: false }),
      runCreated("duplicate-marker"),
    ]);
    expect(duplicate.has("duplicate-marker")).toBe(false);
  });

  it("normalizes fractional frozen execution limits during restore", () => {
    const run = replayJournal([
      runCreated("fractional", {
        frozenMaxAgents: 9.8,
        frozenConcurrency: 4.7,
        frozenAgentRetries: 2.9,
        frozenTokenBudget: 500.6,
        frozenAgentTimeoutMs: 1_500.4,
      }),
    ]).get("fractional");
    expect(run).toMatchObject({
      frozenMaxAgents: 9,
      frozenConcurrency: 4,
      frozenAgentRetries: 2,
      frozenTokenBudget: 500,
      frozenAgentTimeoutMs: 1_500,
    });
  });

  it("quarantines a schema-v2 declarative run instead of replaying it", () => {
    const diagnostics: string[] = [];
    const v2 = {
      type: "custom" as const,
      customType: "pi-workflows:journal",
      data: {
        kind: "run_created",
        schemaVersion: 2,
        runId: "old",
        definition: { name: "old", phases: [], tasks: [], background: true },
        timestamp: 1,
      },
    };
    const runs = replayJournal([v2], { onInvalid: (d) => diagnostics.push(d) });
    expect(runs.size).toBe(0);
    expect(diagnostics.length).toBe(1);
  });

  it("replays call_result facts keyed by call index and settles the run", () => {
    const runs = replayJournal([
      runCreated("r2"),
      transition("r2", "running", 2),
      callResult("r2", "0", 3, { result: { status: "completed", result: "ok", compactionCount: 0, updatedAt: 3 } }),
      transition("r2", "completed", 4, { finalResult: { report: "done" } }),
    ]);
    const run = runs.get("r2");
    expect(run?.status).toBe("completed");
    expect(run?.callResults["0"]?.result).toBe("ok");
    expect(run?.callStatus["0"]).toBe("completed");
    expect(run?.finalResult).toEqual({ report: "done" });
  });

  it("rejects an unknown run reference", () => {
    const diagnostics: string[] = [];
    const runs = replayJournal(
      [
        {
          type: "custom" as const,
          customType: "pi-workflows:journal",
          data: {
            kind: "call_result",
            schemaVersion: JOURNAL_SCHEMA_VERSION,
            runId: "missing",
            nodeId: "0",
            result: { status: "completed", compactionCount: 0, updatedAt: 3 },
            timestamp: 3,
          },
        },
      ],
      { onInvalid: (d) => diagnostics.push(d) },
    );
    expect(runs.size).toBe(0);
    expect(diagnostics.some((d) => d.includes("unknown run"))).toBe(true);
  });

  it("rejects a call index beyond the 1000-call limit", () => {
    const diagnostics: string[] = [];
    const runs = replayJournal([runCreated("r3"), callResult("r3", "1000", 3)], {
      onInvalid: (d) => diagnostics.push(d),
    });
    expect(runs.size).toBe(0);
    expect(diagnostics.some((d) => d.includes("call index"))).toBe(true);
  });

  it("applies a run_recovery rotation that advances the call generation", () => {
    const run = replayJournal([runCreated("r4"), callResult("r4", "0", 3)]).get("r4");
    if (!run) throw new Error("run r4 missing");
    const rotation = {
      nodeId: "0",
      sourceAttemptId: `${run.runId}/call-0/attempt-1`,
      sourceGeneration: 1,
      sourceStatus: "running" as const,
      attemptId: `${run.runId}/call-0/attempt-2`,
      generation: 2,
      owner: {
        extension: "pi-workflows" as const,
        runId: run.runId,
        nodeId: "0",
        attemptId: `${run.runId}/call-0/attempt-2`,
      },
    };
    const event: RunRecoveryEvent = {
      kind: "run_recovery",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: run.runId,
      status: "interrupted",
      branchGeneration: 0,
      rotations: [rotation],
      recoveryId: `r3-${"a".repeat(64)}`,
      timestamp: 5,
    };
    applyRecoveryEvent(run, event);
    expect(run.status).toBe("interrupted");
    expect(run.attempts["0"]).toBe(2);
    expect(run.attemptIds["0"]).toBe(`${run.runId}/call-0/attempt-2`);
    expect(run.callStatus["0"]).toBe("running");
  });

  it("applies a terminal recovery that marks the run stopped and non-resumable", () => {
    const run = replayJournal([runCreated("r5"), transition("r5", "running", 2)]).get("r5");
    if (!run) throw new Error("run r5 missing");
    const terminal: TerminalRecoveryEvent = {
      kind: "terminal_recovery",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: run.runId,
      status: "stopped",
      terminalIntent: "stop",
      branchGeneration: 0,
      terminalResults: [],
      blockedNodeIds: [],
      error: "workflow stopped",
      recoveryId: `r3-${"b".repeat(64)}`,
      timestamp: 5,
    };
    applyTerminalRecoveryEvent(run, terminal);
    expect(run.status).toBe("stopped");
    expect(run.nonResumable).toBe(true);
    expect(run.error).toBe("workflow stopped");
  });

  it("replays nested workflow results without a managed attempt id", () => {
    const runs = replayJournal([runCreated("nested"), workflowResult("nested", "0", 2)]);
    const run = runs.get("nested");
    expect(run?.callResults["0"]?.result).toEqual({ nested: true });
    expect(run?.callStatus["0"]).toBe("completed");
    expect(buildResumeJournal([runCreated("nested"), workflowResult("nested", "0", 2)]).get("nested:0")).toMatchObject({
      result: { nested: true },
    });
  });

  it("restores the newest nested generation and ignores a later stale fact", () => {
    const generationOne = workflowResult("nested-generation", "0", 2, {
      result: { status: "completed", result: "old", compactionCount: 0, updatedAt: 2 },
      agentCount: 1,
    });
    const generationTwo = workflowResult("nested-generation", "0", 3, {
      generation: 2,
      result: { status: "completed", result: "new", compactionCount: 0, updatedAt: 3 },
      agentCount: 2,
    });
    const stale = workflowResult("nested-generation", "0", 4, {
      result: { status: "completed", result: "stale", compactionCount: 0, updatedAt: 4 },
      agentCount: 1,
    });
    const entries = [runCreated("nested-generation"), generationOne, generationTwo, stale];
    const run = replayJournal(entries).get("nested-generation");
    expect(run?.callResults["0"]?.result).toBe("new");
    expect(run?.workflowResultGenerations["0"]).toBe(2);
    expect(buildResumeJournal(entries).get("nested-generation:0")).toMatchObject({
      result: "new",
      generation: 2,
      agentCount: 2,
    });
  });

  it("rejects contradictory nested results only within the same generation", () => {
    const diagnostics: string[] = [];
    const runs = replayJournal(
      [
        runCreated("nested-conflict"),
        workflowResult("nested-conflict", "0", 2),
        workflowResult("nested-conflict", "0", 3, {
          result: { status: "completed", result: { nested: false }, compactionCount: 0, updatedAt: 3 },
        }),
      ],
      { onInvalid: (diagnostic) => diagnostics.push(diagnostic) },
    );
    expect(runs.has("nested-conflict")).toBe(false);
    expect(diagnostics.some((diagnostic) => diagnostic.includes("contradictory nested workflow result"))).toBe(true);
  });

  it("buildResumeJournal reconstructs the runtime cache map keyed by runId:callIndex", () => {
    const entries = [
      runCreated("r6"),
      callResult("r6", "0", 3, { result: { status: "completed", result: "a", compactionCount: 0, updatedAt: 3 } }),
      callResult("r6", "1", 4, {
        result: { status: "completed", result: { nested: true }, compactionCount: 0, updatedAt: 4 },
        storeDelta: { k: "v" },
      }),
      // A result without a callHash is not replayable.
      {
        type: "custom" as const,
        customType: "pi-workflows:journal",
        data: {
          kind: "call_result",
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          runId: "r6",
          nodeId: "2",
          result: { status: "completed", result: "x", compactionCount: 0, updatedAt: 5 },
          timestamp: 5,
        },
      },
    ];
    const journal = buildResumeJournal(entries);
    expect(journal.size).toBe(2);
    expect(journal.get("r6:0")).toMatchObject({ index: 0, runId: "r6", result: "a" });
    expect(journal.get("r6:1")?.result).toEqual({ nested: true });
    expect(journal.get("r6:1")?.storeDelta).toEqual({ k: "v" });
    expect(journal.get("r6:2")).toBeUndefined();
  });

  it("deduplicates identical creation and honors durable removal", () => {
    const created = runCreated("r7");
    const revision = {
      type: "custom" as const,
      customType: "pi-workflows:journal",
      data: {
        kind: "run_revision",
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        runId: "r7",
        revision: 1,
        script: `${SCRIPT}\n// revised`,
        scriptHash: "r".repeat(64),
        meta: { name: "demo", description: "revised" },
        timestamp: 2,
      },
    };
    const removed = {
      type: "custom" as const,
      customType: "pi-workflows:journal",
      data: { kind: "run_removed", schemaVersion: JOURNAL_SCHEMA_VERSION, runId: "r7", timestamp: 3 },
    };
    expect(replayJournal([created, created, revision, removed]).has("r7")).toBe(false);
  });

  it("restores a completed script that handled a failed child result", () => {
    const failed = callResult("handled", "0", 3, {
      result: { status: "failed", error: "handled", compactionCount: 0, updatedAt: 3 },
    });
    const runs = replayJournal([
      runCreated("handled"),
      transition("handled", "running", 2),
      failed,
      transition("handled", "completed", 4),
    ]);
    expect(runs.get("handled")?.status).toBe("completed");
    expect(runs.get("handled")?.callStatus["0"]).toBe("failed");
  });

  it("does not put failed call facts into the replay cache", () => {
    const failed = callResult("r8", "0", 2, {
      result: { status: "failed", error: "no", compactionCount: 0, updatedAt: 2 },
    });
    expect(buildResumeJournal([runCreated("r8"), failed]).size).toBe(0);
  });
});
