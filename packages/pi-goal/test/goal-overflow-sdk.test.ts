import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import goal from "../src/goal.js";
import type { ActiveGoal, GoalStateEntryData } from "../src/persistence.js";

const OVERFLOW = "Your input exceeds the context window of this model";

// Real host overflow recovery, compaction and prompt dispatch. No paid model.
describe.skipIf(VERSION !== "1.4.0")("goal continuation after a context overflow on installed Pi 1.4.0", () => {
  let cwd: string;
  let agentDir: string;
  let previousAgentDir: string | undefined;
  let faux: ReturnType<typeof fauxProvider>;
  let runtime: ModelRuntime;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "goal-overflow-"));
    agentDir = join(cwd, "agent");
    mkdirSync(agentDir);
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    faux = fauxProvider({ provider: "goal-overflow", models: [{ id: "goal", contextWindow: 200_000 }] });
    runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    runtime.registerNativeProvider(faux.provider);
    await runtime.refresh({ allowNetwork: false });
  });

  afterEach(() => {
    faux.setResponses([]);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
  });

  it("blocks once with compaction advice, starts no continuation, and continues after compaction and resume", async () => {
    const settingsPath = join(agentDir, "goal.json");
    writeFileSync(settingsPath, JSON.stringify({ toolVisibility: "always" }));
    const manager = SessionManager.inMemory(cwd);
    // Earlier history gives compaction something to summarize once it is allowed.
    manager.appendMessage({ role: "user", content: "earlier work", timestamp: Date.now() });
    manager.appendMessage(fauxAssistantMessage("earlier answer"));
    const current: ActiveGoal = {
      id: "current",
      status: "active",
      text: "finish current",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      iteration: 1,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      baselineTokens: 0,
      automaticModelTurns: 0,
      toolFreeRepeatCount: 0,
    };
    manager.appendCustomEntry("goal-state", { goal: current });
    const state = () =>
      manager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === "goal-state")
        .at(-1)?.data as GoalStateEntryData;
    let cancelCompaction = true;
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noExtensions: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        { name: "goal", factory: (pi) => goal(pi, { settingsPath }) },
        {
          // Stands in for a compaction owner that cancels Pi's overflow recovery, then
          // supplies its own summary for an explicit compaction.
          name: "compaction",
          factory: (pi) => {
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
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model: registry.find("goal-overflow", "goal"),
      modelRuntime: runtime,
      modelRegistry: registry,
      resourceLoader: loader,
      sessionManager: manager,
      tools: ["goal_complete", "goal_blocked", "goal_wait"],
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true, keepRecentTokens: 1 },
        retry: { enabled: false },
      }),
    });
    const notify = vi.fn<(message: string, level?: string) => void>();
    try {
      await session.bindExtensions({ mode: "rpc", uiContext: { ...session.extensionRunner.getUIContext(), notify } });
      const overflowNotices = () =>
        notify.mock.calls.filter(([message]) => message.includes("context exceeds the model's window"));

      faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW })]);
      await session.prompt("keep going");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(faux.state.callCount).toBe(1);
      expect(state().goal).toMatchObject({ id: "current", status: "blocked" });
      expect(overflowNotices()).toEqual([
        [
          `Goal blocked: the context exceeds the model's window: ${OVERFLOW}. Run /compact, or start a new session, then /goal resume.`,
          "warning",
        ],
      ]);

      cancelCompaction = false;
      await session.compact();
      const prompts: string[] = [];
      const lastUserText = (context: TranscriptContext) => {
        const user = context.messages.filter((message) => message.role === "user").at(-1);
        if (typeof user?.content === "string") return user.content;
        return (user?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
      };
      faux.setResponses([
        (context) => {
          prompts.push(lastUserText(context));
          return fauxAssistantMessage("Made progress.");
        },
        (context) => {
          prompts.push(lastUserText(context));
          const goalId = /<goal_id>\s*([^<\s]+)\s*<\/goal_id>/.exec(prompts.at(-1) ?? "")?.[1] ?? "missing";
          return fauxAssistantMessage(
            fauxToolCall("goal_complete", { goal_id: goalId, summary: "Implemented and verified every requirement." }),
            { stopReason: "toolUse" },
          );
        },
      ]);
      await session.prompt("/goal resume");
      await vi.waitFor(() => expect(prompts).toHaveLength(2), { timeout: 5000 });
      await vi.waitFor(() => expect(session.isIdle).toBe(true));
      expect(prompts[1]).toContain("pi-goal-continuation");
      expect(state().goal).toBeNull();
      expect(overflowNotices()).toHaveLength(1);
    } finally {
      session.dispose();
    }
  });
});
