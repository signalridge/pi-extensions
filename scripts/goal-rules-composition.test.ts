import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import goal from "../packages/pi-goal/src/goal.js";
import { registerRules } from "../packages/pi-rules/src/extension.js";

for (const order of ["Goal->Rules", "Rules->Goal"]) {
  test(`${order} preserves structured Goal guidance, always rules and on-demand index in the actual request`, async () => {
    const root = mkdtempSync(join(tmpdir(), "goal-rules-"));
    const agentDir = join(root, "agent");
    mkdirSync(join(agentDir, "rules"), { recursive: true });
    writeFileSync(join(agentDir, "rules", "always.md"), "---\nalwaysApply: true\n---\nRULE_SENTINEL");
    writeFileSync(join(agentDir, "rules", "index.md"), "---\ndescription: INDEX_SENTINEL\n---\nRead on demand");
    const settingsPath = join(root, "goal.json");
    writeFileSync(settingsPath, JSON.stringify({ toolVisibility: "always" }));
    const faux = fauxProvider({ provider: "goal-rules", models: [{ id: "offline" }] });
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    runtime.registerNativeProvider(faux.provider);
    await runtime.refresh({ allowNetwork: false });
    const manager = SessionManager.inMemory(root);
    const now = Date.now();
    manager.appendCustomEntry("goal-state", {
      goal: {
        id: "goal",
        text: "GOAL_SENTINEL",
        status: "active",
        startedAt: now,
        updatedAt: now,
        iteration: 0,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        baselineTokens: 0,
        automaticModelTurns: 0,
        toolFreeRepeatCount: 0,
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const factories = [
      { name: "goal", factory: (pi) => goal(pi, { settingsPath }) },
      { name: "rules", factory: (pi) => registerRules(pi, { agentDir: () => agentDir }) },
    ] satisfies NonNullable<ConstructorParameters<typeof DefaultResourceLoader>[0]>["extensionFactories"];
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: order === "Goal->Rules" ? factories : factories.reverse(),
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: root,
      agentDir,
      model: faux.getModel(),
      modelRuntime: runtime,
      settingsManager,
      sessionManager: manager,
      resourceLoader: loader,
      tools: ["goal_complete", "goal_blocked", "goal_wait", "read_rule"],
    });
    try {
      await session.bindExtensions({ mode: "print" });
      let prompt = "";
      faux.setResponses([
        (context) => {
          prompt = getCurrentSystemPrompt(context.messages);
          return fauxAssistantMessage(
            fauxToolCall("goal_complete", { goal_id: "goal", summary: "Verified composition." }),
            { stopReason: "toolUse" },
          );
        },
      ]);
      await session.prompt("Finish the goal");
      for (const sentinel of ["RULE_SENTINEL", "INDEX_SENTINEL", "GOAL_SENTINEL", "Active /goal"])
        assert.ok(prompt.includes(sentinel), `${order}: missing ${sentinel}`);
    } finally {
      session.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
