import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { setAgentTiersSettings } from "../src/agent-tiers.js";
import { registerAgents } from "../src/agent-types.js";
import { AGENT_DEFINITION_GENERATION_OVERRIDE } from "../src/internal-run.js";
import { cleanupWorktree, createWorktree } from "../src/worktree.js";
import { mockParentRegistry } from "./helpers/model-runtime.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(), isWorktreeIsolationEnabled: () => true,
  cleanupWorktree: vi.fn(() => ({ hasChanges: false, cleanupSucceeded: true })),
  cleanupWorktreeAsync: vi.fn(async () => ({ hasChanges: false, cleanupSucceeded: true })),
  pruneWorktrees: vi.fn(), pruneWorktreesAsync: vi.fn(async () => {}),
}));

const pi = {} as ExtensionAPI;
const ctx = { cwd: "/tmp", modelRegistry: mockParentRegistry } as unknown as ExtensionContext;
type Outcome = Awaited<ReturnType<typeof runAgent>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function sessionFixture() {
  return { steer: vi.fn(async () => "queued"), dispose: vi.fn(), messages: [], sessionFile: "/tmp/child-session.jsonl" } as unknown as AgentSession;
}

describe("manager foreground handoff", () => {
  let manager: AgentManager;
  const runs: Array<ReturnType<typeof deferred<Outcome>> & { session: AgentSession }> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    registerAgents(new Map());
    setAgentTiersSettings({});
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      const run = { ...deferred<Outcome>(), session: sessionFixture() };
      runs.push(run);
      await Promise.resolve();
      options.onSessionCreated?.(run.session);
      return run.promise;
    });
    manager = new AgentManager(undefined, 1);
  });

  afterEach(async () => {
    for (const run of runs.splice(0)) run.resolve({ responseText: "done", session: run.session, aborted: false, steered: false });
    await manager.dispose();
    setAgentTiersSettings({});
  });

  async function foreground(options = {}) {
    let id = "";
    const waiter = manager.spawnAndWait(pi, ctx, "Explore", "work", { description: "work", ...options }, value => { id = value; });
    await Promise.resolve();
    return { id, waiter, record: manager.getRecordMutable(id)!, run: runs.at(-1)! };
  }

  function complete(run: typeof runs[number], responseText = "done") {
    run.resolve({ responseText, session: run.session, aborted: false, steered: false });
  }

  it.each([false, true])("releases the original waiter without replacing session, promise, transcript or worktree (async observer=%s)", async asynchronous => {
    const completeObserver = vi.fn();
    const handoffObserver = vi.fn(() => {
      if (asynchronous) return Promise.reject(new Error("observer failed"));
      throw new Error("observer failed");
    });
    await manager.dispose();
    manager = new AgentManager(completeObserver, 1, undefined, undefined, undefined, undefined, handoffObserver);
    vi.mocked(createWorktree).mockReturnValue({ path: "/tmp/fixture", workPath: "/tmp/fixture", repoRoot: "/tmp", branch: "fixture", baseSha: "fixture" });
    const { id, waiter, record, run } = await foreground({ isolation: "worktree", invocation: { runInBackground: false, modelName: "same" } });
    record.outputFile = "/tmp/unchanged.output";
    record.outputCleanup = vi.fn();
    record.toolCallId = "original-call";
    record.resultConsumed = true;
    const originalPromise = record.promise;
    const originalWorktree = record.worktree;
    const originalCleanup = record.outputCleanup;
    expect(manager.canHandoff(id)).toBe(true);
    expect(manager.handoff(id)).toBe(true);
    expect(await waiter).toEqual({ id, record, handedOff: true });
    expect(record).toMatchObject({ status: "running", isBackground: true, resultConsumed: false, toolCallId: "original-call", outputFile: "/tmp/unchanged.output", invocation: { runInBackground: true, modelName: "same" } });
    expect(record.session).toBe(run.session);
    expect(record.promise).toBe(originalPromise);
    expect(record.worktree).toBe(originalWorktree);
    expect(record.outputCleanup).toBe(originalCleanup);
    expect(cleanupWorktree).not.toHaveBeenCalled();
    expect(completeObserver).not.toHaveBeenCalled();
    expect(handoffObserver).toHaveBeenCalledOnce();
    expect(manager.handoff(id)).toBe(false);
    expect(manager.canHandoff(id)).toBe(false);
    complete(run, "final answer");
    await originalPromise;
    expect(record.result).toBe("final answer");
    expect(completeObserver).toHaveBeenCalledExactlyOnceWith(record);
    expect(record.resultConsumed).toBe(false);
    expect(originalCleanup).toHaveBeenCalledOnce();
    expect(cleanupWorktree).toHaveBeenCalledOnce();
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it("removes the original parent's abort listener but explicit child stop still works", async () => {
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const { id, waiter, record, run } = await foreground({ signal: controller.signal });
    expect(manager.handoff(id)).toBe(true);
    await waiter;
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    controller.abort();
    expect(record.status).toBe("running");
    expect(record.abortController?.signal.aborted).toBe(false);
    expect(manager.abort(id)).toBe(true);
    expect(record.abortController?.signal.aborted).toBe(true);
    complete(run);
    await record.promise;
    expect(record.status).toBe("stopped");
  });

  it("manager shutdown still aborts a handed-off child", async () => {
    const { id, waiter, record, run } = await foreground();
    manager.handoff(id);
    await waiter;
    const controller = record.abortController!;
    const shutdown = manager.dispose();
    complete(run);
    await shutdown;
    expect(controller.signal.aborted).toBe(true);
    expect(record.detached).toBe(true);
    expect(manager.canHandoff(id)).toBe(false);
  });

  it("refuses a full pool without releasing the foreground waiter, then accepts once space exists", async () => {
    const backgroundId = manager.spawn(pi, ctx, "Explore", "background", { description: "background", isBackground: true });
    const backgroundRun = runs.at(-1)!;
    const { id, waiter, record, run } = await foreground();
    const settled = vi.fn();
    void waiter.then(settled);
    expect(manager.canHandoff(id)).toBe(false);
    expect(manager.handoffUnavailableReason(id)).toMatch(/Background pool is full \(1\/1\)/);
    expect(manager.handoff(id)).toBe(false);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(record.isBackground).toBe(false);
    complete(backgroundRun);
    await manager.getRecordMutable(backgroundId)!.promise;
    expect(manager.handoff(id)).toBe(true);
    await waiter;
    complete(run);
    await record.promise;
  });

  it.each(["success", "failure", "detached"])("holds and releases exactly one slot on %s, draining queued work once", async outcome => {
    const notifications: string[] = [];
    await manager.dispose();
    manager = new AgentManager(record => { notifications.push(record.id); }, 1);
    const first = await foreground();
    manager.handoff(first.id);
    await first.waiter;
    const second = manager.spawn(pi, ctx, "Explore", "second", { description: "second", isBackground: true });
    expect(manager.getRecord(second)?.status).toBe("queued");
    if (outcome === "failure") first.run.reject(new Error("provider failed"));
    else {
      if (outcome === "detached") first.record.detached = true;
      complete(first.run);
    }
    await first.record.promise;
    expect(manager.getRecord(second)?.status).toBe("running");
    expect(notifications.filter(id => id === first.id)).toHaveLength(outcome === "detached" ? 0 : 1);
    const secondRun = runs.at(-1)!;
    const third = manager.spawn(pi, ctx, "Explore", "third", { description: "third", isBackground: true });
    expect(manager.getRecord(third)?.status).toBe("queued");
    complete(secondRun);
    await manager.getRecordMutable(second)!.promise;
    expect(manager.getRecord(third)?.status).toBe("running");
    complete(runs.at(-1)!);
    await manager.getRecordMutable(third)!.promise;
    const slots = manager as unknown as { heldPoolSlots: Set<string>; runningBackground: number };
    expect(slots.runningBackground).toBe(0);
    expect(slots.heldPoolSlots.size).toBe(0);
  });

  it("late settlement after branch quarantine cannot release a new run's slot", async () => {
    const first = await foreground();
    manager.handoff(first.id);
    await first.waiter;
    manager.detachForBranchChange();
    const second = manager.spawn(pi, ctx, "Explore", "second", { description: "second", isBackground: true });
    const secondRun = runs.at(-1)!;
    complete(first.run);
    await first.record.promise;
    const third = manager.spawn(pi, ctx, "Explore", "third", { description: "third", isBackground: true });
    expect(manager.getRecord(third)?.status).toBe("queued");
    complete(secondRun);
    await manager.getRecordMutable(second)!.promise;
    complete(runs.at(-1)!);
    await manager.getRecordMutable(third)!.promise;
  });

  it("completion wins before a stale handoff attempt and untouched foreground remains consumed", async () => {
    const first = await foreground();
    complete(first.run);
    const result = await first.waiter;
    expect(result.handedOff).toBeUndefined();
    expect(result.record.resultConsumed).toBe(true);
    expect(manager.canHandoff(first.id)).toBe(false);
    expect(manager.handoff(first.id)).toBe(false);
    expect(manager.handoff("missing")).toBe(false);
  });

  it("simultaneous foreground waiters are independent and capacity is not oversubscribed", async () => {
    const first = await foreground();
    const second = await foreground();
    expect(manager.handoff(first.id)).toBe(true);
    expect(manager.handoff(second.id)).toBe(false);
    expect(await first.waiter).toMatchObject({ id: first.id, handedOff: true });
    complete(first.run);
    await first.record.promise;
    expect(manager.handoff(second.id)).toBe(true);
    expect(await second.waiter).toMatchObject({ id: second.id, handedOff: true });
    complete(second.run);
    await second.record.promise;
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it("requires a live session and the original provider promise", async () => {
    let id = "";
    const waiter = manager.spawnAndWait(pi, ctx, "Explore", "work", { description: "work" }, value => { id = value; });
    expect(manager.canHandoff(id)).toBe(false);
    await Promise.resolve();
    const record = manager.getRecordMutable(id)!;
    const originalPromise = record.promise;
    record.promise = Promise.resolve("replacement");
    expect(manager.canHandoff(id)).toBe(false);
    record.promise = originalPromise;
    complete(runs.at(-1)!);
    await waiter;
  });

  it("excludes bare spawn, background, queued, nested, internal and resumed paths and rejects injected reopen paths", async () => {
    const bare = manager.spawn(pi, ctx, "Explore", "bare", { description: "bare", isBackground: false });
    const bg = manager.spawn(pi, ctx, "Explore", "bg", { description: "bg", isBackground: true });
    const queued = manager.spawn(pi, ctx, "Explore", "queued", { description: "queued", isBackground: true });
    const nested = await foreground({ parentAgentId: bare, depth: 2 });
    await expect(manager.spawnAndWait(pi, ctx, "Explore", "work", {
      description: "work", resumeSessionFile: "/tmp/old.jsonl",
    } as Parameters<AgentManager["spawnAndWait"]>[4])).rejects.toThrow(/internal capability/);
    let internalId = "";
    const internalWait = manager.spawnAndWaitInternal(pi, ctx, "Explore", "generate", { description: "generate" }, AGENT_DEFINITION_GENERATION_OVERRIDE, id => { internalId = id; });
    await Promise.resolve();
    for (const id of [bare, bg, queued, nested.id, internalId]) expect(manager.canHandoff(id)).toBe(false);
    for (const run of runs) complete(run);
    await Promise.all([nested.waiter, internalWait, manager.getRecordMutable(bare)!.promise]);
    const resumeGate = deferred<Awaited<ReturnType<typeof resumeAgent>>>();
    vi.mocked(resumeAgent).mockReturnValue(resumeGate.promise);
    const resumed = manager.resume(bare, "again");
    expect(manager.canHandoff(bare)).toBe(false);
    resumeGate.resolve({ text: "resumed" });
    await resumed;
  });

  it("excludes owner-managed workflow agents", async () => {
    await manager.dispose();
    manager = new AgentManager(undefined, 1, undefined, undefined, undefined, { append: () => {} });
    const managed = manager.spawnManaged(pi, ctx, {
      requestId: "request", spawnKey: "key", type: "Explore", prompt: "work", description: "work",
      owner: { extension: "pi-workflows", runId: "run", nodeId: "node", attemptId: "attempt" },
    }, {});
    await Promise.resolve();
    expect(manager.canHandoff(managed.id)).toBe(false);
    complete(runs.at(-1)!);
    await manager.getRecordMutable(managed.id)!.promise;
  });
});
