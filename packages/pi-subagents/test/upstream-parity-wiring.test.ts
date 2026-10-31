import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { type RunOptions, type RunResult, resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { AGENT_DEFINITION_GENERATION_OVERRIDE, INTERNAL_AGENT_CONFIG_OVERRIDE } from "../src/internal-run.js";
import type { AgentRecordSnapshot, NotificationDetails } from "../src/types.js";
import { createWorktree } from "../src/worktree.js";
import { mockParentRegistry } from "./helpers/model-runtime.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});
vi.mock("../src/worktree.js", async () => {
  const actual = await vi.importActual<typeof import("../src/worktree.js")>("../src/worktree.js");
  return { ...actual, createWorktree: vi.fn(), cleanupWorktree: vi.fn(() => ({ hasChanges: false, cleanupSucceeded: true })),
    cleanupWorktreeAsync: vi.fn(async () => ({ hasChanges: false, cleanupSucceeded: true })), pruneWorktrees: vi.fn(), pruneWorktreesAsync: vi.fn() };
});

type Handler = (...args: unknown[]) => unknown;
interface Registry {
  spawn: AgentManager["spawn"];
  waitForAll: () => Promise<void>;
  getRecord: (id: string) => AgentRecordSnapshot | undefined;
}

function activation(cwd: string, joinMode = "async", maxConcurrent = 1) {
  writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({
    schedulingEnabled: false, outputTranscript: false, rememberAgents: false,
    defaultJoinMode: joinMode, maxConcurrent,
  }));
  const lifecycle = new Map<string, Handler>();
  const tools = new Map<string, ToolDefinition>();
  const bus = new Map<string, Set<(data: unknown) => unknown>>();
  const events = {
    on: (name: string, handler: (data: unknown) => unknown) => {
      const handlers = bus.get(name) ?? new Set();
      handlers.add(handler);
      bus.set(name, handlers);
      return () => handlers.delete(handler);
    },
    emit: (name: string, data: unknown) => {
      for (const handler of bus.get(name) ?? []) void handler(data);
    },
  };
  const sendMessage = vi.fn();
  const pi = {
    events, sendMessage, appendEntry: vi.fn(), registerMessageRenderer: vi.fn(), registerCommand: vi.fn(),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    on: (name: string, handler: Handler) => lifecycle.set(name, handler),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd, isProjectTrusted: () => true, hasUI: false, mode: "rpc",
    ui: { notify: vi.fn(), setWidget: vi.fn(), setStatus: vi.fn() },
    modelRegistry: { ...mockParentRegistry, getAvailable: () => [], find: () => undefined },
    sessionManager: { getSessionId: () => "parity-session", getBranch: () => [] },
    getSystemPrompt: () => "parent",
  } as unknown as ExtensionContext;
  subagentsExtension(pi);
  const call = (name: string, args: Record<string, unknown>, toolCallId = name) =>
    tools.get(name)!.execute(toolCallId, args, undefined, undefined, ctx);
  return { pi, ctx, lifecycle, events, sendMessage, call,
    registry: () => Reflect.get(globalThis, Symbol.for("pi-subagents:manager")) as Registry };
}

