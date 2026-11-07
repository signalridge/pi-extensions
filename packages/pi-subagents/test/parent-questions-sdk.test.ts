import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionContext, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ParentQuestionBroker } from "../src/parent-questions.js";
import { shutdownAndDisposeSession } from "../src/session-lifecycle.js";

vi.setConfig({ testTimeout: 30_000 });

describe("parent questions on the real offline Pi SDK", () => {
  let root: string;
  let agentDir: string;
  let previousAgentDir: string | undefined;
  let session: AgentSession;
  let main: ReturnType<typeof fauxProvider>;
  let child: ReturnType<typeof fauxProvider>;
  let ctx: ExtensionContext;
  let confirm: ReturnType<typeof vi.fn>;
  let input: ReturnType<typeof vi.fn>;
  let select: ReturnType<typeof vi.fn>;
  let prepared: ReturnType<typeof vi.fn>;
  let extensionInputs: ReturnType<typeof vi.fn>;
  let earlierTree: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "parent-questions-sdk-"));
    agentDir = join(root, "agent");
    mkdirSync(agentDir);
    mkdirSync(join(root, ".pi", "agents"), { recursive: true });
    writeFileSync(join(root, ".pi", "agents", "Questioner.md"), "---\ndescription: Questioner\ntools: read\nextensions: false\nskills: false\nask_tools: read\npersist_session: false\noutput_transcript: false\n---\nAsk one ordinary question; permission still requires the human.\n");
    writeFileSync(join(root, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, maxConcurrent: 1, rememberAgents: false, outputTranscript: false, defaultJoinMode: "async", agentTiers: { profiles: { child: { model: "questions-child/child", thinking: "inherit" } } } }));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    main = fauxProvider({ provider: "questions-main", models: [{ id: "main", contextWindow: 200_000 }] });
    child = fauxProvider({ provider: "questions-child", models: [{ id: "child", contextWindow: 200_000 }] });
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    runtime.registerNativeProvider(main.provider);
    runtime.registerNativeProvider(child.provider);
    await runtime.refresh({ allowNetwork: false });
    prepared = vi.fn();
    extensionInputs = vi.fn();
    earlierTree = vi.fn();
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, noExtensions: true, noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: [{ name: "earlier-tree", factory: pi => { pi.on("session_tree", earlierTree); } }, { name: "questions-subagents", factory: pi => {
      subagentsExtension(pi);
      pi.on("before_agent_start", prepared);
      pi.on("input", event => { if (event.source === "extension") extensionInputs(); });
    } }] });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: root, agentDir, model: main.getModel(), modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), resourceLoader: loader, sessionManager: SessionManager.inMemory(root), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, images: { autoResize: false } }) }));
    await session.bindExtensions({});
    ctx = session.extensionRunner.createContext();
    confirm = vi.fn(async () => false);
    input = vi.fn(async () => "human answer");
    select = vi.fn(async () => "human answer");
    // Programmatic root execution gets the same public dialog capability an
    // interactive/RPC host would supply; no private click/keypress automation.
    ctx = { ...ctx, hasUI: true, ui: { ...ctx.ui, confirm, input, select } };
  });

  afterEach(async () => {
    await shutdownAndDisposeSession(session);
    main.setResponses([]);
    child.setResponses([]);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  const args = { subagent_type: "Questioner", tier: "child", prompt: "Ask a clarification", description: "clarify" };
  function spawn(options: object = {}) {
    return session.getToolDefinition("Agent")!.execute("spawn", { ...args, ...options }, undefined, undefined, ctx);
  }

  it("omits routing from the tool schema and silently ignores an old argument", async () => {
    const tool = session.getToolDefinition("Agent")!;
    expect(tool.parameters.properties).not.toHaveProperty("supervisor_questions");
    child.setResponses([() => fauxAssistantMessage(fauxText("finished normally"))]);
    const validated = validateToolArguments(tool, { type: "toolCall", id: "old-client", name: "Agent", arguments: { ...args, supervisor_questions: "human" } });
    const result = await tool.execute("old-client", validated, undefined, undefined, ctx);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("finished normally") });
    expect(JSON.stringify(result)).not.toContain("retired");
    expect(JSON.stringify(result)).not.toContain("supervisor_questions");
    expect(main.state.callCount).toBe(0);
    expect(input).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    const answer = session.getToolDefinition("answer_subagent_question")!;
    await expect(answer.execute("forged", { questionId: "forged", answer: "approved" }, undefined, undefined, ctx)).rejects.toThrow("Unknown");
  });

  it("starts queued children without polling, wakes the idle main, resumes the asking child, and keeps permission denial human", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const rawChoice = "sqlite\u001b[31m";
    child.setResponses([
      async () => { await gate; return fauxAssistantMessage(fauxText("blocker done")); },
      context => {
        expect(JSON.stringify(context)).not.toContain("answer_subagent_question");
        expect(JSON.stringify(context)).not.toContain("RAW_PARENT_SECRET");
        return fauxAssistantMessage(fauxToolCall("contact_supervisor", { question: "Which database?", options: [rawChoice, "postgres"] }), { stopReason: "toolUse" });
      },
      context => {
        expect(JSON.stringify(context)).toContain("Main agent clarification");
        expect(JSON.stringify(context)).toContain(JSON.stringify(rawChoice).slice(1, -1));
        return fauxAssistantMessage(fauxToolCall("read", { path: join(root, "sensitive") }), { stopReason: "toolUse" });
      },
      context => {
        expect(JSON.stringify(context)).toMatch(/not approved|denied|declined/i);
        return fauxAssistantMessage(fauxText("child resumed; permission denied"));
      },
    ]);
    const answerCalls = vi.fn();
    main.setResponses([
      () => fauxAssistantMessage(fauxText("genuine user turn")),
      context => {
        const text = JSON.stringify(context);
        expect(text).toContain("UNTRUSTED DATA");
        expect(text).toContain("RAW_PARENT_SECRET");
        const id = /\\"questionId\\":\\"([^\\]+)\\"/.exec(text)?.[1];
        if (!id) throw new Error(`Question ID absent in model context: ${text}`);
        answerCalls();
        return fauxAssistantMessage(fauxToolCall("answer_subagent_question", { questionId: id, answer: "option:1" }), { stopReason: "toolUse" });
      },
      () => fauxAssistantMessage(fauxText("main answered ordinary clarification")),
      () => fauxAssistantMessage(fauxText("completion noticed")),
      () => fauxAssistantMessage(fauxText("completion noticed")),
    ]);
    const image = { type: "image" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=", mimeType: "image/png" };
    await session.prompt("RAW_PARENT_SECRET genuine text", { images: [image] });
    const genuine = session.messages.find(message => message.role === "user");
    const before = structuredClone(genuine);
    prepared.mockClear();
    extensionInputs.mockClear();
    const first = await spawn({ run_in_background: true });
    expect(first).toBeDefined();
    await vi.waitFor(() => expect(child.state.callCount).toBe(1));
    const second = await spawn({ run_in_background: true, supervisor_questions: "off" });
    expect(second.content[0]).toMatchObject({ text: expect.stringContaining("queued") });
    expect(child.state.callCount).toBe(1);
    expect(main.state.callCount).toBe(1);
    release();
    await vi.waitFor(() => expect(answerCalls).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(child.state.callCount).toBe(4));
    expect(confirm).toHaveBeenCalledOnce();
    expect(input).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(prepared).toHaveBeenCalledOnce();
    expect(extensionInputs).toHaveBeenCalledOnce();
    expect(genuine).toEqual(before);
    expect(genuine?.role === "user" && genuine.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image", data: image.data })]));
    const id = /Agent ID: ([^\n]+)/.exec(second.content[0]?.type === "text" ? second.content[0].text : "")?.[1];
    expect(id).toBeDefined();
    await vi.waitFor(() => expect(session.isIdle).toBe(true));
    child.setResponses([
      () => fauxAssistantMessage(fauxToolCall("contact_supervisor", { question: "Foreground cannot wait on its parent" }), { stopReason: "toolUse" }),
      context => {
        expect(JSON.stringify(context)).toContain("No answer");
        return fauxAssistantMessage(fauxText("foreground resumed without blocking"));
      },
    ]);
    const resumed = await spawn({ resume: id, run_in_background: false });
    expect(resumed.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("foreground resumed without blocking") });
    expect(input).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it.each(["admission", "context", "answer"])("fences %s against a real native summary commit before this extension's TREE handler runs", async boundary => {
    const manager = session.sessionManager;
    const target = manager.appendCustomEntry("metadata", { branch: "new" });
    manager.appendMessage({ role: "user", content: "abandoned branch", timestamp: Date.now() });
    manager.appendCustomEntry("metadata", { branch: "original" });
    let openQuestion!: () => void;
    const questionGate = new Promise<void>(resolve => { openQuestion = resolve; });
    let openTree!: () => void;
    const treeGate = new Promise<void>(resolve => { openTree = resolve; });
    let treeReady!: () => void;
    const committed = new Promise<void>(resolve => { treeReady = resolve; });
    earlierTree.mockImplementation(async () => { treeReady(); await treeGate; });
    let id: string | undefined;
    let noAnswer = false;
    child.setResponses([
      async () => {
        if (boundary === "admission") await questionGate;
        return fauxAssistantMessage(fauxToolCall("contact_supervisor", { question: "OLD_BRANCH_QUESTION" }), { stopReason: "toolUse" });
      },
      async (context, options) => {
        expect(JSON.stringify(context)).toContain("No answer");
        noAnswer = true;
        // Avoid unrelated completion notifications while inspecting the race.
        return new Promise(resolve => {
          const stop = () => resolve(fauxAssistantMessage(fauxText("stopped"), { stopReason: "aborted" }));
          if (options.signal?.aborted) stop();
          else options.signal?.addEventListener("abort", stop, { once: true });
        });
      },
    ]);
    main.setResponses([async () => {
      await spawn({ run_in_background: true, supervisor_questions: "parent" });
      if (boundary !== "admission") {
        await vi.waitFor(async () => {
          const messages = await session.extensionRunner.emitContext(session.messages);
          const text = JSON.stringify(messages);
          id = /\\"questionId\\":\\"([^\\]+)\\"/.exec(text)?.[1];
          expect(id).toBeDefined();
        });
      }
      return fauxAssistantMessage(fauxText("native summary"));
    }]);
    const navigation = session.navigateTree(target, { summarize: true });
    try {
      await committed;
      expect(earlierTree).toHaveBeenCalledOnce();
      expect(manager.getBranch().some(entry => entry.type === "branch_summary")).toBe(true);
      // Generation notifications have not reached pi-subagents. Reads must use
      // the native manager's committed metadata ancestry, not model text.
      if (boundary === "admission") openQuestion();
      else if (boundary === "answer") {
        await expect(session.getToolDefinition("answer_subagent_question")!.execute("stale", { questionId: id!, answer: "answer" }, undefined, undefined, ctx)).rejects.toThrow("Unknown");
      }
      const messages = await session.extensionRunner.emitContext(session.messages);
      expect(JSON.stringify(messages)).not.toContain("OLD_BRANCH_QUESTION");
      await vi.waitFor(() => expect(noAnswer).toBe(true));
      expect(main.state.callCount).toBe(1); // summary only, no obsolete wake
    } finally {
      openQuestion();
      openTree();
      await navigation;
    }
  });

  it("fences a resumed channel's new question origin across a native summary commit sharing its original prefix", async () => {
    const manager = session.sessionManager;
    const target = manager.appendCustomEntry("metadata", { branch: "shared-channel-prefix" });
    child.setResponses([() => fauxAssistantMessage(fauxText("terminal child"))]);
    const created = await spawn({ run_in_background: true, supervisor_questions: "parent" });
    const id = (created.details as { agentId: string }).agentId;
    await session.getToolDefinition("get_subagent_result")!.execute("consume", { agent_id: id, wait: true }, undefined, undefined, ctx);
    manager.appendMessage({ role: "user", content: "X_AFTER_CHANNEL", timestamp: Date.now() });
    manager.appendCustomEntry("metadata", { branch: "question-origin-only" });
    let releaseTree!: () => void;
    const treeGate = new Promise<void>(resolve => { releaseTree = resolve; });
    let treeReady!: () => void;
    const committed = new Promise<void>(resolve => { treeReady = resolve; });
    earlierTree.mockImplementation(async () => { treeReady(); await treeGate; });
    let questionId: string | undefined;
    const unanswered = vi.fn();
    child.setResponses([
      () => fauxAssistantMessage(fauxToolCall("contact_supervisor", { question: "RESUMED_OLD_QUESTION" }), { stopReason: "toolUse" }),
      async (context, options) => {
        expect(JSON.stringify(context)).toContain("No answer");
        unanswered();
        return new Promise(resolve => {
          const stop = () => resolve(fauxAssistantMessage(fauxText("stopped"), { stopReason: "aborted" }));
          if (options.signal?.aborted) stop();
          else options.signal?.addEventListener("abort", stop, { once: true });
        });
      },
    ]);
    main.setResponses([async () => {
      await spawn({ resume: id, run_in_background: true });
      await vi.waitFor(async () => {
        const messages = await session.extensionRunner.emitContext(session.messages);
        const text = JSON.stringify(messages);
        questionId = /\\"questionId\\":\\"([^\\]+)\\"/.exec(text)?.[1];
        expect(questionId).toBeDefined();
      });
      return fauxAssistantMessage(fauxText("native summary"));
    }]);
    const navigation = session.navigateTree(target, { summarize: true });
    try {
      await committed;
      expect(manager.getBranch().some(entry => entry.type === "branch_summary")).toBe(true);
      expect(JSON.stringify(manager.getBranch())).not.toContain("X_AFTER_CHANNEL");
      const messages = await session.extensionRunner.emitContext(session.messages);
      expect(JSON.stringify(messages)).not.toContain("RESUMED_OLD_QUESTION");
      await expect(session.getToolDefinition("answer_subagent_question")!.execute("stale", { questionId: questionId!, answer: "answer" }, undefined, undefined, ctx)).rejects.toThrow("Unknown");
      await vi.waitFor(() => expect(unanswered).toHaveBeenCalledOnce());
      expect(main.state.callCount).toBe(1);
    } finally {
      releaseTree();
      await navigation;
    }
  });

  it.each([false, true])("releases an actual native handled child mention without releasing concurrent genuine preparation (%s)", async interleave => {
    let releaseChild!: () => void;
    const childGate = new Promise<void>(resolve => { releaseChild = resolve; });
    let releaseGenuine!: () => void;
    const genuineGate = new Promise<void>(resolve => { releaseGenuine = resolve; });
    let genuine: Promise<void> | undefined;
    const ready = vi.fn();
    const notified = vi.fn((message: string) => {
      if (interleave && message.startsWith("Sent to @")) genuine = session.prompt("CONCURRENT_GENUINE");
    });
    const ui = { ...session.extensionRunner.createContext().ui, notify: notified, setWidget: vi.fn(), onTerminalInput: vi.fn(() => () => {}) };
    await session.bindExtensions({ mode: "tui", uiContext: ui });
    prepared.mockImplementation(async event => {
      if (event.prompt === "CONCURRENT_GENUINE") { ready(); await genuineGate; }
    });
    const answered = vi.fn();
    const asking = vi.fn();
    child.setResponses([
      async () => { await childGate; asking(); return fauxAssistantMessage(fauxToolCall("contact_supervisor", { question: "AFTER_HANDLED_MENTION" }), { stopReason: "toolUse" }); },
      context => { expect(JSON.stringify(context)).toContain("Main agent clarification"); return fauxAssistantMessage(fauxText("done")); },
    ]);
    main.setResponses([
      context => {
        const text = JSON.stringify(context);
        expect(text).toContain("AFTER_HANDLED_MENTION");
        if (interleave) expect(text).toContain("CONCURRENT_GENUINE");
        const questionId = /\\"questionId\\":\\"([^\\]+)\\"/.exec(text)?.[1];
        expect(questionId).toBeDefined();
        answered();
        return fauxAssistantMessage(fauxToolCall("answer_subagent_question", { questionId, answer: "existing authorization only" }), { stopReason: "toolUse" });
      },
      () => fauxAssistantMessage(fauxText("answered")),
    ]);
    const created = await spawn({ run_in_background: true, supervisor_questions: "parent" });
    const id = (created.details as { agentId: string }).agentId;
    const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as { getRecord(id: string): { handle: string } };
    await vi.waitFor(() => expect(child.state.callCount).toBe(1));
    extensionInputs.mockClear();
    await session.prompt(`@${registry.getRecord(id).handle} follow up`);
    expect(notified).toHaveBeenCalledWith(expect.stringContaining("Sent to @"), "info");
    if (interleave) await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
    releaseChild();
    if (interleave) {
      await vi.waitFor(() => expect(asking).toHaveBeenCalledOnce());
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(main.state.callCount).toBe(0);
      expect(extensionInputs).not.toHaveBeenCalled();
      releaseGenuine();
      await genuine;
    }
    await vi.waitFor(() => expect(answered).toHaveBeenCalledOnce());
    const result = await session.getToolDefinition("get_subagent_result")!.execute("consume", { agent_id: id, wait: true }, undefined, undefined, ctx);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("done") });
    await session.waitForIdle();
    expect(extensionInputs).toHaveBeenCalledTimes(interleave ? 0 : 1);
  });

  it("cannot self-answer through a child's model-issued tool call", async () => {
    child.setResponses([
      () => fauxAssistantMessage(fauxToolCall("answer_subagent_question", { questionId: "forged", answer: "approved" }), { stopReason: "toolUse" }),
      context => { expect(JSON.stringify(context)).toMatch(/not found|not available/i); return fauxAssistantMessage(fauxText("no root answering tool")); },
    ]);
    await spawn();
    expect(child.state.callCount).toBe(2);
    expect(main.state.callCount).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each(["retire", "timeout"])("returns structured no-answer after %s through a real child contact tool", async reason => {
    let questionReady!: () => void;
    const ready = new Promise<void>(resolve => { questionReady = resolve; });
    const broker = new ParentQuestionBroker(questionReady, 20);
    let childSession: AgentSession | undefined;
    child.setResponses([
      () => fauxAssistantMessage(fauxToolCall("contact_supervisor", { question: "Which ordinary format?" }), { stopReason: "toolUse" }),
      context => { expect(JSON.stringify(context)).toContain("No answer"); expect(JSON.stringify(context)).not.toContain("Supervisor answered"); return fauxAssistantMessage(fauxText("safe assumption")); },
    ]);
    const pending = runAgent(ctx, "Questioner", "clarify", {
      pi: { exec: async () => ({ code: 1, killed: false, stdout: "", stderr: "" }) } as never,
      agentTier: "child", supervisorQuestions: "parent",
      parentQuestion: (question, choices, signal) => broker.request({ agentId: "original", isCurrent: () => true }, question, choices, signal),
      onSessionCreated: created => { childSession = created; },
    });
    try {
      await ready;
      const id = JSON.parse(broker.context()!.split("\n").at(-1)!)[0].questionId as string;
      if (reason === "retire") broker.retire();
      const result = await pending;
      expect(result.responseText).toBe("safe assumption");
      const contact = result.session.messages.find(message => message.role === "toolResult" && message.toolName === "contact_supervisor");
      expect(contact).toMatchObject({ details: { status: "unanswered" } });
      expect(() => broker.answer(id, "approved")).toThrow("Unknown");
      expect(main.state.callCount).toBe(0);
      expect(input).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      broker.retire();
      if (childSession) await shutdownAndDisposeSession(childSession);
    }
  });

  it("withholds contact_supervisor in a foreground child even when the human UI exists", async () => {
    child.setResponses([
      () => fauxAssistantMessage(fauxToolCall("contact_supervisor", { question: "Ordinary clarification?" }), { stopReason: "toolUse" }),
      context => {
        expect(JSON.stringify(context)).toMatch(/not found|not available/i);
        return fauxAssistantMessage(fauxText("reporting the blocker in the final result"));
      },
    ]);
    await spawn();
    expect(input).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(main.state.callCount).toBe(0);
  });
});
