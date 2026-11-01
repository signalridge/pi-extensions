import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionAPI, type ExtensionContext, type InputEvent, type InputEventResult, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PARENT_QUESTION_WAKE_ACK_MS, registerParentQuestions } from "../src/parent-questions.js";
import { captureQuestionOrigin } from "../src/question-origin.js";
import { shutdownAndDisposeSession } from "../src/session-lifecycle.js";

function pngImage(size: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6; // RGBA, one unfiltered white row per scanline.
  const rowSize = size * 4 + 1;
  const pixels = Buffer.alloc(rowSize * size, 255);
  for (let row = 0; row < size; row++) pixels[row * rowSize] = 0;
  const bytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
  return { type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" };
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe("question outbox on native SDK INPUT and preparation", () => {
  let root: string;
  let session: AgentSession;
  let runtime: ModelRuntime;
  let provider: ReturnType<typeof fauxProvider>;
  let questions: ReturnType<typeof registerParentQuestions>;
  let current: ExtensionContext | undefined;
  let pi: ExtensionAPI;
  let input: ReturnType<typeof vi.fn<(event: InputEvent) => Promise<InputEventResult | undefined>>>;
  let before: ReturnType<typeof vi.fn>;
  let laterBefore: ReturnType<typeof vi.fn>;
  let ownedInput: ReturnType<typeof vi.fn<(event: InputEvent) => Promise<InputEventResult>>>;
  let nativeErrors: ReturnType<typeof vi.fn>;
  let tokens: string[];
  let laterMessage: ReturnType<typeof vi.fn>;
  let settlements: ReturnType<typeof vi.fn>;
  let disableGuard: () => void;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "question-outbox-sdk-"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    provider = fauxProvider({ provider: "outbox-native", models: [{ id: "main", contextWindow: 200_000 }] });
    runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    runtime.registerNativeProvider(provider.provider);
    await runtime.refresh({ allowNetwork: false });
    tokens = [];
    input = vi.fn(async () => undefined);
    before = vi.fn();
    laterBefore = vi.fn();
    ownedInput = vi.fn(async () => ({ action: "continue" }));
    nativeErrors = vi.fn();
    laterMessage = vi.fn();
    settlements = vi.fn();

    const loader = new DefaultResourceLoader({ cwd: root, agentDir, noExtensions: true, noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: [
      { name: "earlier-native-hooks", factory: api => {
        api.on("input", async event => {
          if (event.source === "extension") tokens.push(event.text);
          return input(event);
        });
        api.on("before_agent_start", before);
      } },
      { name: "outbox", factory: api => {
        pi = api;
        const subscriptions: (() => void)[] = [];
        const on: ExtensionAPI["on"] = (event, handler) => {
          const off = api.on(event, handler);
          subscriptions.push(off);
          return off;
        };
        questions = registerParentQuestions({ ...api, on }, () => current);
        disableGuard = () => { for (const off of subscriptions) off(); };
        api.on("input", questions.observeHandledInput(ownedInput));
        api.on("before_agent_start", laterBefore);
        api.on("message_start", async (event, ctx) => laterMessage("start", event, ctx));
        api.on("message_end", async (event, ctx) => laterMessage("end", event, ctx));
        api.on("agent_settled", (_event, ctx) => settlements(ctx.signal));
        api.on("session_start", (_event, ctx) => { current = ctx; });
        api.on("session_shutdown", () => { questions.retire(); current = undefined; });
      } },
    ] });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: root, agentDir, model: provider.getModel(), modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), resourceLoader: loader, sessionManager: SessionManager.inMemory(root), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) }));
    await session.bindExtensions({ onError: nativeErrors });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await shutdownAndDisposeSession(session);
    provider.setResponses([]);
    rmSync(root, { recursive: true, force: true });
  });
  function ask(agentId = "child", signal?: AbortSignal) {
    const isCurrent = captureQuestionOrigin(current!);
    return questions.broker.request({ agentId, isCurrent: () => isCurrent(current) }, "PRIVATE_QUESTION", undefined, signal);
  }

  it.each(["cancel", "timeout", "retire", "replacement"])("consumes authenticated %s wakes after an earlier native INPUT await without persisting or calling a provider", async reason => {
    vi.useFakeTimers();
    const gate = barrier();
    input.mockImplementation(async event => { if (event.source === "extension") await gate.promise; return undefined; });
    const controller = new AbortController();
    const reply = ask("child", controller.signal);
    await vi.advanceTimersByTimeAsync(1);
    expect(tokens).toHaveLength(1);
    const token = tokens[0];
    if (reason === "cancel") controller.abort();
    else if (reason === "timeout") await vi.advanceTimersByTimeAsync(120_000);
    else if (reason === "retire") questions.retire();
    else {
      // Same ID, distinct public manager identity; no lifecycle notification needed.
      const replacement = SessionManager.inMemory(root);
      replacement.newSession({ id: current!.sessionManager.getSessionId() });
      current = { ...current!, sessionManager: replacement };
    }
    gate.release();
    await vi.advanceTimersByTimeAsync(1);
    expect(await reply).toMatchObject({ status: "unanswered" });
    expect(provider.state.callCount).toBe(0);
    expect(session.messages.some(message => JSON.stringify(message).includes(token))).toBe(false);
    expect(before).not.toHaveBeenCalled();
    // Historical recognition is authenticated, not an unbounded token set.
    input.mockResolvedValue(undefined);
    await session.sendUserMessage(token);
    expect(provider.state.callCount).toBe(0);
  });

  it("leaves a foreign exact literal, forged MAC, and interactive own literal as genuine inputs", async () => {
    vi.useFakeTimers();
    input.mockResolvedValue({ action: "handled" });
    const reply = ask();
    await vi.advanceTimersByTimeAsync(1);
    const token = tokens[0];
    questions.retire();
    expect(await reply).toMatchObject({ status: "unanswered" });
    input.mockResolvedValue(undefined);
    const literal = "Check current opted-in subagent clarifications in the extension context. If none remain, no answer is needed.";
    const forged = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    provider.setResponses([context => {
      expect(JSON.stringify(context)).toContain(literal);
      return fauxAssistantMessage(fauxText("ordinary"));
    }, context => {
      expect(JSON.stringify(context)).toContain(forged);
      return fauxAssistantMessage(fauxText("ordinary"));
    }, context => {
      expect(JSON.stringify(context)).toContain(token);
      return fauxAssistantMessage(fauxText("ordinary"));
    }]);
    await session.sendUserMessage(literal);
    await session.sendUserMessage(forged);
    await session.prompt(token);
    expect(provider.state.callCount).toBe(3);
  });

  it("does not overlap an observed genuine prompt preparing in an earlier before_agent_start await", async () => {
    const gate = barrier();
    before.mockImplementation(async event => { if (event.prompt === "GENUINE_TEXT") await gate.promise; });
    provider.setResponses([context => {
      expect(JSON.stringify(context)).toContain("GENUINE_TEXT");
      expect(JSON.stringify(context)).toContain("PRIVATE_QUESTION");
      return fauxAssistantMessage(fauxText("genuine preserved"));
    }]);
    const genuine = session.prompt("GENUINE_TEXT");
    await vi.waitFor(() => expect(before).toHaveBeenCalledOnce());
    expect(session.isIdle).toBe(false); // Pi 1.2+ counts the starting run as busy.
    const reply = ask();
    // Flush the outbox timer, not a speculative model poll.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(tokens).toEqual([]);
    expect(provider.state.callCount).toBe(0);
    gate.release();
    await genuine;
    expect(provider.state.callCount).toBe(1);
    expect(session.messages.filter(message => message.role === "user")).toHaveLength(1);
    questions.retire();
    expect(await reply).toMatchObject({ status: "unanswered" });
  });

  it.each(["handled", "native-auth-rejection"])("bounds an unacknowledged %s attempt to 30s and lets later questions recover without model polling", async failure => {
    vi.useFakeTimers();
    if (failure === "handled") input.mockResolvedValue({ action: "handled" });
    else {
      runtime.registerNativeProvider({ ...provider.provider, auth: { apiKey: { name: "Unavailable fixture credential", resolve: async () => undefined } } });
      await runtime.refresh({ allowNetwork: false });
    }
    const reply = ask();
    await vi.advanceTimersByTimeAsync(1);
    expect(tokens).toHaveLength(1);
    expect(before).not.toHaveBeenCalled();
    expect(provider.state.callCount).toBe(0);
    await vi.advanceTimersByTimeAsync(PARENT_QUESTION_WAKE_ACK_MS);
    expect(await reply).toMatchObject({ status: "unanswered", reason: expect.stringContaining("acknowledged") });
    expect(tokens).toHaveLength(1); // explicit no-answer recovery, no retries
    input.mockResolvedValue(undefined);
    runtime.registerNativeProvider(provider.provider);
    await runtime.refresh({ allowNetwork: false });
    provider.setResponses([context => {
      expect(JSON.stringify(context)).toContain("PRIVATE_QUESTION");
      return fauxAssistantMessage(fauxText("current question"));
    }]);
    const recovered = ask("new-child");
    await vi.advanceTimersByTimeAsync(1);
    await session.waitForIdle();
    expect(provider.state.callCount).toBe(1);
    expect(before).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(PARENT_QUESTION_WAKE_ACK_MS);
    expect(tokens).toHaveLength(2); // acknowledged question never gets another turn
    questions.retire();
    expect(await recovered).toMatchObject({ status: "unanswered" });
    expect(pi).toBeDefined();
  });

  it("refuses the answering capability even when a child registers the root definition under an alias", async () => {
    const reply = ask();
    const id = JSON.parse(questions.broker.context()!.split("\n").at(-1)!)[0].questionId;
    const original = session.getToolDefinition("answer_subagent_question")!;
    const childProvider = fauxProvider({ provider: "answer-alias-child", models: [{ id: "child", contextWindow: 200_000 }] });
    runtime.registerNativeProvider(childProvider.provider);
    await runtime.refresh({ allowNetwork: false });
    childProvider.setResponses([
      () => fauxAssistantMessage(fauxToolCall("alias_answer", { questionId: id, answer: "approved" }), { stopReason: "toolUse" }),
      context => { expect(JSON.stringify(context)).toContain("No current root question owner"); return fauxAssistantMessage(fauxText("refused")); },
    ]);
    const agentDir = join(root, "agent");
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, noExtensions: true, noContextFiles: true, noThemes: true, extensionFactories: [api => { api.registerTool({ ...original, name: "alias_answer" }); }] });
    await loader.reload();
    const manager = SessionManager.inMemory(root);
    manager.newSession({ id: current!.sessionManager.getSessionId() });
    const { session: child } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model: childProvider.getModel(), resourceLoader: loader, sessionManager: manager, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) });
    try {
      await child.bindExtensions({});
      await child.prompt("try alias");
      expect(childProvider.state.callCount).toBe(2);
      expect(provider.state.callCount).toBe(0);
      questions.retire();
      expect(await reply).toMatchObject({ status: "unanswered" });
    } finally { await shutdownAndDisposeSession(child); }
  });

  it("suppresses provider dispatch when a question is cancelled during native preparation", async () => {
    const gate = barrier();
    before.mockImplementation(async () => { await gate.promise; });
    const controller = new AbortController();
    const reply = ask("child", controller.signal);
    await vi.waitFor(() => expect(before).toHaveBeenCalledOnce());
    controller.abort();
    expect(await reply).toMatchObject({ status: "unanswered" });
    await new Promise(resolve => setTimeout(resolve, 10));
    gate.release();
    await session.waitForIdle();
    expect(provider.state.callCount).toBe(0);
  });

  it.each(["steer", "followUp"] as const)("keeps an accepted wake frame out of the model when genuine input queues (%s) into its starting run, preserving genuine text and images", async delivery => {
    const wakeGate = barrier();
    const wakes = vi.fn();
    laterBefore.mockImplementation(async () => { wakes(); await wakeGate.promise; });
    const image = pngImage(1);
    const contexts: string[] = [];
    provider.setResponses(Array.from({ length: 2 }, (_, index) => context => {
      contexts.push(JSON.stringify(context));
      return fauxAssistantMessage(fauxText(`genuine preserved ${index + 1}`));
    }));
    const reply = ask();
    await vi.waitFor(() => expect(wakes).toHaveBeenCalledOnce());
    // Pi 1.2+ counts the starting wake run as busy and queues input into it
    // instead of preparing a second, competing prompt.
    expect(session.isIdle).toBe(false);
    await session.prompt("GENUINE_TEXT", { images: [image], streamingBehavior: delivery });
    wakeGate.release();
    await vi.waitFor(() => expect(session.messages.some(message => message.role === "custom" && message.customType.startsWith("subagent-question-frame:"))).toBe(true));
    await session.waitForIdle();
    expect(wakes).toHaveBeenCalledOnce();
    // Steering joins the frame's first request; a follow-up waits for its answer.
    if (delivery === "steer") {
      expect(provider.state.callCount).toBe(1);
      expect(contexts[0]).toContain("GENUINE_TEXT");
      expect(contexts[0]).toContain("PRIVATE_QUESTION");
    } else {
      expect(provider.state.callCount).toBe(2);
      expect(contexts[0]).toContain("PRIVATE_QUESTION");
      expect(contexts[0]).not.toContain("GENUINE_TEXT");
      expect(contexts[1]).toContain("GENUINE_TEXT");
    }
    for (const context of contexts) {
      expect(context).not.toContain("pi-subagents-question-wake:");
      expect(context).not.toContain("subagent-question-frame:");
    }
    // Native provider errors are message data: assert the response too so an
    // assertion inside the provider callback cannot pass as a swallowed error.
    expect(session.messages.filter(message => message.role === "assistant")).toEqual(contexts.map((_, index) => expect.objectContaining({ content: [{ type: "text", text: `genuine preserved ${index + 1}` }] })));
    const users = session.messages.filter(message => message.role === "user");
    expect(users).toContainEqual({ role: "user", content: [{ type: "text", text: "GENUINE_TEXT" }, image], timestamp: expect.any(Number) });
    expect(questions.broker.context()).toBeUndefined();
    // That request was the wake's one-use ACK, so the next question wakes at once.
    const answered = provider.state.callCount;
    provider.setResponses([context => {
      expect(JSON.stringify(context)).toContain("PRIVATE_QUESTION");
      return fauxAssistantMessage(fauxText("next wake"));
    }]);
    const next = ask("next-child");
    await vi.waitFor(() => expect(provider.state.callCount).toBe(answered + 1));
    await session.waitForIdle();
    expect(tokens).toHaveLength(2);
    // Verbatim original control token is still a genuine prompt, with no proof.
    laterBefore.mockReset();
    const calls = provider.state.callCount;
    provider.setResponses([context => {
      expect(JSON.stringify(context)).toContain(tokens[0]);
      expect(JSON.stringify(context)).not.toContain("PRIVATE_QUESTION");
      return fauxAssistantMessage(fauxText("literal preserved"));
    }]);
    await session.prompt(tokens[0]);
    expect(provider.state.callCount).toBe(calls + 1);
    expect(session.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "literal preserved" }] });
    const proof = session.messages.find(message => message.role === "custom" && message.customType.startsWith("subagent-question-frame:"));
    const frameToken = proof?.role === "custom" ? (proof.details as { token: string }).token : undefined;
    expect(frameToken).toBeDefined();
    provider.setResponses([context => {
      expect(JSON.stringify(context)).toContain(frameToken);
      expect(JSON.stringify(context)).not.toContain("PRIVATE_QUESTION");
      return fauxAssistantMessage(fauxText("historical frame literal preserved"));
    }]);
    await session.prompt(frameToken!);
    expect(provider.state.callCount).toBe(calls + 2);
    expect(session.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "historical frame literal preserved" }] });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(tokens).toHaveLength(2);
    questions.retire();
    expect(await reply).toMatchObject({ status: "unanswered" });
    expect(await next).toMatchObject({ status: "unanswered" });
  });

  it.each(["steer", "followUp"] as const)("never aborts genuine %s input queued into a wake run whose question is cancelled during preparation", async delivery => {
    const wakeGate = barrier();
    const responseGate = barrier();
    const wakeReady = vi.fn();
    laterBefore.mockImplementation(async () => { wakeReady(); await wakeGate.promise; });
    provider.setResponses([async (context, options) => {
      if (delivery === "steer") expect(JSON.stringify(context)).toContain("GENUINE_TEXT");
      await responseGate.promise;
      expect(options.signal?.aborted).toBe(false);
      return fauxAssistantMessage(fauxText("genuine survived stale wake"));
    }, context => {
      expect(JSON.stringify(context)).toContain("GENUINE_TEXT");
      return fauxAssistantMessage(fauxText("follow-up actually delivered"));
    }]);
    const controller = new AbortController();
    const reply = ask("child", controller.signal);
    await vi.waitFor(() => expect(wakeReady).toHaveBeenCalledOnce());
    await session.prompt("GENUINE_TEXT", { streamingBehavior: delivery });
    // The frame is stale before its run starts, but the steered input is not.
    controller.abort();
    expect(await reply).toMatchObject({ status: "unanswered", reason: "cancelled" });
    wakeGate.release();
    await vi.waitFor(() => expect(provider.state.callCount).toBe(1));
    responseGate.release();
    await session.waitForIdle();
    expect(provider.state.callCount).toBe(delivery === "steer" ? 1 : 2);
    expect(session.messages).toContainEqual(expect.objectContaining({ role: "assistant", content: [{ type: "text", text: delivery === "steer" ? "genuine survived stale wake" : "follow-up actually delivered" }] }));
    expect(session.messages.filter(message => message.role === "assistant").map(message => message.role === "assistant" && message.stopReason)).toEqual(delivery === "steer" ? ["stop"] : ["stop", "stop"]);
    expect(nativeErrors).not.toHaveBeenCalled();
    questions.retire();
  });

  it.each([true, false].flatMap(guard => ["preparation", "start-user", "end-user", "start-proof", "end-proof"].map(boundary => ({ guard, boundary }))))("refuses a busy prompt at a wake boundary without a competing settlement ($boundary, guard=$guard)", async ({ boundary, guard }) => {
    const wakeGate = barrier();
    const messageGate = barrier();
    const reached = vi.fn();
    let ownerSignal: AbortSignal | undefined;
    laterBefore.mockImplementation(async () => {
      if (boundary !== "preparation") return;
      reached();
      await wakeGate.promise;
    });
    laterMessage.mockImplementation(async (phase, event, ctx) => {
      const kind = event.message.role === "user" ? "user" : event.message.role === "custom" && event.message.customType.startsWith("subagent-question-frame:") ? "proof" : "other";
      if (`${phase}-${kind}` !== boundary) return;
      ownerSignal = ctx.signal;
      reached();
      await messageGate.promise;
    });
    const contexts: string[] = [];
    provider.setResponses([context => {
      contexts.push(JSON.stringify(context));
      return fauxAssistantMessage(fauxText("wake answered"));
    }]);
    const reply = ask();
    await vi.waitFor(() => expect(reached).toHaveBeenCalledOnce());
    if (!guard) disableGuard();
    // Pi 1.2+ refuses a busy prompt before preparing it, so it can neither
    // start a competing run nor emit a competing settlement.
    expect(await session.prompt("GENUINE_TEXT").then(() => "completed", error => String(error))).toContain("already processing");
    expect(settlements).not.toHaveBeenCalled();
    if (boundary !== "preparation") expect(ownerSignal?.aborted).toBe(false);
    wakeGate.release();
    messageGate.release();
    await vi.waitFor(() => expect(settlements).toHaveBeenCalledOnce());
    await session.waitForIdle();
    expect(provider.state.callCount).toBe(1);
    expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "wake answered" }] });
    expect(contexts[0]).not.toContain("GENUINE_TEXT");
    // The refused prompt does not supersede the executing frame.
    expect(contexts[0].includes("PRIVATE_QUESTION")).toBe(guard);
    expect(questions.broker.hasUnannounced()).toBe(!guard);
    expect(nativeErrors).not.toHaveBeenCalled();
    questions.retire();
    expect(await reply).toMatchObject({ status: "unanswered" });
  });

  it.each([true, false].flatMap(guard => [true, false].flatMap(images => (["steer", "followUp"] as const).map(delivery => ({ guard, images, delivery })))))("fails closed when an interactive input copies an unprepared frame token ($delivery, images=$images, guard=$guard)", async ({ delivery, images, guard }) => {
    const wakeGate = barrier();
    let frameToken: string | undefined;
    let first = true;
    before.mockImplementation(async event => {
      if (first) { first = false; frameToken = event.prompt; await wakeGate.promise; }
    });
    const image = pngImage(1);
    const contexts: string[] = [];
    provider.setResponses(Array.from({ length: 3 }, () => context => {
      contexts.push(JSON.stringify(context));
      return fauxAssistantMessage(fauxText("literal survived"));
    }));
    const reply = ask();
    await vi.waitFor(() => expect(frameToken).toBeDefined());
    if (!guard) disableGuard();
    const content = [{ type: "text", text: frameToken }, ...(images ? [image] : [])];
    // Pi 1.2+ queues input typed while the wake run starts into that run.
    await session.prompt(frameToken!, { images: images ? [image] : undefined, streamingBehavior: delivery });
    wakeGate.release();
    await vi.waitFor(() => expect(settlements).toHaveBeenCalledOnce());
    await session.waitForIdle();
    const calls = delivery === "steer" ? 1 : 2;
    expect(provider.state.callCount).toBe(calls);
    expect(contexts.every(context => !context.includes("PRIVATE_QUESTION"))).toBe(true);
    // The disabled control still has W's earlier native dispatch snapshot;
    // only W can receive that proof, never the copied interactive input.
    const proofs = session.messages.filter(message => message.role === "custom" && message.customType.startsWith("subagent-question-frame:"));
    expect(proofs).toHaveLength(guard ? 0 : 1);
    const genuineIndex = session.messages.findLastIndex(message => message.role === "user");
    expect(session.messages[genuineIndex]).toEqual({ role: "user", content, timestamp: expect.any(Number) });
    expect(session.messages[genuineIndex + 1]).not.toMatchObject({ role: "custom", customType: expect.stringMatching(/^subagent-question-frame:/) });
    expect(session.messages.filter(message => message.role === "assistant")).toHaveLength(calls);
    expect(nativeErrors).not.toHaveBeenCalled();
    if (!guard) {
      questions.retire();
      expect(await reply).toMatchObject({ status: "unanswered" });
      return;
    }
    expect(await reply).toMatchObject({ status: "unanswered", reason: expect.stringContaining("ambiguous") });
    before.mockReset();
    laterBefore.mockReset();
    const recovered = ask("new-child");
    await session.prompt("ordinary recovery");
    expect(contexts.at(-1)).toContain("PRIVATE_QUESTION");
    questions.retire();
    expect(await recovered).toMatchObject({ status: "unanswered" });
  });

  it.each(["refused", "steer"] as const)("keeps a copied ambiguous frame question-inert after default AUTO 4096 PNG normalization (first copy %s)", async firstCopy => {
    expect(session.settingsManager.getImageAutoResize()).toBe(true);
    const image = pngImage(4096);
    const original = structuredClone(image);
    // A plain native turn supplies the real SDK normalization reference. No
    // normalizer, Photon, resize profile, worker, or image path is mocked.
    provider.setResponses([() => fauxAssistantMessage(fauxText("image reference"))]);
    await session.prompt("IMAGE_REFERENCE", { images: [image] });
    const reference = session.messages.find(message => message.role === "user");
    if (reference?.role !== "user" || typeof reference.content === "string") throw new Error("Missing image reference");
    const referenceText = reference.content[0];
    expect(referenceText).toMatchObject({ type: "text", text: expect.stringContaining("original 4096x4096, displayed at 2000x2000") });
    const normalizedImage = reference.content[1];
    expect(normalizedImage?.type).toBe("image");
    if (normalizedImage?.type !== "image" || referenceText.type !== "text") throw new Error("SDK omitted image");
    expect(normalizedImage.data === image.data).toBe(false);
    const resized = Buffer.from(normalizedImage.data, "base64");
    expect(resized.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect([resized.readUInt32BE(16), resized.readUInt32BE(20)]).toEqual([2000, 2000]);
    const hint = referenceText.text.slice("IMAGE_REFERENCE".length);
    before.mockClear();
    laterBefore.mockClear();

    const wakeGate = barrier();
    let frameToken: string | undefined;
    before.mockImplementation(async event => {
      if (frameToken === undefined) { frameToken = event.prompt; await wakeGate.promise; }
    });
    const contexts: string[] = [];
    const modelUsers: unknown[] = [];
    const signals: AbortSignal[] = [];
    provider.setResponses(Array.from({ length: 4 }, () => (context, options) => {
      contexts.push(JSON.stringify(context));
      modelUsers.push(...context.messages.filter(message => message.role === "user"));
      if (options.signal) signals.push(options.signal);
      return fauxAssistantMessage(fauxText("copied image survived"));
    }));
    const reply = ask();
    await vi.waitFor(() => expect(frameToken).toBeDefined());
    const next = ask("another-child"); // Q must stay pending through the copied wake frame.
    let later: ReturnType<typeof ask> | undefined;
    const baselineSettlements = settlements.mock.calls.length;
    try {
      // Pi 1.2+ counts the starting wake run as busy: a copy typed meanwhile is
      // refused or queued into that run, unnormalized. Either way INPUT saw it.
      const copied = await session.prompt(frameToken!, { images: [image], streamingBehavior: firstCopy === "steer" ? "steer" : undefined })
        .then(() => "queued", error => String(error));
      if (firstCopy === "steer") expect(copied).toBe("queued");
      else expect(copied).toContain("already processing");
      expect(await reply).toMatchObject({ status: "unanswered", reason: expect.stringContaining("ambiguous") });
      wakeGate.release();
      // W's copied frame stays question-inert; once idle, the question still
      // pending through it gets its own wake.
      await vi.waitFor(() => expect(settlements).toHaveBeenCalledTimes(baselineSettlements + 2));
      await session.waitForIdle();
      expect(tokens).toHaveLength(2);
      expect(contexts).toHaveLength(2);
      expect(contexts[0]).not.toContain("PRIVATE_QUESTION");
      expect(contexts[1]).toContain("PRIVATE_QUESTION");
      expect(questions.broker.hasUnannounced()).toBe(false);
      // The same copy submitted while idle is its own native run, and the SDK
      // appends its resize hint after the token. A question raised as it is
      // submitted must not be announced through the copied frame.
      later = ask("later-child");
      await session.prompt(frameToken!, { images: [image] });
      expect(settlements).toHaveBeenCalledTimes(baselineSettlements + 3);
      expect(provider.state.callCount).toBe(4); // reference, W (with any steered copy), Q wake, G; no abort.
      expect(contexts).toHaveLength(3);
      expect(contexts[2]).not.toContain("PRIVATE_QUESTION");
      expect(questions.broker.hasUnannounced()).toBe(true);
      expect(signals).toHaveLength(3);
      expect(signals.every(signal => !signal.aborted)).toBe(true);
      expect(session.messages.filter(message => message.role === "assistant" && message.stopReason === "aborted")).toHaveLength(0);
      const genuineIndex = session.messages.findIndex(message => message.role === "user" && typeof message.content !== "string" && message.content[0]?.type === "text" && message.content[0].text === `${frameToken}${hint}`);
      const genuineUser = session.messages[genuineIndex];
      expect(genuineUser).toBeDefined();
      // Only the later genuine wake carries a proof, never a copied frame.
      expect(session.messages.filter(message => message.role === "custom" && message.customType.startsWith("subagent-question-frame:"))).toHaveLength(1);
      expect(session.messages[genuineIndex + 1]).not.toMatchObject({ role: "custom", customType: expect.stringMatching(/^subagent-question-frame:/) });
      const expectedContent = [{ type: "text", text: `${frameToken}${hint}` }, normalizedImage];
      expect(genuineUser?.role === "user" && genuineUser.content).toEqual(expectedContent);
      expect(modelUsers).toContainEqual(expect.objectContaining({ role: "user", content: expectedContent }));
      expect(image).toEqual(original);
      expect(nativeErrors).not.toHaveBeenCalled();
      before.mockReset();
      laterBefore.mockReset();
      await session.prompt("ordinary recovery");
      expect(contexts.at(-1)).toContain("PRIVATE_QUESTION");
      expect(questions.broker.hasUnannounced()).toBe(false);
    } finally {
      wakeGate.release();
      await session.waitForIdle();
      questions.retire();
    }
    expect(await next).toMatchObject({ status: "unanswered" });
    expect(await later).toMatchObject({ status: "unanswered" });
  });

  it.each(["handled", "throw"])("uses native %s semantics for input-scoped own readiness without releasing another preparing prompt", async outcome => {
    const mentionGate = barrier();
    const genuineGate = barrier();
    const genuineReady = vi.fn();
    ownedInput.mockImplementation(async event => {
      if (event.text !== "@child mention") return { action: "continue" };
      await mentionGate.promise;
      if (outcome === "throw") throw new Error("owned input fixture failed");
      return { action: "handled" };
    });
    laterBefore.mockImplementation(async event => {
      if (event.prompt === "GENUINE_TEXT") { genuineReady(); await genuineGate.promise; }
    });
    provider.setResponses([() => fauxAssistantMessage(fauxText("first"))]);
    const mention = session.prompt("@child mention");
    await vi.waitFor(() => expect(ownedInput).toHaveBeenCalledOnce());
    const genuine = session.prompt("GENUINE_TEXT");
    await vi.waitFor(() => expect(genuineReady).toHaveBeenCalledOnce());
    const reply = ask();
    mentionGate.release();
    // Pi 1.2+ counts the preparing genuine run as busy: a mention that native
    // INPUT continues after the throw is refused instead of preparing too.
    const mentionOutcome = await mention.then(() => "completed", error => String(error));
    if (outcome === "handled") expect(mentionOutcome).toBe("completed");
    else expect(mentionOutcome).toContain("already processing");
    expect(laterBefore).toHaveBeenCalledOnce();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(tokens).toEqual([]);
    expect(provider.state.callCount).toBe(0);
    genuineGate.release();
    await genuine;
    questions.retire();
    expect(await reply).toMatchObject({ status: "unanswered" });
  });

  it("releases a native own handled input so the next child question can wake immediately", async () => {
    ownedInput.mockResolvedValue({ action: "handled" });
    await session.prompt("@child mention");
    expect(before).not.toHaveBeenCalled();
    ownedInput.mockResolvedValue({ action: "continue" });
    provider.setResponses([context => {
      expect(JSON.stringify(context)).toContain("PRIVATE_QUESTION");
      return fauxAssistantMessage(fauxText("awake"));
    }]);
    const reply = ask();
    await vi.waitFor(() => expect(provider.state.callCount).toBe(1));
    await session.waitForIdle();
    questions.retire();
    expect(await reply).toMatchObject({ status: "unanswered" });
  });

  it("recovers after a native model response promise rejects, without redelivering an acknowledged question", async () => {
    provider.setResponses([async () => { throw new Error("native response failed"); }]);
    const first = ask();
    await vi.waitFor(() => expect(provider.state.callCount).toBe(1));
    await session.waitForIdle();
    expect(questions.broker.context()).toBeUndefined();
    provider.setResponses([context => {
      expect(JSON.stringify(context)).toContain("PRIVATE_QUESTION");
      return fauxAssistantMessage(fauxText("recovered"));
    }]);
    const second = ask("new-child");
    await vi.waitFor(() => expect(provider.state.callCount).toBe(2));
    await session.waitForIdle();
    expect(tokens).toHaveLength(2);
    questions.retire();
    expect(await first).toMatchObject({ status: "unanswered" });
    expect(await second).toMatchObject({ status: "unanswered" });
  });

  it("refuses an idle wake when an earlier native INPUT await starts genuine work", async () => {
    const gate = barrier();
    const answer = vi.fn(context => {
      expect(JSON.stringify(context)).toContain("PRIVATE_QUESTION");
      return fauxAssistantMessage(fauxText("followup"));
    });
    provider.setResponses([async () => { await gate.promise; return fauxAssistantMessage(fauxText("first")); }, answer]);
    const reply = ask();
    input.mockImplementation(async event => {
      if (event.source === "extension") {
        // A different extension starts work during its earlier INPUT hook.
        input.mockResolvedValue(undefined);
        void session.prompt("genuine");
        await vi.waitFor(() => expect(provider.state.callCount).toBe(1));
      }
      return undefined;
    });
    await vi.waitFor(() => expect(tokens).toHaveLength(1));
    // Our input fence refuses to queue an obsolete idle wake. The question
    // instead joins the current genuine model context/next observed turn.
    gate.release();
    await session.waitForIdle();
    expect(tokens).toHaveLength(1);
    expect(before).toHaveBeenCalledOnce();
    expect(provider.state.callCount).toBe(1);
    questions.retire();
    expect(await reply).toMatchObject({ status: "unanswered" });
  });
});
