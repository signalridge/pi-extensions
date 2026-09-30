import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { assertSafeChildSession, INHERIT_CONTEXT_UNAVAILABLE, INHERITED_SESSION_UNSAFE } from "../src/context-boundary.js";
import { runMentionClone } from "../src/mention-clone.js";
import { parentModelSessionOptions } from "../src/model-runtime-bridge.js";
import type { AgentConfig } from "../src/types.js";

const dirs: string[] = [];
afterEach(() => {
  registerAgents(new Map());
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function childType(inheritContext = false): void {
  registerAgents(new Map([["boundary-test", {
    name: "boundary-test", description: "boundary test", builtinToolNames: [],
    extensions: false, skills: false, systemPrompt: "Only answer this task.",
    promptMode: "replace", inheritContext,
  } satisfies AgentConfig]]));
}

async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "subagent-boundary-"));
  dirs.push(cwd);
  const faux = fauxProvider({ provider: "boundary-faux", models: [{ id: "physical", contextWindow: 200_000 }] });
  const runtime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"), modelsPath: null, allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  const model = runtime.getModel("boundary-faux", "physical");
  if (!model) throw new Error("faux model unavailable");
  const registry = new ModelRegistry(runtime);
  const parentManager = SessionManager.inMemory(cwd);
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, noExtensions: true, noContextFiles: true,
    extensionFactories: [{ name: "parent-redactor", factory: (pi) => {
      pi.on("context", (event) => ({
        messages: event.messages.map((message) => message.role === "user"
          ? { ...message, content: "PARENT_REDACTED" } : message),
      }));
    } }],
  });
  await loader.reload();
  const { session: parent } = await createAgentSession({
    cwd, model, modelRuntime: runtime, sessionManager: parentManager, resourceLoader: loader,
    noTools: "all",
  });
  const ctx = {
    cwd, model, modelRegistry: registry, sessionManager: parentManager,
    getSystemPrompt: () => "parent system prompt",
  } as unknown as ExtensionContext;
  const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as Parameters<typeof runAgent>[3]["pi"];
  return { cwd, faux, runtime, model, parentManager, parent, ctx, pi };
}

