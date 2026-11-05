import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { type AgentSession, type AgentSessionEvent, type ExtensionAPI, type ExtensionContext, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { AgentManager } from "../src/agent-manager.js";
import { AGENT_RECORD_ENTRY_TYPE, savedResumableAgents } from "../src/agent-record-entry.js";
import { type AgentReopenMetadata, captureAgentReopenMetadata, parseAgentReopenMetadata, validateAgentReopen } from "../src/agent-reopen.js";
import { resolveAgentRunModel, runAgent } from "../src/agent-runner.js";
import { setAgentTiersSettings } from "../src/agent-tiers.js";
import { getAgentConfig, registerAgents, setDefaultsDisabled } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import * as worktrees from "../src/worktree.js";
import { mockParentRegistry } from "./helpers/model-runtime.js";

let cwd: string;
let previousAgentDir: string | undefined;
let manager: AgentManager;
let shutdown: (() => Promise<void>) | undefined;
const model = getBuiltinModel("anthropic", "claude-sonnet-4-6");
const assistant = (text: string): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id,
  stopReason: "stop", timestamp: Date.now(),
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

/** Native journals, fake execution: never creates an SDK/model/provider session. */
function fakeChild(native: SessionManager, selectedModel: Model<Api> = model) {
  const subscribers = new Set<(event: AgentSessionEvent) => void>();
  const session = {
    sessionManager: native, model: selectedModel,
    get messages() { return native.buildSessionContext().messages; },
    get state() { return { messages: native.buildSessionContext().messages }; },
    subscribe: (listener: (event: AgentSessionEvent) => void) => { subscribers.add(listener); return () => subscribers.delete(listener); },
    dispose: vi.fn(), abort: vi.fn(async () => {}),
  } as unknown as AgentSession;
  return { session, emit: (event: AgentSessionEvent) => { for (const listener of subscribers) listener(event); } };
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-cold-resume-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, agentMentions: "direct" }));
  setDefaultsDisabled(false);
  registerAgents(new Map());
  vi.mocked(runAgent).mockReset();
  vi.mocked(runAgent).mockImplementation(async (ctx, _type, prompt, options) => {
    await Promise.resolve();
    const native = options.resumeSessionFile ? SessionManager.open(options.resumeSessionFile)
      : SessionManager.create(options.cwd ?? ctx.cwd, join(cwd, "children"), { parentSession: ctx.sessionManager.getSessionFile() });
    const child = fakeChild(native, resolveAgentRunModel(ctx, getAgentConfig(_type), options));
    options.onSessionCreated?.(child.session);
    native.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
    native.appendMessage(assistant(`answer:${prompt}`));
    child.emit({ type: "turn_end" } as AgentSessionEvent);
    return { responseText: `answer:${prompt}`, session: child.session, aborted: false, steered: false };
  });
  const original = AgentManager.prototype.restoreSavedAgents;
  vi.spyOn(AgentManager.prototype, "restoreSavedAgents").mockImplementation(function (this: AgentManager, ctx) {
    manager = this;
    return original.call(this, ctx);
  });
});

afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  vi.restoreAllMocks();
  for (const key of ["manager", "manager-active", "rpc-owner"]) Reflect.deleteProperty(globalThis, Symbol.for(`pi-subagents:${key}`));
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(cwd, { recursive: true, force: true });
});

