import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false, cleanupSucceeded: true })),
  cleanupWorktreeAsync: vi.fn(async () => ({ hasChanges: false, cleanupSucceeded: true })),
  pruneWorktreesAsync: vi.fn(async () => {}),
  pruneWorktrees: vi.fn(),
}));

import { resumeAgent, runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

const mockSession = (sessionFile?: string) => ({ dispose: vi.fn(), sessionFile } as any);

const resolvedRun = () =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "done",
    session: mockSession(),
    aborted: false,
    steered: false,
  });

describe("AgentManager — Bug 1 race condition (resultConsumed vs onComplete)", () => {
  let manager: AgentManager;

  afterEach(async () => {
    await manager?.dispose();
  });

  it("reproduces bug: onComplete fires with resultConsumed=false when set after await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecordMutable(id)!;

    // Simulate the buggy get_subagent_result: await THEN mark consumed
    await record.promise;
    record.resultConsumed = true; // too late — onComplete already fired

    // onComplete saw resultConsumed as falsy (undefined) — would queue a notification (the bug)
    expect(seenConsumed).toBeFalsy();
  });

  it("fix: onComplete sees resultConsumed=true when pre-marked before await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecordMutable(id)!;

    // The fix: pre-mark BEFORE awaiting
    record.resultConsumed = true;
    await record.promise;

    expect(seenConsumed).toBe(true);
  });

  it("normal case: onComplete fires with resultConsumed falsy when no explicit polling", async () => {
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => {
      completedRecord = r;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecordMutable(id)!.promise;

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.resultConsumed).toBeFalsy();
  });

  it("onComplete IS called for foreground agents (lifecycle symmetry)", async () => {
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => {
      completedRecord = r;
    });
    resolvedRun();

    const { record } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.status).toBe("completed");
    // resultConsumed is set by spawnAndWait so onComplete skips notifications
    expect(completedRecord!.resultConsumed).toBe(true);
    expect(record).toBe(completedRecord);
  });


  it("stops a pre-aborted foreground spawn without running it", async () => {
    const controller = new AbortController();
    controller.abort(new Error("foreground already cancelled"));
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((record) => {
      completedRecord = record;
    });
    vi.mocked(runAgent).mockClear();

    const { record } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "cancelled", {
      description: "cancelled",
      signal: controller.signal,
    });

    expect(runAgent).not.toHaveBeenCalled();
    expect(record.status).toBe("stopped");
    expect(record.resultConsumed).toBe(true);
    expect(record.completedAt).toBeGreaterThan(0);
    expect(completedRecord).toBe(record);
  });
});

describe("AgentManager — spawnAndWait onSpawned + foreground output file wiring (#105)", () => {
  let manager: AgentManager;
  afterEach(async () => { await manager?.dispose(); });

  it("fields set on the record in onSpawned are visible when onSessionCreated fires", async () => {
    // The load-bearing ordering guarantee: onSpawned fires synchronously inside
    // spawn(), before runAgent's async onSessionCreated fires. index.ts relies on
    // this to set record.outputFile so streamToOutputFile can pick it up.
    manager = new AgentManager();
    let capturedId: string | undefined;
    let outputFileSeenAtSessionCreated: string | undefined;

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      const session = mockSession();
      // Yield one microtask to mirror real behavior: in production, onSessionCreated
      // fires async (after network/session setup). onSpawned fires synchronously
      // inside spawn() before runAgent's promise even starts. This await lets the
      // remainder of startAgent (record.promise = …, onSpawned?.()) finish first.
      await Promise.resolve();
      opts.onSessionCreated?.(session);
      outputFileSeenAtSessionCreated = capturedId
        ? manager.getRecordMutable(capturedId)?.outputFile
        : undefined;
      return { responseText: "done", session, aborted: false, steered: false };
    });

    await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    }, (fgId) => {
      capturedId = fgId;
      manager.getRecordMutable(fgId)!.outputFile = "/fake/agent.jsonl";
    });

    expect(outputFileSeenAtSessionCreated).toBe("/fake/agent.jsonl");
  });

  it("onSpawned id matches the id returned by spawnAndWait", async () => {
    manager = new AgentManager();
    let spawnedId: string | undefined;
    resolvedRun();

    const { id } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    }, (fgId) => { spawnedId = fgId; });

    expect(spawnedId).toBe(id);
  });

  it("restores the shared onSpawned callback before awaiting the foreground run", async () => {
    manager = new AgentManager();
    let finishFirst: ((value: any) => void) | undefined;
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
      .mockResolvedValueOnce({
        responseText: "second",
        session: mockSession(),
        aborted: false,
        steered: false,
      });
    const firstCallback = vi.fn();

    const first = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "first", {
      description: "first",
    }, firstCallback);
    const secondId = manager.spawn(mockPi, mockCtx, "general-purpose", "second", {
      description: "second",
      isBackground: true,
    });

    expect(firstCallback).toHaveBeenCalledTimes(1);
    await manager.getRecordMutable(secondId)!.promise;
    finishFirst?.({
      responseText: "first",
      session: mockSession(),
      aborted: false,
      steered: false,
    });
    await first;
  });

  it("onComplete fires on the error path with resultConsumed=true", async () => {
    // The .then path is covered by the lifecycle-symmetry test above; this guards
    // the .catch path which lacks try/catch around onComplete (a known asymmetry).
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => { completedRecord = r; });
    vi.mocked(runAgent).mockRejectedValue(new Error("agent failed"));

    const { record } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.status).toBe("error");
    expect(completedRecord!.resultConsumed).toBe(true);
    expect(record).toBe(completedRecord);
  });
});

describe("AgentManager — pool and parent-signal settlement", () => {
  let manager: AgentManager;

  afterEach(async () => { await manager?.dispose(); });

  it("drains queued work when a detached agent settles late", async () => {
    let finishFirst!: (value: unknown) => void;
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValue({ responseText: "next", session: mockSession(), aborted: false, steered: false });
    manager = new AgentManager(undefined, 1);

    const first = manager.spawn(mockPi, mockCtx, "X", "first", {
      description: "first",
      isBackground: true,
    });
    const second = manager.spawn(mockPi, mockCtx, "Y", "second", {
      description: "second",
      isBackground: true,
    });
    expect(manager.getRecordMutable(second)?.status).toBe("queued");

    manager.getRecordMutable(first)!.detached = true;
    finishFirst({ responseText: "late", session: mockSession(), aborted: false, steered: false });
    await manager.getRecordMutable(first)!.promise;

    expect(manager.getRecordMutable(second)?.status).toBe("completed");
    await manager.getRecordMutable(second)!.promise;
  });

  it("stops a pre-aborted foreground or queued spawn before runAgent", () => {
    const controller = new AbortController();
    controller.abort(new Error("parent already cancelled"));
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager(undefined, 1);

    const id = manager.spawn(mockPi, mockCtx, "X", "cancelled", {
      description: "cancelled",
      isBackground: true,
      signal: controller.signal,
    });

    expect(manager.getRecordMutable(id)?.status).toBe("stopped");
    expect(runAgent).not.toHaveBeenCalled();
  });


  it("releases a slot when a never-settling record is detached by timeout", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as never);
    manager = new AgentManager(undefined, 1);
    const detachedId = manager.spawn(mockPi, mockCtx, "X", "stuck", {
      description: "stuck",
      isBackground: true,
    });

    await expect(manager.quiesceAll(5)).resolves.toEqual({ settled: false, pending: [detachedId] });
    expect(manager.getRecordMutable(detachedId)?.detached).toBe(true);

    const freshId = manager.spawn(mockPi, mockCtx, "Y", "fresh", {
      description: "fresh",
      isBackground: true,
    });
    expect(manager.getRecordMutable(freshId)?.status).toBe("running");
  });

  it("releases slots and drains detached queued records during branch change", () => {
    let finishRunning!: (value: unknown) => void;
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise((resolve) => { finishRunning = resolve; }))
      .mockResolvedValue({ responseText: "fresh", session: mockSession(), aborted: false, steered: false });
    manager = new AgentManager(undefined, 1);

    const runningId = manager.spawn(mockPi, mockCtx, "X", "running", {
      description: "running",
      isBackground: true,
    });
    const queuedId = manager.spawn(mockPi, mockCtx, "Y", "queued", {
      description: "queued",
      isBackground: true,
    });
    expect(manager.getRecordMutable(queuedId)?.status).toBe("queued");

    manager.detachForBranchChange();

    expect(manager.getRecordMutable(runningId)?.detached).toBe(true);
    expect(manager.getRecordMutable(queuedId)?.status).toBe("stopped");
    const freshId = manager.spawn(mockPi, mockCtx, "Z", "fresh", {
      description: "fresh",
      isBackground: true,
    });
    expect(manager.getRecordMutable(freshId)?.status).toBe("running");

    finishRunning({ responseText: "late", session: mockSession(), aborted: false, steered: false });
  });


  it("continues draining after a detached queued record", async () => {
    let finishRunning!: (value: unknown) => void;
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise((resolve) => { finishRunning = resolve; }))
      .mockResolvedValue({ responseText: "later", session: mockSession(), aborted: false, steered: false });
    manager = new AgentManager(undefined, 1);

    const runningId = manager.spawn(mockPi, mockCtx, "X", "running", {
      description: "running",
      isBackground: true,
    });
    const detachedQueuedId = manager.spawn(mockPi, mockCtx, "Y", "detached", {
      description: "detached",
      isBackground: true,
    });
    const laterId = manager.spawn(mockPi, mockCtx, "Z", "later", {
      description: "later",
      isBackground: true,
    });
    // Use the manager's existing mutable test seam to model a queued record
    // detached by branch replacement while a later queued record remains live.
    manager.getRecordMutable(detachedQueuedId)!.detached = true;

    finishRunning({ responseText: "late", session: mockSession(), aborted: false, steered: false });
    await manager.getRecordMutable(runningId)!.promise;
    await manager.getRecordMutable(laterId)!.promise;

    expect(manager.getRecordMutable(detachedQueuedId)?.status).toBe("stopped");
    expect(manager.getRecordMutable(laterId)?.status).toBe("completed");
  });
});

