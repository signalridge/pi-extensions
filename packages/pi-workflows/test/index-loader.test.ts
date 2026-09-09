import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import {
  type ManagedRoutingPolicy,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_VERSION,
  routingPolicyFingerprint,
} from "@signalridge/pi-subagents-protocol";
import { describe, expect, it, vi } from "vitest";
import piWorkflows from "../src/index.js";

// Deliberately none of the names the built-in workflows use: a host is free to
// call its tiers whatever it likes, and a shipped command must still run.
const ROUTING_POLICY: ManagedRoutingPolicy = {
  defaultTier: "standard",
  profiles: {
    cheap: { model: "inherit", thinking: "low" },
    standard: { model: "inherit", thinking: "medium" },
  },
  blockedProfiles: [],
  blockedDefaultTier: false,
};
const ROUTING_POLICY_SNAPSHOT = {
  policy: ROUTING_POLICY,
  fingerprint: routingPolicyFingerprint(ROUTING_POLICY),
};

class Bus {
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();

  on(event: string, handler: (data: unknown) => void): () => void {
    const handlers = this.listeners.get(event) ?? new Set<(data: unknown) => void>();
    handlers.add(handler);
    this.listeners.set(event, handlers);
    return () => handlers.delete(handler);
  }

  emit(event: string, data: unknown): void {
    for (const handler of this.listeners.get(event) ?? []) handler(data);
  }
}

function createPi(child: boolean, appendFailures = 0, branch: unknown[] = [], protocolAvailable = true) {
  const bus = new Bus();
  // Mutable so a test can change the host catalogue between runs the way
  // `/agents → Model tiers` does mid-session.
  const routing = { snapshot: ROUTING_POLICY_SNAPSHOT, pings: 0 };
  const lifecycle = new Map<string, (...args: never[]) => unknown>();
  const tools: string[] = [];
  const toolDefinitions: unknown[] = [];
  const commands: string[] = [];
  const commandDefinitions = new Map<string, unknown>();
  const widgetUpdates: Array<string[] | undefined> = [];
  const entries: unknown[] = [...branch];
  bus.on("subagents:rpc:context", (raw) => {
    const request = raw as { requestId: string };
    bus.emit(`subagents:rpc:context:reply:${request.requestId}`, {
      success: true,
      data: { child, capability: "childContext" },
    });
  });
  bus.on("subagents:rpc:ping", (raw) => {
    const request = raw as { requestId: string };
    routing.pings += 1;
    bus.emit(`subagents:rpc:ping:reply:${request.requestId}`, {
      success: true,
      data: protocolAvailable
        ? {
            version: PROTOCOL_VERSION,
            capabilities: PROTOCOL_CAPABILITIES,
            routingPolicy: routing.snapshot,
          }
        : { version: PROTOCOL_VERSION - 1, capabilities: {} },
    });
  });
  const pi = {
    events: bus,
    appendEntry: (_type: string, data: unknown) => {
      if (appendFailures > 0) {
        appendFailures -= 1;
        throw new Error("transient append failure");
      }
      entries.push(data);
    },
    registerTool: (tool: { name: string }) => {
      tools.push(tool.name);
      toolDefinitions.push(tool);
    },
    registerCommand: (name: string, descriptor: unknown) => {
      commands.push(name);
      commandDefinitions.set(name, descriptor);
    },
    on: (event: string, handler: (...args: never[]) => unknown) => {
      lifecycle.set(event, handler);
      return () => lifecycle.delete(event);
    },
  };
  const ctx = {
    hasUI: false,
    mode: "print" as "print" | "rpc" | "tui",
    ui: {
      setWidget: (_key: string, content: string[] | undefined) => widgetUpdates.push(content),
      confirm: vi.fn(async () => true),
      input: vi.fn(async () => "input"),
      select: vi.fn(async () => "choice"),
    },
    sessionManager: {
      getBranch: () =>
        entries.map((entry) => {
          const shaped = entry as { type?: unknown };
          return shaped.type ? entry : { type: "custom", customType: "pi-workflows:journal", data: entry };
        }),
    },
  };
  return {
    bus,
    lifecycle,
    tools,
    toolDefinitions,
    commands,
    commandDefinitions,
    entries,
    widgetUpdates,
    routing,
    pi,
    ctx,
  };
}

