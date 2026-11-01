/**
 * Pending parent questions ride on the request context. Pi 1.4 folds every
 * mid-conversation system message into the leading one when a `context` handler
 * changes the message list, which moves the cached prompt prefix on every request
 * that carries a question. Ported from nicobailon/pi-subagents f45abdb9.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { type AgentMessage, type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionContext, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerParentQuestions } from "../src/parent-questions.js";
import { shutdownAndDisposeSession } from "../src/session-lifecycle.js";

describe("parent questions on the native request context", () => {
  let root: string;
  let session: AgentSession;
  let provider: ReturnType<typeof fauxProvider>;
  let questions: ReturnType<typeof registerParentQuestions>;
  let current: ExtensionContext | undefined;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "question-system-sdk-"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    provider = fauxProvider({ provider: "question-system", models: [{ id: "main", contextWindow: 200_000 }] });
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    runtime.registerNativeProvider(provider.provider);
    await runtime.refresh({ allowNetwork: false });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, noExtensions: true, noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: [
      { name: "questions", factory: api => {
        questions = registerParentQuestions(api, () => current);
        api.on("session_start", (_event, ctx) => { current = ctx; });
        api.on("session_shutdown", () => { questions.retire(); current = undefined; });
      } },
    ] });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: root, agentDir, model: provider.getModel(), modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), resourceLoader: loader, sessionManager: SessionManager.inMemory(root), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) }));
    await session.bindExtensions({});
  });
  afterEach(async () => {
    await shutdownAndDisposeSession(session);
    rmSync(root, { recursive: true, force: true });
  });

  it("appends a pending question without moving Pi's system messages", async () => {
    void questions.broker.request({ agentId: "child", isCurrent: () => true }, "Which database?");
    const leading: AgentMessage = { role: "system", content: "Base prompt", timestamp: 0 };
    const user: AgentMessage = { role: "user", content: "hello", timestamp: 1 };
    const assistant = fauxAssistantMessage("hi", { timestamp: 2 });
    // A mid-conversation section update must stay where it is, or the cached prefix ends before it.
    const sectionUpdate: AgentMessage = { role: "system", content: "", sections: { time: "Now: 10:00" }, timestamp: 3 };
    const next: AgentMessage = { role: "user", content: "continue", timestamp: 4 };

    const messages = await session.extensionRunner.emitContext([leading, user, assistant, sectionUpdate, next]);

    expect(messages.slice(0, 5)).toEqual([leading, user, assistant, sectionUpdate, next]);
    expect(messages).toHaveLength(6);
    expect(messages[5]).toMatchObject({ role: "custom", customType: "subagent-questions", content: expect.stringContaining("Which database?") });
  });
});
