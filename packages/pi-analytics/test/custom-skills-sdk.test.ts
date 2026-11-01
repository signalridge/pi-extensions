import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { type AnalyticsStorePort, createAnalyticsExtension } from "../src/analytics.js";
import type { SettledRun } from "../src/types.js";

for (const reload of [false, true]) {
  test(`first custom SDK run discovers and attributes an actual SKILL.md read (reload=${reload})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "analytics-custom-skill-"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    const skillPath = join(root, "SKILL.md");
    writeFileSync(skillPath, "---\nname: probe\ndescription: Offline skill\n---\nSKILL_BODY");
    const runs: SettledRun[] = [];
    const store: AnalyticsStorePort = {
      path: root,
      recordRun: async (run) => {
        runs.push(run);
      },
      getSnapshot: async () => {
        throw new Error("not used");
      },
      clearAll: async () => ({ cleanupIncomplete: false }),
      close: async () => {},
    };
    const faux = fauxProvider({ provider: "analytics-custom", models: [{ id: "offline" }] });
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    runtime.registerNativeProvider(faux.provider);
    await runtime.refresh({ allowNetwork: false });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noThemes: true,
      noPromptTemplates: true,
      skillsOverride: () => ({
        skills: [
          {
            name: "probe",
            description: "Offline skill",
            filePath: skillPath,
            baseDir: root,
            source: "test",
            disableModelInvocation: false,
          },
        ],
        diagnostics: [],
      }),
      extensionFactories: [createAnalyticsExtension({ createStore: () => store, getAgentDir: () => agentDir })],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: root,
      agentDir,
      model: faux.getModel(),
      modelRuntime: runtime,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(root),
      tools: ["read"],
    });
    try {
      const errors: string[] = [];
      await session.bindExtensions({
        mode: "print",
        onError: (error) => {
          errors.push(error.message);
        },
      });
      if (reload) await session.reload();
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("read", { path: skillPath }), { stopReason: "toolUse" }),
        fauxAssistantMessage("read"),
      ]);
      await session.sendCustomMessage(
        { customType: "test-wake", content: "Read the skill", display: false },
        { triggerTurn: true },
      );
      assert.deepEqual(errors, []);
      assert.equal(runs[0]?.triggerSource, "extension");
      assert.deepEqual(
        runs[0]?.skills.map(({ name, initiatedBy }) => ({ name, initiatedBy })),
        [{ name: "probe", initiatedBy: "model" }],
      );
      faux.setResponses([fauxAssistantMessage("user skill")]);
      await session.prompt("/skill:probe");
      assert.equal(runs[1]?.triggerSource, "interactive");
      assert.deepEqual(
        runs[1]?.skills.map(({ name, initiatedBy }) => ({ name, initiatedBy })),
        [{ name: "probe", initiatedBy: "user" }],
      );
    } finally {
      session.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
