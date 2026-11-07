import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents, setDefaultsDisabled } from "../src/agent-types.js";
import { mockParentRegistry } from "./helpers/model-runtime.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
const pi = {} as ExtensionAPI;
const ctx = { cwd: "/tmp", modelRegistry: mockParentRegistry } as unknown as ExtensionContext;
const managers: AgentManager[] = [];

beforeEach(() => {
  registerAgents(new Map());
  setDefaultsDisabled(false);
  vi.mocked(runAgent).mockReset().mockResolvedValue({ responseText: "done", session: { dispose: vi.fn() } as never, aborted: false, steered: false });
});
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
});
function create(withChannel = true) {
  const manager = new AgentManager();
  managers.push(manager);
  const factory = vi.fn(() => async () => ({ status: "answered" as const, answer: "Use existing context" }));
  if (withChannel) manager.setParentQuestionFactory(factory);
  return { manager, factory };
}

describe("fixed host-owned question routing", () => {
  it("routes a fresh ordinary background child to the host without a caller mode", async () => {
    const { manager, factory } = create();
    const id = manager.spawn(pi, ctx, "general-purpose", "work", { description: "work", isBackground: true });
    await manager.getRecordMutable(id)!.promise;
    expect(factory).toHaveBeenCalledOnce();
    expect(vi.mocked(runAgent).mock.lastCall?.[3]).toMatchObject({ supervisorQuestions: "parent", parentQuestion: expect.any(Function) });
  });

  it.each(["foreground", "isolated", "setting off", "channel absent", "internal off"])("withholds questions for %s without a human fallback", async (kind) => {
    const { manager, factory } = create(kind !== "channel absent");
    if (kind === "setting off") manager.setSupervisorQuestions(false);
    const id = manager.spawn(pi, ctx, "general-purpose", "work", {
      description: "work", isBackground: kind !== "foreground",
      ...(kind === "isolated" ? { isolated: true } : {}),
      ...(kind === "internal off" ? { supervisorQuestions: false } : {}),
    });
    await manager.getRecordMutable(id)!.promise;
    const options = vi.mocked(runAgent).mock.lastCall?.[3];
    expect(options?.supervisorQuestions).toBe(false);
    expect(options?.parentQuestion).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not give nested children the root answering channel", async () => {
    const { manager, factory } = create();
    const parentId = manager.spawn(pi, ctx, "general-purpose", "parent", { description: "parent", isBackground: true });
    const childId = manager.spawn(pi, ctx, "general-purpose", "child", { description: "child", isBackground: true, parentAgentId: parentId });
    await manager.getRecordMutable(childId)!.promise;
    expect(factory).toHaveBeenCalledOnce();
    const options = vi.mocked(runAgent).mock.lastCall?.[3];
    expect(options?.supervisorQuestions).toBe(false);
    expect(options?.parentQuestion).toBeUndefined();
    await manager.getRecordMutable(parentId)!.promise;
  });
});
