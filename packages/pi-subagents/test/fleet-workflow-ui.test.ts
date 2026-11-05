import type { Component } from "@earendil-works/pi-tui";
import type { EventBus, WorkflowUiRunSummary } from "@signalridge/pi-subagents-protocol";
import { replyChannel, WORKFLOW_UI_CHANNELS } from "@signalridge/pi-subagents-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import { FleetList, type FleetUICtx } from "../src/ui/fleet-list.js";
import { WorkflowUiClient } from "../src/ui/workflow-ui-client.js";

class Bus implements EventBus {
  listeners = new Map<string, Set<(data: unknown) => void>>();
  on(event: string, handler: (data: unknown) => void) {
    const set = this.listeners.get(event) ?? new Set(); set.add(handler); this.listeners.set(event, set);
    return () => { set.delete(handler); if (!set.size) this.listeners.delete(event); };
  }
  emit(event: string, data: unknown) { for (const handler of [...this.listeners.get(event) ?? []]) handler(data); }
}
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
function run(overrides: Partial<WorkflowUiRunSummary> = {}): WorkflowUiRunSummary {
  return { version: 1, surfaceId: "surface", runId: "run", name: "Named workflow", status: "running", currentPhase: "validate",
    callCount: 3, runningCalls: 1, completedCalls: 1, failedCalls: 0, elapsedMs: 3000, tokenCount: 50, restored: false, ...overrides };
}
function publish(bus: Bus, runs = [run()], surfaceId = "surface") { bus.emit(WORKFLOW_UI_CHANNELS.changed, { version: 1, surfaceId, runs }); }
const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); vi.useRealTimers(); });
function client(bus = new Bus(), isCurrent = () => true, retired?: Set<string>) {
  const changed = vi.fn(); const peer = new WorkflowUiClient(bus, isCurrent, changed, retired);
  disposals.push(() => peer.dispose()); return { bus, peer, changed };
}

