import { type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParentQuestionBroker, registerParentQuestions } from "../src/parent-questions.js";
import { createSupervisorTool } from "../src/supervisor.js";

afterEach(() => vi.useRealTimers());
const owner = (agentId = "child") => ({ agentId, isCurrent: () => true });
function questionId(broker: ParentQuestionBroker): string {
  return JSON.parse(broker.context()!.split("\n").at(-1)!)[0].questionId;
}

describe("parent clarification broker", () => {
  it("keeps raw choices separate from bounded sanitized display and answers only once", async () => {
    const changed = vi.fn();
    const broker = new ParentQuestionBroker(changed);
    const raw = "raw\u001b[31mchoice";
    const reply = broker.request(owner(), "Question\u001b[31m?", [raw, "other"]);
    const context = broker.context()!;
    const id = JSON.parse(context.split("\n").at(-1)!)[0].questionId;
    expect(context).not.toContain("\u001b");
    expect(changed).toHaveBeenCalledOnce();
    expect(() => broker.answer("forged", "option:1")).toThrow("Unknown");
    expect(() => broker.answer(id, raw)).toThrow("offered option");
    expect(broker.answer(id, "option:1")).toEqual({ status: "answered" });
    expect(broker.answer(id, "option:1")).toEqual({ status: "duplicate" });
    expect(() => broker.answer(id, "option:2")).toThrow("different answer");
    expect(await reply).toEqual({ status: "answered", answer: raw });
    broker.retire();
    expect(() => broker.answer(id, "option:1")).toThrow("Unknown");
  });

  it.each(["retire", "timeout", "abort", "removed", "generation"])("settles %s as no answer, never approval", async reason => {
    vi.useFakeTimers();
    let live = true;
    const broker = new ParentQuestionBroker(vi.fn(), 100);
    const controller = new AbortController();
    const reply = broker.request({ agentId: "original", isCurrent: () => live }, "Which?", undefined, controller.signal);
    const id = questionId(broker);
    if (reason === "retire") broker.retire();
    else if (reason === "timeout") await vi.advanceTimersByTimeAsync(100);
    else if (reason === "abort") controller.abort();
    else { live = false; expect(broker.context()).toBeUndefined(); }
    expect(await reply).toMatchObject({ status: "unanswered" });
    expect(() => broker.answer(id, "approved")).toThrow("Unknown");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds pending requests, rejects invalid data, and coalesces context", async () => {
    const broker = new ParentQuestionBroker(vi.fn());
    expect(await broker.request(owner(), "x".repeat(2_001))).toMatchObject({ status: "unanswered" });
    expect(await broker.request(owner(), "Which?", [" "])).toMatchObject({ status: "unanswered" });
    const replies = Array.from({ length: 16 }, (_, i) => broker.request(owner(`child-${i}`), "Which?"));
    expect(await broker.request(owner("extra"), "Which?")).toMatchObject({ status: "unanswered" });
    expect(await broker.request(owner("child-0"), "Again?")).toMatchObject({ status: "unanswered" });
    expect(JSON.parse(broker.context()!.split("\n").at(-1)!)).toHaveLength(16);
    expect(broker.hasUnannounced()).toBe(false);
    broker.retire();
    expect((await Promise.all(replies)).every(reply => reply.status === "unanswered")).toBe(true);
  });

  it("caps issued one-use IDs without retaining an unbounded history", async () => {
    const broker = new ParentQuestionBroker(vi.fn());
    for (let i = 0; i < 64; i++) {
      const reply = broker.request(owner(), "Which?");
      broker.answer(questionId(broker), "answer");
      expect(await reply).toMatchObject({ status: "answered" });
    }
    expect(await broker.request(owner(), "Which?")).toMatchObject({ status: "unanswered", reason: expect.stringContaining("capacity") });
    broker.retire();
  });

  it("injects parent contact without a human UI and returns structured decline", async () => {
    const broker = new ParentQuestionBroker(vi.fn());
    const tool = createSupervisorTool({ agentLabel: "child", parentQuestion: (question, choices, signal) => broker.request(owner(), question, choices, signal) })[0];
    const reply = tool.execute("contact", { question: "Which?" }, undefined, undefined, {} as ExtensionContext);
    expect(tool.description).toContain("Never use this channel for permission");
    broker.answer(questionId(broker), "");
    expect(await reply).toMatchObject({ details: { status: "unanswered" }, content: [{ text: expect.stringContaining("No answer") }] });
  });
});

