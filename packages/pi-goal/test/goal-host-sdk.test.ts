import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
  type Tool,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import goal from "../src/goal.js";
import type { ActiveGoal, GoalStateEntryData } from "../src/persistence.js";

// This regression uses the installed host and its actual codemode executor, not tool mocks.
describe.skipIf(VERSION !== "1.5.0")("terminal goals on installed Pi 1.5.0", () => {
  let cwd: string;
  let agentDir: string;
  let previousAgentDir: string | undefined;
  let faux: ReturnType<typeof fauxProvider>;
  let runtime: ModelRuntime;
  const terminals = ["goal_complete", "goal_blocked", "goal_wait"] as const;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "goal-host-"));
    agentDir = join(cwd, "agent");
    mkdirSync(agentDir);
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    faux = fauxProvider({ provider: "goal-faux", models: [{ id: "goal", contextWindow: 200_000 }] });
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

  function active(id = "current", status: ActiveGoal["status"] = "active"): ActiveGoal {
    return {
      id,
      status,
      text: `finish ${id}`,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      iteration: 3,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      baselineTokens: 0,
      automaticModelTurns: 0,
      toolFreeRepeatCount: 0,
    };
  }

  function args(name: (typeof terminals)[number], id = "current") {
    if (name === "goal_complete") return { goal_id: id, summary: "Implemented and verified every requirement." };
    if (name === "goal_blocked")
      return {
        goal_id: id,
        reason: "External access required",
        evidence: "Three separate attempts denied access",
        repeated_turns: 3,
      };
    return { goal_id: id, reason: "Waiting for external review" };
  }

  async function fixture(mode: "on" | "only", queue = false, beforeSettle?: () => Promise<void>) {
    const settingsPath = join(agentDir, "goal.json");
    writeFileSync(settingsPath, JSON.stringify({ toolVisibility: "always", experimental: { goals: queue } }));
    const manager = SessionManager.inMemory(cwd);
    manager.appendCustomEntry("goal-state", {
      goal: active(),
      ...(queue ? { queue: [active("successor", "queued")] } : {}),
    });
    const state = () =>
      manager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === "goal-state")
        .at(-1)?.data as GoalStateEntryData;
    const substantive = vi.fn();
    const nestedStates: GoalStateEntryData[] = [];
    const nestedErrors: boolean[] = [];
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noExtensions: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        { name: "goal", factory: (pi) => goal(pi, { settingsPath }) },
        { name: "codemode", factory: createCodemodeExtension({ mode, models: false }) },
        {
          name: "probes",
          factory: (pi: ExtensionAPI) => {
            pi.registerTool({
              name: "substantive",
              label: "probe",
              description: "substantive probe",
              exposure: "model-only",
              parameters: Type.Object({}),
              execute: async () => {
                substantive();
                return { content: [{ type: "text", text: "ran" }] };
              },
            });
            pi.registerTool({
              name: "gateway",
              label: "gateway",
              description: "nested caller",
              exposure: "model-only",
              parameters: Type.Object({ name: Type.String(), args: Type.Unknown() }),
              execute: async (_id, params, _signal, _update, ctx) => {
                const outcome = await ctx.executeTool(params.name, params.args);
                nestedErrors.push(outcome.isError);
                nestedStates.push(state());
                return { content: [{ type: "text", text: JSON.stringify(outcome) }] };
              },
            });
            pi.on("tool_execution_end", (event) => {
              if (event.toolName === "codemode") nestedStates.push(state());
            });
            if (beforeSettle) pi.on("agent_before_settle", beforeSettle);
          },
        },
      ],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const registry = new ModelRegistry(runtime);
    const model = registry.find("goal-faux", "goal");
    if (!model) throw new Error("faux model missing");
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      modelRuntime: runtime,
      modelRegistry: registry,
      resourceLoader: loader,
      sessionManager: manager,
      tools: [...terminals, "gateway", "substantive", "codemode"],
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    });
    session.setActiveToolsByName([...terminals, "gateway", "substantive", "codemode"]);
    expect(session.getActiveToolNames()).toEqual(expect.arrayContaining([...terminals]));
    await session.bindExtensions({});
    expect(state().goal?.status).toBe("active");
    return { session, state, substantive, nestedStates, nestedErrors };
  }

  it.each(["on", "only"] as const)(
    "declares terminal tools directly, never to scripts, in codemode %s",
    async (mode) => {
      const f = await fixture(mode);
      try {
        let declared: Tool[] = [];
        const provider = vi.fn((context: TranscriptContext) => {
          declared = getCurrentTools(context.messages);
          return fauxAssistantMessage(fauxToolCall("goal_complete", args("goal_complete")), { stopReason: "toolUse" });
        });
        faux.setResponses([provider]);
        await f.session.prompt("finish");
        expect(provider).toHaveBeenCalledOnce();
        for (const name of terminals) {
          expect(declared.some((tool) => tool.name === name)).toBe(true);
          expect(f.session.getCallableToolNames()).not.toContain(name);
          expect(declared.find((tool) => tool.name === "codemode")?.description).not.toContain(`tools.${name}`);
        }
        expect(f.state().goal).toBeNull();
      } finally {
        f.session.dispose();
      }
    },
  );

  for (const mode of ["on", "only"] as const) {
    it.each(terminals)(`rejects nested %s without mutating the goal in codemode ${mode}`, async (name) => {
      for (const caller of ["gateway", "codemode"] as const) {
        const f = await fixture(mode);
        try {
          const nested =
            caller === "gateway"
              ? { name, args: args(name) }
              : {
                  code: `await tools[${JSON.stringify(name)}](${JSON.stringify(args(name))}); return "must not transition";`,
                };
          let requests = 0;
          faux.setResponses([
            () => {
              requests++;
              return fauxAssistantMessage(fauxToolCall(caller, nested), { stopReason: "toolUse" });
            },
            () => {
              requests++;
              return fauxAssistantMessage(fauxToolCall("goal_complete", args("goal_complete")), {
                stopReason: "toolUse",
              });
            },
          ]);
          await f.session.prompt("try nested, then complete directly");
          expect(f.nestedStates).toHaveLength(1);
          expect(f.nestedStates[0]?.goal).toMatchObject({ id: "current", status: "active" });
          if (caller === "gateway") expect(f.nestedErrors).toEqual([true]);
          else
            expect(f.session.messages.find((m) => m.role === "toolResult" && m.toolName === "codemode")).toMatchObject({
              isError: true,
            });
          expect(f.state().goal).toBeNull();
          expect(requests).toBe(2);
          expect(f.substantive).not.toHaveBeenCalled();
        } finally {
          f.session.dispose();
        }
      }
    });

    it.each(terminals)(
      `direct %s terminates before more work or another provider request in codemode ${mode}`,
      async (name) => {
        const f = await fixture(mode);
        try {
          const provider = vi.fn(() => fauxAssistantMessage(fauxToolCall(name, args(name)), { stopReason: "toolUse" }));
          const additional = vi.fn(() =>
            fauxAssistantMessage(fauxToolCall("substantive", {}), { stopReason: "toolUse" }),
          );
          faux.setResponses([provider, additional]);
          await f.session.prompt("terminate directly");
          expect(provider).toHaveBeenCalledOnce();
          expect(additional).not.toHaveBeenCalled();
          expect(f.substantive).not.toHaveBeenCalled();
          if (name === "goal_complete") expect(f.state().goal).toBeNull();
          else
            expect(f.state().goal).toMatchObject({
              id: "current",
              status: name === "goal_wait" ? "paused" : "blocked",
            });
          if (name === "goal_wait") expect(f.state().goal?.wait?.reason).toBe("Waiting for external review");
        } finally {
          f.session.dispose();
        }
      },
    );
  }

  it("keeps the queued successor inactive until actual host settlement", async () => {
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = false;
    const f = await fixture("only", true, async () => {
      if (!reached) {
        reached = true;
        await barrier;
      }
    });
    let requests = 0;
    try {
      faux.setResponses([
        () => {
          requests++;
          return fauxAssistantMessage(fauxToolCall("goal_complete", args("goal_complete")), { stopReason: "toolUse" });
        },
        () => {
          requests++;
          return fauxAssistantMessage(fauxToolCall("goal_wait", args("goal_wait", f.state().goal?.id ?? "missing")), {
            stopReason: "toolUse",
          });
        },
      ]);
      const running = f.session.prompt("finish first");
      await vi.waitFor(() => expect(reached).toBe(true));
      expect(f.state().goal).toMatchObject({ id: "current", status: "complete" });
      expect(f.state().queue?.[0]).toMatchObject({ id: "successor", status: "queued" });
      expect(requests).toBe(1);
      release();
      await running;
      await vi.waitFor(() => expect(f.state().goal).toMatchObject({ text: "finish successor", status: "paused" }));
      expect(f.state().goal?.id).not.toBe("current");
      expect(requests).toBe(2);
      expect(f.substantive).not.toHaveBeenCalled();
    } finally {
      release();
      f.session.dispose();
    }
  });
});
