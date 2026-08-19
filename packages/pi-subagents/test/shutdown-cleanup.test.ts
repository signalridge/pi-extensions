import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, type ManagedSpawnPolicy } from "../src/agent-manager.js";
import { type RunOptions, type RunResult, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import {
  cleanupWorktree,
  cleanupWorktreeAsync,
  createWorktree,
  pruneWorktrees,
  type WorktreeInfo,
} from "../src/worktree.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
  getAgentConversation: vi.fn(() => ""),
  getDefaultMaxTurns: vi.fn(() => undefined),
  getDefaultModel: vi.fn(() => undefined),
  getGraceTurns: vi.fn(() => 1),
  getDefaultMaxTokens: vi.fn(() => 0),
  getDefaultMaxToolCalls: vi.fn(() => 0),
  normalizeMaxTurns: vi.fn((n: number | undefined) => n),
  resolveConfiguredDefaultModel: vi.fn(() => undefined),
  setDefaultMaxTurns: vi.fn(),
  setDefaultModel: vi.fn(),
  setGraceTurns: vi.fn(),
  setDefaultMaxTokens: vi.fn(),
  setDefaultMaxToolCalls: vi.fn(),
  steerAgent: vi.fn(),
  SUBAGENT_TOOL_NAMES: {
    AGENT: "Agent",
    GET_RESULT: "get_subagent_result",
    STEER: "steer_subagent",
  },
}));

vi.mock("../src/worktree.js", () => {
  const cleanupWorktree = vi.fn();
  const pruneWorktrees = vi.fn();
  return {
    createWorktree: vi.fn(),
    cleanupWorktree,
    cleanupWorktreeAsync: vi.fn(async (...args: Parameters<typeof cleanupWorktree>) => cleanupWorktree(...args)),
    pruneWorktreesAsync: vi.fn(async (...args: Parameters<typeof pruneWorktrees>) => pruneWorktrees(...args)),
    pruneWorktrees,
  };
});

const mockPi = {} as never;

function worktree(path: string, repoRoot: string, branch: string): WorktreeInfo {
  return { path, branch, baseSha: `${branch}-sha`, repoRoot, workPath: path };
}


function abortResponsiveRun(_ctx: unknown, _type: string, _prompt: string, options: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const finish = () => resolve({
      responseText: "stopped",
      session: { dispose: vi.fn() } as never,
      aborted: true,
      steered: false,
    });
    if (options.signal?.aborted) finish();
    else options.signal?.addEventListener("abort", finish, { once: true });
  });
}

function internals(manager: AgentManager): {
  agents: Map<string, AgentRecord>;
  nestedSpawnSeals: Set<string>;
} {
  return manager as unknown as {
    agents: Map<string, AgentRecord>;
    nestedSpawnSeals: Set<string>;
  };
}

