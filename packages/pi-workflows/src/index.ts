import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { sanitizeDisplayText } from "@signalridge/pi-ui";
import { Type } from "@sinclair/typebox";
import { DEFAULT_TRIGGER_WORD, hasTriggerWord, WORKFLOW_ARMING_MESSAGE_TYPE, WorkflowTurnArming } from "./arming.js";
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
import { guardStatusMount, StatusActions, type StatusSurface, workflowStatusSummary } from "./status-actions.js";
import {
  defaultStrengthTable,
  isWorkflowStrength,
  WORKFLOW_STRENGTH_LIST,
  WORKFLOW_STRENGTHS,
  type WorkflowStrengthTable,
} from "./strengths.js";
import { liveWidgetLines, showWorkflowNavigator } from "./ui.js";
import { buildWorkflowUiSnapshot, openOwnedConversation, WorkflowUiBridge, type WorkflowUiSurface } from "./ui-bus.js";
import {
  loadProjectWorkflowSettings,
  loadWorkflowSettings,
  saveWorkflowSettings,
  type WorkflowSettings,
} from "./workflow-settings.js";

const WorkflowToolSchema = Type.Object(
  {
    script: Type.Optional(Type.String({ maxLength: 200_000 })),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    args: Type.Optional(Type.Any()),
    background: Type.Optional(Type.Boolean()),
    maxAgents: Type.Optional(
      Type.Number({
        minimum: 1,
        description:
          "Cap on real agent dispatches for this run. Default 1000, which no ordinary script reaches. Omit it: a value below what the script dispatches stops the run partway with AGENT_LIMIT_EXCEEDED.",
      }),
    ),
    concurrency: Type.Optional(
      Type.Number({
        minimum: 1,
        description:
          "Agents in flight at once. Defaults to the host's own subagent pool size, which is also the ceiling. Omit it: a lower number runs the same work more slowly and buys nothing, and a higher one is clamped.",
      }),
    ),
    agentRetries: Type.Optional(
      Type.Number({
        minimum: 0,
        maximum: 3,
        description: "Retries for a recoverable agent failure. Default 0; a failed call returns null to the script.",
      }),
    ),
    tokenBudget: Type.Optional(
      Type.Number({
        minimum: 1,
        description: "Soft token ceiling for the whole run. Default unlimited; exhausting a set budget aborts the run.",
      }),
    ),
    agentTimeoutMs: Type.Optional(
      Type.Number({
        minimum: 1,
        description:
          "Wall clock per agent, there to bound a hang. Default 1800000 (30min), and it counts from when the agent actually starts, not from dispatch. An agent's real budget is the host's turn, tool and token ceiling. Omit it: a short value fails an entire fan-out as timeouts.",
      }),
    ),
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
    consume: Type.Optional(
      Type.Boolean({
        description:
          "With get/status only: explicitly acknowledge a reviewed terminal result and suppress its pending completion reminder. Running results and ordinary inspections are not consumed.",
      }),
    ),
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

/** Bounded display copies; command notifications never render stored control bytes. */
function notifyWorkflow(
  ctx: Pick<ExtensionContext, "ui">,
  message: string,
  type: "info" | "warning" | "error" = "info",
): void {
  ctx.ui.notify(sanitizeDisplayText(message.slice(0, 8_000), { multiline: true }).slice(0, 4_000), type);
}

/**
 * Run one command for diff discovery. argv array, never a shell string — a
 * branch name or path reaches this from user input.
 */
function runCommand(file: string, args: string[], cwd: string): CommandResult {
  try {
    const stdout = execFileSync(file, args, {
      cwd,
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
  if (result.waitAborted) {
    lines.push(
      "wait_aborted=true",
      result.background
        ? "Only the wait was cancelled; retrieve the detached run with workflow_control."
        : "Foreground execution was cancelled; inspect its status with workflow_control before resuming.",
    );
  }
  if (result.result) lines.push("", result.result.slice(0, 8_000));
  if (result.error) lines.push("", `error=${result.error.slice(0, 2_000)}`);
  return lines.join("\n");
}

/** Build the bounded planner → graph → synthesis script used by `/workflows run`. */
export function buildAdHocWorkflowScript(prompt: string): string {
  return `export const meta = { name: "ad-hoc", description: "Plan, execute, and synthesize a bounded multi-agent task graph" };
const originalPrompt = ${JSON.stringify(prompt)};
const plan = await agent("Design a bounded execution plan for this user task. Return 1-24 independent or dependency-linked tasks. Use unique short ids, concise descriptions, exact worker prompts, and only dependencies that appear in the task list. Prefer independent tasks when possible, and prefer narrow tasks over few broad ones: a task asked one question is read further into than a task asked four. User task:\\n\\n" + originalPrompt, {
  label: "planner",
  strength: "medium",
  schema: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: 24,
        items: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1, maxLength: 64 },
            description: { type: "string", minLength: 1, maxLength: 500 },
            prompt: { type: "string", minLength: 1, maxLength: 8000 },
            dependsOn: { type: "array", maxItems: 24, items: { type: "string", minLength: 1, maxLength: 64 } },
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
  run: ({ results, statuses }) => agent(task.prompt + "\\n\\nDependency results (null means unavailable):\\n" + JSON.stringify({ results, statuses }), { label: task.id, strength: "low" }),
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
return await agent("Synthesize the worker results into a direct answer to the original task. Mention incomplete or failed coverage explicitly.\\n\\nOriginal task, execution plan, and graph ledger:\\n" + synthesisJson, { label: "synthesizer", strength: "medium" });`;
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
  let shutdownQuiesce: Promise<{ settled: boolean; pending: string[]; diagnostic?: string }> | undefined;
  let lifecycleGeneration = 0;
  let deliveryGeneration = 0;
  const deliveryObservers = new Map<string, string>();
  const observedExecutions = new Map<string, string>();
  let handledTreeEvent: unknown;
  let journalBranchAnchor: string | null | undefined;
  let protocolAbortController: AbortController | undefined;
  let sessionCwd = process.cwd();
  let workflowSettings = loadWorkflowSettings(sessionCwd);
  let effortLevel: "off" | "high" | "ultra" = workflowSettings.effort;
  let triggerKeyword: string | undefined = workflowSettings.keywordTriggerWord;
  let keywordTriggerEnabled = workflowSettings.keywordTriggerEnabled;
  /** Public sends are void: acceptance is checked against the owning branch. */
  let deliveryContext: ExtensionContext | undefined;
  let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
  let inputPreparing = false;
  const turnArming = new WorkflowTurnArming();
  let compacting = false;
  let navigating = false;
  let deliveryBranchAnchor: string | null | undefined;
  const DELIVERY_WAKE_PREFIX = "[pi-workflows:wake:";
  const DELIVERY_WAKE_TEXT = "Workflow results are ready in the preceding context.";
  const MAX_WAKE_ADMISSIONS = 256;
  // Private, one-use admissions survive an earlier awaited input handler, not
  // a lifecycle retirement. Missing/evicted IDs fail closed without tombstones.
  const wakeAdmissions = new Map<
    string,
    { generation: number; context: ExtensionContext; engine: WorkflowEngine; anchor: string | null | undefined }
  >();
  /** Pending deliveries for completed runs, including durable recovery (A10). */
  const pendingDeliveryMarkers = new Map<
    string,
    { text: string; timestamp: number; executionGeneration?: number; completionId?: string }
  >();
  const PENDING_DELIVERY_TYPE = "pi-workflows:pending-delivery";
  const PENDING_DELIVERY_ACK_TYPE = "pi-workflows:pending-delivery-ack";
  const MAX_PENDING_DELIVERIES = 256;
  const PENDING_DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
  let widgetTimer: ReturnType<typeof setInterval> | undefined;
  let widgetUi: ExtensionContext["ui"] | undefined;
  let workflowUiBridge: WorkflowUiBridge | undefined;
  let workflowUiSurfaceId = randomUUID();
  let refreshQueued = false;
  let statusActions: StatusActions | undefined;
  let statusSource: (() => StatusSurface | undefined) | undefined;
  const navigatorOpen = new Map<string, number>();
  const retireStatusActions = (): void => {
    const hadStatus = !!statusSource;
    statusActions?.dispose();
    statusActions = undefined;
    statusSource = undefined;
    if (hadStatus && deliveryContext?.mode === "tui") deliveryContext.ui.setStatus("pi-workflows", undefined);
  };

  const currentEngine = (): WorkflowEngine => {
    if (!active || !engine || engine.isDisposed())
      throw new Error("pi-workflows is not active in this session context");
    return engine;
  };

  // Public bus requests are synchronous snapshots, not a lock across Pi's
  // later summarization/leaf replacement. Both extensions can veto in any load
  // order without importing one another's source.
  pi.events.on("pi:navigation-preflight", (raw: unknown) => {
    if (!active || !engine?.hasUnsettledWork()) return;
    const report = (raw as { report?: unknown } | null)?.report;
    if (typeof report === "function") report("workflows");
  });
  const navigationPreflight = (ctx: ExtensionContext): { cancel: true } | undefined => {
    let busy = false;
    pi.events.emit("pi:navigation-preflight", {
      report: () => {
        busy = true;
      },
    });
    if (!busy) return undefined;
    const notice =
      "Navigation blocked while agents or workflows are active or cleaning up. Wait for them to finish, or stop them explicitly and retry.";
    if (ctx.hasUI) notifyWorkflow(ctx, notice, "warning");
    else console.warn(`[pi-workflows] ${notice}`);
    return { cancel: true };
  };
  const invalidateDelivery = (): void => {
    navigatorOpen.delete(workflowUiSurfaceId);
    retireStatusActions();
    workflowUiBridge?.retire(workflowUiSurfaceId);
    workflowUiSurfaceId = randomUUID();
    deliveryGeneration++;
    deliveryObservers.clear();
    observedExecutions.clear();
    turnArming.retire();
    wakeAdmissions.clear();
    if (deliveryTimer) clearTimeout(deliveryTimer);
    deliveryTimer = undefined;
  };
  const beginShutdownQuiesce = (): Promise<{ settled: boolean; pending: string[]; diagnostic?: string }> => {
    if (shutdownQuiesce) return shutdownQuiesce;
    // Retire admission and delivery BEFORE aborting children, including when
    // subagents initiates shutdown first. Journal cleanup retains its separate
    // lifecycle generation until the native shutdown hook finishes quiescence.
    active = false;
    invalidateDelivery();
    deliveryContext = undefined;
    const closingEngine = engine;
    if (!closingEngine || closingEngine.isDisposed()) {
      shutdownQuiesce = Promise.resolve({ settled: true, pending: [] });
      return shutdownQuiesce;
    }
    // Publish the handshake promise before abort can synchronously re-enter
    // the bus through an owned-child cleanup callback.
    let settle: (result: { settled: boolean; pending: string[]; diagnostic?: string }) => void = () => {};
    shutdownQuiesce = new Promise((resolve) => {
      settle = resolve;
    });
    void closingEngine.quiesceForBranchChange().then(settle, (error: unknown) => {
      settle({
        settled: false,
        pending: [],
        diagnostic: error instanceof Error ? error.message : String(error),
      });
    });
    return shutdownQuiesce;
  };
  // Subagents starts this handshake before retiring the owned-agent RPC. When
  // workflows shuts down first, its native hook performs the same operation.
  pi.events.on("pi-workflows:shutdown-quiesce", (raw: unknown) => {
    if (!engine) return;
    const respond = (raw as { respond?: unknown } | null)?.respond;
    if (typeof respond === "function") respond(beginShutdownQuiesce());
  });
  pi.events.on("subagents:session_tree_committed", (raw: unknown) => {
    if (!active || !engine) return;
    const event = (raw as { event?: unknown } | null)?.event;
    if (!event || event === handledTreeEvent) return;
    handledTreeEvent = event;
    invalidateDelivery();
    pendingDeliveryMarkers.clear();
    engine.fenceCommittedBranch();
  });

  const clearWidget = (): void => {
    widgetUi?.setWidget("pi-workflows", undefined);
  };
  const refreshWidget = (): void => {
    const tui = widgetUi;
    if (!tui) return;
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
    if (statusSource?.()) tui.setStatus("pi-workflows", workflowStatusSummary(runs));
    const hasActive = runs.some((run) => !["completed", "failed", "stopped"].includes(run.status));
    const surfaceId = workflowUiSurfaceId;
    tui.setWidget(
      "pi-workflows",
      hasActive
        ? (host, theme) => ({
            render(width) {
              if (
                !active ||
                engine !== workflowEngine ||
                workflowEngine.isDisposed() ||
                workflowUiSurfaceId !== surfaceId ||
                !Number.isFinite(width) ||
                width < 1
              )
                return [];
              const height = Number.isFinite(host.terminal.rows) ? Math.max(0, host.terminal.rows) : 24;
              const rowBudget = Math.max(1, Math.min(12, Math.floor(height / 4)));
              return liveWidgetLines(
                runs,
                workflowSettings.progressMode,
                workflowSettings.maxAgentsShown,
                rowBudget,
              ).map((line, index) =>
                truncateToWidth(theme.fg(index === 0 ? "accent" : "muted", line), Math.floor(width)),
              );
            },
            invalidate() {},
          })
        : undefined,
    );
    workflowUiBridge?.publish();
    if (hasActive && !widgetTimer) {
      widgetTimer = setInterval(refreshWidget, 2_000);
    } else if (!hasActive && widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = undefined;
    }
  };
  const notifyRunChanged = (): void => {
    if (refreshQueued) return;
    refreshQueued = true;
    const surfaceId = workflowUiSurfaceId;
    queueMicrotask(() => {
      refreshQueued = false;
      if (surfaceId !== workflowUiSurfaceId) return;
      refreshWidget();
    });
  };

  const DEFAULT_EXCLUDED_TOOLS = ["workflow", "workflow_control"] as const;

  /**
   * Persist one settings change into this project's own file.
   *
   * `workflowSettings` is the merged view — defaults, then global, then project
   * — while `saveWorkflowSettings` replaces the project file with whatever it
   * is handed. Handing it the merged view would copy every global value and
   * every default into the project on the first edit, and the project would
   * stop tracking the global file from then on. So the patch lands on project
   * scope and the merged view is re-derived from what actually landed, which is
   * also what makes it safe to report the result rather than the intent.
   */
  const persistWorkflowSetting = (patch: WorkflowSettings): void => {
    saveWorkflowSettings({ ...loadProjectWorkflowSettings(sessionCwd), ...patch }, sessionCwd);
    workflowSettings = loadWorkflowSettings(sessionCwd);
  };

  /** Resolve a nested `workflow(name)` reference; a saved file shadows a built-in. */
  const resolveNestedWorkflow = (name: string): string | undefined =>
    loadSavedWorkflow(name, sessionCwd) ?? BUILTIN_WORKFLOWS[name]?.script;

  const resolveScript = (
    script: string | undefined,
    name: string | undefined,
    args: unknown,
  ): { script: string; source: string; toolset?: string } => {
    if (script !== undefined && name !== undefined) {
      throw new Error("Provide either `script` or `name`, not both.");
    }
    if (script !== undefined) return { script, source: "inline" };
    if (name !== undefined) {
      const saved = loadSavedWorkflow(name, sessionCwd);
      if (saved) return { script: saved, source: `saved:${name}` };
      const builtin = BUILTIN_WORKFLOWS[name];
      if (builtin) {
        // Validate named invocations before starting a potentially expensive fleet.
        // Slash commands provide the same shape through their descriptor primaryArg.
        validateBuiltinArgs(name, args);
        return { script: builtin.script, source: `builtin:${name}`, toolset: builtin.toolset };
      }
      throw new Error(`Unknown workflow name "${name}". It is neither a saved workflow nor a built-in.`);
    }
    throw new Error("Provide either `script` or `name`.");
  };

  const showNavigator = async (ctx: ExtensionContext, initialRunId?: string, guard?: () => void): Promise<void> => {
    guard?.();
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      await showWorkflowNavigator(ctx, currentEngine, { initialRunId });
      return;
    }
    const selectedEngine = currentEngine();
    const surfaceId = workflowUiSurfaceId;
    const manager = ctx.sessionManager;
    const sessionId = manager.getSessionId();
    const resolve = (): WorkflowEngine => {
      guard?.(); // Keep a mounted status navigator bound to its exact source.
      if (
        surfaceId !== workflowUiSurfaceId ||
        selectedEngine !== currentEngine() ||
        manager !== deliveryContext?.sessionManager ||
        manager.getSessionId() !== sessionId ||
        !ownsDeliveryBranch()
      )
        throw new Error("Workflow inspector belongs to a retired session or branch.");
      return selectedEngine;
    };
    navigatorOpen.set(surfaceId, (navigatorOpen.get(surfaceId) ?? 0) + 1);
    try {
      await showWorkflowNavigator(guard ? guardStatusMount(ctx, guard) : ctx, resolve, {
        initialRunId,
        getPresentation: (runId) => resolve().getInspection(runId),
        openConversation: async (runId, callIndex) => {
          const current = resolve();
          if (!/^(?:0|[1-9]\d*)$/u.test(callIndex)) throw new Error("This call has no retained root conversation.");
          const state = current.getState(runId);
          const run = state?.run;
          const agentId = run?.agentIds[callIndex];
          const attempt = run?.attempts[callIndex];
          if (!state || !run || !agentId || !Number.isInteger(attempt) || (attempt ?? 0) < 1)
            throw new Error("No retained conversation is available for this call.");
          const executionGeneration = state.executionGeneration;
          await openOwnedConversation(
            pi.events,
            agentId,
            { extension: "pi-workflows", runId, nodeId: `call-${callIndex}`, attemptId: `attempt-${attempt}` },
            () => {
              try {
                return (
                  resolve().getState(runId) === state &&
                  state.executionGeneration === executionGeneration &&
                  run.agentIds[callIndex] === agentId &&
                  run.attempts[callIndex] === attempt
                );
              } catch {
                return false;
              }
            },
          );
        },
      });
    } finally {
      // An obsolete factory cannot hold or release a replacement surface's slot.
      const remaining = (navigatorOpen.get(surfaceId) ?? 0) - 1;
      if (remaining > 0) navigatorOpen.set(surfaceId, remaining);
      else navigatorOpen.delete(surfaceId);
    }
  };

  const registerStatusActions = (): void => {
    const ctx = deliveryContext;
    if (!active || !engine || ctx?.mode !== "tui" || !ctx.hasUI) return;
    const selectedEngine = currentEngine();
    const surfaceId = workflowUiSurfaceId;
    const manager = ctx.sessionManager;
    const sessionId = manager.getSessionId();
    let branchIds = manager.getBranch().map((entry) => entry.id);
    let retired = false;
    const source = (): StatusSurface | undefined => {
      if (retired) return;
      let valid = false;
      try {
        const branch = manager.getBranch().map((entry) => entry.id);
        valid =
          active &&
          engine === selectedEngine &&
          !selectedEngine.isDisposed() &&
          workflowUiSurfaceId === surfaceId &&
          deliveryContext?.sessionManager === manager &&
          manager.getSessionId() === sessionId &&
          ctx.mode === "tui" &&
          ctx.hasUI &&
          ownsDeliveryBranch() &&
          branchIds.every((id, index) => branch[index] === id);
        if (valid) branchIds = branch;
      } catch {
        // A disposed context permanently retires this presentation surface.
      }
      if (!valid) {
        retired = true;
        if (statusSource === source) retireStatusActions();
        return;
      }
      return {
        owner: selectedEngine,
        surfaceId,
        sessionId,
        busy: () => (navigatorOpen.get(surfaceId) ?? 0) > 0,
        open: () =>
          showNavigator(ctx, undefined, () => {
            if (!source()) throw new Error("Workflow status surface is retired.");
          }),
      };
    };
    statusSource = source;
    statusActions = new StatusActions(
      pi.events,
      { providerId: "pi-workflows", statusKey: "pi-workflows", actionId: "runs", label: "Workflow runs" },
      source,
    );
    if (source())
      ctx.ui.setStatus(
        "pi-workflows",
        workflowStatusSummary(selectedEngine.list().map((run) => ({ status: String(run.status) }))),
      );
  };

  const workflowUiSurface = (): WorkflowUiSurface | undefined => {
    const ctx = deliveryContext;
    if (!active || !engine || engine.isDisposed() || ctx?.mode !== "tui" || !ctx.hasUI || !ownsDeliveryBranch())
      return undefined;
    return {
      snapshot: buildWorkflowUiSnapshot(engine, workflowUiSurfaceId),
      open: (runId) => showNavigator(ctx, runId),
      notifyError: (message) => notifyWorkflow(ctx, message, "error"),
    };
  };

  const registerSurface = (): void => {
    if (active) return;
    active = true;
    const workflowEngine = currentEngine();
    workflowEngine.onRunSettled = notifyRunChanged;
    workflowEngine.onBackgroundExecution = (runId) => void deliverBackgroundResult(workflowEngine, runId);
    workflowEngine.onRuntimeEvent = notifyRunChanged;
    workflowEngine.onInspectionChanged = notifyRunChanged;
    if (typeof pi.registerMessageRenderer === "function") {
      pi.registerMessageRenderer("pi-workflows:delivery", (message, { expanded }, theme) => {
        const original =
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
        const display = sanitizeDisplayText(original, { multiline: true });
        return new Text(theme.fg("toolOutput", display.slice(0, expanded ? 8000 : 2000)), 0, 0);
      });
    }
    // `control("resume")` and the provider-limit retry start executions with no
    // caller to pass options for them, and the strength table is deliberately
    // never frozen onto a run. Without this they would resume with no table and
    // re-run every finished call untabled.
    workflowEngine.strengths = () => workflowSettings.strengths;
    workflowEngine.loadSavedWorkflow = resolveNestedWorkflow;
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
          "Size the fan-out to the work: one agent per independent piece of evidence the task actually has. Ten to thirty agents is an ordinary review or audit, and a script that splits a broad task four ways is usually four agents each doing one agent's job. The gain is coverage, not speed — how many run at once is the host's pool, not the script's choice.",
          "Pass script/name/args/background and nothing else unless the user named a specific limit. maxAgents, concurrency, agentRetries, tokenBudget and agentTimeoutMs already default to tuned values, and each one stops or fails the run when it is set too low.",
          "Use background: true for long runs; retrieve results with workflow_control.",
          "Use resumeFromRunId with an edited script to replay the unchanged prefix from cache and re-run the rest live.",
          "Inside the script, never name a model, a thinking level, or a turn limit: `strength` is the only routing a call may express.",
        ],
        parameters: WorkflowToolSchema,
        renderCall(args, theme) {
          const label = sanitizeDisplayText(args.name ?? (args.script !== undefined ? "script" : ""));
          return new Text(theme.fg("toolTitle", theme.bold(`Workflow ${label}`)), 0, 0);
        },
        renderResult(result, { expanded, isPartial }, theme) {
          const text = sanitizeDisplayText(result.content[0]?.type === "text" ? result.content[0].text : "", {
            multiline: true,
          });
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
                    // Resume replays the stored script; only the shared shape
                    // has to be satisfied here.
                    return { script: prior.script, source: "resume", toolset: prior.toolset };
                  })()
                : resolveScript(params.script, params.name, params.args);
            const { script, source, toolset } = resolved;
            const options: ScriptStartOptions = {
              args: params.args,
              background: params.background ?? true,
              maxAgents: params.maxAgents,
              concurrency: params.concurrency,
              agentRetries: params.agentRetries,
              tokenBudget: params.tokenBudget,
              agentTimeoutMs: params.agentTimeoutMs,
              toolset,
              excludeTools: [...DEFAULT_EXCLUDED_TOOLS],
              signal,
              mainModel: ctx?.model?.id,
              // Foreground checkpoint confirmation only when the run is not
              // background — background runs are headless by contract.
              confirm:
                params.background === false && ctx?.hasUI
                  ? async (promptText, checkpointOptions, signal) => {
                      if (checkpointOptions.kind === "input")
                        return ctx.ui.input(promptText, String(checkpointOptions.default ?? ""), { signal });
                      if (checkpointOptions.kind === "select")
                        return ctx.ui.select(promptText, checkpointOptions.choices ?? [], { signal });
                      return ctx.ui.confirm(promptText, promptText, { signal });
                    }
                  : undefined,
              loadSavedWorkflow: resolveNestedWorkflow,
              strengths: workflowSettings.strengths,
            };
            if (params.resumeFromRunId) {
              const replacement = params.script !== undefined || params.name !== undefined ? script : undefined;
              const resumed = await workflowEngine.resume(
                params.resumeFromRunId,
                ctx.sessionManager.getBranch(),
                options,
                replacement,
              );
              if (!resumed) return textResult(`Workflow run not found: ${params.resumeFromRunId}`);
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
          return new Text(
            theme.fg("toolTitle", theme.bold(`Workflow control: ${sanitizeDisplayText(args.action ?? "")}`)),
            0,
            0,
          );
        },
        renderResult(result, { expanded }, theme) {
          const text = sanitizeDisplayText(result.content[0]?.type === "text" ? result.content[0].text : "", {
            multiline: true,
          });
          return new Text(theme.fg("dim", expanded ? text.slice(0, 8_000) : text.slice(0, 1_000)), 0, 0);
        },
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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
            if (params.consume && action !== "get") throw new Error("consume is supported only with get/status.");
            const execution = runId ? workflowEngine.getState(runId)?.executionGeneration : undefined;
            const ownerGeneration = deliveryGeneration;
            const completionId =
              params.consume && action === "get" && runId ? completionReceipt(workflowEngine, runId) : undefined;
            const result = await workflowEngine.control(action, runId);
            signal?.throwIfAborted();
            if (params.consume) {
              const notificationConsumed =
                !!runId &&
                execution !== undefined &&
                completionId !== undefined &&
                consumeReviewedResult(workflowEngine, runId, execution, completionId, ownerGeneration, ctx);
              const receipt = { ...result, notificationConsumed };
              return textResult(JSON.stringify(receipt), receipt);
            }
            return textResult(JSON.stringify(result), result);
          } catch (error: unknown) {
            return textResult(error instanceof Error ? error.message : String(error));
          }
        },
      }),
    );

    // /workflows: navigator + run/status/watch/stop/pause/resume/rm/save subcommands
    pi.registerCommand("workflows", {
      description: "Workflow runs: navigator, or run/status/watch/stop/pause/resume/rm/save/strength",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const [subcommand, ...rest] = tokens;
        const restArgs = rest.join(" ").trim();
        const engineForCommand = (): WorkflowEngine | undefined => {
          try {
            return currentEngine();
          } catch (error: unknown) {
            notifyWorkflow(ctx, error instanceof Error ? error.message : String(error), "error");
            return undefined;
          }
        };
        if (!subcommand) {
          await showNavigator(ctx);
          return;
        }
        if (subcommand === "run") {
          if (!restArgs) {
            notifyWorkflow(ctx, "/workflows run <prompt-or-script>", "warning");
            return;
          }
          const runId = await runWorkflowFromPrompt(ctx, restArgs);
          if (runId) notifyWorkflow(ctx, `Workflow started in background: ${runId}`, "info");
          return;
        }
        if (subcommand === "status") {
          const workflowEngine = engineForCommand();
          if (!workflowEngine) return;
          if (restArgs) {
            const run = workflowEngine.getRun(restArgs);
            if (!run) {
              notifyWorkflow(ctx, `Workflow run not found: ${restArgs}`, "warning");
              return;
            }
            notifyWorkflow(ctx, `${run.runId} · ${run.status} · ${String(run.meta?.name ?? run.runId)}`, "info");
            return;
          }
          const runs = workflowEngine.list();
          notifyWorkflow(
            ctx,
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
            notifyWorkflow(ctx, "No workflow runs to watch.", "warning");
            return;
          }
          const run = workflowEngine.getRun(runId);
          if (!run) {
            notifyWorkflow(ctx, `Workflow run not found: ${runId}`, "warning");
            return;
          }
          if (ctx.mode === "tui" && ctx.hasUI) await showNavigator(ctx, runId);
          else notifyWorkflow(ctx, `${run.runId} · ${run.status} — use workflow_control outside TUI.`, "info");
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
            notifyWorkflow(
              ctx,
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
            notifyWorkflow(ctx, `Workflow ${subcommand} requested: ${runId}`, "info");
          } catch (error: unknown) {
            notifyWorkflow(ctx, error instanceof Error ? error.message : String(error), "error");
          }
          return;
        }
        if (subcommand === "save") {
          const name = rest[0] ?? "";
          if (!name) {
            notifyWorkflow(ctx, "/workflows save <name> [runId]", "warning");
            return;
          }
          const workflowEngine = engineForCommand();
          if (!workflowEngine) return;
          // Fallback to most recent run when runId omitted — matches upstream runs.find(r=>r.script)
          const runId = rest[1] ?? String(workflowEngine.list()[0]?.runId ?? "");
          if (!runId) {
            notifyWorkflow(ctx, "No workflow runs to save.", "warning");
            return;
          }
          try {
            await saveWorkflowFromRun(ctx, name, runId);
          } catch (error: unknown) {
            notifyWorkflow(ctx, error instanceof Error ? error.message : String(error), "error");
          }
          return;
        }
        if (subcommand === "strength") {
          // The Agent tier catalogue is owned by pi-subagents and still is (A8:
          // no second tier config file). What this edits is narrower and is
          // genuinely ours: which Agent tier each workflow strength runs on.
          //
          // A subcommand rather than a command of its own, because the reason
          // to surface it at all is the three-part view below — two lines of
          // which come from this package and one from the other — and that is
          // a page to read, not a mode to be in.
          //
          // The catalogue lives on the managed peer, so it can legitimately be
          // unreachable here. Status still has its other two parts, and a set
          // made against a table that already exists is stored unvalidated: the
          // run-start check reports a tier this host does not define and drops
          // that entry, which costs the redirect rather than the run. A set made
          // with no table at all is refused instead — see below, where the seed
          // is read.
          const catalogue = await (async (): Promise<string[] | undefined> => {
            try {
              return Object.keys((await awaitProtocol()).routingPolicy.profiles).sort();
            } catch {
              return undefined;
            }
          })();
          const knownTiers = catalogue ? new Set(catalogue) : undefined;
          // What a run would resolve, by the same rule the runtime uses: a
          // configured table if there is one, else the shipped default. Shown
          // rather than the configured table alone, because an unconfigured
          // machine is not an unrouted one and a row reading "(unset)" there
          // would describe something other than what the next run does.
          const effective = (): { table: WorkflowStrengthTable; shipped: boolean } => {
            const configured = workflowSettings.strengths;
            return configured === undefined
              ? { table: defaultStrengthTable(knownTiers), shipped: true }
              : { table: configured, shipped: false };
          };
          const describe = (): string => {
            const { table, shipped } = effective();
            const rows = WORKFLOW_STRENGTHS.map((name) => {
              // The default is derived from the catalogue, so without one there
              // is nothing honest to print: the run will still route these, and
              // "(unset)" would claim it will not.
              if (shipped && knownTiers === undefined) return `  ${name} → (default; needs the tier catalogue)`;
              if (table[name] === undefined) return `  ${name} → (unset; the agent's own default)`;
              return `  ${name} → ${table[name]}${shipped ? " (default)" : ""}`;
            });
            // The shipped default is identity, so on a stock install workflow
            // work rides the same profiles every ordinary spawn does — the
            // coupling this indirection exists to let you break, but does not
            // break on its own. Saying so here is the only place the two steps
            // out of it are visible together.
            const decouple = shipped
              ? "\nThis is the shipped default: each strength on the tier of the same name, so " +
                "workflow work shares the tiers your ordinary spawns use (Explore among them). " +
                "To price workflow work on its own, define a tier in /agents → Model tiers, then " +
                "point a strength at it here."
              : "";
            return (
              `Workflow strengths and the Agent tier each runs on:\n${rows.join("\n")}\n` +
              `Tiers this host defines: ${catalogue?.join(", ") ?? "(unavailable)"}\n` +
              "Edits apply to this project; for a machine-wide table edit " +
              "<agent dir>/workflows/settings.json. The tiers themselves live in " +
              "/agents → Model tiers; this only says which one a strength uses." +
              decouple
            );
          };
          const [strength, target] = rest;
          if (strength === undefined) {
            notifyWorkflow(ctx, describe(), "info");
            return;
          }
          if (!isWorkflowStrength(strength)) {
            notifyWorkflow(
              ctx,
              `"${strength}" is not a workflow strength. Use one of ${WORKFLOW_STRENGTH_LIST}.`,
              "warning",
            );
            return;
          }
          if (target === undefined || rest.length !== 2) {
            notifyWorkflow(ctx, `/workflows strength [<${WORKFLOW_STRENGTHS.join("|")}> <tier>|off]`, "warning");
            return;
          }
          // `off` reads as "unset" unless the host really defines a tier by
          // that name, in which case the user's own catalogue outranks our
          // keyword — a tier you cannot point at is worse than a clumsier way
          // to clear one.
          const unset = target === "off" && catalogue?.includes("off") !== true;
          if (!unset && catalogue && !catalogue.includes(target)) {
            notifyWorkflow(
              ctx,
              `"${target}" is not a tier this host defines. Available: ${catalogue.join(", ") || "(none)"}. ` +
                "Define it in /agents → Model tiers first.",
              "warning",
            );
            return;
          }
          const { table: current, shipped } = effective();
          if (shipped && knownTiers === undefined) {
            // Seeding from a default we cannot compute would write a one-entry
            // table, and this key replaces rather than merges — so the other two
            // strengths would go from routed to unmapped as a side effect of
            // setting this one. Refusing costs a retry; writing costs a run.
            notifyWorkflow(
              ctx,
              "The tier catalogue is unavailable, so the current table cannot be read. " +
                "Retry once the managed peer is reachable.",
              "warning",
            );
            return;
          }
          // Seeded from the table a run would use, not from this project's file.
          // Every level of this key replaces the one below rather than merging
          // into it, so a patch built on project scope would silently drop
          // whatever the level below contributed: adding one entry would discard
          // an inherited global table, and `off` against an entry this project
          // never wrote would write nothing and leave the mapping standing. The
          // seed does freeze the current table into the project, which is what a
          // replace-wholesale key costs — the entries a partial file left out
          // would be unmapped, not inherited.
          const { [strength]: _cleared, ...others } = current;
          try {
            persistWorkflowSetting({ strengths: unset ? others : { ...others, [strength]: target } });
          } catch (error: unknown) {
            notifyWorkflow(
              ctx,
              `Could not save workflow strength routing: ${error instanceof Error ? error.message : String(error)}`,
              "warning",
            );
            return;
          }
          // Show the resolved result rather than echoing the write. The
          // settings layer can drop what it was handed, and `off` against the
          // last remaining entry stores an explicit empty table — "map nothing",
          // which is not the same as the shipped default an absent key would
          // mean — so a message announcing the write would describe something
          // other than what the next run will do. Runs already in flight keep
          // what they started with; the table is read fresh at each start and
          // resume.
          //
          // The one case the table alone cannot explain: the host defines a tier
          // named `off`, so the keyword lost to it above and this mapped rather
          // than cleared. The catalogue outranking our keyword is the right call
          // — a tier you cannot point at is worse than a clumsier way to clear
          // one — but a user who typed the documented keyword and got a mapping
          // has to be told which reading won, and where the other one lives.
          const shadowed =
            target === "off" && !unset
              ? '\n\nNote: this host defines a tier named "off", so `off` was read as that tier rather ' +
                "than as the clear keyword. To leave a strength unmapped here, remove its entry from the " +
                "`strengths` object in this project's settings.json."
              : "";
          notifyWorkflow(ctx, `${describe()}${shadowed}`, "info");
          return;
        }
        notifyWorkflow(ctx, `Unknown /workflows subcommand: ${subcommand}`, "warning");
      },
    });

    // /workflows-progress: persistent compact/detailed live-panel settings.
    pi.registerCommand("workflows-progress", {
      description: "Workflow progress panel: compact|detailed|status|max <N>",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const action = tokens[0] ?? "status";
        if (action === "status") {
          notifyWorkflow(
            ctx,
            `Workflow progress: ${workflowSettings.progressMode}, max agents shown: ${workflowSettings.maxAgentsShown}`,
            "info",
          );
          return;
        }
        let patch: WorkflowSettings;
        if (action === "compact" || action === "detailed") {
          patch = { progressMode: action };
        } else if (action === "max") {
          const max = Number(tokens[1]);
          if (!Number.isInteger(max) || max < 1 || max > 32) {
            notifyWorkflow(ctx, "Usage: /workflows-progress max <1-32>", "warning");
            return;
          }
          patch = { maxAgentsShown: max };
        } else {
          notifyWorkflow(ctx, "Usage: /workflows-progress compact|detailed|status|max <N>", "warning");
          return;
        }
        try {
          persistWorkflowSetting(patch);
          refreshWidget();
          notifyWorkflow(
            ctx,
            `Workflow progress set to ${workflowSettings.progressMode}, max ${workflowSettings.maxAgentsShown}.`,
            "info",
          );
        } catch (error: unknown) {
          notifyWorkflow(
            ctx,
            `Could not save workflow progress settings: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        }
      },
    });

    // /workflows-trigger: keyword arming (A5). Typing the bounded word
    // `workflow`/`workflows` — or a configured synonym — in an ordinary message
    // counts as an explicit opt-in to multi-agent orchestration, and the message
    // receives hidden model guidance. Arming AUTHORIZES the tool; it never forces a run,
    // and it never opens UI. A user asking a question about workflows still gets
    // an ordinary answer.
    const TRIGGER_WORD_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u;
    const persistTriggerSettings = (): void => {
      try {
        persistWorkflowSetting({ keywordTriggerWord: triggerKeyword, keywordTriggerEnabled });
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
          notifyWorkflow(ctx, "Workflow keyword trigger disabled.", "info");
          return;
        }
        if (token === "on") {
          keywordTriggerEnabled = true;
          persistTriggerSettings();
          notifyWorkflow(ctx, `Workflow keyword trigger armed on "${triggerKeyword ?? DEFAULT_TRIGGER_WORD}".`, "info");
          return;
        }
        if (token === "reset") {
          triggerKeyword = undefined;
          keywordTriggerEnabled = true;
          persistTriggerSettings();
          notifyWorkflow(ctx, `Workflow keyword trigger reset to default "${DEFAULT_TRIGGER_WORD}".`, "info");
          return;
        }
        if (token === "status") {
          notifyWorkflow(
            ctx,
            `Workflow keyword trigger: ${keywordTriggerEnabled ? "armed" : "disabled"} on "${triggerKeyword ?? DEFAULT_TRIGGER_WORD}"`,
            "info",
          );
          return;
        }
        const keyword = token === "set" ? (args.trim().split(/\s+/)[1] ?? "") : token;
        if (!TRIGGER_WORD_PATTERN.test(keyword)) {
          notifyWorkflow(
            ctx,
            "Usage: /workflows-trigger set <one-word-keyword> | off | on | reset | status",
            "warning",
          );
          return;
        }
        triggerKeyword = keyword.toLowerCase();
        keywordTriggerEnabled = true;
        persistTriggerSettings();
        notifyWorkflow(ctx, `Workflow keyword trigger armed on "${keyword}".`, "info");
      },
    });

    // Keyword arming input hook (A5). Record provenance, never append model
    // guidance to native user text: the model may use `workflow` and may still
    // decline, which is what keeps "how do workflows work?" an ordinary
    // question. Nothing is swallowed and no UI opens.
    pi.on("input", (event, ctx) => {
      const ownWake = event.source === "extension" && event.text.startsWith(DELIVERY_WAKE_PREFIX);
      if (ownWake) {
        const admission = wakeAdmissions.get(event.text);
        wakeAdmissions.delete(event.text); // exact, one-use ownership, even on rejection
        if (
          !admission ||
          admission.generation !== deliveryGeneration ||
          admission.context !== deliveryContext ||
          admission.engine !== engine ||
          !canDeliver()
        ) {
          turnArming.retire();
          return { action: "handled" as const };
        }
        try {
          if (
            admission.anchor &&
            !admission.context.sessionManager.getBranch().some((entry) => entry.id === admission.anchor)
          ) {
            turnArming.retire();
            return { action: "handled" as const };
          }
        } catch {
          turnArming.retire();
          return { action: "handled" as const };
        }
      }
      inputPreparing = true;
      navigating = false; // a fresh prompt supersedes an uncommitted navigation
      if (deliveryTimer) clearTimeout(deliveryTimer);
      deliveryTimer = undefined;
      const text = event.text;
      const explicitTrigger = keywordTriggerEnabled && hasTriggerWord(text, triggerKeyword);
      const substantive = effortLevel !== "off" && text.trim().length >= 16 && !text.trim().startsWith("/");
      turnArming.observe(
        { ...event, text },
        ctx,
        active && (explicitTrigger || substantive),
        effortLevel,
        explicitTrigger,
      );
      if (ownWake)
        return {
          action: "transform" as const,
          text: DELIVERY_WAKE_TEXT,
          ...(event.images ? { images: event.images } : {}),
        };
      return { action: "continue" as const };
    });

    // Hidden guidance is turn-local, including on reload and after later hooks
    // navigate while before_agent_start is awaiting. Never edit native history.
    // Request-local overlays never enter native history or summarization.
    pi.on("message_start", (event, ctx) => turnArming.messageStarted(event, ctx));
    pi.on("context", (event, ctx) => turnArming.filterContext(event, ctx));

    // Standing effort mode mirrors the reference: it auto-arms substantive
    // interactive messages but remains guidance, not an inferred spend ceiling.
    pi.registerCommand("effort", {
      description: "Standing workflow effort: off | high | ultra",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const level = args.trim().toLowerCase();
        if (level !== "off" && level !== "high" && level !== "ultra") {
          notifyWorkflow(ctx, `Effort is currently "${effortLevel}". Usage: /effort off|high|ultra`, "info");
          return;
        }
        effortLevel = level;
        try {
          persistWorkflowSetting({ effort: effortLevel });
        } catch {
          /* warning is non-fatal */
        }
        notifyWorkflow(
          ctx,
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
        try {
          persistWorkflowSetting({ effort: effortLevel });
        } catch {
          /* warning is non-fatal */
        }
        notifyWorkflow(
          ctx,
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
            const cwd = ctx.cwd;
            const scope = resolveCodeReviewScope(text, (file, argv) => runCommand(file, argv, cwd));
            for (const notice of scope.notices) notifyWorkflow(ctx, notice, "warning");
            if (!scope.diff.trim()) return;
            scriptArgs = { diff: scope.diff, diffSource: scope.diffSource };
          } else {
            scriptArgs = text ? { [descriptor.primaryArg]: text } : undefined;
          }
          try {
            validateBuiltinArgs(name, scriptArgs);
          } catch (error: unknown) {
            notifyWorkflow(ctx, error instanceof Error ? error.message : String(error), "warning");
            return;
          }
          const options: ScriptStartOptions = {
            args: scriptArgs,
            background: true,
            toolset: descriptor.toolset,
            excludeTools: [...DEFAULT_EXCLUDED_TOOLS],
            loadSavedWorkflow: resolveNestedWorkflow,
            strengths: workflowSettings.strengths,
          };
          try {
            const workflowEngine = currentEngine();
            const result = await workflowEngine.start(descriptor.script, options);
            void deliverBackgroundResult(workflowEngine, result.runId);
            notifyWorkflow(ctx, `Workflow ${name} started in background: ${result.runId}`, "info");
          } catch (error: unknown) {
            notifyWorkflow(ctx, error instanceof Error ? error.message : String(error), "error");
          }
        },
      });
      registeredWorkflowCommands.add(name);
    }

    // Neither before-event is a commit point. Pi can veto in a later handler,
    // or summarization may abort after every handler has run.
    const beforeNavigation = (ctx: ExtensionContext): { cancel: true } | undefined => {
      turnArming.retire();
      const veto = navigationPreflight(ctx);
      if (!veto) {
        navigating = true;
        if (deliveryTimer) clearTimeout(deliveryTimer);
        deliveryTimer = undefined;
      }
      return veto;
    };
    pi.on("session_before_switch", (_event, ctx) => beforeNavigation(ctx));
    pi.on("session_before_tree", (event, ctx) => {
      // The public preparation array is mutable; remove only legacy owned
      // custom guidance, never quoted user content or stored history.
      const entries = event.preparation?.entriesToSummarize ?? [];
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry?.type === "custom_message" && entry.customType === WORKFLOW_ARMING_MESSAGE_TYPE)
          entries.splice(index, 1);
      }
      return beforeNavigation(ctx);
    });
    pi.on("session_before_fork", (_event, ctx) => beforeNavigation(ctx));
    pi.on("before_agent_start", (event, ctx) => {
      inputPreparing = true;
      if (deliveryTimer) clearTimeout(deliveryTimer);
      deliveryTimer = undefined;
      return turnArming.consume(event, ctx);
    });
    pi.on("agent_start", () => {
      inputPreparing = false;
    });
    pi.on("session_before_compact", (event) => {
      for (const messages of [
        event.preparation?.messagesToSummarize ?? [],
        event.preparation?.turnPrefixMessages ?? [],
      ]) {
        for (let index = messages.length - 1; index >= 0; index--) {
          const message = messages[index];
          if (message?.role === "custom" && message.customType === WORKFLOW_ARMING_MESSAGE_TYPE)
            messages.splice(index, 1);
        }
      }
      compacting = true;
      if (deliveryTimer) clearTimeout(deliveryTimer);
      deliveryTimer = undefined;
    });
    const afterCompact = (): void => {
      compacting = false;
      schedulePendingDeliveries();
    };
    pi.on("session_compact", afterCompact);
    pi.on("session_compact_failed", afterCompact);
    pi.on("agent_settled", () => {
      turnArming.retire();
      inputPreparing = false;
      schedulePendingDeliveries();
    });
    pi.on("session_tree", (event, ctx) => {
      let workflowEngine: WorkflowEngine;
      try {
        workflowEngine = currentEngine();
      } catch {
        return;
      }
      invalidateDelivery();
      pendingDeliveryMarkers.clear();
      inputPreparing = false;
      compacting = false;
      navigating = false;
      if (handledTreeEvent !== event) {
        // A controller abort can synchronously call stop-owned RPC. Detach the
        // old subagent records first, regardless of extension load order, so its
        // managed-stop tombstone cannot be appended on the committed new leaf.
        pi.events.emit("pi-workflows:session_tree_committed", { event });
        workflowEngine.fenceCommittedBranch();
      }
      handledTreeEvent = event;
      try {
        const entries = ctx.sessionManager.getBranch() as unknown as SessionEntryLike[];
        journalBranchAnchor =
          ctx.sessionManager.getLeafId?.() ?? (entries.at(-1) as { id?: string } | undefined)?.id ?? null;
        workflowEngine.restore(entries);
        workflowEngine.resumeLifecycle();
        deliveryContext = ctx;
        deliveryBranchAnchor = journalBranchAnchor;
        registerStatusActions();
        hydratePendingDeliveries(entries);
        schedulePendingDeliveries();
      } catch (error: unknown) {
        active = false; // never resume an old branch after a failed restore
        console.warn(
          `[pi-workflows] session tree recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        refreshWidget();
      }
    });
  };

  /** Native journal identity survives restore; runtime generation counters do not. */
  function completionReceipt(workflowEngine: WorkflowEngine, runId: string): string | undefined {
    const run = workflowEngine.getState(runId)?.run;
    if (!run || !["completed", "failed", "stopped"].includes(run.status)) return;
    try {
      const branch = deliveryContext?.sessionManager.getBranch() ?? [];
      for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index];
        if (entry.type !== "custom" || entry.customType !== JOURNAL_ENTRY_TYPE) continue;
        const data = entry.data as Record<string, unknown> | undefined;
        if (
          data?.runId === runId &&
          data.status === run.status &&
          data.timestamp === run.updatedAt &&
          (data.kind === "workflow_transition" || data.kind === "terminal_recovery")
        )
          return entry.id;
      }
    } catch {
      // Unavailable branch evidence cannot acknowledge a result.
    }
  }

  function consumeReviewedResult(
    workflowEngine: WorkflowEngine,
    runId: string,
    execution: number,
    completionId: string,
    generation: number,
    ctx: ExtensionContext,
  ): boolean {
    const current = () =>
      generation === deliveryGeneration &&
      workflowEngine === engine &&
      ctx.sessionManager === deliveryContext?.sessionManager &&
      ownsDeliveryBranch() &&
      workflowEngine.getState(runId)?.executionGeneration === execution &&
      completionReceipt(workflowEngine, runId) === completionId;
    if (!current()) return false;
    // An older marker without a durable receipt cannot be attributed to the
    // reviewed execution. Preserve it rather than silently migrating history.
    if (pendingDeliveryMarkers.has(runId) && pendingDeliveryMarkers.get(runId)?.completionId === undefined)
      return false;
    if (observedExecutions.get(runId) === completionId) return true;
    try {
      const previous = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
      pi.appendEntry(PENDING_DELIVERY_ACK_TYPE, {
        runId,
        executionGeneration: execution,
        completionId,
        observed: true,
        timestamp: Date.now(),
      });
      if (!current()) return false;
      const accepted = ctx.sessionManager.getBranch().some((entry) => {
        if (previous.has(entry.id) || entry.type !== "custom" || entry.customType !== PENDING_DELIVERY_ACK_TYPE)
          return false;
        const data = entry.data as Record<string, unknown> | undefined;
        return data?.runId === runId && data.completionId === completionId && data.observed === true;
      });
      if (!accepted) return false;
      advanceDeliveryAnchor();
      observedExecutions.set(runId, completionId);
      while (observedExecutions.size > MAX_PENDING_DELIVERIES)
        observedExecutions.delete(observedExecutions.keys().next().value as string);
      if (pendingDeliveryMarkers.get(runId)?.completionId === completionId) pendingDeliveryMarkers.delete(runId);
      return true;
    } catch {
      return false;
    }
  }

  const rememberPendingDelivery = (
    runId: string,
    text: string,
    timestamp = Date.now(),
    executionGeneration?: number,
    completionId?: string,
  ): void => {
    if (
      !runId ||
      timestamp + PENDING_DELIVERY_TTL_MS < Date.now() ||
      (completionId !== undefined && observedExecutions.get(runId) === completionId)
    )
      return;
    pendingDeliveryMarkers.set(runId, { text: text.slice(0, 8_000), timestamp, executionGeneration, completionId });
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
  const deliverBackgroundResult = async (workflowEngine: WorkflowEngine, runId: string): Promise<void> => {
    const generation = deliveryGeneration;
    const executionGeneration = workflowEngine.getState(runId)?.executionGeneration;
    const observerKey = `${generation}:${executionGeneration}`;
    if (deliveryObservers.get(runId) === observerKey) return;
    deliveryObservers.set(runId, observerKey);
    while (deliveryObservers.size > 256) {
      const oldest = deliveryObservers.keys().next().value;
      if (oldest === undefined) break;
      deliveryObservers.delete(oldest);
    }
    const run = await workflowEngine.waitFor(runId).catch(() => undefined);
    if (
      !run ||
      generation !== deliveryGeneration ||
      workflowEngine !== engine ||
      executionGeneration !== workflowEngine.getState(runId)?.executionGeneration ||
      !["completed", "failed", "stopped"].includes(run.status)
    )
      return;
    const completionId = completionReceipt(workflowEngine, runId);
    if (completionId !== undefined && observedExecutions.get(runId) === completionId) return;
    const header = `Workflow ${run.runId} ${run.status}`;
    const state = workflowEngine.getState(runId);
    const finalResult = state?.result ?? run.finalResult;
    const body =
      run.error ??
      (finalResult === undefined
        ? `completed with ${Object.keys(run.callResults).length} agent call(s).`
        : `result:\n${typeof finalResult === "string" ? finalResult : (JSON.stringify(finalResult, null, 2) ?? String(finalResult))}`);
    const text = `${header}: ${body}`;
    if (!ownsDeliveryBranch()) return;
    rememberPendingDelivery(runId, text, Date.now(), executionGeneration, completionId);
    try {
      pi.appendEntry(PENDING_DELIVERY_TYPE, {
        runId,
        executionGeneration,
        completionId,
        text: text.slice(0, 8_000),
        status: run.status,
        timestamp: Date.now(),
      });
      advanceDeliveryAnchor();
    } catch {
      // Best-effort persistence; the in-memory marker remains retryable.
    }
    schedulePendingDeliveries();
  };

  const ownsDeliveryBranch = (): boolean => {
    if (!active || !deliveryContext || !engine || engine.isDisposed()) return false;
    try {
      const branch = deliveryContext.sessionManager.getBranch();
      return [deliveryBranchAnchor, journalBranchAnchor].every(
        (anchor) => !anchor || branch.some((entry) => entry.id === anchor),
      );
    } catch {
      return false;
    }
  };
  const advanceDeliveryAnchor = (): void => {
    if (!deliveryContext) return;
    deliveryBranchAnchor =
      deliveryContext.sessionManager.getLeafId?.() ?? deliveryContext.sessionManager.getBranch().at(-1)?.id ?? null;
  };
  const canDeliver = (): boolean => {
    if (!ownsDeliveryBranch() || inputPreparing || compacting || navigating) return false;
    try {
      return deliveryContext?.isIdle() === true && deliveryContext.hasPendingMessages() === false;
    } catch {
      return false;
    }
  };
  const hydratePendingDeliveries = (entries: SessionEntryLike[]): void => {
    pendingDeliveryMarkers.clear();
    observedExecutions.clear();
    for (const entry of entries) {
      const shaped = entry as { type?: unknown; customType?: unknown; data?: unknown };
      if (shaped.type !== "custom") continue;
      const data = shaped.data as Record<string, unknown> | undefined;
      if (typeof data?.runId !== "string") continue;
      if (shaped.customType === PENDING_DELIVERY_ACK_TYPE) {
        // Explicit reads acknowledge exactly one durable terminal receipt.
        // Ordinary delivery ACKs still acknowledge the actual handed-off marker.
        if (
          data.observed !== true ||
          (typeof data.completionId === "string" &&
            pendingDeliveryMarkers.get(data.runId)?.completionId === data.completionId)
        )
          pendingDeliveryMarkers.delete(data.runId);
      } else if (shaped.customType === PENDING_DELIVERY_TYPE && typeof data.text === "string") {
        rememberPendingDelivery(
          data.runId,
          data.text,
          typeof data.timestamp === "number" ? data.timestamp : Date.now(),
          typeof data.executionGeneration === "number" ? data.executionGeneration : undefined,
          typeof data.completionId === "string" ? data.completionId : undefined,
        );
      }
    }
  };
  const flushPendingDeliveries = (): void => {
    for (const [runId, marker] of pendingDeliveryMarkers) {
      if (marker.completionId !== undefined && observedExecutions.get(runId) === marker.completionId)
        pendingDeliveryMarkers.delete(runId);
    }
    if (!canDeliver() || !deliveryContext || pendingDeliveryMarkers.size === 0) return;
    if (typeof pi.sendMessage !== "function" || typeof pi.sendUserMessage !== "function") return;
    const ctx = deliveryContext;
    const generation = deliveryGeneration;
    // Bounded batches coalesce simultaneous completions without model polling.
    const batch = [...pendingDeliveryMarkers].slice(0, 8);
    const isCurrent = (): boolean => generation === deliveryGeneration && ctx === deliveryContext && canDeliver();
    const persisted = (runId: string): boolean =>
      ctx.sessionManager.getBranch().some((entry) => {
        const shaped = entry as {
          type?: string;
          customType?: string;
          content?: unknown;
          details?: { runIds?: unknown };
        };
        const ids = shaped.details?.runIds;
        return (
          shaped.type === "custom_message" &&
          shaped.customType === "pi-workflows:delivery" &&
          typeof shaped.content === "string" &&
          Array.isArray(ids) &&
          ids.length > 0 &&
          ids.length <= 8 &&
          ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128) &&
          new Set(ids).size === ids.length &&
          ids.includes(runId)
        );
      });
    try {
      if (!isCurrent()) return;
      // Never use a custom-message triggerTurn: that skips input preparation
      // and before_agent_start. The void API is NOT an acceptance promise.
      const missing = batch.filter(([runId]) => !persisted(runId));
      if (missing.length > 0)
        pi.sendMessage(
          {
            content: missing.map(([, marker]) => marker.text).join("\n\n"),
            display: true,
            customType: "pi-workflows:delivery",
            details: { runIds: missing.map(([runId]) => runId) },
          },
          { triggerTurn: false },
        );
      if (!isCurrent() || !batch.every(([runId]) => persisted(runId))) return;
      advanceDeliveryAnchor();
      for (const [runId] of batch) {
        if (!isCurrent()) return;
        const priorEntryIds = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
        pi.appendEntry(PENDING_DELIVERY_ACK_TYPE, { runId, timestamp: Date.now() });
        if (!isCurrent()) return;
        const acknowledged = ctx.sessionManager.getBranch().some((entry) => {
          const shaped = entry as { type?: string; customType?: string; data?: { runId?: unknown } };
          return (
            !priorEntryIds.has(entry.id) &&
            shaped.type === "custom" &&
            shaped.customType === PENDING_DELIVERY_ACK_TYPE &&
            shaped.data?.runId === runId
          );
        });
        if (!acknowledged) return;
        advanceDeliveryAnchor();
        pendingDeliveryMarkers.delete(runId);
      }
      // An earlier input hook can await while the same manager navigates. Keep
      // exact owner evidence until our input hook consumes this private wake.
      if (isCurrent() && engine) {
        const wake = `${DELIVERY_WAKE_PREFIX}${randomUUID()}] ${DELIVERY_WAKE_TEXT}`;
        wakeAdmissions.set(wake, { generation, context: ctx, engine, anchor: deliveryBranchAnchor });
        while (wakeAdmissions.size > MAX_WAKE_ADMISSIONS) {
          const oldest = wakeAdmissions.keys().next().value;
          if (oldest === undefined) break;
          wakeAdmissions.delete(oldest);
        }
        // Disable commands/templates explicitly for internal notification input.
        pi.sendUserMessage(wake, { deliverAs: "followUp", expandPromptTemplates: false });
      }
    } catch {
      // Retain unacknowledged markers. Retry only at a later lifecycle boundary.
    }
  };
  const schedulePendingDeliveries = (): void => {
    if (deliveryTimer || pendingDeliveryMarkers.size === 0 || !ownsDeliveryBranch()) return;
    const generation = deliveryGeneration;
    // Defer handoff out of our notification-only agent_settled handler;
    // later handlers may navigate or start compaction in either load order.
    deliveryTimer = setTimeout(() => {
      deliveryTimer = undefined;
      if (generation === deliveryGeneration) flushPendingDeliveries();
    }, 0);
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
        strengths: workflowSettings.strengths,
        mainModel: ctx.model?.id,
      });
      void deliverBackgroundResult(workflowEngine, result.runId);
      return result.runId;
    } catch (error: unknown) {
      notifyWorkflow(ctx, error instanceof Error ? error.message : String(error), "error");
      return undefined;
    }
  };

  const saveWorkflowFromRun = async (ctx: ExtensionCommandContext, name: string, runId?: string): Promise<void> => {
    const state = currentEngine().getState(runId ?? "");
    if (!state) {
      throw new Error(`Workflow run not found: ${runId ?? "(none)"}`);
    }
    saveWorkflow(name, state.run.script, sessionCwd);
    notifyWorkflow(ctx, `Saved workflow "${name}" (${state.run.script.length} chars).`, "info");
  };

  pi.on("session_start", async (_event, ctx) => {
    turnArming.retire();
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

    journalBranchAnchor =
      ctx.sessionManager.getLeafId?.() ?? (initialEntries.at(-1) as { id?: string } | undefined)?.id ?? null;
    let recoveredEngine: WorkflowEngine | undefined;
    let recoveryError: unknown;
    for (let attempt = 0; attempt < 3 && !recoveredEngine; attempt += 1) {
      const candidate = new WorkflowEngine(
        pi.events,
        client,
        {
          append(event) {
            if (generation !== lifecycleGeneration) throw new Error("workflow session retired before journal append");
            // Every append moves Pi's leaf. Remember the new leaf afterwards;
            // unrelated appends beneath it remain valid, but a navigated-away
            // branch must never receive an old terminal fact. Only traverse the
            // branch when the leaf has moved (or the host cannot report it).
            if (journalBranchAnchor && ctx.sessionManager.getLeafId?.() !== journalBranchAnchor) {
              const branch = ctx.sessionManager.getBranch() as Array<{ id?: string }>;
              if (!branch.some((entry) => entry.id === journalBranchAnchor)) {
                throw new Error("workflow journal branch changed before append");
              }
            }
            pi.appendEntry(JOURNAL_ENTRY_TYPE, event);
            // Some hosts cannot report a leaf ID. Read the new branch tip after
            // every append rather than retaining the old (now-ancestor) anchor:
            // a later run on a sibling would otherwise pass the ancestry check.
            journalBranchAnchor =
              ctx.sessionManager.getLeafId?.() ?? (ctx.sessionManager.getBranch() as Array<{ id?: string }>).at(-1)?.id;
            if (!journalBranchAnchor) throw new Error("workflow journal leaf unavailable after append");
            // Journal writes precede some state mutations; refresh once applied.
            queueMicrotask(() => {
              if (generation === lifecycleGeneration) refreshWidget();
            });
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
        sessionCwd,
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

    if (generation !== lifecycleGeneration) {
      recoveredEngine.dispose();
      return;
    }
    engine = recoveredEngine;
    widgetUi = ctx.mode === "tui" ? ctx.ui : undefined;
    registerSurface();

    // Public API methods target the current session: generation + branch
    // ownership, not a captured function value, provide session affinity.
    deliveryContext = ctx;
    deliveryBranchAnchor = journalBranchAnchor;
    registerStatusActions();
    workflowUiBridge ??= new WorkflowUiBridge(pi.events, workflowUiSurface);
    workflowUiBridge.publish();
    inputPreparing = false;
    compacting = false;
    navigating = false;
    try {
      hydratePendingDeliveries(ctx.sessionManager.getBranch() as unknown as SessionEntryLike[]);
    } catch {
      pendingDeliveryMarkers.clear(); // fail closed on an unreadable branch
    }
    schedulePendingDeliveries();

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
              strengths: workflowSettings.strengths,
            };
            const result = await workflowEngine.start(script, options);
            void deliverBackgroundResult(workflowEngine, result.runId);
            notifyWorkflow(commandCtx, `Workflow ${savedName} started in background: ${result.runId}`, "info");
          } catch (error: unknown) {
            notifyWorkflow(commandCtx, error instanceof Error ? error.message : String(error), "error");
          }
        },
      });
      registeredWorkflowCommands.add(savedName);
    }
  });

  pi.on("session_shutdown", async () => {
    // This synchronous boundary is shared with the bus-first shutdown path.
    const quiescence = beginShutdownQuiesce();
    workflowUiBridge?.dispose();
    workflowUiBridge = undefined;
    clearWidget();
    widgetUi = undefined;
    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = undefined;
    }
    const closingEngine = engine;
    if (closingEngine) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        quiescence,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), 6_000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!result?.settled) {
        console.warn(
          `[pi-workflows] shutdown quiescence timed out or failed; ${result?.diagnostic ?? `pending: ${result?.pending.join(", ") ?? "unknown"}`}; late callbacks fenced`,
        );
      }
    }
    lifecycleGeneration += 1;
    protocolAbortController?.abort();
    protocolAbortController = undefined;
    closingEngine?.dispose();
    engine = undefined;
    shutdownQuiesce = undefined;
    protocolCheck = undefined;
    protocolProbe = undefined;
    protocolInFlight = undefined;
    protocolError = undefined;
    deliveryContext = undefined;
  });
}

export type { ScriptStartResult };
export { WorkflowWaitAbortedError };
