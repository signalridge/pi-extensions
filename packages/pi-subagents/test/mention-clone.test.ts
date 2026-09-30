/**
 * mention-clone.test.ts — the off-screen mention-only turn that starts a
 * mentioned agent.
 *
 * Everything here guards one property: the clone is a throwaway, but the agent
 * it starts must be indistinguishable from one the main model launched. That
 * breaks in quiet ways — a spawn attributed to the fork's session id files its
 * transcript in the wrong place, a tool-call id the real session never issued
 * puts a dangling `<tool-use-id>` in the completion notification. Neither
 * surfaces as an error, so each is pinned below.
 *
 * The other half is the fallback contract: `runMentionClone` never rejects,
 * because the caller starts the agent directly on `spawned: false` and a
 * rejection would instead lose the mention entirely.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted: vi.mock's factory is lifted above the imports, so it cannot close
// over ordinary top-level consts.
const { createAgentSession, inMemory, loaderOptions, loaderReload } = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  inMemory: vi.fn(),
  loaderOptions: vi.fn(),
  loaderReload: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<any>("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    createAgentSession,
    DefaultResourceLoader: class {
      constructor(options: unknown) { loaderOptions(options); }
      reload() { return loaderReload(); }
    },
    SessionManager: { ...actual.SessionManager, inMemory },
  };
});

import { MENTION_SPAWNED, runMentionClone } from "../src/mention-clone.js";

const BRANCH = [{
  type: "message", id: "entry-0", parentId: null,
  message: { role: "user", content: [{ type: "text", text: "PRIVATE_PARENT_SECRET" }] },
}];

beforeEach(() => {
  createAgentSession.mockReset();
  inMemory.mockReset();
  inMemory.mockImplementation(() => ({ getEntries: () => [] }));
  loaderOptions.mockReset();
  loaderReload.mockReset();
});

/** The main session's context — the one the spawn must be attributed to. */
function mainCtx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/repo",
    model: { provider: "custom", id: "main-model" },
    thinkingLevel: "high",
    modelRegistry: { runtime: {
      getAuth: vi.fn(), stream: vi.fn(), streamSimple: vi.fn(), resolveModel: vi.fn(),
      getModel: vi.fn((provider: string, id: string) => provider === "custom" && id === "main-model"
        ? { provider, id } : undefined),
    } },
    getSystemPrompt: vi.fn(() => "the live system prompt"),
    sessionManager: {
      getEntries: vi.fn(() => BRANCH),
      getBranch: vi.fn(() => BRANCH),
      getLeafId: vi.fn(() => "entry-1"),
      getSessionId: vi.fn(() => "session-1"),
    },
    ...overrides,
  } as any;
}

/** The registered Agent tool, whose handler the clone is supposed to reuse. */
function agentTool() {
  return {
    name: "Agent",
    execute: vi.fn(async () => ({
      content: [{ type: "text", text: "Agent ID: a1" }],
      details: { agentId: "a1", status: "background" },
    })),
  } as any;
}

/**
 * Pi's own tool-visibility rule, reproduced from `sdk.js` + `agent-session.js`:
 * an allowlist is derived once (`tools`, or the empty list when `noTools:
 * "all"`), and EVERY tool — built-in, extension and custom alike — is dropped
 * from the registry unless the allowlist names it. So `noTools: "all"` does not
 * mean "no built-ins, keep my custom tool": it means the clone is handed
 * nothing, answers in prose, and the mention falls back to a direct start.
 */
function visibleTools(opts: any): any[] {
  const allowed = opts.tools ?? (opts.noTools === "all" ? [] : undefined);
  const allowedSet = allowed ? new Set<string>(allowed) : undefined;
  const excluded = new Set<string>(opts.excludeTools ?? []);
  return (opts.customTools ?? []).filter(
    (tool: any) => (!allowedSet || allowedSet.has(tool.name)) && !excluded.has(tool.name),
  );
}