describe("AgentManager — nested runtime propagation", () => {
  let manager: AgentManager;

  afterEach(async () => { await manager?.dispose(); });


  it("rejects an unknown nested owner before allocating a record", () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockClear();

    expect(() => manager.spawn(mockPi, mockCtx, "scout", "nested", {
      description: "nested",
      isBackground: true,
      parentAgentId: "missing-parent",
    })).toThrow(/parent agent "missing-parent" is missing/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });


  it("pins an early-stopped parent when onStart created a pending nested provider", async () => {
    const { cleanupWorktree, createWorktree } = await import("../src/worktree.js");
    const baseRepo = mkdtempSync(join(tmpdir(), "pi-subagents-onstart-nested-wt-"));
    const parentPath = join(baseRepo, "parent");
    const parentAlias = join(baseRepo, "parent-alias");
    const childPath = join(parentPath, "child");
    mkdirSync(childPath, { recursive: true });
    symlinkSync(parentPath, parentAlias, "dir");
    const cleanupOrder: string[] = [];
    vi.mocked(createWorktree)
      .mockReturnValueOnce({ path: parentAlias, branch: "parent", baseSha: "parent-sha", repoRoot: baseRepo, workPath: parentAlias })
      .mockReturnValueOnce({ path: childPath, branch: "child", baseSha: "child-sha", repoRoot: realpathSync(parentAlias), workPath: childPath });
    vi.mocked(cleanupWorktree).mockImplementation((_repoRoot, worktree) => {
      cleanupOrder.push(worktree.path);
      return { hasChanges: false, cleanupSucceeded: true };
    });
    let finishChild!: (value: unknown) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise((resolve) => { finishChild = resolve; }));
    let childId: string | undefined;
    manager = new AgentManager(undefined, 4, (record) => {
      if (record.type !== "general-purpose") return;
      childId = manager.spawn(mockPi, { cwd: record.worktree?.path } as any, "scout", "child", {
        description: "child",
        isBackground: true,
        parentAgentId: record.id,
        isolation: "worktree",
      });
      manager.abort(record.id);
    });

    try {
      const parentId = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", {
        description: "parent",
        isBackground: true,
        isolation: "worktree",
      });
      if (!childId) throw new Error("onStart did not create the child");
      expect(cleanupOrder).toEqual([]);
      expect(manager.getRecordMutable(parentId)?.worktree?.path).toBe(parentAlias);

      const childPromise = manager.getRecordMutable(childId)?.promise;
      finishChild({ responseText: "child", session: mockSession(), aborted: true, steered: false });
      await childPromise;
      await Promise.resolve();

      expect(cleanupOrder).toEqual([childPath, parentAlias]);
      expect(manager.getRecordMutable(parentId)?.worktree).toBeUndefined();
    } finally {
      rmSync(baseRepo, { recursive: true, force: true });
    }
  });

  it("stores nesting metadata and passes the owning manager/runtime to runAgent", async () => {
    resolvedRun();
    manager = new AgentManager();
    const parentId = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", {
      description: "parent",
      isBackground: true,
    });
    const id = manager.spawn(mockPi, mockCtx, "scout", "nested", {
      description: "nested",
      isBackground: true,
      depth: 2,
      parentAgentId: parentId,
      maxSubagentDepth: 3,
      configCwd: "/trusted/config",
    });
    await manager.getRecordMutable(id)!.promise;

    expect(manager.getRecordMutable(id)).toEqual(expect.objectContaining({
      depth: 2,
      parentAgentId: parentId,
      maxSubagentDepth: 3,
    }));
    expect(runAgent).toHaveBeenLastCalledWith(
      mockCtx,
      "scout",
      "nested",
      expect.objectContaining({
        configCwd: "/trusted/config",
        nestedRuntime: {
          manager,
          parentAgentId: id,
          depth: 2,
          maxSubagentDepth: 3,
        },
      }),
    );
  });

  it("defaults top-level subagents to depth one", async () => {
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "scout", "top", {
      description: "top",
      isBackground: true,
    });
    await manager.getRecordMutable(id)!.promise;

    expect(manager.getRecordMutable(id)?.depth).toBe(1);
    expect(vi.mocked(runAgent).mock.lastCall?.[3].nestedRuntime).toEqual(expect.objectContaining({
      parentAgentId: id,
      depth: 1,
    }));
  });

  it("starts a nested background child even when the concurrency pool is full", async () => {
    // A parent holding the only slot and waiting on its own child would
    // otherwise deadlock: the child can never be drained from the queue.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager(undefined, 1);

    const parentId = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", {
      description: "parent",
      isBackground: true,
    });
    const childId = manager.spawn(mockPi, mockCtx, "scout", "child", {
      description: "child",
      isBackground: true,
      depth: 2,
      parentAgentId: parentId,
    });
    // A second top-level background agent still queues — the pool is untouched.
    const siblingId = manager.spawn(mockPi, mockCtx, "general-purpose", "sibling", {
      description: "sibling",
      isBackground: true,
    });

    expect(manager.getRecordMutable(childId)?.status).toBe("running");
    expect(manager.getRecordMutable(siblingId)?.status).toBe("queued");
  });

  it("aborts owned children when the parent settles", async () => {
    let finishParent: ((value: any) => void) | undefined;
    // Children settle on abort, as a real run does when its signal fires.
    const abortable = (_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise<any>(resolve => {
        opts.signal?.addEventListener("abort", () =>
          resolve({ responseText: "", session: mockSession(), aborted: true, steered: false }),
        );
      });
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise(resolve => { finishParent = resolve; }))
      .mockImplementation(abortable as any);
    manager = new AgentManager();

    const parentId = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", {
      description: "parent",
      isBackground: true,
    });
    const runningChild = manager.spawn(mockPi, mockCtx, "scout", "child", {
      description: "child",
      isBackground: true,
      depth: 2,
      parentAgentId: parentId,
    });
    const grandchild = manager.spawn(mockPi, mockCtx, "scout", "grandchild", {
      description: "grandchild",
      isBackground: true,
      depth: 3,
      parentAgentId: runningChild,
    });

    finishParent?.({ responseText: "done", session: mockSession(), aborted: false, steered: false });
    await manager.getRecordMutable(parentId)!.promise;

    expect(manager.getRecordMutable(runningChild)?.status).toBe("stopped");
    // The child's own settle path stops the generation below it.
    await manager.getRecordMutable(runningChild)!.promise;
    expect(manager.getRecordMutable(grandchild)?.status).toBe("stopped");
  });

  it("cleans nested worktrees deepest-first while the parent worktree still exists", async () => {
    const { cleanupWorktree, createWorktree } = await import("../src/worktree.js");
    const baseRepo = mkdtempSync(join(tmpdir(), "pi-subagents-nested-wt-"));
    const parentPath = join(baseRepo, "parent");
    const childPath = join(parentPath, "child");
    mkdirSync(childPath, { recursive: true });
    const cleanupOrder: string[] = [];

    vi.mocked(createWorktree)
      .mockReturnValueOnce({ path: parentPath, branch: "parent", baseSha: "parent-sha", repoRoot: baseRepo, workPath: parentPath })
      .mockReturnValueOnce({ path: childPath, branch: "child", baseSha: "child-sha", repoRoot: parentPath, workPath: childPath });
    vi.mocked(cleanupWorktree).mockImplementation((_repoRoot, worktree) => {
      if (worktree.path === childPath) {
        expect(existsSync(parentPath)).toBe(true);
        cleanupOrder.push("child");
        rmSync(childPath, { recursive: true, force: true });
      } else {
        expect(worktree.path).toBe(parentPath);
        expect(existsSync(parentPath)).toBe(true);
        cleanupOrder.push("parent");
        rmSync(parentPath, { recursive: true, force: true });
      }
      return { hasChanges: false, cleanupSucceeded: true };
    });

    let finishParent!: (value: unknown) => void;
    const abortable = (_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise<any>((resolve) => {
        opts.signal?.addEventListener("abort", () =>
          resolve({ responseText: "", session: mockSession(), aborted: true, steered: false }),
          { once: true },
        );
      });
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise((resolve) => { finishParent = resolve; }))
      .mockImplementation(abortable as any);
    manager = new AgentManager();

    const parentId = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", {
      description: "parent",
      isBackground: true,
      isolation: "worktree",
    });
    const childId = manager.spawn(mockPi, { cwd: parentPath } as any, "scout", "child", {
      description: "child",
      isBackground: true,
      depth: 2,
      parentAgentId: parentId,
      isolation: "worktree",
    });

    finishParent({ responseText: "done", session: mockSession(), aborted: false, steered: false });
    await manager.getRecordMutable(parentId)!.promise;
    await manager.getRecordMutable(childId)!.promise;

    expect(cleanupOrder).toEqual(["child", "parent"]);
    expect(manager.getRecordMutable(parentId)?.worktree).toBeUndefined();
    expect(manager.getRecordMutable(childId)?.worktree).toBeUndefined();
    expect(existsSync(parentPath)).toBe(false);
    rmSync(baseRepo, { recursive: true, force: true });
  });

  it("does not reopen a sealed owner when a top-level record resumes", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: mockSession(),
      aborted: false,
      steered: false,
    });
    manager = new AgentManager();
    const parentId = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", {
      description: "parent",
      isBackground: true,
    });
    await manager.getRecordMutable(parentId)!.promise;

    let spawnError: unknown;
    vi.mocked(resumeAgent).mockImplementation(async () => {
      try {
        manager.spawn(mockPi, mockCtx, "scout", "child", {
          description: "child",
          isBackground: true,
          depth: 2,
          parentAgentId: parentId,
        });
      } catch (error: unknown) {
        spawnError = error;
      }
      return { text: "resumed" };
    });

    await manager.resume(parentId, "keep going");

    expect(spawnError).toBeInstanceOf(Error);
    expect(String(spawnError)).toContain("sealed");
    expect(manager.listAgents().some((record) => record.parentAgentId === parentId)).toBe(false);
  });


  it("seals before completion observers can allocate a late child", async () => {
    let parentId = "";
    let spawnError: unknown;
    manager = new AgentManager((record) => {
      if (record.id !== parentId) return;
      try {
        manager.spawn(mockPi, mockCtx, "scout", "late child", {
          description: "late child",
          isBackground: true,
          parentAgentId: parentId,
        });
      } catch (error: unknown) {
        spawnError = error;
      }
    });
    resolvedRun();

    parentId = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", {
      description: "parent",
      isBackground: true,
    });
    await manager.getRecordMutable(parentId)!.promise;

    expect(String(spawnError)).toContain("sealed");
    expect(manager.listAgents().some((record) => record.parentAgentId === parentId)).toBe(false);
  });

  it("rejects a nested spawn when a transitive owner is sealed", async () => {
    let finishRoot!: (value: unknown) => void;
    let finishChild!: (value: unknown) => void;
    let finishGrandchild!: (value: unknown) => void;
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise((resolve) => { finishRoot = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishChild = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishGrandchild = resolve; }));
    manager = new AgentManager();

    const rootId = manager.spawn(mockPi, mockCtx, "general-purpose", "root", {
      description: "root",
      isBackground: true,
    });
    const childId = manager.spawn(mockPi, mockCtx, "scout", "child", {
      description: "child",
      isBackground: true,
      parentAgentId: rootId,
    });
    const grandchildId = manager.spawn(mockPi, mockCtx, "scout", "grandchild", {
      description: "grandchild",
      isBackground: true,
      parentAgentId: childId,
    });
    const abort = vi.spyOn(manager, "abort").mockImplementation(() => false);

    finishRoot({ responseText: "root", session: mockSession(), aborted: false, steered: false });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(() => manager.spawn(mockPi, mockCtx, "scout", "late", {
      description: "late",
      isBackground: true,
      parentAgentId: grandchildId,
    })).toThrow(/sealed/);

    abort.mockRestore();
    finishChild({ responseText: "child", session: mockSession(), aborted: false, steered: false });
    finishGrandchild({ responseText: "grandchild", session: mockSession(), aborted: false, steered: false });
    await Promise.all([
      manager.getRecordMutable(rootId)!.promise,
      manager.getRecordMutable(childId)!.promise,
      manager.getRecordMutable(grandchildId)!.promise,
    ]);
  });

  it("keeps nested resume available while every owner is active", async () => {
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ responseText: "child", session: mockSession(), aborted: false, steered: false });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed" });
    manager = new AgentManager();

    const rootId = manager.spawn(mockPi, mockCtx, "general-purpose", "root", {
      description: "root",
      isBackground: true,
    });
    const childId = manager.spawn(mockPi, mockCtx, "scout", "child", {
      description: "child",
      isBackground: true,
      parentAgentId: rootId,
    });
    await manager.getRecordMutable(childId)!.promise;

    const resumed = await manager.resume(childId, "continue");

    expect(resumed?.status).toBe("completed");
    expect(resumed?.result).toBe("resumed");
  });

  it("rejects nested resume after the owner is sealed or removed", async () => {
    let finishRoot!: (value: unknown) => void;
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise((resolve) => { finishRoot = resolve; }))
      .mockResolvedValueOnce({ responseText: "child", session: mockSession(), aborted: false, steered: false });
    vi.mocked(resumeAgent).mockClear();
    manager = new AgentManager();

    const rootId = manager.spawn(mockPi, mockCtx, "general-purpose", "root", {
      description: "root",
      isBackground: true,
    });
    const childId = manager.spawn(mockPi, mockCtx, "scout", "child", {
      description: "child",
      isBackground: true,
      parentAgentId: rootId,
    });
    await manager.getRecordMutable(childId)!.promise;
    finishRoot({ responseText: "root", session: mockSession(), aborted: false, steered: false });
    await manager.getRecordMutable(rootId)!.promise;

    expect(await manager.resume(childId, "sealed parent")).toBeUndefined();
    expect(resumeAgent).not.toHaveBeenCalled();

    manager.getRecordMutable(rootId)!.resultConsumed = true;
    manager.clearCompleted(true);
    expect(await manager.resume(childId, "missing parent")).toBeUndefined();
  });

  it("run_in_background resume settles asynchronously and notifies on completion", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: mockSession(),
      aborted: false,
      steered: false,
    });
    let releaseResume!: (value: { text: string }) => void;
    vi.mocked(resumeAgent).mockImplementation(
      () => new Promise((resolve) => { releaseResume = resolve; }),
    );
    let completed: AgentRecord | undefined;
    manager = new AgentManager((record) => {
      completed = record;
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "first", {
      description: "first",
      isBackground: true,
    });
    await manager.getRecordMutable(id)!.promise;
    completed = undefined; // the initial spawn already notified; watch the resume only

    // Background resume returns immediately with the record still active.
    const resumed = await manager.resume(id, "keep going", undefined, { isBackground: true });
    expect(resumed).toBeDefined();
    expect(resumed!.status).toBe("running");
    expect(manager.getRecordMutable(id)!.status).toBe("running");

    // It must not block: the call returned before the run settled.
    expect(completed).toBeUndefined();

    // Let the background run settle; completion notifies the observer.
    releaseResume({ text: "background resumed" });
    await vi.waitFor(() => {
      expect(completed?.status).toBe("completed");
    });
    expect(completed?.result).toBe("background resumed");
    expect(manager.getRecordMutable(id)!.status).toBe("completed");
  });

  it("background resume refuses a second concurrent resume of the same agent", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: mockSession(),
      aborted: false,
      steered: false,
    });
    let releaseResume!: (value: { text: string }) => void;
    vi.mocked(resumeAgent).mockClear();
    vi.mocked(resumeAgent).mockImplementation(
      () => new Promise((resolve) => { releaseResume = resolve; }),
    );
    manager = new AgentManager();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "first", {
      description: "first",
      isBackground: true,
    });
    await manager.getRecordMutable(id)!.promise;

    const first = await manager.resume(id, "one", undefined, { isBackground: true });
    expect(first?.status).toBe("running");
    // Second background resume while the first is in flight is refused.
    const second = await manager.resume(id, "two", undefined, { isBackground: true });
    expect(second).toBeUndefined();
    expect(resumeAgent).toHaveBeenCalledTimes(1);
    releaseResume({ text: "settled" });
    await vi.waitFor(() => {
      expect(manager.getRecordMutable(id)!.status).toBe("completed");
    });
  });

  it("foreground resume refuses to overlap a background resume", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: mockSession(),
      aborted: false,
      steered: false,
    });
    let releaseResume!: (value: { text: string }) => void;
    vi.mocked(resumeAgent).mockClear();
    vi.mocked(resumeAgent).mockImplementation(
      () => new Promise((resolve) => { releaseResume = resolve; }),
    );
    manager = new AgentManager();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "first", {
      description: "first",
      isBackground: true,
    });
    await manager.getRecordMutable(id)!.promise;

    await expect(manager.resume(id, "background", undefined, { isBackground: true })).resolves.toBeDefined();
    await expect(manager.resume(id, "foreground")).resolves.toBeUndefined();
    expect(resumeAgent).toHaveBeenCalledTimes(1);

    releaseResume({ text: "settled" });
    await vi.waitFor(() => expect(manager.getRecordMutable(id)!.status).toBe("completed"));
  });

  it("disposal settles a queued background resume", async () => {
    vi.mocked(runAgent).mockReset();
    vi.mocked(runAgent)
      .mockResolvedValueOnce({
        responseText: "first",
        session: mockSession(),
        aborted: false,
        steered: false,
      })
      .mockImplementationOnce(() => new Promise(() => {}) as never);
    vi.mocked(resumeAgent).mockClear();
    manager = new AgentManager(undefined, 1);

    const completedId = manager.spawn(mockPi, mockCtx, "general-purpose", "completed", {
      description: "completed",
      isBackground: true,
    });
    await manager.getRecordMutable(completedId)!.promise;
    manager.spawn(mockPi, mockCtx, "general-purpose", "running", {
      description: "running",
      isBackground: true,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const resumed = await manager.resume(completedId, "queued", undefined, { isBackground: true });
    expect(resumed?.status).toBe("queued");
    const resumePromise = manager.getRecordMutable(completedId)!.promise!;

    await manager.dispose();
    await expect(resumePromise).resolves.toBe("");
  });

  it("captures immutable nested ancestor lineage in public snapshots", () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager();

    const rootId = manager.spawn(mockPi, mockCtx, "general-purpose", "root", {
      description: "root",
      isBackground: true,
    });
    const childId = manager.spawn(mockPi, mockCtx, "scout", "child", {
      description: "child",
      isBackground: true,
      parentAgentId: rootId,
    });
    const grandchildId = manager.spawn(mockPi, mockCtx, "scout", "grandchild", {
      description: "grandchild",
      isBackground: true,
      parentAgentId: childId,
    });

    expect(manager.getRecordMutable(childId)?.ancestorAgentIds).toEqual([rootId]);
    expect(manager.getRecordMutable(grandchildId)?.ancestorAgentIds).toEqual([rootId, childId]);
    const snapshot = manager.getRecordMutable(grandchildId)!;
    expect(snapshot.ancestorAgentIds).toEqual([rootId, childId]);
    expect(Object.isFrozen(snapshot.ancestorAgentIds)).toBe(true);
    try { (snapshot.ancestorAgentIds as string[]).push("forged"); } catch { /* frozen snapshots may throw */ }
    expect(manager.getRecordMutable(grandchildId)?.ancestorAgentIds).toEqual([rootId, childId]);
  });

  it("defers owner eviction until R → C → G is fully cleaned and orders worktrees deepest-first", async () => {
    const { cleanupWorktree, createWorktree } = await import("../src/worktree.js");
    const baseRepo = mkdtempSync(join(tmpdir(), "pi-subagents-lineage-wt-"));
    const rootPath = join(baseRepo, "root");
    const childPath = join(rootPath, "child");
    const grandchildPath = join(childPath, "grandchild");
    mkdirSync(grandchildPath, { recursive: true });
    const cleanupOrder: string[] = [];
    vi.mocked(createWorktree)
      .mockReturnValueOnce({ path: rootPath, branch: "root", baseSha: "root-sha", repoRoot: baseRepo, workPath: rootPath })
      .mockReturnValueOnce({ path: childPath, branch: "child", baseSha: "child-sha", repoRoot: rootPath, workPath: childPath })
      .mockReturnValueOnce({ path: grandchildPath, branch: "grandchild", baseSha: "grandchild-sha", repoRoot: childPath, workPath: grandchildPath });
    vi.mocked(cleanupWorktree).mockImplementation((_repoRoot, worktree) => {
      cleanupOrder.push(worktree.path);
      rmSync(worktree.path, { recursive: true, force: true });
      return { hasChanges: false, cleanupSucceeded: true };
    });

    let finishRoot!: (value: unknown) => void;
    let finishChild!: (value: unknown) => void;
    let finishGrandchild!: (value: unknown) => void;
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise((resolve) => { finishRoot = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishChild = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishGrandchild = resolve; }));
    manager = new AgentManager();

    try {
      const rootId = manager.spawn(mockPi, mockCtx, "general-purpose", "root", {
        description: "root",
        isBackground: true,
        isolation: "worktree",
      });
      const childId = manager.spawn(mockPi, { cwd: rootPath } as any, "scout", "child", {
        description: "child",
        isBackground: true,
        parentAgentId: rootId,
        isolation: "worktree",
      });
      const grandchildId = manager.spawn(mockPi, { cwd: childPath } as any, "scout", "grandchild", {
        description: "grandchild",
        isBackground: true,
        parentAgentId: childId,
        isolation: "worktree",
      });
      const rootRecord = manager.getRecordMutable(rootId)!;
      const childRecord = manager.getRecordMutable(childId)!;
      const grandchildRecord = manager.getRecordMutable(grandchildId)!;

      // Legacy stop marks C/G synchronously, while both providers ignore abort.
      expect(manager.abort(childId)).toBe(true);
      expect(childRecord.status).toBe("stopped");
      expect(grandchildRecord.status).toBe("stopped");

      childRecord.completedAt = Date.now() - 11 * 60_000;
      grandchildRecord.completedAt = Date.now() - 11 * 60_000;
      manager.clearCompleted();
      expect(manager.getRecordMutable(childId)).toBeDefined();
      expect(manager.getRecordMutable(grandchildId)).toBeDefined();
      // The periodic path makes the same safe decision: defer instead of
      // deleting an owner whose descendant still has a live provider/worktree.
      (manager as any).cleanup();
      expect(manager.getRecordMutable(childId)).toBeDefined();
      expect(manager.getRecordMutable(grandchildId)).toBeDefined();

      finishGrandchild({ responseText: "grandchild", session: mockSession(), aborted: false, steered: false });
      await grandchildRecord.promise;
      expect(cleanupOrder).toEqual([grandchildPath]);
      expect(manager.getRecordMutable(childId)).toBeDefined();

      finishChild({ responseText: "child", session: mockSession(), aborted: false, steered: false });
      await childRecord.promise;
      expect(cleanupOrder).toEqual([grandchildPath, childPath]);
      expect(manager.getRecordMutable(childId)).toBeUndefined();

      // C is gone before R settles; R's cleanup still sees G's immutable
      // lineage (until G itself is evicted) and never removes root too early.
      finishRoot({ responseText: "root", session: mockSession(), aborted: false, steered: false });
      await rootRecord.promise;
      expect(cleanupOrder).toEqual([grandchildPath, childPath, rootPath]);
      expect(rootRecord.worktree).toBeUndefined();

      manager.clearCompleted();
      expect(manager.listAgents()).toEqual([]);
      expect((manager as any).nestedSpawnSeals.size).toBe(0);
    } finally {
      rmSync(baseRepo, { recursive: true, force: true });
    }
  });

  it("finds a grandchild through immutable lineage after an intermediate record disappears", async () => {
    let finishRoot!: (value: unknown) => void;
    let finishChild!: (value: unknown) => void;
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise((resolve) => { finishRoot = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishChild = resolve; }))
      .mockImplementation((_ctx, _type, _prompt, options) => new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => {
          resolve({ responseText: "", session: mockSession(), aborted: true, steered: false });
        }, { once: true });
      }));
    manager = new AgentManager();

    const rootId = manager.spawn(mockPi, mockCtx, "general-purpose", "root", {
      description: "root",
      isBackground: true,
    });
    const childId = manager.spawn(mockPi, mockCtx, "scout", "child", {
      description: "child",
      isBackground: true,
      parentAgentId: rootId,
    });
    const grandchildId = manager.spawn(mockPi, mockCtx, "scout", "grandchild", {
      description: "grandchild",
      isBackground: true,
      parentAgentId: childId,
    });
    const grandchildRecord = manager.getRecordMutable(grandchildId)!;
    const records = (manager as any).agents as Map<string, AgentRecord>;
    (manager as any).nestedSpawnSeals.add(childId);
    records.delete(childId); // model the legacy cleanup hole adversarially

    await (manager as any).abortOwnedChildren(rootId);
    expect(grandchildRecord.status).toBe("stopped");

    finishRoot({ responseText: "root", session: mockSession(), aborted: false, steered: false });
    finishChild({ responseText: "child", session: mockSession(), aborted: false, steered: false });
    await Promise.all([manager.getRecordMutable(rootId)!.promise, grandchildRecord.promise]);
  });

  it("pins a detached parent until its nested provider settles, then cleans deepest-first", async () => {
    vi.useFakeTimers();
    const { cleanupWorktree, createWorktree } = await import("../src/worktree.js");
    const baseRepo = mkdtempSync(join(tmpdir(), "pi-subagents-detached-nested-wt-"));
    const parentPath = join(baseRepo, "parent");
    const childPath = join(parentPath, "child");
    mkdirSync(childPath, { recursive: true });
    const cleanupOrder: string[] = [];
    vi.mocked(createWorktree)
      .mockReturnValueOnce({ path: parentPath, branch: "parent", baseSha: "parent-sha", repoRoot: baseRepo, workPath: parentPath })
      .mockReturnValueOnce({ path: childPath, branch: "child", baseSha: "child-sha", repoRoot: parentPath, workPath: childPath });
    vi.mocked(cleanupWorktree).mockImplementation((_repoRoot, worktree) => {
      cleanupOrder.push(worktree.path);
      return { hasChanges: false, cleanupSucceeded: true };
    });
    let finishParent!: (value: unknown) => void;
    let finishChild!: (value: unknown) => void;
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise((resolve) => { finishParent = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishChild = resolve; }));
    manager = new AgentManager();

    try {
      const parentId = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", {
        description: "parent",
        isBackground: true,
        isolation: "worktree",
      });
      const childId = manager.spawn(mockPi, { cwd: parentPath } as any, "scout", "child", {
        description: "child",
        isBackground: true,
        parentAgentId: parentId,
        isolation: "worktree",
      });
      const parentPromise = manager.getRecordMutable(parentId)!.promise;
      const childPromise = manager.getRecordMutable(childId)!.promise;
      manager.detachForBranchChange();

      finishParent({ responseText: "parent", session: mockSession(), aborted: false, steered: false });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
      await parentPromise;

      expect(cleanupOrder).toEqual([]);
      expect(manager.getRecordMutable(parentId)?.worktree?.path).toBe(parentPath);
      expect(manager.getRecordMutable(childId)?.worktree?.path).toBe(childPath);

      finishChild({ responseText: "child", session: mockSession(), aborted: true, steered: false });
      await childPromise;
      await Promise.resolve();

      expect(cleanupOrder).toEqual([childPath, parentPath]);
      expect(manager.getRecordMutable(parentId)?.worktree).toBeUndefined();
    } finally {
      vi.useRealTimers();
      rmSync(baseRepo, { recursive: true, force: true });
    }
  });

  it("pins a parent checkout while a non-isolated nested provider may still use it", async () => {
    vi.useFakeTimers();
    const { cleanupWorktree, createWorktree } = await import("../src/worktree.js");
    const baseRepo = mkdtempSync(join(tmpdir(), "pi-subagents-shared-nested-wt-"));
    const parentPath = join(baseRepo, "parent");
    mkdirSync(parentPath, { recursive: true });
    const cleanupOrder: string[] = [];
    vi.mocked(createWorktree).mockReturnValueOnce({
      path: parentPath,
      branch: "parent",
      baseSha: "parent-sha",
      repoRoot: baseRepo,
      workPath: parentPath,
    });
    vi.mocked(cleanupWorktree).mockImplementation((_repoRoot, worktree) => {
      cleanupOrder.push(worktree.path);
      return { hasChanges: false, cleanupSucceeded: true };
    });
    let finishParent!: (value: unknown) => void;
    let finishChild!: (value: unknown) => void;
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise((resolve) => { finishParent = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishChild = resolve; }));
    manager = new AgentManager();

    try {
      const parentId = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", {
        description: "parent",
        isBackground: true,
        isolation: "worktree",
      });
      const childId = manager.spawn(mockPi, { cwd: parentPath } as any, "scout", "child", {
        description: "child",
        isBackground: true,
        parentAgentId: parentId,
      });
      const parentPromise = manager.getRecordMutable(parentId)!.promise;
      const childPromise = manager.getRecordMutable(childId)!.promise;
      manager.detachForBranchChange();

      finishParent({ responseText: "parent", session: mockSession(), aborted: false, steered: false });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
      await parentPromise;
      expect(cleanupOrder).toEqual([]);
      expect(manager.getRecordMutable(parentId)?.worktree?.path).toBe(parentPath);

      finishChild({ responseText: "child", session: mockSession(), aborted: true, steered: false });
      await childPromise;
      await Promise.resolve();

      expect(cleanupOrder).toEqual([parentPath]);
      expect(manager.getRecordMutable(parentId)?.worktree).toBeUndefined();
    } finally {
      vi.useRealTimers();
      rmSync(baseRepo, { recursive: true, force: true });
    }
  });

  it("pins timed-out nested worktrees and quarantines descendants", async () => {
    vi.useFakeTimers();
    const { cleanupWorktree, createWorktree } = await import("../src/worktree.js");
    const baseRepo = mkdtempSync(join(tmpdir(), "pi-subagents-timeout-wt-"));
    const parentPath = join(baseRepo, "parent");
    const childPath = join(parentPath, "child");
    const grandchildPath = join(childPath, "grandchild");
    mkdirSync(grandchildPath, { recursive: true });
    const cleanupOrder: string[] = [];
    vi.mocked(createWorktree)
      .mockReturnValueOnce({ path: parentPath, branch: "parent", baseSha: "parent-sha", repoRoot: baseRepo, workPath: parentPath })
      .mockReturnValueOnce({ path: childPath, branch: "child", baseSha: "child-sha", repoRoot: parentPath, workPath: childPath })
      .mockReturnValueOnce({ path: grandchildPath, branch: "grandchild", baseSha: "grandchild-sha", repoRoot: childPath, workPath: grandchildPath });
    vi.mocked(cleanupWorktree).mockImplementation((_repoRoot, worktree) => {
      cleanupOrder.push(worktree.path);
      return { hasChanges: false, cleanupSucceeded: true };
    });
    let finishRoot!: (value: unknown) => void;
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise((resolve) => { finishRoot = resolve; }))
      .mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager();

    try {
      const rootId = manager.spawn(mockPi, mockCtx, "general-purpose", "root", {
        description: "root",
        isBackground: true,
        isolation: "worktree",
      });
      const childId = manager.spawn(mockPi, { cwd: parentPath } as any, "scout", "child", {
        description: "child",
        isBackground: true,
        parentAgentId: rootId,
        isolation: "worktree",
      });
      const grandchildId = manager.spawn(mockPi, { cwd: childPath } as any, "scout", "grandchild", {
        description: "grandchild",
        isBackground: true,
        parentAgentId: childId,
        isolation: "worktree",
      });
      const rootPromise = manager.getRecordMutable(rootId)!.promise;
      finishRoot({ responseText: "root", session: mockSession(), aborted: false, steered: false });

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(cleanupOrder).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await rootPromise;

      expect(cleanupOrder).toEqual([]);
      expect(manager.getRecordMutable(childId)?.detached).toBe(true);
      expect(manager.getRecordMutable(grandchildId)?.detached).toBe(true);
      expect(manager.getRecordMutable(rootId)?.worktree?.path).toBe(parentPath);
      expect(manager.getRecordMutable(childId)?.worktree?.path).toBe(childPath);
      expect(manager.getRecordMutable(grandchildId)?.worktree?.path).toBe(grandchildPath);
    } finally {
      vi.useRealTimers();
      rmSync(baseRepo, { recursive: true, force: true });
    }
  });
});