async function activate(parent = SessionManager.create(cwd, join(cwd, "parents"))) {
  if (!parent.getLeafId()) parent.appendMessage({ role: "user", content: "private parent text", timestamp: Date.now() });
  const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
  const tools = new Map<string, ToolDefinition>();
  const busHandlers = new Map<string, ((payload: unknown) => void)[]>();
  const events = {
    on: (name: string, handler: (payload: unknown) => void) => { const list = busHandlers.get(name) ?? []; list.push(handler); busHandlers.set(name, list); return () => { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1); }; },
    emit: vi.fn((name: string, payload: unknown) => { for (const handler of busHandlers.get(name) ?? []) handler(payload); }),
  };
  const pi = {
    on: (name: string, handler: (...args: unknown[]) => unknown) => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    events, registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand: vi.fn(), registerMessageRenderer: vi.fn(),
    appendEntry: (type: string, data: unknown) => parent.appendCustomEntry(type, data), sendMessage: vi.fn(),
    setModel: vi.fn(), setThinkingLevel: vi.fn(), getThinkingLevel: () => "off",
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd, mode: "tui", hasUI: false, isProjectTrusted: () => true, model, thinkingLevel: "off",
    modelRegistry: { ...mockParentRegistry, runtime: { ...mockParentRegistry.runtime, getModel: () => model },
      getAvailable: () => [model], find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined }, sessionManager: parent,
    getSystemPrompt: () => "parent system prompt", isIdle: () => true, hasPendingMessages: () => false, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
  } as unknown as ExtensionContext;
  const fire = async (event: string, payload: unknown = {}) => { for (const handler of handlers.get(event) ?? []) await handler(payload, ctx); };
  subagentsExtension(pi);
  await fire("session_start");
  shutdown = () => fire("session_shutdown");
  const call = (params: Record<string, unknown>) => tools.get("Agent")!.execute("test-call", params, undefined, undefined, ctx as never);
  return { parent, ctx, call, fire, events, pi };
}

async function initial(overrides: Record<string, unknown> = {}) {
  const activation = await activate();
  const result = await activation.call({ subagent_type: "Explore", prompt: "first", description: "Original task", ...overrides });
  const id = (result.details as { agentId: string }).agentId;
  const saved = savedResumableAgents(activation.parent.getBranch(), activation.parent.getSessionId())[0]!;
  expect(saved.id).toBe(id);
  return { ...activation, id, saved };
}

async function evict() {
  manager.clearCompleted();
  await new Promise<void>(resolve => setImmediate(resolve)); // native shutdown promise owns eviction until settled
}

function savedRecord(parent: SessionManager, id: string): AgentRecord & { reopen: AgentReopenMetadata } {
  const entry = parent.getBranch().findLast(item => item.type === "custom" && item.customType === AGENT_RECORD_ENTRY_TYPE &&
    (item.data as { id?: string })?.id === id);
  if (entry?.type !== "custom") throw new Error("missing saved record");
  return structuredClone(entry.data) as AgentRecord & { reopen: AgentReopenMetadata };
}

