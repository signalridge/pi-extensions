import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { WorkflowEngine, type WorkflowQuiesceResult } from "./engine.js";
import { JOURNAL_ENTRY_TYPE, type SessionEntryLike } from "./journal.js";
import { createManagedSpawnClient, PROTOCOL_DIAGNOSTIC, queryChildSessionContextImmediate } from "./rpc-client.js";
import { validateWorkflow } from "./schema.js";
import { showWorkflowNavigator } from "./ui.js";

const WorkflowTierSchema = Type.Union([Type.Literal("small"), Type.Literal("medium"), Type.Literal("large")]);

const PhaseSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    title: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false },
);

const TaskSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    phase: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    tier: Type.Optional(WorkflowTierSchema),
    subagent_type: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.String({ minLength: 1, maxLength: 512 }),
    prompt: Type.String({ minLength: 1, maxLength: 100_000 }),
    depends_on: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 128 })),
    inputs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 128 })),
  },
  { additionalProperties: false },
);

const SynthesisSchema = Type.Object(
  {
    subagent_type: Type.String({ minLength: 1, maxLength: 128 }),
    tier: Type.Optional(WorkflowTierSchema),
    prompt: Type.String({ minLength: 1, maxLength: 100_000 }),
  },
  { additionalProperties: false },
);

const WorkflowSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 512 }),
    description: Type.Optional(Type.String({ maxLength: 100_000 })),
    tier: Type.Optional(WorkflowTierSchema),
    phases: Type.Optional(Type.Array(PhaseSchema, { maxItems: 32 })),
    tasks: Type.Array(TaskSchema, { minItems: 1, maxItems: 128 }),
    synthesis: Type.Optional(SynthesisSchema),
    background: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const ControlSchema = Type.Object(
  {
    action: Type.String({ minLength: 1, maxLength: 32 }),
    run_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);

function textResult(text: string, details: unknown = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function formatStart(result: {
  runId: string;
  status: string;
  background: boolean;
  result?: string;
  error?: string;
  waitAborted?: boolean;
}): string {
  const lines = [
    `Workflow ${result.background ? "started in background" : result.status}: ${result.runId}`,
    `status=${result.status}`,
  ];
  if (result.waitAborted)
    lines.push("wait_aborted=true", "The workflow run continues; retrieve it with workflow_control.");
  if (result.result) lines.push("", result.result.slice(0, 8_000));
  if (result.error) lines.push("", `error=${result.error.slice(0, 2_000)}`);
  return lines.join("\n");
}

export default function piWorkflows(pi: ExtensionAPI): void {
  let engine: WorkflowEngine | undefined;
  let protocolError: string | undefined;
  let protocolCheck: Promise<void> = Promise.resolve();
  let active = false;
  let unsubscribeTreeSignal: (() => void) | undefined;
  let branchQuiesce: Promise<WorkflowQuiesceResult> | undefined;
  let lifecycleGeneration = 0;
  let branchGeneration = 0;
  let protocolAbortController: AbortController | undefined;

  const currentEngine = (): WorkflowEngine => {
    if (!engine) throw new Error("pi-workflows is not active in this session context");
    return engine;
  };

  const registerSurface = (): void => {
    if (active) return;
    active = true;
    const workflowEngine = currentEngine();

    pi.registerTool(
      defineTool({
        name: "workflow",
        label: "Workflow",
        description:
          "Run a strict declarative task DAG through pi-subagents. Workflows submit subagent_type, prompt, description, and an optional semantic tier; execution policy belongs to pi-subagents.",
        promptSnippet: "Run independent tasks as a dependency-aware workflow",
        promptGuidelines: [
          "Use workflow for explicit multi-task DAG orchestration; an optional tier must be small, medium, or large. Do not include model, thinking, concurrency, retry, timeout, or turn-limit settings.",
          "depends_on controls ordering only. To pass a dependency's result into a task, also list it in inputs, which must be a subset of that task's depends_on; those results are appended to the task prompt under a bounded budget.",
          "Use workflow_control to inspect, pause, resume, or stop a background workflow.",
        ],
        parameters: WorkflowSchema,
        renderCall(args, theme) {
          return new Text(theme.fg("toolTitle", theme.bold(`Workflow ${args.name ?? ""}`)), 0, 0);
        },
        renderResult(result, { expanded, isPartial }, theme) {
          const text = result.content[0]?.type === "text" ? result.content[0].text : "";
          if (isPartial) return new Text(theme.fg("warning", "Workflow running…"), 0, 0);
          const preview = expanded ? text.slice(0, 8_000) : text.split("\n").slice(0, 4).join("\n");
          return new Text(
            theme.fg(
              result.details && (result.details as { status?: string }).status === "failed" ? "error" : "dim",
              preview,
            ),
            0,
            0,
          );
        },
        async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
          try {
            await protocolCheck;
          } catch (error: unknown) {
            return textResult(
              protocolError ??
                `${PROTOCOL_DIAGNOSTIC} Diagnostic: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          const definition = validateWorkflow(params);
          const result = await workflowEngine.start(definition, signal);
          return textResult(formatStart(result), result);
        },
      }),
    );

    pi.registerTool(
      defineTool({
        name: "workflow_control",
        label: "Workflow Control",
        description: "List, inspect, pause, resume, or stop workflow runs with bounded machine-readable output.",
        parameters: ControlSchema,
        renderCall(args, theme) {
          return new Text(theme.fg("toolTitle", theme.bold(`Workflow control: ${args.action ?? ""}`)), 0, 0);
        },
        renderResult(result, { expanded }, theme) {
          const text = result.content[0]?.type === "text" ? result.content[0].text : "";
          return new Text(theme.fg("dim", expanded ? text.slice(0, 8_000) : text.slice(0, 1_000)), 0, 0);
        },
        async execute(_toolCallId, params) {
          const action = params.action as "list" | "get" | "pause" | "resume" | "stop";
          if (!["list", "get", "pause", "resume", "stop"].includes(action)) {
            throw new Error(`unknown workflow_control action: ${params.action}`);
          }
          const result = await workflowEngine.control(action, params.run_id);
          return textResult(JSON.stringify(result), result);
        },
      }),
    );

    pi.registerCommand("workflows", {
      description: "Open the workflow run navigator",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        await showWorkflowNavigator(ctx, workflowEngine);
      },
    });

    const beginBranchQuiesce = (): Promise<WorkflowQuiesceResult> => {
      if (!branchQuiesce) {
        branchQuiesce = workflowEngine.quiesceForBranchChange().then((result) => {
          if (!result.settled) {
            console.warn(
              `[pi-workflows] ${result.diagnostic ?? "branch quiescence did not settle; stale events are quarantined"}`,
            );
          }
          return result;
        });
      }
      return branchQuiesce;
    };

    unsubscribeTreeSignal = pi.events.on("subagents:session_before_tree", () => {
      void beginBranchQuiesce();
    });

    pi.on("session_before_tree", async () => {
      await beginBranchQuiesce();
    });
    pi.on("session_tree", (_event, ctx) => {
      let entries: SessionEntryLike[];
      try {
        entries = ctx.sessionManager.getBranch() as unknown as SessionEntryLike[];
      } catch {
        // A reload may invalidate the old lifecycle context before the tree
        // callback is delivered. Do not let stale-context access escape.
        return;
      }
      workflowEngine.suspendLifecycle();
      branchGeneration += 1;
      try {
        workflowEngine.restore(entries, branchGeneration);
      } catch (error: unknown) {
        // Keep the lifecycle surface alive after a failed recovery append. The
        // engine rolls its candidate state back transactionally; a later tree
        // event can retry the same branch without leaving workflows inert.
        console.warn(
          `[pi-workflows] session tree recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        workflowEngine.resumeLifecycle();
        branchQuiesce = undefined;
      }
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    if (active || engine) return;
    const generation = ++lifecycleGeneration;
    let initialEntries: SessionEntryLike[];
    try {
      initialEntries = ctx.sessionManager.getBranch() as unknown as SessionEntryLike[];
    } catch {
      // The lifecycle context may already be invalid during a reload race.
      return;
    }

    // Dispatch the formal child-context query synchronously. The event bus
    // delivers the reply synchronously, which lets us filter child sessions
    // before registering any Pi tools while keeping startup nonblocking.
    let child: boolean | undefined;
    try {
      child = queryChildSessionContextImmediate(pi.events);
    } catch {
      child = undefined;
    }
    if (child === true) return;

    protocolAbortController = new AbortController();
    // Tool-call signals only cancel the foreground wait. Managed RPCs use this
    // session-lifetime controller so a host with no ctx.signal still cancels
    // outstanding requests during session_shutdown.
    const client = createManagedSpawnClient(pi.events, protocolAbortController.signal, protocolAbortController.signal);

    // Recovery appends can fail transiently (for example while Pi is flushing a
    // branch). Build and restore a disposable candidate, retrying against the
    // latest branch snapshot before exposing the workflow surface. Never leave
    // `engine` assigned while restore is half-complete.
    let recoveredEngine: WorkflowEngine | undefined;
    let recoveryError: unknown;
    for (let attempt = 0; attempt < 3 && !recoveredEngine; attempt += 1) {
      const candidate = new WorkflowEngine(pi.events, client, {
        append(event) {
          pi.appendEntry(JOURNAL_ENTRY_TYPE, event);
        },
      });
      try {
        const entries =
          attempt === 0 ? initialEntries : (ctx.sessionManager.getBranch() as unknown as SessionEntryLike[]);
        candidate.restore(entries, branchGeneration);
        recoveredEngine = candidate;
      } catch (error: unknown) {
        recoveryError = error;
        candidate.dispose();
        if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    if (!recoveredEngine) {
      console.warn(
        `[pi-workflows] session recovery failed; workflow surface remains disabled: ${
          recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        }`,
      );
      return;
    }

    engine = recoveredEngine;
    branchGeneration = 0;
    registerSurface();

    protocolError = undefined;
    protocolCheck = client.checkProtocol?.() ?? Promise.reject(new Error("managed protocol check is unavailable"));
    void protocolCheck.catch((error: unknown) => {
      if (generation !== lifecycleGeneration) return;
      const detail = error instanceof Error ? error.message : String(error);
      // Missing pi-subagents is a valid independent-package activation state.
      // Keep startup nonblocking and defer the bounded diagnostic to the next
      // workflow tool call instead of logging a spurious startup error.
      protocolError = `${PROTOCOL_DIAGNOSTIC} Diagnostic: ${detail}`;
    });
  });

  pi.on("session_shutdown", () => {
    lifecycleGeneration += 1;
    protocolAbortController?.abort();
    protocolAbortController = undefined;
    unsubscribeTreeSignal?.();
    unsubscribeTreeSignal = undefined;
    engine?.dispose();
    engine = undefined;
    active = false;
    branchQuiesce = undefined;
    branchGeneration = 0;
    protocolCheck = Promise.resolve();
    protocolError = undefined;
  });
}

export { validateWorkflow, WorkflowSchema };