describe("AgentManager — resumable index (rememberAgents)", () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await manager?.dispose();
    vi.useRealTimers();
  });

  it("indexes an evicted top-level agent with a session file", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: mockSession("/sessions/agent-1.jsonl"),
      aborted: false,
      steered: false,
    });
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "work", {
      description: "work",
      isBackground: true,
    });
    await manager.getRecordMutable(id)!.promise;
    const record = manager.getRecordMutable(id)!;
    record.completedAt = Date.now() - 11 * 60_000; // older than the 10-minute cutoff

    manager.clearCompleted();

    const entries = manager.listResumable();
    expect(entries.length).toBe(1);
    expect(entries[0].id).toBe(id);
    expect(entries[0].sessionFile).toBe("/sessions/agent-1.jsonl");
    expect(manager.getResumable(id)).toBeDefined();
  });

  it("does not index records without a session file", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: mockSession(), // no sessionFile
      aborted: false,
      steered: false,
    });
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "work", {
      description: "work",
      isBackground: true,
    });
    await manager.getRecordMutable(id)!.promise;
    const record = manager.getRecordMutable(id)!;
    record.completedAt = Date.now() - 11 * 60_000;

    manager.clearCompleted();

    expect(manager.listResumable().length).toBe(0);
  });

  it("setting rememberAgents=false clears the index and stops new entries", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: mockSession("/sessions/a.jsonl"),
      aborted: false,
      steered: false,
    });
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "work", {
      description: "work",
      isBackground: true,
    });
    await manager.getRecordMutable(id)!.promise;
    const record = manager.getRecordMutable(id)!;
    record.completedAt = Date.now() - 11 * 60_000;
    manager.clearCompleted();
    expect(manager.listResumable().length).toBe(1);

    manager.setRememberAgents(false);
    expect(manager.listResumable().length).toBe(0);

    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "more", {
      description: "more",
      isBackground: true,
    });
    await manager.getRecordMutable(id2)!.promise;
    const record2 = manager.getRecordMutable(id2)!;
    record2.completedAt = Date.now() - 11 * 60_000;
    manager.clearCompleted();
    expect(manager.listResumable().length).toBe(0);
  });

  it("dropResumable forgets an entry by handle or id", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: mockSession("/sessions/b.jsonl"),
      aborted: false,
      steered: false,
    });
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "work", {
      description: "work",
      isBackground: true,
    });
    await manager.getRecordMutable(id)!.promise;
    const record = manager.getRecordMutable(id)!;
    record.completedAt = Date.now() - 11 * 60_000;
    manager.clearCompleted();
    expect(manager.listResumable().length).toBe(1);

    expect(manager.dropResumable(id)).toBe(true);
    expect(manager.listResumable().length).toBe(0);
    expect(manager.dropResumable(id)).toBe(false);
  });
});