describe("root wake gates", () => {
  it.each(["retire", "replacement", "deadline"])("cancels bounded idle-gated compaction recovery on %s", async reason => {
    vi.useFakeTimers();
    const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
    const sendUserMessage = vi.fn();
    let idle = false;
    const manager = SessionManager.inMemory();
    const ctx = { isIdle: () => idle, hasPendingMessages: () => false, sessionManager: manager } as unknown as ExtensionContext;
    const pi = { on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => handlers.set(name, handler), registerTool: () => {}, sendUserMessage } as unknown as ExtensionAPI;
    const runtime = registerParentQuestions(pi, () => ctx);
    const reply = runtime.broker.request(owner(), "pending?");
    await vi.advanceTimersByTimeAsync(1);
    handlers.get("session_compact")!({} as never, ctx);
    await vi.advanceTimersByTimeAsync(50);
    expect(sendUserMessage).not.toHaveBeenCalled();
    if (reason === "retire") runtime.retire();
    else if (reason === "replacement") manager.newSession();
    else await vi.advanceTimersByTimeAsync(30_000);
    idle = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(sendUserMessage).not.toHaveBeenCalled();
    runtime.retire();
    expect(await reply).toMatchObject({ status: "unanswered" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ACKs a proven current frame at context and never lets an old token clear a new flight", async () => {
    vi.useFakeTimers();
    const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
    const sendUserMessage = vi.fn();
    let signal: AbortSignal | undefined;
    const ctx = { get signal() { return signal; }, isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId: () => "root", getBranch: () => [] } } as unknown as ExtensionContext;
    const pi = { on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => handlers.set(name, handler), registerTool: () => {}, sendUserMessage } as unknown as ExtensionAPI;
    const runtime = registerParentQuestions(pi, () => ctx);
    const first = runtime.broker.request(owner("one"), "one?");
    await vi.advanceTimersByTimeAsync(1);
    const firstToken = sendUserMessage.mock.calls[0][0];
    function startFrame(token: string) {
      const accepted = handlers.get("input")!({ text: token, source: "extension" } as never, ctx) as { action: string; text: string };
      expect(accepted.action).toBe("transform");
      const prepared = handlers.get("before_agent_start")!({ prompt: accepted.text } as never, ctx) as { message: { customType: string; content: string; details: unknown } };
      const messages = [{ role: "user", content: [{ type: "text", text: accepted.text }] }, { role: "custom", ...prepared.message }];
      signal = new AbortController().signal;
      handlers.get("agent_start")!({} as never, ctx);
      for (const message of messages) handlers.get("message_start")!({ message } as never, ctx);
      return { messages };
    }
    const event = startFrame(firstToken);
    const context = handlers.get("context_with_system")!(event as never, ctx) as { messages: unknown[] };
    expect(JSON.stringify(context)).toContain("one?");
    expect(runtime.broker.context()).toBeUndefined(); // bounded one-use display
    handlers.get("agent_end")!({} as never, ctx);
    signal = undefined;
    handlers.get("agent_settled")!({} as never, ctx);
    const second = runtime.broker.request(owner("two"), "two?");
    await vi.advanceTimersByTimeAsync(1);
    const secondToken = sendUserMessage.mock.calls[1][0];
    expect(handlers.get("input")!({ text: firstToken, source: "extension" } as never, ctx)).toEqual({ action: "handled" });
    const secondEvent = startFrame(secondToken);
    const secondContext = handlers.get("context_with_system")!(secondEvent as never, ctx) as { messages: unknown[] };
    expect(JSON.stringify(secondContext)).toContain("two?");
    expect(JSON.stringify(secondContext)).not.toContain("one?");
    await vi.advanceTimersByTimeAsync(30_001);
    expect(sendUserMessage).toHaveBeenCalledTimes(2);
    runtime.retire();
    expect(await first).toMatchObject({ status: "unanswered" });
    expect(await second).toMatchObject({ status: "unanswered" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps ambiguous admissions without recycling their identity or rewriting quoted user data", async () => {
    vi.useFakeTimers();
    const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
    const sendUserMessage = vi.fn();
    const abort = vi.fn();
    let signal: AbortSignal | undefined;
    const ctx = { get signal() { return signal; }, abort, isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId: () => "root", getBranch: () => [] } } as unknown as ExtensionContext;
    const pi = { on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => handlers.set(name, handler), registerTool: () => {}, sendUserMessage } as unknown as ExtensionAPI;
    const runtime = registerParentQuestions(pi, () => ctx);
    let firstToken = "";
    for (let i = 0; i < 16; i++) {
      const reply = runtime.broker.request(owner(), "private?");
      await vi.advanceTimersByTimeAsync(1);
      const token = sendUserMessage.mock.calls[i][0];
      const admitted = handlers.get("input")!({ text: token, source: "extension" } as never, ctx) as { action: string; text: string };
      expect(admitted.action).toBe("transform");
      if (i === 0) firstToken = admitted.text;
      const image = { type: "image", data: "unchanged", mimeType: "image/png" };
      expect(handlers.get("input")!({ text: admitted.text, source: "interactive", images: [image] } as never, ctx)).toEqual({ action: "continue" });
      expect(await reply).toMatchObject({ status: "unanswered", reason: expect.stringContaining("ambiguous") });
      expect(handlers.get("before_agent_start")!({ prompt: admitted.text } as never, ctx)).toBeUndefined();
      // Repeated copies and retirement do not recycle the ambiguous slot.
      runtime.retire();
      signal = new AbortController().signal;
      handlers.get("agent_start")!({} as never, ctx);
      const user = { role: "user", content: [{ type: "text", text: admitted.text }, image] };
      const original = structuredClone(user);
      handlers.get("message_start")!({ message: user } as never, ctx);
      expect(handlers.get("context_with_system")!({ messages: [user] } as never, ctx)).toEqual({ messages: [original] });
      expect(user).toEqual(original);
      handlers.get("agent_end")!({} as never, ctx);
      signal = undefined;
      handlers.get("agent_settled")!({} as never, ctx);
    }
    const exhausted = runtime.broker.request(owner(), "capacity?");
    await vi.advanceTimersByTimeAsync(1);
    expect(sendUserMessage).toHaveBeenCalledTimes(17);
    expect(handlers.get("input")!({ text: sendUserMessage.mock.calls[16][0], source: "extension" } as never, ctx)).toEqual({ action: "handled" });
    expect(handlers.get("before_agent_start")!({ prompt: firstToken } as never, ctx)).toBeUndefined();
    expect(abort).not.toHaveBeenCalled();
    runtime.retire();
    expect(await exhausted).toMatchObject({ status: "unanswered" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { kind: "native image hint", copied: true, suffix: "\n\n[Image: original 4096x4096, displayed at 2000x2000.]", suppress: true },
    { kind: "arbitrary prose after token boundary", copied: true, suffix: "\n\nUser-authored prose, not an SDK hint.", suppress: true },
    { kind: "adjacent suffix", copied: true, suffix: "-user-suffix", suppress: false },
    { kind: "leading prose", copied: true, suffix: "", suppress: false },
    { kind: "forged MAC", copied: true, suffix: "\n\n[Image: original 4096x4096.]", suppress: false },
    { kind: "generic hint only", copied: true, suffix: "", suppress: false },
    { kind: "unambiguous authenticated token", copied: false, suffix: "\n\n[Image: original 4096x4096.]", suppress: false },
  ])("requires token authentication, a boundary, and current ambiguity, not hint prose ($kind)", async ({ kind, copied, suffix, suppress }) => {
    vi.useFakeTimers();
    const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
    const sendUserMessage = vi.fn();
    const abort = vi.fn();
    const ctx = { signal: new AbortController().signal, abort, isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId: () => "root", getBranch: () => [] } } as unknown as ExtensionContext;
    const pi = { on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => handlers.set(name, handler), registerTool: () => {}, sendUserMessage } as unknown as ExtensionAPI;
    const runtime = registerParentQuestions(pi, () => ctx);
    const first = runtime.broker.request(owner(), "original?");
    await vi.advanceTimersByTimeAsync(1);
    const admission = handlers.get("input")!({ text: sendUserMessage.mock.calls[0][0], source: "extension" } as never, ctx) as { action: string; text: string };
    expect(admission.action).toBe("transform");
    if (copied) handlers.get("input")!({ text: admission.text, source: "interactive" } as never, ctx);
    const next = runtime.broker.request(owner("other-child"), "new question?");
    let text = `${admission.text}${suffix}`;
    if (kind === "leading prose") text = `Quote ${admission.text}\n\n[Image: original 4096x4096.]`;
    if (kind === "forged MAC") text = `${admission.text.slice(0, -1)}${admission.text.endsWith("0") ? "1" : "0"}${suffix}`;
    if (kind === "generic hint only") text = "Ordinary user text\n\n[Image: original 4096x4096.]";
    const user = { role: "user", content: [{ type: "text", text }, { type: "image", data: "verbatim", mimeType: "image/png" }] };
    const original = structuredClone(user);
    handlers.get("agent_start")!({} as never, ctx);
    handlers.get("message_start")!({ message: user } as never, ctx);
    const result = handlers.get("context_with_system")!({ messages: [user] } as never, ctx) as { messages: unknown[] };
    expect(result.messages[0]).toEqual(original);
    expect(user).toEqual(original);
    expect(JSON.stringify(result.messages).includes("new question?")).toBe(!suppress);
    expect(runtime.broker.hasUnannounced()).toBe(suppress);
    expect(abort).not.toHaveBeenCalled();
    runtime.retire();
    expect(await first).toMatchObject({ status: "unanswered" });
    expect(await next).toMatchObject({ status: "unanswered" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not wake at agent_end; coalesces once after safe settlement without editing user text/images", async () => {
    vi.useFakeTimers();
    const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
    const tools: unknown[] = [];
    let idle = false;
    let pending = false;
    const sendUserMessage = vi.fn();
    const ctx = { isIdle: () => idle, hasPendingMessages: () => pending, sessionManager: { getSessionId: () => "root", getBranch: () => [] } } as unknown as ExtensionContext;
    const pi = { on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => handlers.set(name, handler), registerTool: (tool: unknown) => tools.push(tool), sendUserMessage } as unknown as ExtensionAPI;
    const runtime = registerParentQuestions(pi, () => ctx);
    const first = runtime.broker.request(owner("one"), "one?");
    const second = runtime.broker.request(owner("two"), "two?");
    await vi.advanceTimersByTimeAsync(1);
    expect(sendUserMessage).not.toHaveBeenCalled();
    handlers.get("agent_end")?.({} as never, ctx);
    await vi.advanceTimersByTimeAsync(1);
    expect(sendUserMessage).not.toHaveBeenCalled();
    idle = true;
    pending = true;
    handlers.get("agent_settled")?.({} as never, ctx);
    await vi.advanceTimersByTimeAsync(1);
    expect(sendUserMessage).not.toHaveBeenCalled();
    pending = false;
    handlers.get("ui_prompt_start")?.({} as never, ctx);
    handlers.get("agent_settled")?.({} as never, ctx);
    await vi.advanceTimersByTimeAsync(1);
    expect(sendUserMessage).not.toHaveBeenCalled();
    handlers.get("ui_prompt_end")?.({} as never, ctx);
    await vi.advanceTimersByTimeAsync(1);
    expect(sendUserMessage).toHaveBeenCalledOnce();
    expect(sendUserMessage.mock.calls[0][1]).toEqual({ deliverAs: "followUp" });
    const user = { role: "user", content: [{ type: "text", text: "genuine\u001buser" }, { type: "image", data: "original", mimeType: "image/png" }] };
    const original = structuredClone(user);
    const event = { messages: [user] };
    const injected = handlers.get("context_with_system")!(event as never, ctx) as { messages: unknown[] };
    expect(injected.messages[0]).toBe(user);
    expect(user).toEqual(original);
    expect(event.messages).toEqual([original]);
    handlers.get("agent_settled")?.({} as never, ctx);
    await vi.advanceTimersByTimeAsync(1);
    expect(sendUserMessage).toHaveBeenCalledOnce();
    runtime.retire();
    expect(await first).toMatchObject({ status: "unanswered" });
    expect(await second).toMatchObject({ status: "unanswered" });
    expect(vi.getTimerCount()).toBe(0);
    expect(tools).toHaveLength(1);
  });
});
