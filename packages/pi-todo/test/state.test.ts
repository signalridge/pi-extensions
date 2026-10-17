import { randomUUID } from "node:crypto";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { copy, empty, MAX_BYTES, STATE_TYPE, transition, validateSnapshot } from "../src/state.js";
import { recover, TodoStore } from "../src/store.js";

const add = (state = empty(), title = "Task", dependencies: string[] = []) =>
  transition(state, { action: "add", baseRevision: state.revision, title, dependencies });
function fixture() {
  const manager = SessionManager.inMemory();
  const ctx = { sessionManager: manager } as unknown as ExtensionContext;
  const append = vi.fn((type: string, data: unknown) => {
    manager.appendCustomEntry(type, data);
  });
  const store = new TodoStore({ appendEntry: append });
  store.reconcile(ctx);
  return { manager, ctx, append, store };
}

describe("bounded immutable checklist graph", () => {
  it("requires revisions on every mutation, only meaningful changes advance, and list is read-only", () => {
    const initial = empty();
    expect(transition(initial, { action: "list" })).toBe(initial);
    expect(transition(initial, { action: "clear", baseRevision: 0 })).toBe(initial);
    for (const action of ["add", "update", "remove", "clear"])
      for (const baseRevision of [undefined, -1, 0.5, "0", Infinity, Number.MAX_SAFE_INTEGER + 1])
        expect(() => transition(initial, { action, baseRevision })).toThrow();
    const first = add(initial);
    expect(first.revision).toBe(1);
    expect(() => transition(first, { action: "clear", baseRevision: 0 })).toThrow("Stale");
    expect(
      transition(first, { action: "update", baseRevision: 1, updates: [{ id: first.tasks[0].id, title: "Task" }] }),
    ).toBe(first);
    expect(Object.isFrozen(first.tasks[0].dependencies)).toBe(true);
    const detached = copy(first);
    detached.tasks[0].title = "alias";
    detached.tasks[0].dependencies.push(randomUUID());
    expect(first.tasks[0].title).toBe("Task");
    expect(first.tasks[0].dependencies).toEqual([]);
    expect(initial.tasks).toEqual([]);
  });
  it("rejects missing, self, duplicate and cyclic dependencies; validates a full atomic next graph", () => {
    let state = add();
    const a = state.tasks[0].id;
    state = add(state, "B", [a]);
    const b = state.tasks[1].id;
    for (const dependencies of [[randomUUID()], [a], [b, b], [b]]) {
      expect(() =>
        transition(state, { action: "update", baseRevision: state.revision, updates: [{ id: a, dependencies }] }),
      ).toThrow();
    }
    expect(() => transition(state, { action: "remove", baseRevision: state.revision, id: a })).toThrow("dependency");
    expect(() =>
      transition(state, {
        action: "update",
        baseRevision: state.revision,
        updates: [{ id: b, status: "in_progress" }],
      }),
    ).toThrow("prerequisites");
    const complete = transition(state, {
      action: "update",
      baseRevision: state.revision,
      updates: [
        { id: a, status: "completed" },
        { id: b, status: "completed" },
      ],
    });
    expect(complete.tasks.every((task) => task.status === "completed")).toBe(true);
    expect(() =>
      transition(complete, {
        action: "update",
        baseRevision: complete.revision,
        updates: [{ id: a, status: "pending" }],
      }),
    ).toThrow("prerequisites");
    const reopened = transition(complete, {
      action: "update",
      baseRevision: complete.revision,
      updates: [
        { id: a, status: "pending" },
        { id: b, status: "pending" },
      ],
    });
    expect(reopened.tasks.every((task) => task.status === "pending")).toBe(true);
    const detached = transition(complete, {
      action: "update",
      baseRevision: complete.revision,
      updates: [
        { id: a, status: "pending" },
        { id: b, dependencies: [] },
      ],
    });
    expect(detached.tasks[1].status).toBe("completed");
  });
  it("bounds Unicode code points, dependency counts, tasks and actual serialized UTF-8 bytes", () => {
    expect(add(empty(), "😀".repeat(160)).tasks[0].title).toHaveLength(320);
    expect(() => add(empty(), "😀".repeat(161))).toThrow();
    expect(() => add(empty(), " ")).toThrow();
    let state = empty();
    for (let n = 0; n < 40; n++) state = add(state);
    expect(() => add(state)).toThrow("40");
    expect(() =>
      transition(state, {
        action: "update",
        baseRevision: state.revision,
        updates: [{ id: state.tasks[0].id, description: "x".repeat(513) }],
      }),
    ).toThrow();
    expect(() =>
      transition(state, {
        action: "update",
        baseRevision: state.revision,
        updates: [{ id: state.tasks[0].id, dependencies: state.tasks.slice(1, 18).map((task) => task.id) }],
      }),
    ).toThrow("16");
    const wide = copy(state);
    for (const task of wide.tasks) {
      task.title = "😀".repeat(160);
      task.description = "😀".repeat(512);
    }
    expect(JSON.stringify(wide).length).toBeLessThan(MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(wide))).toBeGreaterThan(MAX_BYTES);
    expect(() => validateSnapshot(wide)).toThrow("UTF-8");
  });
  it("uses fresh opaque UUIDs after clear and rejects unknown fields, malformed snapshots and duplicate patches", () => {
    const first = add();
    const cleared = transition(first, { action: "clear", baseRevision: 1 });
    const second = add(cleared);
    expect(second.tasks[0].id).not.toBe(first.tasks[0].id);
    expect(second.tasks[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => transition(first, { action: "list", tasks: [] })).toThrow("Unknown");
    expect(() =>
      transition(first, {
        action: "update",
        baseRevision: 1,
        updates: [{ id: first.tasks[0].id }, { id: first.tasks[0].id }],
      }),
    ).toThrow("duplicate");
    for (const data of [
      null,
      { schemaVersion: 2, revision: 0, tasks: [] },
      { ...first, revision: -1 },
      { ...first, tasks: [...first.tasks, ...first.tasks] },
      { ...first, unexpected: true },
    ])
      expect(() => validateSnapshot(data)).toThrow();
  });
});