describe("AgentManager — completion callbacks", () => {
  let manager: AgentManager;

  afterEach(async () => {
    await manager?.dispose();
  });

  it("does not let onComplete errors turn a completed agent into a failed run", async () => {
    manager = new AgentManager(() => {
      throw new Error("stale extension context");
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await expect(manager.getRecordMutable(id)!.promise).resolves.toBe("done");

    expect(manager.getRecordMutable(id)!.status).toBe("completed");
  });
});

describe("AgentManager — cleanup timer", () => {
  let manager: AgentManager;

  afterEach(async () => {
    await manager?.dispose();
  });

  it("does not keep the process alive on its own", () => {
    manager = new AgentManager();

    expect((manager as any).cleanupInterval.hasRef()).toBe(false);
  });
});

describe("AgentManager — Bug 3 clearCompleted", () => {
  let manager: AgentManager;

  afterEach(async () => {
    await manager?.dispose();
  });

  it("clearCompleted removes completed records", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecordMutable(id)!.promise;

    expect(manager.listAgents()).toHaveLength(1);
    manager.clearCompleted();
    expect(manager.listAgents()).toHaveLength(0);
  });

  it("releases a pool slot when the runner throws synchronously", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent)
      .mockImplementationOnce(() => {
        throw new Error("synchronous runner failure");
      })
      .mockImplementation(() => new Promise(() => {}) as never);

    expect(() => manager.spawn(mockPi, mockCtx, "X", "failed", {
      description: "failed",
      isBackground: true,
    })).toThrow("synchronous runner failure");

    const id = manager.spawn(mockPi, mockCtx, "Y", "next", {
      description: "next",
      isBackground: true,
    });
    expect(manager.getRecordMutable(id)?.status).toBe("running");
  });

  it("clearCompleted does not remove running or queued agents", async () => {
    // Use maxConcurrent=0 to keep agents queued, then spawn one running via foreground
    manager = new AgentManager(undefined, 1);

    // Mock runAgent to never resolve (keeps agent "running")
    vi.mocked(runAgent).mockImplementation(
      () => new Promise(() => {}), // hangs forever
    );

    const id1 = manager.spawn(mockPi, mockCtx, "general-purpose", "test1", {
      description: "running agent",
      isBackground: true,
    });
    // Second agent should be queued (limit=1)
    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "test2", {
      description: "queued agent",
      isBackground: true,
    });

    expect(manager.getRecordMutable(id1)!.status).toBe("running");
    expect(manager.getRecordMutable(id2)!.status).toBe("queued");

    manager.clearCompleted();

    // Both should still be present
    expect(manager.getRecordMutable(id1)).toBeDefined();
    expect(manager.getRecordMutable(id2)).toBeDefined();

    // Abort to allow cleanup
    manager.abort(id1);
    manager.abort(id2);
  });

  it("clearCompleted calls dispose on sessions of removed records", async () => {
    manager = new AgentManager();
    const disposeSpy = vi.fn();
    const sess = { dispose: disposeSpy };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: sess as any,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecordMutable(id)!.promise;

    manager.clearCompleted();

    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("clearCompleted removes error and stopped records", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecordMutable(id)!.promise;
    expect(manager.getRecordMutable(id)!.status).toBe("error");

    manager.clearCompleted();
    expect(manager.getRecordMutable(id)).toBeUndefined();
  });

  it("clearCompleted(true) preserves completed records with resultConsumed=false", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecordMutable(id)!.promise;
    expect(manager.getRecordMutable(id)!.status).toBe("completed");
    expect(manager.getRecordMutable(id)!.resultConsumed).toBeFalsy();

    manager.clearCompleted(true);
    expect(manager.getRecordMutable(id)).toBeDefined();
  });

  it("clearCompleted(true) removes completed records with resultConsumed=true", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecordMutable(id)!;
    await record.promise;
    record.resultConsumed = true;

    manager.clearCompleted(true);
    expect(manager.getRecordMutable(id)).toBeUndefined();
  });

  it("clearCompleted(true) still removes running=false queued=false records when resultConsumed=false for error status", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecordMutable(id)!.promise;
    expect(manager.getRecordMutable(id)!.status).toBe("error");
    expect(manager.getRecordMutable(id)!.resultConsumed).toBeFalsy();

    // Error records with unread results are also preserved — the LLM should
    // be able to read the error message via get_subagent_result before the
    // record is evicted.
    manager.clearCompleted(true);
    expect(manager.getRecordMutable(id)).toBeDefined();
  });
});

