import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionContext, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import { shutdownAndDisposeSession } from "../src/session-lifecycle.js";

vi.setConfig({ testTimeout: 30_000 });

const OVERFLOW = "Your input exceeds the context window of this model";

describe("overflow-aware waking on the real offline Pi SDK", () => {
  let root: string;
  let previousAgentDir: string | undefined;
  let session: AgentSession;
  let main: ReturnType<typeof fauxProvider>;
  let child: ReturnType<typeof fauxProvider>;
  let ctx: ExtensionContext;
  let notify: ReturnType<typeof vi.fn<(message: string, level?: string) => void>>;
  let runs: string[];
  let cancelCompaction: boolean;
  let compactionHook: () => Promise<void>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "subagents-overflow-sdk-"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    mkdirSync(join(root, ".pi", "agents"), { recursive: true });
    writeFileSync(join(root, ".pi", "agents", "Worker.md"), "---\ndescription: Worker\ntools: read\nextensions: false\nskills: false\nask_tools: read\npersist_session: false\noutput_transcript: false\n---\nDo the task.\n");
    writeFileSync(join(root, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, maxConcurrent: 1, rememberAgents: false, outputTranscript: false, defaultJoinMode: "async", agentTiers: { profiles: { child: { model: "overflow-child/child", thinking: "inherit" } } } }));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    main = fauxProvider({ provider: "overflow-main", models: [{ id: "main", contextWindow: 200_000 }] });
    child = fauxProvider({ provider: "overflow-child", models: [{ id: "child", contextWindow: 200_000 }] });
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    runtime.registerNativeProvider(main.provider);
    runtime.registerNativeProvider(child.provider);
    await runtime.refresh({ allowNetwork: false });
    runs = [];
    cancelCompaction = true;
    compactionHook = async () => {};
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, noExtensions: true, noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: [
      { name: "overflow-subagents", factory: pi => subagentsExtension(pi) },
      { name: "probes", factory: pi => {
        pi.on("before_agent_start", event => { runs.push(event.messageType); });
        pi.on("session_compact", () => compactionHook());
        // Stands in for a compaction owner that cancels Pi's overflow recovery, then
        // supplies its own summary for an explicit compaction.
        pi.on("session_before_compact", event => cancelCompaction ? { cancel: true } : { compaction: { summary: "compacted", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } });
      } },
    ] });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: root, agentDir, model: main.getModel(), modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), resourceLoader: loader, sessionManager: SessionManager.inMemory(root), settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 1 }, retry: { enabled: false }, images: { autoResize: false } }) }));
    notify = vi.fn();
    await session.bindExtensions({ mode: "rpc", uiContext: { ...session.extensionRunner.getUIContext(), notify } });
    ctx = session.extensionRunner.createContext();
  });

  afterEach(async () => {
    await shutdownAndDisposeSession(session);
    main.setResponses([]);
    child.setResponses([]);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  const spawn = (options: object) => session.getToolDefinition("Agent")!.execute("spawn", { subagent_type: "Worker", tier: "child", description: "work", run_in_background: true, ...options }, undefined, undefined, ctx);
  const notices = () => session.sessionManager.getBranch().flatMap(entry => entry.type === "custom_message" && entry.customType === "subagent-notification" && typeof entry.content === "string" ? [entry.content] : []);
  const overflowNotices = () => notify.mock.calls.filter(([message]) => message.startsWith("Context exceeds the model's window"));
  // An earlier turn gives compaction something to summarize once it is allowed.
  async function overflow() {
    main.setResponses([fauxAssistantMessage(fauxText("warmed up")), fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW })]);
    await session.prompt("warm up");
    await session.prompt("hello");
    await vi.waitFor(() => expect(session.isIdle).toBe(true));
    expect(main.state.callCount).toBe(2);
    main.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 503 temporarily unavailable" })]);
    await session.prompt("retry oversized context");
    expect(main.state.callCount).toBe(3);
    runs.length = 0;
  }

  it("records completions without re-running an overflowed parent, notices once, and wakes again after compaction", async () => {
    await overflow();

    child.setResponses([fauxAssistantMessage(fauxText("FIRST_RESULT"))]);
    await spawn({ prompt: "first" });
    await vi.waitFor(() => expect(notices()).toEqual([expect.stringContaining("FIRST_RESULT")]));
    child.setResponses([fauxAssistantMessage(fauxText("SECOND_RESULT"))]);
    await spawn({ prompt: "second" });
    await vi.waitFor(() => expect(notices()).toHaveLength(2));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(main.state.callCount).toBe(3);
    expect(runs).toEqual([]);
    expect(overflowNotices()).toEqual([["Context exceeds the model's window; background subagent results are added to the conversation without starting a turn. Run /compact, or start a new session.", "warning"]]);
    // Held results are in the model context the next run starts from.
    expect(JSON.stringify(session.messages.filter(message => message.role === "custom"))).toMatch(/FIRST_RESULT.*SECOND_RESULT/s);

    cancelCompaction = false;
    await session.compact();
    let woken: TranscriptContext | undefined;
    main.setResponses([context => { woken = context; return fauxAssistantMessage(fauxText("results reviewed")); }]);
    child.setResponses([fauxAssistantMessage(fauxText("THIRD_RESULT"))]);
    await spawn({ prompt: "third" });
    await vi.waitFor(() => expect(main.state.callCount).toBe(4));
    await vi.waitFor(() => expect(session.isIdle).toBe(true));
    expect(runs).toEqual(["custom"]);
    // The run after compaction carries the held result it kept and the new one that woke it.
    for (const marker of ["SECOND_RESULT", "THIRD_RESULT"]) expect(JSON.stringify(woken?.messages)).toContain(marker);
    expect(overflowNotices()).toHaveLength(1);
  });

  it("holds a question wake while overflowed and wakes for it after compaction", async () => {
    await overflow();
    let questionId: string | undefined;
    child.setResponses([
      () => fauxAssistantMessage(fauxToolCall("contact_supervisor", { question: "Which database?" }), { stopReason: "toolUse" }),
      context => fauxAssistantMessage(fauxText(JSON.stringify(context).includes("sqlite") ? "answered" : "unanswered")),
    ]);
    main.setResponses([
      context => {
        questionId = /\\"questionId\\":\\"([^\\]+)\\"/.exec(JSON.stringify(context))?.[1];
        return fauxAssistantMessage(fauxToolCall("answer_subagent_question", { questionId, answer: "sqlite" }), { stopReason: "toolUse" });
      },
      () => fauxAssistantMessage(fauxText("question answered")),
      () => fauxAssistantMessage(fauxText("completion noticed")),
    ]);
    await spawn({ prompt: "ask", supervisor_questions: "parent" });
    await vi.waitFor(() => expect(child.state.callCount).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(main.state.callCount).toBe(3);
    expect(overflowNotices()).toHaveLength(1);

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = vi.fn(async () => { await gate; });
    compactionHook = held;
    cancelCompaction = false;
    const compacting = session.compact();
    await vi.waitFor(() => expect(held).toHaveBeenCalledOnce());
    // Let several local idle checks run while the downstream handler retains
    // Pi's compaction controller. No request may start during that interval.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(session.isIdle).toBe(false);
    expect(main.state.callCount).toBe(3);
    release();
    await compacting;
    await vi.waitFor(() => expect(questionId).toBeDefined());
    await vi.waitFor(() => expect(notices()).toEqual([expect.stringContaining("answered")]));
    expect(notices()[0]).not.toContain("unanswered");
    expect(runs.filter(kind => kind === "user")).toHaveLength(1);
    expect(overflowNotices()).toHaveLength(1);
  });
});