describe("inherit_context host boundary (real Pi SDK)", () => {
  it("rejects raw inheritance before reading the pre-hook projection or making a child request", async () => {
    childType();
    const { faux, parent, parentManager, ctx, pi } = await fixture();
    try {
      const calls: string[] = [];
      faux.setResponses([() => {
        calls.push("parent");
        return fauxAssistantMessage(fauxText("parent done"));
      }]);
      await parent.prompt("PRIVATE_PRE_HOOK_HISTORY");
      expect(calls).toEqual(["parent"]);
      expect(JSON.stringify(parentManager.getBranch())).toContain("PRIVATE_PRE_HOOK_HISTORY");
      const projection = vi.spyOn(parentManager, "buildSessionProjection");
      await expect(runAgent(ctx, "boundary-test", "CHILD_TASK", { pi, inheritContext: true }))
        .rejects.toThrow(INHERIT_CONTEXT_UNAVAILABLE);
      expect(projection).not.toHaveBeenCalled();
      expect(calls).toEqual(["parent"]);
      projection.mockRestore();
    } finally {
      parent.dispose();
    }
  });

  it("sends only the explicit task with ordinary inheritance off, even after a persisted context_edit", async () => {
    childType();
    const { faux, parent, parentManager, ctx, pi } = await fixture();
    try {
      const rawId = parentManager.appendMessage({ role: "user", content: "PRIVATE_PARENT_SECRET", timestamp: Date.now() });
      parentManager.appendContextEdit(rawId, { content: "SAFE_PARENT_SUMMARY" });
      const requests: unknown[] = [];
      faux.setResponses([(context) => {
        requests.push(context);
        return fauxAssistantMessage(fauxText("CHILD_OK"));
      }]);
      const result = await runAgent(ctx, "boundary-test", "Explicitly sanitized summary: SAFE_PARENT_SUMMARY", { pi, isolated: true });
      expect(result.responseText).toBe("CHILD_OK");
      expect(requests).toHaveLength(1);
      const request = JSON.stringify(requests[0]);
      expect(request).toContain("Explicitly sanitized summary: SAFE_PARENT_SUMMARY");
      expect(request).not.toContain("PRIVATE_PARENT_SECRET");
      expect(request).not.toContain("# Parent Conversation Context");
    } finally {
      parent.dispose();
    }
  });

  it("refuses a missing parent ModelRuntime before a Pi 0.99 child provider request", async () => {
    childType();
    const { faux, parent, ctx, pi } = await fixture();
    try {
      const incompatible = { ...ctx, modelRegistry: {
        find: () => ctx.model, getAll: () => [ctx.model], getAvailable: () => [ctx.model],
      } } as unknown as ExtensionContext;
      await expect(runAgent(incompatible, "boundary-test", "sanitized task", { pi, isolated: true }))
        .rejects.toThrow(/parent's model runtime is unavailable or incompatible/);
      expect(faux.state.callCount).toBe(0);
    } finally {
      parent.dispose();
    }
  });

  it("refuses a persisted inherited prompt on reopen and an in-memory resume before provider dispatch", async () => {
    childType();
    const { cwd, faux, parent, ctx, pi } = await fixture();
    try {
      const persisted = SessionManager.create(cwd, join(cwd, "sessions"));
      persisted.appendMessage({ role: "user", content: "# Parent Conversation Context\nPRIVATE_OLD_HISTORY\n# Your Task (below)\nTASK", timestamp: Date.now() });
      const file = persisted.getSessionFile();
      if (!file) throw new Error("test session file unavailable");
      const reopened = SessionManager.open(file);
      const fakeSession = { sessionManager: reopened, messages: [] };
      expect(() => assertSafeChildSession(fakeSession as never)).toThrow(INHERITED_SESSION_UNSAFE);
      await expect(runAgent(ctx, "boundary-test", "new message", { pi, resumeSessionFile: file }))
        .rejects.toThrow(INHERITED_SESSION_UNSAFE);
      const prompt = vi.fn();
      await expect(resumeAgent({ ...fakeSession, prompt } as never, "new message"))
        .rejects.toThrow(INHERITED_SESSION_UNSAFE);
      expect(prompt).not.toHaveBeenCalled();
      expect(faux.state.callCount).toBe(0);
    } finally {
      parent.dispose();
    }
  });

  it("rejects a missing or incompatible parent runtime before either child or mention provider request", async () => {
    childType();
    const { faux, parent, ctx, pi, model } = await fixture();
    try {
      const absent = { ...ctx, modelRegistry: {
        find: () => model, getAll: () => [model], getAvailable: () => [model],
      } } as ExtensionContext;
      const incompatible = { ...absent, modelRegistry: {
        ...absent.modelRegistry,
        runtime: { getModel: () => model, getAuth: async () => ({ apiKey: "faux" }) },
      } } as ExtensionContext;
      const providerCall = vi.fn(() => fauxAssistantMessage(fauxText("UNEXPECTED")));
      faux.setResponses([providerCall]);
      for (const brokenCtx of [absent, incompatible]) {
        await expect(runAgent(brokenCtx, "boundary-test", "explicit child task", { pi, isolated: true }))
          .rejects.toThrow(/parent's model runtime is unavailable or incompatible/);
        const clone = await runMentionClone({
          ctx: brokenCtx, type: "boundary-test", message: "explicit mention task",
          agentTool: { name: "Agent" } as never, isOriginCurrent: () => true,
        });
        expect(clone.spawned).toBe(false);
        expect(clone.error).toMatch(/parent's model runtime is unavailable or incompatible/);
      }
      expect(providerCall).not.toHaveBeenCalled();
      expect(faux.state.callCount).toBe(0);
    } finally {
      parent.dispose();
    }
  });

  it("rejects a runtime that cannot resolve the selected child model", async () => {
    childType();
    const { parent, ctx, model } = await fixture();
    try {
      const wrong = { ...ctx, modelRegistry: {
        ...ctx.modelRegistry,
        runtime: {
          getModel: () => undefined,
          getAuth: async () => ({ apiKey: "faux" }),
          stream: () => { throw new Error("unused"); },
          streamSimple: () => { throw new Error("unused"); },
        },
      } } as ExtensionContext;
      expect(() => parentModelSessionOptions(wrong, model)).toThrow(/incompatible/);
    } finally {
      parent.dispose();
    }
  });

  it("also refuses metadata-only inherited child sessions after the original prompt was compacted", () => {
    const manager = SessionManager.inMemory();
    manager.appendCustomEntry("child-policy", { inheritContext: true });
    expect(() => assertSafeChildSession({ sessionManager: manager, messages: [] } as never))
      .toThrow(INHERITED_SESSION_UNSAFE);
    const noMarker = SessionManager.inMemory();
    expect(() => assertSafeChildSession({ sessionManager: noMarker, messages: [] } as never, true))
      .toThrow(INHERITED_SESSION_UNSAFE);
  });
});