// Eager init removes the optional/required asymmetry that previously required
// `??=` defaults at the callback sites and `?? 0` / `?? 1` at the read sites.
describe("AgentManager — lifetime usage + compaction count are eagerly initialized", () => {
  let manager: AgentManager;

  afterEach(async () => {
    await manager?.dispose();
  });

  it("spawn initializes lifetimeUsage to zeros and compactionCount to 0", () => {
    manager = new AgentManager();
    // Don't resolve the run — we just want to inspect the record at spawn time.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecordMutable(id)!;

    expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(record.compactionCount).toBe(0);

    manager.abort(id);
  });

  it("onAssistantUsage from runAgent accumulates into record.lifetimeUsage", async () => {
    manager = new AgentManager();

    // Capture the options passed to runAgent so we can drive callbacks
    let captured: any;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      captured = opts;
      // Two assistant messages with usage
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 10 });
      opts.onAssistantUsage?.({ input: 200, output: 80, cacheWrite: 20 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecordMutable(id)!.promise;

    expect(captured).toBeDefined();
    expect(manager.getRecordMutable(id)!.lifetimeUsage).toEqual({
      input: 300, output: 130, cacheWrite: 30,
    });
  });

  it("onCompaction from runAgent increments record.compactionCount", async () => {
    manager = new AgentManager();
    const compactSeen: any[] = [];

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      // Compaction fires while the agent is still running — the record passed to
      // onCompact should reflect the just-incremented count.
      opts.onCompaction?.({ reason: "threshold", tokensBefore: 12345 });
      opts.onCompaction?.({ reason: "manual", tokensBefore: 22222 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    manager = new AgentManager(undefined, undefined, undefined, (record, info) => {
      compactSeen.push({ count: record.compactionCount, reason: info.reason });
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecordMutable(id)!.promise;

    expect(compactSeen).toEqual([
      { count: 1, reason: "threshold" },
      { count: 2, reason: "manual" },
    ]);
    expect(manager.getRecordMutable(id)!.compactionCount).toBe(2);
  });

  it("resume() also accumulates usage and increments compactions on the same record", async () => {
    manager = new AgentManager();

    // First, spawn with a session that resume can latch onto
    const session = { ...mockSession() };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first",
      session: session as any,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecordMutable(id)!.promise;

    // Pre-resume: lifetimeUsage from spawn was zero (mock didn't call onAssistantUsage)
    expect(manager.getRecordMutable(id)!.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(manager.getRecordMutable(id)!.compactionCount).toBe(0);

    // Now resume — drive callbacks via the mocked resumeAgent
    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockImplementation(async (_session, _prompt, opts: any) => {
      opts.onAssistantUsage?.({ input: 70, output: 30, cacheWrite: 5 });
      opts.onCompaction?.({ reason: "overflow", tokensBefore: 999 });
      return { text: "second" };
    });

    await manager.resume(id, "more");

    expect(manager.getRecordMutable(id)!.lifetimeUsage).toEqual({ input: 70, output: 30, cacheWrite: 5 });
    expect(manager.getRecordMutable(id)!.compactionCount).toBe(1);
  });


  it("preserves a terminal record when resume is already aborted", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "prior result",
      session: mockSession(),
      aborted: false,
      steered: false,
    });
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "first", {
      description: "first",
      isBackground: true,
    });
    const record = manager.getRecordMutable(id)!;
    await record.promise;
    const before = {
      status: record.status,
      result: record.result,
      error: record.error,
      completedAt: record.completedAt,
    };

    vi.mocked(resumeAgent).mockClear();
    const controller = new AbortController();
    controller.abort(new Error("resume already cancelled"));
    await expect(manager.resume(id, "do not run", controller.signal)).resolves.toBe(record);

    expect(record.status).toBe(before.status);
    expect(record.result).toBe(before.result);
    expect(record.error).toBe(before.error);
    expect(record.completedAt).toBe(before.completedAt);
    expect(resumeAgent).not.toHaveBeenCalled();
  });
});

// Regression: `isolation: "worktree"` MUST fail loud when the cwd can't host
// a worktree. The previous behavior silently fell back to the main tree and
// injected a warning into the LLM's prompt — invisible to the caller.
describe("AgentManager — isolation: worktree fails loud, no silent fallback", () => {
  let manager: AgentManager;

  afterEach(async () => {
    await manager?.dispose();
  });

  it("spawn() throws when createWorktree returns undefined; no orphan record left behind", async () => {
    const { createWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce(undefined);
    vi.mocked(runAgent).mockClear();

    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    })).toThrow(/isolation: "worktree"/);

    // Cleaned up — no orphan in listAgents()
    expect(manager.listAgents()).toEqual([]);
    // runAgent never invoked — strict, no silent fallback
    expect(runAgent).not.toHaveBeenCalled();
  });
});

