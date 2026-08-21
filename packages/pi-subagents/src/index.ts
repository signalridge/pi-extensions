/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import {
  type AgentSession,
  type AutocompleteProviderFactory,
  defineTool,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  type SettingItem,
  SettingsList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { wrapCustomUi } from "@signalridge/pi-ui";
import { Type } from "@sinclair/typebox";
import { abortable } from "./abortable.js";
import {
  atomicCreateFile,
  atomicReplaceFile,
  buildNewAgentFile,
  disableInContent,
  enableInContent,
  findAgentFile,
  isEmptyStub,
  personalAgentsDir,
  projectAgentsDir,
  removeFileIfUnchanged,
  serializeAgentFile,
  validateAgentFileContent,
} from "./agent-file-toggle.js";
import {
  AgentManager,
  MANAGED_SPAWN_ENTRY_TYPE,
  type ManagedSpawnEntryLike,
  type ManagedSpawnPolicy,
  type ManagedSpawnRequest,
  type ManagedSpawnResult,
  type ManagedSpawnTombstone,
} from "./agent-manager.js";
import {
  getAgentConversation,
  getDefaultMaxTokens,
  getDefaultMaxToolCalls,
  getDefaultMaxTurns,
  getDefaultModel,
  getDefaultToolTimeoutMs,
  getGraceTurns,
  normalizeMaxTurns,
  resolveConfiguredDefaultModel,
  SUBAGENT_TOOL_NAMES,
  setDefaultMaxTokens,
  setDefaultMaxToolCalls,
  setDefaultMaxTurns,
  setDefaultModel,
  setDefaultToolTimeoutMs,
  setGraceTurns,
  steerAgent,
} from "./agent-runner.js";
import {
  buildAgentTierListText,
  buildAgentTierParameterDescription,
  buildCompactAgentTierListText,
  findUnknownAgentTierReferences,
  getAgentTiersConfiguredSettings,
  getAgentTiersSettings,
  getDefaultAgentTierText,
  isValidAgentTierKey,
  listAgentTierKeys,
  MAX_AGENT_TIER_KEY_LENGTH,
  offerableTierThinking,
  removeAgentTierProfile,
  setAgentTiersSettings,
  setDefaultAgentTier,
  upsertAgentTierProfile,
} from "./agent-tiers.js";
import {
  BUILTIN_TOOL_NAMES,
  getAgentConfig,
  getAllTypes,
  getAvailableTypes,
  getFallbackSubagent,
  isDefaultsDisabled,
  NO_FALLBACK,
  registerAgents,
  resolveSpawnType,
  resolveType,
  setDefaultsDisabled,
  setFallbackSubagent,
} from "./agent-types.js";
import { inChildSessionContext } from "./child-context.js";
import {
  PROTOCOL_CAPABILITIES,
  PROTOCOL_VERSION,
  type RpcHandle,
  registerChildContextHandler,
  registerRpcHandlers,
} from "./cross-extension-rpc.js";
import { loadCustomAgents } from "./custom-agents.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { readEnabledModels, resolveEnabledModels } from "./enabled-models.js";
import { GroupJoinManager } from "./group-join.js";
import { AGENT_DEFINITION_GENERATION_OVERRIDE } from "./internal-run.js";
import {
  resolveAgentInvocationConfig,
  resolveJoinMode,
} from "./invocation-config.js";
import {
  describeMention,
  handleBase,
  isReservedHandle,
  parseMention,
  resolveHandleToType,
  stripAgentPrefix,
} from "./mention.js";
import { runMentionClone } from "./mention-clone.js";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import {
  checkModelScope,
  isScopeModelsEnabled,
  setScopeModelsEnabled,
} from "./model-scope.js";
import { getMaxSubagentDepth, setMaxSubagentDepth } from "./nested-tools.js";
import {
  createOutputFilePath,
  ensureOutputFile,
  getOutputTranscriptDefault,
  setOutputTranscriptDefault,
  streamToOutputFile,
  writeInitialEntry,
} from "./output-file.js";
import { SubagentScheduler } from "./schedule.js";
import { resolveStorePath, ScheduleStore } from "./schedule-store.js";
import {
  AGENT_MENTION_MODES,
  type AgentMentionMode,
  type AgentTierProfile,
  applySettings,
  isModelReference,
  loadSettings,
  type SubagentsSettings,
  saveAndEmitChanged,
  type TierThinking,
  type ToolDescriptionMode,
} from "./settings.js";
import {
  getForegroundOutcomeNote,
  getStatusNote,
  partialOutputSuffix,
} from "./status-note.js";
import {
  type AgentConfig,
  type AgentInvocation,
  type AgentOwner,
  type AgentRecord,
  type JoinMode,
  type NotificationDetails,
  type SubagentType,
} from "./types.js";
import {
  type AgentActivity,
  type AgentDetails,
  buildInvocationTags,
  describeActivity,
  fgPreservingNestedStyles,
  formatDuration,
  formatMs,
  formatTokens,
  formatTurns,
  getDisplayName,
  getPromptModeLabel,
  SPINNER,
  SPINNER_INTERVAL_MS,
  type Theme,
} from "./ui/agent-display.js";
import { createMentionProvider, mentionRoster } from "./ui/agent-mention.js";
import {
  ConversationViewer,
  VIEWPORT_HEIGHT_PCT,
} from "./ui/conversation-viewer.js";
import { FleetList, type FleetUICtx } from "./ui/fleet-list.js";
import {
  safeTerminalText,
  sanitizeDisplayText,
  truncateCodePoints,
} from "./ui/safe-text.js";
import { showSchedulesMenu } from "./ui/schedule-menu.js";
import { selectItem } from "./ui/select-item.js";
import {
  getAgentStatusColor,
  getAgentStatusLabel,
  getAgentStatusMark,
} from "./ui/status-label.js";
import {
  addUsage,
  getLifetimeTotal,
  getSessionContextPercent,
  type LifetimeUsage,
} from "./usage.js";
import { getWorkflowSettings, resolveWorkflowTier, setWorkflowSettings } from "./workflow-tiers.js";
import { isWorktreeIsolationEnabled, setWorktreeIsolationEnabled } from "./worktree.js";

// ---- Shared helpers ----

/** Summarize every retained top-level run without collapsing terminal outcomes. */
export function summarizeAgentRuns(
  agents: readonly Pick<AgentRecord, "status">[],
): string {
  const counts = {
    running: 0,
    queued: 0,
    completed: 0,
    wrappedUp: 0,
    stopped: 0,
    aborted: 0,
    failed: 0,
  };
  for (const agent of agents) {
    switch (agent.status) {
      case "running":
        counts.running++;
        break;
      case "queued":
        counts.queued++;
        break;
      case "completed":
        counts.completed++;
        break;
      case "steered":
        counts.wrappedUp++;
        break;
      case "stopped":
        counts.stopped++;
        break;
      case "aborted":
        counts.aborted++;
        break;
      case "error":
        counts.failed++;
        break;
    }
  }
  return (
    `Agent runs (${agents.length}) · ${counts.running} running · ${counts.queued} queued · ` +
    `${counts.completed} completed · ${counts.wrappedUp} wrapped up · ${counts.stopped} stopped · ` +
    `${counts.aborted} aborted · ${counts.failed} failed`
  );
}
/** Tool execute return value for a text response. */
function textResult(msg: string, details?: AgentDetails) {
  return {
    content: [{ type: "text" as const, text: msg }],
    details: details as any,
  };
}

export function renderRunningAgentStatus(
  frame: string,
  statsText: string,
  activity: string,
  theme: Pick<Theme, "fg">,
): Container {
  const container = new Container();
  const stats = statsText ? theme.fg("dim", " · ") + statsText : "";
  const mark = theme.fg("accent", `${getAgentStatusMark("running")} `);
  container.addChild(
    new Text(mark + theme.fg("accent", "running") + stats, 0, 0),
  );
  // Indented to the width of the mark, so the spinner sits under the label and
  // the activity text starts at a column that never moves.
  container.addChild(new Text(theme.fg("dim", `  ${frame} ${activity}`), 0, 0));
  return container;
}

/** Format an agent's lifetime token total, or "" when zero. */
function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}
/** Copy lifecycle ownership metadata before publishing it outside the manager. */
function snapshotOwner(owner: AgentOwner | undefined): AgentOwner | undefined {
  return owner ? Object.freeze({ ...owner }) : undefined;
}

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 * Used by both foreground and background paths to avoid duplication.
 */
function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
  const state: AgentActivity = {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns,
    responseText: "",
    session: undefined,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
  };

  const callbacks = {
    onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
      if (activity.type === "start") {
        state.activeTools.set(
          activity.toolName + "_" + Date.now(),
          activity.toolName,
        );
      } else {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) {
            state.activeTools.delete(key);
            break;
          }
        }
        state.toolUses++;
      }
      onStreamUpdate?.();
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
      onStreamUpdate?.();
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
      onStreamUpdate?.();
    },
    onSessionCreated: (session: any) => {
      state.session = session;
    },
    onAssistantUsage: (usage: {
      input: number;
      output: number;
      cacheWrite: number;
    }) => {
      addUsage(state.lifetimeUsage, usage);
      onStreamUpdate?.();
    },
  };

  return { state, callbacks };
}

/**
 * Advertised thinking levels, ordered to mirror pi-ai's EXTENDED_THINKING_LEVELS
 * (`off` + every `ThinkingLevel`). Single source for the Agent tool description,
 * the generated-agent template, and the `/agents` wizard so these lists can't
 * drift behind pi again (#147). Availability of any level still depends on the
 * host pi version and the selected model — pi clamps unsupported levels down.
 */
/** Agent-detail menu entry for the model-assisted rewrite. Named once so the
 *  option string and the branch that handles it cannot drift apart. */
const REFINE_CHOICE = "Refine with Claude";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Human-readable status label for agent completion. */
function getStatusLabel(status: string, error?: string): string {
  switch (status) {
    case "error":
      return `Error: ${error ?? "unknown"}`;
    case "aborted":
      return "Aborted (max turns exceeded)";
    case "steered":
      return "wrapped up · turn limit";
    case "stopped":
      return "Stopped";
    default:
      return "Done";
  }
}

