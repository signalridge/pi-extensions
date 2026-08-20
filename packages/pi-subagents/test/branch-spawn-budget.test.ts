/**
 * branch-spawn-budget.test.ts — the horizontal bound on nested delegation.
 *
 * `maxSubagentDepth` bounds how DEEP nesting goes and says nothing about how
 * WIDE it gets. With nesting on by default (depth 2), a single top-level agent
 * could fan out without limit: its only cost per child is one of its own turns,
 * and max turns is commonly unlimited. This budget is the missing bound.
 */
import { describe, expect, it, vi } from "vitest";
import {
  AgentManager,
  DEFAULT_MAX_SUBAGENT_SPAWNS_PER_BRANCH,
} from "../src/agent-manager.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false, cleanupSucceeded: true })),
  cleanupWorktreeAsync: vi.fn(async () => ({
    hasChanges: false,
    cleanupSucceeded: true,
  })),
  pruneWorktreesAsync: vi.fn(async () => {}),
  pruneWorktrees: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

/** A run that never settles, so parents stay live and spawnable. */
const runHanging = () =>
  vi
    .mocked(runAgent)
    .mockImplementation((async () => new Promise(() => {})) as any);

const spawnTop = (manager: AgentManager) =>
  manager.spawn(mockPi, mockCtx, "general-purpose", "go", {
    description: "d",
    isBackground: true,
  });

const spawnChild = (manager: AgentManager, parentAgentId: string, depth = 2) =>
  manager.spawn(mockPi, mockCtx, "general-purpose", "go", {
    description: "d",
    isBackground: true,
    parentAgentId,
    depth,
  });

describe("branch spawn budget", () => {
  it("defaults to a bound that no ordinary delegation notices", async () => {
    const manager = new AgentManager();
    expect(manager.getMaxSubagentSpawnsPerBranch()).toBe(
      DEFAULT_MAX_SUBAGENT_SPAWNS_PER_BRANCH,
    );
    await manager.dispose();
  });

  it("does not count top-level agents — the budget is per branch, not per session", async () => {
    const manager = new AgentManager();
    manager.setMaxSubagentSpawnsPerBranch(2);
    runHanging();
    // Three top-level agents with a budget of 2: none is anyone's descendant.
    expect(() => {
      spawnTop(manager);
      spawnTop(manager);
      spawnTop(manager);
    }).not.toThrow();
    await manager.dispose();
  });

  it("refuses the spawn that would exceed the branch budget", async () => {
    const manager = new AgentManager();
    manager.setMaxSubagentSpawnsPerBranch(2);
    runHanging();
    const root = spawnTop(manager);

    spawnChild(manager, root);
    spawnChild(manager, root);
    expect(() => spawnChild(manager, root)).toThrow(/spawn budget exhausted/i);
    await manager.dispose();
  });

  it("names the number and the setting, so the message is actionable", async () => {
    const manager = new AgentManager();
    manager.setMaxSubagentSpawnsPerBranch(1);
    runHanging();
    const root = spawnTop(manager);
    spawnChild(manager, root);

    expect(() => spawnChild(manager, root)).toThrow(/1\/1 agents/);
    expect(() => spawnChild(manager, root)).toThrow(
      /maxSubagentSpawnsPerBranch/,
    );
    await manager.dispose();
  });

  it("counts grandchildren against the same top-level root, not their own parent", async () => {
    const manager = new AgentManager();
    manager.setMaxSubagentSpawnsPerBranch(2);
    runHanging();
    const root = spawnTop(manager);
    const child = spawnChild(manager, root);

    // The grandchild's parent is `child`, but the budget belongs to `root` —
    // otherwise every new level would hand the branch a fresh allowance and the
    // bound would mean nothing.
    spawnChild(manager, child, 3);
    expect(() => spawnChild(manager, child, 3)).toThrow(
      /spawn budget exhausted/i,
    );
    expect(manager.getBranchSpawnCount(root)).toBe(2);
    await manager.dispose();
  });

  it("gives each branch its own budget", async () => {
    const manager = new AgentManager();
    manager.setMaxSubagentSpawnsPerBranch(1);
    runHanging();
    const first = spawnTop(manager);
    const second = spawnTop(manager);

    spawnChild(manager, first);
    expect(() => spawnChild(manager, first)).toThrow(/spawn budget exhausted/i);
    // The second branch is untouched by the first's exhaustion.
    expect(() => spawnChild(manager, second)).not.toThrow();
    await manager.dispose();
  });

  // The counter is cumulative for the branch's life, not a concurrency gauge:
  // a loop that starts one child at a time, waits, and repeats forever is
  // exactly the shape a concurrency limit fails to catch.
  it("counts cumulatively, so finished children still consume budget", async () => {
    const manager = new AgentManager();
    manager.setMaxSubagentSpawnsPerBranch(2);
    vi.mocked(runAgent).mockImplementation(
      (async () => new Promise(() => {})) as any,
    );
    const root = spawnTop(manager);

    const first = spawnChild(manager, root);
    manager.abort(first);
    const second = spawnChild(manager, root);
    manager.abort(second);

    expect(() => spawnChild(manager, root)).toThrow(/spawn budget exhausted/i);
    await manager.dispose();
  });

  it("refuses a budget below 1 rather than reading 0 as unlimited", async () => {
    const manager = new AgentManager();
    manager.setMaxSubagentSpawnsPerBranch(8);
    manager.setMaxSubagentSpawnsPerBranch(0);
    expect(manager.getMaxSubagentSpawnsPerBranch()).toBe(8);
    manager.setMaxSubagentSpawnsPerBranch(-1);
    expect(manager.getMaxSubagentSpawnsPerBranch()).toBe(8);
    manager.setMaxSubagentSpawnsPerBranch(1.5);
    expect(manager.getMaxSubagentSpawnsPerBranch()).toBe(8);
    await manager.dispose();
  });

  it("reports zero for a branch that has started nothing", async () => {
    const manager = new AgentManager();
    runHanging();
    expect(manager.getBranchSpawnCount(spawnTop(manager))).toBe(0);
    await manager.dispose();
  });
});