describe("AgentManager — SpawnOptions.cwd passthrough (#96)", () => {
  let manager: AgentManager;
  afterEach(async () => { await manager?.dispose(); });

  it("passes cwd to runAgent as the working dir, parent cwd as configCwd", async () => {
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/", // absolute and always exists
    });
    await manager.getRecordMutable(id)!.promise;

    expect(runAgent).toHaveBeenCalledWith(
      mockCtx, "general-purpose", "test",
      expect.objectContaining({ cwd: "/", configCwd: "/tmp" }),
    );
  });

  it("without cwd, configCwd stays unset — existing behavior untouched", async () => {
    // mockClear + lastCall: toHaveBeenCalledWith would scan the file's whole
    // accumulated call history, where earlier no-cwd spawns already match.
    vi.mocked(runAgent).mockClear();
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecordMutable(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBeUndefined();
    expect(opts.configCwd).toBeUndefined();
  });

  it("cwd: null (RPC 'unset') behaves exactly like omitting cwd", async () => {
    vi.mocked(runAgent).mockClear();
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: null as any,
    });
    await manager.getRecordMutable(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBeUndefined();
    expect(opts.configCwd).toBeUndefined();
  });

  it("cwd + isolation: worktree — worktree created FROM cwd, session runs at the copy's workPath, cleanup targets cwd's repo", async () => {
    const { createWorktree, cleanupWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce({
      path: "/wt/copy", branch: "pi-agent-x", baseSha: "abc", repoRoot: "/repo", workPath: "/wt/copy/packages/api",
    });
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/",
      isolation: "worktree",
    });
    await manager.getRecordMutable(id)!.promise;

    expect(createWorktree).toHaveBeenCalledWith("/", id);
    // Worktree wins for the working dir — at workPath, so subdirectory scoping
    // survives isolation. Config still anchored to the parent.
    expect(runAgent).toHaveBeenCalledWith(
      mockCtx, "general-purpose", "test",
      expect.objectContaining({ cwd: "/wt/copy/packages/api", configCwd: "/tmp", worktreeBase: "/repo" }),
    );
    expect(cleanupWorktree).toHaveBeenCalledWith("/repo", expect.anything(), "test");
  });

  it("plain worktree (no cwd) keeps the historical root working dir even when workPath differs", async () => {
    // Parent session sitting in a repo subdirectory: workPath would point at
    // the copied subdir. Without SpawnOptions.cwd the agent must stay at the
    // copy's root — moving it would also move .pi config discovery.
    const { createWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce({
      path: "/wt/copy", branch: "pi-agent-x", baseSha: "abc", repoRoot: "/repo", workPath: "/wt/copy/sub/dir",
    });
    vi.mocked(runAgent).mockClear();
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    });
    await manager.getRecordMutable(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBe("/wt/copy");
    expect(opts.worktreeBase).toBe("/repo");
    expect(opts.configCwd).toBeUndefined();
  });

  it("relative cwd throws immediately; no orphan record", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "relative/path",
    })).toThrow(/absolute path/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("nonexistent cwd throws immediately; no orphan record", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/nonexistent-pi-subagents-test-dir",
    })).toThrow(/does not exist/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("cwd pointing at a regular file throws a curated 'not a directory' error", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: fileURLToPath(import.meta.url), // this test file: absolute, exists, not a directory
    })).toThrow(/not a directory/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("non-string cwd (RPC junk) throws the curated error, not a TypeError from path internals", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: 123 as any,
    })).toThrow(/must be an absolute path/);
    expect(manager.listAgents()).toEqual([]);
  });
});

