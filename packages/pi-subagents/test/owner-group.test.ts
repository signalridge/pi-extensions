import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { borderedComponent } from "@signalridge/pi-ui";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import { FleetList, type FleetUICtx } from "../src/ui/fleet-list.js";
import { OwnerGroupViewer, workflowGroupId } from "../src/ui/owner-group.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const session = { subscribe: () => () => {}, messages: [] } as unknown as AgentSession;
function record(id: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return { id, type: "Explore", description: `child ${id}`, status: "running", startedAt: 1, toolUses: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, compactionCount: 0, session,
    owner: { extension: "pi-workflows", runId: "run", nodeId: id, attemptId: "one" }, ...overrides } as AgentRecord;
}
function tui(rows = 24): TUI {
  return { terminal: { rows, columns: 80 }, requestRender: vi.fn(), getFocusedComponent: () => ({ getText: () => "", setText: () => {} }) } as unknown as TUI;
}

describe("retained workflow children", () => {
  it("propagates initial and changing native focus to its swapped-in conversation", () => {
    const child = { focused: false, render: () => ["conversation"], invalidate() {}, dispose: vi.fn() };
    let back: (() => void) | undefined;
    const viewer = new OwnerGroupViewer(tui(), theme, "run", () => [record("a")], (_record, done) => { back = done; return child; }, vi.fn());
    const framed = borderedComponent(viewer, text => text);
    (framed as typeof framed & { focused: boolean }).focused = true;
    viewer.handleInput("\r");
    expect(child.focused).toBe(true);
    (framed as typeof framed & { focused: boolean }).focused = false;
    expect(child.focused).toBe(false);
    (framed as typeof framed & { focused: boolean }).focused = true;
    expect(child.focused).toBe(true);
    back?.();
    expect(child.dispose).toHaveBeenCalledOnce();
    viewer.dispose();
  });

  it("validates only known owner extension and a nonempty run id", () => {
    for (const owner of [undefined, {}, { extension: "other", runId: "run" }, { extension: "pi-workflows", runId: 12 }, { extension: "pi-workflows", runId: " " }]) {
      expect(workflowGroupId(record("a", { owner: owner as AgentRecord["owner"] }))).toBeUndefined();
    }
    expect(workflowGroupId(record("a"))).toBe(JSON.stringify(["pi-workflows", "run"]));
  });

  it.each([24, 40])("bounds 0/30/1000 retained rows at terminal height %s, including resize and narrow widths", rows => {
    for (const count of [0, 30, 1000]) {
      const records = Array.from({ length: count }, (_, index) => record(String(index)));
      const open = vi.fn(() => ({ render: () => [], invalidate: () => {} }));
      const viewer = new OwnerGroupViewer(tui(rows), theme, "run", () => records, open, vi.fn());
      for (const width of [12, 20, 40, 80]) {
        const framed = borderedComponent(viewer, text => text);
        const lines = framed.render(width);
        expect(lines.length).toBeLessThanOrEqual(Math.floor(rows * 0.7));
        expect(lines.at(-2)).toContain("Esc back");
        expect(lines.at(-2)).toContain(width >= 22 ? "Enter" : "↵");
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      if (count) {
        viewer.handleInput("\x1b[F"); // End reaches the last child in constant navigation steps
        viewer.handleInput("\r");
        expect(open).toHaveBeenCalledWith(records.at(-1), expect.any(Function));
      }
      viewer.dispose();
    }
  });

  it("preserves child selection by id across removals, labels duplicates only, and recovers from sessionless/opener failures", () => {
    const records = [record("a", { description: "same" }), record("b", { description: "same", session: undefined }), record("c")];
    const open = vi.fn(() => { throw new Error("opener"); });
    const viewer = new OwnerGroupViewer(tui(), theme, "run", () => records, open, vi.fn());
    let output = viewer.render(80).join("\n");
    expect(output).toContain("[a]"); expect(output).toContain("[b]"); expect(output).not.toContain("[c]");
    viewer.handleInput("\x1b[B"); // b selected
    records.shift();
    viewer.handleInput("\r");
    expect(open).not.toHaveBeenCalled();
    expect(viewer.render(80).join("\n")).toContain("No session yet");
    records[0].session = session;
    viewer.handleInput("\r");
    expect(open).toHaveBeenCalledWith(records[0], expect.any(Function));
    expect(viewer.render(80).join("\n")).toContain("Cannot open");
    records.splice(0);
    expect(viewer.render(80).join("\n")).toContain("No retained children");
    viewer.dispose();
    viewer.handleInput("\r");
    expect(open).toHaveBeenCalledOnce();
  });

  it("does not open another child when the selected identity disappears just before Enter", () => {
    const records = [record("a"), record("b")];
    const open = vi.fn(() => ({ render: () => [], invalidate: () => {} }));
    const viewer = new OwnerGroupViewer(tui(), theme, "run", () => records, open, vi.fn());
    viewer.render(80);
    records.shift();
    viewer.handleInput("\r");
    expect(open).not.toHaveBeenCalled();
    viewer.handleInput("\x1b[B"); viewer.handleInput("\r");
    expect(open).toHaveBeenCalledWith(records[0], expect.any(Function));
    viewer.dispose();
  });

  it("disposes a nested conversation on back and on disposal, without closing the child on theme invalidation", () => {
    let back: (() => void) | undefined;
    const child = { render: () => ["conversation"], invalidate: vi.fn(), dispose: vi.fn(), handleInput: vi.fn() };
    const viewer = new OwnerGroupViewer(tui(), theme, "run", () => [record("a")], (_, done) => { back = done; return child; }, vi.fn());
    viewer.handleInput("\r");
    viewer.invalidate();
    expect(child.invalidate).toHaveBeenCalledOnce(); expect(child.dispose).not.toHaveBeenCalled();
    viewer.handleInput("x"); expect(child.handleInput).toHaveBeenCalledWith("x");
    back!(); expect(child.dispose).toHaveBeenCalledOnce();
    viewer.handleInput("\r"); viewer.dispose();
    expect(child.dispose).toHaveBeenCalledTimes(2);
  });

  it("keeps Fleet independent and explicitly opens retained children with stale controls fenced on thread reuse and detach", async () => {
    const records = [record("ordinary", { owner: undefined }), record("a"), record("b", { status: "queued", session: undefined }),
      record("c", { owner: { extension: "pi-workflows", runId: "other", nodeId: "c" } }), record("detached", { detached: true })];
    const manager = { listAgentsMutable: () => records, steer: vi.fn(() => true), abort: vi.fn(() => true) } as unknown as AgentManager;
    const host = tui();
    let widget: Component | undefined;
    let overlay: Component | undefined;
    let done: ((result: undefined) => void) | undefined;
    const ui: FleetUICtx = { setWidget: (_, factory) => { widget = factory?.(host, theme); }, onTerminalInput: () => () => {}, getEditorText: () => "", notify: vi.fn(),
      custom: factory => new Promise(resolve => { done = resolve as typeof done; overlay = factory(host, theme, undefined as never, resolve); }) };
    const fleet = new FleetList(manager, new Map());
    fleet.setUICtx(ui); fleet.update();
    const output = widget!.render(120).join("\n");
    expect(output).toContain("child ordinary"); expect(output).not.toContain("Workflow");
    expect(output).not.toContain("child a"); expect(output).not.toContain("detached");
    expect(fleet.retainedWorkflowGroups().find(group => group.runId === "run")?.records).toHaveLength(2);
    fleet.setEnabled(false);
    const opening = fleet.openRetainedWorkflow("run", false);
    expect(overlay!.render(80).join("\n")).toContain("2 retained children");
    overlay!.handleInput!("\r"); // a conversation
    overlay!.handleInput!("\r"); // composer
    for (const char of "draft") overlay!.handleInput!(char);
    records[1] = record("a", { owner: { extension: "pi-workflows", runId: "run", nodeId: "a", attemptId: "two" } });
    overlay!.handleInput!("\r");
    expect(manager.steer).not.toHaveBeenCalled();
    expect(overlay!.render(80).join("\n")).toContain("draft retained");
    fleet.dispose();
    done?.(undefined);
    await opening;
    expect(widget).toBeUndefined();
  });
});