/**
 * Stand in for `createAgentSession`. `turn` receives the clone's single custom
 * tool and plays the part of the model deciding what to do with it — and only
 * the tools Pi would really expose reach it, so a clone built with an allowlist
 * that hides its own tool prompts a model with nothing to call.
 */
function cloneSession(turn?: (tool: any) => Promise<void> | void) {
  const session = {
    agent: { state: { systemPrompt: "rebuilt-from-cwd", messages: [] as any[] } },
    prompt: vi.fn(async () => {}),
    dispose: vi.fn(),
  } as any;
  createAgentSession.mockImplementation(async (opts: any) => {
    const tools = visibleTools(opts);
    session.prompt.mockImplementation(async () => {
      // No tool, no tool call: the model can only answer in prose.
      if (tools.length === 0) return;
      await turn?.(tools[0]);
    });
    session.createdWith = opts;
    return { session };
  });
  return session;
}

/** What the model does when it plays along: one Agent call. */
const callsAgent = (params: Record<string, unknown> = { subagent_type: "Explore", prompt: "go" }) =>
  async (tool: any) => {
    await tool.execute("clone-tool-call-1", params, undefined, undefined, {
      cwd: "/fork",
      tools: [tool],
      executeTool: vi.fn(),
    });
  };

const opts = (over: Record<string, unknown> = {}) => ({
  ctx: mainCtx(),
  type: "Explore",
  message: "find the flaky test",
  agentTool: agentTool(),
  isOriginCurrent: () => true,
  ...over,
}) as any;