describe("AgentManager — abort() state machine", () => {
  let manager: AgentManager;
  afterEach(async () => { await manager?.dispose(); });

  it("returns false for an unknown id (no record, no side-effects)", () => {
    manager = new AgentManager();
    expect(manager.abort("does-not-exist")).toBe(false);
  });

  it("removes a queued agent from the queue and marks it stopped", () => {
    // Concurrency=1: the second background spawn queues behind the first
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager.spawn(mockPi, mockCtx, "X", "blocker", { description: "block", isBackground: true });
    const queuedId = manager.spawn(mockPi, mockCtx, "Y", "queued", {
      description: "q",
      isBackground: true,
    });
    const queuedRecord = manager.getRecordMutable(queuedId)!;
    expect(queuedRecord.status).toBe("queued");

    expect(manager.abort(queuedId)).toBe(true);
    expect(queuedRecord.status).toBe("stopped");
    expect(queuedRecord.completedAt).toBeGreaterThan(0);
    // Aborting again is a no-op — status is no longer "queued" or "running"
    expect(manager.abort(queuedId)).toBe(false);
  });


  it("removes an aborted queued agent so later work can drain", async () => {
    let finishBlocker!: (value: unknown) => void;
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise((resolve) => { finishBlocker = resolve; }))
      .mockResolvedValue({ responseText: "later", session: mockSession(), aborted: false, steered: false });
    manager = new AgentManager(undefined, 1);

    const blockerId = manager.spawn(mockPi, mockCtx, "X", "blocker", {
      description: "blocker",
      isBackground: true,
    });
    const abortedId = manager.spawn(mockPi, mockCtx, "Y", "aborted", {
      description: "aborted",
      isBackground: true,
    });
    const laterId = manager.spawn(mockPi, mockCtx, "Z", "later", {
      description: "later",
      isBackground: true,
    });

    expect(manager.abort(abortedId)).toBe(true);
    finishBlocker({ responseText: "done", session: mockSession(), aborted: false, steered: false });
    await manager.getRecordMutable(blockerId)!.promise;
    await manager.getRecordMutable(laterId)!.promise;

    expect(manager.getRecordMutable(abortedId)?.status).toBe("stopped");
    expect(manager.getRecordMutable(laterId)?.status).toBe("completed");
  });

  it("aborts a running agent by firing its AbortController and setting status='stopped'", () => {
    manager = new AgentManager();
    let receivedSignal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      receivedSignal = (opts as { signal?: AbortSignal })?.signal;
      return new Promise(() => {});
    });

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "r",
      isBackground: true,
    });
    const record = manager.getRecordMutable(id)!;
    expect(record.status).toBe("running");
    expect(receivedSignal?.aborted).toBe(false);

    expect(manager.abort(id)).toBe(true);
    expect(record.status).toBe("stopped");
    expect(record.completedAt).toBeGreaterThan(0);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("returns false (and does not change status) for an already-completed agent", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: false,
    });
    await manager.getRecordMutable(id)?.promise;
    expect(manager.getRecordMutable(id)?.status).toBe("completed");

    expect(manager.abort(id)).toBe(false);
    expect(manager.getRecordMutable(id)?.status).toBe("completed");
  });

  it("a user abort survives the agent settling — stays 'stopped', never 'completed'", async () => {
    // Guards the `if (record.status !== "stopped")` check in the completion
    // handler: after a user abort, runAgent's promise still settles (here with
    // aborted:false, as a non-cooperative mock would), and must NOT flip the
    // user-stopped status back to "completed" — otherwise the parent agent
    // would read the partial output as a finished result.
    manager = new AgentManager();
    let resolveRun!: (v: unknown) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise((res) => { resolveRun = res as (v: unknown) => void; }));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r", isBackground: true });
    const record = manager.getRecordMutable(id)!;
    expect(record.status).toBe("running");

    expect(manager.abort(id)).toBe(true);
    expect(record.status).toBe("stopped");

    // The agent loop ends and the promise settles "normally".
    resolveRun({ responseText: "partial output", session: mockSession(), aborted: false, steered: false });
    await record.promise;

    expect(record.status).toBe("stopped");        // not overwritten to "completed"
    expect(record.result).toBe("partial output"); // partial result still captured
  });
});

// Regression for #44: ESC during a foreground Agent call must propagate to
// the child. Pi delivers parent abort via AbortSignal; the manager wires the
// signal's "abort" event to this.abort(id).
describe("AgentManager — steer()", () => {
  let manager: AgentManager;
  afterEach(async () => { await manager?.dispose(); });

  it("returns false for an unknown id", () => {
    manager = new AgentManager();
    expect(manager.steer("nope", "hi")).toBe(false);
  });

  it("delivers to a live session via session.steer()", () => {
    manager = new AgentManager();
    const steer = vi.fn(() => Promise.resolve());
    let captured: ((s: any) => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      captured = (opts as any)?.onSessionCreated;
      return new Promise(() => {});
    });
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r", isBackground: true });
    // Simulate the session becoming ready.
    captured?.({ steer, dispose: vi.fn() });

    expect(manager.steer(id, "go left")).toBe(true);
    expect(steer).toHaveBeenCalledWith("go left");
  });

  it("queues onto pendingSteers when the session isn't ready yet", () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r", isBackground: true });
    const record = manager.getRecordMutable(id)!;
    record.session = undefined; // not ready

    expect(manager.steer(id, "first")).toBe(true);
    expect(manager.steer(id, "second")).toBe(true);
    expect(record.pendingSteers).toEqual(["first", "second"]);
  });

  it("refuses to steer an agent that is no longer running", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: false });
    await manager.getRecordMutable(id)?.promise;
    expect(manager.getRecordMutable(id)?.status).toBe("completed");
    expect(manager.steer(id, "too late")).toBe(false);
  });
});

describe("AgentManager — parent abort signal forwarding (#44)", () => {
  let manager: AgentManager;
  afterEach(async () => { await manager?.dispose(); });

  it("aborts the child when the parent signal aborts", () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const parent = new AbortController();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: false,
      signal: parent.signal,
    });
    const record = manager.getRecordMutable(id)!;
    expect(record.status).toBe("running");

    parent.abort();
    expect(record.status).toBe("stopped");
    expect(record.completedAt).toBeGreaterThan(0);
  });
});

