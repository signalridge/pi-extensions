import { describe, expect, it } from "vitest";
import {
  deriveRecoveryId,
  JOURNAL_ENTRY_TYPE,
  type JournalEvent,
  replayJournal,
  type SessionEntryLike,
} from "../src/journal.js";
import type { WorkflowDefinition } from "../src/schema.js";

const definition: WorkflowDefinition = {
  name: "journal",
  phases: [],
  tasks: [{ id: "a", subagent_type: "Explore", description: "A", prompt: "A", depends_on: [] }],
  background: false,
};

describe("workflow journal replay", () => {
  it("reconstructs transitions, results, and compaction observations", () => {
    const events: JournalEvent[] = [
      { kind: "run_created", schemaVersion: 1, runId: "run-1", definition, timestamp: 1 },
      { kind: "workflow_transition", schemaVersion: 1, runId: "run-1", status: "running", timestamp: 2 },
      {
        kind: "task_transition",
        schemaVersion: 1,
        runId: "run-1",
        nodeId: "a",
        status: "running",
        agentId: "agent-1",
        timestamp: 3,
      },
      { kind: "task_compacted", schemaVersion: 1, runId: "run-1", nodeId: "a", compactionCount: 2, timestamp: 4 },
      {
        kind: "task_result",
        schemaVersion: 1,
        runId: "run-1",
        nodeId: "a",
        result: { status: "completed", agentId: "agent-1", text: "done", compactionCount: 2, updatedAt: 5 },
        timestamp: 5,
      },
    ];
    const runs = replayJournal(events.map((data) => ({ type: "custom", customType: JOURNAL_ENTRY_TYPE, data })));
    const run = runs.get("run-1");
    expect(run?.status).toBe("running");
    expect(run?.agentIds.a).toBe("agent-1");
    expect(run?.taskResults.a?.text).toBe("done");
    expect(run?.compactions.a).toBe(2);
  });

  it("skips malformed, future, unknown-node, and forged-owner entries once", () => {
    const diagnostics: string[] = [];
    const entries = [
      {
        type: "custom",
        customType: JOURNAL_ENTRY_TYPE,
        data: { kind: "run_created", schemaVersion: 99, runId: "future", definition, timestamp: 1 },
      },
      {
        type: "custom",
        customType: JOURNAL_ENTRY_TYPE,
        data: { kind: "run_created", schemaVersion: 1, runId: "valid", definition, timestamp: 1 },
      },
      {
        type: "custom",
        customType: JOURNAL_ENTRY_TYPE,
        data: {
          kind: "task_transition",
          schemaVersion: 1,
          runId: "valid",
          nodeId: "missing",
          status: "running",
          timestamp: 2,
        },
      },
      {
        type: "custom",
        customType: JOURNAL_ENTRY_TYPE,
        data: {
          kind: "task_result",
          schemaVersion: 1,
          runId: "valid",
          nodeId: "a",
          owner: { extension: "other", runId: "valid", nodeId: "a" },
          result: { status: "completed", compactionCount: 0, updatedAt: 2 },
          timestamp: 2,
        },
      },
      {
        type: "custom",
        customType: JOURNAL_ENTRY_TYPE,
        data: { kind: "workflow_transition", schemaVersion: 1, runId: "valid", status: "running", timestamp: 2 },
      },
    ];
    const runs = replayJournal(entries, { onInvalid: (diagnostic) => diagnostics.push(diagnostic) });
    expect(runs.get("valid")).toBeUndefined();
    expect(runs.get("future")).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatch(/quarantined malformed workflow journal run/);
  });

  it("accepts an older direct pending-to-running task transition for replay compatibility", () => {
    const runs = replayJournal([
      {
        type: "custom",
        customType: JOURNAL_ENTRY_TYPE,
        data: { kind: "run_created", schemaVersion: 1, runId: "legacy", definition, timestamp: 1 },
      },
      {
        type: "custom",
        customType: JOURNAL_ENTRY_TYPE,
        data: {
          kind: "task_transition",
          schemaVersion: 1,
          runId: "legacy",
          nodeId: "a",
          status: "running",
          timestamp: 2,
        },
      },
    ]);
    expect(runs.get("legacy")?.taskStatus.a).toBe("running");
  });

  it("replays a self-contained recovery event and quarantines duplicate generations", () => {
    const runId = "atomic-journal";
    const attemptOne = `${runId}/a/attempt-1`;
    const attemptTwo = `${runId}/a/attempt-2`;
    const base: SessionEntryLike[] = [
      {
        type: "custom",
        customType: JOURNAL_ENTRY_TYPE,
        data: {
          kind: "run_created",
          schemaVersion: 2,
          runId,
          definition,
          attempts: { a: 1, __synthesis__: 1 },
          attemptIds: { a: attemptOne, __synthesis__: `${runId}/__synthesis__/attempt-1` },
          timestamp: 1,
        },
      },
      {
        type: "custom",
        customType: JOURNAL_ENTRY_TYPE,
        data: { kind: "workflow_transition", schemaVersion: 2, runId, status: "running", timestamp: 2 },
      },
      {
        type: "custom",
        customType: JOURNAL_ENTRY_TYPE,
        data: {
          kind: "task_transition",
          schemaVersion: 2,
          runId,
          nodeId: "a",
          status: "running",
          attemptId: attemptOne,
          agentId: "old-agent",
          owner: { extension: "pi-workflows", runId, nodeId: "a", attemptId: attemptOne },
          timestamp: 3,
        },
      },
    ];
    const recovery = {
      kind: "run_recovery",
      schemaVersion: 2,
      runId,
      status: "interrupted",
      branchGeneration: 12,
      rotations: [
        {
          nodeId: "a",
          sourceAttemptId: attemptOne,
          sourceGeneration: 1,
          sourceStatus: "running",
          attemptId: attemptTwo,
          generation: 2,
          owner: { extension: "pi-workflows", runId, nodeId: "a", attemptId: attemptTwo },
          supersededAgentId: "old-agent",
        },
      ],
      timestamp: 4,
    };
    const recoveryWithId = { ...recovery, recoveryId: deriveRecoveryId(recovery) };
    const runs = replayJournal([...base, { type: "custom", customType: JOURNAL_ENTRY_TYPE, data: recoveryWithId }]);
    const run = runs.get(runId);
    expect(run?.status).toBe("interrupted");
    expect(run?.taskStatus.a).toBe("ready");
    expect(run?.attempts.a).toBe(2);
    expect(run?.attemptIds.a).toBe(attemptTwo);
    expect(run?.agentIds.a).toBeUndefined();
    expect(run?.taskResults.a).toBeUndefined();
    expect(run?.compactions.a).toBe(0);

    // A stale top-level generation must be ignored even if the payload names a
    // newer attempt. It must not mutate the recovered branch or quarantine the
    // whole run.
    const staleGeneration = replayJournal([
      ...base,
      { type: "custom", customType: JOURNAL_ENTRY_TYPE, data: recoveryWithId },
      {
        type: "custom",
        customType: JOURNAL_ENTRY_TYPE,
        data: {
          kind: "task_result",
          schemaVersion: 2,
          runId,
          nodeId: "a",
          attemptId: attemptOne,
          result: {
            status: "completed",
            attemptId: attemptTwo,
            text: "stale result",
            compactionCount: 0,
            updatedAt: 5,
          },
          owner: { extension: "pi-workflows", runId, nodeId: "a", attemptId: attemptOne },
          timestamp: 5,
        },
      },
    ]);
    expect(staleGeneration.get(runId)?.taskStatus.a).toBe("ready");
    expect(staleGeneration.get(runId)?.taskResults.a).toBeUndefined();

    expect(recoveryWithId.recoveryId).toMatch(/^r1-[0-9a-f]{64}$/);
    const diagnostics: string[] = [];
    const duplicate = replayJournal(
      [
        ...base,
        { type: "custom", customType: JOURNAL_ENTRY_TYPE, data: recoveryWithId },
        { type: "custom", customType: JOURNAL_ENTRY_TYPE, data: recoveryWithId },
      ],
      { onInvalid: (diagnostic) => diagnostics.push(diagnostic) },
    );
    expect(duplicate.get(runId)?.attempts.a).toBe(2);
    expect(diagnostics).toHaveLength(0);

    const conflictDiagnostics: string[] = [];
    const conflict = replayJournal(
      [
        ...base,
        { type: "custom", customType: JOURNAL_ENTRY_TYPE, data: recoveryWithId },
        {
          type: "custom",
          customType: JOURNAL_ENTRY_TYPE,
          data: {
            ...recoveryWithId,
            rotations: [{ ...recoveryWithId.rotations[0], supersededAgentId: "different-agent" }],
          },
        },
      ],
      { onInvalid: (diagnostic) => conflictDiagnostics.push(diagnostic) },
    );
    expect(conflict.get(runId)).toBeUndefined();
    expect(conflictDiagnostics).toHaveLength(1);

    const legacy = replayJournal([
      ...base,
      { type: "custom", customType: JOURNAL_ENTRY_TYPE, data: recovery },
      { type: "custom", customType: JOURNAL_ENTRY_TYPE, data: recovery },
    ]);
    expect(legacy.get(runId)?.attempts.a).toBe(2);

    const nextAttempt = `${runId}/a/attempt-3`;
    const nextRecoveryBase = {
      kind: "run_recovery" as const,
      schemaVersion: 2 as const,
      runId,
      status: "interrupted" as const,
      branchGeneration: 13,
      rotations: [
        {
          ...recoveryWithId.rotations[0],
          sourceAttemptId: attemptTwo,
          sourceGeneration: 2,
          sourceStatus: "ready" as const,
          attemptId: nextAttempt,
          generation: 3,
          owner: { extension: "pi-workflows" as const, runId, nodeId: "a", attemptId: nextAttempt },
        },
      ],
      timestamp: 6,
    };
    const nextRecovery = { ...nextRecoveryBase, recoveryId: deriveRecoveryId(nextRecoveryBase) };
    const newer = replayJournal([
      ...base,
      { type: "custom", customType: JOURNAL_ENTRY_TYPE, data: recoveryWithId },
      {
        type: "custom",
        customType: JOURNAL_ENTRY_TYPE,
        data: { kind: "workflow_transition", schemaVersion: 2, runId, status: "running", timestamp: 5 },
      },
      { type: "custom", customType: JOURNAL_ENTRY_TYPE, data: nextRecovery },
      { type: "custom", customType: JOURNAL_ENTRY_TYPE, data: nextRecovery },
    ]);
    expect(newer.get(runId)?.attempts.a).toBe(3);
    expect(newer.get(runId)?.attemptIds.a).toBe(nextAttempt);

    const invalidId = replayJournal([
      ...base,
      {
        type: "custom",
        customType: JOURNAL_ENTRY_TYPE,
        data: { ...recoveryWithId, recoveryId: "r1-too-short" },
      },
    ]);
    expect(invalidId.get(runId)).toBeUndefined();

    const foreignRun = replayJournal([
      ...base,
      { type: "custom", customType: JOURNAL_ENTRY_TYPE, data: recoveryWithId },
      {
        type: "custom",
        customType: JOURNAL_ENTRY_TYPE,
        data: { ...recoveryWithId, runId: "foreign-run" },
      },
    ]);
    expect(foreignRun.get(runId)?.attempts.a).toBe(2);
    expect(foreignRun.get("foreign-run")).toBeUndefined();
  });

  it("quarantines owner-missing attempt-aware events instead of falling back to the current generation", () => {
    const runId = "owner-missing";
    const attemptId = `${runId}/a/attempt-1`;
    const synthesisAttemptId = `${runId}/__synthesis__/attempt-1`;
    const custom = (data: unknown): SessionEntryLike => ({
      type: "custom",
      customType: JOURNAL_ENTRY_TYPE,
      data,
    });
    const runs = replayJournal([
      custom({
        kind: "run_created",
        schemaVersion: 2,
        runId,
        definition,
        attempts: { a: 1, __synthesis__: 1 },
        attemptIds: { a: attemptId, __synthesis__: synthesisAttemptId },
        timestamp: 1,
      }),
      custom({ kind: "workflow_transition", schemaVersion: 2, runId, status: "running", timestamp: 2 }),
      custom({
        kind: "task_transition",
        schemaVersion: 2,
        runId,
        nodeId: "a",
        status: "running",
        attemptId,
        timestamp: 3,
      }),
      custom({
        kind: "task_result",
        schemaVersion: 2,
        runId,
        nodeId: "a",
        attemptId,
        result: { status: "completed", attemptId, compactionCount: 0, updatedAt: 4 },
        timestamp: 4,
      }),
      custom({
        kind: "task_compacted",
        schemaVersion: 2,
        runId,
        nodeId: "a",
        attemptId,
        compactionCount: 1,
        timestamp: 5,
      }),
      custom({
        kind: "synthesis_result",
        schemaVersion: 2,
        runId,
        attemptId: synthesisAttemptId,
        result: { status: "completed", attemptId: synthesisAttemptId, compactionCount: 0, updatedAt: 6 },
        timestamp: 6,
      }),
    ]);
    expect(runs.get(runId)).toBeUndefined();
  });
});