describe("isolating the mention turn", () => {
  it("starts an empty session and passes the current mention to Agent", async () => {
    const o = opts();
    const session = cloneSession(callsAgent({ subagent_type: "Explore", prompt: "find the flaky test" }));

    expect(await runMentionClone(o)).toEqual({ spawned: true });

    expect(inMemory).toHaveBeenCalledWith("/repo");
    expect(session.createdWith.sessionManager.getEntries()).toEqual([]);
    expect(session.agent.state.messages).toEqual([]);
    expect(session.prompt).toHaveBeenCalledWith("find the flaky test");
    expect(o.agentTool.execute.mock.calls[0][1]).toMatchObject({
      subagent_type: "Explore", prompt: "find the flaky test", run_in_background: true,
    });
    expect(o.ctx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(o.ctx.sessionManager.getEntries).not.toHaveBeenCalled();
  });

  it("delivers the current mention even when the model returns an empty task", async () => {
    const o = opts();
    const session = cloneSession(callsAgent({ subagent_type: "Explore", prompt: "   " }));

    expect(await runMentionClone(o)).toEqual({ spawned: true });
    expect(session.createdWith.sessionManager.getEntries()).toEqual([]);
    expect(o.agentTool.execute.mock.calls[0][1].prompt).toBe("find the flaky test");
  });

  it("thinks at the level the session is really on", async () => {
    cloneSession(callsAgent());

    await runMentionClone(opts());

    expect(createAgentSession.mock.calls[0][0].thinkingLevel).toBe("high");
  });

  it("omits the level when older Pi hosts do not expose it", async () => {
    // Pi <0.82.0 has no ctx.thinkingLevel; session creation resolves settings.
    const o = opts({ ctx: mainCtx({ thinkingLevel: undefined }) });
    cloneSession(callsAgent());

    await runMentionClone(o);

    expect(createAgentSession.mock.calls[0][0]).not.toHaveProperty("thinkingLevel");
  });

  it("delivers a first mention even with no parent history", async () => {
    const o = opts({ ctx: mainCtx({ sessionManager: { getBranch: () => [] } }) });
    const session = cloneSession(callsAgent({ prompt: "find the flaky test" }));

    expect(await runMentionClone(o)).toEqual({ spawned: true });
    expect(session.createdWith.sessionManager.getEntries()).toEqual([]);
    expect(o.agentTool.execute.mock.calls[0][1].prompt).toBe("find the flaky test");
  });

  it("uses a static, narrow prompt and loads no parent extensions or context files", async () => {
    const o = opts();
    const session = cloneSession(callsAgent());

    expect(await runMentionClone(o)).toEqual({ spawned: true });

    expect(session.createdWith.resourceLoader).toBeDefined();
    expect(loaderOptions).toHaveBeenCalledWith(expect.objectContaining({
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      appendSystemPromptOverride: expect.any(Function),
      systemPromptOverride: expect.any(Function),
    }));
    expect(loaderOptions.mock.calls[0][0].systemPromptOverride()).toContain("only the user's current message");
    expect(loaderOptions.mock.calls[0][0].appendSystemPromptOverride()).toEqual([]);
    expect(o.ctx.getSystemPrompt).not.toHaveBeenCalled();
    expect(loaderReload).toHaveBeenCalledOnce();
    expect(session.agent.state.systemPrompt).toBe("rebuilt-from-cwd"); // no unsupported state mutation
  });

  it("inherits the parent's model, thinking level and providers", async () => {
    const o = opts();
    cloneSession(callsAgent());

    await runMentionClone(o);

    const built = createAgentSession.mock.calls[0][0];
    expect(built.model).toEqual({ provider: "custom", id: "main-model" });
    expect(built.thinkingLevel).toBe("high");
    expect(built.modelRuntime).toBe(o.ctx.modelRegistry.runtime);
  });

  it.each(["missing", "incompatible"])("refuses a %s runtime without a hidden provider request", async (condition) => {
    const o = opts();
    if (condition === "missing") delete o.ctx.modelRegistry.runtime;
    else o.ctx.modelRegistry.runtime = { getAuth: vi.fn() };
    const result = await runMentionClone(o);
    expect(result).toMatchObject({ spawned: false, error: expect.stringContaining("parent's model runtime") });
    expect(createAgentSession).not.toHaveBeenCalled();
    expect(loaderReload).not.toHaveBeenCalled();
    expect(o.agentTool.execute).not.toHaveBeenCalled();
  });

  it("gives the clone the Agent tool and nothing else", async () => {
    // It runs where nobody is watching. A full toolset would let an invisible
    // turn read, write or run things on the user's behalf.
    cloneSession(callsAgent());

    await runMentionClone(opts());

    const built = createAgentSession.mock.calls[0][0];
    expect(built.customTools).toHaveLength(1);
    expect(built.customTools[0].name).toBe("Agent");
    expect(visibleTools(built).map((tool: any) => tool.name)).toEqual(["Agent"]);
  });

  it("names its own tool in the allowlist, or Pi hands it nothing", async () => {
    // `noTools: "all"` reads like "no built-ins, keep my custom tool" and is
    // not: it sets an EMPTY allowlist, which strips the custom tool from the
    // registry too (agent-session.js `isAllowedTool`). The clone then has
    // nothing to call, every mention falls through to the direct start, and the
    // user sees "Started @x directly — the conversation clone did not start it"
    // on every single one. Naming the tool is what makes it reachable.
    cloneSession(callsAgent());

    const result = await runMentionClone(opts());

    const built = createAgentSession.mock.calls[0][0];
    expect(built.tools).toEqual(["Agent"]);
    expect(built.noTools).toBeUndefined();
    expect(result).toEqual({ spawned: true });
  });

  it("prompts it with the message alone", async () => {
    const session = cloneSession(callsAgent({ prompt: "find the flaky test" }));

    expect(await runMentionClone(opts())).toEqual({ spawned: true });
    expect(session.prompt).toHaveBeenCalledWith("find the flaky test");
  });
});

describe("attributing the spawn to the real session", () => {
  it("runs the real Agent handler with the MAIN context, not the fork's", async () => {
    // The handler reads cwd, model and sessionManager.getSessionId() off this
    // to place the .output transcript and rootSessionId. The clone's own
    // context would file both under a session that is about to be discarded.
    const tool = agentTool();
    const o = opts({ agentTool: tool });
    cloneSession(callsAgent());

    await runMentionClone(o);

    expect(tool.execute).toHaveBeenCalledTimes(1);
    const invokedCtx = tool.execute.mock.calls[0][4];
    expect(invokedCtx).not.toBe(o.ctx);
    expect(invokedCtx.sessionManager).toBe(o.ctx.sessionManager);
    expect(invokedCtx.modelRegistry).toBe(o.ctx.modelRegistry);
    expect(invokedCtx.model).toBe(o.ctx.model);
    expect(invokedCtx.cwd).toBe(o.ctx.cwd);
    expect(invokedCtx.getSystemPrompt).toBe(o.ctx.getSystemPrompt);
    expect(invokedCtx.tools).toEqual([expect.objectContaining({ name: "Agent" })]);
    expect(invokedCtx.executeTool).toEqual(expect.any(Function));
  });

  it("passes no tool-call id, since the real session issued none", async () => {
    // Left on the record it becomes a <tool-use-id> in the completion
    // notification pointing at a call the main conversation never made.
    const tool = agentTool();
    cloneSession(callsAgent());

    await runMentionClone(opts({ agentTool: tool }));

    expect(tool.execute.mock.calls[0][0]).toBeUndefined();
  });

  it("uses the mentioned type and only the model's prompt, not other hidden choices", async () => {
    const tool = agentTool();
    cloneSession(callsAgent({
      subagent_type: "Plan",
      prompt: "sketch the migration",
      schedule: "every day",
      resume: "another-agent",
      tier: "expensive",
    }));

    await runMentionClone(opts({ agentTool: tool }));

    expect(tool.execute.mock.calls[0][1]).toMatchObject({
      subagent_type: "Explore",
      prompt: "sketch the migration",
      run_in_background: true,
    });
    expect(tool.execute.mock.calls[0][1][MENTION_SPAWNED]).toEqual(expect.any(Function));
  });

  it("forces the spawn into the background — a foreground result goes nowhere", async () => {
    // `run_in_background` defaults to false, and a foreground agent returns its
    // answer as the TOOL RESULT: AgentManager marks the record `resultConsumed`
    // precisely so the completion notification is skipped as redundant. Here
    // that tool result lands in the throwaway clone, which is disposed moments
    // later — so the agent runs to completion, shows up in the widget and the
    // fleet, and its answer reaches nobody. The main conversation is not part
    // of the clone's turn, so background delivery is the only way back.
    const tool = agentTool();
    cloneSession(callsAgent({ subagent_type: "Explore", prompt: "go" }));

    await runMentionClone(opts({ agentTool: tool }));

    expect(tool.execute.mock.calls[0][1]).toMatchObject({ run_in_background: true });
  });

  it("overrides a clone that explicitly asked for a foreground run", async () => {
    // Nothing tells the clone's model that its own turn is discarded, so an
    // explicit `false` is a reasonable thing for it to emit. It must not decide
    // this one.
    const tool = agentTool();
    cloneSession(callsAgent({ subagent_type: "Explore", prompt: "go", run_in_background: false }));

    await runMentionClone(opts({ agentTool: tool }));

    expect(tool.execute.mock.calls[0][1]).toMatchObject({ run_in_background: true });
  });

  it("refuses a second spawn from the same mention", async () => {
    // One handle, one agent. A clone that decides to also launch something else
    // would do it unseen and unasked.
    const tool = agentTool();
    cloneSession(async (t) => {
      await callsAgent()(t);
      await callsAgent()(t);
    });

    const result = await runMentionClone(opts({ agentTool: tool }));

    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ spawned: true });
  });

  it("tells the clone why the second call was refused", async () => {
    const captured: any[] = [];
    cloneSession(async (t) => {
      await callsAgent()(t);
      captured.push(await t.execute("c2", { subagent_type: "Explore", prompt: "again" }, undefined, undefined, {}));
    });

    await runMentionClone(opts());

    expect(captured[0].isError).toBe(true);
    expect(captured[0].content[0].text).toContain("Already attempted an agent");
  });
});

