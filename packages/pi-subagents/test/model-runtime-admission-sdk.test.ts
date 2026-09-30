import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import {
  type ExtensionContext,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { setAgentTiersSettings } from "../src/agent-tiers.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { parentModelSessionOptions } from "../src/model-runtime-bridge.js";
import type { AgentConfig } from "../src/types.js";

vi.setConfig({ testTimeout: 30_000 });

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const dirs: string[] = [];
afterEach(() => {
  setAgentTiersSettings({});
  registerAgents(new Map());
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function parentFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "subagents-runtime-admission-"));
  dirs.push(cwd);
  process.env.PI_CODING_AGENT_DIR = cwd;
  const faux = fauxProvider({
    provider: "admission-faux",
    models: [{ id: "physical", contextWindow: 200_000 }],
  });
  const runtime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({ allowNetwork: false });
  const model = runtime.getModel("admission-faux", "physical");
  if (!model)
    throw new Error("Physical model was not registered in real Pi runtime");
  const registry = new ModelRegistry(runtime);
  const stale = { provider: "retired-provider", id: "retired-model" };
  const ctx = {
    cwd,
    model: stale,
    modelRegistry: registry,
    hasUI: true,
    mode: "tui",
    ui: {
      notify: vi.fn(),
      setWidget: vi.fn(),
      setStatus: vi.fn(),
      onTerminalInput: vi.fn(() => vi.fn()),
    },
    sessionManager: SessionManager.inMemory(cwd),
    getSystemPrompt: () => "parent",
  } as unknown as ExtensionContext;
  return { cwd, faux, runtime, model, registry, ctx };
}

function withoutRuntime(
  ctx: ExtensionContext,
  registry: ModelRegistry,
): ExtensionContext {
  // Keep real public registry methods and hide only the private runtime bridge.
  return {
    ...ctx,
    modelRegistry: {
      find: registry.find.bind(registry),
      getAll: registry.getAll.bind(registry),
      getAvailable: registry.getAvailable.bind(registry),
      hasConfiguredAuth: registry.hasConfiguredAuth.bind(registry),
    },
  } as unknown as ExtensionContext;
}

function activation() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const events = {
    emit: vi.fn((name: string, data: unknown) => {
      for (const listener of listeners.get(name) ?? []) listener(data);
    }),
    on: vi.fn((name: string, listener: (data: unknown) => void) => {
      const current = listeners.get(name) ?? new Set<(data: unknown) => void>();
      current.add(listener);
      listeners.set(name, current);
      return () => current.delete(listener);
    }),
  };
  const extensionPi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((name: string, handler: (...args: any[]) => any) =>
      handlers.set(name, handler),
    ),
    events,
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(extensionPi);
  return { handlers, tools, extensionPi, events };
}

