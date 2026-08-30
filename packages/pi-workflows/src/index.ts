import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { DEFAULT_TRIGGER_WORD, hasTriggerWord, WORKFLOW_ARMED_DIRECTIVE } from "./arming.js";
import { BUILTIN_WORKFLOWS, validateBuiltinArgs } from "./builtins.js";
import { type CommandResult, resolveCodeReviewScope } from "./code-review-scope.js";
import { type ScriptStartOptions, type ScriptStartResult, WorkflowEngine, WorkflowWaitAbortedError } from "./engine.js";
import { JOURNAL_ENTRY_TYPE, type SessionEntryLike } from "./journal.js";
import {
  createManagedSpawnClient,
  type ManagedProtocolCheck,
  PROTOCOL_DIAGNOSTIC,
  queryChildSessionContextImmediate,
} from "./rpc-client.js";
import { listSavedWorkflows, loadSavedWorkflow, saveWorkflow } from "./saved-workflows.js";
import { liveWidgetLines, showWorkflowNavigator } from "./ui.js";
import { loadWorkflowSettings, saveWorkflowSettings } from "./workflow-settings.js";

const WorkflowToolSchema = Type.Object(
  {
    script: Type.Optional(Type.String({ maxLength: 200_000 })),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    args: Type.Optional(Type.Any()),
    background: Type.Optional(Type.Boolean()),
    maxAgents: Type.Optional(Type.Number({ minimum: 1 })),
    concurrency: Type.Optional(Type.Number({ minimum: 1 })),
    agentRetries: Type.Optional(Type.Number({ minimum: 0, maximum: 3 })),
    tokenBudget: Type.Optional(Type.Number({ minimum: 1 })),
    agentTimeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
    resumeFromRunId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);

const ControlSchema = Type.Object(
  {
    action: Type.Union(
      [
        Type.Literal("list", { description: "List all workflow runs" }),
        Type.Literal("get", { description: "Get details for one run" }),
        Type.Literal("status", { description: "Alias for get — inspect one run" }),
        Type.Literal("pause", { description: "Pause a running workflow" }),
        Type.Literal("resume", { description: "Resume a paused/interrupted workflow" }),
        Type.Literal("stop", { description: "Stop a running workflow" }),
        Type.Literal("rm", { description: "Remove a workflow run and its journal" }),
      ],
      { description: "Control action" },
    ),
    run_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    // Accept camelCase and legacy workflow_run_id for interop with pi-dynamic-workflows docs
    runId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    workflow_run_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);

function normalizeControlRunId(params: Record<string, unknown>): string | undefined {
  const raw = params.run_id ?? params.runId ?? params.workflow_run_id ?? params.runID ?? params.workflowRunId;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function textResult(text: string, details: unknown = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

/**
 * Run one command for diff discovery. argv array, never a shell string — a
 * branch name or path reaches this from user input.
 */
function runCommand(file: string, args: string[]): CommandResult {
  try {
    const stdout = execFileSync(file, args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, stdout };
  } catch {
    // Non-zero exit or a missing binary. Either way there is no usable diff;
    // the caller decides whether to degrade or report.
    return { ok: false, stdout: "" };
  }
}

/** Control subcommands of `/workflows` that take a run id. */
export type WorkflowControlSubcommand = "stop" | "pause" | "resume" | "rm";

/**
 * Resolve which run a `/workflows <subcommand>` invocation acts on.
 *
 * `stop` and `rm` are destructive — stopping kills the run's owned agents, and
 * `rm` deletes the run and its journal — so they take no implicit target: a
 * bare `/workflows rm` must never act on whatever `list()` happens to return
 * first. `pause` and `resume` are reversible, so they keep the convenience
 * default for the common single-run case.
 *
 * Returns the empty string when the caller must be asked for an explicit id.
 */
export function resolveControlTarget(
  subcommand: WorkflowControlSubcommand,
  explicitRunId: string,
  firstListedRunId: string | undefined,
): string {
  if (explicitRunId) return explicitRunId;
  if (subcommand === "stop" || subcommand === "rm") return "";
  return firstListedRunId ?? "";
}

function formatStart(result: ScriptStartResult): string {
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

/** Build the bounded planner → graph → synthesis script used by `/workflows run`. */
export function buildAdHocWorkflowScript(prompt: string): string {
  return `export const meta = { name: "ad-hoc", description: "Plan, execute, and synthesize a bounded multi-agent task graph" };
const originalPrompt = ${JSON.stringify(prompt)};
const plan = await agent("Design a bounded execution plan for this user task. Return 1-8 independent or dependency-linked tasks. Use unique short ids, concise descriptions, exact worker prompts, and only dependencies that appear in the task list. Prefer independent tasks when possible. User task:\\n\\n" + originalPrompt, {
  label: "planner",
  tier: "medium",
  schema: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1, maxLength: 64 },
            description: { type: "string", minLength: 1, maxLength: 500 },
            prompt: { type: "string", minLength: 1, maxLength: 8000 },
            dependsOn: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 64 } },
          },
          required: ["id", "description", "prompt"],
          additionalProperties: false,
        },
      },
    },
    required: ["tasks"],
    additionalProperties: false,
  },
});
const graph = await orchestrate(plan.tasks.map((task) => ({
  id: task.id,
  description: task.description,
  dependsOn: task.dependsOn || [],
  run: ({ results, statuses }) => agent(task.prompt + "\\n\\nDependency results (null means unavailable):\\n" + JSON.stringify({ results, statuses }), { label: task.id, tier: "low" }),
})), { onError: "continue" });
const SYNTHESIS_CONTEXT_LIMIT = 78000;
function renderContextValue(value) {
  const rendered = JSON.stringify(value);
  return rendered === undefined ? String(value) : rendered;
}
function boundContextText(value, maxEncodedChars) {
  const text = String(value);
  const encodedLength = (candidate) => JSON.stringify(candidate).length - 2;
  if (encodedLength(text) <= maxEncodedChars) return { text, truncated: false, marker: null };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encodedLength(text.slice(0, middle)) <= maxEncodedChars) low = middle;
    else high = middle - 1;
  }
  return {
    text: text.slice(0, low),
    truncated: true,
    marker: "[TRUNCATED " + (text.length - low) + " SOURCE CHARACTERS]",
  };
}
const planMetadata = {
  taskCount: plan.tasks.length,
  tasks: plan.tasks.map((task) => {
    const description = boundContextText(task.description, 500);
    return {
      id: task.id,
      description: description.text,
      descriptionTruncated: description.truncated,
      descriptionTruncationMarker: description.marker,
      dependsOn: task.dependsOn || [],
    };
  }),
};
function makeSynthesisContext(valuePreviewBudget, originalPromptBudget) {
  const boundedOriginalPrompt = boundContextText(originalPrompt, originalPromptBudget);
  const tasks = Object.keys(graph.tasks).map((id) => {
    const task = graph.tasks[id];
    const error = task.error == null ? null : boundContextText(task.error, 1000);
    const value = boundContextText(renderContextValue(task.value), valuePreviewBudget);
    return {
      id,
      status: task.status,
      attempts: task.attempts,
      error: error == null ? null : error.text,
      errorTruncated: error == null ? false : error.truncated,
      errorTruncationMarker: error == null ? null : error.marker,
      valuePreview: value.text,
      valueTruncated: value.truncated,
      valueTruncationMarker: value.marker,
    };
  });
  return {
    originalPrompt: boundedOriginalPrompt.text,
    originalPromptTruncated: boundedOriginalPrompt.truncated,
    originalPromptTruncationMarker: boundedOriginalPrompt.marker,
    plan: planMetadata,
    tasks,
  };
}
let valuePreviewBudget = 6000;
let originalPromptBudget = 16000;
let synthesisContext = makeSynthesisContext(valuePreviewBudget, originalPromptBudget);
let synthesisJson = JSON.stringify(synthesisContext);
while (synthesisJson.length > SYNTHESIS_CONTEXT_LIMIT && (valuePreviewBudget > 128 || originalPromptBudget > 256)) {
  valuePreviewBudget = Math.max(128, Math.floor(valuePreviewBudget * 0.75));
  originalPromptBudget = Math.max(256, Math.floor(originalPromptBudget * 0.75));
  synthesisContext = makeSynthesisContext(valuePreviewBudget, originalPromptBudget);
  synthesisJson = JSON.stringify(synthesisContext);
}
if (synthesisJson.length > SYNTHESIS_CONTEXT_LIMIT) throw new Error("Unable to fit the synthesis context within its managed prompt budget");
return await agent("Synthesize the worker results into a direct answer to the original task. Mention incomplete or failed coverage explicitly.\\n\\nOriginal task, execution plan, and graph ledger:\\n" + synthesisJson, { label: "synthesizer", tier: "medium" });`;
}

export default function piWorkflows(pi: ExtensionAPI): void {
  let engine: WorkflowEngine | undefined;
  let protocolError: string | undefined;
  let protocolCheck: Promise<ManagedProtocolCheck> | undefined;
  let protocolProbe: (() => Promise<ManagedProtocolCheck>) | undefined;
  let protocolInFlight: Promise<ManagedProtocolCheck> | undefined;
  /**
   * Track one in-flight probe so concurrent starts share it, and release it the
   * moment it settles.
   *
   * Releasing matters: the catalogue is read live on the peer's side, so the
   * next start or resume must issue a *new* ping. Holding a settled promise
   * here would pin every later run to the routing policy as it stood at session
   * start, and a tier defined since then would be rejected pre-dispatch as
   * unknown.
   */
  const trackProbe = (check: Promise<ManagedProtocolCheck>): Promise<ManagedProtocolCheck> => {
    protocolInFlight = check;
    const release = () => {
      if (protocolInFlight === check) protocolInFlight = undefined;
    };
    void check.then(release, release);
    return check;
  };
  const awaitProtocol = async (): Promise<ManagedProtocolCheck> => {
    let check = protocolInFlight;
    if (!check) {
      if (protocolProbe) protocolError = undefined;
      check = protocolProbe?.() ?? protocolCheck;
      if (!check) throw new Error(`${PROTOCOL_DIAGNOSTIC} Diagnostic: no active protocol probe`);
      trackProbe(check);
    }
    try {
      const result = await check;
      protocolError = undefined;
      return result;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(protocolError ?? `${PROTOCOL_DIAGNOSTIC} Diagnostic: ${detail}`);
    }
  };
  let active = false;
  let surfaceRegistered = false;
  const registeredWorkflowCommands = new Set<string>();
  let branchQuiesce: Promise<{ settled: boolean; pending: string[]; diagnostic?: string }> | undefined;
  let lifecycleGeneration = 0;
  let protocolAbortController: AbortController | undefined;
  let sessionCwd = process.cwd();
  let workflowSettings = loadWorkflowSettings(sessionCwd);
  let effortLevel: "off" | "high" | "ultra" = workflowSettings.effort;
  let triggerKeyword: string | undefined = workflowSettings.keywordTriggerWord;
  let keywordTriggerEnabled = workflowSettings.keywordTriggerEnabled;
  /** Per-session delivery endpoint for background-run results (A10 fail-closed). */
  let deliverResult: ((text: string, details?: unknown) => void) | undefined;
  /** Pending deliveries for runs that settled before a session endpoint was bound (A10). */
  const pendingDeliveryMarkers = new Map<string, { text: string; timestamp: number }>();
  const PENDING_DELIVERY_TYPE = "pi-workflows:pending-delivery";
  const PENDING_DELIVERY_ACK_TYPE = "pi-workflows:pending-delivery-ack";
  const MAX_PENDING_DELIVERIES = 256;
  const PENDING_DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
  let widgetTimer: ReturnType<typeof setInterval> | undefined;

  const currentEngine = (): WorkflowEngine => {
    if (!active || !engine || engine.isDisposed())
      throw new Error("pi-workflows is not active in this session context");
    return engine;
  };

  const clearWidget = (): void => {
    const tui = (pi as unknown as { ui?: { setWidget?: (key: string, content: string[] | undefined) => void } }).ui;
    tui?.setWidget?.("pi-workflows", undefined);
  };
  const refreshWidget = (): void => {
    const tui = (pi as unknown as { ui?: { setWidget?: (key: string, content: string[] | undefined) => void } }).ui;
    if (!tui?.setWidget) return;
    const workflowEngine = engine;
    if (!active || !workflowEngine || workflowEngine.isDisposed()) {
      tui.setWidget("pi-workflows", undefined);
      if (widgetTimer) {
        clearInterval(widgetTimer);
        widgetTimer = undefined;
      }
      return;
    }
    const runs = workflowEngine
      .list()
      .map((summary) => workflowEngine.getRun(String(summary.runId)))
      .filter((run): run is NonNullable<typeof run> => run !== undefined);
    const lines = liveWidgetLines(runs, workflowSettings.progressMode, workflowSettings.maxAgentsShown);
    tui.setWidget("pi-workflows", lines.length > 0 ? lines : undefined);
    if (lines.length > 0 && !widgetTimer) {
      widgetTimer = setInterval(refreshWidget, 2_000);
    } else if (lines.length === 0 && widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = undefined;
    }
  };
  const notifyRunChanged = (): void => refreshWidget();

  const branchEntries = (): SessionEntryLike[] => {
    const ctx = (pi as unknown as { currentSessionManager?: { getBranch?: () => unknown } }).currentSessionManager;
    try {
      return (ctx?.getBranch?.() as SessionEntryLike[] | undefined) ?? [];
    } catch {
      return [];
    }
  };

  const DEFAULT_EXCLUDED_TOOLS = ["workflow", "workflow_control"] as const;

  /**
   * Resolve a nested `workflow(name)` reference, saying where the script came
   * from.
   *
   * Shipped-ness has to be reported per script rather than inherited from the
   * frame that called it: a user script may call a built-in by name, and a
   * built-in's tier names are preferences against whatever catalogue the host
   * defines, while a user script's are assertions about a catalogue the user
   * owns. Inheriting the caller's flag would apply the wrong rule in both
   * directions.
   */
  const resolveNestedWorkflow = (name: string): { script: string; shippedScript?: boolean } | undefined => {
    // A saved file shadows a built-in of the same name; it is the user's own
    // script and keeps the strict tier check.
    const saved = loadSavedWorkflow(name, sessionCwd);
    if (saved !== undefined) return { script: saved };
    const builtin = BUILTIN_WORKFLOWS[name]?.script;
    return builtin === undefined ? undefined : { script: builtin, shippedScript: true };
  };

  const resolveScript = (
    script: string | undefined,
    name: string | undefined,
    args: unknown,
  ): { script: string; source: string; toolset?: string; shippedScript?: boolean } => {
    if (script !== undefined && name !== undefined) {
      throw new Error("Provide either `script` or `name`, not both.");
    }
    if (script !== undefined) return { script, source: "inline" };
    if (name !== undefined) {
      // A saved workflow is the user's own file even when it shadows a built-in
      // name, so it keeps the strict tier check.
      const saved = loadSavedWorkflow(name, sessionCwd);
      if (saved) return { script: saved, source: `saved:${name}` };
      const builtin = BUILTIN_WORKFLOWS[name];
      if (builtin) {
        // Validate named invocations before starting a potentially expensive fleet.
        // Slash commands provide the same shape through their descriptor primaryArg.
        validateBuiltinArgs(name, args);
        return {
          script: builtin.script,
          source: `builtin:${name}`,
          toolset: builtin.toolset,
          shippedScript: true,
        };
      }
      throw new Error(`Unknown workflow name "${name}". It is neither a saved workflow nor a built-in.`);
    }
    throw new Error("Provide either `script` or `name`.");
  };

  const registerSurface = (): void => {
    if (active) return;
    active = true;
    const workflowEngine = currentEngine();
    workflowEngine.onRunSettled = notifyRunChanged;
    // Command/tool registrations persist across session replacement, but the
    // widget belongs to the newly restored engine and must be refreshed too.
    refreshWidget();
    if (surfaceRegistered) return;
    surfaceRegistered = true;

    pi.registerTool(
      defineTool({
        name: "workflow",
        label: "Workflow",
        description:
          "Run a JavaScript workflow script through the pi-subagents managed spawning protocol. The script declares `export const meta = { name, description, phases }` first and uses the runtime globals agent(), parallel(), pipeline(), orchestrate(), workflow(), verify(), judgePanel(), loopUntilDry(), completenessCheck(), retry(), gate(), checkpoint(), phase(), log(), args, cwd, process, and budget. Determinism is enforced: Date.now()/Math.random()/new Date() are unavailable.",
        promptSnippet: "Run a JavaScript workflow script",
        promptGuidelines: [
          "Provide either a full `script` (raw JavaScript with the meta contract first) or a `name` of a saved/built-in workflow.",
          "Use orchestrate([{ id, dependsOn, run }]) for named dependency graphs; use parallel(() => agent(...), ...) for a simple fan-out and pipeline(items, ...stages) for sequential per-item stages.",
          "Use background: true for long runs; retrieve results with workflow_control.",
          "Use resumeFromRunId with an edited script to replay the unchanged prefix from cache and re-run the rest live.",
          "Do not include model, thinking, concurrency, retry, timeout, or turn-limit settings beyond the declared options.",
        ],
        parameters: WorkflowToolSchema,
        renderCall(args, theme) {
          const label = args.name ?? (args.script !== undefined ? "script" : "");
          return new Text(theme.fg("toolTitle", theme.bold(`Workflow ${label}`)), 0, 0);
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
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          try {
            const workflowEngine = currentEngine();
            const resolved =
              params.resumeFromRunId && params.script === undefined && params.name === undefined
                ? (() => {
                    const prior = workflowEngine.getRun(params.resumeFromRunId);
                    if (!prior) throw new Error(`Workflow run not found: ${params.resumeFromRunId}`);
                    // Resume reads the frozen flag off the restored run, so
                    // this only has to satisfy the shared shape.
                    return { script: prior.script, source: "resume", toolset: prior.toolset, shippedScript: undefined };
                  })()
                : resolveScript(params.script, params.name, params.args);
            const { script, source, toolset, shippedScript } = resolved;
            const options: ScriptStartOptions = {
              args: params.args,
              background: params.background ?? true,
              maxAgents: params.maxAgents,
              concurrency: params.concurrency,
              agentRetries: params.agentRetries,
              tokenBudget: params.tokenBudget,
              agentTimeoutMs: params.agentTimeoutMs,
              toolset,
              ...(shippedScript === undefined ? {} : { shippedScript }),
              excludeTools: [...DEFAULT_EXCLUDED_TOOLS],
              signal,
              mainModel: ctx?.model?.id,
              // Foreground checkpoint confirmation only when the run is not
              // background — background runs are headless by contract.
              confirm:
                params.background === false && ctx?.hasUI && ctx.mode === "tui"
                  ? async (promptText, checkpointOptions) => {
                      if (checkpointOptions.kind === "input")
                        return ctx.ui.input(promptText, String(checkpointOptions.default ?? ""));
                      if (checkpointOptions.kind === "select")
                        return ctx.ui.select(promptText, checkpointOptions.choices ?? []);
                      return ctx.ui.confirm(promptText, promptText);
                    }
                  : undefined,
              loadSavedWorkflow: resolveNestedWorkflow,
            };
            if (params.resumeFromRunId) {
              const replacement = params.script !== undefined || params.name !== undefined ? script : undefined;
              const resumed = await workflowEngine.resume(
                params.resumeFromRunId,
                branchEntries(),
                options,
                replacement,
              );
              if (!resumed) return textResult(`Workflow run not found: ${params.resumeFromRunId}`);
              if (resumed.background) void deliverBackgroundResult(workflowEngine, resumed.runId);
              return textResult(formatStart(resumed), resumed);
            }
            const result = await workflowEngine.start(script, options);
            if (result.background) {
              // The engine resolves the script's meta name for the delivery header.
              void source;
              void deliverBackgroundResult(workflowEngine, result.runId);
            }
            return textResult(formatStart(result), result);
          } catch (error: unknown) {
            return textResult(error instanceof Error ? error.message : String(error));
          }
        },
      }),
    );

    pi.registerTool(
      defineTool({
        name: "workflow_control",
        label: "Workflow Control",
        description:
          "List, inspect, pause, resume, stop, or remove workflow runs with bounded machine-readable output.",
        parameters: ControlSchema,
        renderCall(args, theme) {
          return new Text(theme.fg("toolTitle", theme.bold(`Workflow control: ${args.action ?? ""}`)), 0, 0);
        },
        renderResult(result, { expanded }, theme) {
          const text = result.content[0]?.type === "text" ? result.content[0].text : "";
          return new Text(theme.fg("dim", expanded ? text.slice(0, 8_000) : text.slice(0, 1_000)), 0, 0);
        },
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
          try {
            const rawAction = params.action as string;
            const action = (rawAction === "status" ? "get" : rawAction) as
              | "list"
              | "get"
              | "pause"
              | "resume"
              | "stop"
              | "rm";
            if (!["list", "get", "pause", "resume", "stop", "rm"].includes(action)) {
              throw new Error(`unknown workflow_control action: ${params.action}`);
            }
            const runId = normalizeControlRunId(params as unknown as Record<string, unknown>);
            const workflowEngine = currentEngine();
            const result = await workflowEngine.control(action, runId);
            return textResult(JSON.stringify(result), result);
          } catch (error: unknown) {
            return textResult(error instanceof Error ? error.message : String(error));
          }
        },
      }),
    );

    // /workflows: navigator + run/status/watch/stop/pause/resume/rm/save subcommands
    pi.registerCommand("workflows", {
      description: "Workflow runs: open the navigator, or run/status/watch/stop/pause/resume/rm/save",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const [subcommand, ...rest] = tokens;
        const restArgs = rest.join(" ").trim();
        const engineForCommand = (): WorkflowEngine | undefined => {
          try {
            return currentEngine();
          } catch (error: unknown) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            return undefined;
          }
        };
        if (!subcommand) {
          await showWorkflowNavigator(ctx, currentEngine);
          return;
        }
        if (subcommand === "run") {
          if (!restArgs) {
            ctx.ui.notify("/workflows run <prompt-or-script>", "warning");
            return;
          }
          const runId = await runWorkflowFromPrompt(ctx, restArgs);
          if (runId) ctx.ui.notify(`Workflow started in background: ${runId}`, "info");
          return;
        }
        if (subcommand === "status") {
          const workflowEngine = engineForCommand();
          if (!workflowEngine) return;
          if (restArgs) {
            const run = workflowEngine.getRun(restArgs);
            if (!run) {
              ctx.ui.notify(`Workflow run not found: ${restArgs}`, "warning");
              return;
            }
            ctx.ui.notify(`${run.runId} · ${run.status} · ${String(run.meta?.name ?? run.runId)}`, "info");
            return;
          }
          const runs = workflowEngine.list();
          ctx.ui.notify(
            runs.length === 0
              ? "No workflow runs."
              : runs.map((r) => `${r.runId} · ${r.status} · ${String(r.name)}`).join("\n"),
            "info",
          );
          return;
        }
        if (subcommand === "watch") {
          const workflowEngine = engineForCommand();
          if (!workflowEngine) return;
          const runId = restArgs || String(workflowEngine.list()[0]?.runId ?? "");
          if (!runId) {
            ctx.ui.notify("No workflow runs to watch.", "warning");
            return;
          }
          const run = await workflowEngine.waitFor(runId).catch(() => undefined);
          if (run) ctx.ui.notify(`${run.runId} settled as ${run.status}`, "info");
          return;
        }
        if (subcommand === "stop" || subcommand === "pause" || subcommand === "resume" || subcommand === "rm") {
          const listedEngine = engineForCommand();
          if (!listedEngine) return;
          const firstListed = listedEngine.list()[0]?.runId;
          const runId = resolveControlTarget(
            subcommand,
            restArgs,
            firstListed === undefined ? undefined : String(firstListed),
          );
          if (!runId) {
            const destructive = subcommand === "stop" || subcommand === "rm";
            ctx.ui.notify(
              destructive
                ? `/workflows ${subcommand} <runId> — a run id is required; /workflows status lists them`
                : `/workflows ${subcommand} <runId>`,
              "warning",
            );
            return;
          }
          try {
            const workflowEngine = engineForCommand();
            if (!workflowEngine) return;
            await workflowEngine.control(subcommand, runId);
            if (subcommand === "resume") void deliverBackgroundResult(workflowEngine, runId);
            ctx.ui.notify(`Workflow ${subcommand} requested: ${runId}`, "info");
          } catch (error: unknown) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          }
          return;
        }
        if (subcommand === "save") {
          const name = rest[0] ?? "";
          if (!name) {
            ctx.ui.notify("/workflows save <name> [runId]", "warning");
            return;
          }
          const workflowEngine = engineForCommand();
          if (!workflowEngine) return;
          // Fallback to most recent run when runId omitted — matches upstream runs.find(r=>r.script)
          const runId = rest[1] ?? String(workflowEngine.list()[0]?.runId ?? "");
          if (!runId) {
            ctx.ui.notify("No workflow runs to save.", "warning");
            return;
          }
          try {
            await saveWorkflowFromRun(ctx, name, runId);
          } catch (error: unknown) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          }
          return;
        }
        ctx.ui.notify(`Unknown /workflows subcommand: ${subcommand}`, "warning");
      },
    });

    // /workflows-models: tier configuration is owned by pi-subagents; this
    // command documents the delegation (A8: no second tier config file).
    pi.registerCommand("workflows-models", {
      description: "Workflow tier routing: tiers are configured in pi-subagents /agents → Model tiers",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        ctx.ui.notify(
          "Workflow tiers (small/medium/large) route through pi-subagents' workflow.tiers settings. " +
            "Use /agents → Model tiers to configure them.",
          "info",
        );
      },
    });

    // /workflows-progress: persistent compact/detailed live-panel settings.
    pi.registerCommand("workflows-progress", {
      description: "Workflow progress panel: compact|detailed|status|max <N>",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const action = tokens[0] ?? "status";
        if (action === "status") {
          ctx.ui.notify(
            `Workflow progress: ${workflowSettings.progressMode}, max agents shown: ${workflowSettings.maxAgentsShown}`,
            "info",
          );
          return;
        }
        if (action === "compact" || action === "detailed") {
          workflowSettings = { ...workflowSettings, progressMode: action };
        } else if (action === "max") {
          const max = Number(tokens[1]);
          if (!Number.isInteger(max) || max < 1 || max > 32) {
            ctx.ui.notify("Usage: /workflows-progress max <1-32>", "warning");
            return;
          }
          workflowSettings = { ...workflowSettings, maxAgentsShown: max };
        } else {
          ctx.ui.notify("Usage: /workflows-progress compact|detailed|status|max <N>", "warning");
          return;
        }
        try {
          saveWorkflowSettings(workflowSettings, sessionCwd);
          refreshWidget();
          ctx.ui.notify(
            `Workflow progress set to ${workflowSettings.progressMode}, max ${workflowSettings.maxAgentsShown}.`,
            "info",
          );
        } catch (error: unknown) {
          ctx.ui.notify(
            `Could not save workflow progress settings: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        }
      },
    });

    // /workflows-trigger: keyword arming (A5). Typing the bounded word
    // `workflow`/`workflows` — or a configured synonym — in an ordinary message
    // counts as an explicit opt-in to multi-agent orchestration, and the message
    // is annotated to say so. Arming AUTHORIZES the tool; it never forces a run,
    // and it never opens UI. A user asking a question about workflows still gets
    // an ordinary answer.
    const TRIGGER_WORD_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u;
    const persistTriggerSettings = (): void => {
      workflowSettings = { ...workflowSettings, keywordTriggerWord: triggerKeyword, keywordTriggerEnabled };
      try {
        saveWorkflowSettings(workflowSettings, sessionCwd);
      } catch {
        /* setting changes remain active in memory */
      }
    };
    pi.registerCommand("workflows-trigger", {
      description: "Arm the workflow tool on a keyword: set <keyword> | off | on | reset | status",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const token = args.trim().split(/\s+/)[0] ?? "";
        if (token === "off") {
          keywordTriggerEnabled = false;
          persistTriggerSettings();
          ctx.ui.notify("Workflow keyword trigger disabled.", "info");
          return;
        }
        if (token === "on") {
          keywordTriggerEnabled = true;
          persistTriggerSettings();
          ctx.ui.notify(`Workflow keyword trigger armed on "${triggerKeyword ?? DEFAULT_TRIGGER_WORD}".`, "info");
          return;
        }
        if (token === "reset") {
          triggerKeyword = undefined;
          keywordTriggerEnabled = true;
          persistTriggerSettings();
          ctx.ui.notify(`Workflow keyword trigger reset to default "${DEFAULT_TRIGGER_WORD}".`, "info");
          return;
        }
        if (token === "status") {
          ctx.ui.notify(
            `Workflow keyword trigger: ${keywordTriggerEnabled ? "armed" : "disabled"} on "${triggerKeyword ?? DEFAULT_TRIGGER_WORD}"`,
            "info",
          );
          return;
        }
        const keyword = token === "set" ? (args.trim().split(/\s+/)[1] ?? "") : token;
        if (!TRIGGER_WORD_PATTERN.test(keyword)) {
          ctx.ui.notify("Usage: /workflows-trigger set <one-word-keyword> | off | on | reset | status", "warning");
          return;
        }
        triggerKeyword = keyword.toLowerCase();
        keywordTriggerEnabled = true;
        persistTriggerSettings();
        ctx.ui.notify(`Workflow keyword trigger armed on "${keyword}".`, "info");
      },
    });

    // Keyword arming input hook (A5). The message is annotated rather than
    // acted on: the model is told it may use the `workflow` tool and may still
    // decline, which is what keeps "how do workflows work?" an ordinary
    // question. Nothing is swallowed and no UI opens.
    pi.on("input", (event) => {
      if (event.source === "extension") return { action: "continue" as const };
      const explicitTrigger = keywordTriggerEnabled && hasTriggerWord(event.text, triggerKeyword);
      const substantive = effortLevel !== "off" && event.text.trim().length >= 16 && !event.text.trim().startsWith("/");
      if (!explicitTrigger && !substantive) return { action: "continue" as const };
      if (event.text.includes(WORKFLOW_ARMED_DIRECTIVE)) return { action: "continue" as const };
      const effortDirective =
        effortLevel === "ultra"
          ? "Effort: ULTRA. Be exhaustive: use broad parallel review, verification, and completeness checks; choose the large tier where useful."
          : effortLevel === "high"
            ? "Effort: HIGH. Be thorough: use several independent reviewers and an adversarial verification pass."
            : "";
      return {
        action: "transform" as const,
        text: `${event.text}\n\n${WORKFLOW_ARMED_DIRECTIVE}${effortDirective ? `\n${effortDirective}` : ""}`,
        ...(event.images ? { images: event.images } : {}),
      };
    });

    // Standing effort mode mirrors the reference: it auto-arms substantive
    // interactive messages but remains guidance, not an inferred spend ceiling.
    pi.registerCommand("effort", {
      description: "Standing workflow effort: off | high | ultra",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const level = args.trim().toLowerCase();
        if (level !== "off" && level !== "high" && level !== "ultra") {
          ctx.ui.notify(`Effort is currently "${effortLevel}". Usage: /effort off|high|ultra`, "info");
          return;
        }
        effortLevel = level;
        workflowSettings = { ...workflowSettings, effort: effortLevel };
        try {
          saveWorkflowSettings(workflowSettings, sessionCwd);
        } catch {
          /* warning is non-fatal */
        }
        ctx.ui.notify(
          level === "off"
            ? "Effort off — messages are no longer auto-armed."
            : `Effort ${level} enabled for substantive messages.`,
          "info",
        );
      },
    });
    pi.registerCommand("ultracode", {
      description: "Ultracode: toggle exhaustive workflow effort",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        effortLevel = args.trim().toLowerCase() === "off" ? "off" : "ultra";
        workflowSettings = { ...workflowSettings, effort: effortLevel };
        try {
          saveWorkflowSettings(workflowSettings, sessionCwd);
        } catch {
          /* warning is non-fatal */
        }
        ctx.ui.notify(
          effortLevel === "off"
            ? "Ultracode off."
            : "Ultracode on — substantive messages use exhaustive workflow guidance.",
          "info",
        );
      },
    });

    // Builtin workflow commands (A6). Saved workflows with the same name take
    // precedence at resolution; the commands themselves still dispatch by name.
    // Names already claimed by another extension are left alone — Pi cannot
    // unregister or replace a command, so clobbering one is permanent.
    const claimedCommands = new Set((pi.getCommands?.() ?? []).map((command) => command.name));
    for (const name of Object.keys(BUILTIN_WORKFLOWS)) {
      if (claimedCommands.has(name) || registeredWorkflowCommands.has(name)) continue;
      const descriptor = BUILTIN_WORKFLOWS[name];
      pi.registerCommand(name, {
        description: `Run the ${name} workflow`,
        handler: async (args: string, ctx: ExtensionCommandContext) => {
          const text = args.trim();
          // Each script reads its own named input; none reads a generic
          // `prompt`, so the text goes in under `primaryArg`. `code-review`
          // takes a diff rather than something typed, so it resolves one first.
          let scriptArgs: Record<string, unknown> | undefined;
          if (name === "code-review") {
            const scope = resolveCodeReviewScope(text, runCommand);
            for (const notice of scope.notices) ctx.ui.notify(notice, "warning");
            if (!scope.diff.trim()) return;
            scriptArgs = { diff: scope.diff, diffSource: scope.diffSource };
          } else {
            scriptArgs = text ? { [descriptor.primaryArg]: text } : undefined;
          }
          try {
            validateBuiltinArgs(name, scriptArgs);
          } catch (error: unknown) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
            return;
          }
          const options: ScriptStartOptions = {
            args: scriptArgs,
            background: true,
            toolset: descriptor.toolset,
            shippedScript: true,
            excludeTools: [...DEFAULT_EXCLUDED_TOOLS],
            loadSavedWorkflow: resolveNestedWorkflow,
          };
          try {
            const workflowEngine = currentEngine();
            const result = await workflowEngine.start(descriptor.script, options);
            void deliverBackgroundResult(workflowEngine, result.runId);
            ctx.ui.notify(`Workflow ${name} started in background: ${result.runId}`, "info");
          } catch (error: unknown) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          }
        },
      });
      registeredWorkflowCommands.add(name);
    }

    // Live progress widget refreshes through the current engine, so its timer
    // and settlement callback remain safe across session replacement.
    const beginBranchQuiesce = (): Promise<{ settled: boolean; pending: string[]; diagnostic?: string }> => {
      if (!branchQuiesce) {
        let workflowEngine: WorkflowEngine;
        try {
          workflowEngine = currentEngine();
        } catch {
          return Promise.resolve({ settled: true, pending: [] });
        }
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

    pi.events.on("subagents:session_before_tree", () => {
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
        return;
      }
      let workflowEngine: WorkflowEngine;
      try {
        workflowEngine = currentEngine();
      } catch {
        return;
      }
      workflowEngine.suspendLifecycle();
      try {
        workflowEngine.restore(entries);
      } catch (error: unknown) {
        console.warn(
          `[pi-workflows] session tree recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        workflowEngine.resumeLifecycle();
        branchQuiesce = undefined;
      }
    });
  };

  const rememberPendingDelivery = (runId: string, text: string, timestamp = Date.now()): void => {
    if (!runId || timestamp + PENDING_DELIVERY_TTL_MS < Date.now()) return;
    pendingDeliveryMarkers.set(runId, { text: text.slice(0, 8_000), timestamp });
    for (const [id, marker] of pendingDeliveryMarkers) {
      if (marker.timestamp + PENDING_DELIVERY_TTL_MS < Date.now()) pendingDeliveryMarkers.delete(id);
    }
    while (pendingDeliveryMarkers.size > MAX_PENDING_DELIVERIES) {
      const oldest = [...pendingDeliveryMarkers.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0]?.[0];
      if (!oldest) break;
      pendingDeliveryMarkers.delete(oldest);
    }
  };

  /** Background-run result delivery: fail-closed, session-bound (A10). */
  const deliverBackgroundResult = async (engine: WorkflowEngine, runId: string): Promise<void> => {
    const run = await engine.waitFor(runId).catch(() => undefined);
    if (!run) return;
    const header = `Workflow ${run.runId} ${run.status}`;
    const state = engine.getState(runId);
    const finalResult = state?.result ?? run.finalResult;
    const body =
      run.error ??
      (finalResult === undefined
        ? `completed with ${Object.keys(run.callResults).length} agent call(s).`
        : `result:\n${typeof finalResult === "string" ? finalResult : (JSON.stringify(finalResult, null, 2) ?? String(finalResult))}`);
    const text = `${header}: ${body}`;
    if (deliverResult) {
      try {
        deliverResult(text);
      } catch {
        // Endpoint suspended or send failed — leave pending for next bind (fail-closed).
        rememberPendingDelivery(runId, text);
        try {
          pi.appendEntry(PENDING_DELIVERY_TYPE, { runId, text, status: run.status, timestamp: Date.now() });
        } catch {
          // appendEntry is best-effort; in-memory marker still ensures flush on next bind
        }
      }
    } else {
      // No bound session endpoint — fail-closed: persist a pending marker and
      // flush it when a session binds, never fall back to shared pi.sendMessage.
      rememberPendingDelivery(runId, text);
      try {
        pi.appendEntry(PENDING_DELIVERY_TYPE, { runId, text, status: run.status, timestamp: Date.now() });
      } catch {
        // best-effort persistence; in-memory marker still ensures retry
      }
    }
  };

  const flushPendingDeliveries = (): void => {
    if (!deliverResult || pendingDeliveryMarkers.size === 0) return;
    for (const [runId, pending] of [...pendingDeliveryMarkers]) {
      try {
        deliverResult(pending.text);
        pi.appendEntry(PENDING_DELIVERY_ACK_TYPE, { runId, timestamp: Date.now() });
        pendingDeliveryMarkers.delete(runId);
      } catch {
        // Keep pending until both delivery and its durable acknowledgement succeed.
      }
    }
  };

  /** Build a script from a natural-language prompt and run it in background. */
  const runWorkflowFromPrompt = async (ctx: ExtensionCommandContext, prompt: string): Promise<string | undefined> => {
    // A bounded planner → named DAG → synthesis script. Keeping the planner's
    // output inside the workflow makes /workflows run useful for broad tasks,
    // while the graph validates dependencies before dispatching any workers.
    const script = buildAdHocWorkflowScript(prompt);
    try {
      const workflowEngine = currentEngine();
      const result = await workflowEngine.start(script, {
        background: true,
        // We wrote this script, tiers included, so its tier names are a
        // preference against whatever catalogue this host defines.
        shippedScript: true,
        mainModel: ctx.model?.id,
      });
      void deliverBackgroundResult(workflowEngine, result.runId);
      return result.runId;
    } catch (error: unknown) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return undefined;
    }
  };

  const saveWorkflowFromRun = async (ctx: ExtensionCommandContext, name: string, runId?: string): Promise<void> => {
    const state = currentEngine().getState(runId ?? "");
    if (!state) {
      throw new Error(`Workflow run not found: ${runId ?? "(none)"}`);
    }
    saveWorkflow(name, state.run.script, sessionCwd);
    ctx.ui.notify(`Saved workflow "${name}" (${state.run.script.length} chars).`, "info");
  };

  pi.on("session_start", async (_event, ctx) => {
    if (active || engine) return;
    const generation = ++lifecycleGeneration;
    sessionCwd = ctx.cwd ?? process.cwd();
    workflowSettings = loadWorkflowSettings(sessionCwd);
    effortLevel = workflowSettings.effort;
    triggerKeyword = workflowSettings.keywordTriggerWord;
    keywordTriggerEnabled = workflowSettings.keywordTriggerEnabled;
    let initialEntries: SessionEntryLike[];
    try {
      initialEntries = ctx.sessionManager.getBranch() as unknown as SessionEntryLike[];
    } catch {
      return;
    }

    let child: boolean | undefined;
    try {
      child = queryChildSessionContextImmediate(pi.events);
    } catch {
      child = undefined;
    }
    if (child === true) return;

    protocolAbortController = new AbortController();
    const client = createManagedSpawnClient(pi.events, protocolAbortController.signal, protocolAbortController.signal);
    protocolError = undefined;
    protocolProbe = () =>
      client.checkProtocol?.() ?? Promise.reject(new Error("managed protocol check is unavailable"));
    protocolCheck = trackProbe(protocolProbe());
    void protocolCheck.catch((error: unknown) => {
      if (generation !== lifecycleGeneration) return;
      const detail = error instanceof Error ? error.message : String(error);
      protocolError = `${PROTOCOL_DIAGNOSTIC} Diagnostic: ${detail}`;
    });

    let recoveredEngine: WorkflowEngine | undefined;
    let recoveryError: unknown;
    for (let attempt = 0; attempt < 3 && !recoveredEngine; attempt += 1) {
      const candidate = new WorkflowEngine(
        pi.events,
        client,
        {
          append(event) {
            pi.appendEntry(JOURNAL_ENTRY_TYPE, event);
          },
        },
        () => {
          try {
            return (ctx.sessionManager.getBranch() as unknown as SessionEntryLike[]) ?? [];
          } catch {
            return [];
          }
        },
        awaitProtocol,
      );
      try {
        const entries =
          attempt === 0 ? initialEntries : (ctx.sessionManager.getBranch() as unknown as SessionEntryLike[]);
        candidate.restore(entries);
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
    registerSurface();

    // Bind per-session delivery endpoint (A10): capture the session-bound send
    // at this moment so completions deliver to the originating session, not
    // whichever session happens to be current later. Never fall back to the
    // shared pi.sendMessage — a missing or suspended endpoint leaves the
    // result pending and flushes on the next successful bind (fail-closed).
    try {
      const capturedSend = pi.sendMessage;
      if (typeof capturedSend === "function") {
        deliverResult = (text: string) => {
          // Use the captured function value for session affinity; if the
          // captured function is itself a shared accessor, the flush is still
          // fail-closed (delivery only when bound).
          (capturedSend as unknown as (message: unknown, options: unknown) => unknown).call(
            pi,
            {
              content: text,
              display: true,
              customType: "pi-workflows:delivery",
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        };
      }
    } catch {
      // binding is best-effort; pending stays buffered
    }
    // Hydrate any pending markers persisted before this bind (e.g. runs that
    // settled before the first session_start) — scan the branch for
    // PENDING_DELIVERY_TYPE entries that have no in-memory counterpart.
    try {
      const acknowledged = new Set<string>();
      for (const entry of initialEntries) {
        const shaped = entry as { type?: unknown; customType?: unknown; data?: unknown };
        if (shaped.type !== "custom" || typeof shaped.customType !== "string") continue;
        const data = shaped.data as Record<string, unknown> | undefined;
        const entryRunId = typeof data?.runId === "string" ? data.runId : undefined;
        if (!entryRunId) continue;
        if (shaped.customType === PENDING_DELIVERY_ACK_TYPE) {
          acknowledged.add(entryRunId);
        } else if (shaped.customType === PENDING_DELIVERY_TYPE) {
          const pendingText = typeof data?.text === "string" ? data.text : undefined;
          const timestamp = typeof data?.timestamp === "number" ? data.timestamp : Date.now();
          if (pendingText && !acknowledged.has(entryRunId)) rememberPendingDelivery(entryRunId, pendingText, timestamp);
        }
      }
      for (const runId of acknowledged) pendingDeliveryMarkers.delete(runId);
    } catch {
      // scan is best-effort
    }
    flushPendingDeliveries();

    // Saved workflow commands register at session_start (Pi cannot unregister
    // or replace command metadata, so factory-time registration would freeze the
    // source project's description and survive cross-project resumes). Check for
    // name clashes first — never overwrite another extension's command.
    const existingCommands = new Set((pi.getCommands?.() ?? []).map((command) => command.name));
    for (const savedName of listSavedWorkflows(sessionCwd)) {
      if (existingCommands.has(savedName) || registeredWorkflowCommands.has(savedName)) continue;
      if (!loadSavedWorkflow(savedName, sessionCwd)) continue;
      pi.registerCommand(savedName, {
        description: `Run the saved workflow ${savedName}`,
        handler: async (args: string, commandCtx: ExtensionCommandContext) => {
          try {
            const workflowEngine = currentEngine();
            const script = loadSavedWorkflow(savedName, sessionCwd) ?? BUILTIN_WORKFLOWS[savedName]?.script;
            if (!script) throw new Error(`Saved workflow "${savedName}" is no longer available.`);
            const options: ScriptStartOptions = {
              args: args.trim() ? { prompt: args.trim() } : undefined,
              background: true,
              mainModel: commandCtx?.model?.id,
              loadSavedWorkflow: resolveNestedWorkflow,
            };
            const result = await workflowEngine.start(script, options);
            void deliverBackgroundResult(workflowEngine, result.runId);
            commandCtx.ui.notify(`Workflow ${savedName} started in background: ${result.runId}`, "info");
          } catch (error: unknown) {
            commandCtx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          }
        },
      });
      registeredWorkflowCommands.add(savedName);
    }
  });

  pi.on("session_shutdown", async () => {
    lifecycleGeneration += 1;
    // Invalidate all long-lived command/tool/widget closures before awaiting
    // engine quiescence; the old session must not accept another run.
    active = false;
    clearWidget();
    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = undefined;
    }
    const closingEngine = engine;
    if (closingEngine) {
      await closingEngine.quiesceForBranchChange().catch(() => undefined);
    }
    protocolAbortController?.abort();
    protocolAbortController = undefined;
    closingEngine?.dispose();
    engine = undefined;
    branchQuiesce = undefined;
    protocolCheck = undefined;
    protocolProbe = undefined;
    protocolInFlight = undefined;
    protocolError = undefined;
    deliverResult = undefined;
  });
}

export type { ScriptStartResult };
export { WorkflowWaitAbortedError };