describe("when the clone cannot deliver", () => {
  it("reports a turn that never called the tool", async () => {
    // The model answering in prose is a real outcome, and a silent one — the
    // caller needs it to fall back rather than leave the mention unanswered.
    cloneSession();

    const result = await runMentionClone(opts());

    expect(result.spawned).toBe(false);
    expect(result.error).toContain("did not start it");
  });

  it("reports an Agent policy refusal without authorizing direct fallback", async () => {
    const tool = agentTool();
    tool.execute.mockResolvedValue({ content: [{ type: "text", text: "Model not in scope" }], details: undefined });
    cloneSession(callsAgent({ subagent_type: "Explore", prompt: "go" }));

    const result = await runMentionClone(opts({ agentTool: tool }));

    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ spawned: false, refused: true, error: "the Agent tool refused this mention" });
  });

  it("returns a thrown error rather than rejecting", async () => {
    // The caller's fallback runs off the resolved value. A rejection here would
    // land in an unhandled promise and lose the mention.
    createAgentSession.mockRejectedValue(new Error("no provider configured"));

    await expect(runMentionClone(opts())).resolves.toEqual({
      spawned: false,
      error: "no provider configured",
    });
  });

  it("keeps a spawn that already happened when the turn then fails", async () => {
    // The agent is running. Reporting spawned:false would start a second one.
    cloneSession(async (tool) => {
      await callsAgent()(tool);
      throw new Error("turn aborted");
    });

    const result = await runMentionClone(opts());

    expect(result).toEqual({ spawned: true, error: "turn aborted" });
  });

  it("does not prompt the provider after a switch during resource loading", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let current = true;
    loaderReload.mockReturnValue(waiting);
    const session = cloneSession(callsAgent());
    const tool = agentTool();

    const resultPromise = runMentionClone(opts({ agentTool: tool, isOriginCurrent: () => current }));
    await vi.waitFor(() => expect(loaderReload).toHaveBeenCalledOnce());
    current = false;
    release();

    expect(await resultPromise).toMatchObject({ spawned: false, error: "the original session changed" });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("refuses a hidden Agent call after the originating session changed", async () => {
    let current = true;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const tool = agentTool();
    cloneSession(async (cloneTool) => {
      await waiting;
      await callsAgent()(cloneTool);
    });

    const resultPromise = runMentionClone(opts({ agentTool: tool, isOriginCurrent: () => current }));
    // Let the clone reach its deferred turn before replacing the parent.
    await vi.waitFor(() => expect(createAgentSession).toHaveBeenCalledOnce());
    current = false;
    release();

    expect(await resultPromise).toMatchObject({ spawned: false });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("does not fall back if Agent throws after confirming a background spawn", async () => {
    const tool = agentTool();
    tool.execute.mockImplementation(async (_id: unknown, params: any) => {
      params[MENTION_SPAWNED]("a1");
      throw new Error("fleet update failed");
    });
    cloneSession(callsAgent());

    expect(await runMentionClone(opts({ agentTool: tool }))).toEqual({
      spawned: true,
      error: "fleet update failed",
    });
    expect(tool.execute).toHaveBeenCalledOnce();
  });

  it("permits a direct fallback when Agent throws before confirming a spawn", async () => {
    const tool = agentTool();
    tool.execute.mockRejectedValue(new Error("spawn refused"));
    cloneSession(callsAgent());

    expect(await runMentionClone(opts({ agentTool: tool }))).toEqual({
      spawned: false,
      error: "spawn refused",
    });
  });

  it("disposes the clone even when the turn throws", async () => {
    const session = cloneSession(() => {
      throw new Error("turn aborted");
    });

    await runMentionClone(opts());

    expect(session.dispose).toHaveBeenCalled();
  });
});
