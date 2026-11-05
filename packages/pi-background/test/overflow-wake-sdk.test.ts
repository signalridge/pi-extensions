import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import background from "../src/extension.js";
import { MESSAGE_TYPE } from "../src/notifications.js";

const OVERFLOW = "Your input exceeds the context window of this model";

// Real host loader, lifecycle, overflow recovery and provider dispatch. No paid model.
describe.skipIf(VERSION !== "1.5.0" || process.platform === "win32")(
  "background wakes after a context overflow",
  () => {
    let cwd: string;
    let previousAgentDir: string | undefined;
    let session: AgentSession;
    let faux: ReturnType<typeof fauxProvider>;
    let notify: ReturnType<typeof vi.fn<(message: string, level?: string) => void>>;
    let prompts: string[];
    let cancelCompaction: boolean;

    beforeEach(async () => {
      cwd = mkdtempSync(join(tmpdir(), "background-overflow-"));
      const agentDir = join(cwd, "agent");
      mkdirSync(agentDir);
      previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      faux = fauxProvider({ provider: "background-overflow", models: [{ id: "main", contextWindow: 200_000 }] });
      const runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        allowModelNetwork: false,
      });
      runtime.registerNativeProvider(faux.provider);
      await runtime.refresh({ allowNetwork: false });
      prompts = [];
      cancelCompaction = true;
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        noExtensions: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
          { name: "background", factory: background },
          {
            name: "probes",
            factory: (pi) => {
              pi.registerVirtualModel({
                provider: "background-router",
                id: "small",
                name: "Offline small router",
                contextWindow: 8000,
                route: () => ({ model: faux.getModel(), thinkingLevel: "off" }),
              });
              pi.on("before_agent_start", (event) => {
                prompts.push(event.messageType === "custom" ? `custom:${event.message.customType}` : event.prompt);
              });
              // Stands in for a compaction owner that cancels Pi's overflow recovery, then
              // supplies its own summary for an explicit compaction.
              pi.on("session_before_compact", (event) =>
                cancelCompaction
                  ? { cancel: true }
                  : {
                      compaction: {
                        summary: "compacted",
                        firstKeptEntryId: event.preparation.firstKeptEntryId,
                        tokensBefore: event.preparation.tokensBefore,
                      },
                    },
              );
            },
          },
        ],
      });
      await loader.reload();
      const registry = new ModelRegistry(runtime);
      ({ session } = await createAgentSession({
        cwd,
        agentDir,
        model: registry.find("background-overflow", "main"),
        modelRuntime: runtime,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: ["bash_background"],
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: true, keepRecentTokens: 1 },
          retry: { enabled: false },
        }),
      }));
      notify = vi.fn();
      await session.bindExtensions({ mode: "rpc", uiContext: { ...session.extensionRunner.getUIContext(), notify } });
    });

    afterEach(async () => {
      await session.abort();
      await session.reload(); // Public reload tears down any remaining jobs.
      session.dispose();
      faux.setResponses([]);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(cwd, { recursive: true, force: true });
    });

    const events = () =>
      session.sessionManager
        .getBranch()
        .flatMap((entry) =>
          entry.type === "custom_message" && entry.customType === MESSAGE_TYPE && typeof entry.content === "string"
            ? [entry.content]
            : [],
        );
    const overflowNotices = () =>
      notify.mock.calls.filter(([message]) => message.startsWith("Context exceeds the model's window"));
    // Each job exits when the test releases it, so every event lands at a known point.
    const job = (name: string) =>
      fauxToolCall("bash_background", {
        command: `while [ ! -e ${join(cwd, name)} ]; do sleep 0.05; done; printf ${name}-done`,
        notify: "turn",
      });
    const release = (name: string) => writeFileSync(join(cwd, name), "");

    it.each([
      { input: 20_000, repair: "none", wakes: true },
      { input: 250_000, repair: "none", wakes: false },
      { input: 250_000, repair: "shorten", wakes: true },
      { input: 250_000, repair: "omit", wakes: true },
    ])("SDK physical-window process wake and persisted repair: %j", async ({ input, repair, wakes }) => {
      const ctx = session.extensionRunner.createToolContext("routed", undefined);
      const router = ctx.modelRegistry.find("background-router", "small");
      if (!router) throw new Error("Missing router fixture");
      await session.setModel(router);
      const call = job("routed");
      const tool = session.getToolDefinition("bash_background");
      if (!tool) throw new Error("Missing background tool fixture");
      await tool.execute("routed", call.arguments, undefined, undefined, ctx);
      const manager = session.sessionManager;
      const user = manager.appendMessage({ role: "user", content: "original long input", timestamp: Date.now() });
      const assistant = manager.appendMessage({
        ...fauxAssistantMessage("answer"),
        provider: faux.getModel().provider,
        model: faux.getModel().id,
        usage: { ...fauxAssistantMessage("").usage, input, totalTokens: input },
      });
      if (repair !== "none")
        manager.appendContextEdit(
          repair === "omit" ? assistant : user,
          repair === "omit" ? null : { content: "short" },
        );
      faux.setResponses([fauxAssistantMessage("received")]);
      release("routed");
      await vi.waitFor(() => expect(events()).toHaveLength(1), { timeout: 5000 });
      if (wakes) await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
      else expect(faux.state.callCount).toBe(0);
      await vi.waitFor(() => expect(session.isIdle).toBe(true));
      expect(overflowNotices()).toHaveLength(wakes ? 0 : 1);
    });

    it("records exits without re-running an overflowed parent, notices once, and wakes again after compaction", async () => {
      // An earlier turn gives compaction something to summarize once it is allowed.
      faux.setResponses([
        fauxAssistantMessage("Warmed up."),
        fauxAssistantMessage([job("first"), job("second"), job("third")], { stopReason: "toolUse" }),
        fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW }),
      ]);
      await session.prompt("Warm up.");
      await session.prompt("Start three jobs.");
      await vi.waitFor(() => expect(session.isIdle).toBe(true));
      expect(faux.state.callCount).toBe(3);
      faux.setResponses([
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 503 temporarily unavailable" }),
      ]);
      await session.prompt("Retry oversized context.");
      expect(faux.state.callCount).toBe(4);

      release("first");
      await vi.waitFor(() => expect(events()).toEqual([expect.stringContaining("first-done")]), { timeout: 5000 });
      release("second");
      await vi.waitFor(() => expect(events()).toHaveLength(2), { timeout: 5000 });
      expect(events()[1]).toContain("second-done");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(faux.state.callCount).toBe(4);
      expect(prompts).toEqual(["Warm up.", "Start three jobs.", "Retry oversized context."]);
      expect(overflowNotices()).toEqual([
        [
          "Context exceeds the model's window; background process events are added to the conversation without starting a turn. Run /compact, or start a new session.",
          "warning",
        ],
      ]);

      cancelCompaction = false;
      await session.compact();
      const wake = vi.fn(() => fauxAssistantMessage("Exit received."));
      faux.setResponses([wake]);
      release("third");
      await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce(), { timeout: 5000 });
      await vi.waitFor(() => expect(session.isIdle).toBe(true));
      expect(prompts).toHaveLength(4);
      expect(prompts[3]).toContain("Background process wake [");
      expect(events()).toHaveLength(3);
      expect(overflowNotices()).toHaveLength(1);
    });
  },
);
