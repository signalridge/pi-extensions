/**
 * manager-registry-guard.test.ts — the Symbol.for("pi-subagents:manager")
 * global registry across multiple activations in one process.
 *
 * Subagent sessions re-activate this extension in the same process
 * (session.bindExtensions in agent-runner.ts). The old code let every
 * activation overwrite the global slot — pointing cross-package consumers at
 * a short-lived child manager — and every child's session_shutdown DELETED
 * the slot, so the root session's entry was lost as soon as any subagent ran.
 *
 * The fix: the first activation claims the slot, later activations leave it
 * alone, and only the owner's shutdown releases it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

const TAKEOVER_LOCK_KEY = Symbol.for("pi-subagents:manager-takeover-lock");

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx(sessionId = "s1") {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => sessionId), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

async function spawnBackground(tools: Map<string, any>): Promise<string> {
  vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any); // never resolves
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "registry test agent", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

// Restore the global slot around every test.
const priorGlobal = (globalThis as any)[MANAGER_KEY];
afterEach(() => {
  if (priorGlobal === undefined) delete (globalThis as any)[MANAGER_KEY];
  else (globalThis as any)[MANAGER_KEY] = priorGlobal;
  delete (globalThis as any)[Symbol.for("pi-subagents:rpc-owner")];
  delete (globalThis as any)[Symbol.for("pi-subagents:manager-active")];

  delete (globalThis as any)[TAKEOVER_LOCK_KEY];
  vi.mocked(runAgent).mockReset();
});

describe("Symbol.for manager registry across activations", () => {
  it("child activation does not overwrite the root entry; child shutdown does not delete it", async () => {
    delete (globalThis as any)[MANAGER_KEY];

    // Root session activates first and owns the registry.
    const root = makePi();
    subagentsExtension(root.pi);
    await root.lifecycle.get("session_start")?.({}, ctx());
    const rootEntry = (globalThis as any)[MANAGER_KEY];
    expect(rootEntry).toBeDefined();

    // Spawn a background agent through the ROOT so its record is findable.
    const id = await spawnBackground(root.tools);
    expect(rootEntry.getRecord(id)).toBeDefined();

    // A child agent session re-activates the extension in-process.
    const child = makePi();
    subagentsExtension(child.pi);
    await child.lifecycle.get("session_start")?.({}, ctx("child-s1"));

    // Registry still points at the root's entry (child did not clobber it) …
    expect((globalThis as any)[MANAGER_KEY]).toBe(rootEntry);
    expect((globalThis as any)[MANAGER_KEY].getRecord(id)).toBeDefined();

    // … and the child's shutdown does not delete the root's entry.
    await child.lifecycle.get("session_shutdown")?.();
    expect((globalThis as any)[MANAGER_KEY]).toBe(rootEntry);

    // The root's own shutdown releases the slot.
    await root.lifecycle.get("session_shutdown")?.();
    expect((globalThis as any)[MANAGER_KEY]).toBeUndefined();
  });

  it("a bound root replaces a filtered factory's stale manager entry", async () => {
    delete (globalThis as any)[MANAGER_KEY];
    delete (globalThis as any)[Symbol.for("pi-subagents:rpc-owner")];
    delete (globalThis as any)[Symbol.for("pi-subagents:manager-active")];

    const filtered = makePi();
    subagentsExtension(filtered.pi);
    const staleEntry = (globalThis as any)[MANAGER_KEY];

    const active = makePi();
    subagentsExtension(active.pi);
    await active.lifecycle.get("session_start")?.({}, ctx());

    expect((globalThis as any)[MANAGER_KEY]).toBeDefined();
    expect((globalThis as any)[MANAGER_KEY]).not.toBe(staleEntry);
    expect((globalThis as any)[Symbol.for("pi-subagents:rpc-owner")]).toBe((globalThis as any)[MANAGER_KEY]);

    await active.lifecycle.get("session_shutdown")?.();
  });


  it("a same-session activation retires and replaces a stale bound registry owner", async () => {
    delete (globalThis as any)[MANAGER_KEY];
    delete (globalThis as any)[Symbol.for("pi-subagents:rpc-owner")];
    delete (globalThis as any)[Symbol.for("pi-subagents:manager-active")];

    const stale = makePi();
    subagentsExtension(stale.pi);
    await stale.lifecycle.get("session_start")?.({}, ctx("reload-s1"));
    const staleEntry = (globalThis as any)[MANAGER_KEY];

    const replacement = makePi();
    subagentsExtension(replacement.pi);
    await replacement.lifecycle.get("session_start")?.({ reason: "reload" }, ctx("reload-s1"));
    const replacementEntry = (globalThis as any)[MANAGER_KEY];

    expect(replacementEntry).toBeDefined();
    expect(replacementEntry).not.toBe(staleEntry);
    expect((globalThis as any)[Symbol.for("pi-subagents:rpc-owner")]).toBe(replacementEntry);
    expect((globalThis as any)[Symbol.for("pi-subagents:manager-active")]).toBe(replacementEntry);

    // A delayed old shutdown is idempotent and cannot delete the replacement.
    await stale.lifecycle.get("session_shutdown")?.();
    expect((globalThis as any)[MANAGER_KEY]).toBe(replacementEntry);
    await replacement.lifecycle.get("session_shutdown")?.();
    expect((globalThis as any)[MANAGER_KEY]).toBeUndefined();
  });


  it("serializes overlapping same-session reload takeovers", async () => {
    delete (globalThis as any)[MANAGER_KEY];
    delete (globalThis as any)[Symbol.for("pi-subagents:rpc-owner")];
    delete (globalThis as any)[Symbol.for("pi-subagents:manager-active")];
    delete (globalThis as any)[TAKEOVER_LOCK_KEY];

    const stale = makePi();
    subagentsExtension(stale.pi);
    await stale.lifecycle.get("session_start")?.({}, ctx("reload-race"));

    const replacementA = makePi();
    const replacementB = makePi();
    subagentsExtension(replacementA.pi);
    subagentsExtension(replacementB.pi);

    const startA = replacementA.lifecycle.get("session_start")?.({ reason: "reload" }, ctx("reload-race"));
    const startB = replacementB.lifecycle.get("session_start")?.({ reason: "reload" }, ctx("reload-race"));
    await Promise.all([startA, startB]);
    const finalEntry = (globalThis as any)[MANAGER_KEY];

    expect(finalEntry).toBeDefined();
    expect((globalThis as any)[Symbol.for("pi-subagents:rpc-owner")]).toBe(finalEntry);
    expect((globalThis as any)[Symbol.for("pi-subagents:manager-active")]).toBe(finalEntry);
    expect((globalThis as any)[TAKEOVER_LOCK_KEY]).toBeUndefined();

    // The first replacement was retired by the serialized second handoff; its
    // delayed shutdown cannot remove the final owner.
    await replacementA.lifecycle.get("session_shutdown")?.();
    await stale.lifecycle.get("session_shutdown")?.();
    expect((globalThis as any)[MANAGER_KEY]).toBe(finalEntry);
    await replacementB.lifecycle.get("session_shutdown")?.();
    expect((globalThis as any)[MANAGER_KEY]).toBeUndefined();
  });


  it("returns immutable public records and keeps ordinary lifecycle ownership unchanged", async () => {
    delete (globalThis as any)[MANAGER_KEY];
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "ordinary result",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const root = makePi();
    subagentsExtension(root.pi);
    await root.lifecycle.get("session_start")?.({}, ctx());
    const rootEntry = (globalThis as any)[MANAGER_KEY];

    const aliasedDescription = { label: "before" };
    expect(() => rootEntry.spawn(root.pi, ctx(), "general-purpose", "go", {
      description: aliasedDescription,
      isBackground: true,
    })).toThrow(/description must be a string/);
    aliasedDescription.label = "after";


    const aliasedBackground = { changed: false };
    expect(() => rootEntry.spawn(root.pi, ctx(), "general-purpose", "go", {
      description: "invalid background",
      isBackground: aliasedBackground,
    })).toThrow(/isBackground must be a boolean/);
    aliasedBackground.changed = true;
    expect(runAgent).not.toHaveBeenCalled();


    const nestedInvocationAlias = { changed: false };
    const hostileArray = [nestedInvocationAlias] as typeof nestedInvocationAlias[] & { map: () => unknown };
    hostileArray.map = () => hostileArray;

    const speciesAlias = { changed: false };
    const speciesOutput: unknown[] = [];
    Object.defineProperty(speciesOutput, "hidden", { value: speciesAlias });
    Object.defineProperty(hostileArray, "constructor", {
      value: { [Symbol.species]: function hostileSpecies() { return speciesOutput; } },
    });
    const invocationAlias = { modelName: { changed: false, nested: hostileArray } };
    const aliasId = rootEntry.spawn(root.pi, ctx(), "general-purpose", "go", {
      description: "alias probe",
      invocation: invocationAlias,
      isBackground: true,
    });
    nestedInvocationAlias.changed = true;

    speciesAlias.changed = true;
    const aliasSnapshot = rootEntry.getRecord(aliasId);
    expect(Object.isFrozen(aliasSnapshot.invocation)).toBe(true);
    expect(Object.isFrozen((aliasSnapshot.invocation as any).modelName)).toBe(true);
    expect((aliasSnapshot.invocation as any).modelName.nested[0].changed).toBe(false);

    expect((aliasSnapshot.invocation as any).modelName.nested.hidden).toBeUndefined();
    try {
      (aliasSnapshot.invocation as any).modelName.changed = true;
    } catch {
      // Deep-frozen inert metadata rejects mutation in strict mode.
    }
    expect(invocationAlias.modelName.changed).toBe(false);
    expect((rootEntry.getRecord(aliasId).invocation as any).modelName.changed).toBe(false);

    expect((rootEntry.getRecord(aliasId).invocation as any).modelName.nested[0].changed).toBe(false);
    const result = await root.tools.get("Agent").execute(
      "tc-public-record",
      { prompt: "go", description: "ordinary lifecycle", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    const id = /Agent ID: (\S+)/.exec(textOf(result))?.[1];
    if (!id) throw new Error("background spawn did not return an id");

    const exposed = rootEntry.getRecord(id);
    if (!exposed) throw new Error("public registry did not return the record");
    expect(Object.isFrozen(exposed)).toBe(true);
    try {
      (exposed as any).owner = { extension: "pi-workflows", runId: "forged", nodeId: "a" };
    } catch {
      // Frozen snapshots may reject mutation in strict mode.
    }
    expect(rootEntry.getRecord(id)?.owner).toBeUndefined();

    expect(Object.isFrozen(exposed.lifetimeUsage)).toBe(true);
    try {
      (exposed.lifetimeUsage as any).input = 999;
    } catch {
      // Frozen nested snapshots may reject mutation in strict mode.
    }
    expect(rootEntry.getRecord(id)?.lifetimeUsage.input).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(rootEntry.getRecord(id)).not.toHaveProperty("session");

    expect(rootEntry.getRecord(id)).not.toHaveProperty("promise");
    const completed = root.pi.events.emit.mock.calls.find(([event]: [string]) => event === "subagents:completed");
    expect(completed?.[1]).not.toHaveProperty("owner");
    expect(root.pi.sendMessage).toHaveBeenCalled();
    await root.lifecycle.get("session_shutdown")?.();
  });
});
