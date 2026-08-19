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

describe("workflow journal replay (schema v3)", () => {
  it("replays a run_created with script text, hash, and meta", () => {
    const runs = replayJournal([runCreated("r1")]);
    const run = runs.get("r1");
    expect(run).toBeDefined();
    expect(run?.script).toBe(SCRIPT);
    expect(run?.scriptHash).toBe("h".repeat(64));
    expect(run?.meta.name).toBe("demo");
    expect(run?.status).toBe("pending");
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
      transition("r2", "completed", 4),
    ]);
    const run = runs.get("r2");
    expect(run?.status).toBe("completed");
    expect(run?.callResults["0"]?.result).toBe("ok");
    expect(run?.callStatus["0"]).toBe("completed");
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
});
