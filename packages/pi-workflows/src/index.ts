import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { DEFAULT_TRIGGER_WORD, hasTriggerWord, WORKFLOW_ARMED_DIRECTIVE } from "./arming.js";
import { BUILTIN_WORKFLOWS } from "./builtins.js";
import { type CommandResult, resolveCodeReviewScope } from "./code-review-scope.js";
import { type ScriptStartOptions, type ScriptStartResult, WorkflowEngine, WorkflowWaitAbortedError } from "./engine.js";
import { JOURNAL_ENTRY_TYPE, type SessionEntryLike } from "./journal.js";
import { createManagedSpawnClient, PROTOCOL_DIAGNOSTIC, queryChildSessionContextImmediate } from "./rpc-client.js";
import { listSavedWorkflows, loadSavedWorkflow, saveWorkflow } from "./saved-workflows.js";
import { liveWidgetLines, showWorkflowNavigator } from "./ui.js";

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

export default function piWorkflows(pi: ExtensionAPI): void {
  let engine: WorkflowEngine | undefined;
  let protocolError: string | undefined;
  let protocolCheck: Promise<void> = Promise.resolve();
  let active = false;
  let unsubscribeTreeSignal: (() => void) | undefined;
  let branchQuiesce: Promise<{ settled: boolean; pending: string[]; diagnostic?: string }> | undefined;
  let lifecycleGeneration = 0;
  let protocolAbortController: AbortController | undefined;
  let sessionCwd = process.cwd();
  /** Per-session delivery endpoint for background-run results (A10 fail-closed). */
  let deliverResult: ((text: string, details?: unknown) => void) | undefined;
  /** Pending deliveries for runs that settled before a session endpoint was bound (A10). */
  const pendingDeliveryMarkers = new Map<string, { text: string; timestamp: number }>();
  const PENDING_DELIVERY_TYPE = "pi-workflows:pending-delivery";
  let widgetTimer: ReturnType<typeof setInterval> | undefined;

  const currentEngine = (): WorkflowEngine => {
    if (!engine) throw new Error("pi-workflows is not active in this session context");
    return engine;
  };

  const branchEntries = (): SessionEntryLike[] => {
    const ctx = (pi as unknown as { currentSessionManager?: { getBranch?: () => unknown } }).currentSessionManager;
    try {
      return (ctx?.getBranch?.() as SessionEntryLike[] | undefined) ?? [];
    } catch {
      return [];
    }
  };

  const resolveScript = (script: string | undefined, name: string | undefined): { script: string; source: string } => {
    if (script !== undefined && name !== undefined) {
      throw new Error("Provide either `script` or `name`, not both.");
    }
    if (script !== undefined) return { script, source: "inline" };
    if (name !== undefined) {
      const saved = loadSavedWorkflow(name, sessionCwd);
      if (saved) return { script: saved, source: `saved:${name}` };
      const builtin = BUILTIN_WORKFLOWS[name]?.script;
      if (builtin) return { script: builtin, source: `builtin:${name}` };
      throw new Error(`Unknown workflow name "${name}". It is neither a saved workflow nor a built-in.`);
    }
    throw new Error("Provide either `script` or `name`.");
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
          "Run a JavaScript workflow script through the pi-subagents managed spawning protocol. The script declares `export const meta = { name, description, phases }` first and uses the runtime globals agent(), parallel(), pipeline(), workflow(), verify(), judgePanel(), loopUntilDry(), completenessCheck(), retry(), gate(), checkpoint(), phase(), log(), args, cwd, process, and budget. Determinism is enforced: Date.now()/Math.random()/new Date() are unavailable.",
        promptSnippet: "Run a JavaScript workflow script",
        promptGuidelines: [
          "Provide either a full `script` (raw JavaScript with the meta contract first) or a `name` of a saved/built-in workflow.",
          "Use parallel(() => agent(...), ...) for concurrent agents; pipeline(items, ...stages) for sequential per-item stages.",
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
            await protocolCheck;
          } catch (error: unknown) {
            return textResult(
              protocolError ??
                `${PROTOCOL_DIAGNOSTIC} Diagnostic: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          const { script, source } = resolveScript(params.script, params.name);
          const options: ScriptStartOptions = {
            args: params.args,
            background: params.background ?? true,
            maxAgents: params.maxAgents,
            concurrency: params.concurrency,
            agentRetries: params.agentRetries,
            tokenBudget: params.tokenBudget,
            agentTimeoutMs: params.agentTimeoutMs,
            signal,
            mainModel: ctx?.model?.id,
            // Foreground checkpoint confirmation only when the run is not
            // background — background runs are headless by contract.
            confirm:
              params.background === false && ctx?.ui
                ? async (promptText: string) => {
                    const answer = await ctx.ui.confirm(promptText, promptText);
                    return answer;
                  }
                : undefined,
            loadSavedWorkflow: (name) => loadSavedWorkflow(name, sessionCwd) ?? BUILTIN_WORKFLOWS[name]?.script,
          };
          if (params.resumeFromRunId) {
            const resumed = await workflowEngine.resume(params.resumeFromRunId, branchEntries(), options);
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
          const action = params.action as "list" | "get" | "pause" | "resume" | "stop" | "rm";
          if (!["list", "get", "pause", "resume", "stop", "rm"].includes(action)) {
            throw new Error(`unknown workflow_control action: ${params.action}`);
          }
          const result = await workflowEngine.control(action, params.run_id);
          return textResult(JSON.stringify(result), result);
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
        if (!subcommand) {
          await showWorkflowNavigator(ctx, workflowEngine);
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
          const firstListed = workflowEngine.list()[0]?.runId;
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
            await workflowEngine.control(subcommand, runId);
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
          const runId = rest[1];
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

    // /workflows-progress: progress panel toggle (A5).
    let progressPanel = false;
    pi.registerCommand("workflows-progress", {
      description: "Toggle the workflow progress panel",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        progressPanel = !progressPanel;
        ctx.ui.notify(`Workflow progress panel ${progressPanel ? "enabled" : "disabled"}.`, "info");
      },
    });

    // /workflows-trigger: keyword arming (A5). Typing the bounded word
    // `workflow`/`workflows` — or a configured synonym — in an ordinary message
    // counts as an explicit opt-in to multi-agent orchestration, and the message
    // is annotated to say so. Arming AUTHORIZES the tool; it never forces a run,
    // and it never opens UI. A user asking a question about workflows still gets
    // an ordinary answer.
    let triggerKeyword: string | undefined;
    let keywordTriggerEnabled = true;
    const TRIGGER_WORD_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u;
    pi.registerCommand("workflows-trigger", {
      description: "Arm the workflow tool on a keyword: set <keyword> | off | on",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const token = args.trim().split(/\s+/)[0] ?? "";
        if (token === "off") {
          keywordTriggerEnabled = false;
          ctx.ui.notify("Workflow keyword trigger disabled.", "info");
          return;
        }
        if (token === "on") {
          keywordTriggerEnabled = true;
          ctx.ui.notify(`Workflow keyword trigger armed on "${triggerKeyword ?? DEFAULT_TRIGGER_WORD}".`, "info");
          return;
        }
        const keyword = token === "set" ? (args.trim().split(/\s+/)[1] ?? "") : token;
        if (!TRIGGER_WORD_PATTERN.test(keyword)) {
          ctx.ui.notify("Usage: /workflows-trigger set <one-word-keyword> | off | on", "warning");
          return;
        }
        triggerKeyword = keyword.toLowerCase();
        keywordTriggerEnabled = true;
        ctx.ui.notify(`Workflow keyword trigger armed on "${keyword}".`, "info");
      },
    });

    // Keyword arming input hook (A5). The message is annotated rather than
    // acted on: the model is told it may use the `workflow` tool and may still
    // decline, which is what keeps "how do workflows work?" an ordinary
    // question. Nothing is swallowed and no UI opens.
    pi.on("input", (event) => {
      if (!keywordTriggerEnabled) return { action: "continue" as const };
      // Extension-submitted text (a background result delivering back into the
      // conversation, a saved-workflow command) must never re-arm: the annotation
      // would then compound on every hop.
      if (event.source === "extension") return { action: "continue" as const };
      if (!hasTriggerWord(event.text, triggerKeyword)) return { action: "continue" as const };
      // Already annotated — a re-submitted or steered message must not stack a
      // second copy of the directive.
      if (event.text.includes(WORKFLOW_ARMED_DIRECTIVE)) return { action: "continue" as const };
      return {
        action: "transform" as const,
        text: `${event.text}\n\n${WORKFLOW_ARMED_DIRECTIVE}`,
        ...(event.images ? { images: event.images } : {}),
      };
    });

    // /effort and /ultracode: effort presets are workflow-tier aliases.
    pi.registerCommand("effort", {
      description: "Set the workflow effort preset (small/medium/large → /workflows run tier)",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const level = args.trim().toLowerCase();
        if (level !== "small" && level !== "medium" && level !== "large") {
          ctx.ui.notify("Usage: /effort small|medium|large", "warning");
          return;
        }
        ctx.ui.notify(`Workflow effort preset: ${level}. Pass tier: "${level}" in agent() calls.`, "info");
      },
    });
    pi.registerCommand("ultracode", {
      description: "Ultra-effort preset: large tier for workflow agents",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        ctx.ui.notify("Ultra effort preset: large tier for workflow agents.", "info");
      },
    });

    // Builtin workflow commands (A6). Saved workflows with the same name take
    // precedence at resolution; the commands themselves still dispatch by name.
    // Names already claimed by another extension are left alone — Pi cannot
    // unregister or replace a command, so clobbering one is permanent.
    const claimedCommands = new Set((pi.getCommands?.() ?? []).map((command) => command.name));
    for (const name of Object.keys(BUILTIN_WORKFLOWS)) {
      if (claimedCommands.has(name)) continue;
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
          const options: ScriptStartOptions = {
            args: scriptArgs,
            background: true,
            loadSavedWorkflow: (savedName) =>
              loadSavedWorkflow(savedName, sessionCwd) ?? BUILTIN_WORKFLOWS[savedName]?.script,
          };
          const result = await workflowEngine.start(descriptor.script, options);
          ctx.ui.notify(`Workflow ${name} started in background: ${result.runId}`, "info");
        },
      });
    }

    // Live progress widget (A10): renders only while runs are active, then
    // clears itself. The widget is TUI-only; headless sessions skip it.
    const refreshWidget = () => {
      const tui = (pi as unknown as { ui?: { setWidget?: (key: string, content: string[] | undefined) => void } }).ui;
      if (!tui?.setWidget) return;
      const runs = workflowEngine
        .list()
        .map((summary) => workflowEngine.getRun(String(summary.runId)))
        .filter((run): run is NonNullable<typeof run> => run !== undefined);
      const lines = liveWidgetLines(runs);
      tui.setWidget("pi-workflows", lines.length > 0 ? lines : undefined);
      if (lines.length > 0 && !widgetTimer) {
        widgetTimer = setInterval(() => {
          if (!tui?.setWidget) return;
          const current = workflowEngine
            .list()
            .map((summary) => workflowEngine.getRun(String(summary.runId)))
            .filter((run): run is NonNullable<typeof run> => run !== undefined);
          const next = liveWidgetLines(current);
          tui.setWidget("pi-workflows", next.length > 0 ? next : undefined);
          if (next.length === 0 && widgetTimer) {
            clearInterval(widgetTimer);
            widgetTimer = undefined;
          }
        }, 2_000);
      } else if (lines.length === 0 && widgetTimer) {
        clearInterval(widgetTimer);
        widgetTimer = undefined;
      }
    };
    // Refresh after any control action and on run settlement.
    const notifyRunChanged = () => refreshWidget();
    workflowEngine.onRunSettled = notifyRunChanged;
    void notifyRunChanged;

    const beginBranchQuiesce = (): Promise<{ settled: boolean; pending: string[]; diagnostic?: string }> => {
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

  /** Background-run result delivery: fail-closed, session-bound (A10). */
  const deliverBackgroundResult = async (engine: WorkflowEngine, runId: string): Promise<void> => {
    const run = await engine.waitFor(runId).catch(() => undefined);
    if (!run) return;
    const header = `Workflow ${run.runId} ${run.status}`;
    const body = run.error ?? `completed with ${Object.keys(run.callResults).length} agent call(s).`;
    const text = `${header}: ${body}`;
    if (deliverResult) {
      try {
        deliverResult(text);
      } catch {
        // Endpoint suspended or send failed — leave pending for next bind (fail-closed).
        pendingDeliveryMarkers.set(runId, { text, timestamp: Date.now() });
        try {
          pi.appendEntry(PENDING_DELIVERY_TYPE, { runId, text, status: run.status, timestamp: Date.now() });
        } catch {
          // appendEntry is best-effort; in-memory marker still ensures flush on next bind
        }
      }
    } else {
      // No bound session endpoint — fail-closed: persist a pending marker and
      // flush it when a session binds, never fall back to shared pi.sendMessage.
      pendingDeliveryMarkers.set(runId, { text, timestamp: Date.now() });
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
        pendingDeliveryMarkers.delete(runId);
      } catch {
        // keep pending for next bind
      }
    }
  };

  /** Build a script from a natural-language prompt and run it in background. */
  const runWorkflowFromPrompt = async (ctx: ExtensionCommandContext, prompt: string): Promise<string | undefined> => {
    // A bounded, deterministic script that dispatches the user's instruction
    // through a general-purpose agent and returns its answer.
    const script = `export const meta = { name: "ad-hoc", description: "Run a user-requested task with a general-purpose agent" };
const answer = await agent(${JSON.stringify(prompt)});
return answer;`;
    try {
      const result = await currentEngine().start(script, { background: true, mainModel: ctx.model?.id });
      return result.runId;
    } catch (error: unknown) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return undefined;
    }
  };

  const saveWorkflowFromRun = async (ctx: ExtensionCommandContext, name: string, runId?: string): Promise<void> => {
    const state = engine?.getState(runId ?? "");
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
      for (const entry of initialEntries) {
        if (
          (entry as { type?: unknown; customType?: unknown; data?: unknown }).type === "custom" &&
          (entry as { customType?: unknown }).customType === PENDING_DELIVERY_TYPE
        ) {
          const data = (entry as { data?: unknown }).data as Record<string, unknown> | undefined;
          const pendingRunId = typeof data?.runId === "string" ? data.runId : undefined;
          const pendingText = typeof data?.text === "string" ? data.text : undefined;
          if (pendingRunId && pendingText && !pendingDeliveryMarkers.has(pendingRunId)) {
            pendingDeliveryMarkers.set(pendingRunId, { text: pendingText, timestamp: Date.now() });
          }
        }
      }
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
      if (existingCommands.has(savedName)) continue;
      const script = loadSavedWorkflow(savedName, sessionCwd);
      if (!script) continue;
      pi.registerCommand(savedName, {
        description: `Run the saved workflow ${savedName}`,
        handler: async (args: string, commandCtx: ExtensionCommandContext) => {
          const options: ScriptStartOptions = {
            args: args.trim() ? { prompt: args.trim() } : undefined,
            background: true,
            mainModel: commandCtx?.model?.id,
            loadSavedWorkflow: (name) => loadSavedWorkflow(name, sessionCwd) ?? BUILTIN_WORKFLOWS[name]?.script,
          };
          const result = await recoveredEngine.start(script, options);
          commandCtx.ui.notify(`Workflow ${savedName} started in background: ${result.runId}`, "info");
        },
      });
    }

    protocolError = undefined;
    protocolCheck = client.checkProtocol?.() ?? Promise.reject(new Error("managed protocol check is unavailable"));
    void protocolCheck.catch((error: unknown) => {
      if (generation !== lifecycleGeneration) return;
      const detail = error instanceof Error ? error.message : String(error);
      protocolError = `${PROTOCOL_DIAGNOSTIC} Diagnostic: ${detail}`;
    });
  });

  pi.on("session_shutdown", () => {
    lifecycleGeneration += 1;
    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = undefined;
    }
    protocolAbortController?.abort();
    protocolAbortController = undefined;
    unsubscribeTreeSignal?.();
    unsubscribeTreeSignal = undefined;
    engine?.dispose();
    engine = undefined;
    active = false;
    branchQuiesce = undefined;
    protocolCheck = Promise.resolve();
    protocolError = undefined;
    deliverResult = undefined;
  });
}

export type { ScriptStartResult };
export { WorkflowWaitAbortedError };