describe("parent ModelRuntime admission (real Pi SDK)", () => {
  it("rejects the public registry facade without a runtime, before allocating a manager ID", async () => {
    const { faux, ctx, registry } = await parentFixture();
    try {
      const publicCtx = withoutRuntime(ctx, registry);
      const providerCall = vi.fn(() =>
        fauxAssistantMessage(fauxText("must not run")),
      );
      faux.setResponses([providerCall]);
      const onCreated = vi.fn();
      const manager = new AgentManager(
        undefined,
        1,
        undefined,
        undefined,
        onCreated,
      );
      try {
        for (const isBackground of [false, true]) {
          expect(() =>
            manager.spawn({} as never, publicCtx, "Explore", "work", {
              description: "work",
              isBackground,
            }),
          ).toThrow(/parent's model runtime is unavailable or incompatible/);
        }
        expect(manager.listAgents()).toEqual([]);
        expect(onCreated).not.toHaveBeenCalled();
        expect(providerCall).not.toHaveBeenCalled();
      } finally {
        await manager.dispose();
      }
    } finally {
      faux.setResponses([]);
    }
  });

  it.each(["model", "direct"] as const)(
    "refuses background Agent and %s mention on the public-only registry",
    async (mode) => {
      const { cwd, faux, ctx, registry } = await parentFixture();
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(
        join(cwd, ".pi", "subagents.json"),
        JSON.stringify({
          agentMentions: mode,
          schedulingEnabled: false,
          outputTranscript: false,
        }),
      );
      const providerCall = vi.fn(() =>
        fauxAssistantMessage(fauxText("must not run")),
      );
      faux.setResponses([providerCall]);
      const publicCtx = withoutRuntime(ctx, registry);
      const { handlers, tools, extensionPi } = activation();
      try {
        await handlers.get("session_start")?.({}, publicCtx);
        await expect(
          tools.get("Agent").execute(
            "tc-admission",
            {
              subagent_type: "Explore",
              prompt: "find it",
              description: "Find it",
              run_in_background: true,
            },
            undefined,
            undefined,
            publicCtx,
          ),
        ).rejects.toThrow(
          /parent's model runtime is unavailable or incompatible/,
        );
        expect(extensionPi.events.emit).not.toHaveBeenCalledWith(
          "subagents:created",
          expect.anything(),
        );
        expect(
          await handlers.get("input")?.(
            { text: "@explore find it", source: "user" },
            publicCtx,
          ),
        ).toEqual({ action: "handled" });
        expect(publicCtx.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining(
            "parent's model runtime is unavailable or incompatible",
          ),
          "error",
        );
        expect(publicCtx.ui.notify).not.toHaveBeenCalledWith(
          expect.stringMatching(/^(Starting|Started)/),
          expect.anything(),
        );
        expect(providerCall).not.toHaveBeenCalled();
      } finally {
        await handlers.get("session_shutdown")?.({}, publicCtx);
        faux.setResponses([]);
      }
    },
  );

  it("does not announce or allocate a model-mode mention when its inherited model retired", async () => {
    const { cwd, faux, ctx } = await parentFixture();
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "subagents.json"),
      JSON.stringify({
        agentMentions: "model",
        schedulingEnabled: false,
        outputTranscript: false,
      }),
    );
    const providerCall = vi.fn(() =>
      fauxAssistantMessage(fauxText("unexpected")),
    );
    faux.setResponses([providerCall]);
    const { handlers, extensionPi } = activation();
    try {
      await handlers.get("session_start")?.({}, ctx);
      expect(
        await handlers.get("input")?.(
          { text: "@explore find it", source: "user" },
          ctx,
        ),
      ).toEqual({ action: "handled" });
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining(
          "parent's model runtime is unavailable or incompatible",
        ),
        "error",
      );
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(
        expect.stringMatching(/^(Starting|Started)/),
        expect.anything(),
      );
      const manager = (globalThis as Record<symbol, unknown>)[
        Symbol.for("pi-subagents:manager")
      ] as { hasRunning: () => boolean };
      expect(manager.hasRunning()).toBe(false);
      expect(extensionPi.events.emit).not.toHaveBeenCalledWith(
        "subagents:created",
        expect.anything(),
      );
      expect(
        ctx.sessionManager
          .getEntries()
          .filter(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === "subagents:managed-spawn",
          ),
      ).toEqual([]);
      expect(providerCall).not.toHaveBeenCalled();
    } finally {
      await handlers.get("session_shutdown")?.({}, ctx);
      faux.setResponses([]);
    }
  });

  it("checks only shape at admission and uses the same runtime for an explicit physical child model", async () => {
    const { faux, ctx, runtime, registry, model } = await parentFixture();
    try {
      expect(parentModelSessionOptions(ctx).modelRuntime).toBe(runtime);
      expect(parentModelSessionOptions(ctx, model).modelRuntime).toBe(runtime);
      expect(() => parentModelSessionOptions(ctx, ctx.model)).toThrow(
        /parent's model runtime/,
      );
      // Pi 0.84/0.87 have these real runtime capabilities but no resolveModel.
      const olderRuntimeShape = {
        getAuth: runtime.getAuth.bind(runtime),
        getModel: runtime.getModel.bind(runtime),
        stream: runtime.stream.bind(runtime),
        streamSimple: runtime.streamSimple.bind(runtime),
      };
      expect(
        parentModelSessionOptions(
          {
            ...ctx,
            modelRegistry: { runtime: olderRuntimeShape },
          } as unknown as ExtensionContext,
          model,
        ).modelRuntime,
      ).toBe(olderRuntimeShape);
      const providerCall = vi.fn(() =>
        fauxAssistantMessage(fauxText("CHILD_REQUEST_OK")),
      );
      faux.setResponses([providerCall]);
      registerAgents(
        new Map([
          [
            "AdmissionTest",
            {
              name: "AdmissionTest",
              description: "Admission test",
              builtinToolNames: [],
              extensions: false,
              skills: false,
              systemPrompt: "You are a test child.",
              promptMode: "replace",
            } satisfies AgentConfig,
          ],
        ]),
      );
      const manager = new AgentManager();
      try {
        const id = manager.spawn(
          { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as never,
          ctx,
          "AdmissionTest",
          "answer",
          { description: "answer", isBackground: true, model },
        );
        const record = manager.getRecordMutable(id);
        expect(record).toBeDefined();
        await record?.promise;
        expect(manager.getRecord(id)?.status).toBe("completed");
        expect(manager.getRecord(id)?.result).toContain("CHILD_REQUEST_OK");
        expect(providerCall).toHaveBeenCalledOnce();
        expect(registry.find(model.provider, model.id)).toEqual(model);
      } finally {
        await manager.dispose();
      }
    } finally {
      faux.setResponses([]);
    }
  });

  it("does not poison a managed key when a tier's selected model is unavailable", async () => {
    const { faux, ctx, model, runtime, registry } = await parentFixture();
    registerAgents(
      new Map([
        [
          "AdmissionTest",
          {
            name: "AdmissionTest",
            description: "Admission test",
            builtinToolNames: [],
            extensions: false,
            skills: false,
            systemPrompt: "You are a test child.",
            promptMode: "replace",
          } satisfies AgentConfig,
        ],
      ]),
    );
    const staleModel = { ...model, id: "retired" };
    const staleCtx = {
      ...ctx,
      modelRegistry: {
        runtime,
        find: (provider: string, id: string) =>
          provider === staleModel.provider && id === staleModel.id
            ? staleModel
            : registry.find(provider, id),
        getAll: () => [staleModel, model],
        getAvailable: () => [staleModel, model],
      },
    } as unknown as ExtensionContext;
    const append = vi.fn();
    const onCreated = vi.fn();
    const providerCall = vi.fn(() =>
      fauxAssistantMessage(fauxText("VALID_ALTERNATE_CHILD")),
    );
    faux.setResponses([providerCall]);
    const manager = new AgentManager(
      undefined,
      1,
      undefined,
      undefined,
      onCreated,
      { append },
    );
    const request = {
      requestId: "request",
      spawnKey: "run:route",
      type: "AdmissionTest",
      tier: "route",
      prompt: "probe",
      description: "Probe",
      owner: {
        extension: "pi-workflows" as const,
        runId: "run",
        nodeId: "node",
        attemptId: "attempt",
      },
    };
    const tier = (modelId: string) =>
      setAgentTiersSettings({
        profiles: {
          route: { model: `admission-faux/${modelId}`, thinking: "inherit" },
        },
      });
    try {
      tier("retired");
      expect(() => manager.spawnManaged({} as never, ctx, request, {})).toThrow(
        /unavailable model/,
      );
      // Even a stale registry facade claiming the model is available cannot
      // override the real parent's runtime when the runner selects that model.
      expect(() =>
        manager.spawnManaged({} as never, staleCtx, request, {}),
      ).toThrow(/parent's model runtime is unavailable or incompatible/);
      expect(manager.getManagedSpawn(request.spawnKey)).toBeUndefined();
      expect(manager.listAgents()).toEqual([]);
      expect(onCreated).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(providerCall).not.toHaveBeenCalled();

      // Repair the tier and reuse the identical key. The stale parent model is
      // irrelevant: this explicit tier selects a valid alternate physical model.
      tier("physical");
      const spawned = manager.spawnManaged(
        { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as never,
        ctx,
        request,
        {},
      );
      expect(spawned.created).toBe(true);
      await manager.getRecordMutable(spawned.id)?.promise;
      expect(manager.getRecord(spawned.id)?.status).toBe("completed");
      expect(providerCall).toHaveBeenCalledOnce();
      expect(manager.getManagedSpawn(request.spawnKey)?.id).toBe(spawned.id);
    } finally {
      await manager.dispose();
      faux.setResponses([]);
    }
  });

  it("rejects a new managed key before journaling and keeps a cached key readable", async () => {
    const { faux, ctx, registry } = await parentFixture();
    // No selected model here: a cached managed key stays readable even when
    // its original runner could not select a model and the host later loses the bridge.
    const inheritedCtx = { ...ctx, model: undefined } as ExtensionContext;
    const publicCtx = withoutRuntime(inheritedCtx, registry);
    const providerCall = vi.fn(() =>
      fauxAssistantMessage(fauxText("unexpected")),
    );
    faux.setResponses([providerCall]);
    const append = vi.fn();
    const manager = new AgentManager(
      undefined,
      1,
      undefined,
      undefined,
      undefined,
      { append },
    );
    const owner = {
      extension: "pi-workflows" as const,
      runId: "run",
      nodeId: "node",
      attemptId: "attempt",
    };
    const request = {
      requestId: "request",
      spawnKey: "run:node",
      type: "Explore",
      prompt: "probe",
      description: "Probe",
      owner,
    };
    try {
      expect(() =>
        manager.spawnManaged({} as never, publicCtx, request, {}),
      ).toThrow(/parent's model runtime is unavailable or incompatible/);
      expect(manager.getManagedSpawn(request.spawnKey)).toBeUndefined();
      expect(manager.listAgents()).toEqual([]);
      expect(append).not.toHaveBeenCalled();
      expect(providerCall).not.toHaveBeenCalled();

      // The real runner may eventually fail because this fixture specifies no
      // tier, but the previously persisted idempotency identity is still valid.
      const first = manager.spawnManaged(
        {} as never,
        inheritedCtx,
        request,
        {},
      );
      expect(first.created).toBe(true);
      expect(
        manager.spawnManaged({} as never, publicCtx, request, {}),
      ).toMatchObject({ id: first.id, created: false });
      const writes = append.mock.calls.length;
      expect(() =>
        manager.spawnManaged(
          {} as never,
          publicCtx,
          { ...request, spawnKey: "run:new" },
          {},
        ),
      ).toThrow(/parent's model runtime is unavailable or incompatible/);
      expect(manager.getManagedSpawn("run:new")).toBeUndefined();
      expect(append).toHaveBeenCalledTimes(writes);
      expect(providerCall).not.toHaveBeenCalled();
    } finally {
      await manager.dispose();
      faux.setResponses([]);
    }
  });

  it("replies to managed RPC with an error and no tombstone or provider request", async () => {
    const { cwd, faux, ctx, registry } = await parentFixture();
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false }),
    );
    const publicCtx = withoutRuntime(ctx, registry);
    const providerCall = vi.fn(() =>
      fauxAssistantMessage(fauxText("unexpected")),
    );
    faux.setResponses([providerCall]);
    const { handlers, extensionPi, events } = activation();
    try {
      await handlers.get("session_start")?.({}, publicCtx);
      const response = new Promise<unknown>((resolve) => {
        events.on("subagents:rpc:spawn-managed:reply:runtime-missing", resolve);
      });
      events.emit("subagents:rpc:spawn-managed", {
        requestId: "runtime-missing",
        spawnKey: "run:missing",
        type: "Explore",
        prompt: "probe",
        description: "Probe",
        owner: {
          extension: "pi-workflows",
          runId: "run",
          nodeId: "node",
          attemptId: "attempt",
        },
      });
      await expect(response).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining(
          "parent's model runtime is unavailable or incompatible",
        ),
      });
      expect(
        publicCtx.sessionManager
          .getEntries()
          .filter(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === "subagents:managed-spawn",
          ),
      ).toEqual([]);
      expect(extensionPi.events.emit).not.toHaveBeenCalledWith(
        "subagents:created",
        expect.anything(),
      );
      expect(providerCall).not.toHaveBeenCalled();
    } finally {
      await handlers.get("session_shutdown")?.({}, publicCtx);
      faux.setResponses([]);
    }
  });
});