type WorkflowTool = {
  execute: (
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: { runId: string; status: string; result?: string };
  }>;
};

function workflowTool(fixture: ReturnType<typeof createPi>): WorkflowTool {
  return fixture.toolDefinitions.find((tool) => (tool as { name: string }).name === "workflow") as WorkflowTool;
}

describe("pi-workflows loader context isolation", () => {
  for (const kind of ["confirm", "input", "select"] as const) {
    for (const action of ["tool-abort", "pause", "stop", "dispose", "fatal"] as const) {
      it(`${action} closes an unanswered ${kind} checkpoint and pairs Pi prompt lifecycle`, async () => {
        const fixture = createPi(false);
        const controller = new AbortController();
        let dialogSignal: AbortSignal | undefined;
        let pendingDialogs = 0;
        const dialog = vi.fn(async (_title: string, _value: unknown, options?: { signal?: AbortSignal }) => {
          dialogSignal = options?.signal;
          pendingDialogs++;
          try {
            return await new Promise<false | undefined>((resolve) => {
              const close = () => {
                dialogSignal?.removeEventListener("abort", close);
                resolve(kind === "confirm" ? false : undefined);
              };
              dialogSignal?.addEventListener("abort", close, { once: true });
              if (dialogSignal?.aborted) close();
            });
          } finally {
            pendingDialogs--;
          }
        });
        // Use Pi's real public UI wrapper: lifecycle pairing must happen on
        // automatic cancellation, without a synthetic/manual UI response.
        const runner = new ExtensionRunner([], {} as never, ".", {} as never, {} as never);
        const emitted = vi.spyOn(runner, "emit").mockResolvedValue(undefined);
        runner.setUIContext({ ...fixture.ctx.ui, [kind]: dialog } as never, "rpc");
        const ctx = { ...fixture.ctx, mode: "rpc", hasUI: true, ui: runner.getUIContext() };
        piWorkflows(fixture.pi as never);
        await fixture.lifecycle.get("session_start")?.({}, ctx);
        const checkpoint = `checkpoint("wait", { kind: "${kind}", choices: ["yes"], default: "fallback" })`;
        const body =
          action === "fatal"
            ? `return await Promise.all([${checkpoint}, Promise.resolve().then(() => { throw new Error("fatal"); })]);`
            : `return await ${checkpoint};`;
        const pending = workflowTool(fixture).execute(
          "cancel-checkpoint",
          { script: `export const meta = { name: "cancel-dialog", description: "test" }; ${body}`, background: false },
          controller.signal,
          undefined,
          ctx,
        );
        await vi.waitFor(() => expect(dialog).toHaveBeenCalledOnce());
        const runId = (
          fixture.entries.find((entry) => (entry as { kind?: string }).kind === "run_created") as { runId: string }
        ).runId;
        if (action === "tool-abort") controller.abort();
        else if (action === "dispose") await fixture.lifecycle.get("session_shutdown")?.({}, ctx);
        else if (action !== "fatal") {
          const control = fixture.toolDefinitions.find(
            (tool) => (tool as { name: string }).name === "workflow_control",
          ) as WorkflowTool;
          await control.execute(action, { action, run_id: runId }, undefined, undefined, ctx);
        }
        const cancelled = await pending;
        if (action === "tool-abort") {
          expect(cancelled.details.status).toBe("interrupted");
          expect(cancelled.content.map((part) => part.text).join(" ")).not.toContain("run continues");
          expect(pendingDialogs).toBe(0);
        }
        await vi.waitFor(() => {
          expect(dialogSignal?.aborted).toBe(true);
          expect(pendingDialogs).toBe(0);
          expect(emitted.mock.calls.map(([event]) => event.type)).toEqual(["ui_prompt_start", "ui_prompt_end"]);
        });
        expect(fixture.entries.some((entry) => (entry as { kind?: string }).kind === "call_result")).toBe(false);
        if (action === "tool-abort") {
          const control = fixture.toolDefinitions.find(
            (tool) => (tool as { name: string }).name === "workflow_control",
          ) as WorkflowTool;
          await control.execute(
            "resume",
            { action: "resume", run_id: runId },
            new AbortController().signal,
            undefined,
            ctx,
          );
          await vi.waitFor(() =>
            expect(
              fixture.entries.some((entry) => {
                const fact = entry as { kind?: string; status?: string };
                return fact.kind === "workflow_transition" && fact.status === "completed";
              }),
            ).toBe(true),
          );
        }
        await fixture.lifecycle.get("session_shutdown")?.({}, ctx);
      });
    }
  }

  for (const mode of ["rpc", "print"] as const) {
    it(`foreground checkpoints use ${mode === "rpc" ? "RPC dialogs" : "print defaults"}`, async () => {
      const fixture = createPi(false);
      fixture.ctx.mode = mode;
      fixture.ctx.hasUI = mode === "rpc";
      piWorkflows(fixture.pi as never);
      await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
      const result = await workflowTool(fixture).execute(
        "checkpoint",
        {
          script:
            'export const meta = { name: "dialog", description: "test" }; return await checkpoint("proceed?", { default: "fallback" });',
          background: false,
        },
        undefined,
        undefined,
        fixture.ctx,
      );
      expect(result.details.status).toBe("completed");
      expect(result.details.result).toContain(mode === "rpc" ? "true" : "fallback");
      expect(fixture.ctx.ui.confirm).toHaveBeenCalledTimes(mode === "rpc" ? 1 : 0);
      expect(fixture.widgetUpdates).toEqual([]);
      await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
    });
  }

  it("replays checkpoint answers from the executing context's real branch", async () => {
    const fixture = createPi(false);
    fixture.ctx.mode = "rpc";
    fixture.ctx.hasUI = true;
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    const tool = workflowTool(fixture);
    let releaseCheckpoint: (value: boolean) => void = () => {};
    fixture.ctx.ui.confirm.mockResolvedValueOnce(true).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseCheckpoint = resolve;
        }),
    );
    const firstPending = tool.execute(
      "first",
      {
        script:
          'export const meta = { name: "replay", description: "test" }; const answer = await checkpoint("proceed?", { default: false }); await checkpoint("wait"); return answer;',
        background: false,
      },
      undefined,
      undefined,
      fixture.ctx,
    );
    await vi.waitFor(() => expect(fixture.ctx.ui.confirm).toHaveBeenCalledTimes(2));
    const runId = (
      fixture.entries.find((entry) => (entry as { kind?: string }).kind === "run_created") as { runId: string }
    ).runId;
    const control = fixture.toolDefinitions.find(
      (tool) => (tool as { name: string }).name === "workflow_control",
    ) as WorkflowTool;
    await control.execute("pause", { action: "pause", run_id: runId }, undefined, undefined, fixture.ctx);
    const first = await firstPending;
    releaseCheckpoint(false);
    await new Promise((resolve) => setImmediate(resolve));
    // Rebind like a restored session, so replay must come from durable entries.
    await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    const getBranch = vi.fn(fixture.ctx.sessionManager.getBranch);
    const resumed = await tool.execute(
      "second",
      {
        resumeFromRunId: first.details.runId,
        script:
          'export const meta = { name: "replay", description: "test" }; const answer = await checkpoint("proceed?", { default: false }); return answer;',
        background: false,
      },
      undefined,
      undefined,
      {
        ...fixture.ctx,
        sessionManager: { getBranch },
      },
    );
    expect(getBranch).toHaveBeenCalled();
    expect(resumed.details.status).toBe("completed");
    expect(first.details.status).toBe("interrupted");
    expect(fixture.ctx.ui.confirm).toHaveBeenCalledTimes(2);
    await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
  });

  it("renders a live TUI run through ctx.ui and releases that UI on shutdown", async () => {
    const fixture = createPi(false);
    fixture.ctx.mode = "tui";
    fixture.ctx.hasUI = true;
    let resolveConfirm: (value: boolean) => void = () => {};
    fixture.ctx.ui.confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    const pending = workflowTool(fixture).execute(
      "live",
      {
        script: 'export const meta = { name: "live", description: "test" }; return await checkpoint("wait");',
        background: false,
      },
      undefined,
      undefined,
      fixture.ctx,
    );
    await vi.waitFor(() => expect(fixture.widgetUpdates.some((lines) => lines && lines.length > 0)).toBe(true));
    resolveConfirm(true);
    await pending;
    await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
    expect(fixture.widgetUpdates.at(-1)).toBeUndefined();
    const updates = fixture.widgetUpdates.length;
    await Promise.resolve();
    expect(fixture.widgetUpdates).toHaveLength(updates);
  });
  it("does not register tools, commands, ping, or journal state in a child session", async () => {
    const fixture = createPi(true);
    let pinged = false;
    fixture.bus.on("subagents:rpc:ping", () => {
      pinged = true;
    });
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    expect(fixture.tools).toEqual([]);
    expect(fixture.commands).toEqual([]);
    expect(pinged).toBe(false);
    expect(fixture.entries).toEqual([]);
  });

  it("retains the root workflow surface and protocol diagnostic path", async () => {
    const fixture = createPi(false);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fixture.tools).toEqual(["workflow", "workflow_control"]);
    expect(fixture.commands).toContain("workflows");
    expect(fixture.commands).toContain("deep-research");
    expect(fixture.commands).toContain("code-review");
    expect(fixture.commands).toContain("effort");
    await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
  });

  it("re-reads the host tier catalogue on every start rather than pinning the one seen at session start", async () => {
    // The catalogue lives on the peer and the user can edit it mid-session. A
    // start that replayed the activation-time snapshot would reject a tier
    // defined since then as unknown, before ever dispatching it.
    const fixture = createPi(false);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    await new Promise((resolve) => setImmediate(resolve));
    const activationPings = fixture.routing.pings;
    expect(activationPings).toBeGreaterThan(0);

    const workflow = fixture.toolDefinitions.find((tool) => (tool as { name: string }).name === "workflow") as {
      execute: (id: string, params: unknown, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<unknown>;
    };
    const script = "export const meta = { name: 'probe', description: 'no agents' }\nreturn 1";
    await workflow.execute("call-1", { script, background: false }, undefined, undefined, fixture.ctx);
    expect(fixture.routing.pings).toBe(activationPings + 1);

    // A tier the activation snapshot did not contain must be usable now.
    const extended: ManagedRoutingPolicy = {
      ...ROUTING_POLICY,
      profiles: { ...ROUTING_POLICY.profiles, added: { model: "inherit", thinking: "high" } },
    };
    fixture.routing.snapshot = { policy: extended, fingerprint: routingPolicyFingerprint(extended) };
    await workflow.execute("call-2", { script, background: false }, undefined, undefined, fixture.ctx);
    expect(fixture.routing.pings).toBe(activationPings + 2);

    await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
  });

  it("does not start a built-in workflow when protocol negotiation fails", async () => {
    const fixture = createPi(false, 0, [], false);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    const command = fixture.commandDefinitions.get("deep-research") as {
      handler: (args: string, ctx: { ui: { notify: (message: string) => void } }) => Promise<void>;
    };
    const notices: string[] = [];
    await command.handler("question", {
      ...fixture.ctx,
      ui: { notify: (message: string) => notices.push(message) },
    });

    expect(notices.join("\n")).toContain("@signalridge/pi-workflows requires");
    expect(fixture.entries.some((entry) => (entry as { kind?: string }).kind === "run_created")).toBe(false);
    await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
  });

  it("refreshes the widget for a replacement session and clears it on shutdown", async () => {
    const fixture = createPi(false);
    fixture.ctx.mode = "tui";
    fixture.ctx.hasUI = true;
    piWorkflows(fixture.pi as never);
    const sessionStart = fixture.lifecycle.get("session_start");
    const sessionShutdown = fixture.lifecycle.get("session_shutdown");
    if (!sessionStart || !sessionShutdown) throw new Error("workflow lifecycle handlers are missing");
    await sessionStart({}, fixture.ctx);
    fixture.widgetUpdates.length = 0;
    await sessionShutdown({}, fixture.ctx);
    expect(fixture.widgetUpdates).toEqual([undefined]);

    fixture.widgetUpdates.length = 0;
    await sessionStart({}, fixture.ctx);
    expect(fixture.widgetUpdates).toEqual([undefined]);
    await sessionShutdown({}, fixture.ctx);
  });

  it("does not let a built-in command retain a disposed session engine", async () => {
    const fixture = createPi(false);
    piWorkflows(fixture.pi as never);
    const sessionStart = fixture.lifecycle.get("session_start");
    const sessionShutdown = fixture.lifecycle.get("session_shutdown");
    if (!sessionStart || !sessionShutdown) throw new Error("workflow lifecycle handlers are missing");
    await sessionStart({}, fixture.ctx);
    const command = fixture.commandDefinitions.get("deep-research") as {
      handler: (args: string, ctx: { ui: { notify: (message: string) => void } }) => Promise<void>;
    };
    if (!command) throw new Error("built-in command was not registered");
    await sessionShutdown({}, fixture.ctx);

    await sessionStart({}, fixture.ctx);
    const before = fixture.entries.filter((entry) => (entry as { kind?: unknown }).kind === "run_created").length;
    const notices: string[] = [];
    await command.handler("question", {
      ...fixture.ctx,
      ui: { notify: (message: string) => notices.push(message) },
    });
    const after = fixture.entries.filter((entry) => (entry as { kind?: unknown }).kind === "run_created").length;
    expect(after).toBe(before + 1);
    expect(notices.join("\n")).toContain("started in background");

    await sessionShutdown({}, fixture.ctx);
    const shutdownNotices: string[] = [];
    await command.handler("question", {
      ...fixture.ctx,
      ui: { notify: (message: string) => shutdownNotices.push(message) },
    });
    expect(shutdownNotices.join("\n")).toContain("not active in this session context");
    expect(fixture.entries.filter((entry) => (entry as { kind?: unknown }).kind === "run_created")).toHaveLength(after);
  });

  it("quarantines a pre-schema-v4 journal instead of replaying it", async () => {
    const runId = "recovery-loader-run";
    const definition = {
      name: "recovery",
      phases: [],
      tasks: [{ id: "a", subagent_type: "Explore", description: "A", prompt: "A", depends_on: [] }],
      background: true,
    };
    const branch = [
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: { kind: "run_created", schemaVersion: 3, runId, definition, timestamp: 1 },
      },
      {
        type: "custom",
        customType: "pi-workflows:journal",
        data: { kind: "workflow_transition", schemaVersion: 3, runId, status: "running", timestamp: 2 },
      },
    ];
    const fixture = createPi(false, 0, branch);
    piWorkflows(fixture.pi as never);
    await fixture.lifecycle.get("session_start")?.({}, fixture.ctx);
    expect(fixture.tools).toEqual(["workflow", "workflow_control"]);
    // No recovery event is appended for the pre-schema-v4 run — it is quarantined, not replayed.
    expect(fixture.entries.some((entry) => (entry as { kind?: string }).kind === "run_recovery")).toBe(false);
    await fixture.lifecycle.get("session_shutdown")?.({}, fixture.ctx);
  });
});