/** Escape XML special characters to prevent injection in structured notifications. */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Format a structured task notification matching Claude Code's <task-notification> XML. */
function formatTaskNotification(
  record: AgentRecord,
  resultMaxLen: number,
): string {
  const status = getStatusLabel(record.status, record.error);
  const durationMs = record.completedAt
    ? record.completedAt - record.startedAt
    : 0;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const contextPercent = getSessionContextPercent(record.session);
  const ctxXml =
    contextPercent !== null
      ? `<context_percent>${Math.round(contextPercent)}</context_percent>`
      : "";
  const compactXml = record.compactionCount
    ? `<compactions>${record.compactionCount}</compactions>`
    : "";

  const resultPreview = record.result
    ? record.result.length > resultMaxLen
      ? record.result.slice(0, resultMaxLen) +
        "\n...(truncated, use get_subagent_result for full output)"
      : record.result
    : "No output.";

  return [
    `<task-notification>`,
    `<task-id>${record.id}</task-id>`,
    record.toolCallId
      ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>`
      : null,
    record.outputFile
      ? `<output-file>${escapeXml(record.outputFile)}</output-file>`
      : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Agent "${escapeXml(record.description)}" ${record.status}${getStatusNote(record.status)}</summary>`,
    `<result>${escapeXml(resultPreview)}</result>`,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses>${ctxXml}${compactXml}<duration_ms>${durationMs}</duration_ms></usage>`,
    `</task-notification>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Build AgentDetails from a base + record-specific fields. */
function buildDetails(
  base: Pick<
    AgentDetails,
    "displayName" | "description" | "subagentType" | "modelName" | "tags"
  >,
  record: {
    toolUses: number;
    startedAt: number;
    completedAt?: number;
    status: string;
    error?: string;
    id?: string;
    session?: any;
    lifetimeUsage: LifetimeUsage;
  },
  activity?: AgentActivity,
  overrides?: Partial<AgentDetails>,
): AgentDetails {
  return {
    ...base,
    toolUses: record.toolUses,
    tokens: formatLifetimeTokens(record),
    turnCount: activity?.turnCount,
    maxTurns: activity?.maxTurns,
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    status: record.status as AgentDetails["status"],
    agentId: record.id,
    error: record.error,
    ...overrides,
  };
}

/** Build notification details for the custom message renderer. */
function buildNotificationDetails(
  record: AgentRecord,
  resultMaxLen: number,
  activity?: AgentActivity,
): NotificationDetails {
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);

  return {
    id: record.id,
    description: record.description,
    status: record.status,
    toolUses: record.toolUses,
    turnCount: activity?.turnCount ?? 0,
    maxTurns: activity?.maxTurns,
    totalTokens,
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    outputFile: record.outputFile,
    error: record.error,
    resultPreview: record.result
      ? record.result.length > resultMaxLen
        ? record.result.slice(0, resultMaxLen) + "..."
        : record.result
      : "No output.",
  };
}

/** Format built-in tool scope without conflating absent, empty, and extension-only agents. */
export function formatToolsSuffix(cfg: AgentConfig | undefined): string {
  const tools = cfg?.builtinToolNames;
  if (!tools) return "*";
  if (tools.length === 0) {
    const noExtensionTools =
      cfg?.isolated === true || cfg?.extensions === false;
    return noExtensionTools ? "none" : "no built-ins, extension tools only";
  }
  const isFullSet =
    tools.length === BUILTIN_TOOL_NAMES.length &&
    BUILTIN_TOOL_NAMES.every((tool) => tools.includes(tool));
  return isFullSet ? "*" : tools.join(", ");
}

interface RootRuntime {
  onSessionStart: (
    event: { reason?: string },
    ctx: ExtensionContext,
  ) => Promise<void>;
}

export default function (pi: ExtensionAPI): void {
  const childSession = inChildSessionContext();
  if (childSession) {
    // Child sessions keep the existing scoped-context responder and do not
    // construct a second root manager or expose root tools.
    const unsubscribeChildContext = registerChildContextHandler(
      pi.events,
      true,
    );
    pi.on("session_shutdown", () => unsubscribeChildContext());
    return;
  }

  // Root sessions answer the same factory-time context query as child sessions,
  // but advertise the root-side capability explicitly. This is safe before
  // session_start and is removed on validation failure or root shutdown.
  const unsubscribeRootContextRegistration = registerChildContextHandler(
    pi.events,
    false,
  );
  let rootContextUnsubscribed = false;
  const unsubscribeRootContext = (): void => {
    if (rootContextUnsubscribed) return;
    rootContextUnsubscribed = true;
    unsubscribeRootContextRegistration();
  };

  // Pi invokes factories before it knows which session cwd and extension
  // filter will bind. Keep this bootstrap handler as the only root side effect
  // until the first real session_start supplies the authoritative ctx.cwd.
  let rootRuntime: RootRuntime | undefined;
  let inert = false;
  pi.on("session_start", async (event, ctx) => {
    if (inert) return;
    if (!rootRuntime) {
      try {
        const startupSettings = loadSettings(ctx.cwd);
        const startupAgents = loadCustomAgents(
          ctx.cwd,
          startupSettings.strictAgentFiles === true,
        );
        rootRuntime = activateRootRuntime(
          pi,
          startupSettings,
          startupAgents,
          ctx.cwd,
          unsubscribeRootContext,
        );
      } catch (error: unknown) {
        // No root runtime has been created yet, so validation failure leaves no
        // responder/tool/manager side effect behind. The bootstrap itself stays
        // inert for the lifetime of this activation.
        unsubscribeRootContext();
        inert = true;
        throw error;
      }
    }
    await rootRuntime.onSessionStart(event, ctx);
  });
}

function activateRootRuntime(
  pi: ExtensionAPI,
  startupSettings: SubagentsSettings,
  startupAgents: Map<string, AgentConfig>,
  initialCwd: string,
  unsubscribeRootContext: () => void,
): RootRuntime {
  let sessionCwd = initialCwd;
  let strictAgentFiles = startupSettings.strictAgentFiles === true;

  // ---- Register custom notification renderer ----
  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, { expanded }, theme) => {
      const d = message.details;
      if (!d) return undefined;

      function renderOne(d: NotificationDetails): string {
        const statusText = getAgentStatusLabel(d.status);
        const statusColor = getAgentStatusColor(d.status);

        let line = `${theme.bold(sanitizeDisplayText(d.description))} ${theme.fg("dim", "·")} ${theme.fg(statusColor, statusText)}`;

        const parts: string[] = [];
        if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
        if (d.toolUses > 0) parts.push(`tools ${d.toolUses}`);
        if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
        if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
        if (parts.length) {
          line += `\n  ${parts.map((p) => theme.fg("dim", p)).join(theme.fg("dim", " · "))}`;
        }

        // The preview is the child's own words, drawn straight into the parent
        // transcript by a renderer that preserves ANSI.
        const resultPreview = safeTerminalText(d.resultPreview);
        if (expanded) {
          const lines = resultPreview.split("\n").slice(0, 30);
          for (const l of lines) line += `\n  ${theme.fg("dim", l)}`;
        } else {
          const preview = truncateCodePoints(
            sanitizeDisplayText(resultPreview.split("\n")[0] ?? ""),
            80,
            "",
          );
          line += `\n  ${theme.fg("dim", preview)}`;
        }

        if (d.outputFile) {
          line += `\n  ${theme.fg("muted", `transcript: ${sanitizeDisplayText(d.outputFile)}`)}`;
        }

        return line;
      }

      const all = [d, ...(d.others ?? [])];
      return new Text(all.map(renderOne).join("\n"), 0, 0);
    },
  );

  /** Reload agents from project/global custom agent dirs and merge with defaults (called on init and each Agent invocation). */
  const reloadCustomAgents = (strict = false) => {
    const userAgents = loadCustomAgents(sessionCwd, strict);
    registerAgents(userAgents);
  };

  // Register the already-validated startup map. A bad edit mid-session must not
  // kill the session on the next unrelated spawn, so every later reload warns.
  if (startupAgents) registerAgents(startupAgents);

  // ---- Agent activity tracking ----
  const agentActivity = new Map<string, AgentActivity>();

  // ---- Cancellable pending notifications ----
  // Holds notifications briefly so get_subagent_result can cancel them
  // before they reach pi.sendMessage (fire-and-forget).
  const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();
  const NUDGE_HOLD_MS = 200;
  // A queued result wait must observe completion before its held notification
  // can fire, so successful waits can still suppress that redundant nudge.
  const QUEUE_WAIT_POLL_MS = Math.floor(NUDGE_HOLD_MS / 4);

  function scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS) {
    cancelNudge(key);
    pendingNudges.set(
      key,
      setTimeout(() => {
        pendingNudges.delete(key);
        try {
          send();
        } catch {
          /* ignore stale completion side-effect errors */
        }
      }, delay),
    );
  }

  function cancelNudge(key: string) {
    const timer = pendingNudges.get(key);
    if (timer != null) {
      clearTimeout(timer);
      pendingNudges.delete(key);
    }
  }

  // ---- Individual nudge helper (async join mode) ----
  function emitIndividualNudge(record: AgentRecord) {
    if (record.resultConsumed) return; // re-check at send time

    const notification = formatTaskNotification(record, 500);
    const footer = record.outputFile
      ? `\nFull transcript available at: ${record.outputFile}`
      : "";

    pi.sendMessage<NotificationDetails>(
      {
        customType: "subagent-notification",
        content: notification + footer,
        display: true,
        details: buildNotificationDetails(
          record,
          500,
          agentActivity.get(record.id),
        ),
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }

  function sendIndividualNudge(record: AgentRecord) {
    agentActivity.delete(record.id);
    fleet.onAgentFinished(record.id);
    scheduleNudge(record.id, () => emitIndividualNudge(record));
  }

  // ---- Group join manager ----
  const groupJoin = new GroupJoinManager((records, partial) => {
    for (const r of records) {
      agentActivity.delete(r.id);
      fleet.onAgentFinished(r.id);
    }

    const groupKey = `group:${records.map((r) => r.id).join(",")}`;
    scheduleNudge(groupKey, () => {
      // Re-check at send time
      const unconsumed = records.filter((r) => !r.resultConsumed);
      if (unconsumed.length === 0) {
        fleet.update();
        return;
      }

      const notifications = unconsumed
        .map((r) => formatTaskNotification(r, 300))
        .join("\n\n");
      const label = partial
        ? `${unconsumed.length} agent(s) finished (partial — others still running)`
        : `${unconsumed.length} agent(s) finished`;

      const [first, ...rest] = unconsumed;
      const details = buildNotificationDetails(
        first,
        300,
        agentActivity.get(first.id),
      );
      if (rest.length > 0) {
        details.others = rest.map((r) =>
          buildNotificationDetails(r, 300, agentActivity.get(r.id)),
        );
      }

      pi.sendMessage<NotificationDetails>(
        {
          customType: "subagent-notification",
          content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
          display: true,
          details,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    });
    fleet.update();
  }, 30_000);

  /** Helper: build event data for lifecycle events from an AgentRecord. */
  function buildEventData(record: AgentRecord) {
    const durationMs = record.completedAt
      ? record.completedAt - record.startedAt
      : Date.now() - record.startedAt;
    // All three fields are lifetime-accumulated (Σ over every assistant message_end),
    // so they survive compaction together — input + output ≤ total always.
    // tokens is omitted when nothing was ever produced (e.g. agent errored before
    // any message_end fired), preserving prior payload shape.
    const u = record.lifetimeUsage;
    const total = getLifetimeTotal(u);
    const tokens =
      total > 0 ? { input: u.input, output: u.output, total } : undefined;
    return {
      id: record.id,
      type: record.type,
      description: record.description,
      result: record.result,
      error: record.error,
      status: record.status,
      toolUses: record.toolUses,
      durationMs,
      tokens,
      ...(record.outputFile ? { outputFile: record.outputFile } : {}),
      ...(record.owner ? { owner: snapshotOwner(record.owner) } : {}),
    };
  }

  const PERSISTED_RECORD_TEXT_LIMIT = 8_000;
  const boundedPersistedText = (
    value: string | undefined,
  ): string | undefined => {
    if (!value) return undefined;
    if (value.length <= PERSISTED_RECORD_TEXT_LIMIT) return value;
    const marker = "\n…[truncated]";
    return `${value.slice(0, PERSISTED_RECORD_TEXT_LIMIT - marker.length)}${marker}`;
  };

  function managedRecoveryEventData(tombstone: ManagedSpawnTombstone) {
    const terminal = tombstone.terminal;
    const failed = tombstone.state !== "completed";
    return {
      id: tombstone.id,
      type: tombstone.type,
      description: tombstone.description,
      status:
        tombstone.state === "interrupted"
          ? "interrupted"
          : failed
            ? "error"
            : "completed",
      result: terminal?.result,
      error: terminal?.error,
      durationMs: terminal
        ? Math.max(0, terminal.completedAt - tombstone.createdAt)
        : 0,
      ...(terminal?.outputFile ? { outputFile: terminal.outputFile } : {}),
      ...(terminal?.tokenCount
        ? { tokens: { total: terminal.tokenCount } }
        : {}),
      owner: snapshotOwner(tombstone.owner),
    };
  }

  function persistRecoveredManaged(tombstone: ManagedSpawnTombstone): void {
    const terminal = tombstone.terminal;
    if (!terminal) return;
    const eventData = managedRecoveryEventData(tombstone);
    if (tombstone.state === "completed")
      pi.events.emit("subagents:completed", eventData);
    else pi.events.emit("subagents:failed", eventData);
    pi.appendEntry("subagents:record", {
      id: tombstone.id,
      type: tombstone.type,
      description: tombstone.description,
      status: eventData.status,
      result: boundedPersistedText(terminal.result),
      error: boundedPersistedText(terminal.error),
      startedAt: tombstone.createdAt,
      completedAt: terminal.completedAt,
      compactionCount: terminal.compactionCount,
      ...(terminal.outputFile ? { outputFile: terminal.outputFile } : {}),
      ...(terminal.tokenCount ? { tokens: terminal.tokenCount } : {}),
      owner: snapshotOwner(tombstone.owner),
    });
  }

  // Background completion: route through group join or send individual nudge
  /**
   * Session-cumulative usage per agent type, for the `/agents → Usage` summary.
   *
   * Not derived from live records on demand: they are evicted ten minutes after
   * they finish, so a scan of the manager answers "the last ten minutes", not
   * "this session" — and the agents that cost the most are exactly the
   * long-finished ones a scan would have dropped. Accumulated on the terminal
   * callback instead, which every record passes through exactly once.
   *
   * Nested children are counted too, under their own type: they spend real
   * tokens, and attributing them to the parent would hide where a fan-out went.
   */
  const sessionUsageByType = new Map<
    string,
    { runs: number; usage: LifetimeUsage }
  >();
  function recordSessionUsage(record: AgentRecord): void {
    const entry = sessionUsageByType.get(record.type) ?? {
      runs: 0,
      usage: { input: 0, output: 0, cacheWrite: 0 },
    };
    entry.runs++;
    addUsage(entry.usage, record.lifetimeUsage);
    sessionUsageByType.set(record.type, entry);
  }

  const manager = new AgentManager(
    (record) => {
      if (!record.detached) recordSessionUsage(record);
      // Nested children report only through their owning parent's scoped tools.
      // Keep them out of top-level lifecycle, transcript, notification, and UI channels.
      if (record.parentAgentId || record.detached) return;

      // Emit lifecycle event based on terminal status
      const isError =
        record.status === "error" ||
        record.status === "stopped" ||
        record.status === "aborted";
      const eventData = buildEventData(record);
      if (isError) {
        pi.events.emit("subagents:failed", eventData);
      } else {
        pi.events.emit("subagents:completed", eventData);
      }

      // Persist final record for cross-extension history reconstruction
      pi.appendEntry("subagents:record", {
        id: record.id,
        type: record.type,
        description: record.description,
        status: record.status,
        result: boundedPersistedText(record.result),
        error: boundedPersistedText(record.error),
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        compactionCount: record.compactionCount,
        ...(record.outputFile ? { outputFile: record.outputFile } : {}),
        ...(record.lifetimeUsage.input + record.lifetimeUsage.output > 0
          ? { tokens: record.lifetimeUsage.input + record.lifetimeUsage.output }
          : {}),
        ...(record.owner ? { owner: snapshotOwner(record.owner) } : {}),
      });

      // Managed workflow agents are consumed by their owner through lifecycle
      // events. Suppress only their automatic main-session nudge/group message.
      if (record.owner) {
        agentActivity.delete(record.id);
        fleet.onAgentFinished(record.id);
        return;
      }

      // Skip notification if result was already consumed via get_subagent_result
      if (record.resultConsumed) {
        agentActivity.delete(record.id);
        fleet.onAgentFinished(record.id);
        return;
      }

      // If this agent is pending batch finalization (debounce window still open),
      // don't send an individual nudge — finalizeBatch will pick it up retroactively.
      if (currentBatchAgents.some((a) => a.id === record.id)) {
        fleet.update();
        return;
      }

      const result = groupJoin.onAgentComplete(record);
      if (result === "pass") {
        sendIndividualNudge(record);
      }
      // 'held' → do nothing, group will fire later
      // 'delivered' → group callback already fired
      fleet.update();
    },
    undefined,
    (record) => {
      if (record.parentAgentId || record.detached) return;
      // A queued spawn is only drawn by onCreated; this covers the transition to
      // running for anything that entered through the manager directly.
      refreshAgentSurfaces();
      // Emit started event when agent transitions to running (including from queue)
      pi.events.emit("subagents:started", {
        id: record.id,
        type: record.type,
        description: record.description,
        ...(record.owner ? { owner: snapshotOwner(record.owner) } : {}),
      });
    },
    (record, info) => {
      if (record.parentAgentId || record.detached) return;
      // Emit compacted event when agent's session compacts (preserves count on record).
      pi.events.emit("subagents:compacted", {
        id: record.id,
        type: record.type,
        description: record.description,
        reason: info.reason,
        tokensBefore: info.tokensBefore,
        compactionCount: record.compactionCount,
        ...(record.owner ? { owner: snapshotOwner(record.owner) } : {}),
      });
    },
    (record) => {
      if (record.parentAgentId || record.detached) return;
      refreshAgentSurfaces();
      // The created payload names an owner, so only owned spawns can announce one.
      if (!record.owner) return;
      pi.events.emit("subagents:created", {
        id: record.id,
        type: record.type,
        description: record.description,
        isBackground: record.isBackground,
        owner: snapshotOwner(record.owner),
      });
    },
    {
      append: (tombstone) =>
        pi.appendEntry(MANAGED_SPAWN_ENTRY_TYPE, tombstone),
    },
  );

  // Expose the validated root manager via Symbol.for() for cross-package access.
  // The runtime is created only after session_start supplies ctx.cwd and strict
  // custom-agent validation succeeds. A filtered-out activation never reaches
  // this runtime, so it cannot reserve the managed RPC responder or manager.
  const MANAGER_KEY = Symbol.for("pi-subagents:manager");
  // Process-external callers may supply arbitrary options. Nested ownership and
  // config-root metadata are internal capabilities issued only by scoped tools.
  const spawnTopLevel = (
    piRef: any,
    ctxRef: any,
    type: string,
    prompt: string,
    options: any,
  ) => {
    const safeOptions = { ...(options ?? {}) };
    delete safeOptions.parentAgentId;
    delete safeOptions.depth;
    delete safeOptions.maxSubagentDepth;
    delete safeOptions.configCwd;
    // Also internal: it names a transcript directory, so a forged value would
    // be a path-traversal primitive.
    delete safeOptions.rootSessionId;
    // Ownership is an internal capability. Legacy RPC/registry spawns may not
    // forge workflow metadata; only the validated spawn-managed handler adds it.
    delete safeOptions.owner;
    // Cross-extension callers get the same dispatch contract as the LLM (#183).
    // The RPC layer already throws for an unresolvable model rather than falling
    // back silently; a bad agent type should not be quieter. Throws become error
    // envelopes at the RPC boundary. Reload first so an agent file added mid
    // session is spawnable here too, not only through the Agent tool.
    reloadCustomAgents();
    const dispatch = resolveSpawnType(type);
    if (!dispatch.ok) throw new Error(dispatch.message);
    return manager.spawn(piRef, ctxRef, dispatch.type, prompt, safeOptions);
  };
  const MANAGER_ACTIVE_KEY = Symbol.for("pi-subagents:manager-active");
  const RPC_OWNER_KEY = Symbol.for("pi-subagents:rpc-owner");
  const MANAGER_CONTROL_KEY = Symbol.for("pi-subagents:manager-control");

  const MANAGER_TAKEOVER_LOCK_KEY = Symbol.for(
    "pi-subagents:manager-takeover-lock",
  );
  const withManagerTakeoverLock = async <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    const globalRegistry = globalThis as any;
    const predecessor =
      (globalRegistry[MANAGER_TAKEOVER_LOCK_KEY] as
        | Promise<void>
        | undefined) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.catch(() => undefined).then(() => gate);
    globalRegistry[MANAGER_TAKEOVER_LOCK_KEY] = tail;
    await predecessor.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (globalRegistry[MANAGER_TAKEOVER_LOCK_KEY] === tail) {
        Reflect.deleteProperty(globalRegistry, MANAGER_TAKEOVER_LOCK_KEY);
      }
    }
  };
  let boundSessionId: string | undefined;
  let retireRuntime: () => Promise<void> = async () => {};
  const registryEntry = {
    waitForAll: () => manager.waitForAll(),
    hasRunning: () => manager.hasRunning(),
    spawn: spawnTopLevel,
    getRecord: (id: string) => {
      const record = manager.getRecord(id);
      return record?.parentAgentId || record?.detached ? undefined : record;
    },
    [MANAGER_CONTROL_KEY]: {
      getSessionId: () => boundSessionId,
      isLive: () => currentCtx !== undefined,
      retire: () => retireRuntime(),
    },
  };
  let ownsManagerRegistry = (globalThis as any)[MANAGER_KEY] === undefined;
  if (ownsManagerRegistry) {
    (globalThis as any)[MANAGER_KEY] = registryEntry;
  }
  let ownsRpcRegistry = false;
  const claimRpcRegistry = async (
    ctx: ExtensionContext,
    allowLiveTakeover: boolean,
  ): Promise<void> => {
    await withManagerTakeoverLock(async () => {
      const currentOwner = (globalThis as any)[RPC_OWNER_KEY];
      const activeOwner = (globalThis as any)[MANAGER_ACTIVE_KEY];
      const contenders = [...new Set([currentOwner, activeOwner])].filter(
        (entry) => entry !== undefined && entry !== registryEntry,
      );
      const incomingSessionId = ctx.sessionManager?.getSessionId?.();

      for (const contender of contenders) {
        const control = (contender as any)?.[MANAGER_CONTROL_KEY] as
          | {
              getSessionId?: () => string | undefined;
              isLive?: () => boolean;
              retire?: () => Promise<void>;
            }
          | undefined;
        const contenderSessionId = control?.getSessionId?.();
        const contenderIsLive = control?.isLive?.();
        // A live different-session owner is a child/parallel activation and stays
        // authoritative. Inactive owners are stale and reclaimable. Pi's explicit
        // reload reason permits same-session handoff after an unclean old runtime;
        // unrelated duplicate activations cannot evict a healthy root.
        if (
          contenderIsLive !== false &&
          contenderSessionId &&
          contenderSessionId !== incomingSessionId
        )
          return;
        if (!allowLiveTakeover && contenderIsLive !== false) return;
        await control?.retire?.();
      }

      (globalThis as any)[MANAGER_KEY] = registryEntry;
      ownsManagerRegistry = true;
      (globalThis as any)[MANAGER_ACTIVE_KEY] = registryEntry;
      (globalThis as any)[RPC_OWNER_KEY] = registryEntry;
      ownsRpcRegistry = true;
    });
  };

  // --- Cross-extension RPC via pi.events ---
  let currentCtx: ExtensionContext | undefined;
  // RPC handlers + the `subagents:ready` broadcast are wired on `session_start`
  // (a bound lifecycle event), not at factory time. pi runs every extension
  // factory before the `extensions:` filter and only fires lifecycle events for
  // survivors, so a child session that filtered pi-subagents out never reaches
  // session_start — and must not advertise or answer RPC it can't service
  // (currentCtx would stay undefined → spawn always "No active session"). Gating
  // here makes a filtered session behave like an absent one (#142).
  let rpcHandle: RpcHandle | undefined;

  // ---- Subagent scheduler ----
  // Session-scoped: store is constructed inside session_start once sessionId
  // is available. Mirrors pi-chonky-tasks's session-scoped task store —
  // schedules reset on /new, restore on /resume.
  const scheduler = new SubagentScheduler();

  function startScheduler(ctx: ExtensionContext) {
    try {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (!sessionId) return; // sessionId not yet available — try again on next event
      const path = resolveStorePath(ctx.cwd, sessionId);
      const store = new ScheduleStore(path);
      scheduler.start(pi, ctx, manager, store);
      pi.events.emit("subagents:scheduler_ready", {
        sessionId,
        jobCount: store.list().length,
      });
    } catch (err) {
      // Scheduling is non-essential — log and move on so the rest of the
      // extension keeps working if e.g. .pi/ is unwritable.
      console.warn("[pi-subagents] Failed to start scheduler:", err);
    }
  }

  // The bootstrap session_start handler calls this after validation/activation.
  // Subsequent session replacements reuse the same registered runtime and keep
  // RPC/manager ownership idempotent.
  async function initializeSession(
    event: { reason?: string },
    ctx: ExtensionContext,
  ): Promise<void> {
    sessionCwd = ctx.cwd;
    boundSessionId = ctx.sessionManager?.getSessionId?.();
    currentCtx = ctx;
    await claimRpcRegistry(ctx, event.reason === "reload");
    const sessionEntries =
      typeof ctx.sessionManager.getBranch === "function"
        ? ctx.sessionManager.getBranch()
        : [];
    const recovered = manager.restoreManagedSpawns(
      sessionEntries as unknown as ManagedSpawnEntryLike[],
    );
    manager.clearCompleted(true);
    for (const tombstone of recovered) persistRecoveredManaged(tombstone);
    if (ownsRpcRegistry && !rpcHandle) {
      rpcHandle = registerRpcHandlers({
        events: pi.events,
        pi,
        getCtx: () => currentCtx,
        manager: {
          spawn: spawnTopLevel,
          spawnManaged: (piRef, ctxRef, request) =>
            spawnManagedWithUi(
              piRef as ExtensionAPI,
              ctxRef as ExtensionContext,
              request,
            ),
          abort: (id) => {
            const record = manager.getRecordMutable(id);
            // Legacy stop is intentionally limited to unowned top-level records.
            // Workflow-owned descendants remain reachable only through their
            // owner-scoped controls.
            return (
              !!record &&
              !record.owner &&
              !record.parentAgentId &&
              manager.abort(id)
            );
          },
          abortOwned: (id, owner) => manager.abortOwned(id, owner),
          quiesceOwned: (runId, agentIds, timeoutMs, owners) =>
            manager.quiesceOwned(runId, agentIds, timeoutMs, owners),
          reconcileManaged: (spawnKey, owner) => manager.reconcileManaged(spawnKey, owner),
        },
      });
      // Emit only after RPC handlers are armed, and only for a bound session.
      pi.events.emit("subagents:ready", {
        version: PROTOCOL_VERSION,
        capabilities: PROTOCOL_CAPABILITIES,
      });
    }
    // `@` completion for agent handles. Registered at most ONCE for the
    // lifetime of this activation: `addAutocompleteProvider` wraps whatever
    // provider is current, and pi never unregisters a wrapper — registering
    // again on the next session_start would stack a second wrapper on top of
    // the first, and every one after that another.
    //
    // Guarded like `seatFleet`: an editor to complete into is a TUI-only
    // affordance, and a `ui` object without the method is a normal shape for a
    // print-mode, RPC, or programmatic context. Registration is best-effort —
    // the dispatcher works without the popup, so a host that cannot take a
    // provider must not take session startup down with it. The flag is set only
    // after a call that returned, so a failure leaves the next session free to
    // retry rather than permanently marking it registered.
    const addProvider = (
      ctx.ui as {
        addAutocompleteProvider?: (
          factory: AutocompleteProviderFactory,
        ) => void;
      }
    ).addAutocompleteProvider;
    if (
      ctx.mode === "tui" &&
      !mentionProviderRegistered &&
      typeof addProvider === "function"
    ) {
      try {
        addProvider.call(ctx.ui, (current) =>
          createMentionProvider(
            current,
            () =>
              mentionRoster(
                manager,
                getAvailableTypes().map((name) => ({
                  name,
                  description: getAgentConfig(name)?.description ?? name,
                })),
                (type) => getDisplayName(type),
              ),
            isAgentMentionsEnabled,
          ),
        );
        mentionProviderRegistered = true;
      } catch {
        /* the popup is optional; `@handle message` still dispatches without it */
      }
    }
    if (ownsRpcRegistry && isSchedulingEnabled() && !scheduler.isActive())
      startScheduler(ctx);
  }

  pi.on("session_before_switch", async () => {
    currentCtx = undefined;
    scheduler.stop();
    const quiesced = await manager.quiesceAll(5_000);
    if (!quiesced.settled) manager.detachForBranchChange();
    manager.clearCompleted(true);
    manager.resetManagedSpawns();
  });

  // Tree navigation keeps the same root session but replaces its active branch.
  // Stop-and-wait happens before lifecycle suspension so workflow consumers can
  // journal terminal callbacks on the old branch. A timeout is conservative:
  // records are detached on session_tree and late completions cannot write into
  // the replacement branch.
  pi.on("session_before_tree", async () => {
    currentCtx = undefined;
    scheduler.stop();
    pi.events.emit("subagents:session_before_tree", {});
    const quiesced = await manager.quiesceAll(5_000);
    if (!quiesced.settled) {
      // waitForTerminalRecords quarantines timed-out records, and this second
      // guard covers handler-order races where tree preparation is delivered
      // after an abort but before the provider promise has settled.
      manager.detachForBranchChange();
      // The manager retains pending records and recovery state; avoid writing
      // directly to the teardown event loop.
    }
  });
  pi.on("session_tree", (_event, ctx) => {
    currentCtx = ctx;
    manager.abortAll();
    manager.detachForBranchChange();
    manager.clearCompleted(true);
    manager.resetManagedSpawns();
    const entries =
      typeof ctx.sessionManager.getBranch === "function"
        ? ctx.sessionManager.getBranch()
        : [];
    const recovered = manager.restoreManagedSpawns(
      entries as unknown as ManagedSpawnEntryLike[],
      { dropActive: true },
    );
    manager.clearCompleted(true);
    for (const tombstone of recovered) persistRecoveredManaged(tombstone);
    if (isSchedulingEnabled() && !scheduler.isActive()) startScheduler(ctx);
  });

  // Shutdown is idempotent and also serves same-session hot-reload handoff. The
  // replacement waits for the stale responder/manager to retire before claiming
  // the global registry, so no dead wrapper or duplicate RPC responder survives.
  let runtimeShutdown: Promise<void> | undefined;
  const shutdownRuntime = (): Promise<void> => {
    runtimeShutdown ??= (async () => {
      unsubscribeRootContext();
      rpcHandle?.unsubSpawn();
      rpcHandle?.unsubSpawnManaged();
      rpcHandle?.unsubStop();
      rpcHandle?.unsubStopOwned();
      rpcHandle?.unsubQuiesce();
      rpcHandle?.unsubReconcile();
      rpcHandle?.unsubPing();
      rpcHandle = undefined;
      currentCtx = undefined;
      boundSessionId = undefined;
      // Only release a global slot still owned by this activation. A stale
      // shutdown delivered after replacement must not delete the new entry.
      if (
        ownsManagerRegistry &&
        (globalThis as any)[MANAGER_KEY] === registryEntry
      ) {
        delete (globalThis as any)[MANAGER_KEY];
      }
      if (
        ownsRpcRegistry &&
        (globalThis as any)[MANAGER_ACTIVE_KEY] === registryEntry
      ) {
        delete (globalThis as any)[MANAGER_ACTIVE_KEY];
      }
      if (
        ownsRpcRegistry &&
        (globalThis as any)[RPC_OWNER_KEY] === registryEntry
      ) {
        delete (globalThis as any)[RPC_OWNER_KEY];
      }
      scheduler.stop();
      manager.abortAll();
      for (const timer of pendingNudges.values()) clearTimeout(timer);
      pendingNudges.clear();
      fleet.dispose();
      await manager.dispose();
    })();
    return runtimeShutdown;
  };
  retireRuntime = shutdownRuntime;
  pi.on("session_shutdown", shutdownRuntime);

  // Claude Code-style FleetView: navigable list of main + subagents below the
  // editor, and the only place running agents are drawn. An above-editor widget
  // used to carry the same rows, with the same summary repeated again in the
  // footer status; one surface, below the prompt, replaces all three.
  const fleet = new FleetList(manager, agentActivity);
  let fleetViewEnabled = true;
  function isFleetViewEnabled(): boolean {
    return fleetViewEnabled;
  }
  function setFleetViewEnabled(b: boolean): void {
    fleetViewEnabled = b;
    fleet.setEnabled(b);
  }

  /**
   * Point the FleetView list at this context's UI, if there is one to draw on.
   *
   * The list needs more than a place to render: it takes over arrow keys
   * through `onTerminalInput` and opens an overlay on Enter, none of which
   * exists outside an interactive session. A print-mode or RPC context carries
   * a `ui` object without those methods, so seating unconditionally would throw
   * inside whatever called it — including the Agent tool's own execute.
   */
  function seatFleet(ctx: ExtensionContext): boolean {
    if (ctx.mode !== "tui" || !ctx.hasUI) return false;
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    return true;
  }

  /**
   * Redraw both agent surfaces for a spawn that arrived through the manager
   * rather than through a tool handler. The Agent tool and the managed RPC do
   * this themselves; the legacy RPC registry spawn and every scheduler fire do
   * not, and nothing else would ever draw them.
   */
  function refreshAgentSurfaces(): void {
    if (currentCtx?.mode !== "tui" || !currentCtx.hasUI) return;
    // The list otherwise holds whatever `tool_execution_start` last handed it,
    // which is the RETIRED session's UI after a switch and nothing at all in a
    // session that has not run a tool yet. Re-seat from the live context so the
    // guard and the draw target agree; the setter is idempotent.
    fleet.setUICtx(currentCtx.ui as unknown as FleetUICtx);
    // Arm the tickers after the draw, not before: both tear their own timer down
    // when they find nothing to show, and the fleet finds nothing until the child
    // session lands a moment later. A spawn that entered through the manager has
    // no activity callbacks to refresh it again, so this tick is its only way in.
    fleet.update();
    fleet.ensureTimer();
  }

  const splitManagedModelSpec = (spec: string): { model: string; thinking?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" } => {
    const separator = spec.lastIndexOf(":");
    const suffix = separator > spec.indexOf("/") ? spec.slice(separator + 1) : "";
    const thinking = ["minimal", "low", "medium", "high", "xhigh", "max"].includes(suffix)
      ? (suffix as "minimal" | "low" | "medium" | "high" | "xhigh" | "max")
      : undefined;
    return thinking ? { model: spec.slice(0, separator), thinking } : { model: spec };
  };
  /**
   * Add the same activity, transcript, and FleetView wiring used by Agent-tool
   * background runs without expanding the managed RPC's policy surface.
   */
  function spawnManagedWithUi(
    piRef: ExtensionAPI,
    ctxRef: ExtensionContext,
    request: ManagedSpawnRequest,
  ): ManagedSpawnResult {
    // Managed RPC is another caller-supplied spawn path: reload custom agents
    // and apply the exact same enabled/unknown/fallback resolver as Agent before
    // the manager can create a record. This is fail-closed when configured so a
    // workflow cannot bypass an agent's disabled state.
    reloadCustomAgents();
    const dispatch = resolveSpawnType(request.type);
    if (!dispatch.ok) throw new Error(dispatch.message);
    const workflowSettings = getWorkflowSettings();
    if (request.tier === undefined && workflowSettings.blockedDefaultTier) {
      throw new Error(
        "workflow defaultTier is blocked by malformed configuration",
      );
    }
    const effectiveTier = request.tier ?? workflowSettings.defaultTier;
    const normalizedRequest = {
      ...request,
      type: dispatch.type,
      ...(effectiveTier === undefined ? {} : { tier: effectiveTier }),
    };
    const customConfig = getAgentConfig(dispatch.type);
    const resolvedConfig = resolveAgentInvocationConfig(customConfig, {
      workflowTier: effectiveTier,
    });
    const requestedModel = request.model ? splitManagedModelSpec(request.model) : undefined;
    const requestedThinking = request.thinking === "off" ? undefined : request.thinking;
    const parentThinking = (() => {
      const level = (piRef as unknown as { getThinkingLevel?: () => unknown }).getThinkingLevel?.();
      return level === "minimal" || level === "low" || level === "medium" || level === "high" || level === "xhigh" || level === "max"
        ? level
        : undefined;
    })();
    const tierResolution = effectiveTier
      ? resolveWorkflowTier({
          tier: effectiveTier,
          agentConfig: customConfig,
          modelOverride: requestedModel?.model,
          thinkingOverride: requestedThinking,
          parentModel: ctxRef.model,
          parentThinking,
          modelRegistry: ctxRef.modelRegistry,
        })
      : undefined;
    const resolvedRequestedModel = requestedModel
      ? resolveModel(requestedModel.model, ctxRef.modelRegistry)
      : undefined;
    if (typeof resolvedRequestedModel === "string") throw new Error(resolvedRequestedModel);
    const modelInput = requestedModel?.model ?? resolvedConfig.modelInput;
    // An exact managed model is still checked by pi-subagents' model-scope policy;
    // workflows never bypass the host's enabled-model restrictions.
    if (effectiveTier === undefined || requestedModel !== undefined) {
      const model = resolvedRequestedModel ?? resolveConfiguredDefaultModel(ctxRef.modelRegistry) ?? ctxRef.model;
      const scopeVerdict = checkModelScope({
        model,
        cwd: ctxRef.cwd,
        modelRegistry: ctxRef.modelRegistry,
        callerSupplied: requestedModel !== undefined,
        agentLabel: customConfig?.displayName ?? dispatch.type,
        modelInput,
      });
      if (scopeVerdict.kind === "error") throw new Error(scopeVerdict.message);
      if (scopeVerdict.kind === "warn" && ctxRef.hasUI) ctxRef.ui.notify(scopeVerdict.message, "warning");
    }
    const effectiveMaxTurns = normalizeMaxTurns(
      resolvedConfig.maxTurns ?? getDefaultMaxTurns(),
    );
    const effectiveIsolation = request.isolation ?? resolvedConfig.isolation;
    const configuredModel =
      resolvedConfig.modelInput && resolvedConfig.modelInput !== "inherit"
        ? resolveModel(resolvedConfig.modelInput, ctxRef.modelRegistry)
        : undefined;
    const effectiveModel =
      resolvedRequestedModel ??
      tierResolution?.model ??
      (typeof configuredModel === "string" ? undefined : configuredModel) ??
      (effectiveTier === undefined ? resolveConfiguredDefaultModel(ctxRef.modelRegistry) ?? ctxRef.model : undefined);
    const effectiveExcludeTools = [...new Set([...(customConfig?.disallowedTools ?? []), ...(request.excludeTools ?? [])])];
    const managedPolicy: ManagedSpawnPolicy = {
      // The managed request may select an exact model, but resolution and scope
      // checks above remain owned by pi-subagents.
      model: effectiveModel,
      maxTurns: effectiveMaxTurns,
      isolated: resolvedConfig.isolated,
      inheritContext: resolvedConfig.inheritContext,
      thinkingLevel: (tierResolution?.thinkingLevel ?? requestedThinking ?? resolvedConfig.thinking ?? parentThinking ?? undefined) as "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined,
      isolation: effectiveIsolation,
      toolset: request.toolset,
      excludeTools: effectiveExcludeTools,
      policyFingerprint: JSON.stringify(customConfig ?? null),
      rootSessionId: ctxRef.sessionManager.getSessionId(),
      invocation: {
        tier: effectiveTier,
        maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
        isolated: resolvedConfig.isolated,
        inheritContext: resolvedConfig.inheritContext,
        runInBackground: true,
        isolation: effectiveIsolation,
      },
    };

    const { state, callbacks } = createActivityTracker(undefined, () => {
      fleet.update();
    });
    const outputTranscript =
      getAgentConfig(dispatch.type)?.outputTranscript ??
      getOutputTranscriptDefault();
    let id = "";
    const initializeRecord = (spawnedId: string): void => {
      id = spawnedId;
      agentActivity.set(id, state);
      const record = manager.getRecordMutable(id);
      if (record && outputTranscript) {
        record.outputFile = createOutputFilePath(
          ctxRef.cwd,
          id,
          ctxRef.sessionManager.getSessionId(),
        );
        writeInitialEntry(
          record.outputFile,
          id,
          normalizedRequest.prompt,
          ctxRef.cwd,
        );
      }
      fleet.ensureTimer();
      fleet.update();
    };
    const onSessionCreated = callbacks.onSessionCreated;
    const managedCallbacks = {
      ...callbacks,
      onSpawned: initializeRecord,
      onSessionCreated: (session: AgentSession) => {
        onSessionCreated(session);
        const record = manager.getRecordMutable(id);
        if (record?.outputFile) {
          record.outputCleanup = streamToOutputFile(
            session,
            record.outputFile,
            id,
            ctxRef.cwd,
          );
        }
      },
      onCompaction: () => {
        fleet.update();
      },
    };
    const managedResult = manager.spawnManaged(
      piRef,
      ctxRef,
      normalizedRequest,
      managedPolicy,
      managedCallbacks,
    );
    // Reused managed requests deliberately do not initialize a second tracker,
    // transcript, timer, or callback chain. The original Agent record owns all
    // first-class UI and streaming state.
    if (!managedResult.created) return managedResult;
    if (!id) {
      const record = manager.getRecordMutable(managedResult.id);
      if (record?.status === "queued" || record?.status === "running")
        initializeRecord(managedResult.id);
    }
    return managedResult;
  }

  // Project/global default for writing the subagent .output transcript lives in
  // output-file.ts (both spawn paths read it). A custom agent's
  // `output_transcript` frontmatter overrides it per spawn; when the frontmatter
  // is silent, this default applies. Read live at spawn time.

  // ---- `@handle message` prompt mentions ----
  // Claude Code's prompt mention, same grammar (see mention.ts). The handle
  // names the *agent*, not one process, so one syntax covers its whole
  // lifecycle: message it while it runs, resume it once it has finished, start
  // it if it never ran. Read live so `/agents → Settings` takes effect at once.
  let agentMentionMode: AgentMentionMode = "model";
  /**
   * The registered `Agent` tool, once it exists. The mention clone hands the
   * copy this exact tool so a clone-driven spawn is an ordinary top-level agent
   * owned by this activation. Undefined before registration, which the
   * dispatcher treats as "no clone available" and starts the agent directly.
   */
  let agentToolRef: ReturnType<typeof defineTool> | undefined;
  function getAgentMentionMode(): AgentMentionMode {
    return agentMentionMode;
  }
  function isAgentMentionsEnabled(): boolean {
    return agentMentionMode !== "off";
  }
  /** The `@` completion wrapper is installed once per activation — see below. */
  let mentionProviderRegistered = false;

  // ---- `contact_supervisor` ----
  // Whether a subagent may interrupt to ask its human a question. Read live at
  // spawn, so a change applies to agents started from now on.
  let supervisorQuestionsEnabled = true;
  function isSupervisorQuestionsEnabled(): boolean {
    return supervisorQuestionsEnabled;
  }

  /**
   * Start a top-level agent for a mention, with the same activity tracker,
   * transcript, and FleetView wiring an Agent-tool background run gets.
   *
   * `reclaim` and `resumeSessionFile` are the reopen path and are deliberately
   * not reachable from any caller-supplied surface: both values always come
   * from a resumable entry this extension wrote itself.
   */
  function spawnMention(
    ctxRef: ExtensionContext,
    type: SubagentType,
    prompt: string,
    opts: {
      description: string;
      reclaimHandle?: string;
      resumeSessionFile?: string;
    },
  ): string {
    const config = getAgentConfig(type);
    const resolved = resolveAgentInvocationConfig(config, {});
    const { state, callbacks } = createActivityTracker(undefined, () => {
      fleet.update();
    });
    // Same sole gate as every other spawn path: `record.outputFile` being set is
    // what every downstream consumer keys off, so an agent whose frontmatter
    // says `output_transcript: false` must not gain one by being mentioned.
    const outputTranscript =
      config?.outputTranscript ?? getOutputTranscriptDefault();
    let id = "";
    const spawnedId = manager.spawn(pi, ctxRef, type, prompt, {
      description: opts.description,
      maxTurns: normalizeMaxTurns(resolved.maxTurns ?? getDefaultMaxTurns()),
      isolated: resolved.isolated,
      inheritContext: resolved.inheritContext,
      isolation: resolved.isolation,
      isBackground: true,
      rootSessionId: ctxRef.sessionManager.getSessionId(),
      ...(opts.reclaimHandle === undefined
        ? {}
        : { reclaimHandle: opts.reclaimHandle }),
      ...(opts.resumeSessionFile === undefined
        ? {}
        : { resumeSessionFile: opts.resumeSessionFile }),
      invocation: {
        maxTurns: normalizeMaxTurns(resolved.maxTurns),
        isolated: resolved.isolated,
        inheritContext: resolved.inheritContext,
        runInBackground: true,
        isolation: resolved.isolation,
      },
      ...callbacks,
      onSpawned: (newId) => {
        id = newId;
        agentActivity.set(id, state);
        const record = manager.getRecordMutable(id);
        // A reopened conversation keeps writing the transcript it already has:
        // `ensureOutputFile` creates one only when absent, and streaming starts
        // after the turns already on disk instead of truncating them.
        if (record && outputTranscript) {
          record.outputFile = createOutputFilePath(
            ctxRef.cwd,
            id,
            ctxRef.sessionManager.getSessionId(),
          );
          if (opts.resumeSessionFile) ensureOutputFile(record.outputFile);
          else writeInitialEntry(record.outputFile, id, prompt, ctxRef.cwd);
        }
        fleet.ensureTimer();
        fleet.update();
      },
      onSessionCreated: (session) => {
        callbacks.onSessionCreated(session);
        const record = manager.getRecordMutable(id);
        if (record?.outputFile) {
          // A reopened session already holds every prior turn. Start the stream
          // after them so the transcript gains this run's turns instead of a
          // second copy of the whole conversation.
          const startIndex = opts.resumeSessionFile
            ? session.state.messages.length
            : undefined;
          record.outputCleanup = streamToOutputFile(
            session,
            record.outputFile,
            id,
            ctxRef.cwd,
            startIndex,
          );
        }
      },
    });
    return spawnedId;
  }

  // ---- Join mode configuration ----
  let defaultJoinMode: JoinMode = "smart";
  function getDefaultJoinMode(): JoinMode {
    return defaultJoinMode;
  }
  function setDefaultJoinMode(mode: JoinMode) {
    defaultJoinMode = mode;
  }

  // Master switch for the schedule subagent feature. Defaults to enabled.
  // Read once at extension init (before tool registration) so the Agent tool's
  // param schema reflects the persisted setting. Runtime toggles via /agents
  // → Settings short-circuit the menu entry + the execute-time addJob path
  // immediately, but the schema-level removal only takes effect on next
  // extension load (next pi session). Documented in CHANGELOG/README.
  let schedulingEnabled = true;
  function isSchedulingEnabled(): boolean {
    return schedulingEnabled;
  }
  function setSchedulingEnabled(b: boolean) {
    schedulingEnabled = b;
  }

  // ---- Disable default agents configuration ----
  // When enabled, the three hardcoded default agents (general-purpose, Explore,
  // Plan) are not registered. User-defined agents from project/global custom
  // agent dirs are completely unaffected — only DEFAULT_AGENTS are suppressed.
  // Defaults to false; opt-in via `/agents → Settings` or subagents.json.
  // State lives in agent-types.ts (isDefaultsDisabled) because registerAgents
  // needs it; this wrapper just re-registers after flipping it.
  function setDisableDefaultAgents(b: boolean): void {
    setDefaultsDisabled(b);
    reloadCustomAgents(); // re-register with new setting
  }

  // ---- Agent tool description mode ----
  // "full" (default) keeps the rich Claude Code-style description; "compact"
  // swaps in a ~75% smaller one for small/local models (#91). Read once at
  // tool registration — flipping it applies on the next pi session.
  let toolDescriptionMode: ToolDescriptionMode = "full";
  function getToolDescriptionMode(): ToolDescriptionMode {
    return toolDescriptionMode;
  }
  function setToolDescriptionMode(mode: ToolDescriptionMode): void {
    toolDescriptionMode = mode;
  }

  // ---- Batch tracking for smart join mode ----
  // Collects background agent IDs spawned in the current turn for smart grouping.
  // Uses a debounced timer: each new agent resets the 100ms window so that all
  // parallel tool calls (which may be dispatched across multiple microtasks by the
  // framework) are captured in the same batch.
  let currentBatchAgents: { id: string; joinMode: JoinMode }[] = [];
  let batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  let batchCounter = 0;

  /** Finalize the current batch: if 2+ smart-mode agents, register as a group. */
  function finalizeBatch() {
    batchFinalizeTimer = undefined;
    const batchAgents = [...currentBatchAgents];
    currentBatchAgents = [];

    const smartAgents = batchAgents.filter(
      (a) => a.joinMode === "smart" || a.joinMode === "group",
    );
    if (smartAgents.length >= 2) {
      const groupId = `batch-${++batchCounter}`;
      const ids = smartAgents.map((a) => a.id);
      groupJoin.registerGroup(groupId, ids);
      // Retroactively process agents that already completed during the debounce window.
      // Their onComplete fired but was deferred (agent was in currentBatchAgents),
      // so we feed them into the group now.
      for (const id of ids) {
        const record = manager.getRecordMutable(id);
        if (!record) continue;
        record.groupId = groupId;
        if (record.completedAt != null && !record.resultConsumed) {
          groupJoin.onAgentComplete(record);
        }
      }
    } else {
      // No group formed — send individual nudges for any agents that completed
      // during the debounce window and had their notification deferred.
      for (const { id } of batchAgents) {
        const record = manager.getRecordMutable(id);
        if (record?.completedAt != null && !record.resultConsumed) {
          sendIndividualNudge(record);
        }
      }
    }
  }

  // Grab UI context from the first tool execution and refresh the list, which
  // is what drops agents that finished during the previous turn.
  pi.on("tool_execution_start", async (_event, ctx) => {
    if (!seatFleet(ctx)) return;
    fleet.update();
  });

  /** Build the full type list text dynamically from available agents only. */
  const buildTypeListText = () => {
    const available = getAvailableTypes();

    return available
      .map((name) => {
        const cfg = getAgentConfig(name);
        const modelSuffix = cfg?.agentTier ? ` (tier: ${cfg.agentTier})` : "";
        const toolsSuffix = ` (Tools: ${formatToolsSuffix(cfg)})`;
        return `- ${name}: ${cfg?.description ?? name}${modelSuffix}${toolsSuffix}`;
      })
      .join("\n");
  };

  /** First sentence of an agent description — for the compact type list. */
  const firstSentence = (text: string): string => {
    const match = text.match(/^.*?[.!?](?=\s|$)/s);
    return (match ? match[0] : text).replace(/\s+/g, " ").trim();
  };

  /** Compact type list: one line per agent, first sentence only. */
  const buildCompactTypeListText = () =>
    getAvailableTypes()
      .map((name) => {
        const cfg = getAgentConfig(name);
        return `- ${name}: ${firstSentence(cfg?.description ?? name)} (Tools: ${formatToolsSuffix(cfg)})`;
      })
      .join("\n");

  /** Derive a short model label from a model string. */
  function getModelLabelFromConfig(model: string): string {
    // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6")
    const name = model.includes("/") ? model.split("/").pop()! : model;
    // Strip trailing date suffix (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
    return name.replace(/-\d{8}$/, "");
  }

  // Apply the already-validated session settings and emit the same lifecycle
  // event that the normal startup path exposes. Do not re-read process.cwd().
  applySettings(startupSettings, {
    setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
    setDefaultMaxTurns,
    setGraceTurns,
    setDefaultMaxTokens,
    setDefaultMaxToolCalls,
    setDefaultToolTimeout: (ms) => setDefaultToolTimeoutMs(ms),
    setDefaultJoinMode,
    setDefaultModel,
    setSchedulingEnabled,
    setScopeModels: setScopeModelsEnabled,
    setStrictAgentFiles: (enabled) => {
      strictAgentFiles = enabled;
    },
    setDisableDefaultAgents,
    setToolDescriptionMode,
    setFleetView: setFleetViewEnabled,
    setOutputTranscript: setOutputTranscriptDefault,
    setRememberAgents: (enabled) => manager.setRememberAgents(enabled),
    setAgentMentions: (enabled) => {
      agentMentionMode = enabled;
    },
    setSupervisorQuestions: (enabled) => {
      supervisorQuestionsEnabled = enabled;
      manager.setSupervisorQuestions(enabled);
    },
    setMaxSubagentDepth,
    setMaxSubagentSpawnsPerBranch: (n) =>
      manager.setMaxSubagentSpawnsPerBranch(n),
    setFallbackSubagent,
    setWorktreeIsolation: setWorktreeIsolationEnabled,
    setWorkflow: setWorkflowSettings,
    setAgentTiers: setAgentTiersSettings,
  });
  pi.events.emit("subagents:settings_loaded", { settings: startupSettings });

  // A tier that nothing defines is a typo, and the resolver would only reach it
  // on the first spawn that needs it — possibly minutes in, mid-task. Report it
  // now, while the fix is obvious and nothing has run.
  const tierReferenceProblems = findUnknownAgentTierReferences(
    getAgentTiersSettings(),
    new Map(
      getAvailableTypes()
        .map((name): [string, string | undefined] => [
          name,
          getAgentConfig(name)?.agentTier,
        ])
        .filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  );
  for (const problem of tierReferenceProblems) {
    console.warn(`[pi-subagents] ${problem}`);
  }

  /**
   * `@handle message` typed at the prompt addresses that agent instead of the
   * main model.
   *
   * Everything that isn't an agent mention falls through untouched, which is
   * what keeps `@src/foo.ts summarize this`, a bare `@handle`, and ordinary
   * prose working. A delivered mention costs no main-model turn; the answer
   * arrives through the ordinary completion notification either way.
   */
  pi.on("input", async (event, ctx) => {
    // Never hijack text the extension layer itself submitted (pi.sendMessage,
    // scheduled prompts) — only something a person typed can be a mention.
    if (event.source === "extension" || !isAgentMentionsEnabled())
      return { action: "continue" };
    // Claiming the turn is TUI only. `handled` returns from prompt() before any
    // turn starts, so headless (`pi -p "@explore …"`) would exit having printed
    // nothing, and `ctx.ui.notify` is a no-op there — the mention would answer
    // with silence. Outside the TUI the text goes to the main model unchanged,
    // exactly as it did before mentions existed.
    if (ctx.mode !== "tui") return { action: "continue" };

    const mention = parseMention(event.text);
    if (!mention) return { action: "continue" };

    // `@main` addresses the main conversation, never a subagent — the one name
    // `assignHandle` refuses to allocate. An explicit escape hatch for text
    // that would otherwise read as a mention, so the prefix is dropped and the
    // rest goes to the model with its attachments intact.
    if (isReservedHandle(mention.handle)) {
      return {
        action: "transform",
        text: mention.message,
        ...(event.images ? { images: event.images } : {}),
      };
    }

    // As typed first, so an agent actually called `agent-foo` wins over Claude
    // Code's `@agent-` + `foo` spelling rather than being shadowed by it.
    const alias = stripAgentPrefix(mention.handle);
    const resolved =
      manager.resolveMention(mention.handle) ??
      (alias ? manager.resolveMention(alias) : undefined);

    if (resolved?.kind === "live") {
      const record = resolved.record;
      const target = `@${record.handle ?? mention.handle}`;

      if (record.status === "running" || record.status === "queued") {
        // Steering interrupts after the current tool call, exactly like the
        // steer_subagent tool. Un-consume the result so the agent's reply to
        // this message is still relayed even if the LLM read its last answer.
        record.resultConsumed = false;
        manager.steer(record.id, mention.message);
        pi.events.emit("subagents:steered", {
          id: record.id,
          message: mention.message,
        });
        ctx.ui.notify(`Sent to ${target}`, "info");
        return { action: "handled" };
      }

      if (record.session) {
        const resumed = await manager.resume(
          record.id,
          mention.message,
          undefined,
          { isBackground: true },
        );
        ctx.ui.notify(
          resumed
            ? `Resuming ${target}`
            : `Could not resume ${target} — it is still running.`,
          resumed ? "info" : "warning",
        );
        return { action: "handled" };
      }
      // A live record with no session never got far enough to continue, so it
      // falls through to the start-fresh path below.
    }

    // Evicted, but its conversation is still on disk: reopen it. An ordinary
    // spawn carrying a session file, so the new record picks up the fleet row,
    // transcript, and completion notification unchanged — and `reclaimHandle`
    // hands it back the name the entry was holding.
    if (resolved?.kind === "resumable") {
      const entry = resolved.entry;
      const target = `@${entry.handle}`;

      // Checked here rather than left to SessionManager.open: that runs inside
      // runAgent, whose rejection lands on the record as an agent error. A
      // `/new` in another pi window or a manual delete makes the conversation
      // unrecoverable, so drop the entry — a handle that can only ever fail is
      // worse than none — and say so rather than quietly sending this message
      // to an unrelated agent.
      if (!existsSync(entry.sessionFile)) {
        manager.dropResumable(entry.handle);
        ctx.ui.notify(
          `Could not resume ${target} — its session is gone.`,
          "warning",
        );
        return { action: "handled" };
      }

      // The Agent tool deliberately falls back to a substitute for a type it
      // cannot resolve, which covers a deleted file AND a merely disabled one.
      // A resume must not inherit that: reopening this conversation under a
      // different agent's prompt and tools is not continuing it, and the new
      // record would re-index under the substitute, so the handle would never
      // find its way back.
      reloadCustomAgents();
      const dispatch = resolveSpawnType(entry.type);
      if (!dispatch.ok || dispatch.fellBackFrom !== undefined) {
        // The entry stays: re-enabling the agent makes the handle work again,
        // which a drop would foreclose.
        ctx.ui.notify(
          `Could not resume ${target} — the ${entry.type} agent is no longer available.`,
          "warning",
        );
        return { action: "handled" };
      }

      try {
        spawnMention(ctx, dispatch.type, mention.message, {
          description: entry.description,
          reclaimHandle: entry.handle,
          resumeSessionFile: entry.sessionFile,
        });
        // The entry deliberately stays. `resolveMention` prefers the live
        // record holding this same handle, so it cannot shadow the resume — and
        // if this run dies before establishing its own session, the original
        // transcript is still the right thing for the next mention to reopen.
        // Once the resumed record is evicted it overwrites this entry in place,
        // keyed by the same handle, so nothing accumulates.
        ctx.ui.notify(`Resuming ${target}`, "info");
      } catch (err) {
        ctx.ui.notify(
          `Could not resume ${target}: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
      return { action: "handled" };
    }

    // No agent under that handle — but the name may still be an agent type, in
    // which case the mention starts one.
    reloadCustomAgents();
    const type =
      resolveHandleToType(mention.handle, getAvailableTypes()) ??
      (alias ? resolveHandleToType(alias, getAvailableTypes()) : undefined);
    if (!type) return { action: "continue" };

    const label = `@${handleBase(type)}`;
    const startDirectly = (): void => {
      spawnMention(ctx, type, mention.message, {
        description: describeMention(mention.message),
      });
    };

    // In `model` mode the turn is taken by an off-screen clone of this
    // conversation, so the agent is started with a prompt written from context
    // rather than from the words after the handle alone. Nothing reaches the
    // chat, and what it starts is an ordinary top-level agent.
    const registeredAgentTool = agentToolRef;
    if (getAgentMentionMode() === "model" && registeredAgentTool) {
      ctx.ui.notify(`Starting ${label}…`, "info");
      // Not awaited: the clone runs a full model turn and `prompt()` is blocked
      // until this hook returns. The user gets their prompt back immediately.
      void runMentionClone({ ctx, type, message: mention.message, agentTool: registeredAgentTool }).then(
        (result) => {
          if (result.spawned) return;
          // A clone that could not run must not swallow the mention: start the
          // agent the direct way rather than leaving a toast and nothing running.
          try {
            startDirectly();
            ctx.ui.notify(`Started ${label} directly — ${result.error}`, "warning");
          } catch (err) {
            ctx.ui.notify(
              `Could not start ${label}: ${err instanceof Error ? err.message : String(err)}`,
              "error",
            );
          }
        },
      );
      return { action: "handled" };
    }

    try {
      startDirectly();
      ctx.ui.notify(`Started ${label}`, "info");
    } catch (err) {
      ctx.ui.notify(
        `Could not start ${label}: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
    return { action: "handled" };
  });

  // ---- Agent tool ----

  // Schedule param + its guideline are gated on `schedulingEnabled` (read once
  // at registration; flipping the setting later requires next pi session for
  // the schema to update). Defining the shape once and spreading it via Partial
  // preserves Type.Object's inference when present and produces a
  // `schedule`-free schema when absent — zero LLM-context cost in disabled mode.
  const scheduleParamShape = {
    schedule: Type.Optional(
      Type.String({
        description:
          "Opt-in only — fire later instead of now. Omit to run immediately (the default, almost always correct). " +
          'Formats: 6-field cron ("0 0 9 * * 1" = 9am Mon), interval ("5m"/"1h"), one-shot ("+10m" or ISO). ' +
          "Forces run_in_background; incompatible with inherit_context and resume. Returns job ID.",
      }),
    ),
  };
  const scheduleParam: Partial<typeof scheduleParamShape> =
    isSchedulingEnabled() ? scheduleParamShape : {};

  const scheduleGuideline = isSchedulingEnabled()
    ? `\n- Use \`schedule\` only when the user explicitly asked for scheduled / recurring / delayed execution (e.g. "every Monday", "in an hour"). Don't auto-schedule from vague intent like "monitor X" — run once now or ask.`
    : "";

  // Compact Agent tool description (#91, `toolDescriptionMode: "compact"`) —
  // the same load-bearing facts as the full version at ~75% fewer tokens, for
  // small/local models. Per-option details live in the param descriptions.
  // The catalogue is injected into the description rather than left to a lookup
  // tool: the host has to pick a tier on its first call, and a tool it must
  // remember to call first is a tool it will skip.
  const tierListText = buildAgentTierListText();
  const compactTierListText = buildCompactAgentTierListText();
  const tierSection = tierListText ? `\n\n${tierListText}` : "";
  const compactTierSection = compactTierListText
    ? `\n\n${compactTierListText}`
    : "";

  const compactAgentToolDescription = `Launch an autonomous agent for complex, multi-step tasks. Agent types:
${buildCompactTypeListText()}${compactTierSection}

Custom agents: .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).

Notes:
- description: 3-5 words (shown in UI). Prompts must be self-contained — the agent has not seen this conversation.
- Parallel work: one message, multiple Agent calls, run_in_background: true on each. You are notified when background agents finish — never poll or sleep.
- The result is not shown to the user — summarize it for them. Verify an agent's claimed code changes before reporting work done.
- resume continues a previous agent by ID; steer_subagent messages a running one.
- isolation: "worktree" runs the agent in an isolated git worktree; changes land on a branch.`;

  const fullAgentToolDescription = `Launch a new agent to handle complex, multi-step tasks autonomously. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
${buildTypeListText()}

Custom agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.${tierSection}

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

## When not to use

If the target is already known, use a direct tool — \`read\` for a known path, \`grep\`/\`find\` for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses, with run_in_background: true on each, so they run concurrently. If the user specifies that they want agents run "in parallel", you MUST send a single message with multiple tool calls. Foreground calls run sequentially — only one executes at a time.
- When the agent is done, it returns a single message back to you. The result is not visible to the user — to show the user, send a text message with a concise summary.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting work as done.
- Use run_in_background for work you don't need immediately. You will be notified when it completes — do NOT poll or sleep waiting for it. Continue with other work or respond to the user instead.
- Foreground vs background: use foreground (default) when you need the agent's results before you can proceed. Use background when you have genuinely independent work to do in parallel.
- Use resume with an agent ID to continue a previous agent's work. A new (non-resume) Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Use steer_subagent to send mid-run messages to a running background agent.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.
- If an agent's description says it should be used proactively, try to use it without the user having to ask for it first.
- Use tier to pick the model profile for this spawn, by name. A tier overrides the agent's own default tier. Model and thinking are not callable parameters — they are what a tier resolves to.
- Use inherit_context if the agent needs the parent conversation history.
- Use isolation: "worktree" to run the agent in an isolated git worktree (safe parallel file modifications). The worktree is automatically cleaned up if the agent makes no changes; otherwise the path and branch are returned in the result.${scheduleGuideline}

## Writing the prompt

Provide clear, detailed prompts so the agent can work autonomously. Brief it like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.`;

  // `toolDescriptionMode: "custom"` — user-authored description with live
  // dynamic parts. Project file wins over global; missing/empty falls back to
  // "full" (a stale fallback beats a blank tool description). Only the prose
  // is customizable — the parameter schema stays code-owned.
  const renderToolDescriptionTemplate = (template: string): string => {
    const vars: Record<string, () => string> = {
      typeList: buildTypeListText,
      compactTypeList: buildCompactTypeListText,
      // Both carry their own leading blank line, so a template that drops the
      // placeholder inline renders byte-identically to the built-in description
      // whether or not any tier is configured.
      tierList: () => tierSection,
      compactTierList: () => compactTierSection,
      defaultTier: getDefaultAgentTierText,
      agentDir: getAgentDir,
      scheduleGuideline: () => scheduleGuideline,
    };
    // Replacement callback (not a string) — agent descriptions may contain `$&` etc.
    return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
      if (vars[name]) return vars[name]();
      console.warn(
        `[pi-subagents] agent-tool-description.md: unknown placeholder ${raw} left as-is`,
      );
      return raw;
    });
  };

  const loadCustomToolDescription = (): string | undefined => {
    for (const path of [
      join(sessionCwd, ".pi", "agent-tool-description.md"),
      join(getAgentDir(), "agent-tool-description.md"),
    ]) {
      try {
        if (!existsSync(path)) continue;
        const text = readFileSync(path, "utf-8").trim();
        if (text) return renderToolDescriptionTemplate(text);
        console.warn(`[pi-subagents] ${path} is empty — ignoring`);
      } catch (err) {
        console.warn(
          `[pi-subagents] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return undefined;
  };

  const agentToolDescription = (() => {
    const mode = getToolDescriptionMode();
    if (mode === "compact") return compactAgentToolDescription;
    if (mode === "custom") {
      const custom = loadCustomToolDescription();
      if (custom) return custom;
      console.warn(
        '[pi-subagents] toolDescriptionMode is "custom" but no agent-tool-description.md found — using "full"',
      );
    }
    return fullAgentToolDescription;
  })();

  // Captured so the mention clone can hand the copy the REAL registered tool:
  // its handler closes over this activation, which is what makes a clone-driven
  // spawn an ordinary top-level agent rather than something the fork owns.
  const agentTool = defineTool({
      name: SUBAGENT_TOOL_NAMES.AGENT,
      label: "Agent",
      description: agentToolDescription,
      promptSnippet:
        "Launch autonomous sub-agents for complex multi-step tasks",
      promptGuidelines: [
        "Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
        "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type (e.g. Explore). Otherwise use direct tools (read, grep, find) when the target is already known.",
        "When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it. Continue with other work instead.",
        "Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
      ],
      parameters: Type.Object({
        prompt: Type.String({
          description: "The task for the agent to perform.",
        }),
        description: Type.String({
          description:
            "A short (3-5 word) description of the task (shown in UI).",
        }),
        subagent_type: Type.String({
          description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}. Custom agents from .pi/agents/*.md (project) or ${getAgentDir()}/agents/*.md (global) are also available.`,
        }),
        tier: Type.Optional(
          Type.String({
            description: buildAgentTierParameterDescription(),
          }),
        ),
        max_turns: Type.Optional(
          Type.Number({
            description:
              "Maximum number of agentic turns before stopping. Omit for unlimited (default).",
            minimum: 1,
          }),
        ),
        run_in_background: Type.Optional(
          Type.Boolean({
            description:
              "Set to true to run in background. Returns agent ID immediately. You will be notified on completion.",
          }),
        ),
        resume: Type.Optional(
          Type.String({
            description:
              "Optional agent ID to resume from. Continues from previous context.",
          }),
        ),
        isolated: Type.Optional(
          Type.Boolean({
            description:
              "If true, agent gets no extension/MCP tools — only built-in tools.",
          }),
        ),
        inherit_context: Type.Optional(
          Type.Boolean({
            description:
              "If true, fork parent conversation into the agent. Default: false (fresh context).",
          }),
        ),
        isolation: Type.Optional(
          Type.Union(
            [
              Type.Literal("worktree", {
                description:
                  'Run the agent in a temporary git worktree (isolated copy of the repo). Changes are saved to a branch on completion.',
              }),
              Type.Literal("off", {
                description: 'Explicitly disable worktree isolation for this agent.',
              }),
            ],
            {
              description: 'Isolation mode: "worktree" for isolated git worktree, "off" to explicitly disable.',
            },
          ),
        ),
        ...scheduleParam,
      }),

      // ---- Custom rendering: Claude Code style ----

      renderCall(args, theme) {
        const displayName = args.subagent_type
          ? getDisplayName(args.subagent_type)
          : "Agent";
        const desc = sanitizeDisplayText(args.description ?? "");
        const text = [
          theme.fg("toolTitle", theme.bold(displayName)),
          desc ? theme.fg("muted", desc) : undefined,
        ]
          .filter((part): part is string => part !== undefined)
          .join(theme.fg("dim", " · "));
        return new Text(text, 0, 0);
      },

      renderResult(result, { expanded, isPartial }, theme, renderContext) {
        // Everything below draws child-derived text into the parent transcript
        // through pi-tui's ANSI-preserving renderer, so it is scrubbed on the way in.
        const text = safeTerminalText(
          result.content[0]?.type === "text" ? result.content[0].text : "",
        );
        const details = result.details as AgentDetails | undefined;
        // Pre-execution failures have no agent status. Preserve pi's error text
        // instead of rendering them as an invented subagent failure.
        if (renderContext?.isError || !details?.status) {
          return new Text(text, 0, 0);
        }

        const stats = (d: AgentDetails) => {
          const parts: string[] = [];
          if (d.modelName) parts.push(d.modelName);
          if (d.tags) parts.push(...d.tags);
          if (d.turnCount != null && d.turnCount > 0) {
            parts.push(formatTurns(d.turnCount, d.maxTurns));
          }
          if (d.toolUses > 0) parts.push(`tools ${d.toolUses}`);
          if (d.tokens) parts.push(d.tokens);
          return parts
            .map((p) => fgPreservingNestedStyles(theme, "dim", p))
            .join(theme.fg("dim", " · "));
        };

        if (details.status === "queued") {
          const id = details.agentId ? ` · ID ${details.agentId}` : "";
          return new Text(
            theme.fg(
              "dim",
              `${getAgentStatusMark("queued")} queued · background${id}`,
            ),
            0,
            0,
          );
        }

        if (isPartial || details.status === "running") {
          const frame = SPINNER[details.spinnerFrame ?? 0] ?? SPINNER[0]!;
          const s = stats(details);
          return renderRunningAgentStatus(
            frame,
            s,
            details.activity ?? "Thinking...",
            theme,
          );
        }

        if (details.status === "background") {
          const id = details.agentId ? ` · ID ${details.agentId}` : "";
          return new Text(
            theme.fg(
              "dim",
              `${getAgentStatusMark("running")} running · background${id}`,
            ),
            0,
            0,
          );
        }

        if (details.status === "completed" || details.status === "steered") {
          const duration = formatMs(details.durationMs);
          const isSteered = details.status === "steered";
          const statusText = isSteered
            ? "wrapped up · turn limit"
            : "completed";
          const statusColor = isSteered ? "warning" : "dim";
          const s = stats(details);
          let line = theme.fg(
            statusColor,
            `${getAgentStatusMark(details.status)} ${statusText}`,
          );
          if (s) line += theme.fg("dim", " · ") + s;
          line += theme.fg("dim", " · ") + theme.fg("dim", duration);

          if (expanded) {
            if (text) {
              const lines = text.split("\n").slice(0, 50);
              for (const l of lines) {
                line += "\n" + theme.fg("dim", `  ${l}`);
              }
              if (text.split("\n").length > 50) {
                line +=
                  "\n" +
                  theme.fg(
                    "muted",
                    "  ... (use get_subagent_result with verbose for full output)",
                  );
              }
            }
          } else {
            const doneText = isSteered
              ? "Wrapped up at the turn limit"
              : "Done";
            line += "\n" + theme.fg("dim", `  ${doneText}`);
          }
          return new Text(line, 0, 0);
        }

        if (details.status === "stopped") {
          const s = stats(details);
          let line = theme.fg(
            "dim",
            `${getAgentStatusMark("stopped")} stopped`,
          );
          if (s) line += theme.fg("dim", " · ") + s;
          line += "\n" + theme.fg("dim", "  Stopped before completion");
          return new Text(line, 0, 0);
        }

        // Keep unknown/future statuses from falling through to the turn-limit
        // renderer, which is only valid for explicit error/aborted outcomes.
        if (details.status !== "error" && details.status !== "aborted") {
          return new Text(text, 0, 0);
        }

        const s = stats(details);
        const isError = details.status === "error";
        let line = theme.fg(
          isError ? "error" : "warning",
          `${getAgentStatusMark(details.status)} ${isError ? "failed" : "aborted"}`,
        );
        if (s) line += theme.fg("dim", " · ") + s;

        if (isError) {
          line +=
            "\n" +
            theme.fg(
              "error",
              `  Error: ${sanitizeDisplayText(details.error ?? "unknown")}`,
            );
        } else {
          line += "\n" + theme.fg("warning", "  Aborted at the turn limit");
        }

        return new Text(line, 0, 0);
      },

      // ---- Execute ----

      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        // Ensure we have UI context for the FleetView list
        seatFleet(ctx);

        // Reload custom agents so new project/global .md files are picked up without restart
        reloadCustomAgents();

        const rawType = params.subagent_type as SubagentType;
        // Single decision point for dispatch (#183): unknown, disabled and
        // case-ambiguous types are refused here, BEFORE anything spawns, so a
        // background or scheduled call can't start running the wrong agent while
        // the caller is still unaware. `fallbackSubagent` decides whether an
        // unresolvable type falls back or fails closed.
        const dispatch = resolveSpawnType(rawType);
        // `resume` replays a stored session and ignores `subagent_type` entirely,
        // but the parameter is required by the schema — so gating it here would
        // make a live agent unresumable the moment its type is deleted, disabled,
        // or gains a case-clashing sibling. Only a real spawn is gated.
        if (!dispatch.ok && !params.resume) return textResult(dispatch.message);
        const subagentType = dispatch.ok ? dispatch.type : rawType;
        // What the caller actually asked for, named once: `fellBackFrom` is "" for
        // a blank request, so reading it inline invites the `??`-vs-`||` slip that
        // once persisted an empty type into a scheduled job.
        const requestedType =
          (dispatch.ok && dispatch.fellBackFrom) || subagentType;
        // Computed at resolution rather than after the run, so the background and
        // schedule branches carry it too — previously it existed only on the
        // foreground path. Resume deliberately doesn't: it replays the stored
        // session and ignores `subagent_type` entirely, so a note about type
        // substitution would be describing something that didn't happen.
        const fallbackNote =
          dispatch.ok && dispatch.fellBackFrom !== undefined
            ? `Note: Unknown agent type "${dispatch.fellBackFrom}" — using ${resolveType(subagentType) ? subagentType : "the fallback agent config"}.\n\n`
            : "";

        const displayName = getDisplayName(subagentType);

        // Get agent config (if any)
        const customConfig = getAgentConfig(subagentType);

        const resolvedConfig = resolveAgentInvocationConfig(
          customConfig,
          params,
        );

        // Resolve model from agent config first; tool-call params only fill gaps.
        // With neither, runAgent falls to the configured `defaultModel` before the
        // parent, so mirror that here — the scope check below and the model label
        // must describe the model that will actually run.
        let model =
          resolveConfiguredDefaultModel(ctx.modelRegistry) ?? ctx.model;
        if (resolvedConfig.modelInput) {
          const resolved = resolveModel(
            resolvedConfig.modelInput,
            ctx.modelRegistry,
          );
          if (typeof resolved === "string") {
            if (resolvedConfig.modelFromParams) return textResult(resolved);
            // config-specified: silent fallback to the default model, then parent
          } else {
            model = resolved;
          }
        }

        // Scope validation: the effective resolved model is checked against the
        // user's enabledModels list. Policy (hard error vs warn-and-proceed) lives
        // in model-scope.ts so the nested delegation tools apply the same rule.
        const scopeVerdict = checkModelScope({
          model,
          cwd: ctx.cwd,
          modelRegistry: ctx.modelRegistry,
          callerSupplied: resolvedConfig.modelFromParams,
          agentLabel: customConfig?.displayName ?? subagentType,
          modelInput: resolvedConfig.modelInput,
        });
        if (scopeVerdict.kind === "error")
          return textResult(scopeVerdict.message);
        if (scopeVerdict.kind === "warn")
          ctx.ui.notify(scopeVerdict.message, "warning");

        const thinking = resolvedConfig.thinking;
        const inheritContext = resolvedConfig.inheritContext;
        const runInBackground = resolvedConfig.runInBackground;
        const isolated = resolvedConfig.isolated;
        const isolation = resolvedConfig.isolation;
        // Whether this spawn writes its .output transcript. Per-agent
        // frontmatter (`output_transcript`) wins; otherwise the project/global
        // default applies. `attachTranscript` below is the SOLE gate — every
        // downstream consumer keys off record.outputFile being set, so no spawn
        // path can re-enable the transcript by accident.
        const outputTranscript =
          customConfig?.outputTranscript ?? getOutputTranscriptDefault();
        const attachTranscript = (
          rec: AgentRecord | undefined,
          agentId: string,
        ): void => {
          if (!rec || !outputTranscript) return;
          rec.outputFile = createOutputFilePath(
            ctx.cwd,
            agentId,
            ctx.sessionManager.getSessionId(),
          );
          writeInitialEntry(rec.outputFile, agentId, params.prompt, ctx.cwd);
        };

        const parentModelId = ctx.model?.id;
        const effectiveModelId = model?.id;
        const modelName =
          effectiveModelId && effectiveModelId !== parentModelId
            ? (model?.name ?? effectiveModelId)
                .replace(/^Claude\s+/i, "")
                .toLowerCase()
            : undefined;
        const effectiveMaxTurns = normalizeMaxTurns(
          resolvedConfig.maxTurns ?? getDefaultMaxTurns(),
        );
        const agentInvocation: AgentInvocation = {
          modelName,
          thinking,
          // Explicit value only — the default fallback would just add noise.
          // Normalize so `0` (unlimited) doesn't surface as a misleading "max turns: 0".
          maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
          isolated,
          inheritContext,
          runInBackground,
          isolation,
        };
        // Tool-result render shows the mode label too; viewer's header already does.
        const modeLabel = getPromptModeLabel(subagentType);
        const { tags: invocationTags } = buildInvocationTags(agentInvocation);
        const agentTags = modeLabel
          ? [modeLabel, ...invocationTags]
          : invocationTags;
        const detailBase = {
          displayName,
          description: params.description,
          subagentType,
          modelName,
          tags: agentTags.length > 0 ? agentTags : undefined,
        };

        // ---- Schedule: register a job, don't spawn now ----
        if (params.schedule) {
          if (!isSchedulingEnabled()) {
            return textResult(
              "Scheduling is disabled in this project. Enable via /agents, Settings, Scheduling.",
            );
          }
          if (params.resume) {
            return textResult(
              "Cannot combine `schedule` with `resume` — schedules create fresh agents.",
            );
          }
          if (inheritContext) {
            return textResult(
              "Cannot combine `schedule` with `inherit_context` — there is no parent conversation at fire time.",
            );
          }
          if (params.run_in_background === false) {
            return textResult(
              "Cannot combine `schedule` with `run_in_background: false` — scheduled jobs always run in background.",
            );
          }
          if (!scheduler.isActive()) {
            return textResult(
              "Scheduler is not active in this session yet. Try again after the session has fully started.",
            );
          }
          try {
            const job = scheduler.addJob({
              name: params.description as string,
              description: params.description as string,
              schedule: params.schedule as string,
              // The caller's own name, not the substitute — the scheduler re-resolves
              // at fire time, and the original is what a user edits.
              subagent_type: requestedType,
              prompt: params.prompt as string,
              // Store the resolved policy input (agent config first, tool params second)
              // so scheduled fires use the same model fallback as an immediate spawn.
              model: resolvedConfig.modelInput,
              thinking: thinking,
              max_turns: effectiveMaxTurns,
              isolated: isolated,
              isolation: isolation,
            });
            const next = scheduler.getNextRun(job.id);
            return textResult(
              `${fallbackNote}Scheduled "${job.name}" (id: ${job.id}, type: ${job.scheduleType}). ` +
                `Next run: ${next ?? "(unknown)"}. ` +
                `Manage via /agents, Scheduled jobs.`,
            );
          } catch (err) {
            return textResult(err instanceof Error ? err.message : String(err));
          }
        }

        // Resume existing agent
        if (params.resume) {
          const existing = manager.getRecordMutable(params.resume);
          if (!existing || existing.parentAgentId) {
            return textResult(
              `Agent not found: "${params.resume}". It may have been cleaned up.`,
            );
          }
          if (!existing.session) {
            return textResult(
              `Agent "${params.resume}" has no active session to resume.`,
            );
          }
          if (signal?.aborted) {
            return textResult("Resume aborted.");
          }

          // Assigned unconditionally, before either resume path. The completion
          // notification carries this as `<tool-use-id>` (see
          // formatTaskNotification), and `manager.resume` clears
          // `resultConsumed`, so a resumed run does notify. Keeping the id the
          // original spawn wrote would point that notification at a tool call
          // answered runs ago; a resume with no tool call of its own must clear
          // it rather than inherit one.
          existing.toolCallId = toolCallId;

          // run_in_background on resume: settle asynchronously and notify on
          // completion like a background spawn, returning immediately. Previously
          // the flag was accepted then silently dropped — a resumed agent always
          // blocked the caller until it finished.
          if (runInBackground) {
            const { state: bgState, callbacks: bgCallbacks } =
              createActivityTracker(effectiveMaxTurns);
            // resumeAgent has no onSessionCreated — the session predates this run
            // — so seed the activity tracker directly.
            bgState.session = existing.session;
            // Reuse the agent's transcript rather than starting a fresh one: the
            // path is deterministic per agent+session, and writing an initial
            // entry would truncate the previous run's turns (B1#2).
            if (outputTranscript) {
              existing.outputFile = createOutputFilePath(
                ctx.cwd,
                params.resume,
                ctx.sessionManager.getSessionId(),
              );
              ensureOutputFile(existing.outputFile);
            }
            // Anchor streaming past the turns already on disk, captured BEFORE the
            // run starts. The resumed prompt lands as an ordinary user message at
            // this index, so it is written exactly once.
            const transcriptAnchor = existing.session.messages.length ?? 0;
            const record = await manager.resume(
              params.resume,
              params.prompt,
              undefined,
              {
                isBackground: true,
                onToolActivity: bgCallbacks.onToolActivity,
                onAssistantUsage: bgCallbacks.onAssistantUsage,
              },
            );
            if (!record) {
              return textResult(
                `Cannot resume agent "${params.resume}" in background — it is already running. ` +
                  "Wait for it to settle, or steer it with steer_subagent.",
              );
            }
            // Wire streaming once the run actually starts (immediately, or on
            // queue drain).
            if (existing.outputFile) {
              existing.outputCleanup = streamToOutputFile(
                existing.session,
                existing.outputFile,
                params.resume,
                ctx.cwd,
                transcriptAnchor,
              );
            }
            agentActivity.set(params.resume, bgState);
            void bgCallbacks;
            return textResult(
              record.status === "queued"
                ? `Agent "${params.resume}" resumed in background (queued at the concurrency limit).`
                : `Agent "${params.resume}" resumed in background.`,
              buildDetails(detailBase, record),
            );
          }

          const record = await manager.resume(
            params.resume,
            params.prompt,
            signal,
          );
          if (!record) {
            return textResult(`Failed to resume agent "${params.resume}".`);
          }
          // A failed resume surfaces the error, plus any partial output THIS
          // resume produced (never the previous turn's answer, #144).
          if (record.status === "error") {
            return textResult(
              `Agent failed: ${record.error}${partialOutputSuffix(record)}`,
              buildDetails(detailBase, record),
            );
          }
          return textResult(
            record.result?.trim() || "No output.",
            buildDetails(detailBase, record),
          );
        }

        // Background execution
        if (runInBackground) {
          const { state: bgState, callbacks: bgCallbacks } =
            createActivityTracker(effectiveMaxTurns);

          // Wrap onSessionCreated to wire output file streaming.
          // The callback lazily reads record.outputFile (set right after spawn)
          // rather than closing over a value that doesn't exist yet.
          let id: string;
          const origBgOnSession = bgCallbacks.onSessionCreated;
          bgCallbacks.onSessionCreated = (session: any) => {
            origBgOnSession(session);
            const rec = manager.getRecordMutable(id);
            if (rec?.outputFile) {
              rec.outputCleanup = streamToOutputFile(
                session,
                rec.outputFile,
                id,
                ctx.cwd,
              );
            }
          };

          // A startup throw means the agent never started. Let pi mark the tool
          // call as failed instead of returning a successful-looking text result.
          id = manager.spawn(pi, ctx, subagentType, params.prompt, {
            description: params.description,
            model,
            maxTurns: effectiveMaxTurns,
            isolated,
            inheritContext,
            thinkingLevel: thinking,
            agentTier: resolvedConfig.requestedAgentTier,
            isBackground: true,
            isolation,
            invocation: agentInvocation,
            rootSessionId: ctx.sessionManager.getSessionId(),
            ...bgCallbacks,
          });

          // Set output file + join mode synchronously after spawn, before the
          // event loop yields — onSessionCreated is async so this is safe.
          const joinMode = resolveJoinMode(defaultJoinMode, true);
          const record = manager.getRecordMutable(id);
          if (record && joinMode) {
            record.joinMode = joinMode;
            record.toolCallId = toolCallId;
            attachTranscript(record, id);
          }

          if (joinMode == null || joinMode === "async") {
            // Foreground/no join mode or explicit async — not part of any batch
          } else {
            // smart or group — add to current batch
            currentBatchAgents.push({ id, joinMode });
            // Debounce: reset timer on each new agent so parallel tool calls
            // dispatched across multiple event loop ticks are captured together
            if (batchFinalizeTimer) clearTimeout(batchFinalizeTimer);
            batchFinalizeTimer = setTimeout(finalizeBatch, 100);
          }

          agentActivity.set(id, bgState);
          fleet.ensureTimer();
          fleet.update();

          // Emit created event unless a branch replacement detached the record.
          if (!record?.detached) {
            pi.events.emit("subagents:created", {
              id,
              type: subagentType,
              description: params.description,
              isBackground: true,
            });
          }

          const isQueued = record?.status === "queued";
          return textResult(
            `${fallbackNote}Agent ${isQueued ? "queued" : "started"} in background.\n` +
              `Agent ID: ${id}\n` +
              `Type: ${displayName}\n` +
              `Description: ${params.description}\n` +
              (record?.outputFile
                ? `Output file: ${record.outputFile}\n`
                : "") +
              (isQueued
                ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n`
                : "") +
              `\nYou will be notified when this agent completes.\n` +
              `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
              `Do not duplicate this agent's work.`,
            {
              ...detailBase,
              toolUses: 0,
              tokens: "",
              durationMs: 0,
              status: isQueued ? "queued" : "background",
              agentId: id,
            },
          );
        }

        // Foreground (synchronous) execution — stream progress via onUpdate
        let spinnerFrame = 0;
        const startedAt = Date.now();
        let fgId: string | undefined;

        const streamUpdate = () => {
          const details: AgentDetails = {
            ...detailBase,
            toolUses: fgState.toolUses,
            tokens: formatLifetimeTokens(fgState),
            turnCount: fgState.turnCount,
            maxTurns: fgState.maxTurns,
            durationMs: Date.now() - startedAt,
            status: "running",
            activity: describeActivity(
              fgState.activeTools,
              fgState.responseText,
            ),
            spinnerFrame: spinnerFrame % SPINNER.length,
          };
          onUpdate?.({
            content: [
              { type: "text", text: `${fgState.toolUses} tool uses...` },
            ],
            details: details as any,
          });
        };

        const { state: fgState, callbacks: fgCallbacks } =
          createActivityTracker(effectiveMaxTurns, streamUpdate);

        // Wire session creation: register in the FleetView list + stream to the output file.
        // The output file path is set synchronously after spawn (below),
        // before onSessionCreated fires — same pattern as background agents.
        const origOnSession = fgCallbacks.onSessionCreated;
        fgCallbacks.onSessionCreated = (session: any) => {
          origOnSession(session);
          for (const a of manager.listAgentsMutable()) {
            if (a.session === session) {
              fgId = a.id;
              agentActivity.set(a.id, fgState);
              fleet.ensureTimer();
              fleet.update();
              break;
            }
          }
          // Stream conversation to output file (foreground agent logging)
          if (fgId) {
            const rec = manager.getRecordMutable(fgId);
            if (rec?.outputFile) {
              rec.outputCleanup = streamToOutputFile(
                session,
                rec.outputFile,
                fgId,
                ctx.cwd,
              );
            }
          }
        };

        const spinnerInterval = setInterval(() => {
          spinnerFrame++;
          streamUpdate();
        }, SPINNER_INTERVAL_MS);

        streamUpdate();

        let record: AgentRecord;
        try {
          const fgResult = await manager.spawnAndWait(
            pi,
            ctx,
            subagentType,
            params.prompt,
            {
              description: params.description,
              model,
              maxTurns: effectiveMaxTurns,
              isolated,
              inheritContext,
              thinkingLevel: thinking,
              agentTier: resolvedConfig.requestedAgentTier,
              isolation,
              invocation: agentInvocation,
              signal,
              rootSessionId: ctx.sessionManager.getSessionId(),
              ...fgCallbacks,
            },
            (fgAgentId) => {
              // onSpawned: called synchronously after spawn, before onSessionCreated fires.
              // Set up the output file so streamToOutputFile can pick it up.
              const fgRec = manager.getRecordMutable(fgAgentId);
              attachTranscript(fgRec, fgAgentId);
            },
          );
          record = fgResult.record;
        } finally {
          // Always stop the spinner and drop the row, including startup errors
          // that now propagate to pi as failed tool calls.
          clearInterval(spinnerInterval);
          if (fgId) {
            agentActivity.delete(fgId);
            fleet.onAgentFinished(fgId);
          }
        }

        // Get final token count
        const tokenText = formatLifetimeTokens(fgState);

        const details = buildDetails(detailBase, record, fgState, {
          tokens: tokenText,
        });

        if (record.status === "error") {
          // Error headline + any partial output the run produced before failing.
          return textResult(
            `${fallbackNote}Agent failed: ${record.error}${partialOutputSuffix(record)}`,
            details,
          );
        }

        const durationMs =
          (record.completedAt ?? Date.now()) - record.startedAt;
        const statsParts = [`${record.toolUses} tool uses`];
        if (tokenText) statsParts.push(tokenText);
        return textResult(
          `${fallbackNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getForegroundOutcomeNote(record.status)}.\n\n` +
            (record.result?.trim() || "No output."),
          details,
        );
      },
  });
  pi.registerTool(agentTool);
  agentToolRef = agentTool;

  // ---- get_subagent_result tool ----

  pi.registerTool(
    defineTool({
      name: SUBAGENT_TOOL_NAMES.GET_RESULT,
      label: "Get Agent Result",
      description:
        "Check status and retrieve results from a background agent. Use the agent ID returned by Agent with run_in_background.",
      promptSnippet:
        "Check status and retrieve results from a background agent",
      parameters: Type.Object({
        agent_id: Type.String({
          description: "The agent ID to check.",
        }),
        wait: Type.Optional(
          Type.Boolean({
            description:
              "If true, wait for the agent to complete before returning. Default: false.",
          }),
        ),
        verbose: Type.Optional(
          Type.Boolean({
            description:
              "If true, include the agent's full conversation (messages + tool calls). Default: false.",
          }),
        ),
      }),
      execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
        const record = manager.getRecordMutable(params.agent_id);
        if (!record || record.parentAgentId || record.detached) {
          return textResult(
            `Agent not found: "${params.agent_id}". It may have been cleaned up.`,
          );
        }

        // Wait for completion if requested. Cancellation stops only this tool
        // call; the background agent keeps running and remains unconsumed so its
        // completion notification can still be delivered.
        // Queued agents have no promise yet (it's created when the queue starts
        // them), so poll until they leave the queue, then await like a running one.
        if (
          params.wait &&
          (record.status === "running" || record.status === "queued")
        ) {
          while (record.status === "queued") {
            await abortable(
              new Promise<void>((resolve) =>
                setTimeout(resolve, QUEUE_WAIT_POLL_MS),
              ),
              signal,
            );
          }
          if (record.promise) await abortable(record.promise, signal);
        }

        const displayName = getDisplayName(record.type);
        const duration = formatDuration(record.startedAt, record.completedAt);
        const tokens = formatLifetimeTokens(record);
        const contextPercent = getSessionContextPercent(record.session);
        const statsParts = [`Tool uses: ${record.toolUses}`];
        if (tokens) statsParts.push(tokens);
        if (contextPercent !== null)
          statsParts.push(`Context: ${Math.round(contextPercent)}%`);
        if (record.compactionCount)
          statsParts.push(`Compactions: ${record.compactionCount}`);
        statsParts.push(`Duration: ${duration}`);

        let output =
          `Agent: ${record.id}\n` +
          `Type: ${displayName} | Status: ${record.status}${getStatusNote(record.status)} | ${statsParts.join(" | ")}\n` +
          `Description: ${record.description}\n\n`;

        if (record.status === "running") {
          output +=
            "Agent is still running. Use wait: true or check back later.";
        } else if (record.status === "error") {
          output += `Error: ${record.error}${partialOutputSuffix(record)}`;
        } else {
          output += record.result?.trim() || "No output.";
        }

        // Mark result as consumed — suppresses the completion notification
        if (record.status !== "running" && record.status !== "queued") {
          record.resultConsumed = true;
          cancelNudge(params.agent_id);
        }

        // Verbose: include full conversation
        if (params.verbose && record.session) {
          const conversation = getAgentConversation(record.session);
          if (conversation) {
            output += `\n\n--- Agent Conversation ---\n${conversation}`;
          }
        }

        return textResult(output);
      },
    }),
  );

  // ---- steer_subagent tool ----

  pi.registerTool(
    defineTool({
      name: SUBAGENT_TOOL_NAMES.STEER,
      label: "Steer Agent",
      description:
        "Send a steering message to a running agent. The message will interrupt the agent after its current tool execution " +
        "and be injected into its conversation, allowing you to redirect its work mid-run. Only works on running agents.",
      promptSnippet:
        "Send a steering message to redirect a running background agent",
      parameters: Type.Object({
        agent_id: Type.String({
          description: "The agent ID to steer (must be currently running).",
        }),
        message: Type.String({
          description:
            "The steering message to send. This will appear as a user message in the agent's conversation.",
        }),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
        const record = manager.getRecordMutable(params.agent_id);
        if (!record || record.parentAgentId || record.detached) {
          return textResult(
            `Agent not found: "${params.agent_id}". It may have been cleaned up.`,
          );
        }
        if (record.status !== "running") {
          return textResult(
            `Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot steer a non-running agent.`,
          );
        }
        if (!record.session) {
          // Session not ready yet — queue the steer for delivery once initialized
          if (!record.pendingSteers) record.pendingSteers = [];
          record.pendingSteers.push(params.message);
          if (!record.detached)
            pi.events.emit("subagents:steered", {
              id: record.id,
              message: params.message,
            });
          return textResult(
            `Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`,
          );
        }

        try {
          await steerAgent(record.session, params.message);
          if (!record.detached)
            pi.events.emit("subagents:steered", {
              id: record.id,
              message: params.message,
            });
          const tokens = formatLifetimeTokens(record);
          const contextPercent = getSessionContextPercent(record.session);
          const stateParts: string[] = [];
          if (tokens) stateParts.push(tokens);
          stateParts.push(
            `${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`,
          );
          if (contextPercent !== null)
            stateParts.push(`context ${Math.round(contextPercent)}% full`);
          if (record.compactionCount)
            stateParts.push(
              `${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`,
            );
          return textResult(
            `Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.\n` +
              `Current state: ${stateParts.join(" · ")}`,
          );
        } catch (err) {
          return textResult(
            `Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    }),
  );

  // ---- /agents interactive menu ----

  // Directory resolution and frontmatter edits live in agent-file-toggle.ts so
  // they can be tested independently of this command handler.

  /**
   * Render one configured model reference for a menu row.
   *
   * Shared by the agent list, the `Default model` setting and the tier editor,
   * because all three show a value someone typed into a settings file and all
   * three have to answer the same question about it: does this machine actually
   * have it? A reference that doesn't resolve falls back at runtime, so the
   * label says so rather than showing config that isn't in force.
   */
  function describeModelReference(
    ref: string | undefined,
    registry?: ModelRegistry,
  ): string {
    if (!ref || ref === "inherit") return "inherit"; // no model configured → really inherits parent
    const label = getModelLabelFromConfig(ref);
    if (!registry) return label;
    const resolved = resolveModel(ref, registry);
    if (typeof resolved === "string")
      return `${label} (unavailable, fallback: inherit)`;
    // Surface what it actually resolved to when that differs from the config —
    // e.g. a provider fallback or a looser version pin. Cosmetic separator/date
    // differences are normalized away so an effectively-identical match stays quiet.
    const resolvedFull = `${resolved.provider}/${resolved.id}`;
    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/\./g, "-")
        .replace(/-\d{8}$/, "");
    if (norm(ref) === norm(resolvedFull)) return label;
    return `${label} (resolved: ${resolvedFull.replace(/-\d{8}$/, "")})`;
  }

  function getModelLabel(type: string, registry?: ModelRegistry): string {
    return describeModelReference(getAgentConfig(type)?.model, registry);
  }

  async function showAgentsMenu(ctx: ExtensionCommandContext) {
    reloadCustomAgents();
    const allNames = getAllTypes();

    // Build select options
    const options: string[] = [];

    // Agent runs entry includes every retained top-level record, not just active agents.
    const agents = manager.listAgentsMutable().filter((a) => !a.parentAgentId);
    if (agents.length > 0) options.push(summarizeAgentRuns(agents));

    // Agent types list
    if (allNames.length > 0) {
      options.push(`Agent types (${allNames.length})`);
    }

    // Scheduled jobs entry (always present when scheduler is active)
    if (scheduler.isActive()) {
      const jobCount = scheduler.list().length;
      options.push(`Scheduled jobs (${jobCount})`);
    }

    // Model tiers entry — always present, since an empty catalogue is exactly
    // the state where the user needs the way in to create the first tier.
    const tierCount = listAgentTierKeys(getAgentTiersSettings()).length;
    options.push(`Model tiers (${tierCount})`);

    // Session usage — always offered, since "nothing has run yet" is a useful
    // answer and the entry is where users learn the summary exists.
    options.push(`Usage (${sessionUsageByType.size} type(s))`);

    // Actions
    options.push("Create new agent");
    options.push("Settings");
    options.push("Diagnostics");

    const noAgentsMsg =
      allNames.length === 0 && agents.length === 0
        ? "No agents found. Create specialized subagents that can be delegated to.\n\n" +
          "Each subagent has its own context window, custom system prompt, and specific tools.\n\n" +
          "Try creating: Code Reviewer, Security Auditor, Test Writer, or Documentation Writer.\n\n"
        : "";

    if (noAgentsMsg) {
      ctx.ui.notify(noAgentsMsg, "info");
    }

    const choice = await ctx.ui.select("Agents", options);
    if (!choice) return;

    if (choice.startsWith("Agent runs (")) {
      await showAgentRuns(ctx);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Agent types (")) {
      await showAllAgentsList(ctx);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Scheduled jobs (")) {
      await showSchedulesMenu(ctx, scheduler);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Model tiers (")) {
      await showModelTiersMenu(ctx);
      await showAgentsMenu(ctx);
    } else if (choice === "Create new agent") {
      await showCreateWizard(ctx);
    } else if (choice === "Settings") {
      await showSettings(ctx);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Usage (")) {
      showSessionUsage(ctx);
      await showAgentsMenu(ctx);
    } else if (choice === "Diagnostics") {
      await showDiagnostics(ctx);
      await showAgentsMenu(ctx);
    }
  }

  /**
   * What subagents have spent this session, by agent type.
   *
   * Tokens, not currency. The model registry carries no per-token price for
   * text models, so a dollar figure here would have to be invented from a
   * hardcoded table that silently goes stale — a confidently wrong number is
   * worse than an honest one. Totals follow `getLifetimeTotal`: input + output
   * + cacheWrite, with cacheRead deliberately excluded.
   */
  function showSessionUsage(ctx: ExtensionCommandContext): void {
    if (sessionUsageByType.size === 0) {
      ctx.ui.notify("No subagents have run in this session yet.", "info");
      return;
    }
    const rows = [...sessionUsageByType.entries()]
      .map(([type, entry]) => ({
        type,
        ...entry,
        total: getLifetimeTotal(entry.usage),
      }))
      .sort((a, b) => b.total - a.total);

    const totals = rows.reduce(
      (sum, row) => ({
        runs: sum.runs + row.runs,
        total: sum.total + row.total,
      }),
      { runs: 0, total: 0 },
    );

    const lines = rows.map(
      (row) =>
        `${sanitizeDisplayText(getDisplayName(row.type))} · ${row.runs} run(s) · ${formatTokens(row.total)}` +
        ` (in ${formatTokens(row.usage.input)}, out ${formatTokens(row.usage.output)}, cache-write ${formatTokens(row.usage.cacheWrite)})`,
    );
    lines.push(
      "",
      `Total · ${totals.runs} run(s) · ${formatTokens(totals.total)}`,
    );
    ctx.ui.notify(lines.join("\n"), "info");
  }

  async function showAllAgentsList(ctx: ExtensionCommandContext) {
    const allNames = getAllTypes();
    if (allNames.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    // Source indicators are textual: project, global, and disabled.
    const sourceIndicator = (cfg: AgentConfig | undefined) => {
      const labels: string[] = [];
      if (cfg?.source === "project") labels.push("project");
      if (cfg?.source === "global") labels.push("global");
      if (cfg?.enabled === false) labels.push("disabled");
      return labels.length > 0 ? `${labels.join(" ")} ` : "";
    };

    // One row per agent (name in the left column, model on the right); the
    // full description renders below the highlighted row via SettingsList,
    // exactly like the Settings menu — so long descriptions never wrap the list.
    const items: SettingItem[] = allNames.map((name) => {
      const cfg = getAgentConfig(name);
      const disabled = cfg?.enabled === false;
      const model = getModelLabel(name, ctx.modelRegistry);
      return {
        id: name,
        label: `${sourceIndicator(cfg)}${name}`,
        currentValue: model,
        description: disabled ? "(disabled)" : (cfg?.description ?? name),
        // Single-value list so Enter "activates" the row (fires onChange with the
        // agent's id) without offering anything to actually cycle.
        values: [model],
      };
    });

    const hasCustom = allNames.some((n) => {
      const c = getAgentConfig(n);
      return c && !c.isDefault && c.enabled !== false;
    });
    const hasDisabled = allNames.some(
      (n) => getAgentConfig(n)?.enabled === false,
    );
    const legendParts: string[] = [];
    if (hasCustom) legendParts.push("source labels: project and global");
    if (hasDisabled) legendParts.push("disabled = unavailable");

    const selected = await wrapCustomUi(ctx.ui).custom<string | undefined>(
      (_tui, _theme, _kb, done) => {
        const slTheme = getSettingsListTheme();
        const list = new SettingsList(
          items,
          Math.min(items.length, 12),
          slTheme,
          (id) => done(id), // Enter/Space on a row → return that agent's name
          () => done(undefined), // Esc → cancel
        );
        const container = new Container();
        container.addChild(new Text("Agent types", 0, 0));
        if (legendParts.length)
          container.addChild(
            new Text(slTheme.hint(legendParts.join("  ")), 0, 0),
          );
        container.addChild(new Spacer(1));
        container.addChild(list);
        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => list.handleInput?.(data),
        };
      },
    );

    if (selected && getAgentConfig(selected)) {
      await showAgentDetail(ctx, selected);
      await showAllAgentsList(ctx);
    }
  }

  async function showAgentRuns(ctx: ExtensionCommandContext) {
    const agents = manager.listAgentsMutable().filter((a) => !a.parentAgentId);
    if (agents.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    const record = await selectItem(ctx.ui, "Agent runs", agents, (agent) => {
      const dn = getDisplayName(agent.type);
      const dur = formatDuration(agent.startedAt, agent.completedAt);
      return `${dn} (${sanitizeDisplayText(agent.description)}) · ${agent.toolUses} tools · ${getAgentStatusLabel(agent.status)} · ${dur}`;
    });
    if (!record) return;

    await viewAgentConversation(ctx, record);
    // Back-navigation: re-show the list
    await showAgentRuns(ctx);
  }

  async function viewAgentConversation(
    ctx: ExtensionCommandContext,
    record: AgentRecord,
  ) {
    if (!record.session) {
      ctx.ui.notify(
        `Agent is ${record.status === "queued" ? "queued" : "expired"}; no session available.`,
        "info",
      );
      return;
    }

    const session = record.session;
    const activity = agentActivity.get(record.id);

    await wrapCustomUi(ctx.ui).custom<undefined>(
      (tui, theme, keybindings, done) => {
        return new ConversationViewer(
          tui,
          session,
          record,
          activity,
          theme,
          done,
          () => {
            if (manager.abort(record.id)) {
              ctx.ui.notify(
                `Stopped "${sanitizeDisplayText(record.description)}".`,
                "info",
              );
            }
          },
          keybindings,
          (message: string) => manager.steer(record.id, message),
          () => manager.getRecord(record.id),
        );
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "90%",
          maxHeight: `${VIEWPORT_HEIGHT_PCT}%`,
        },
      },
    );
  }

  /** Resolve actions against the config that actually survived discovery. */
  function activeAgentFile(
    name: string,
    cfg: AgentConfig,
  ): ReturnType<typeof findAgentFile> {
    return cfg.sourcePath
      ? findAgentFile(name, sessionCwd, cfg.sourcePath)
      : undefined;
  }

  async function showAgentDetail(ctx: ExtensionCommandContext, name: string) {
    const cfg = getAgentConfig(name);
    if (!cfg) {
      ctx.ui.notify(`Agent config not found for "${name}".`, "warning");
      return;
    }

    const file = activeAgentFile(name, cfg);
    // A custom file with a built-in name still has a resettable embedded default.
    const isDefault =
      cfg.isDefault === true ||
      (!isDefaultsDisabled() && DEFAULT_AGENTS.has(name));
    const disabled = cfg.enabled === false;

    // "Refine with Claude" sits beside "Edit" wherever a file exists to rewrite.
    // A default agent with no `.md` has nothing to refine — it has to be
    // ejected first, which the menu already offers.
    let menuOptions: string[];
    if (disabled && file) {
      // Disabled agent with a file — offer Enable
      menuOptions = isDefault
        ? [
            "Enable",
            "Edit",
            REFINE_CHOICE,
            "Reset to default",
            "Delete",
            "Back",
          ]
        : ["Enable", "Edit", REFINE_CHOICE, "Delete", "Back"];
    } else if (isDefault && !file) {
      // Default agent with no .md override
      menuOptions = ["Eject (export as .md)", "Disable", "Back"];
    } else if (isDefault && file) {
      // Default agent with .md override (ejected)
      menuOptions = [
        "Edit",
        REFINE_CHOICE,
        "Disable",
        "Reset to default",
        "Delete",
        "Back",
      ];
    } else {
      // User-defined agent
      menuOptions = ["Edit", REFINE_CHOICE, "Disable", "Delete", "Back"];
    }

    const choice = await ctx.ui.select(name, menuOptions);
    if (!choice || choice === "Back") return;
    if (
      (choice === "Edit" ||
        choice === REFINE_CHOICE ||
        choice === "Delete" ||
        choice === "Reset to default") &&
      !file
    ) {
      ctx.ui.notify(
        `Cannot ${choice.toLowerCase()} ${name}: its active definition is no longer available. Reload and try again.`,
        "error",
      );
      return;
    }

    if (choice === REFINE_CHOICE && file) {
      await refineAgentFile(ctx, name, file.path);
      return;
    }

    if (choice === "Edit" && file) {
      const content = readFileSync(file.path, "utf-8");
      const edited = await ctx.ui.editor(`Edit ${name}`, content);
      if (edited !== undefined && edited !== content) {
        try {
          await atomicReplaceFile(file.path, edited, content);
        } catch (error: unknown) {
          ctx.ui.notify(
            `Cannot update ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
          return;
        }
        reloadCustomAgents();
        const active = getAgentConfig(name);
        if (active?.sourcePath !== file.path) {
          ctx.ui.notify(
            `Updated ${file.path}, but it is no longer the active definition after reload.`,
            "error",
          );
        } else {
          ctx.ui.notify(`Updated ${file.path}`, "info");
        }
      }
    } else if (choice === "Delete") {
      if (file) {
        const content = readFileSync(file.path, "utf-8");
        const confirmed = await ctx.ui.confirm(
          "Delete agent",
          `Delete ${name} from ${file.location} (${file.path})?`,
        );
        if (confirmed) {
          try {
            await removeFileIfUnchanged(file.path, content);
          } catch (error: unknown) {
            ctx.ui.notify(
              `Cannot delete ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
            return;
          }
          reloadCustomAgents();
          ctx.ui.notify(`Deleted ${file.path}`, "info");
        }
      }
    } else if (choice === "Reset to default" && file) {
      const content = readFileSync(file.path, "utf-8");
      const confirmed = await ctx.ui.confirm(
        "Reset to default",
        `Delete override ${file.path} and restore embedded default?`,
      );
      if (confirmed) {
        try {
          await removeFileIfUnchanged(file.path, content);
        } catch (error: unknown) {
          ctx.ui.notify(
            `Cannot reset ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
          return;
        }
        reloadCustomAgents();
        const active = getAgentConfig(name);
        if (active?.isDefault !== true) {
          ctx.ui.notify(
            `Deleted ${file.path}, but another override is still active for ${name}.`,
            "warning",
          );
        } else {
          ctx.ui.notify(`Restored default ${name}`, "info");
        }
      }
    } else if (choice.startsWith("Eject")) {
      await ejectAgent(ctx, name, cfg);
    } else if (choice === "Disable") {
      await disableAgent(ctx, name);
    } else if (choice === "Enable") {
      await enableAgent(ctx, name);
    }
  }

  /** Eject a default agent: write its embedded config as a .md file. */
  async function ejectAgent(
    ctx: ExtensionCommandContext,
    name: string,
    cfg: AgentConfig,
  ) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project")
      ? projectAgentsDir(sessionCwd)
      : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(realpathSync(targetDir), `${name}.md`);
    const existing = existsSync(targetPath)
      ? readFileSync(targetPath, "utf-8")
      : undefined;
    if (existing !== undefined) {
      const overwrite = await ctx.ui.confirm(
        "Overwrite",
        `${targetPath} already exists. Overwrite?`,
      );
      if (!overwrite) return;
    }

    const content = serializeAgentFile(cfg);

    try {
      if (existing === undefined) await atomicCreateFile(targetPath, content);
      else await atomicReplaceFile(targetPath, content, existing);
    } catch (error: unknown) {
      ctx.ui.notify(
        `Cannot eject ${name}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }
    reloadCustomAgents();
    const active = getAgentConfig(name);
    if (active?.sourcePath !== targetPath) {
      ctx.ui.notify(
        `Ejected ${name} to ${targetPath}, but it did not become the active definition after reload.`,
        "error",
      );
      return;
    }
    ctx.ui.notify(`Ejected ${name} to ${targetPath}`, "info");
  }

  /** Disable an agent: edit its active source, or create a stub for an embedded default. */
  async function disableAgent(ctx: ExtensionCommandContext, name: string) {
    const cfg = getAgentConfig(name);
    const file = cfg ? activeAgentFile(name, cfg) : undefined;
    if (cfg?.sourcePath && !file) {
      ctx.ui.notify(
        `Cannot disable ${name}: its active definition ${cfg.sourcePath} is no longer available. Reload and try again.`,
        "error",
      );
      return;
    }
    if (file) {
      const content = readFileSync(file.path, "utf-8");
      const { content: updated, outcome, error } = disableInContent(content);
      if (outcome === "already-disabled") {
        ctx.ui.notify(`${name} is already disabled.`, "info");
        return;
      }
      if (outcome === "no-frontmatter") {
        ctx.ui.notify(
          `Cannot disable ${name}: ${file.path} has no frontmatter block.`,
          "error",
        );
        return;
      }
      if (outcome === "invalid") {
        ctx.ui.notify(
          `Cannot disable ${name}: modified frontmatter is invalid${error ? ` (${error})` : ""}.`,
          "error",
        );
        return;
      }
      try {
        await atomicReplaceFile(file.path, updated, content);
      } catch (writeError: unknown) {
        ctx.ui.notify(
          `Cannot disable ${name}: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
          "error",
        );
        return;
      }
      reloadCustomAgents();
      const active = getAgentConfig(name);
      if (active?.sourcePath !== file.path || active.enabled !== false) {
        ctx.ui.notify(
          `Cannot disable ${name}: ${file.path} is no longer the active definition after reload.`,
          "error",
        );
        return;
      }
      ctx.ui.notify(`Disabled ${name} (${file.path})`, "info");
      return;
    }

    if (!cfg) {
      ctx.ui.notify(
        `Cannot disable ${name}: no active agent configuration.`,
        "error",
      );
      return;
    }

    // No active source file (normally an embedded default) — create a stub.
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project")
      ? projectAgentsDir(sessionCwd)
      : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(realpathSync(targetDir), `${name}.md`);
    const existing = existsSync(targetPath)
      ? readFileSync(targetPath, "utf-8")
      : undefined;
    if (existing !== undefined) {
      const overwrite = await ctx.ui.confirm(
        "Overwrite",
        `${targetPath} already exists. Overwrite it with a disable stub?`,
      );
      if (!overwrite) return;
    }
    try {
      if (existing === undefined)
        await atomicCreateFile(targetPath, "---\nenabled: false\n---\n");
      else
        await atomicReplaceFile(
          targetPath,
          "---\nenabled: false\n---\n",
          existing,
        );
    } catch (error: unknown) {
      ctx.ui.notify(
        `Cannot disable ${name}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }
    reloadCustomAgents();
    const active = getAgentConfig(name);
    if (active?.sourcePath !== targetPath || active.enabled !== false) {
      ctx.ui.notify(
        `Cannot disable ${name}: ${targetPath} did not become the active definition after reload.`,
        "error",
      );
      return;
    }
    ctx.ui.notify(`Disabled ${name} (${targetPath})`, "info");
  }

  /** Enable a disabled agent by removing enabled: false from its active source. */
  async function enableAgent(ctx: ExtensionCommandContext, name: string) {
    const cfg = getAgentConfig(name);
    const file = cfg ? activeAgentFile(name, cfg) : undefined;
    if (!file) {
      ctx.ui.notify(
        cfg?.sourcePath
          ? `Cannot enable ${name}: its active definition ${cfg.sourcePath} is no longer available. Reload and try again.`
          : `Cannot enable ${name}: no active file definition.`,
        "error",
      );
      return;
    }

    const content = readFileSync(file.path, "utf-8");
    const { content: updated, changed, error } = enableInContent(content);
    if (error) {
      ctx.ui.notify(
        `Cannot enable ${name}: modified frontmatter is invalid (${error}).`,
        "error",
      );
      return;
    }
    if (!changed && !isEmptyStub(updated)) {
      ctx.ui.notify(`${name} is not disabled in ${file.path}.`, "info");
      return;
    }

    if (isEmptyStub(updated)) {
      try {
        await removeFileIfUnchanged(file.path, content);
      } catch (writeError: unknown) {
        ctx.ui.notify(
          `Cannot enable ${name}: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
          "error",
        );
        return;
      }
      reloadCustomAgents();
      const active = getAgentConfig(name);
      if (active?.enabled === false) {
        ctx.ui.notify(
          `Cannot enable ${name}: ${file.path} is still disabled after reload.`,
          "error",
        );
        return;
      }
      ctx.ui.notify(`Enabled ${name} (removed ${file.path})`, "info");
    } else {
      try {
        await atomicReplaceFile(file.path, updated, content);
      } catch (writeError: unknown) {
        ctx.ui.notify(
          `Cannot enable ${name}: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
          "error",
        );
        return;
      }
      reloadCustomAgents();
      const active = getAgentConfig(name);
      if (active?.sourcePath !== file.path || active.enabled === false) {
        ctx.ui.notify(
          `Cannot enable ${name}: ${file.path} is no longer the active definition after reload.`,
          "error",
        );
        return;
      }
      ctx.ui.notify(`Enabled ${name} (${file.path})`, "info");
    }
  }

  function validateNewAgentName(input: string): string | undefined {
    const name = input.trim();
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return name;
    return undefined;
  }

  /**
   * Rewrite an existing agent definition with the model's help.
   *
   * `showGenerateWizard` covers creation; this is the other half. It runs under
   * the same guarantees: the child gets `AGENT_DEFINITION_GENERATION_OVERRIDE`,
   * a symbol-keyed zero-tool policy, so it cannot touch the file itself — it
   * returns text, the parent validates it, and only then does the parent commit
   * through `atomicReplaceFile` against the exact snapshot read before the run.
   * A concurrent editor can therefore only make the commit fail, never lose a
   * write.
   *
   * The rollback is the point. A model rewriting a working agent can make it
   * worse in ways that are not obvious from a diff, so the previous content is
   * held and offered back — this is `/agents` editing something the user
   * already depends on, not creating something new.
   */
  async function refineAgentFile(
    ctx: ExtensionCommandContext,
    name: string,
    path: string,
  ): Promise<void> {
    const before = readFileSync(path, "utf-8");

    const instruction = await ctx.ui.input(`What should change about ${name}?`);
    if (!instruction) return;

    ctx.ui.notify(`Refining ${name}...`, "info");

    const refinePrompt = `Revise this pi sub-agent definition file according to the request below.

REQUEST: "${instruction}"

CURRENT FILE:
\`\`\`markdown
${before}
\`\`\`

Return the complete revised file as your final response text only — the whole file, not a diff or a fragment. Do not call tools, write files, or ask the parent to write any path. The parent process validates the in-memory result and commits it itself.

Rules:
- Change only what the request calls for. Preserve every other frontmatter field and every part of the system prompt body that the request does not concern.
- Keep the same frontmatter format: a YAML block delimited by \`---\`, then the system prompt body.
- Do not add \`model:\` or \`thinking:\`; this project resolves models through tiers and the loader ignores those fields.
- Do not wrap the response in a markdown code fence. Return only the file contents.`;

    let record: AgentRecord;
    try {
      ({ record } = await manager.spawnAndWaitInternal(
        pi,
        ctx,
        "general-purpose",
        refinePrompt,
        { description: `Refine ${name} agent`, maxTurns: 5 },
        AGENT_DEFINITION_GENERATION_OVERRIDE,
      ));
    } catch (error: unknown) {
      ctx.ui.notify(
        `Refine failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      return;
    }

    if (record.status !== "completed") {
      ctx.ui.notify(
        `Refine failed: ${record.error ?? `agent ended with status ${record.status}`}`,
        "warning",
      );
      return;
    }

    const after = record.result ?? "";
    try {
      validateAgentFileContent(after);
    } catch (error: unknown) {
      ctx.ui.notify(
        `Refined definition is malformed, nothing was written: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      return;
    }

    if (after.trim() === before.trim()) {
      ctx.ui.notify(
        `${name} is unchanged — the model returned the same definition.`,
        "info",
      );
      return;
    }

    // Shown before writing: the user asked for a rewrite, not for it to be
    // applied sight-unseen. Line counts rather than a diff because there is no
    // diff renderer here, and a wrong-looking delta is the signal that matters.
    const beforeLines = before.split("\n").length;
    const afterLines = after.split("\n").length;
    const apply = await ctx.ui.confirm(
      `Apply refinement to ${name}?`,
      `${path}\n${beforeLines} lines → ${afterLines} lines. The previous version can be restored right after.`,
    );
    if (!apply) {
      ctx.ui.notify(`${name} left unchanged.`, "info");
      return;
    }

    try {
      await atomicReplaceFile(path, after, before);
    } catch (error: unknown) {
      ctx.ui.notify(
        `Cannot update ${path}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }
    reloadCustomAgents();

    // Offered immediately, while the previous content is still in hand and the
    // user can see what the reload produced. Declining is the normal answer;
    // the point is that accepting is one keystroke rather than a git operation.
    const rollback = await ctx.ui.confirm(
      `Keep the refined ${name}?`,
      `Updated ${path}. Choose No to restore the previous version.`,
    );
    if (rollback) {
      ctx.ui.notify(`Updated ${path}`, "info");
      return;
    }

    try {
      // Expect `after`, not `before`: this reverts THIS write. If something
      // else has since changed the file, the restore fails loudly rather than
      // discarding that edit too.
      await atomicReplaceFile(path, before, after);
      reloadCustomAgents();
      ctx.ui.notify(`Restored the previous ${name}.`, "info");
    } catch (error: unknown) {
      ctx.ui.notify(
        `Could not restore ${path} — it changed since the refinement was applied: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  async function showCreateWizard(ctx: ExtensionCommandContext) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project")
      ? projectAgentsDir(sessionCwd)
      : personalAgentsDir();

    const method = await ctx.ui.select("Creation method", [
      "Generate with Claude (recommended)",
      "Manual configuration",
    ]);
    if (!method) return;

    if (method.startsWith("Generate")) {
      await showGenerateWizard(ctx, targetDir);
    } else {
      await showManualWizard(ctx, targetDir);
    }
  }

  async function showGenerateWizard(
    ctx: ExtensionCommandContext,
    targetDir: string,
  ) {
    const description = await ctx.ui.input(
      "Describe what this agent should do",
    );
    if (!description) return;

    const rawName = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!rawName) return;
    const name = validateNewAgentName(rawName);
    if (!name) {
      ctx.ui.notify(
        "Agent name must be 1-64 letters, numbers, dots, underscores, or hyphens, starting with a letter or number.",
        "warning",
      );
      return;
    }

    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    // Capture the target before invoking another agent. The eventual commit uses
    // this exact snapshot, so a concurrent editor can only make the commit fail.
    const existing = existsSync(targetPath)
      ? readFileSync(targetPath, "utf-8")
      : undefined;
    if (existing !== undefined) {
      const overwrite = await ctx.ui.confirm(
        "Overwrite",
        `${targetPath} already exists. Overwrite?`,
      );
      if (!overwrite) return;
    }

    ctx.ui.notify("Generating agent definition...", "info");

    const generatePrompt = `Create a custom pi sub-agent definition file based on this description: "${description}"

Return the complete agent-definition markdown as your final response text only. Do not call tools, write files, create directories, or ask the parent to create any path. The parent process will validate the in-memory result, then commit it through atomicCreateFile or atomicReplaceFile.

The file format is a markdown file with YAML frontmatter and a system prompt body:

\`\`\`markdown
---
description: <one-line description shown in UI>
tools: <comma-separated built-in tools: read, bash, edit, write, grep, find, ls. Use "none" for no tools. Omit for all tools>
model: <optional model as "provider/modelId", e.g. "anthropic/claude-haiku-4-5". Omit to inherit parent model>
thinking: <optional thinking level: ${THINKING_LEVELS.join(", ")}. Omit to inherit>
max_turns: <optional max agentic turns. 0 or omit for unlimited (default)>
prompt_mode: <"replace" (body IS the full system prompt) or "append" (body is appended to default prompt). Default: replace>
extensions: <true (inherit all MCP/extension tools), false (none), or comma-separated names. Default: true>
skills: <true (inherit all), false (none), or comma-separated skill names to preload into prompt. Default: true>
disallowed_tools: <comma-separated tool names to block, even if otherwise available. Omit for none>
inherit_context: <true to fork parent conversation into agent so it sees chat history. Default: false>
run_in_background: <true to run in background by default. Default: false>
output_transcript: <false to write no transcript file or path for this agent. Independent of persist_session. Default: true>
isolated: <true for no extension/MCP tools, only built-in tools. Default: false>
memory: <"user" (global), "project" (per-project), or "local" (gitignored per-project) for persistent memory. Omit for none>
isolation: <"worktree" to run in isolated git worktree. Omit for normal>
---

<system prompt body — instructions for the agent>
\`\`\`

Guidelines for choosing settings:
- For read-only tasks (review, analysis): tools: read, bash, grep, find, ls
- For code modification tasks: include edit, write
- Use prompt_mode: append if the agent should keep the default system prompt and add specialization on top
- Use prompt_mode: replace for fully custom agents with their own personality/instructions
- Set inherit_context: true if the agent needs to know what was discussed in the parent conversation
- Set isolated: true if the agent should NOT have access to MCP servers or other extensions
- Set output_transcript: false to skip writing the agent's transcript; this alone doesn't keep the run off disk (persist_session, isolation: worktree commits, and memory still write) — set those too if that's the goal
- Only include frontmatter fields that differ from defaults — omit fields where the default is fine

Do not wrap the response in a markdown code fence. Return only the file contents.`;

    let record: AgentRecord;
    try {
      ({ record } = await manager.spawnAndWaitInternal(
        pi,
        ctx,
        "general-purpose",
        generatePrompt,
        {
          description: `Generate ${name} agent`,
          maxTurns: 5,
        },
        AGENT_DEFINITION_GENERATION_OVERRIDE,
      ));
    } catch (error: unknown) {
      ctx.ui.notify(
        `Generation failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      return;
    }

    if (record.status !== "completed") {
      ctx.ui.notify(
        `Generation failed: ${record.error ?? `agent ended with status ${record.status}`}`,
        "warning",
      );
      return;
    }

    let content: string;
    try {
      content = record.result ?? "";
      validateAgentFileContent(content);
    } catch (error: unknown) {
      ctx.ui.notify(
        `Generated agent definition is malformed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      return;
    }

    // The child has no file tools. The validated in-memory result is committed
    // atomically through atomicCreateFile or atomicReplaceFile below.
    try {
      if (existing === undefined) await atomicCreateFile(targetPath, content);
      else await atomicReplaceFile(targetPath, content, existing);
    } catch (error: unknown) {
      ctx.ui.notify(
        `Cannot create ${targetPath}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }

    reloadCustomAgents();
    ctx.ui.notify(`Created ${targetPath}`, "info");
  }

  async function showManualWizard(
    ctx: ExtensionCommandContext,
    targetDir: string,
  ) {
    // 1. Name
    const rawName = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!rawName) return;
    const name = validateNewAgentName(rawName);
    if (!name) {
      ctx.ui.notify(
        "Agent name must be 1-64 letters, numbers, dots, underscores, or hyphens, starting with a letter or number.",
        "warning",
      );
      return;
    }
    // 2. Description
    const description = await ctx.ui.input("Description (one line)");
    if (!description) return;

    // 3. Tools
    const toolChoice = await ctx.ui.select("Tools", [
      "all",
      "none",
      "read-only (read, bash, grep, find, ls)",
      "custom...",
    ]);
    if (!toolChoice) return;

    let tools: string;
    if (toolChoice === "all") {
      tools = BUILTIN_TOOL_NAMES.join(", ");
    } else if (toolChoice === "none") {
      tools = "none";
    } else if (toolChoice.startsWith("read-only")) {
      tools = "read, bash, grep, find, ls";
    } else {
      const customTools = await ctx.ui.input(
        "Tools (comma-separated)",
        BUILTIN_TOOL_NAMES.join(", "),
      );
      if (!customTools) return;
      tools = customTools;
    }

    // 4. Model
    const modelChoice = await ctx.ui.select("Model", [
      "inherit (parent model)",
      "haiku",
      "sonnet",
      "opus",
      "custom...",
    ]);
    if (!modelChoice) return;

    let model: string | undefined;
    if (modelChoice === "haiku") model = "anthropic/claude-haiku-4-5";
    else if (modelChoice === "sonnet") model = "anthropic/claude-sonnet-4-6";
    else if (modelChoice === "opus") model = "anthropic/claude-opus-4-6";
    else if (modelChoice === "custom...") {
      model = (await ctx.ui.input("Model (provider/modelId)")) || undefined;
    }

    // 5. Thinking
    // "inherit" is a UI-only pseudo-choice (omit the field); the rest mirror pi.
    const thinkingChoice = await ctx.ui.select("Thinking level", [
      "inherit",
      ...THINKING_LEVELS,
    ]);
    if (!thinkingChoice) return;

    const thinking = thinkingChoice === "inherit" ? undefined : thinkingChoice;

    // 6. System prompt
    const systemPrompt = await ctx.ui.editor("System prompt", "");
    if (systemPrompt === undefined) return;

    const content = buildNewAgentFile({
      description,
      tools,
      model,
      thinking,
      systemPrompt,
    });

    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${name}.md`);
    const existing = existsSync(targetPath)
      ? readFileSync(targetPath, "utf-8")
      : undefined;

    if (existing !== undefined) {
      const overwrite = await ctx.ui.confirm(
        "Overwrite",
        `${targetPath} already exists. Overwrite?`,
      );
      if (!overwrite) return;
    }

    try {
      if (existing === undefined) await atomicCreateFile(targetPath, content);
      else await atomicReplaceFile(targetPath, content, existing);
    } catch (error: unknown) {
      ctx.ui.notify(
        `Cannot create ${targetPath}: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }
    reloadCustomAgents();
    ctx.ui.notify(`Created ${targetPath}`, "info");
  }

  function snapshotSettings() {
    return {
      maxConcurrent: manager.getMaxConcurrent(),
      // 0 = unlimited — per SubagentsSettings.defaultMaxTurns docstring and
      // normalizeMaxTurns() in agent-runner.ts (which maps 0 → undefined).
      defaultMaxTurns: getDefaultMaxTurns() ?? 0,
      graceTurns: getGraceTurns(),
      defaultMaxTokens: getDefaultMaxTokens(),
      defaultMaxToolCalls: getDefaultMaxToolCalls(),
      defaultToolTimeoutMs: getDefaultToolTimeoutMs(),
      defaultJoinMode: getDefaultJoinMode(),
      // `"inherit"` is written out verbatim so a project can cancel a global
      // default; never configured stays undefined, which JSON.stringify drops.
      defaultModel: getDefaultModel(),
      schedulingEnabled: isSchedulingEnabled(),
      scopeModels: isScopeModelsEnabled(),
      strictAgentFiles,
      disableDefaultAgents: isDefaultsDisabled(),
      toolDescriptionMode: getToolDescriptionMode(),
      fleetView: isFleetViewEnabled(),
      outputTranscript: getOutputTranscriptDefault(),
      rememberAgents: manager.getRememberAgents(),
      agentMentions: getAgentMentionMode(),
      supervisorQuestions: isSupervisorQuestionsEnabled(),
      worktreeIsolation: isWorktreeIsolationEnabled(),
      maxSubagentDepth: getMaxSubagentDepth(),
      maxSubagentSpawnsPerBranch: manager.getMaxSubagentSpawnsPerBranch(),
      ...(Object.keys(getWorkflowSettings().tiers ?? {}).length > 0 ||
      getWorkflowSettings().defaultTier !== undefined ||
      getWorkflowSettings().blockedDefaultTier === true ||
      (getWorkflowSettings().blockedTiers?.length ?? 0) > 0
        ? { workflow: getWorkflowSettings() }
        : {}),
      // Same shape as the workflow block above: written back only when the user
      // actually configured tiers, so the snapshot never materializes an empty
      // catalogue — or the shipped `fast` fallback — into the project settings
      // file.
      ...(Object.keys(getAgentTiersConfiguredSettings().profiles ?? {}).length >
        0 ||
      getAgentTiersConfiguredSettings().defaultTier !== undefined ||
      getAgentTiersConfiguredSettings().blockedDefaultTier === true ||
      (getAgentTiersConfiguredSettings().blockedProfiles?.length ?? 0) > 0
        ? { agentTiers: getAgentTiersConfiguredSettings() }
        : {}),
      // Deliberately NOT `?? "general-purpose"`: every settings change writes the
      // whole snapshot, and materializing the implicit default would turn it into
      // explicit configuration — which then fails loudly if general-purpose later
      // goes away. undefined is dropped by JSON.stringify.
      fallbackSubagent: getFallbackSubagent(),
    } satisfies SubagentsSettings;
  }

  // Keep whole-object settings snapshots complete: a newly-added optional field
  // must not silently disappear when an unrelated setting is changed.
  type _NoMissingSettingsKeys =
    Exclude<
      keyof SubagentsSettings,
      keyof ReturnType<typeof snapshotSettings>
    > extends never
      ? true
      : ["snapshotSettings() is missing a SubagentsSettings key"];
  const _settingsSnapshotIsComplete: _NoMissingSettingsKeys = true;
  void _settingsSnapshotIsComplete;

  const NUMERIC_IDS = new Set([
    "maxConcurrent",
    "defaultMaxTurns",
    "graceTurns",
    "maxSubagentDepth",
    "maxSubagentSpawnsPerBranch",
    "defaultMaxTokens",
    "defaultMaxToolCalls",
  ]);
  /**
   * Settings whose value is chosen in a dialog rather than cycled in place.
   * Enter closes the list and reopens it once the dialog resolves, the same way
   * the numeric fields hand off to a text prompt.
   */
  const PICKER_IDS = new Set(["defaultModel"]);
  /** Row value standing in for "no default tier configured". Not a tier key — keys reject whitespace, not words. */
  const NO_DEFAULT_TIER = "none";
  /** Menu entry that starts a new tier instead of editing an existing one. */
  const NEW_TIER_ENTRY = "+ New tier...";

  /**
   * Ask for a model reference: this machine's models, plus `inherit` and a
   * typed escape hatch.
   *
   * The escape hatch is not decoration — the settings file accepts references
   * this machine cannot resolve, which is exactly what a shared project config
   * naming a provider only some teammates have authed looks like. A picker able
   * to express only what is available here would be weaker than the file it
   * writes.
   *
   * With `scopeModels` on and a scope configured, the list narrows to that
   * scope: offering a model the same setting would warn about on every spawn is
   * a menu arguing with itself.
   */
  async function pickModelReference(
    ctx: ExtensionCommandContext,
    title: string,
    current: string | undefined,
  ): Promise<string | undefined> {
    const CUSTOM = "custom...";
    const candidates =
      isScopeModelsEnabled() && ctx.scopedModels.length > 0
        ? ctx.scopedModels.map((scoped) => scoped.model)
        : ctx.modelRegistry.getAvailable();
    const refs = [
      ...new Set(candidates.map((m) => `${m.provider}/${m.id}`)),
    ].sort((a, b) => a.localeCompare(b));

    const choice = await ctx.ui.select(title, ["inherit", ...refs, CUSTOM]);
    if (!choice) return undefined;
    if (choice !== CUSTOM) return choice;

    const typed = await ctx.ui.input(
      "Model (provider/modelId, or inherit)",
      current ?? "",
    );
    const trimmed = typed?.trim();
    if (!trimmed) return undefined;
    if (!isModelReference(trimmed)) {
      // Refuse here rather than at save: saveSettings drops unrecognized fields
      // silently, which would show a success toast for a setting that vanished.
      ctx.ui.notify(
        `"${trimmed}" is not a model reference. Use provider/modelId, or inherit.`,
        "warning",
      );
      return undefined;
    }
    return trimmed;
  }

  async function pickDefaultModel(ctx: ExtensionCommandContext) {
    const chosen = await pickModelReference(
      ctx,
      "Default model",
      getDefaultModel(),
    );
    if (chosen === undefined) return;
    setDefaultModel(chosen);
    notifyApplied(
      ctx,
      chosen === "inherit"
        ? "Default model set to inherit — subagents follow the parent session."
        : `Default model set to ${chosen}. Applies to spawns where no tier picks a model.`,
    );
  }

  /**
   * /agents → Diagnostics: a self-check of the extension's health surface.
   * Each check is cheap and read-only; failures are listed with a hint rather
   * than fixed silently, because every fix touches configuration the user
   * owns.
   */
  async function showDiagnostics(ctx: ExtensionCommandContext) {
    const lines: string[] = [];
    const problem = (label: string, detail: string) =>
      lines.push(`✗ ${label}: ${detail}`);
    const ok = (label: string, detail?: string) =>
      lines.push(`✓ ${label}${detail ? `: ${detail}` : ""}`);

    // 1. Agent directory readability + malformed files (already surfaced as
    //    warnings at load; re-run the loader in warn mode and report the count).
    const dirs = [
      join(sessionCwd, ".pi", "agents"),
      join(sessionCwd, ".agents", "agents"),
      join(getAgentDir(), "agents"),
    ];
    // A directory that does not exist is the normal state, not a fault: most
    // projects define agents in one of these three places, so counting absence
    // as "unreadable" reported a permissions problem on every healthy
    // workspace and buried the real ones.
    const present = dirs.filter((dir) => existsSync(dir));
    const unreadable = present.filter((dir) => {
      try {
        readdirSync(dir);
        return false;
      } catch {
        return true;
      }
    });
    if (unreadable.length === 0) {
      ok(
        "agent directories",
        `${present.length} of ${dirs.length} present, all readable`,
      );
    } else {
      for (const dir of unreadable)
        problem(
          "agent directories",
          `${dir} is unreadable (check permissions)`,
        );
    }

    // 1b. Files that are present but did not become agents. Load warnings are
    //     emitted once per session at load time and scroll away; this is the
    //     surface that still answers "why isn't my agent here?" an hour later.
    //     Counted rather than re-parsed: the loader owns the reasons, and
    //     re-running it in strict mode here would throw on the first bad file
    //     instead of reporting all of them.
    let markdownFiles = 0;
    for (const dir of dirs) {
      try {
        if (existsSync(dir))
          markdownFiles += readdirSync(dir).filter((f) =>
            f.endsWith(".md"),
          ).length;
      } catch {
        /* unreadable directories are already reported above */
      }
    }
    // Only agents that came from a file: the built-in defaults have no file
    // behind them, so counting them would make the denominator meaningless and
    // hide a whole directory that failed to load.
    const loadedFromFiles = getAllTypes().filter((name) => {
      const source = getAgentConfig(name)?.source;
      return source === "project" || source === "global";
    }).length;
    if (markdownFiles <= loadedFromFiles) {
      ok(
        "agent files",
        `${loadedFromFiles} loaded from ${markdownFiles} file(s)`,
      );
    } else {
      problem(
        "agent files",
        `${markdownFiles - loadedFromFiles} of ${markdownFiles} file(s) did not load` +
          ' — malformed frontmatter, a reserved ":" in `name:`, or shadowed by a higher-priority file',
      );
    }

    // 2. Tier reference problems (unknown tiers named by agents or default).
    const tierProblems = findUnknownAgentTierReferences(
      getAgentTiersSettings(),
      new Map(
        getAvailableTypes()
          .map((name): [string, string | undefined] => [
            name,
            getAgentConfig(name)?.agentTier,
          ])
          .filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    );
    if (tierProblems.length === 0) {
      ok("tier references", "all agent tiers resolve");
    } else {
      for (const tierProblem of tierProblems.slice(0, 5)) {
        problem("tier references", tierProblem);
      }
      if (tierProblems.length > 5)
        problem("tier references", `...and ${tierProblems.length - 5} more`);
    }

    // 2b. Tier LIVENESS, not just reference validity. A tier can name a model
    //     that resolves as a string (no registry entry, or no auth configured)
    //     and the reference check above still passes — the tier exists and
    //     agents point at it. The failure only appears at the first spawn that
    //     uses it, which is minutes into a task. Probe it here instead, while
    //     the fix is obvious and nothing has run.
    const tierSettings = getAgentTiersSettings();
    const deadTiers: string[] = [];
    let liveTiers = 0;
    for (const key of listAgentTierKeys(tierSettings)) {
      const model = tierSettings.profiles?.[key]?.model;
      // `inherit` is the whole point of a provider-neutral default: it resolves
      // to the parent session's model, so there is nothing to probe.
      if (model === undefined || model === "inherit") {
        liveTiers++;
        continue;
      }
      const resolved = resolveModel(model, ctx.modelRegistry);
      if (typeof resolved === "string")
        deadTiers.push(`${key} → ${model} (${resolved})`);
      else liveTiers++;
    }
    if (deadTiers.length === 0) {
      ok("tier models", `${liveTiers} tier(s) resolve to a live model`);
    } else {
      for (const dead of deadTiers.slice(0, 5)) problem("tier models", dead);
      if (deadTiers.length > 5)
        problem("tier models", `...and ${deadTiers.length - 5} more`);
    }

    // 3. enabledModels ∩ tier models: a tier naming a model outside the
    //    scoped set would fail the scope check at spawn time.
    if (isScopeModelsEnabled()) {
      const enabled = resolveEnabledModels(
        readEnabledModels(sessionCwd),
        ctx.modelRegistry,
        sessionCwd,
      );
      if (enabled === undefined || enabled.size === 0) {
        problem(
          "model scope",
          "scoping is on but enabledModels resolves to an empty set — every spawn will be refused",
        );
      } else {
        ok("model scope", `${enabled.size} enabled model(s)`);
      }
    } else {
      ok("model scope", "disabled (no scoping enforced)");
    }

    // 4. Scheduler lock liveness.
    if (isSchedulingEnabled()) {
      if (scheduler.isActive()) {
        ok("scheduler", "active");
      } else {
        problem(
          "scheduler",
          "scheduling is enabled but the scheduler is not active — jobs will not fire",
        );
      }
    } else {
      ok("scheduler", "disabled");
    }

    // 5. Protocol version match with pi-workflows.
    ok("protocol", `v${PROTOCOL_VERSION} managed spawn`);

    // 6. Scheduler store health when active.
    if (scheduler.isActive()) {
      const jobCount = scheduler.list().length;
      ok("scheduled jobs", `${jobCount} registered`);
    }

    ctx.ui.notify(lines.join("\n") || "All diagnostics passed.", "info");
  }

  async function showSettings(ctx: ExtensionCommandContext) {
    function buildItems(): SettingItem[] {
      const mc = manager.getMaxConcurrent();
      const dmt = getDefaultMaxTurns() ?? 0;
      const gt = getGraceTurns();
      const msd = getMaxSubagentDepth();
      // Label what unset actually does — it targets general-purpose even when
      // that is unregistered (the permissive hardcoded tier), so showing "none"
      // there would advertise strict dispatch for the most permissive state.
      // `values` still offers only resolvable targets, so the user cannot
      // persist a fallback that would hard-error on every dispatch.
      const fallbackValue = getFallbackSubagent() ?? "general-purpose";
      const fallbackValues = [
        ...new Set([...getAvailableTypes(), NO_FALLBACK]),
      ];
      const defaultModelLabel = describeModelReference(
        getDefaultModel(),
        ctx.modelRegistry,
      );
      const tierKeys = listAgentTierKeys(getAgentTiersSettings());

      return [
        {
          id: "maxConcurrent",
          label: "Max concurrency",
          description: "Max concurrent background agents (Enter to type)",
          currentValue: String(mc),
          values: [String(mc)],
        },
        {
          id: "defaultMaxTurns",
          label: "Default max turns",
          description:
            "Default max turns before wrap-up (0 = unlimited, Enter to type)",
          currentValue: String(dmt),
          values: [String(dmt)],
        },
        {
          id: "graceTurns",
          label: "Grace turns",
          description: "Grace turns after wrap-up steer (Enter to type)",
          currentValue: String(gt),
          values: [String(gt)],
        },
        {
          id: "defaultMaxTokens",
          label: "Token budget",
          description:
            "Token budget per subagent run — wrap-up steer at 80%, abort at 100% (0 = unlimited, Enter to type)",
          currentValue: String(getDefaultMaxTokens()),
          values: [String(getDefaultMaxTokens())],
        },
        {
          id: "defaultMaxToolCalls",
          label: "Tool-call budget",
          description:
            "Tool calls per subagent run — wrap-up steer at 80%, abort at 100% (0 = unlimited, Enter to type)",
          currentValue: String(getDefaultMaxToolCalls()),
          values: [String(getDefaultMaxToolCalls())],
        },
        {
          id: "maxSubagentDepth",
          label: "Nested depth",
          description:
            "Hard cap on nested delegation — main is 0, its subagents 1 (0/1 = nesting off, Enter to type)",
          currentValue: String(msd),
          values: [String(msd)],
        },
        {
          id: "maxSubagentSpawnsPerBranch",
          label: "Nested spawn budget",
          description:
            "Cumulative descendants one top-level agent may start — the horizontal bound the depth cap does not provide (min 1, Enter to type)",
          currentValue: String(manager.getMaxSubagentSpawnsPerBranch()),
          values: [String(manager.getMaxSubagentSpawnsPerBranch())],
        },
        {
          id: "defaultModel",
          label: "Default model",
          description:
            'Model a subagent runs when no tier applies (Enter to choose). "inherit" follows the parent session. A tier always wins over this.',
          currentValue: defaultModelLabel,
          // Single-value list: the real choice is a picker, opened on Enter,
          // because cycling a registry of models one keypress at a time is not
          // a usable way to pick one.
          values: [defaultModelLabel],
        },
        {
          id: "defaultTier",
          label: "Default tier",
          description:
            tierKeys.length > 0
              ? "Tier applied when neither the caller nor the agent names one. Edit the tiers themselves in /agents → Model tiers."
              : "No tiers defined yet — create one in /agents → Model tiers.",
          currentValue: getAgentTiersSettings().defaultTier ?? NO_DEFAULT_TIER,
          values: [NO_DEFAULT_TIER, ...tierKeys],
        },
        {
          id: "joinMode",
          label: "Join mode",
          description: "Default join mode for background agents",
          currentValue: getDefaultJoinMode(),
          values: ["smart", "async", "group"],
        },
        {
          id: "schedulingEnabled",
          label: "Scheduling",
          description:
            "Schedule subagent feature (off removes `schedule` param from Agent tool spec on next pi session)",
          currentValue: isSchedulingEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "scopeModels",
          label: "Scope models",
          description:
            "Validate subagent models against scoped models (/scoped-models)",
          currentValue: isScopeModelsEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "strictAgentFiles",
          label: "Strict agent files",
          description:
            "Fail startup on unreadable or unparseable agent files instead of skipping them",
          currentValue: strictAgentFiles ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "disableDefaultAgents",
          label: "Disable defaults",
          description:
            "Hide built-in agents (general-purpose, Explore, Plan) — custom agents are unaffected",
          currentValue: isDefaultsDisabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "fallbackSubagent",
          label: "Fallback agent",
          description: `Agent used when subagent_type is unknown, disabled, or ambiguous; "${NO_FALLBACK}" rejects the call instead (strict dispatch)`,
          currentValue: fallbackValue,
          values: fallbackValues,
        },
        {
          id: "outputTranscript",
          label: "Output transcript",
          description:
            "Write each subagent's .output transcript by default. A custom agent's output_transcript frontmatter overrides this.",
          currentValue: getOutputTranscriptDefault() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "fleetView",
          label: "Fleet view",
          description:
            "Claude Code-style main and subagents list below the editor (down or left to navigate, Enter to view)",
          currentValue: isFleetViewEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "rememberAgents",
          label: "Remember agents",
          description:
            "Keep evicted agents addressable for @handle reopen (off forgets them entirely)",
          currentValue: manager.getRememberAgents() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "agentMentions",
          label: "Agent mentions",
          description:
            "How `@handle message` is dispatched: model (an off-screen clone of this conversation writes the new agent's prompt), direct (start it from the typed text), or off (send the text to the main model verbatim). Messaging and resuming an existing agent are always direct.",
          currentValue: getAgentMentionMode(),
          values: [...AGENT_MENTION_MODES],
        },
        {
          id: "supervisorQuestions",
          label: "Supervisor questions",
          description:
            "Let a subagent interrupt with `contact_supervisor` to ask you a question it cannot decide itself (off withholds the tool)",
          currentValue: isSupervisorQuestionsEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "toolDescriptionMode",
          label: "Tool description",
          description:
            "Agent tool description sent to the LLM: full (rich, default), compact (~75% fewer tokens, for small/local models), or custom (.pi/agent-tool-description.md with {{placeholders}})",
          currentValue: getToolDescriptionMode(),
          values: ["full", "compact", "custom"],
        },
      ];
    }

    function applyValue(id: string, value: string) {
      if (id === "maxConcurrent") {
        const n = parseInt(value, 10);
        if (n >= 1) {
          manager.setMaxConcurrent(n);
          notifyApplied(ctx, `Max concurrency set to ${n}`);
        }
      } else if (id === "defaultMaxTurns") {
        const n = parseInt(value, 10);
        if (n === 0) {
          setDefaultMaxTurns(undefined);
          notifyApplied(ctx, "Default max turns set to unlimited");
        } else if (n >= 1) {
          setDefaultMaxTurns(n);
          notifyApplied(ctx, `Default max turns set to ${n}`);
        }
      } else if (id === "graceTurns") {
        const n = parseInt(value, 10);
        if (n >= 1) {
          setGraceTurns(n);
          notifyApplied(ctx, `Grace turns set to ${n}`);
        }
      } else if (id === "maxSubagentDepth") {
        const n = parseInt(value, 10);
        if (n >= 0) {
          setMaxSubagentDepth(n);
          notifyApplied(
            ctx,
            n <= 1
              ? "Nested delegation disabled"
              : `Nested depth set to ${n}. Applies to agents started from now on.`,
          );
        }
      } else if (id === "defaultMaxTokens") {
        const n = parseInt(value, 10);
        if (n >= 0) {
          setDefaultMaxTokens(n);
          notifyApplied(
            ctx,
            n === 0
              ? "Token budget set to unlimited"
              : `Token budget set to ${n} per run`,
          );
        }
      } else if (id === "defaultMaxToolCalls") {
        const n = parseInt(value, 10);
        if (n >= 0) {
          setDefaultMaxToolCalls(n);
          notifyApplied(
            ctx,
            n === 0
              ? "Tool-call budget set to unlimited"
              : `Tool-call budget set to ${n} per run`,
          );
        }
      } else if (id === "maxSubagentSpawnsPerBranch") {
        const n = parseInt(value, 10);
        if (n >= 1) {
          manager.setMaxSubagentSpawnsPerBranch(n);
          notifyApplied(
            ctx,
            `Nested spawn budget set to ${n} per top-level agent`,
          );
        }
      } else if (id === "defaultTier") {
        const tier = value === NO_DEFAULT_TIER ? undefined : value;
        setAgentTiersSettings(
          setDefaultAgentTier(getAgentTiersSettings(), tier),
        );
        notifyApplied(
          ctx,
          tier === undefined
            ? "Default tier cleared. Spawns that name no tier use the default model."
            : `Default tier set to ${tier}. The tool description updates on the next pi session.`,
        );
      } else if (id === "joinMode") {
        setDefaultJoinMode(value as JoinMode);
        notifyApplied(ctx, `Default join mode set to ${value}`);
      } else if (id === "schedulingEnabled") {
        const enabled = value === "on";
        if (enabled === isSchedulingEnabled()) {
          ctx.ui.notify(
            `Scheduling already ${enabled ? "enabled" : "disabled"}.`,
            "info",
          );
        } else {
          setSchedulingEnabled(enabled);
          if (!enabled) scheduler.stop(); // immediate kill — outstanding fires stop ticking
          notifyApplied(
            ctx,
            `Scheduling ${enabled ? "enabled" : "disabled"}. Tool spec change takes effect on next pi session.`,
          );
        }
      } else if (id === "scopeModels") {
        const enabled = value === "on";
        setScopeModelsEnabled(enabled);
        notifyApplied(ctx, `Scope models ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "strictAgentFiles") {
        const enabled = value === "on";
        strictAgentFiles = enabled;
        notifyApplied(
          ctx,
          `Strict agent files ${enabled ? "enabled" : "disabled"}. Takes effect on next pi session.`,
        );
      } else if (id === "disableDefaultAgents") {
        const enabled = value === "on";
        setDisableDefaultAgents(enabled);
        notifyApplied(
          ctx,
          `Default agents ${enabled ? "disabled" : "enabled"}. Tool spec change takes effect on next pi session.`,
        );
      } else if (id === "fallbackSubagent") {
        setFallbackSubagent(value);
        notifyApplied(
          ctx,
          value === NO_FALLBACK
            ? "Unknown or disabled agent types will now be rejected"
            : `Unknown agent types will fall back to ${value}`,
        );
      } else if (id === "outputTranscript") {
        const enabled = value === "on";
        setOutputTranscriptDefault(enabled);
        notifyApplied(
          ctx,
          `Output transcript ${enabled ? "enabled" : "disabled"} by default`,
        );
      } else if (id === "toolDescriptionMode") {
        setToolDescriptionMode(value as ToolDescriptionMode);
        notifyApplied(
          ctx,
          `Tool description set to ${value}. Takes effect on next pi session.`,
        );
      } else if (id === "fleetView") {
        const enabled = value === "on";
        setFleetViewEnabled(enabled);
        notifyApplied(ctx, `Fleet view ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "rememberAgents") {
        const enabled = value === "on";
        manager.setRememberAgents(enabled);
        notifyApplied(
          ctx,
          `Remember agents ${enabled ? "enabled" : "disabled"}`,
        );
      } else if (id === "supervisorQuestions") {
        const enabled = value === "on";
        supervisorQuestionsEnabled = enabled;
        manager.setSupervisorQuestions(enabled);
        notifyApplied(ctx, `Supervisor questions ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "agentMentions") {
        agentMentionMode = value as AgentMentionMode;
        notifyApplied(
          ctx,
          `Agent mentions set to ${agentMentionMode}`,
        );
      }
    }

    let list: SettingsList;
    // Track current selection index directly (SettingsList doesn't expose it).
    // Updated on arrow keys so Enter knows which field is selected immediately.
    let currentIndex = 0;

    const result = await wrapCustomUi(ctx.ui).custom<string | undefined>(
      (_tui, _theme, _kb, done) => {
        const items = buildItems();

        list = new SettingsList(
          items,
          items.length + 2,
          getSettingsListTheme(),
          (id, newValue) => {
            applyValue(id, newValue);
          },
          () => done(undefined as undefined),
        );

        const container = new Container();
        container.addChild(new Text("Subagent settings", 0, 0));
        container.addChild(new Spacer(1));
        container.addChild(list);

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            // Track navigation so Enter knows the current field
            if (matchesKey(data, "up")) {
              currentIndex = Math.max(0, currentIndex - 1);
            } else if (matchesKey(data, "down")) {
              currentIndex = Math.min(items.length - 1, currentIndex + 1);
            }

            // Enter on a numeric or picker field → close and open its dialog
            const focusedId = items[currentIndex].id;
            if (
              matchesKey(data, Key.enter) &&
              (NUMERIC_IDS.has(focusedId) || PICKER_IDS.has(focusedId))
            ) {
              done(focusedId);
              return;
            }
            list.handleInput?.(data);
          },
        };
      },
    );

    if (result === "defaultModel") {
      await pickDefaultModel(ctx);
      await showSettings(ctx);
      return;
    }

    // If a numeric field ID was returned, prompt for typed input
    if (result && NUMERIC_IDS.has(result)) {
      const current =
        result === "maxConcurrent"
          ? String(manager.getMaxConcurrent())
          : result === "defaultMaxTurns"
            ? String(getDefaultMaxTurns() ?? 0)
            : result === "maxSubagentDepth"
              ? String(getMaxSubagentDepth())
              : result === "defaultMaxTokens"
                ? String(getDefaultMaxTokens())
                : result === "defaultMaxToolCalls"
                  ? String(getDefaultMaxToolCalls())
                  : String(getGraceTurns());

      const label =
        result === "maxConcurrent"
          ? "Max concurrency (1+)"
          : result === "defaultMaxTurns"
            ? "Default max turns (0 = unlimited)"
            : result === "maxSubagentDepth"
              ? "Nested depth (0/1 = nesting off)"
              : result === "defaultMaxTokens"
                ? "Token budget (0 = unlimited)"
                : result === "defaultMaxToolCalls"
                  ? "Tool-call budget (0 = unlimited)"
                  : "Grace turns (1+)";

      // Loop until user enters a valid integer or cancels (Esc / null).
      // Silently trims whitespace; rejects non-numeric input by re-prompting.
      let input: string | undefined = await ctx.ui.input(label, current);
      while (input != null) {
        const trimmed = input.trim();
        const n = Number(trimmed);
        if (trimmed !== "" && Number.isInteger(n)) {
          applyValue(result, String(n));
          await showSettings(ctx);
          return;
        }
        // Invalid — re-prompt with the user's last entry so they can edit it
        input = await ctx.ui.input(label, trimmed);
      }
    }
  }

  // ---- /agents → Model tiers ----
  //
  // The catalogue only; `defaultTier` stays in Settings next to the other
  // defaults. Every mutation here goes through the pure helpers in
  // agent-tiers.ts, so the rules that outlive a menu — retiring a tombstone,
  // never leaving `defaultTier` pointing at a deleted tier — are tested without
  // a terminal.

  /** One catalogue row: what the tier resolves to on this machine. */
  function describeTierRow(key: string, ctx: ExtensionCommandContext): string {
    const settings = getAgentTiersSettings();
    const profile = settings.profiles?.[key];
    if (!profile)
      return `${key} — blocked (malformed profile in subagents.json)`;
    const suffix = settings.defaultTier === key ? " (default)" : "";
    const model = describeModelReference(profile.model, ctx.modelRegistry);
    return `${key} — ${model} · thinking ${profile.thinking}${suffix}`;
  }

  /**
   * Ask for a tier's thinking level, offering only what its model supports.
   *
   * A model with no thinking support at all leaves `inherit` as the single
   * honest answer, so it is stored without a one-item menu to click through.
   */
  async function pickTierThinking(
    ctx: ExtensionCommandContext,
    modelRef: string,
    current?: TierThinking,
  ): Promise<TierThinking | undefined> {
    const levels = offerableTierThinking(modelRef, ctx.modelRegistry);
    if (levels.length === 1) {
      ctx.ui.notify(
        `${describeModelReference(modelRef, ctx.modelRegistry)} supports no thinking levels — storing "inherit".`,
        "info",
      );
      return "inherit";
    }
    const choice = await ctx.ui.select(
      current ? `Thinking level (now ${current})` : "Thinking level",
      levels,
    );
    return choice as TierThinking | undefined;
  }

  /** Write one profile and report it, naming the delay the tool description has. */
  function saveTierProfile(
    ctx: ExtensionCommandContext,
    key: string,
    profile: AgentTierProfile,
    verb: string,
  ) {
    setAgentTiersSettings(
      upsertAgentTierProfile(getAgentTiersSettings(), key, profile),
    );
    notifyApplied(
      ctx,
      `Tier "${key}" ${verb}. The Agent tool description updates on the next pi session.`,
    );
  }

  /**
   * Define a tier from scratch.
   *
   * `presetKey` skips the name prompt: redefining a blocked tier already knows
   * which name it is fixing, and asking again invites a typo that would leave
   * the tombstone in place next to a near-miss twin.
   */
  async function createTier(ctx: ExtensionCommandContext, presetKey?: string) {
    const rawKey =
      presetKey ?? (await ctx.ui.input("Tier name (one word, no spaces)"));
    if (!rawKey) return;
    const key = rawKey.trim();
    if (!isValidAgentTierKey(key)) {
      ctx.ui.notify(
        `"${key}" is not a tier name. Use one word, no whitespace, at most ${MAX_AGENT_TIER_KEY_LENGTH} characters.`,
        "warning",
      );
      return;
    }
    if (getAgentTiersSettings().profiles?.[key]) {
      ctx.ui.notify(
        `Tier "${key}" already exists. Pick it from the list to edit it.`,
        "warning",
      );
      return;
    }

    const model = await pickModelReference(
      ctx,
      `Model for "${key}"`,
      undefined,
    );
    if (model === undefined) return;
    const thinking = await pickTierThinking(ctx, model);
    if (thinking === undefined) return;
    // Description is what the host agent reads when choosing between tiers, so
    // it is prose about the job, not about the model. Blank falls back to the key.
    const description = await ctx.ui.input(
      `What is "${key}" for? (shown to the model, optional)`,
    );

    const trimmed = description?.trim();
    saveTierProfile(
      ctx,
      key,
      { model, thinking, ...(trimmed ? { description: trimmed } : {}) },
      "created",
    );
  }

  async function editTier(ctx: ExtensionCommandContext, key: string) {
    const profile = getAgentTiersSettings().profiles?.[key];
    if (!profile) {
      // A blocked key has no profile to edit; redefining it is the documented
      // fix, and upsert retires the tombstone in the same write.
      const redefine = await ctx.ui.confirm(
        "Blocked tier",
        `"${key}" was dropped as malformed. Define it again to unblock it?`,
      );
      if (redefine) await createTier(ctx, key);
      return;
    }

    const MODEL = "Model";
    const THINKING = "Thinking";
    const DESCRIPTION = "Description";
    const DELETE = "Delete tier";
    const choice = await ctx.ui.select(`Tier "${key}"`, [
      MODEL,
      THINKING,
      DESCRIPTION,
      DELETE,
    ]);
    if (!choice) return;

    if (choice === MODEL) {
      const model = await pickModelReference(
        ctx,
        `Model for "${key}"`,
        profile.model,
      );
      if (model === undefined) return;
      saveTierProfile(ctx, key, { ...profile, model }, `now runs ${model}`);
    } else if (choice === THINKING) {
      const thinking = await pickTierThinking(
        ctx,
        profile.model,
        profile.thinking,
      );
      if (thinking === undefined) return;
      saveTierProfile(
        ctx,
        key,
        { ...profile, thinking },
        `now thinks ${thinking}`,
      );
    } else if (choice === DESCRIPTION) {
      const description = await ctx.ui.input(
        `What is "${key}" for?`,
        profile.description ?? "",
      );
      if (description === undefined) return;
      const trimmed = description.trim();
      const { description: _dropped, ...rest } = profile;
      saveTierProfile(
        ctx,
        key,
        { ...rest, ...(trimmed ? { description: trimmed } : {}) },
        "description updated",
      );
    } else if (choice === DELETE) {
      const wasDefault = getAgentTiersSettings().defaultTier === key;
      const confirmed = await ctx.ui.confirm(
        "Delete tier",
        wasDefault
          ? `Delete "${key}"? It is the default tier, so the default is cleared too.`
          : `Delete "${key}"? Agents whose frontmatter names it will fail to spawn until you fix them.`,
      );
      if (!confirmed) return;
      setAgentTiersSettings(
        removeAgentTierProfile(getAgentTiersSettings(), key),
      );
      notifyApplied(
        ctx,
        wasDefault
          ? `Tier "${key}" deleted and the default tier cleared.`
          : `Tier "${key}" deleted.`,
      );
    }
  }

  async function showModelTiersMenu(ctx: ExtensionCommandContext) {
    const settings = getAgentTiersSettings();
    // Blocked keys are listed alongside defined ones: they are the entries most
    // in need of attention, and hiding them would leave a tier that refuses
    // every spawn invisible in the menu that exists to manage tiers.
    const keys = [
      ...new Set([
        ...listAgentTierKeys(settings),
        ...(settings.blockedProfiles ?? []),
      ]),
    ].sort((a, b) => a.localeCompare(b));

    const rows = keys.map((key) => describeTierRow(key, ctx));
    const choice = await ctx.ui.select("Model tiers", [
      ...rows,
      NEW_TIER_ENTRY,
    ]);
    if (!choice) return;

    if (choice === NEW_TIER_ENTRY) await createTier(ctx);
    else await editTier(ctx, keys[rows.indexOf(choice)]);

    await showModelTiersMenu(ctx);
  }

  // Persist the current snapshot, emit `subagents:settings_changed`, and surface
  // the right toast. Successful saves show info; persistence failures downgrade
  // to warning so users aren't silently reverted on restart. Event fires regardless
  // of outcome so listeners see the in-memory change.
  function notifyApplied(ctx: ExtensionCommandContext, successMsg: string) {
    const { message, level } = saveAndEmitChanged(
      snapshotSettings(),
      successMsg,
      (event, payload) => pi.events.emit(event, payload),
      sessionCwd,
    );
    ctx.ui.notify(message, level);
  }

  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => {
      await showAgentsMenu(ctx);
    },
  });

  return { onSessionStart: initializeSession };
}