describe("Fleet workflow metadata peer", () => {
  it("queries once, handles either load order, validates snapshots and does not poll", async () => {
    vi.useFakeTimers();
    const bus = new Bus();
    const query = vi.fn((raw: unknown) => {
      const { requestId } = raw as { requestId: string };
      bus.emit(replyChannel(WORKFLOW_UI_CHANNELS.query, requestId), { success: true, data: { version: 1, surfaceId: "surface", runs: [run()] } });
    });
    bus.on(WORKFLOW_UI_CHANNELS.query, query);
    const { peer } = client(bus); await Promise.resolve();
    expect(peer.runs(new Set())).toEqual([run()]);
    for (const malformed of [null, {}, { version: 1, surfaceId: "surface", runs: [run({ callCount: 0 })] },
      { version: 1, surfaceId: "surface", runs: Array.from({ length: 257 }, (_, i) => run({ runId: String(i) })) }]) bus.emit(WORKFLOW_UI_CHANNELS.changed, malformed);
    expect(peer.runs(new Set())).toEqual([run()]);
    vi.advanceTimersByTime(20_000); expect(query).toHaveBeenCalledOnce();
    const late = client(); publish(late.bus); expect(late.peer.runs(new Set())).toEqual([run()]);
  });

  it("ignores delayed query replies, retired surfaces and branch-inactive publications; cleans every request/listener", async () => {
    vi.useFakeTimers();
    const bus = new Bus(); let requestId = "";
    bus.on(WORKFLOW_UI_CHANNELS.query, raw => { requestId = (raw as { requestId: string }).requestId; });
    let active = true;
    const retired = new Set<string>(); const { peer } = client(bus, () => active, retired);
    publish(bus, [run({ name: "new" })]);
    bus.emit(replyChannel(WORKFLOW_UI_CHANNELS.query, requestId), { success: true, data: { version: 1, surfaceId: "surface", runs: [run({ name: "old" })] } });
    await Promise.resolve(); expect(peer.runs(new Set())[0].name).toBe("new");
    const opening = peer.open(run()); const observed = expect(opening).rejects.toThrow("retired");
    active = false; publish(bus, [run({ name: "late" })]); expect(peer.runs(new Set())).toEqual([]);
    peer.dispose(); await observed;
    expect([...bus.listeners.keys()]).toEqual([WORKFLOW_UI_CHANNELS.query]); expect(vi.getTimerCount()).toBe(0);
    active = true;
    const next = client(bus, () => active, retired); publish(bus); expect(next.peer.runs(new Set())).toEqual([]);
    publish(bus, [run({ surfaceId: "replacement" })], "replacement"); expect(next.peer.runs(new Set())).toHaveLength(1);
  });

  it("keeps childless paused/interrupted workflows available for explicit resume", () => {
    vi.useFakeTimers(); const { bus, peer } = client();
    for (const status of ["paused", "interrupted"] as const) {
      publish(bus, [run({ status })]);
      vi.advanceTimersByTime(20_000);
      expect(peer.runs(new Set())).toHaveLength(1);
      expect(peer.runs(new Set())[0].status).toBe(status);
    }
  });

  it("keeps zero-child finished runs briefly without relingering on repeated same snapshots, and retains child-backed rows", () => {
    vi.useFakeTimers(); const { bus, peer } = client();
    publish(bus, [run({ status: "completed" })]); expect(peer.runs(new Set())).toHaveLength(1);
    vi.advanceTimersByTime(4001); publish(bus, [run({ status: "completed" })]); expect(peer.runs(new Set())).toEqual([]);
    expect(peer.runs(new Set(["run"]))).toHaveLength(1);
    publish(bus, [run({ status: "running" })]); expect(peer.runs(new Set())).toHaveLength(1);
    publish(bus, [run({ status: "stopped" })]); expect(peer.runs(new Set())).toHaveLength(1);
  });

  it("bounds absent peer waits, acknowledges admission without waiting for dialog close, and rejects unsupported replies", async () => {
    vi.useFakeTimers(); const { bus, peer } = client(); publish(bus);
    const absent = expect(peer.open(run())).rejects.toThrow("unavailable"); vi.advanceTimersByTime(2001); await absent;
    const off = bus.on(WORKFLOW_UI_CHANNELS.open, raw => bus.emit(replyChannel(WORKFLOW_UI_CHANNELS.open, (raw as { requestId: string }).requestId), { success: true, data: { accepted: true } }));
    await expect(peer.open(run())).resolves.toBeUndefined(); off();
    bus.on(WORKFLOW_UI_CHANNELS.open, raw => bus.emit(replyChannel(WORKFLOW_UI_CHANNELS.open, (raw as { requestId: string }).requestId), { success: true, data: {} }));
    await expect(peer.open(run())).rejects.toThrow("did not accept");
    peer.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe("independent Fleet and explicit workflow child access", () => {
  it("retires managed-child-only repaint ticks while preserving ordinary agent activity and retained access", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const session = { subscribe: () => () => {}, messages: [] };
    const managed = {
      id: "retained-child", type: "Explore", description: "completed workflow child", status: "completed", session,
      startedAt: 1, completedAt: Date.now(), toolUses: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, compactionCount: 0,
      owner: { extension: "pi-workflows", runId: "retained-run", nodeId: "call-1", attemptId: "attempt-1" },
    } as AgentRecord;
    const records = [managed];
    const listAgentsMutable = vi.fn(() => records);
    const fleet = new FleetList({ listAgentsMutable } as unknown as AgentManager, new Map());
    disposals.push(() => fleet.dispose());
    const requestRender = vi.fn();
    const tui = { terminal: { rows: 24, columns: 120 }, requestRender };
    const setWidget = vi.fn<FleetUICtx["setWidget"]>((_, factory) => { factory?.(tui as never, theme); });
    fleet.setUICtx({ setWidget, getEditorText: () => "", onTerminalInput: () => () => {}, custom: vi.fn(), notify: vi.fn() });

    // A managed spawn may arm the timer, but its first tick must retire it.
    fleet.ensureTimer();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(200);
    expect(vi.getTimerCount()).toBe(0);
    expect(setWidget).not.toHaveBeenCalled();
    expect(requestRender).not.toHaveBeenCalled();
    const idleReads = listAgentsMutable.mock.calls.length;
    vi.advanceTimersByTime(10 * 60_000);
    expect(listAgentsMutable).toHaveBeenCalledTimes(idleReads);
    expect(fleet.retainedWorkflowGroups()[0].records).toEqual([managed]);

    const ordinary = { ...managed, id: "ordinary", owner: undefined, status: "running", completedAt: undefined } as AgentRecord;
    records.push(ordinary);
    fleet.update();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(200);
    expect(requestRender).toHaveBeenCalled();
    ordinary.status = "completed";
    ordinary.completedAt = Date.now();
    fleet.onAgentFinished(ordinary.id);
    vi.advanceTimersByTime(4200);
    expect(vi.getTimerCount()).toBe(0);
    expect(setWidget).toHaveBeenLastCalledWith("fleet", undefined);
    const finalRenders = requestRender.mock.calls.length;
    const finalReads = listAgentsMutable.mock.calls.length;
    vi.advanceTimersByTime(10 * 60_000);
    expect(requestRender).toHaveBeenCalledTimes(finalRenders);
    expect(listAgentsMutable).toHaveBeenCalledTimes(finalReads);
    expect(fleet.retainedWorkflowGroups()[0].records).toEqual([managed]);
  });

  it("never infers workflow status from running children; failed peer open offers an explicit bounded child-only fallback", async () => {
    const bus = new Bus(); const session = { subscribe: () => () => {}, messages: [] };
    const records = Array.from({ length: 30 }, (_, index) => ({ id: String(index), type: "Explore", description: `child ${index}`, status: "running", session,
      startedAt: index, toolUses: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, compactionCount: 0,
      owner: { extension: "pi-workflows", runId: "run", nodeId: `call-${index}`, attemptId: "attempt-1" } } as AgentRecord));
    const manager = { listAgentsMutable: () => records } as unknown as AgentManager;
    const fleet = new FleetList(manager, new Map()); disposals.push(() => fleet.dispose());
    let widget: Component | undefined; let overlay: Component | undefined;
    const tui = { terminal: { rows: 24, columns: 120 }, requestRender: vi.fn() };
    const notify = vi.fn();
    const ui: FleetUICtx = { setWidget: (_, factory) => { widget = factory?.(tui as never, theme); }, getEditorText: () => "", onTerminalInput: () => () => {}, notify,
      custom: factory => new Promise(resolve => { overlay = factory(tui as never, theme, undefined as never, resolve); }) };
    fleet.setUICtx(ui);
    const peer = new WorkflowUiClient(bus, () => true, () => fleet.update()); disposals.push(() => peer.dispose()); fleet.setWorkflowClient(peer);
    publish(bus, [run({ status: "failed" })]);
    expect(widget).toBeUndefined(); // No overview or flattened owned-agent duplicate.
    expect(fleet.handleKey("\x1b[B")).toBeUndefined();
    bus.on(WORKFLOW_UI_CHANNELS.open, raw => bus.emit(replyChannel(WORKFLOW_UI_CHANNELS.open, (raw as { requestId: string }).requestId), { success: false, error: "Unsupported" }));
    const opening = fleet.openRetainedWorkflow("run");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("retained children only"), "warning");
    expect(overlay!.render(80).join("\n")).toContain("30 retained children");
    expect(overlay!.render(80).length).toBeLessThanOrEqual(Math.floor(24 * 0.7));
    fleet.dispose(); await opening;
  });

  it("never mounts zero-child workflow summaries or takes their arrows, regardless of status or Fleet setting", () => {
    vi.useFakeTimers(); const bus = new Bus();
    const manager = { listAgentsMutable: () => [] } as unknown as AgentManager;
    const fleet = new FleetList(manager, new Map()); disposals.push(() => fleet.dispose());
    const setWidget = vi.fn(); const custom = vi.fn();
    fleet.setUICtx({ setWidget, getEditorText: () => "", onTerminalInput: () => () => {}, custom, notify: vi.fn() });
    const peer = new WorkflowUiClient(bus, () => true, () => fleet.update()); disposals.push(() => peer.dispose());
    fleet.setWorkflowClient(peer);
    for (const enabled of [true, false]) {
      fleet.setEnabled(enabled);
      for (const status of ["completed", "failed", "stopped", "stopping", "paused", "interrupted", "running"] as const) {
        publish(bus, [run({ status, callCount: 0, runningCalls: 0, completedCalls: 0 })]);
        expect(fleet.retainedWorkflowGroups()).toEqual([]);
        for (const key of ["\x1b[B", "\x1b[D", "\r"]) expect(fleet.handleKey(key)).toBeUndefined();
      }
    }
    vi.advanceTimersByTime(4201);
    expect(setWidget).not.toHaveBeenCalled(); expect(custom).not.toHaveBeenCalled();
  });

  it("delegates an explicit retained group to the owner even with Fleet disabled, then yields all dialog keys", async () => {
    vi.useFakeTimers(); const bus = new Bus();
    const record = { id: "child", startedAt: 1, owner: { extension: "pi-workflows", runId: "run" } } as AgentRecord;
    const fleet = new FleetList({ listAgentsMutable: () => [record] } as unknown as AgentManager, new Map());
    disposals.push(() => fleet.dispose());
    const custom = vi.fn(); const setWidget = vi.fn();
    fleet.setUICtx({ setWidget, getEditorText: () => "", onTerminalInput: () => () => {}, custom, notify: vi.fn() });
    const peer = new WorkflowUiClient(bus, () => true, () => fleet.update()); disposals.push(() => peer.dispose());
    fleet.setWorkflowClient(peer); publish(bus);
    const opened = vi.fn((raw: unknown) => {
      const request = raw as { requestId: string; runId: string; surfaceId: string };
      expect(request).toMatchObject({ runId: "run", surfaceId: "surface" });
      bus.emit(replyChannel(WORKFLOW_UI_CHANNELS.open, request.requestId), { success: true, data: { accepted: true } });
    });
    bus.on(WORKFLOW_UI_CHANNELS.open, opened);
    fleet.setEnabled(false);
    await fleet.openRetainedWorkflow("run");
    vi.advanceTimersByTime(1);
    for (const key of ["\x1b[B", "\r", "\x02", "\x1b"]) expect(fleet.handleKey(key)).toBeUndefined();
    expect(opened).toHaveBeenCalledOnce(); expect(custom).not.toHaveBeenCalled(); expect(setWidget).not.toHaveBeenCalled();
  });
});
