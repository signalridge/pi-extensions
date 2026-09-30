import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>(
    "../src/agent-runner.js",
  );
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

vi.setConfig({ testTimeout: 30_000 });

describe.skipIf(!VERSION.startsWith("0.99."))(
  "Pi 0.99 SDK summary navigation",
  () => {
    let cwd = "";
    let agentDir = "";
    let oldAgentDir: string | undefined;
    let oldCwd = "";
    let faux: ReturnType<typeof fauxProvider>;
    let runtime: ModelRuntime;
    let registry: ModelRegistry;

    beforeEach(async () => {
      cwd = mkdtempSync(join(tmpdir(), "navigation-sdk-"));
      agentDir = join(cwd, "agent-dir");
      mkdirSync(agentDir);
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(
        join(cwd, ".pi", "subagents.json"),
        JSON.stringify({ schedulingEnabled: false }),
      );
      oldAgentDir = process.env.PI_CODING_AGENT_DIR;
      oldCwd = process.cwd();
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.chdir(cwd);
      faux = fauxProvider({
        provider: "navigation-faux",
        models: [{ id: "summary", contextWindow: 200_000 }],
      });
      runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        allowModelNetwork: false,
      });
      runtime.registerNativeProvider(faux.provider);
      await runtime.refresh({ allowNetwork: false });
      registry = new ModelRegistry(runtime);
      vi.mocked(runAgent).mockReset();
    });

    afterEach(() => {
      faux.setResponses([]);
      process.chdir(oldCwd);
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      for (const key of [
        "pi-subagents:manager",
        "pi-subagents:manager-active",
        "pi-subagents:rpc-owner",
      ]) {
        delete (globalThis as Record<symbol, unknown>)[Symbol.for(key)];
      }
      rmSync(cwd, { recursive: true, force: true });
    });

    it.each(["aborted", "error"])(
      "keeps a worker alive after real SDK summary %s and journals only on old ancestry",
      async (outcome) => {
        const model = registry.find("navigation-faux", "summary");
        if (!model) throw new Error("Navigation test model was not registered");
        let piRef: ExtensionAPI | undefined;
        const loader = new DefaultResourceLoader({
          cwd,
          agentDir,
          noExtensions: true,
          noContextFiles: true,
          noPromptTemplates: true,
          noThemes: true,
          extensionFactories: [
            {
              name: "navigation-subagents",
              factory: (pi) => {
                piRef = pi;
                subagentsExtension(pi);
              },
            },
          ],
        });
        await loader.reload();
        const manager = SessionManager.inMemory(cwd);
        const target = manager.appendCustomEntry("ancestor", {
          value: "target",
        });
        manager.appendMessage({
          role: "user",
          content: "old work to summarize",
          timestamp: Date.now(),
        });
        let resolveWorker:
          ((value: Awaited<ReturnType<typeof runAgent>>) => void) | undefined;
        let workerSignal: AbortSignal | undefined;
        vi.mocked(runAgent).mockImplementation(
          (_ctx, _type, _prompt, options) => {
            workerSignal = options.signal;
            return new Promise((resolve) => {
              resolveWorker = resolve;
            });
          },
        );
        const { session } = await createAgentSession({
          cwd,
          agentDir,
          model,
          modelRuntime: runtime,
          modelRegistry: registry,
          resourceLoader: loader,
          sessionManager: manager,
          settingsManager: SettingsManager.inMemory({
            compaction: { enabled: false },
            retry: { enabled: false },
          }),
          noTools: "all",
        });
        try {
          await session.bindExtensions({});
          const oldLeaf = manager.getLeafId();
          const registry = (globalThis as Record<symbol, unknown>)[
            Symbol.for("pi-subagents:manager")
          ] as
            | {
                spawn: (
                  pi: ExtensionAPI,
                  ctx: ExtensionContext,
                  type: string,
                  prompt: string,
                  options: object,
                ) => string;
              }
            | undefined;
          expect(registry).toBeDefined();
          faux.setResponses([
            async () => {
              registry?.spawn(
                piRef!,
                session.extensionRunner.createContext(),
                "general-purpose",
                "work",
                {
                  description: "started during summary",
                },
              );
              await vi.waitFor(() => expect(workerSignal).toBeDefined());
              if (outcome === "aborted") session.abortBranchSummary();
              return fauxAssistantMessage(fauxText("summary failed"), {
                stopReason: outcome === "aborted" ? "aborted" : "error",
              });
            },
          ]);

          if (outcome === "aborted") {
            expect(
              await session.navigateTree(target, { summarize: true }),
            ).toMatchObject({ cancelled: true, aborted: true });
          } else {
            await expect(
              session.navigateTree(target, { summarize: true }),
            ).rejects.toThrow();
          }
          expect(manager.getLeafId()).toBe(oldLeaf);
          expect(workerSignal?.aborted).toBe(false);
          resolveWorker?.({
            responseText: "old worker completed",
            session: { dispose: vi.fn() } as never,
            aborted: false,
            steered: false,
          } as Awaited<ReturnType<typeof runAgent>>);
          await vi.waitFor(() =>
            expect(
              manager
                .getBranch()
                .some(
                  (entry) =>
                    entry.type === "custom" &&
                    entry.customType === "subagents:record",
                ),
            ).toBe(true),
          );
          const terminal = manager
            .getBranch()
            .find(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === "subagents:record",
            );
          expect(terminal).toBeDefined();

          expect(await session.navigateTree(target)).toMatchObject({
            cancelled: false,
          });
          expect(
            manager.getBranch().some((entry) => entry.id === terminal?.id),
          ).toBe(false);
          expect(
            manager.getEntries().some((entry) => entry.id === terminal?.id),
          ).toBe(true);
        } finally {
          await session.extensionRunner.emit({
            type: "session_shutdown",
            reason: "quit",
          });
          session.dispose();
        }
      },
    );

    it.each(["subagents-first", "workflows-first"])(
      "does not append an owned stop on the committed summary branch in %s order",
      async (order) => {
        const model = registry.find("navigation-faux", "summary");
        if (!model) throw new Error("Navigation test model was not registered");
        const subagentsPath = fileURLToPath(
          new URL("../src/index.ts", import.meta.url),
        );
        const workflowsPath = fileURLToPath(
          new URL("../../pi-workflows/src/index.ts", import.meta.url),
        );
        const extensionPaths =
          order === "subagents-first"
            ? [subagentsPath, workflowsPath]
            : [workflowsPath, subagentsPath];
        const loader = new DefaultResourceLoader({
          cwd,
          agentDir,
          noExtensions: true,
          noContextFiles: true,
          noPromptTemplates: true,
          noThemes: true,
          additionalExtensionPaths: extensionPaths,
        });
        await loader.reload();
        const loaded = loader.getExtensions();
        expect(loaded.errors).toEqual([]);
        expect(loaded.extensions.map((extension) => extension.path)).toEqual(
          expect.arrayContaining(extensionPaths),
        );
        expect(
          loaded.extensions
            .find((extension) => extension.path === workflowsPath)
            ?.handlers.has("session_start"),
        ).toBe(true);
        const manager = SessionManager.inMemory(cwd);
        const target = manager.appendCustomEntry("ancestor", {
          value: "target",
        });
        manager.appendMessage({
          role: "user",
          content: "old branch to summarize",
          timestamp: Date.now(),
        });
        let childStarted = false;
        let childAborted = false;
        const { session } = await createAgentSession({
          cwd,
          agentDir,
          model,
          modelRuntime: runtime,
          modelRegistry: registry,
          resourceLoader: loader,
          sessionManager: manager,
          settingsManager: SettingsManager.inMemory({
            compaction: { enabled: false },
            retry: { enabled: false },
          }),
          noTools: "all",
        });
        try {
          await session.bindExtensions({});
          expect(session.extensionRunner.getExtensionPaths()).toEqual(
            expect.arrayContaining(extensionPaths),
          );
          expect(
            loaded.extensions
              .find((extension) => extension.path === workflowsPath)
              ?.tools.has("workflow"),
          ).toBe(true);
          faux.setResponses([
            async () => {
              const workflow = loaded.extensions
                .find((extension) => extension.path === workflowsPath)
                ?.tools.get("workflow")?.definition;
              expect(workflow).toBeDefined();
              const started = await workflow!.execute(
                "during-summary",
                {
                  script:
                    'export const meta = { name: "during-summary", description: "owned child" }; return await agent("work");',
                  background: true,
                },
                new AbortController().signal,
                undefined,
                session.extensionRunner.createContext(),
              );
              const runId = (started.details as { runId?: string } | undefined)
                ?.runId;
              if (!runId)
                throw new Error(
                  `Workflow did not start: ${JSON.stringify(started.content)}`,
                );
              try {
                await vi.waitFor(() => expect(childStarted).toBe(true), {
                  timeout: 5_000,
                });
              } catch {
                const control = loaded.extensions
                  .find((extension) => extension.path === workflowsPath)
                  ?.tools.get("workflow_control")?.definition;
                const state = await control?.execute(
                  "during-summary-status",
                  { action: "get", run_id: runId },
                  new AbortController().signal,
                  undefined,
                  session.extensionRunner.createContext(),
                );
                throw new Error(
                  `Workflow child did not start: ${JSON.stringify(state?.content)}`,
                );
              }
              return fauxAssistantMessage(fauxText("summary of old work"));
            },
            async (_context, options) => {
              childStarted = true;
              return await new Promise<ReturnType<typeof fauxAssistantMessage>>(
                (resolve) => {
                  const stop = () => {
                    childAborted = true;
                    resolve(
                      fauxAssistantMessage(fauxText("stopped"), {
                        stopReason: "aborted",
                      }),
                    );
                  };
                  if (options.signal?.aborted) stop();
                  else
                    options.signal?.addEventListener("abort", stop, {
                      once: true,
                    });
                },
              );
            },
          ]);

          expect(
            await session.navigateTree(target, { summarize: true }),
          ).toMatchObject({ cancelled: false });
          expect(childAborted).toBe(true);
          const newBranch = manager.getBranch();
          expect(newBranch.some((entry) => entry.id === target)).toBe(true);
          expect(
            newBranch.filter(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === "subagents:managed-spawn",
            ),
          ).toEqual([]);
          expect(
            manager
              .getEntries()
              .some(
                (entry) =>
                  entry.type === "custom" &&
                  entry.customType === "subagents:managed-spawn",
              ),
          ).toBe(true);
        } finally {
          await session.extensionRunner.emit({
            type: "session_shutdown",
            reason: "quit",
          });
          session.dispose();
        }
      },
    );
  },
);