describe("AgentManager — listAgents() ordering", () => {
  let manager: AgentManager;
  afterEach(async () => { await manager?.dispose(); });

  it("returns records sorted by startedAt descending (most recent first)", () => {
    manager = new AgentManager();
    resolvedRun();

    const a = manager.spawn(mockPi, mockCtx, "X", "1", { description: "a" });
    const b = manager.spawn(mockPi, mockCtx, "X", "2", { description: "b" });
    const c = manager.spawn(mockPi, mockCtx, "X", "3", { description: "c" });

    // Force deterministic startedAt — Date.now() can collide on fast runs
    manager.getRecordMutable(a)!.startedAt = 100;
    manager.getRecordMutable(b)!.startedAt = 200;
    manager.getRecordMutable(c)!.startedAt = 300;

    expect(manager.listAgents().map((r) => r.id)).toEqual([c, b, a]);
  });
});

describe("AgentManager — abortAll", () => {
  let manager: AgentManager;
  afterEach(async () => { await manager?.dispose(); });

  it("stops both queued and running agents and returns the total count", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const running = manager.spawn(mockPi, mockCtx, "X", "r", {
      description: "r",
      isBackground: true,
    });
    const queued = manager.spawn(mockPi, mockCtx, "Y", "q", {
      description: "q",
      isBackground: true,
    });
    expect(manager.getRecordMutable(running)?.status).toBe("running");
    expect(manager.getRecordMutable(queued)?.status).toBe("queued");

    expect(manager.abortAll()).toBe(2);
    expect(manager.getRecordMutable(running)?.status).toBe("stopped");
    expect(manager.getRecordMutable(queued)?.status).toBe("stopped");
    expect(manager.hasRunning()).toBe(false);
  });

  it("returns 0 when there are no running or queued agents", () => {
    manager = new AgentManager();
    expect(manager.abortAll()).toBe(0);
  });
});

describe("AgentManager — hasRunning", () => {
  let manager: AgentManager;
  afterEach(async () => { await manager?.dispose(); });

  it("is true while a background agent is running, false after it completes", async () => {
    manager = new AgentManager();
    resolvedRun();

    expect(manager.hasRunning()).toBe(false);
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: true,
    });
    expect(manager.hasRunning()).toBe(true);

    await manager.getRecordMutable(id)?.promise;
    expect(manager.hasRunning()).toBe(false);
  });

  it("is true when an agent is queued behind the concurrency limit", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager.spawn(mockPi, mockCtx, "X", "r", { description: "r", isBackground: true });
    manager.spawn(mockPi, mockCtx, "Y", "q", { description: "q", isBackground: true });
    expect(manager.hasRunning()).toBe(true);
  });
});

describe("AgentManager — runAgent rejection leaves the record visible with error status", () => {
  let manager: AgentManager;
  afterEach(async () => { await manager?.dispose(); });

  it("sets status='error', captures the error message, and stamps completedAt", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: false,
    });
    const record = manager.getRecordMutable(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.error).toBe("boom");
    expect(record.completedAt).toBeGreaterThan(0);
  });
});

// #144 — a run that RESOLVES with a failed final turn (pi never rejects on
// retry exhaustion) must map to status "error", not "completed".
describe("AgentManager — resolved runs with a failed final turn map to error (#144)", () => {
  let manager: AgentManager;
  afterEach(async () => { await manager?.dispose(); });

  const failedRun = (failure: string, responseText = "") =>
    vi.mocked(runAgent).mockResolvedValue({
      responseText,
      session: mockSession(),
      aborted: false,
      steered: false,
      failure,
    } as any);

  it("sets status='error' and captures the provider message", async () => {
    manager = new AgentManager();
    failedRun("retries exhausted: 529 overloaded");

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecordMutable(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.error).toBe("retries exhausted: 529 overloaded");
    expect(record.completedAt).toBeGreaterThan(0);
  });

  it("keeps earlier-turn text available as result context, but never as a clean completion", async () => {
    manager = new AgentManager();
    failedRun("provider died", "partial progress from an earlier turn");

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecordMutable(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.result).toBe("partial progress from an earlier turn");
  });

  it("onComplete sees the error status (routes to subagents:failed in the host)", async () => {
    let completed: AgentRecord | undefined;
    manager = new AgentManager((r) => { completed = r; });
    failedRun("boom");

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    await manager.getRecordMutable(id)!.promise;

    expect(completed?.status).toBe("error");
  });

  it("an external stop still wins over a late failure resolution", async () => {
    manager = new AgentManager();
    let resolveRun: ((v: unknown) => void) | undefined;
    const session = mockSession();
    vi.mocked(runAgent).mockImplementation(() => new Promise((r) => { resolveRun = r; }));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecordMutable(id)!;
    record.status = "stopped"; // external abort() path
    resolveRun!({ responseText: "", session, aborted: false, steered: false, failure: "late error" });
    await record.promise;

    expect(record.status).toBe("stopped");
    expect(record.error).toBeUndefined();
  });

  it("resume(): a failed final turn on the resumed prompt maps to error too", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecordMutable(id)!;
    await record.promise;
    expect(record.status).toBe("completed");

    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    // resumeAgent bounds its fallback to this invocation, so a failed empty
    // resume yields text "" — never the prior turn's answer (#144 root-fix).
    vi.mocked(resumeMock).mockResolvedValue({
      text: "",
      failure: "retries exhausted on resume",
    });

    await manager.resume(id, "more");

    expect(record.status).toBe("error");
    expect(record.error).toBe("retries exhausted on resume");
    expect(record.result).toBe(""); // no stale prior answer
  });

  it("resume(): partial text produced before the failure is kept as result", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecordMutable(id)!;
    await record.promise;

    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockResolvedValue({
      text: "new partial progress",
      failure: "provider died mid-turn",
    });

    await manager.resume(id, "more");

    expect(record.status).toBe("error");
    expect(record.result).toBe("new partial progress"); // salvageable, this-run text
  });
});

describe("AgentManager — queued resume chat isolation", () => {
  let manager: AgentManager;

  afterEach(async () => { await manager?.dispose(); });

  it("keeps queued-resume chat out of the reused session and clears it on cancel", async () => {
    const targetSession = { ...mockSession(), steer: vi.fn(async () => {}) };
    let releaseBlocker!: (value: unknown) => void;
    vi.mocked(runAgent)
      .mockResolvedValueOnce({ responseText: "target", session: targetSession, aborted: false, steered: false })
      .mockImplementationOnce(() => new Promise((resolve) => { releaseBlocker = resolve; }));
    vi.mocked(resumeAgent).mockClear();
    manager = new AgentManager(undefined, 1);

    const targetId = manager.spawn(mockPi, mockCtx, "X", "target", {
      description: "target", isBackground: true,
    });
    await manager.getRecordMutable(targetId)!.promise;

    const blockerId = manager.spawn(mockPi, mockCtx, "X", "blocker", {
      description: "blocker", isBackground: true,
    });
    await vi.waitFor(() => expect(manager.getRecordMutable(blockerId)?.status).toBe("running"));

    const resumed = await manager.resume(targetId, "later", undefined, { isBackground: true });
    const target = manager.getRecordMutable(targetId)!;
    expect(resumed?.status).toBe("queued");

    expect(manager.steer(targetId, "old queued message")).toBe(true);
    expect(target.pendingSteers).toEqual(["old queued message"]);
    expect(targetSession.steer).not.toHaveBeenCalled();

    expect(manager.abort(targetId)).toBe(true);
    expect(target.status).toBe("stopped");
    expect(target.pendingSteers).toBeUndefined();

    releaseBlocker({ responseText: "blocker done", session: mockSession(), aborted: false, steered: false });
    await manager.getRecordMutable(blockerId)!.promise;
    expect(resumeAgent).not.toHaveBeenCalled();
  });

  it("flushes queued-resume chat when the queued run actually starts", async () => {
    const targetSession = { ...mockSession(), steer: vi.fn(async () => {}) };
    let releaseBlocker!: (value: unknown) => void;
    vi.mocked(runAgent)
      .mockResolvedValueOnce({ responseText: "target", session: targetSession, aborted: false, steered: false })
      .mockImplementationOnce(() => new Promise((resolve) => { releaseBlocker = resolve; }));
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed" });
    manager = new AgentManager(undefined, 1);

    const targetId = manager.spawn(mockPi, mockCtx, "X", "target", {
      description: "target", isBackground: true,
    });
    await manager.getRecordMutable(targetId)!.promise;

    const blockerId = manager.spawn(mockPi, mockCtx, "X", "blocker", {
      description: "blocker", isBackground: true,
    });
    await vi.waitFor(() => expect(manager.getRecordMutable(blockerId)?.status).toBe("running"));

    const onStarted = vi.fn();
    const resumed = await manager.resume(targetId, "later", undefined, {
      isBackground: true,
      onStarted,
    });
    const target = manager.getRecordMutable(targetId)!;
    const resumeLifecycle = target.promise!;
    expect(resumed?.status).toBe("queued");
    expect(onStarted).not.toHaveBeenCalled();
    expect(manager.steer(targetId, "queued message")).toBe(true);

    releaseBlocker({ responseText: "blocker done", session: mockSession(), aborted: false, steered: false });
    await manager.getRecordMutable(blockerId)!.promise;
    await resumeLifecycle;

    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(targetSession.steer).toHaveBeenCalledWith("queued message");
    expect(target.pendingSteers).toBeUndefined();
    expect(target.status).toBe("completed");
  });
});