describe("durable branch-owned store", () => {
  it("appends before reporting, deep copies entries/results, and preserves state on failed append", () => {
    const f = fixture();
    f.append.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => f.store.mutate(f.ctx, { action: "add", baseRevision: 0, title: "A" })).toThrow("disk full");
    expect(f.store.read(f.ctx)).toEqual(empty());
    const result = f.store.mutate(f.ctx, { action: "add", baseRevision: 0, title: "A" });
    expect(f.append).toHaveBeenCalledWith(STATE_TYPE, result);
    result.tasks[0].title = "bad";
    expect(f.store.read(f.ctx).tasks[0].title).toBe("A");
    const entry = f.manager.getBranch().at(-1);
    if (entry?.type !== "custom") throw new Error("Missing state entry");
    (entry.data as typeof result).tasks[0].title = "tamper";
    expect(() => f.store.read(f.ctx)).toThrow("ownership");
  });
  it("recovers only latest validated branch entries, including authoritative empty state; never tool results", () => {
    const f = fixture();
    const first = f.store.mutate(f.ctx, { action: "add", baseRevision: 0, title: "A" });
    const root = f.manager.getLeafId();
    f.store.mutate(f.ctx, { action: "clear", baseRevision: 1 });
    f.store.reconcile(f.ctx);
    expect(f.store.read(f.ctx).tasks).toEqual([]);
    f.manager.appendCustomEntry(STATE_TYPE, { schemaVersion: 99 });
    expect(f.store.reconcile(f.ctx)).toBe(1);
    expect(f.store.read(f.ctx).tasks).toEqual([]);
    if (!root) throw new Error("missing root");
    f.manager.branch(root);
    f.store.reconcile(f.ctx);
    expect(f.store.read(f.ctx)).toEqual(first);
    f.manager.resetLeaf();
    f.manager.appendMessage({
      role: "toolResult",
      toolCallId: "old",
      toolName: "todo",
      content: [],
      details: first,
      isError: false,
      timestamp: 1,
    });
    expect(recover(f.manager.getBranch()).snapshot).toEqual(empty());
    expect(f.manager.getEntries().length).toBeGreaterThan(f.manager.getBranch().length);
  });
  it("labels memory sessions as volatile and fingerprints the full ordinary native prefix", () => {
    const f = fixture();
    expect(f.store.persistenceStatus).toBe("in-memory, not persistent after process exit");
    f.manager.appendMessage({ role: "user", content: "Original message", timestamp: 1 });
    f.store.reconcile(f.ctx);
    f.store.mutate(f.ctx, { action: "add", baseRevision: 0, title: "A" });
    const message = f.manager.getBranch()[0];
    if (message.type !== "message" || message.message.role !== "user") throw new Error("Missing user entry");
    message.message.content = "Same ID, altered native data";
    expect(() => f.store.read(f.ctx)).toThrow("ownership");
  });
  it("rejects rollback before reconciliation, stale callbacks, manager replacement, authoritative data changes and nested commit reentry", () => {
    const f = fixture();
    const lease = f.store.lease(f.ctx);
    f.store.mutate(f.ctx, { action: "add", baseRevision: 0, title: "A" }, lease);
    expect(() => f.store.mutate(f.ctx, { action: "clear", baseRevision: 0 }, lease)).toThrow("ownership");
    f.manager.resetLeaf();
    expect(() => f.store.mutate(f.ctx, { action: "add", baseRevision: 1, title: "Wrong branch" })).toThrow("ownership");
    f.store.reconcile(f.ctx);
    const destination = f.store.lease(f.ctx);
    f.store.reconcile(f.ctx);
    expect(() => f.store.assert(f.ctx, destination)).toThrow("ownership");
    expect(() => f.store.read({ sessionManager: SessionManager.inMemory() } as unknown as ExtensionContext)).toThrow(
      "ownership",
    );
    f.append.mockImplementationOnce((type, data) => {
      expect(() => f.store.mutate(f.ctx, { action: "add", baseRevision: 0, title: "Nested" })).toThrow("progress");
      f.manager.appendCustomEntry(type, data);
    });
    expect(f.store.mutate(f.ctx, { action: "add", baseRevision: 0, title: "Outer" }).tasks).toHaveLength(1);
    f.store.retire();
    expect(() => f.store.read(f.ctx)).toThrow("ownership");
  });
});