describe("cold ordinary Agent continuation", () => {
  it("reopens after eviction with stable ID/handle and appends the transcript exactly once", async () => {
    const a = await initial();
    const old = manager.getRecordMutable(a.id)!;
    const outputFile = old.outputFile!;
    const originalTranscript = readFileSync(outputFile, "utf8");
    await evict();
    expect(manager.getRecord(a.id)).toBeUndefined();
    const continued = await a.call({ subagent_type: "not-the-original-type", prompt: "second", description: "ignored", resume: a.id });
    expect((continued.details as { agentId: string }).agentId).toBe(a.id);
    expect(manager.getRecord(a.id)?.handle).toBe(a.saved.handle);
    expect(manager.getRecord(a.id)?.type).toBe("Explore");
    expect(vi.mocked(runAgent).mock.lastCall?.[3].resumeSessionFile).toBe(a.saved.sessionFile);
    const transcript = readFileSync(outputFile, "utf8");
    expect(transcript.startsWith(originalTranscript)).toBe(true);
    const messages = transcript.trim().split("\n").map(line => JSON.parse(line).message);
    expect(messages.filter(message => message.role === "user").map(message => message.content)).toEqual(["first", "second"]);
    expect(messages.filter(message => message.role === "assistant")).toHaveLength(2);
    expect(readFileSync(a.saved.sessionFile, "utf8")).not.toContain("private parent text");
    await evict();
    await a.fire("input", { text: `@${a.saved.handle} third`, source: "user" });
    await manager.waitForAll();
    expect(manager.getRecord(a.id)?.result).toBe("answer:third");
    expect(manager.getRecord(a.id)?.handle).toBe(a.saved.handle);
    const userMessages = readFileSync(outputFile, "utf8").trim().split("\n").map(line => JSON.parse(line).message)
      .filter(message => message.role === "user").map(message => message.content);
    expect(userMessages).toEqual(["first", "second", "third"]);
  });

  it.each([
    { provider: "other" }, { api: "openai-responses" }, { id: "different-model" }, { baseUrl: "https://other.example/v1" },
    { baseUrl: "" }, { api: "pi-virtual" },
  ])("refuses changed/unknown catalog route %j before lease, runner or main policy mutation", async change => {
    const a = await initial();
    await evict();
    const before = readFileSync(a.saved.sessionFile, "utf8");
    const eventCount = a.events.emit.mock.calls.length;
    a.ctx.model = { ...model, ...change };
    await expect(a.call({ subagent_type: "Explore", prompt: "do not send", description: "task", resume: a.id })).rejects.toThrow(/route proof.*sanitized task summary/);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(manager.listAgents()).toEqual([]);
    expect(existsSync(`${a.saved.sessionFile}.subagents-lock`)).toBe(false);
    expect(readFileSync(a.saved.sessionFile, "utf8")).toBe(before);
    expect(a.events.emit.mock.calls).toHaveLength(eventCount);
    expect(a.pi.setModel).not.toHaveBeenCalled();
    expect(a.pi.setThinkingLevel).not.toHaveBeenCalled();
    expect(a.ctx.model).toEqual({ ...model, ...change });
    expect(a.ctx.thinkingLevel).toBe("off");
  });

  it("resolves a changed current-definition tier before refusing, without restoring its old model", async () => {
    const a = await initial();
    await evict();
    const alternate = { ...model, id: "alternate" };
    Object.assign(a.ctx.modelRegistry, { find: () => alternate, getAvailable: () => [model, alternate] });
    setAgentTiersSettings({ profiles: { changed: { model: "test/alternate", thinking: "inherit" } } });
    writeFileSync(join(cwd, ".pi", "agents", "Explore.md"), "---\ndescription: changed\ntier: changed\n---\nCurrent definition\n");
    await expect(a.call({ subagent_type: "Explore", prompt: "new tier", description: "task", resume: a.id })).rejects.toThrow(/route proof/);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(a.ctx.model).toBe(model);
    expect(a.pi.setModel).not.toHaveBeenCalled();
    expect(a.pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  it("does not retain a proof when the live child model route changed before settlement", async () => {
    const a = await initial();
    const record = manager.getRecordMutable(a.id)!;
    Object.assign(record.session!, { model: { ...model, baseUrl: "https://changed.example" } });
    const saved = savedRecord(a.parent, a.id);
    // The terminal capture used by eviction/persistence cannot mint replacement consent.
    saved.reopen = captureAgentReopenMetadata(record)!;
    expect(saved.reopen.route).toBeUndefined();
    a.parent.appendCustomEntry(AGENT_RECORD_ENTRY_TYPE, saved);
    await evict();
    manager.restoreSavedAgents(a.ctx);
    await expect(a.call({ subagent_type: "Explore", prompt: "changed live", description: "task", resume: a.id })).rejects.toThrow(/route proof/);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("strips spoofed secret-path routes during parsing and terminal/queued capture without upgrading failed capture", async () => {
    const a = await initial();
    const record = manager.getRecordMutable(a.id)!;
    const secretUrl = `${model.baseUrl}/tenant/SECRET-PATH-CREDENTIAL`;
    const spoofed = { ...record.reopen!, route: { ...record.reopen!.route!, baseUrl: secretUrl } };
    const parsed = parseAgentReopenMetadata(spoofed)!;
    const queued = captureAgentReopenMetadata({ ...record, reopen: spoofed, session: undefined })!;
    const terminal = captureAgentReopenMetadata({ ...record, reopen: spoofed,
      session: fakeChild(record.session!.sessionManager, { ...model, baseUrl: secretUrl }).session })!;
    const failedCapture = captureAgentReopenMetadata({ ...record, reopen: spoofed,
      session: { ...record.session!, model: undefined } as AgentSession })!;
    const restored = savedResumableAgents([{ type: "custom", customType: AGENT_RECORD_ENTRY_TYPE,
      data: { ...savedRecord(a.parent, a.id), reopen: spoofed } }], a.parent.getSessionId());
    expect(restored).toHaveLength(1);
    for (const receipt of [parsed, queued, terminal, failedCapture, restored[0]!.reopen!]) expect(receipt.route).toBeUndefined();
    expect(JSON.stringify([parsed, queued, terminal, failedCapture, restored])).not.toContain(secretUrl);
    expect(JSON.stringify([parsed, queued, terminal, failedCapture, restored])).not.toContain("SECRET-PATH-CREDENTIAL");
  });

  it("requires route proof to agree with the exact native identity marker, not only the parent receipt", async () => {
    const a = await initial();
    await evict();
    const saved = savedRecord(a.parent, a.id);
    const alternate = getBuiltinModel("anthropic", "claude-opus-4-6");
    saved.reopen.route = { ...saved.reopen.route!, modelId: alternate.id };
    a.ctx.model = alternate;
    a.parent.appendCustomEntry(AGENT_RECORD_ENTRY_TYPE, saved);
    manager.restoreSavedAgents(a.ctx);
    await expect(a.call({ subagent_type: "Explore", prompt: "forged route", description: "task", resume: a.id })).rejects.toThrow(/native route proof/);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(existsSync(`${a.saved.sessionFile}.subagents-lock`)).toBe(false);
  });

  it("refuses legacy missing route proof without upgrading it from the current model", async () => {
    const a = await initial();
    await evict();
    const legacy = savedRecord(a.parent, a.id);
    delete legacy.reopen.route;
    a.parent.appendCustomEntry(AGENT_RECORD_ENTRY_TYPE, legacy);
    manager.restoreSavedAgents(a.ctx);
    await expect(a.call({ subagent_type: "Explore", prompt: "legacy", description: "task", resume: a.id })).rejects.toThrow(/route proof.*sanitized task summary/);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(existsSync(`${a.saved.sessionFile}.subagents-lock`)).toBe(false);
  });

  it.each(["thinking-signature", "text-signature", "tool-signature", "redacted", "unknown", "compacted", "edited"])("refuses %s history despite a matching catalog route, without provider side effects", async kind => {
    const a = await initial();
    await evict();
    const child = SessionManager.open(a.saved.sessionFile);
    const message = assistant("plain");
    if (kind === "thinking-signature" || kind === "compacted" || kind === "edited") message.content = [{ type: "thinking", thinking: "", thinkingSignature: "OPAQUE-ISSUER-PAYLOAD" }];
    if (kind === "text-signature") message.content = [{ type: "text", text: "text", textSignature: "opaque" }];
    if (kind === "tool-signature") message.content = [{ type: "toolCall", id: "call", name: "read", arguments: {}, thoughtSignature: "opaque" }];
    if (kind === "redacted") message.content = [{ type: "thinking", thinking: "", redacted: true }];
    if (kind === "unknown") message.content = [{ type: "future-opaque", payload: "opaque" }] as unknown as AssistantMessage["content"];
    const id = child.appendMessage(message);
    if (kind === "compacted") child.appendCompaction("Plain summary", null, 10);
    if (kind === "edited") child.appendContextEdit(id, { content: [{ type: "text", text: "sanitized visible edit" }] });
    const saved = savedRecord(a.parent, a.id);
    saved.reopen.leafId = child.getLeafId()!;
    a.parent.appendCustomEntry(AGENT_RECORD_ENTRY_TYPE, saved);
    manager.restoreSavedAgents(a.ctx);
    await expect(a.call({ subagent_type: "Explore", prompt: "opaque", description: "task", resume: a.id })).rejects.toThrow(/opaque or unknown replay content.*issuer\/profile/);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(existsSync(`${a.saved.sessionFile}.subagents-lock`)).toBe(false);
    expect(a.pi.setModel).not.toHaveBeenCalled();
    expect(a.pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  it("rechecks the current route after queue wait without invoking the runner", async () => {
    const a = await initial();
    await evict();
    manager.setMaxConcurrent(1);
    let release!: () => void;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ responseText: "busy", session: fakeChild(SessionManager.inMemory(cwd)).session, aborted: false, steered: false }); }));
    manager.spawn(a.pi, a.ctx, "Explore", "busy", { description: "busy", isBackground: true });
    manager.reopen(a.pi, a.ctx, a.id, "queued", { description: "task", isBackground: true });
    expect(manager.getRecord(a.id)?.status).toBe("queued");
    a.ctx.model = { ...model, baseUrl: "https://changed.example/v1" };
    release();
    await manager.waitForAll();
    expect(runAgent).toHaveBeenCalledTimes(2); // original plus blocker only
    expect(manager.getRecord(a.id)).toMatchObject({ status: "error", error: expect.stringContaining("route proof") });
  });

  it.each([{ isolated: true }, { isolated: false }, { isolation: "worktree" }, { isolation: "off" }])(
    "refuses explicit cold isolation parameters %j at public and manager admission, including a full queue", async change => {
      const a = await initial({ isolated: true, supervisor_questions: "off" });
      await evict();
      manager.setMaxConcurrent(1);
      let release!: () => void;
      vi.mocked(runAgent).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ responseText: "busy", session: fakeChild(SessionManager.inMemory(cwd)).session, aborted: false, steered: false }); }));
      const blocker = manager.spawn(a.pi, a.ctx, "Explore", "busy", { description: "busy", isBackground: true });
      const before = readFileSync(a.saved.sessionFile, "utf8");
      const events = a.events.emit.mock.calls.length;
      const key = "isolated" in change ? "isolated" : "isolation";
      try {
        await expect(a.call({ subagent_type: "Explore", prompt: "refused", description: "task", resume: a.id,
          run_in_background: true, ...change })).rejects.toThrow(new RegExp(`per-call ${key}`));
        expect(() => manager.reopen(a.pi, a.ctx, a.id, "refused", { description: "task", isBackground: true, ...change })).toThrow(new RegExp(`per-call ${key}`));
        expect(manager.listAgents().map(record => record.id)).toEqual([blocker]);
        expect(runAgent).toHaveBeenCalledTimes(2);
        expect(existsSync(`${a.saved.sessionFile}.subagents-lock`)).toBe(false);
        expect(readFileSync(a.saved.sessionFile, "utf8")).toBe(before);
        expect(manager.getResumable(a.id)?.reopen).toEqual(a.saved.reopen);
        expect(a.events.emit.mock.calls).toHaveLength(events);
      } finally { release(); await manager.waitForAll(); }
      await a.call({ subagent_type: "Explore", prompt: "unchanged restrictions", description: "task", resume: a.id });
      expect(vi.mocked(runAgent).mock.lastCall?.[3]).toMatchObject({ isolated: true, supervisorQuestions: false });
    });

  it("preserves invocation isolation and withheld supervisor access instead of widening current defaults", async () => {
    const a = await initial({ isolated: true, supervisor_questions: "off" });
    await evict();
    await a.call({ subagent_type: "Explore", prompt: "continue", description: "task", resume: a.id });
    expect(vi.mocked(runAgent).mock.lastCall?.[3]).toMatchObject({ isolated: true, supervisorQuestions: false });
  });

  it("reopens original isolated/worktree restrictions with bare public params, without treating derived defaults as transitions", async () => {
    const a = await initial({ isolated: true, supervisor_questions: "off" });
    await evict();
    const worktree = { path: cwd, workPath: cwd, repoRoot: cwd, branch: "original-checkout", baseSha: "original-sha" };
    const saved = savedRecord(a.parent, a.id);
    saved.reopen.isolation = "worktree";
    saved.reopen.worktree = worktree;
    // A native pre-existing worktree receipt; Git admission/cleanup are observed
    // separately so this fixture neither creates nor commits a checkout.
    const journal = readFileSync(a.saved.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const identity = journal.find(entry => entry.type === "custom" && entry.customType === "subagents:identity");
    Object.assign(identity.data, { isolation: "worktree", worktree });
    writeFileSync(a.saved.sessionFile, journal.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    a.parent.appendCustomEntry(AGENT_RECORD_ENTRY_TYPE, saved);
    manager.restoreSavedAgents(a.ctx);
    writeFileSync(join(cwd, ".pi", "agents", "Explore.md"), "---\ndescription: Current\nisolation: worktree\nisolated: false\n---\nCurrent prompt\n");
    const reusable = vi.spyOn(worktrees, "assertReusableWorktree").mockImplementation(() => {});
    const create = vi.spyOn(worktrees, "createWorktree");
    vi.spyOn(worktrees, "cleanupWorktree").mockReturnValue({ hasChanges: false, cleanupSucceeded: false, path: cwd });
    vi.spyOn(worktrees, "cleanupWorktreeAsync").mockResolvedValue({ hasChanges: false, cleanupSucceeded: true });
    vi.spyOn(worktrees, "pruneWorktreesAsync").mockResolvedValue();
    await a.call({ subagent_type: "Explore", prompt: "same checkout", description: "task", resume: a.id });
    expect(vi.mocked(runAgent).mock.lastCall?.[3]).toMatchObject({ cwd, isolated: true, worktreeBase: cwd, supervisorQuestions: false });
    expect(manager.getRecordMutable(a.id)?.worktree).toEqual(worktree);
    expect(reusable).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
  });

  it("restores branch-owned receipts on a fresh activation and reapplies current definition policy", async () => {
    const a = await initial();
    await shutdown?.();
    shutdown = undefined;
    writeFileSync(join(cwd, ".pi", "agents", "Explore.md"), "---\ndescription: Current\ntools: read\nmax_turns: 3\nisolated: true\n---\nCurrent prompt\n");
    const b = await activate(a.parent);
    await b.call({ subagent_type: "ignored", prompt: "after reload", description: "ignored", resume: a.id });
    expect(manager.getRecord(a.id)?.type).toBe("Explore");
    expect(vi.mocked(runAgent).mock.lastCall?.[3]).toMatchObject({ maxTurns: 3, isolated: true });
    expect(manager.getRecord(a.id)?.handle).toBe(a.saved.handle);
  });

  it.each(["resumeSessionFile", "reclaimHandle", "resume_session_file", "reclaim_handle"])("rejects public capability %s at Agent, registry and legacy RPC boundaries", async key => {
    const a = await activate();
    const params = { subagent_type: "Explore", prompt: "first", description: "task", [key]: "/foreign/session.jsonl" };
    await expect(a.call(params)).rejects.toThrow(/internal capability/);
    const registry = Reflect.get(globalThis, Symbol.for("pi-subagents:manager")) as { spawn: (...args: unknown[]) => string };
    expect(() => registry.spawn(a.pi, a.ctx, "Explore", "go", { description: "task", [key]: "/foreign/session.jsonl" })).toThrow(/internal capability/);
    a.events.emit("subagents:rpc:spawn", { requestId: "injection", type: "Explore", prompt: "go", options: { [key]: "/foreign/session.jsonl" } });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(a.events.emit).toHaveBeenCalledWith("subagents:rpc:spawn:reply:injection", expect.objectContaining({ success: false, error: expect.stringContaining("internal capability") }));
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("refuses foreign/sibling parents, missing files and stale native leaves", async () => {
    const a = await initial();
    const foreign = SessionManager.create(cwd, join(cwd, "parents"));
    foreign.appendMessage({ role: "user", content: "other parent", timestamp: Date.now() });
    expect(() => validateAgentReopen(a.saved, { ...a.ctx, sessionManager: foreign })).toThrow(/another parent/);
    const sibling = SessionManager.create(cwd, join(cwd, "children"), { parentSession: a.parent.getSessionFile() });
    sibling.appendMessage({ role: "user", content: "sibling", timestamp: Date.now() });
    expect(() => validateAgentReopen({ ...a.saved, reopen: { ...a.saved.reopen!, sessionFile: sibling.getSessionFile()! } }, a.ctx)).toThrow(/stale\/mismatched/);
    SessionManager.open(a.saved.sessionFile).appendMessage({ role: "user", content: "newer attempt", timestamp: Date.now() });
    await evict();
    await expect(a.call({ subagent_type: "Explore", prompt: "stale", description: "task", resume: a.id })).rejects.toThrow(/stale\/mismatched/);
    rmSync(a.saved.sessionFile);
    await expect(a.call({ subagent_type: "Explore", prompt: "missing", description: "task", resume: a.id })).rejects.toThrow(/Restore its original session file/);
    await a.fire("input", { text: `@${a.saved.handle} missing`, source: "user" });
    await a.fire("input", { text: `@${a.saved.handle} missing again`, source: "user" });
    expect(manager.getResumable(a.id)).toBeDefined();
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it.each(["disabled", "missing", "inherit", "no-persistence", "lost-isolation"])("refuses changed %s definition without falling back", async change => {
    const a = await initial();
    await evict();
    const fields = change === "disabled" ? "enabled: false" : change === "inherit" ? "inherit_context: true"
      : change === "no-persistence" ? "persist_session: false" : "isolation: worktree";
    if (change === "missing") {
      writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, disableDefaultAgents: true }));
      await shutdown?.();
      shutdown = undefined;
      const b = await activate(a.parent);
      await expect(b.call({ subagent_type: "Explore", prompt: "next", description: "task", resume: a.id })).rejects.toThrow(/no longer available/);
    } else {
      writeFileSync(join(cwd, ".pi", "agents", "Explore.md"), `---\ndescription: changed\n${fields}\n---\nPrompt\n`);
      await expect(a.call({ subagent_type: "Explore", prompt: "next", description: "task", resume: a.id })).rejects.toThrow(/no longer available|inherit_context|disables session|no isolated checkout/);
    }
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("rejects managed, malformed and inherited receipts and masks older supported facts", async () => {
    const a = await initial();
    const record = savedRecord(a.parent, a.id);
    const managed = { ...record, owner: { extension: "pi-workflows", runId: "r", nodeId: "n", attemptId: "a" } };
    expect(savedResumableAgents([{ type: "custom", customType: AGENT_RECORD_ENTRY_TYPE, data: managed }], a.parent.getSessionId())).toEqual([]);
    expect(savedResumableAgents([{ type: "custom", customType: AGENT_RECORD_ENTRY_TYPE, data: { ...record, reopen: { ...record.reopen, version: 99 } } }], a.parent.getSessionId())).toEqual([]);
    const child = SessionManager.open(a.saved.sessionFile);
    child.appendMessage({ role: "user", content: "# Parent Conversation Context\nprivate", timestamp: Date.now() });
    expect(() => validateAgentReopen({ ...a.saved, reopen: { ...a.saved.reopen!, leafId: child.getLeafId()! } }, a.ctx)).toThrow(/inherited parent history/);
    a.parent.appendCustomEntry(AGENT_RECORD_ENTRY_TYPE, { ...record, reopen: { ...record.reopen, version: 99 } });
    manager.restoreSavedAgents(a.ctx);
    expect(manager.getResumable(a.id)).toBeUndefined();
  });

  it("does not restore receipts from an abandoned sibling branch or when remembering is off", async () => {
    const a = await initial();
    const root = a.parent.getBranch()[0]!;
    await evict();
    a.parent.branch(root.id);
    await a.fire("session_tree");
    expect(manager.getResumable(a.id)).toBeUndefined();
    const result = await a.call({ subagent_type: "Explore", prompt: "wrong branch", description: "task", resume: a.id });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("No ordinary saved agent") });
    manager.setRememberAgents(false);
    manager.restoreSavedAgents(a.ctx);
    expect(manager.listResumable()).toEqual([]);
  });

  it("refuses handle collisions and retains only a bounded saved index", async () => {
    const a = await initial();
    const record = savedRecord(a.parent, a.id);
    const collision = { ...record, id: "collision" };
    a.parent.appendCustomEntry(AGENT_RECORD_ENTRY_TYPE, collision);
    manager.restoreSavedAgents(a.ctx);
    expect(manager.getResumable(a.saved.handle)).toBeUndefined();
    for (let i = 0; i < 150; i++) a.parent.appendCustomEntry(AGENT_RECORD_ENTRY_TYPE,
      { ...record, id: `id-${i}`, reopen: { ...record.reopen, handle: `handle-${i}` } });
    manager.restoreSavedAgents(a.ctx);
    expect(manager.listResumable()).toHaveLength(128);
  });

  it("keeps ordinary live IDs out of managed mention indexing", async () => {
    const a = await initial();
    manager.getRecordMutable(a.id)!.owner = { extension: "pi-workflows", runId: "r", nodeId: "n", attemptId: "a" };
    expect(manager.resolveMention(a.saved.handle)).toBeUndefined();
    const response = await a.call({ subagent_type: "Explore", prompt: "steal", description: "task", resume: a.id });
    expect(response.content[0]).toMatchObject({ text: expect.stringContaining("Agent not found") });
    await evict();
    expect(manager.getResumable(a.id)).toBeUndefined();
  });

  it("leases the native file across managers until the original provider/session ownership is released", async () => {
    const a = await initial();
    const second = new AgentManager();
    const originalManager = manager;
    try {
      second.restoreSavedAgents(a.ctx);
      manager = originalManager;
      expect(() => second.reopen(a.pi, a.ctx, a.id, "overlap", { description: "task" })).toThrow(/reserved by another instance/);
      expect(second.listAgents()).toEqual([]);
      await evict();
      const id = second.reopen(a.pi, a.ctx, a.id, "after release", { description: "task" });
      await second.getRecordMutable(id)?.promise;
      expect(id).toBe(a.id);
      expect(second.getRecord(id)?.result).toBe("answer:after release");
    } finally { await second.dispose(); }
  });

  it("requires the matching native ordinary identity even for a sibling with the same parent", async () => {
    const a = await initial();
    const sibling = SessionManager.create(cwd, join(cwd, "children"), { parentSession: a.parent.getSessionFile() });
    sibling.appendCustomEntry("subagents:identity", { id: "sibling-id", type: a.saved.type,
      rootSessionId: a.parent.getSessionId(), parentSessionFile: a.parent.getSessionFile(), cwd, isolation: "off" });
    sibling.appendMessage({ role: "user", content: "sibling task", timestamp: Date.now() });
    const forged = { ...a.saved, reopen: { ...a.saved.reopen!, sessionId: sibling.getSessionId(),
      sessionFile: sibling.getSessionFile()!, leafId: sibling.getLeafId()! } };
    expect(() => validateAgentReopen(forged, a.ctx)).toThrow(/foreign or managed/);
  });

  it("never indexes an actual managed native session or lets ordinary Agent resume it", async () => {
    const a = await activate();
    const managed = manager.spawnManaged(a.pi, a.ctx, { requestId: "managed-request", spawnKey: "managed-key", type: "Explore",
      prompt: "owned task", description: "Owned task", owner: { extension: "pi-workflows", runId: "r", nodeId: "n", attemptId: "a" } }, {});
    await manager.waitForAll();
    expect(manager.getRecordMutable(managed.id)?.sessionFile).toBeDefined();
    expect(manager.getRecordMutable(managed.id)?.reopen).toBeUndefined();
    expect(manager.getRecordMutable(managed.id)?.handle).toBeUndefined();
    expect(manager.resolveMention(managed.id)).toBeUndefined();
    const response = await a.call({ subagent_type: "Explore", prompt: "steal", description: "task", resume: managed.id });
    expect(response.content[0]).toMatchObject({ text: expect.stringContaining("Agent not found") });
    await evict();
    expect(manager.getResumable(managed.id)).toBeUndefined();
    expect(savedResumableAgents(a.parent.getBranch(), a.parent.getSessionId())).toEqual([]);
  });

  it("keeps the original receipt when a queued cold run is cancelled before opening its session", async () => {
    const a = await initial();
    await evict();
    manager.setMaxConcurrent(1);
    let release!: () => void;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ responseText: "busy", session: fakeChild(SessionManager.inMemory(cwd)).session, aborted: false, steered: false }); }));
    manager.spawn(a.pi, a.ctx, "Explore", "busy", { description: "busy", isBackground: true });
    await a.call({ subagent_type: "Explore", prompt: "queued", description: "task", resume: a.id, run_in_background: true });
    expect(manager.getRecord(a.id)?.status).toBe("queued");
    expect(() => manager.reopen(a.pi, a.ctx, a.id, "duplicate", { description: "task" })).toThrow(/live or still settling/);
    expect(manager.abort(a.id)).toBe(true);
    expect(savedResumableAgents(a.parent.getBranch(), a.parent.getSessionId()).find(entry => entry.id === a.id)?.reopen).toEqual(a.saved.reopen);
    release();
    await manager.waitForAll();
    await evict();
    await a.call({ subagent_type: "Explore", prompt: "after cancellation", description: "task", resume: a.id });
    expect(manager.getRecord(a.id)?.result).toBe("answer:after cancellation");
  });

  it("reserves the original identity while a background cold continuation executes", async () => {
    const a = await initial();
    await evict();
    let release!: () => void;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ responseText: "done", session: fakeChild(SessionManager.open(a.saved.sessionFile)).session, aborted: false, steered: false }); }));
    await a.call({ subagent_type: "Explore", prompt: "hold", description: "task", resume: a.id, run_in_background: true });
    expect(() => manager.reopen(a.pi, a.ctx, a.id, "duplicate", { description: "task" })).toThrow(/live or still settling/);
    expect(manager.listAgents()).toHaveLength(1);
    expect(() => manager.spawn(a.pi, a.ctx, "Explore", "nested", {
      description: "nested", parentAgentId: a.id, isBackground: true,
    })).toThrow(/sealed/);
    release();
    await manager.waitForAll();
    expect(existsSync(a.saved.sessionFile)).toBe(true);
  });
});
