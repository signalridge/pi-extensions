import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import goal from "../src/goal.js";
import type { GoalStateEntryData } from "../src/persistence.js";
import { GOAL_SAFETY_PAUSE_CONTEXT_TYPE } from "../src/prompts.js";

test("native custom notifications reach the provider with authoritative safety-pause state, never an implicit resume", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "goal-pause-sdk-"));
  const settingsPath = join(cwd, "goal.json");
  writeFileSync(settingsPath, JSON.stringify({ toolVisibility: "always" }));
  const faux = fauxProvider({ provider: "goal-pause-faux", models: [{ id: "test", contextWindow: 200_000 }] });
  const runtime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({ allowNetwork: false });
  const registry = new ModelRegistry(runtime);
  const manager = SessionManager.inMemory(cwd);
  manager.appendCustomEntry("goal-state", {
    goal: {
      id: "capped-goal",
      text: "Finish work",
      status: "active",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      iteration: 2,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      baselineTokens: 0,
      automaticModelTurns: 25,
      toolFreeRepeatCount: 0,
    },
  });
  const state = () =>
    manager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === "goal-state")
      .at(-1)?.data as GoalStateEntryData;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    noExtensions: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [{ name: "goal", factory: (pi) => goal(pi, { settingsPath }) }],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    modelRuntime: runtime,
    modelRegistry: registry,
    model: registry.find("goal-pause-faux", "test"),
    sessionManager: manager,
    resourceLoader: loader,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  });
  try {
    await session.bindExtensions({});
    expect(state().goal).toMatchObject({
      id: "capped-goal",
      status: "paused",
      automaticModelTurns: 25,
      safetyPauseCause: "continuation_limit",
    });
    let requests = 0;
    const noticeText = (context: TranscriptContext) => JSON.stringify(context.messages);
    faux.setResponses([
      (context: TranscriptContext) => {
        requests++;
        expect(noticeText(context)).toContain("Goal paused: continuation_limit (25/25). Explicit resume required");
        expect(noticeText(context)).toContain("not Goal automatic execution");
        return fauxAssistantMessage(
          fauxToolCall("goal_wait", { goal_id: "capped-goal", reason: "Waiting for another job" }),
          { stopReason: "toolUse" },
        );
      },
      (context: TranscriptContext) => {
        requests++;
        expect(noticeText(context)).toContain("goal_wait rejected: Goal paused: continuation_limit (25/25)");
        return fauxAssistantMessage("The background job finished; Goal remains safety-paused pending /goal resume.");
      },
    ]);
    await session.sendCustomMessage(
      { customType: "background-complete", content: "Background job finished", display: true },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    expect(requests).toBe(2);
    expect(state().goal).toMatchObject({
      id: "capped-goal",
      status: "paused",
      automaticModelTurns: 25,
      safetyPauseCause: "continuation_limit",
    });
    expect(session.messages.some((m) => m.role === "custom" && m.customType === GOAL_SAFETY_PAUSE_CONTEXT_TYPE)).toBe(
      false,
    );

    faux.setResponses([
      (context: TranscriptContext) => {
        requests++;
        expect(noticeText(context)).not.toContain("Goal runtime state (authoritative for this request)");
        expect(state().goal?.id).not.toBe("capped-goal");
        expect(state().goal?.automaticModelTurns).toBe(0);
        return fauxAssistantMessage(
          fauxToolCall("goal_complete", { goal_id: state().goal?.id, summary: "Implemented and verified" }),
          { stopReason: "toolUse" },
        );
      },
    ]);
    await session.prompt("/goal resume");
    await session.agent.waitForIdle();
    expect(requests).toBe(3);
    expect(state().goal).toBeNull();
  } finally {
    await session.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});