describe("selective upstream parity through production dispatch", () => {
  let cwd: string;
  let previousAgentDir: string | undefined;
  let active: ReturnType<typeof activation> | undefined;
  const pending: Array<{ options: RunOptions; finish: (result: RunResult) => void; session: AgentSession }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    cwd = mkdtempSync(join(tmpdir(), "subagents-parity-wiring-"));
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    mkdirSync(join(cwd, "global"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(cwd, "global");
    pending.length = 0;
    vi.mocked(createWorktree).mockReset().mockImplementation((_base, id) => ({
      path: cwd, workPath: cwd, branch: `fixture-${id}`, baseSha: "fixture", repoRoot: cwd,
    }));
    vi.mocked(runAgent).mockReset().mockImplementation((_ctx, _type, _prompt, options) => {
      const session = { messages: [], subscribe: () => () => {}, dispose: vi.fn() } as unknown as AgentSession;
      options.onSessionCreated?.(session);
      return new Promise<RunResult>(finish => pending.push({ options, finish, session }));
    });
    vi.mocked(resumeAgent).mockReset().mockImplementation(async () => ({ text: "RESUMED", aborted: false, steered: false }));
  });

  afterEach(async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "cleanup", session: { dispose: vi.fn() } as unknown as AgentSession, aborted: false, steered: false });
    for (const entry of pending) entry.finish({ responseText: "cleanup", session: entry.session, aborted: false, steered: false });
    await active?.registry().waitForAll();
    await active?.lifecycle.get("session_shutdown")?.({}, active.ctx);
    active = undefined;
    registerAgents(new Map());
    for (const name of ["manager", "manager-active", "rpc-owner", "manager-takeover-lock"]) Reflect.deleteProperty(globalThis, Symbol.for(`pi-subagents:${name}`));
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    vi.useRealTimers();
    rmSync(cwd, { recursive: true, force: true });
  });

  function definition(name: string, fields: string) {
    writeFileSync(join(cwd, ".pi", "agents", `${name}.md`), `---\n${fields}\n---\nfixture`);
  }
  async function start(joinMode = "async", maxConcurrent = 1) {
    active = activation(cwd, joinMode, maxConcurrent);
    await active.lifecycle.get("session_start")?.({}, active.ctx);
    return active;
  }
  async function finish(index: number, text = `RESULT-${index}`) {
    const entry = pending[index];
    entry.finish({ responseText: text, session: entry.session, aborted: false, steered: false });
    await active!.registry().waitForAll();
  }
  async function spawnTool(description = "fixture") {
    const result = await active!.call("Agent", { subagent_type: "general-purpose", description, prompt: "go", run_in_background: true }, `tc-${description}`);
    return (result.details as { agentId: string }).agentId;
  }

  it.each(["registry", "rpc"] as const)("applies definition isolation before immediate and queued %s starts", async surface => {
    definition("locked", "isolated: true\nisolation: worktree");
    const runtime = await start();
    let requestSequence = 0;
    const spawn = async (name: string, options: Record<string, unknown> = {}) => {
      if (surface === "registry") return runtime.registry().spawn(runtime.pi, runtime.ctx, name, "go", { description: name, isBackground: true, ...options });
      const requestId = `rpc-${++requestSequence}`;
      const reply = new Promise<{ success: boolean; data: { id: string } }>(resolve => runtime.events.on(`subagents:rpc:spawn:reply:${requestId}`, raw => resolve(raw as never)));
      runtime.events.emit("subagents:rpc:spawn", { requestId, type: name, prompt: "go", options: { description: name, isBackground: true, ...options } });
      const result = await reply;
      expect(result.success).toBe(true);
      return result.data.id;
    };
    const first = await spawn("locked", { isolated: false, isolation: "off" });
    const second = await spawn("locked");
    expect(runtime.registry().getRecord(first)?.status).toBe("running");
    expect(runtime.registry().getRecord(second)?.status).toBe("queued");
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(pending[0].options.isolated).toBe(true);
    pending[0].finish({ responseText: "first", session: pending[0].session, aborted: false, steered: false });
    // Drain the immediate lifecycle without waiting on the queued provider.
    for (let i = 0; i < 15; i++) await Promise.resolve();
    expect(pending).toHaveLength(2);
    expect(createWorktree).toHaveBeenCalledTimes(2);
    expect(pending[1].options.isolated).toBe(true);
    await finish(1);
  });

  it.each(["registry", "rpc"] as const)("preserves definition false/off and unspecified caller isolation via %s", async surface => {
    definition("open", "isolated: false\nisolation: off");
    definition("unset", "description: unset");
    const runtime = await start();
    const options = { description: "test", isBackground: true, isolated: true, isolation: "worktree" as const };
    const spawn = async (requestId: string) => {
      if (surface === "registry") return runtime.registry().spawn(runtime.pi, runtime.ctx, "open", "go", options);
      const reply = new Promise<{ success: boolean; data: { id: string } }>(resolve => runtime.events.on(`subagents:rpc:spawn:reply:${requestId}`, raw => resolve(raw as never)));
      runtime.events.emit("subagents:rpc:spawn", { requestId, type: "open", prompt: "go", options });
      const result = await reply;
      expect(result.success).toBe(true);
      return result.data.id;
    };
    await spawn("open-first");
    const queued = await spawn("open-queued");
    expect(runtime.registry().getRecord(queued)?.status).toBe("queued");
    expect(pending[0].options.isolated).toBe(false);
    expect(createWorktree).not.toHaveBeenCalled();
    pending[0].finish({ responseText: "first", session: pending[0].session, aborted: false, steered: false });
    for (let i = 0; i < 15; i++) await Promise.resolve();
    expect(pending[1].options.isolated).toBe(false);
    expect(createWorktree).not.toHaveBeenCalled();
    await finish(1);
    runtime.registry().spawn(runtime.pi, runtime.ctx, "unset", "go", options);
    expect(pending[2].options.isolated).toBe(true);
    expect(createWorktree).toHaveBeenCalledOnce();
    await finish(2);
  });

  it("keeps internal generation stronger than definition isolation and managed request-first policy", async () => {
    definition("general-purpose", "isolated: false\nisolation: worktree");
    definition("managed", "isolation: off");
    const runtime = await start();
    const manager = new AgentManager();
    try {
      const generated = manager.spawnAndWaitInternal(runtime.pi, runtime.ctx, "general-purpose", "generate", { description: "generate" }, AGENT_DEFINITION_GENERATION_OVERRIDE);
      expect(createWorktree).not.toHaveBeenCalled();
      expect(pending[0].options.isolated).toBe(true);
      expect(pending[0].options[INTERNAL_AGENT_CONFIG_OVERRIDE]).toBe(AGENT_DEFINITION_GENERATION_OVERRIDE);
      pending[0].finish({ responseText: "generated", session: pending[0].session, aborted: false, steered: false });
      await generated;
      const reply = new Promise<{ success: boolean; data: { id: string } }>(resolve => runtime.events.on("subagents:rpc:spawn-managed:reply:managed", raw => resolve(raw as never)));
      runtime.events.emit("subagents:rpc:spawn-managed", { requestId: "managed", spawnKey: "managed-key", type: "managed", description: "managed", prompt: "go", isolation: "worktree", owner: { extension: "pi-workflows", runId: "run", nodeId: "node", attemptId: "attempt" } });
      expect((await reply).success).toBe(true);
      expect(createWorktree).toHaveBeenCalledOnce();
      await finish(1);
    } finally { await manager.dispose(); }
  });

  it.each([
    { early: true, peerBeforeHandoff: false },
    { early: false, peerBeforeHandoff: false },
    { early: true, peerBeforeHandoff: true },
  ])("labels a partial group from finalized membership, not snapshot timing: %j", async ({ early, peerBeforeHandoff }) => {
    const runtime = await start("smart", 2); await spawnTool("first"); const peer = await spawnTool("peer");
    if (!early) await vi.advanceTimersByTimeAsync(100);
    pending[0].finish({ responseText: "FIRST", session: pending[0].session, aborted: false, steered: false });
    for (let i = 0; i < 15; i++) await Promise.resolve();
    if (early) await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(30_000);
    if (peerBeforeHandoff) await finish(1, "PEER");
    await vi.advanceTimersByTimeAsync(200);
    const status = runtime.registry().getRecord(peer)?.status;
    const content = runtime.sendMessage.mock.calls.map(([message]) => message.content as string).join("\n");
    if (!peerBeforeHandoff) await finish(1, "PEER");
    expect(status).toBe(peerBeforeHandoff ? "completed" : "running");
    expect(content).toContain("<result>FIRST</result>");
    expect(content.includes("partial — others still running")).toBe(!peerBeforeHandoff);
  });

  it("snapshots text, activity and tool-use identity when completion is immediately resumed", async () => {
    const runtime = await start();
    const id = await spawnTool("original");
    pending[0].options.onTurnEnd?.(7);
    pending[0].options.onToolActivity?.({ type: "end", toolName: "read" });
    pending[0].options.onAssistantUsage?.({ input: 9, output: 3, cacheWrite: 0 });
    await finish(0, "ORIGINAL");
    let release!: (value: Awaited<ReturnType<typeof resumeAgent>>) => void;
    vi.mocked(resumeAgent).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await runtime.call("Agent", { resume: id, subagent_type: "general-purpose", prompt: "again", description: "again", run_in_background: true }, "tc-resume");
    await vi.advanceTimersByTimeAsync(200);
    const [message, delivery] = runtime.sendMessage.mock.calls[0];
    expect(message.content).toContain("<tool-use-id>tc-original</tool-use-id>");
    expect(message.content).toContain("<result>ORIGINAL</result>");
    expect(message.content).toContain("<status>Done</status>");
    expect(message.details).toMatchObject({ status: "completed", turnCount: 7, toolUses: 1, totalTokens: 12 });
    expect(delivery).toEqual({ deliverAs: "steer", triggerTurn: true });
    release({ text: "RESUMED", aborted: false, steered: false });
    await runtime.registry().waitForAll();
    await vi.advanceTimersByTimeAsync(200);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(runtime.sendMessage.mock.calls[1][0].content).toContain("<tool-use-id>tc-resume</tool-use-id>");
  });

  it("does not let consumption of an older completion suppress its replacement", async () => {
    const runtime = await start();
    const id = await spawnTool();
    await finish(0, "OLD");
    await runtime.call("get_subagent_result", { agent_id: id });
    await runtime.call("Agent", { resume: id, subagent_type: "general-purpose", prompt: "again", run_in_background: true });
    await runtime.registry().waitForAll();
    await vi.advanceTimersByTimeAsync(250);
    expect(runtime.sendMessage).toHaveBeenCalledOnce();
    expect(runtime.sendMessage.mock.calls[0][0].content).toContain("<result>RESUMED</result>");
  });

  it("does not apply a replacement completion's consumption to the older pending nudge", async () => {
    const runtime = await start();
    const id = await spawnTool();
    await finish(0, "UNCONSUMED-ORIGINAL");
    await runtime.call("Agent", { resume: id, subagent_type: "general-purpose", prompt: "again", run_in_background: true });
    await runtime.registry().waitForAll();
    await runtime.call("get_subagent_result", { agent_id: id });
    await vi.advanceTimersByTimeAsync(250);
    expect(runtime.sendMessage).toHaveBeenCalledOnce();
    expect(runtime.sendMessage.mock.calls[0][0].content).toContain("<result>UNCONSUMED-ORIGINAL</result>");
  });

  it("snapshots smart-group members before batch deletion and filters only consumed completions", async () => {
    const runtime = await start("smart");
    const first = await spawnTool("first");
    await spawnTool("second");
    pending[0].options.onTurnEnd?.(4);
    pending[0].finish({ responseText: "FIRST", session: pending[0].session, aborted: false, steered: false });
    for (let i = 0; i < 15; i++) await Promise.resolve();
    await runtime.call("get_subagent_result", { agent_id: first });
    // Finalize the batch while one completed member is consumed.
    await vi.advanceTimersByTimeAsync(100);
    pending[1].options.onTurnEnd?.(8);
    await finish(1, "SECOND");
    // A new attempt's resultConsumed reset must not resurrect the first member.
    await runtime.call("Agent", { resume: first, subagent_type: "general-purpose", prompt: "again", run_in_background: true });
    await runtime.registry().waitForAll();
    await vi.advanceTimersByTimeAsync(200);
    const grouped = runtime.sendMessage.mock.calls.map(([message]) => message).find(message => message.content.includes("group completed"));
    expect(grouped.content).toContain("1 agent(s) finished");
    expect(grouped.content).toContain("<result>SECOND</result>");
    expect(grouped.content).not.toContain("FIRST");
    expect(grouped.details).toMatchObject({ turnCount: 8, status: "completed" });
    expect(grouped.details.others).toHaveLength(1);
    expect(grouped.content).toContain("<result>RESUMED</result>");
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps grouped snapshots stable while a completed member resumes before its peer finishes", async () => {
    const runtime = await start("smart");
    const first = await spawnTool("first");
    await spawnTool("second");
    pending[0].options.onTurnEnd?.(4);
    pending[0].finish({ responseText: "FIRST", session: pending[0].session, aborted: false, steered: false });
    for (let i = 0; i < 15; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    let release!: (value: Awaited<ReturnType<typeof resumeAgent>>) => void;
    vi.mocked(resumeAgent).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await runtime.call("Agent", { resume: first, subagent_type: "general-purpose", prompt: "again", run_in_background: true }, "replacement");
    pending[1].finish({ responseText: "SECOND", session: pending[1].session, aborted: false, steered: false });
    for (let i = 0; i < 15; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);
    const message = runtime.sendMessage.mock.calls[0][0];
    expect(message.content).toContain("<result>FIRST</result>");
    expect(message.content).toContain("<tool-use-id>tc-first</tool-use-id>");
    const details = message.details as NotificationDetails;
    expect([details, ...(details.others ?? [])].map(detail => detail.turnCount)).toContain(4);
    release({ text: "replacement", aborted: false, steered: false });
    await runtime.registry().waitForAll();
  });

  it.each([
    { finalized: false, consume: "none" },
    { finalized: false, consume: "first" },
    { finalized: false, consume: "second" },
    { finalized: false, consume: "both" },
    { finalized: true, consume: "none" },
    { finalized: true, consume: "first" },
    { finalized: true, consume: "second" },
    { finalized: true, consume: "both" },
  ])("retains both completed attempts while a peer is running: %j", async ({ finalized, consume }) => {
    const runtime = await start("smart", 2);
    const first = await spawnTool("first");
    await spawnTool("peer");
    if (finalized) await vi.advanceTimersByTimeAsync(100);
    pending[0].finish({ responseText: "FIRST", session: pending[0].session, aborted: false, steered: false });
    for (let i = 0; i < 15; i++) await Promise.resolve();
    if (consume === "first" || consume === "both") await runtime.call("get_subagent_result", { agent_id: first });
    vi.mocked(resumeAgent).mockResolvedValueOnce({ text: "SECOND", aborted: false, steered: false });
    const secondCompleted = new Promise<void>(resolve => runtime.events.on("subagents:completed", raw => {
      if ((raw as { result?: string }).result === "SECOND") resolve();
    }));
    await runtime.call("Agent", { resume: first, subagent_type: "general-purpose", prompt: "again", run_in_background: true }, "tc-second");
    await secondCompleted;
    for (let i = 0; i < 15; i++) await Promise.resolve();
    if (consume === "second" || consume === "both") {
      const result = await runtime.call("get_subagent_result", { agent_id: first });
      expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("SECOND") })]));
    }
    expect(runtime.registry().getRecord(first)?.status).toBe("completed");
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    await finish(1, "PEER");
    await vi.advanceTimersByTimeAsync(finalized ? 200 : 300);
    const messages = runtime.sendMessage.mock.calls.map(([message]) => message);
    // Explicit group membership remains intact inside the single boundary
    // message, alongside any unconsumed newer attempt's individual XML.
    expect(messages).toHaveLength(1);
    const content = messages[0].content as string;
    const grouped = content.match(/Background agent group completed:[\s\S]*?Use get_subagent_result for full output\./)?.[0];
    expect(grouped).toContain("<result>PEER</result>");
    expect(grouped?.includes("<result>FIRST</result>")).toBe(consume !== "first" && consume !== "both");
    expect(grouped).not.toContain("<result>SECOND</result>");
    expect(content.includes("<result>SECOND</result>")).toBe(consume !== "second" && consume !== "both");
    if (consume !== "second" && consume !== "both") expect(content).toContain("<tool-use-id>tc-second</tool-use-id>");
    for (const [, delivery] of runtime.sendMessage.mock.calls) expect(delivery).toEqual({ deliverAs: "steer", triggerTurn: true });
  });

  it.each(["session_tree", "session_shutdown"])("retires every pre-finalization completed attempt on %s", async event => {
    const runtime = await start("smart", 2);
    const id = await spawnTool("first");
    await spawnTool("peer");
    pending[0].finish({ responseText: "FIRST", session: pending[0].session, aborted: false, steered: false });
    for (let i = 0; i < 15; i++) await Promise.resolve();
    const secondCompleted = new Promise<void>(resolve => runtime.events.on("subagents:completed", raw => {
      if ((raw as { result?: string }).result === "RESUMED") resolve();
    }));
    await runtime.call("Agent", { resume: id, subagent_type: "general-purpose", prompt: "again", run_in_background: true });
    await secondCompleted;
    await finish(1, "PEER");
    await runtime.lifecycle.get(event)?.({}, { ...runtime.ctx });
    await vi.advanceTimersByTimeAsync(500);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    if (event === "session_shutdown") active = undefined;
  });

  it.each(["async", "smart"])("retires %s held completions across navigation and shutdown", async mode => {
    const runtime = await start(mode);
    // Run each retirement in a fresh generation, retaining the real activation.
    for (const event of ["session_start", "session_tree", "session_shutdown"]) {
      const index = pending.length;
      await spawnTool(`first-${event}`);
      if (mode === "smart") await spawnTool(`second-${event}`);
      pending[index].finish({ responseText: "retired", session: pending[index].session, aborted: false, steered: false });
      for (let i = 0; i < 15; i++) await Promise.resolve();
      if (mode === "smart") await finish(index + 1);
      else await runtime.registry().waitForAll();
      await vi.advanceTimersByTimeAsync(100);
      await runtime.lifecycle.get(event)?.({}, { ...runtime.ctx });
      await vi.advanceTimersByTimeAsync(500);
      expect(runtime.sendMessage).not.toHaveBeenCalled();
    }
    active = undefined;
  });
});
