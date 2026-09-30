import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_CAPABILITIES, PROTOCOL_VERSION, routingPolicyFingerprint } from "@signalridge/pi-subagents-protocol";
import { describe, expect, it, vi } from "vitest";
import piWorkflows from "../src/index.js";

class Bus {
  private readonly handlers = new Map<string, Set<(value: unknown) => void>>();

  on(name: string, handler: (value: unknown) => void): () => void {
    const listeners = this.handlers.get(name) ?? new Set();
    listeners.add(handler);
    this.handlers.set(name, listeners);
    return () => listeners.delete(handler);
  }

  emit(name: string, value: unknown): void {
    for (const handler of this.handlers.get(name) ?? []) handler(value);
  }
}

const script = 'export const meta = { name: "journal-branch", description: "test" }; return 1;';
const policy = {
  defaultTier: "default",
  profiles: { default: { model: "inherit" as const, thinking: "medium" as const } },
  blockedProfiles: [],
  blockedDefaultTier: false,
};

function fixture() {
  const session = SessionManager.inMemory();
  const root = session.appendMessage({ role: "user", content: "root", timestamp: 1 });
  const earlier = session.appendMessage({ role: "user", content: "earlier", timestamp: 2 });
  const anchor = session.appendMessage({ role: "user", content: "anchor", timestamp: 3 });
  const bus = new Bus();
  const lifecycle = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  let workflowTool: {
    execute: (
      id: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: undefined,
      ctx: unknown,
    ) => Promise<{ details: { status: string }; content: Array<{ text: string }> }>;
  };
  bus.on("subagents:rpc:context", (raw) => {
    const { requestId } = raw as { requestId: string };
    bus.emit(`subagents:rpc:context:reply:${requestId}`, { success: true, data: { child: false } });
  });
  bus.on("subagents:rpc:ping", (raw) => {
    const { requestId } = raw as { requestId: string };
    bus.emit(`subagents:rpc:ping:reply:${requestId}`, {
      success: true,
      data: {
        version: PROTOCOL_VERSION,
        capabilities: PROTOCOL_CAPABILITIES,
        routingPolicy: { policy, fingerprint: routingPolicyFingerprint(policy) },
      },
    });
  });
  const pi = {
    events: bus,
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => lifecycle.set(name, handler),
    appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
    registerTool: (tool: typeof workflowTool & { name: string }) => {
      if (tool.name === "workflow") workflowTool = tool;
    },
    registerCommand: vi.fn(),
    getCommands: () => [],
    sendMessage: vi.fn(),
  };
  piWorkflows(pi as never);
  const ctx = {
    cwd: process.cwd(),
    mode: "rpc",
    hasUI: false,
    ui: { notify: vi.fn(), setWidget: vi.fn() },
    sessionManager: session,
  };
  return {
    session,
    root,
    earlier,
    anchor,
    start: async () => lifecycle.get("session_start")?.({ type: "session_start" }, ctx),
    shutdown: async () => lifecycle.get("session_shutdown")?.({ type: "session_shutdown" }, ctx),
    run: () => workflowTool.execute("journal-branch", { script, background: false }, undefined, undefined, ctx),
  };
}

describe("workflow journal branch anchor with real Pi SessionManager", () => {
  it("does not traverse the branch when journal appends keep the current leaf", async () => {
    const f = fixture();
    await f.start();
    const getBranch = vi.spyOn(f.session, "getBranch");
    const result = await f.run();
    expect(result.details.status).toBe("completed");
    expect(getBranch).not.toHaveBeenCalled();
    expect(f.session.getEntries().filter((entry) => entry.type === "custom")).toHaveLength(3);
    await f.shutdown();
  });

  it.each(["message", "label", "compaction"])("allows a descendant %s before appending", async (kind) => {
    const f = fixture();
    await f.start();
    if (kind === "message") f.session.appendMessage({ role: "user", content: "next", timestamp: 4 });
    else if (kind === "label") f.session.appendLabelChange(f.anchor, "saved");
    else f.session.appendCompaction("summary", f.anchor, 100);
    const descendant = f.session.getLeafId();
    const getBranch = vi.spyOn(f.session, "getBranch");
    const result = await f.run();
    expect(result.details.status).toBe("completed");
    expect(getBranch).toHaveBeenCalledTimes(1);
    const firstJournalEntry = f.session.getEntries().find((entry) => entry.type === "custom");
    expect(firstJournalEntry?.parentId).toBe(descendant);
    await f.shutdown();
  });

  it("tracks each new journal tip when the host cannot report its leaf", async () => {
    const f = fixture();
    await f.start();
    vi.spyOn(f.session, "getLeafId").mockImplementation(() => undefined as never);
    const getBranch = vi.spyOn(f.session, "getBranch");
    expect((await f.run()).details.status).toBe("completed");
    expect(getBranch).toHaveBeenCalled();
    expect(getBranch.mock.calls.length).toBeGreaterThan(1);
    await f.shutdown();
  });

  it("rejects a second run on an earlier branch when getLeafId is unavailable", async () => {
    const f = fixture();
    vi.spyOn(f.session, "getLeafId").mockImplementation(() => undefined as never);
    await f.start();
    expect((await f.run()).details.status).toBe("completed");
    const oldBranchJournalCount = f.session.getEntries().filter((entry) => entry.type === "custom").length;
    f.session.branch(f.earlier);
    const result = await f.run();
    expect(result.details.status).not.toBe("completed");
    expect(result.content.map((part) => part.text).join(" ")).toContain(
      "workflow journal branch changed before append",
    );
    expect(f.session.getEntries().filter((entry) => entry.type === "custom")).toHaveLength(oldBranchJournalCount);
    await f.shutdown();
  });

  it("keeps the wrong-branch guard when the leaf method is unavailable", async () => {
    const f = fixture();
    await f.start();
    f.session.branch(f.earlier);
    vi.spyOn(f.session, "getLeafId").mockImplementation(() => undefined as never);
    const getBranch = vi.spyOn(f.session, "getBranch");
    const result = await f.run();
    expect(result.content.map((part) => part.text).join(" ")).toContain(
      "workflow journal branch changed before append",
    );
    expect(getBranch).toHaveBeenCalled();
    expect(f.session.getEntries().some((entry) => entry.type === "custom")).toBe(false);
    await f.shutdown();
  });

  it.each(["ancestor", "sibling", "root", "branch-summary sibling"])(
    "rejects a %s leaf that no longer descends from the anchor",
    async (kind) => {
      const f = fixture();
      await f.start();
      if (kind === "ancestor") f.session.branch(f.earlier);
      else if (kind === "sibling") {
        f.session.branch(f.earlier);
        f.session.appendMessage({ role: "user", content: "sibling", timestamp: 4 });
      } else if (kind === "root") f.session.resetLeaf();
      else f.session.branchWithSummary(f.earlier, "summarized abandoned branch");
      const getBranch = vi.spyOn(f.session, "getBranch");
      const result = await f.run();
      expect(result.details.status).not.toBe("completed");
      expect(result.content.map((part) => part.text).join(" ")).toContain(
        "workflow journal branch changed before append",
      );
      expect(getBranch).toHaveBeenCalled();
      expect(f.session.getEntries().some((entry) => entry.type === "custom")).toBe(false);
      await f.shutdown();
    },
  );
});
