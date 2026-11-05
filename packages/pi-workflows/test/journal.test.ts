/**
 * journal.test.ts — schema-v4 script-run journal replay.
 *
 * Acceptance coverage from the optimization spec (A3):
 *  - run_created carries script text + hash + meta
 *  - node identity is the call index
 *  - pre-schema-v4 runs are quarantined rather than replayed
 *  - recovery events rotate call generations
 *  - buildResumeJournal reconstructs the runtime's cache map
 */

import { parseManagedTerminalSnapshot } from "@signalridge/pi-subagents-protocol";
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
    frozenArgsPresent: false,
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

const callAttempt = (runId: string, nodeId: string, timestamp: number) => ({
  type: "custom" as const,
  customType: "pi-workflows:journal",
  data: {
    kind: "call_attempt",
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    runId,
    nodeId,
    attemptId: `${runId}/${nodeId}/attempt-1`,
    generation: 1,
    tier: "low",
    owner: {
      extension: "pi-workflows",
      runId,
      nodeId,
      attemptId: `${runId}/${nodeId}/attempt-1`,
    },
    timestamp,
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

describe("workflow journal replay (schema v4)", () => {
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

  it("deduplicates identical recovery events without quarantining the run", () => {
    const recovery = {
      type: "custom" as const,
      customType: "pi-workflows:journal",
      data: {
        kind: "run_recovery",
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        runId: "recovery-duplicate",
        status: "interrupted",
        branchGeneration: 7,
        rotations: [],
        recoveryId: `r4-${"a".repeat(64)}`,
        timestamp: 2,
      },
    };
    const terminal = {
      type: "custom" as const,
      customType: "pi-workflows:journal",
      data: {
        kind: "terminal_recovery",
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        runId: "terminal-duplicate",
        status: "stopped",
        terminalIntent: "stop",
        branchGeneration: 9,
        terminalResults: [],
        blockedNodeIds: [],
        error: "stopped",
        recoveryId: `r4-${"b".repeat(64)}`,
        timestamp: 2,
      },
    };

    const runs = replayJournal([
      runCreated("recovery-duplicate"),
      recovery,
      recovery,
      runCreated("terminal-duplicate"),
      terminal,
      terminal,
    ]);

    expect(runs.get("recovery-duplicate")?.status).toBe("interrupted");
    expect(runs.get("terminal-duplicate")?.status).toBe("stopped");
  });

  it("compares duplicate creation facts against immutable creation state", () => {
    const created = runCreated("creation-fact");
    const duplicate = runCreated("creation-fact");
    const replayed = replayJournal([created, callAttempt("creation-fact", "0", 2), duplicate]);
    expect(replayed.get("creation-fact")?.callStatus["0"]).toBe("running");

    const conflicting = replayJournal([
      runCreated("creation-conflict", { frozenMaxAgents: 1 }),
      runCreated("creation-conflict", { frozenMaxAgents: 2 }),
    ]);
    expect(conflicting.has("creation-conflict")).toBe(false);
  });

  it("quarantines legacy journal meta policy fields instead of ignoring them", () => {
    const diagnostics: string[] = [];
    const run = replayJournal(
      [
        runCreated("legacy-meta", {
          meta: {
            name: "legacy",
            description: "old policy",
            model: "provider/old",
            thinking: "high",
            phases: [{ title: "phase", model: "provider/phase", thinking: "low" }],
          },
        }),
      ],
      { onInvalid: (diagnostic) => diagnostics.push(diagnostic) },
    ).get("legacy-meta");

    expect(run).toBeUndefined();
    expect(diagnostics.some((diagnostic) => diagnostic.includes("workflow journal meta model/thinking"))).toBe(true);
  });

  it("requires an explicit frozen-args marker in the schema-v4 creation fact", () => {
    const diagnostics: string[] = [];
    const runs = replayJournal([runCreated("missing-marker", { frozenArgsPresent: undefined })], {
      onInvalid: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(runs.has("missing-marker")).toBe(false);
    expect(diagnostics.some((diagnostic) => diagnostic.includes("presence marker is required"))).toBe(true);
  });

  it("validates frozen args marker consistency and conflicting duplicate markers", () => {
    const inconsistent = replayJournal([
      runCreated("inconsistent", { frozenArgsPresent: false, args: { target: "x" } }),
    ]);
    expect(inconsistent.has("inconsistent")).toBe(false);

    const duplicate = replayJournal([
      runCreated("duplicate-marker", { frozenArgsPresent: false }),
      runCreated("duplicate-marker", { frozenArgsPresent: true, args: { target: "x" } }),
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

  it("quarantines present malformed frozen run options", () => {
    const invalidOptions: Array<[string, unknown]> = [
      ["frozenMaxAgents", 0],
      ["frozenConcurrency", "four"],
      ["frozenAgentRetries", -1],
      ["frozenTokenBudget", false],
      ["frozenAgentTimeoutMs", 0],
      ["frozenExcludeTools", ["ok", 42]],
      ["toolset", ""],
    ];

    for (const [key, value] of invalidOptions) {
      const runId = `malformed-${key}`;
      const runs = replayJournal([runCreated(runId, { [key]: value })]);
      expect(runs.has(runId)).toBe(false);
    }
  });

  it("bounds terminal results in run recovery events", () => {
    const diagnostics: string[] = [];
    const terminalResults = Array.from({ length: 1_001 }, () => ({
      status: "completed",
      compactionCount: 0,
      updatedAt: 2,
    }));
    const runs = replayJournal(
      [
        runCreated("recovery-limit"),
        {
          type: "custom" as const,
          customType: "pi-workflows:journal",
          data: {
            kind: "run_recovery",
            schemaVersion: JOURNAL_SCHEMA_VERSION,
            runId: "recovery-limit",
            status: "interrupted",
            branchGeneration: 1,
            rotations: [],
            terminalResults,
            recoveryId: `r4-${"c".repeat(64)}`,
            timestamp: 2,
          },
        },
      ],
      { onInvalid: (diagnostic) => diagnostics.push(diagnostic) },
    );
    expect(runs.has("recovery-limit")).toBe(false);
    expect(diagnostics.some((diagnostic) => diagnostic.includes("terminalResults are invalid"))).toBe(true);
  });

  it("quarantines a schema-v3 run instead of replaying it", () => {
    const diagnostics: string[] = [];
    const v2 = {
      type: "custom" as const,
      customType: "pi-workflows:journal",
      data: {
        kind: "run_created",
        schemaVersion: 3,
        runId: "old",
        script: SCRIPT,
        scriptHash: "h".repeat(64),
        meta: { name: "old", description: "old" },
        frozenArgsPresent: false,
        timestamp: 1,
      },
    };
    const runs = replayJournal([v2], { onInvalid: (d) => diagnostics.push(d) });
    expect(runs.size).toBe(0);
    expect(diagnostics.length).toBe(1);
  });

  it("retains tier identity from call attempts when a run is restored", () => {
    const run = replayJournal([runCreated("attempts"), callAttempt("attempts", "0", 2)]).get("attempts");
    expect(run?.callTiers["0"]).toEqual({ tier: "low" });
    expect(run?.callStatus["0"]).toBe("running");
  });

  it("retains attempt tier identity when a terminal result omits optional tier fields", () => {
    const runId = "partial-terminal-tier";
    const attemptId = `${runId}/0/attempt-1`;
    const run = replayJournal([
      runCreated(runId),
      callAttempt(runId, "0", 2),
      callResult(runId, "0", 3, {
        result: { status: "completed", compactionCount: 0, updatedAt: 3, attemptId },
        attemptId,
        owner: { extension: "pi-workflows", runId, nodeId: "0", attemptId },
      }),
    ]).get(runId);

    expect(run?.callTiers["0"]).toEqual({ tier: "low" });
  });

  it("replays call_result facts keyed by call index and settles the run", () => {
    const runs = replayJournal([
      runCreated("r2"),
      transition("r2", "running", 2),
      callResult("r2", "0", 3, {
        result: {
          status: "completed",
          result: "ok",
          tier: "low",
          compactionCount: 0,
          updatedAt: 3,
        },
      }),
      transition("r2", "completed", 4, { finalResult: { report: "done" } }),
    ]);
    const run = runs.get("r2");
    expect(run?.status).toBe("completed");
    expect(run?.callResults["0"]?.result).toBe("ok");
    expect(run?.callResults["0"]?.tier).toBe("low");
    expect(run?.callStatus["0"]).toBe("completed");
    expect(run?.finalResult).toEqual({ report: "done" });
  });

  it.each([257, 2_000])(
    "restores an exact %i-character managed transcript pointer with terminal ownership",
    (length) => {
      const runId = "pointer-boundary";
      const attemptId = `${runId}/0/attempt-1`;
      const owner = { extension: "pi-workflows", runId, nodeId: "0", attemptId };
      const outputFile = `/transcripts/${"x".repeat(length - 13)}`;
      const result = {
        status: "failed",
        attemptId,
        agentId: "child",
        outputFile,
        tokenCount: 0,
        compactionCount: 2,
        updatedAt: 3,
      };
      const entries = [
        runCreated(runId),
        transition(runId, "running", 2),
        callAttempt(runId, "0", 2),
        callResult(runId, "0", 3, { result, attemptId, owner, callHash: undefined }),
        transition(runId, "completed", 4),
      ];
      const accepted: unknown[] = [];
      const diagnostics: string[] = [];
      const restored = replayJournal(entries, {
        onInvalid: (message) => diagnostics.push(message),
        onAccepted: (event) => accepted.push(event),
      }).get(runId);
      expect(diagnostics).toEqual([]);
      expect(restored?.status).toBe("completed");
      expect(restored?.callStatus["0"]).toBe("failed");
      expect(restored?.attemptIds["0"]).toBe(attemptId);
      expect(restored?.agentIds["0"]).toBe("child");
      expect(restored?.callResults["0"]).toEqual({ ...result, tier: "low" });
      expect(accepted).toContainEqual(expect.objectContaining({ kind: "call_result", owner }));
      expect(buildResumeJournal(entries).size).toBe(0);
    },
  );

  it.each(["x".repeat(2_001), "", " \t\n ", 42, null, {}])(
    "rejects a persisted transcript pointer rejected by the managed protocol: %j",
    (outputFile) => {
      expect(() =>
        parseManagedTerminalSnapshot({ status: "failed", outputFile, compactionCount: 0, completedAt: 1 }),
      ).toThrow();
      const diagnostics: string[] = [];
      const runs = replayJournal(
        [
          runCreated("invalid-pointer"),
          callResult("invalid-pointer", "0", 3, {
            result: { status: "failed", outputFile, tokenCount: 0, compactionCount: 0, updatedAt: 3 },
          }),
        ],
        { onInvalid: (message) => diagnostics.push(message) },
      );
      expect(runs.has("invalid-pointer")).toBe(false);
      expect(diagnostics).toHaveLength(1);
    },
  );

  it("keeps the journal's generic identity bound independent of transcript pointers", () => {
    const runs = replayJournal([
      runCreated("long-agent-id"),
      callResult("long-agent-id", "0", 3, {
        result: { status: "failed", agentId: "x".repeat(257), compactionCount: 0, updatedAt: 3 },
      }),
    ]);
    expect(runs.has("long-agent-id")).toBe(false);
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
      tier: "cheap",
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
      recoveryId: `r4-${"a".repeat(64)}`,
      timestamp: 5,
    };
    applyRecoveryEvent(run, event);
    expect(run.status).toBe("interrupted");
    expect(run.attempts["0"]).toBe(2);
    expect(run.attemptIds["0"]).toBe(`${run.runId}/call-0/attempt-2`);
    expect(run.callStatus["0"]).toBe("running");
    expect(run.callTiers["0"]).toEqual({ tier: "cheap" });
  });

  it("preserves call tier identity when an older recovery rotation omits it", () => {
    const run = replayJournal([runCreated("rotation-identity"), callAttempt("rotation-identity", "0", 2)]).get(
      "rotation-identity",
    );
    if (!run) throw new Error("run rotation-identity missing");
    applyRecoveryEvent(run, {
      kind: "attempt_recovery",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: run.runId,
      nodeId: "0",
      branchGeneration: 0,
      rotation: {
        nodeId: "0",
        sourceAttemptId: `${run.runId}/0/attempt-1`,
        sourceGeneration: 1,
        sourceStatus: "running",
        attemptId: `${run.runId}/0/attempt-2`,
        generation: 2,
        owner: {
          extension: "pi-workflows",
          runId: run.runId,
          nodeId: "0",
          attemptId: `${run.runId}/0/attempt-2`,
        },
      },
      timestamp: 3,
    });
    expect(run.callTiers["0"]).toEqual({ tier: "low" });
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
      recoveryId: `r4-${"b".repeat(64)}`,
      timestamp: 5,
    };
    applyTerminalRecoveryEvent(run, terminal);
    expect(run.status).toBe("stopped");
    expect(run.nonResumable).toBe(true);
    expect(run.error).toBe("workflow stopped");
  });

  it("does not let a delayed identity transition regress a terminal call", () => {
    const runId = "late-tier-transition";
    const entries = [
      runCreated(runId),
      transition(runId, "running", 2),
      callResult(runId, "0", 3, {
        result: { status: "completed", result: "done", compactionCount: 0, updatedAt: 3 },
      }),
      {
        type: "custom" as const,
        customType: "pi-workflows:journal",
        data: {
          kind: "call_transition",
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          runId,
          nodeId: "0",
          status: "running",
          tier: "cheap",
          timestamp: 4,
        },
      },
      transition(runId, "completed", 5),
    ];

    const run = replayJournal(entries).get(runId);
    expect(run?.callStatus["0"]).toBe("completed");
    expect(run?.callTiers["0"]).toEqual({ tier: "cheap" });
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

  it("ignores a delayed call result from a superseded attempt", () => {
    const runId = "stale-call-result";
    const firstAttemptId = `${runId}/0/attempt-1`;
    const secondAttemptId = `${runId}/0/attempt-2`;
    const attempt2 = {
      type: "custom" as const,
      customType: "pi-workflows:journal",
      data: {
        kind: "call_attempt",
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        runId,
        nodeId: "0",
        attemptId: secondAttemptId,
        generation: 2,
        owner: { extension: "pi-workflows" as const, runId, nodeId: "0", attemptId: secondAttemptId },
        timestamp: 4,
      },
    };
    const firstResult = callResult(runId, "0", 3, {
      callHash: "old-hash",
      attemptId: firstAttemptId,
      owner: { extension: "pi-workflows" as const, runId, nodeId: "0", attemptId: firstAttemptId },
      result: { status: "completed", result: "old", attemptId: firstAttemptId, compactionCount: 0, updatedAt: 3 },
    });
    const secondResult = callResult(runId, "0", 5, {
      callHash: "new-hash",
      attemptId: secondAttemptId,
      owner: { extension: "pi-workflows" as const, runId, nodeId: "0", attemptId: secondAttemptId },
      result: { status: "completed", result: "new", attemptId: secondAttemptId, compactionCount: 0, updatedAt: 5 },
    });

    const journal = buildResumeJournal([
      runCreated(runId),
      callAttempt(runId, "0", 2),
      firstResult,
      attempt2,
      secondResult,
      firstResult,
    ]);
    expect(journal.get(`${runId}:0`)).toMatchObject({ hash: "new-hash", result: "new" });
  });

  describe("resume cache reconciliation", () => {
    const runId = "resume-reconciliation";
    const firstAttemptId = `${runId}/0/attempt-1`;
    const secondAttemptId = `${runId}/0/attempt-2`;
    const owner = (attemptId: string) => ({ extension: "pi-workflows", runId, nodeId: "0", attemptId });
    const seededCompletion = () =>
      [
        runCreated(runId, { attempts: { "0": 1 }, attemptIds: { "0": firstAttemptId } }),
        callResult(runId, "0", 2, {
          attemptId: firstAttemptId,
          owner: owner(firstAttemptId),
          result: { status: "completed", result: "OLD", attemptId: firstAttemptId, compactionCount: 0, updatedAt: 2 },
          storeDelta: { old: true },
        }),
      ] as const;
    const nextAttempt = () => ({
      ...callAttempt(runId, "0", 3),
      data: {
        ...callAttempt(runId, "0", 3).data,
        attemptId: secondAttemptId,
        generation: 2,
        owner: owner(secondAttemptId),
      },
    });
    const nextResult = (status: "completed" | "failed" | "stopped", overrides: Record<string, unknown> = {}) =>
      callResult(runId, "0", 4, {
        attemptId: secondAttemptId,
        owner: owner(secondAttemptId),
        result: { status, result: "NEW", attemptId: secondAttemptId, compactionCount: 0, updatedAt: 4 },
        storeDelta: { new: true },
        ...overrides,
      });
    const rotation = () => ({
      nodeId: "0",
      sourceAttemptId: firstAttemptId,
      sourceGeneration: 1,
      sourceStatus: "completed",
      attemptId: secondAttemptId,
      generation: 2,
      owner: owner(secondAttemptId),
    });
    const recovery = (kind: "attempt_recovery" | "run_recovery") => ({
      type: "custom" as const,
      customType: "pi-workflows:journal",
      data: {
        kind,
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        runId,
        branchGeneration: 1,
        timestamp: 3,
        ...(kind === "attempt_recovery"
          ? { nodeId: "0", rotation: rotation() }
          : { status: "interrupted", rotations: [rotation()], recoveryId: `r4-${"d".repeat(64)}` }),
      },
    });

    it.each(["running", "failed", "stopped"] as const)(
      "invalidates an older completed result when the accepted next attempt is %s",
      (status) => {
        const entries = [...seededCompletion(), nextAttempt(), ...(status === "running" ? [] : [nextResult(status)])];
        const diagnostics: string[] = [];
        const run = replayJournal(entries, { onInvalid: (message) => diagnostics.push(message) }).get(runId);
        expect(diagnostics).toEqual([]);
        expect(run?.attempts["0"]).toBe(2);
        expect(run?.callStatus["0"]).toBe(status);
        expect(buildResumeJournal(entries).has(`${runId}:0`)).toBe(false);
      },
    );

    it.each(["attempt_recovery", "run_recovery"] as const)(
      "invalidates a completed candidate after accepted %s without replacement",
      (kind) => {
        const entries = [...seededCompletion(), recovery(kind)];
        const run = replayJournal(entries).get(runId);
        expect(run?.attemptIds["0"]).toBe(secondAttemptId);
        expect(run?.callResults["0"]).toBeUndefined();
        expect(buildResumeJournal(entries).size).toBe(0);
      },
    );

    it.each(["failed", "stopped", "completed"] as const)(
      "invalidates a candidate overwritten by a %s terminal recovery result",
      (status) => {
        const entries = [
          ...seededCompletion(),
          {
            type: "custom" as const,
            customType: "pi-workflows:journal",
            data: {
              kind: "terminal_recovery",
              schemaVersion: JOURNAL_SCHEMA_VERSION,
              runId,
              status: "failed",
              terminalIntent: "failure",
              branchGeneration: 1,
              terminalResults: [
                {
                  nodeId: "0",
                  attemptId: firstAttemptId,
                  owner: owner(firstAttemptId),
                  // Even identical completed content has no replay hash in a
                  // recovery result and must supersede the old cached fact.
                  result: { ...seededCompletion()[1].data.result, status },
                },
              ],
              blockedNodeIds: [],
              recoveryId: `r4-${"e".repeat(64)}`,
              timestamp: 3,
            },
          },
        ];
        expect(replayJournal(entries).get(runId)?.callResults["0"]?.status).toBe(status);
        expect(buildResumeJournal(entries).size).toBe(0);
      },
    );

    it("invalidates a candidate overwritten by a run recovery terminal result", () => {
      const recovered = recovery("run_recovery");
      const entries = [
        ...seededCompletion(),
        {
          ...recovered,
          data: {
            ...recovered.data,
            rotations: [],
            terminalResults: [
              {
                nodeId: "0",
                attemptId: firstAttemptId,
                owner: owner(firstAttemptId),
                result: seededCompletion()[1].data.result,
              },
            ],
          },
        },
      ];
      expect(replayJournal(entries).get(runId)?.callResults["0"]?.result).toBe("OLD");
      expect(buildResumeJournal(entries).size).toBe(0);
    });

    it.each(["missing hash", "missing value"])(
      "invalidates a candidate after a completed replacement with %s",
      (kind) => {
        const replacement = nextResult("completed", {
          ...(kind === "missing hash"
            ? { callHash: undefined }
            : { result: { status: "completed", attemptId: secondAttemptId, compactionCount: 0, updatedAt: 4 } }),
        });
        const entries = [...seededCompletion(), nextAttempt(), replacement];
        expect(replayJournal(entries).get(runId)?.callStatus["0"]).toBe("completed");
        expect(buildResumeJournal(entries).size).toBe(0);
      },
    );

    it("keeps the successful replacement despite delayed stale results and attempts", () => {
      const entries = [
        ...seededCompletion(),
        nextAttempt(),
        nextResult("completed"),
        // Both are rejected as stale, not accepted invalidations.
        seededCompletion()[1],
        callAttempt(runId, "0", 5),
        callResult(runId, "0", 6, {
          attemptId: firstAttemptId,
          owner: owner(firstAttemptId),
          result: { status: "failed", attemptId: firstAttemptId, compactionCount: 0, updatedAt: 6 },
        }),
      ];
      expect(replayJournal(entries).get(runId)?.attempts["0"]).toBe(2);
      expect(buildResumeJournal(entries).get(`${runId}:0`)).toEqual({
        index: 0,
        runId,
        hash: "hash-0",
        result: "NEW",
        tier: "low",
        storeDelta: { new: true },
      });
    });

    it("invalidates a candidate when accepted call status is no longer completed", () => {
      const entries = [
        ...seededCompletion(),
        {
          type: "custom" as const,
          customType: "pi-workflows:journal",
          data: {
            kind: "call_transition",
            schemaVersion: JOURNAL_SCHEMA_VERSION,
            runId,
            nodeId: "0",
            attemptId: firstAttemptId,
            owner: owner(firstAttemptId),
            status: "stopped",
            timestamp: 3,
          },
        },
      ];
      expect(replayJournal(entries).get(runId)?.callStatus["0"]).toBe("stopped");
      expect(buildResumeJournal(entries).size).toBe(0);
    });

    it("does not resurrect a removed run's candidate through recreation", () => {
      const entries = [
        ...seededCompletion(),
        {
          type: "custom" as const,
          customType: "pi-workflows:journal",
          data: { kind: "run_removed", schemaVersion: JOURNAL_SCHEMA_VERSION, runId, timestamp: 3 },
        },
        ...seededCompletion(),
      ];
      expect(replayJournal(entries).has(runId)).toBe(false);
      expect(buildResumeJournal(entries).size).toBe(0);
    });

    it("discards quarantined candidates without affecting another run's valid cache", () => {
      const entries = [
        ...seededCompletion(),
        runCreated("quarantined"),
        callResult("quarantined", "0", 2, {
          result: { status: "completed", result: "first", compactionCount: 0, updatedAt: 2 },
        }),
        callResult("quarantined", "0", 3, {
          result: { status: "completed", result: "contradiction", compactionCount: 0, updatedAt: 3 },
        }),
      ];
      expect(replayJournal(entries).has("quarantined")).toBe(false);
      const journal = buildResumeJournal(entries);
      expect(journal.size).toBe(1);
      expect(journal.get(`${runId}:0`)?.result).toBe("OLD");
    });

    it("invalidates only the superseded nested boundary, preserving child namespace results", () => {
      const entries = [
        runCreated("parent"),
        workflowResult("parent", "0", 2, { agentCount: 2, storeDelta: { parent: true } }),
        runCreated("child"),
        workflowResult("child", "0", 2, { agentCount: 1, storeDelta: { child: true } }),
        callAttempt("parent", "0", 3),
      ];
      expect(replayJournal(entries).get("parent")?.callResults["0"]).toBeUndefined();
      const journal = buildResumeJournal(entries);
      expect(journal.has("parent:0")).toBe(false);
      expect(journal.get("child:0")).toMatchObject({
        generation: 1,
        agentCount: 1,
        storeDelta: { child: true },
      });
    });

    it("invalidates a nested candidate after an accepted newer generation without a value", () => {
      const entries = [
        runCreated("parent"),
        workflowResult("parent", "0", 2),
        workflowResult("parent", "0", 3, {
          generation: 2,
          result: { status: "completed", compactionCount: 0, updatedAt: 3 },
        }),
      ];
      expect(replayJournal(entries).get("parent")?.workflowResultGenerations["0"]).toBe(2);
      expect(buildResumeJournal(entries).size).toBe(0);
    });

    it("preserves a nested candidate after an identical accepted retry and delayed identity transition", () => {
      const result = workflowResult("parent", "0", 2);
      const entries = [
        runCreated("parent"),
        result,
        result,
        {
          type: "custom" as const,
          customType: "pi-workflows:journal",
          data: {
            kind: "call_transition",
            schemaVersion: JOURNAL_SCHEMA_VERSION,
            runId: "parent",
            nodeId: "0",
            status: "running",
            timestamp: 3,
          },
        },
      ];
      expect(replayJournal(entries).get("parent")?.callStatus["0"]).toBe("completed");
      expect(buildResumeJournal(entries).get("parent:0")?.result).toEqual({ nested: true });
    });
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