describe("AgentManager synchronous shutdown cleanup", () => {
  let manager: AgentManager | undefined;

  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
    vi.mocked(createWorktree).mockReset();
    vi.mocked(cleanupWorktree).mockReset();
    vi.mocked(cleanupWorktreeAsync).mockClear();
    vi.mocked(pruneWorktrees).mockReset();
  });

  afterEach(async () => {
    await manager?.dispose();
    manager = undefined;
  });

  it("dispose removes R → C → G worktrees deepest-first before clearing metadata", async () => {
    const baseRepo = mkdtempSync(join(tmpdir(), "pi-subagents-dispose-wt-"));
    const rootPath = join(baseRepo, "root");
    const childPath = join(rootPath, "child");
    const grandchildPath = join(childPath, "grandchild");
    mkdirSync(grandchildPath, { recursive: true });
    const cleanupOrder: string[] = [];
    const events: string[] = [];

    vi.mocked(createWorktree)
      .mockReturnValueOnce(worktree(rootPath, baseRepo, "root"))
      .mockReturnValueOnce(worktree(childPath, rootPath, "child"))
      .mockReturnValueOnce(worktree(grandchildPath, childPath, "grandchild"));
    vi.mocked(runAgent).mockImplementation(abortResponsiveRun as typeof runAgent);
    vi.mocked(cleanupWorktree).mockImplementation((_repoRoot, attached) => {
      events.push(`cleanup:${attached.path}`);
      cleanupOrder.push(attached.path);
      expect(internals(manager!).agents.size).toBe(3);
      expect(internals(manager!).nestedSpawnSeals.size).toBe(3);
      rmSync(attached.path, { recursive: true, force: true });
      return { hasChanges: false, cleanupSucceeded: true };
    });
    vi.mocked(pruneWorktrees).mockImplementation((repo) => {
      events.push(`prune:${repo}`);
      expect(internals(manager!).agents.size).toBe(3);
    });

    try {
      manager = new AgentManager();
      const rootId = manager.spawn(mockPi, { cwd: baseRepo } as never, "R", "root", {
        description: "root",
        isBackground: true,
        isolation: "worktree",
      });
      const childId = manager.spawn(mockPi, { cwd: rootPath } as never, "C", "child", {
        description: "child",
        isBackground: true,
        parentAgentId: rootId,
        isolation: "worktree",
      });
      const grandchildId = manager.spawn(mockPi, { cwd: childPath } as never, "G", "grandchild", {
        description: "grandchild",
        isBackground: true,
        parentAgentId: childId,
        isolation: "worktree",
      });
      const records = [
        manager.getRecordMutable(rootId)!,
        manager.getRecordMutable(childId)!,
        manager.getRecordMutable(grandchildId)!,
      ];

      await manager.dispose();

      expect(cleanupOrder).toEqual([grandchildPath, childPath, rootPath]);
      expect(events.slice(0, 3)).toEqual([
        `cleanup:${grandchildPath}`,
        `cleanup:${childPath}`,
        `cleanup:${rootPath}`,
      ]);
      expect(events.slice(3).every((event) => event.startsWith("prune:"))).toBe(true);
      expect(vi.mocked(pruneWorktrees).mock.calls.map(([repo]) => repo)).toEqual(
        expect.arrayContaining([baseRepo, rootPath, childPath]),
      );
      expect(records.every((record) => record.worktree === undefined)).toBe(true);
      expect(existsSync(rootPath)).toBe(false);
      expect(manager.listAgents()).toEqual([]);
      expect(internals(manager).agents.size).toBe(0);
      expect(internals(manager).nestedSpawnSeals.size).toBe(0);
    } finally {
      rmSync(baseRepo, { recursive: true, force: true });
    }
  });

  it("continues through a failed child cleanup and still cleans siblings and ancestors", async () => {
    const baseRepo = mkdtempSync(join(tmpdir(), "pi-subagents-dispose-failure-"));
    const rootPath = join(baseRepo, "root");
    const childPath = join(rootPath, "child");
    const siblingPath = join(rootPath, "sibling");
    const grandchildPath = join(childPath, "grandchild");
    mkdirSync(grandchildPath, { recursive: true });
    mkdirSync(siblingPath, { recursive: true });
    const cleanupOrder: string[] = [];

    vi.mocked(createWorktree)
      .mockReturnValueOnce(worktree(rootPath, baseRepo, "root"))
      .mockReturnValueOnce(worktree(childPath, rootPath, "child"))
      .mockReturnValueOnce(worktree(siblingPath, rootPath, "sibling"))
      .mockReturnValueOnce(worktree(grandchildPath, childPath, "grandchild"));
    vi.mocked(runAgent).mockImplementation(abortResponsiveRun as typeof runAgent);
    let childCleanupAttempts = 0;
    vi.mocked(cleanupWorktree).mockImplementation((_repoRoot, attached) => {
      cleanupOrder.push(attached.path);
      if (attached.path === childPath && childCleanupAttempts++ === 0) {
        return {
          hasChanges: false,
          path: childPath,
          cleanupSucceeded: false,
          cleanupDiagnostic: "child cleanup failed once",
          recoveryCommands: ["recover child"],
        };
      }
      rmSync(attached.path, { recursive: true, force: true });
      return { hasChanges: false, cleanupSucceeded: true };
    });

    try {
      manager = new AgentManager();
      const rootId = manager.spawn(mockPi, { cwd: baseRepo } as never, "R", "root", {
        description: "root",
        isBackground: true,
        isolation: "worktree",
      });
      const childId = manager.spawn(mockPi, { cwd: rootPath } as never, "C", "child", {
        description: "child",
        isBackground: true,
        parentAgentId: rootId,
        isolation: "worktree",
      });
      manager.spawn(mockPi, { cwd: rootPath } as never, "S", "sibling", {
        description: "sibling",
        isBackground: true,
        parentAgentId: rootId,
        isolation: "worktree",
      });
      manager.spawn(mockPi, { cwd: childPath } as never, "G", "grandchild", {
        description: "grandchild",
        isBackground: true,
        parentAgentId: childId,
        isolation: "worktree",
      });

      await manager.dispose();

      expect(cleanupOrder).toEqual([grandchildPath, childPath, siblingPath, childPath, rootPath]);
      expect(existsSync(rootPath)).toBe(false);
      expect(manager.listAgents()).toEqual([]);
    } finally {
      rmSync(baseRepo, { recursive: true, force: true });
    }
  });

  it("retains immutable path-rich diagnostics when a worktree remains after retry", async () => {
    const baseRepo = mkdtempSync(join(tmpdir(), "pi-subagents-dispose-diagnostic-"));
    const rootPath = join(baseRepo, "root");
    const childPath = join(rootPath, "child");
    const siblingPath = join(rootPath, "sibling");
    mkdirSync(siblingPath, { recursive: true });
    const cleanupOrder: string[] = [];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.mocked(createWorktree)
      .mockReturnValueOnce(worktree(rootPath, baseRepo, "root"))
      .mockReturnValueOnce(worktree(childPath, rootPath, "child"))
      .mockReturnValueOnce(worktree(siblingPath, rootPath, "sibling"));
    vi.mocked(runAgent).mockImplementation(abortResponsiveRun as typeof runAgent);
    vi.mocked(cleanupWorktree).mockImplementation((_repoRoot, attached) => {
      cleanupOrder.push(attached.path);
      if (attached.path === childPath) {
        return {
          hasChanges: false,
          path: childPath,
          cleanupSucceeded: false,
          cleanupDiagnostic: "permission denied by the operating system",
          recoveryCommands: ["recover child"],
        };
      }
      rmSync(attached.path, { recursive: true, force: true });
      return { hasChanges: false, cleanupSucceeded: true };
    });

    try {
      manager = new AgentManager();
      const rootId = manager.spawn(mockPi, { cwd: baseRepo } as never, "R", "root", {
        description: "root",
        isBackground: true,
        isolation: "worktree",
      });
      const childId = manager.spawn(mockPi, { cwd: rootPath } as never, "C", "child", {
        description: "child",
        isBackground: true,
        parentAgentId: rootId,
        isolation: "worktree",
      });
      manager.spawn(mockPi, { cwd: rootPath } as never, "S", "sibling", {
        description: "sibling",
        isBackground: true,
        parentAgentId: rootId,
        isolation: "worktree",
      });
      const childRecord = manager.getRecordMutable(childId)!;

      const failures = await manager.dispose();
      expect(cleanupOrder).toEqual([childPath, siblingPath, childPath]);
      expect(vi.mocked(pruneWorktrees)).toHaveBeenCalled();
      expect(failures).toHaveLength(2);
      expect(failures[0]).toMatchObject({
        path: childPath,
        repoRoot: rootPath,
        reason: "permission denied by the operating system",
        recoveryCommands: ["recover child"],
      });
      expect(failures[1]).toMatchObject({
        path: rootPath,
        repoRoot: baseRepo,
        reason: expect.stringContaining("pinned"),
      });
      expect(Object.isFrozen(failures)).toBe(true);
      expect(Object.isFrozen(failures[0])).toBe(true);
      expect(Object.isFrozen(failures[0]!.recoveryCommands)).toBe(true);
      expect(childRecord.worktree?.path).toBe(childPath);
      expect(manager.getWorktreeCleanupFailures()).toBe(failures);
      expect(warning).toHaveBeenCalledOnce();
      expect(warning.mock.calls[0]?.[0]).toContain(childPath);
      expect(warning.mock.calls[0]?.[0]).toContain("recover child");

      const callsAfterDispose = vi.mocked(cleanupWorktree).mock.calls.length;
      expect(await manager.dispose()).toBe(failures);
      expect(vi.mocked(cleanupWorktree).mock.calls.length).toBe(callsAfterDispose);
    } finally {
      warning.mockRestore();
      rmSync(baseRepo, { recursive: true, force: true });
    }
  });

  it("pins worktrees and quarantines side effects when provider settlement is late", async () => {
    const baseRepo = mkdtempSync(join(tmpdir(), "pi-subagents-dispose-late-"));
    const rootPath = join(baseRepo, "root");
    const childPath = join(rootPath, "child");
    const grandchildPath = join(childPath, "grandchild");
    mkdirSync(grandchildPath, { recursive: true });
    const cleanupOrder: string[] = [];
    const deferred: Array<{ resolve: (result: RunResult) => void; options: RunOptions }> = [];
    const completed = vi.fn();
    const persisted = vi.fn();
    const activity = vi.fn();
    const textDelta = vi.fn();
    const turnEnd = vi.fn();
    const usage = vi.fn();
    const compaction = vi.fn();
    const sessionCreated = vi.fn();

    vi.mocked(createWorktree)
      .mockReturnValueOnce(worktree(rootPath, baseRepo, "root"))
      .mockReturnValueOnce(worktree(childPath, rootPath, "child"))
      .mockReturnValueOnce(worktree(grandchildPath, childPath, "grandchild"));
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) =>
      new Promise<RunResult>((resolve) => {
        deferred.push({ resolve, options });
      }),
    );
    vi.mocked(cleanupWorktree).mockImplementation((_repoRoot, attached) => {
      cleanupOrder.push(attached.path);
      rmSync(attached.path, { recursive: true, force: true });
      return { hasChanges: false, cleanupSucceeded: true };
    });

    try {
      const policy: ManagedSpawnPolicy = { isolation: "worktree" };
      manager = new AgentManager(completed, 1, undefined, undefined, undefined, { append: persisted });
      const rootId = manager.spawnManaged(
        mockPi,
        { cwd: baseRepo } as never,
        {
          requestId: "shutdown-request",
          spawnKey: "shutdown-root",
          type: "R",
          prompt: "root",
          description: "root",
          owner: {
            extension: "pi-workflows",
            runId: "shutdown-run",
            nodeId: "root",
            attemptId: "attempt-1",
          },
        },
        policy,
        {
          onSessionCreated: sessionCreated,
          onToolActivity: activity,
          onTextDelta: textDelta,
          onTurnEnd: turnEnd,
          onAssistantUsage: usage,
          onCompaction: compaction,
        },
      ).id;
      const childId = manager.spawn(mockPi, { cwd: rootPath } as never, "C", "child", {
        description: "child",
        isBackground: true,
        parentAgentId: rootId,
        isolation: "worktree",
      });
      manager.spawn(mockPi, { cwd: childPath } as never, "G", "grandchild", {
        description: "grandchild",
        isBackground: true,
        parentAgentId: childId,
        isolation: "worktree",
      });
      const queuedId = manager.spawn(mockPi, { cwd: baseRepo } as never, "queued", "queued", {
        description: "queued",
        isBackground: true,
      });
      expect(manager.getRecord(queuedId)?.status).toBe("queued");
      expect(deferred).toHaveLength(3);
      const persistedBeforeDispose = persisted.mock.calls.length;

      const failures = await manager.dispose();
      expect(cleanupOrder).toEqual([]);
      expect(failures.map((failure) => failure.path)).toEqual([grandchildPath, childPath, rootPath]);
      expect(failures.every((failure) => failure.reason.includes("provider settlement"))).toBe(true);
      expect(existsSync(grandchildPath)).toBe(true);
      expect(manager.listAgents()).toEqual([]);
      expect(manager.getRecord(rootId)).toBeUndefined();

      for (const { options } of deferred) {
        options.onToolActivity?.({ type: "end", toolName: "late" });
        options.onTextDelta?.("late", "late");
        options.onTurnEnd?.(1);
        options.onAssistantUsage?.({ input: 1, output: 1, cacheWrite: 0 });
        options.onCompaction?.({ reason: "manual", tokensBefore: 1 });
        options.onSessionCreated?.({ dispose: vi.fn() } as never);
        expect(() => options.nestedRuntime?.manager.spawn(
          mockPi,
          { cwd: baseRepo } as never,
          "late",
          "late",
          { description: "late", parentAgentId: rootId },
        )).toThrow("disposed");
      }
      for (const entry of deferred) {
        entry.resolve({ responseText: "late", session: { dispose: vi.fn() } as never, aborted: false, steered: false });
      }
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(cleanupOrder).toEqual([]);
      expect(runAgent).toHaveBeenCalledTimes(3);
      expect(completed).not.toHaveBeenCalled();
      expect(sessionCreated).not.toHaveBeenCalled();
      expect(activity).not.toHaveBeenCalled();
      expect(textDelta).not.toHaveBeenCalled();
      expect(turnEnd).not.toHaveBeenCalled();
      expect(usage).not.toHaveBeenCalled();
      expect(compaction).not.toHaveBeenCalled();
      expect(persisted).toHaveBeenCalledTimes(persistedBeforeDispose);
    } finally {
      rmSync(baseRepo, { recursive: true, force: true });
    }
  });

  it("keeps ordinary disposal behavior unchanged when no worktree is attached", async () => {
    const sessionDispose = vi.fn();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: sessionDispose } as never,
      aborted: false,
      steered: false,
    });
    vi.mocked(cleanupWorktree).mockClear();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, { cwd: "/tmp" } as never, "ordinary", "ordinary", {
      description: "ordinary",
      isBackground: true,
    });
    await manager.getRecordMutable(id)!.promise;
    await manager.dispose();

    expect(sessionDispose).toHaveBeenCalledOnce();
    expect(cleanupWorktree).not.toHaveBeenCalled();
    expect(manager.listAgents()).toEqual([]);
  });

  it("waits for child session shutdown before branch worktree cleanup", async () => {
    const baseRepo = mkdtempSync(join(tmpdir(), "pi-subagents-quiesce-session-"));
    const rootPath = join(baseRepo, "root");
    mkdirSync(rootPath, { recursive: true });
    let releaseShutdown!: () => void;
    let finishProvider!: (result: RunResult) => void;
    let markShutdownStarted!: () => void;
    const shutdownStarted = new Promise<void>((resolve) => { markShutdownStarted = resolve; });
    const shutdownGate = new Promise<void>((resolve) => { releaseShutdown = resolve; });
    const session = {
      extensionRunner: {
        emit: vi.fn(async () => {
          markShutdownStarted();
          await shutdownGate;
        }),
      },
      dispose: vi.fn(),
    };

    vi.mocked(createWorktree).mockReturnValue(worktree(rootPath, baseRepo, "root"));
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options: RunOptions) => {
      options.onSessionCreated?.(session as never);
      return new Promise<RunResult>((resolve) => { finishProvider = resolve; });
    });
    vi.mocked(cleanupWorktree).mockImplementation((_repoRoot, attached) => {
      expect(session.dispose).toHaveBeenCalledOnce();
      rmSync(attached.path, { recursive: true, force: true });
      return { hasChanges: false, cleanupSucceeded: true };
    });

    try {
      manager = new AgentManager();
      const id = manager.spawn(mockPi, { cwd: baseRepo } as never, "root", "root", {
        description: "root",
        isBackground: true,
        isolation: "worktree",
      });

      const quiesced = manager.quiesceAll(25);
      await shutdownStarted;
      expect(cleanupWorktree).not.toHaveBeenCalled();
      releaseShutdown();

      await expect(quiesced).resolves.toMatchObject({ settled: false, pending: [id] });
      expect(cleanupWorktree).not.toHaveBeenCalled();
      expect(existsSync(rootPath)).toBe(true);

      const providerSettled = manager.getRecordMutable(id)?.promise;
      finishProvider({ responseText: "stopped", session: session as never, aborted: true, steered: false });
      await providerSettled;
      expect(cleanupWorktree).toHaveBeenCalledOnce();
      expect(existsSync(rootPath)).toBe(false);
    } finally {
      releaseShutdown();
      rmSync(baseRepo, { recursive: true, force: true });
    }
  });

  it("session_shutdown pins attached worktrees while provider settlement is still pending", async () => {
    const baseRepo = mkdtempSync(join(tmpdir(), "pi-subagents-shutdown-wt-"));
    const rootPath = join(baseRepo, "root");
    mkdirSync(rootPath, { recursive: true });
    const cleanupOrder: string[] = [];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lifecycle = new Map<string, (...args: unknown[]) => unknown>();
    const pi = {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => lifecycle.set(event, handler)),
      events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    };
    const ctx = {
      cwd: baseRepo,
      hasUI: false,
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
      model: undefined,
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
      sessionManager: { getSessionId: vi.fn(() => "shutdown-session"), getBranch: vi.fn(() => []) },
      getSystemPrompt: vi.fn(() => "parent"),
    };
    const managerKey = Symbol.for("pi-subagents:manager");
    const activeKey = Symbol.for("pi-subagents:manager-active");
    const rpcOwnerKey = Symbol.for("pi-subagents:rpc-owner");

    vi.mocked(createWorktree).mockReturnValueOnce(worktree(rootPath, baseRepo, "root"));
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as never);
    vi.mocked(cleanupWorktreeAsync).mockImplementation(async (_repoRoot, attached) => {
      cleanupOrder.push(attached.path);
      rmSync(attached.path, { recursive: true, force: true });
      return { hasChanges: false, cleanupSucceeded: true };
    });

    try {
      delete (globalThis as Record<symbol, unknown>)[managerKey];
      delete (globalThis as Record<symbol, unknown>)[activeKey];
      delete (globalThis as Record<symbol, unknown>)[rpcOwnerKey];
      subagentsExtension(pi as never);
      await lifecycle.get("session_start")?.({}, ctx);
      const rootManager = (globalThis as Record<symbol, unknown>)[managerKey] as Pick<AgentManager, "spawn"> & {
        getRecord: (id: string) => unknown;
      };
      const rootId = rootManager.spawn(pi as never, ctx as never, "R", "root", {
        description: "root",
        isBackground: true,
        isolation: "worktree",
      });

      await lifecycle.get("session_shutdown")?.({}, ctx);

      expect(cleanupOrder).toEqual([]);
      expect(cleanupWorktree).not.toHaveBeenCalled();
      expect(cleanupWorktreeAsync).not.toHaveBeenCalled();
      expect(existsSync(rootPath)).toBe(true);
      expect(rootManager.getRecord(rootId)).toBeUndefined();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("provider settlement"));
    } finally {
      warning.mockRestore();
      delete (globalThis as Record<symbol, unknown>)[managerKey];
      delete (globalThis as Record<symbol, unknown>)[activeKey];
      delete (globalThis as Record<symbol, unknown>)[rpcOwnerKey];
      rmSync(baseRepo, { recursive: true, force: true });
    }
  });
});
