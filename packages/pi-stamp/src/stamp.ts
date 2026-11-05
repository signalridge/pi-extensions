import type { EntryRenderer, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  buildCostOriginLookup,
  COST_ORIGIN_ENTRY_TYPE,
  type CostOriginAnnotation,
  type CostOriginLookup,
  isStampEntryId,
} from "./cost-origin.js";
import {
  DEFAULT_STAMP_SETTINGS,
  formatMessageStampLabel,
  formatStampLabel,
  type StampSettings,
  stampFormatEnvironmentEpoch,
} from "./format.js";
import { showStampMenu } from "./menu.js";
import {
  type AssistantMetadataData,
  type AssistantStampCostOrigin,
  captureAssistantCostOrigin,
  captureAssistantMetadata,
  formatAssistantMetadataLines,
  formatToolStampLabel,
  isAssistantMetadataData,
  sanitizeMetadataText,
  sanitizeTerminalText,
  type ToolStampOutcome,
} from "./metadata.js";
import { StampRenderCache, type StampRenderSnapshot, stampRenderSnapshot } from "./render-cache.js";
import { createStampSettingsRuntime, type StampSettingsRuntime } from "./settings.js";

export const STAMP_ENTRY_TYPE = "pi-stamp";
export const MAX_TOOL_STAMP_OBSERVATIONS = 256;

export interface MessageStampDataV1 {
  version: 1;
  role: "user" | "assistant";
  timestamp: number;
}

export interface MessageStampDataV2 {
  version: 2;
  role: "user" | "assistant";
  timestamp: number;
  previousTimestamp?: number;
}

export interface AssistantMessageStampDataV3 {
  version: 3;
  role: "assistant";
  timestamp: number;
  previousTimestamp?: number;
  completedAt: number;
  firstContentAt?: number;
}

export interface AssistantMessageStampDataV4 {
  version: 4;
  role: "assistant";
  timestamp: number;
  previousTimestamp?: number;
  completedAt?: number;
  firstContentAt?: number;
  metadata: AssistantMetadataData;
}

export interface ToolStampDataV1 {
  version: 1;
  kind: "tool";
  toolCallId: string;
  toolName: string;
  startedAt: number;
  completedAt: number;
  outcome: ToolStampOutcome;
}

export type MessageStampData =
  | MessageStampDataV1
  | MessageStampDataV2
  | AssistantMessageStampDataV3
  | AssistantMessageStampDataV4;
export type StampEntryData = MessageStampData | ToolStampDataV1;

export interface StampExtensionOptions {
  settingsRuntime?: StampSettingsRuntime;
  now?: () => number;
}

interface AssistantTimingObservation {
  timestamp: number;
  firstContentAt?: number;
}

interface FinalizedAssistantTiming extends AssistantTimingObservation {
  completedAt: number;
}

interface ToolTimingObservation {
  toolCallId: string;
  toolName: string;
  startedAt: number;
  completedAt?: number;
}

export function formatStampTime(timestamp: number): string | undefined {
  return formatStampLabel(timestamp, undefined, {
    ...DEFAULT_STAMP_SETTINGS,
    dateContext: "never",
  });
}

export function isMessageStampData(value: unknown): value is MessageStampData {
  if (!isRecord(value) || !isStampRole(value.role) || !isValidTimestamp(value.timestamp)) {
    return false;
  }
  if (value.version === 1) {
    return hasOnlyKeys(value, ["version", "role", "timestamp"]);
  }
  if (value.version === 2) {
    return (
      hasOnlyKeys(value, ["version", "role", "timestamp", "previousTimestamp"]) &&
      (!Object.hasOwn(value, "previousTimestamp") || isValidTimestamp(value.previousTimestamp))
    );
  }
  if (value.version === 3) {
    return (
      value.role === "assistant" &&
      hasOnlyKeys(value, ["version", "role", "timestamp", "previousTimestamp", "completedAt", "firstContentAt"]) &&
      isValidTimestamp(value.completedAt) &&
      value.completedAt >= value.timestamp &&
      (!Object.hasOwn(value, "previousTimestamp") || isValidTimestamp(value.previousTimestamp)) &&
      (!Object.hasOwn(value, "firstContentAt") ||
        (isValidTimestamp(value.firstContentAt) &&
          value.firstContentAt >= value.timestamp &&
          value.firstContentAt <= value.completedAt))
    );
  }
  if (value.version !== 4 || value.role !== "assistant") return false;
  if (
    !hasOnlyKeys(value, [
      "version",
      "role",
      "timestamp",
      "previousTimestamp",
      "completedAt",
      "firstContentAt",
      "metadata",
    ]) ||
    (Object.hasOwn(value, "previousTimestamp") && !isValidTimestamp(value.previousTimestamp)) ||
    !isAssistantMetadataData(value.metadata)
  ) {
    return false;
  }
  if (!Object.hasOwn(value, "completedAt")) return !Object.hasOwn(value, "firstContentAt");
  return (
    isValidTimestamp(value.completedAt) &&
    value.completedAt >= value.timestamp &&
    (!Object.hasOwn(value, "firstContentAt") ||
      (isValidTimestamp(value.firstContentAt) &&
        value.firstContentAt >= value.timestamp &&
        value.firstContentAt <= value.completedAt))
  );
}

export function isToolStampData(value: unknown): value is ToolStampDataV1 {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.kind === "tool" &&
    hasOnlyKeys(value, ["version", "kind", "toolCallId", "toolName", "startedAt", "completedAt", "outcome"]) &&
    isSafePersistedText(value.toolCallId) &&
    isSafePersistedText(value.toolName) &&
    isValidTimestamp(value.startedAt) &&
    isValidTimestamp(value.completedAt) &&
    value.completedAt >= value.startedAt &&
    (value.outcome === "success" || value.outcome === "error")
  );
}

export function createStampEntryRenderer(
  getSettings: () => Readonly<StampSettings>,
  costOrigin?: CostOriginLookup,
  cache = new StampRenderCache(),
): EntryRenderer<StampEntryData> {
  return (entry, options, theme) => {
    if (isToolStampData(entry.data)) {
      if (!getSettings().toolStamps) return undefined;
    } else if (!isMessageStampData(entry.data)) return undefined;
    const key = Symbol("stamp");
    return {
      render(width) {
        if (width < 1) return [];
        const data = entry.data;
        const settings = getSettings();
        // Attribution is live, not part of a cached whole render. In particular,
        // currentCostOrigin must qualify the native leaf/session/generation BEFORE
        // a previously known label can be selected, even on unchanged repaints.
        const cost =
          isRecord(data) && data.version === 4 && isRecord(data.metadata) && isRecord(data.metadata.usage)
            ? data.metadata.usage.estimatedCost
            : undefined;
        const resolvedOrigin = typeof cost === "number" ? costOrigin?.(entry.id, cost) : undefined;
        const origin =
          resolvedOrigin === "provider" || resolvedOrigin === "estimated" || resolvedOrigin === "unknown"
            ? resolvedOrigin
            : undefined;
        let snapshot: StampRenderSnapshot | undefined;
        try {
          snapshot = stampRenderSnapshot(data, [
            entry.id,
            settings.hourCycle,
            settings.showSeconds,
            settings.dateContext,
            settings.locale,
            settings.timeZone,
            settings.responseTiming,
            settings.assistantMetadata,
            settings.toolStamps,
            options.expanded,
            origin,
            stampFormatEnvironmentEpoch(settings),
          ]);
        } catch {
          // An unavailable OS default must not freeze a previous successful label.
        }
        const lines = cache.lines(key, snapshot, () => {
          if (isToolStampData(data)) {
            if (!settings.toolStamps) return [];
            const label = formatToolStampLabel(data.toolName, data.completedAt - data.startedAt, data.outcome);
            return label ? [label] : [];
          }
          if (!isMessageStampData(data)) return [];
          const label = formatMessageStampLabel(
            {
              timestamp: data.timestamp,
              ...(data.version === 1 ? {} : { previousTimestamp: data.previousTimestamp }),
              ...(data.version === 3 || data.version === 4
                ? { completedAt: data.completedAt, firstContentAt: data.firstContentAt }
                : {}),
            },
            settings,
          );
          if (!label) return undefined;
          return [
            label,
            ...(data.version === 4
              ? formatAssistantMetadataLines(metadataView(data, origin), settings.assistantMetadata, options.expanded)
              : []),
          ];
        });
        if (lines.length === 0) return [];
        // Public Theme.fg wraps text in ANSI foreground codes. Resolve those codes
        // live even for the SAME theme object, without retaining coloured rows.
        // The transient marker is removed before anything reaches the terminal.
        const [prefix = "", suffix = ""] = theme.fg("dim", "\u0000").split("\u0000");
        return cache
          .rows(key, lines, width, { prefix, suffix })
          .map((row) => `${row.padding}${prefix}${row.text}${suffix}`);
      },
      invalidate() {
        cache.delete(key);
      },
    };
  };
}

export const renderStampEntry = createStampEntryRenderer(() => DEFAULT_STAMP_SETTINGS);

export default function stampExtension(pi: ExtensionAPI, options: StampExtensionOptions = {}): void {
  const settingsRuntime = options.settingsRuntime ?? createStampSettingsRuntime();
  const now = options.now ?? Date.now;
  let generation = 0;
  let renderCache = new StampRenderCache();
  const retireRenderCache = () => {
    renderCache.clear(true);
    renderCache = new StampRenderCache();
  };
  let costOrigins: CostOriginLookup = () => undefined;
  let costOriginsLeaf: string | null | undefined;
  let costOriginSession: ExtensionContext["sessionManager"] | undefined;
  let activeSessionId: string | undefined;
  let sessionController = new AbortController();
  const currentCostOrigin: CostOriginLookup = (id, cost) => {
    const owner = generation;
    const manager = costOriginSession;
    if (!manager || sessionController.signal.aborted) return undefined;
    try {
      const sessionId = manager.getSessionId();
      const leaf = manager.getLeafId();
      if (sessionId !== activeSessionId) return undefined;
      if (leaf !== costOriginsLeaf) {
        const branch = manager.getBranch();
        const lookup = costOriginLookupFromBranch(branch);
        if (
          (branch.at(-1)?.id ?? null) !== leaf ||
          manager.getLeafId() !== leaf ||
          manager.getSessionId() !== sessionId ||
          manager !== costOriginSession ||
          owner !== generation ||
          sessionController.signal.aborted
        )
          return undefined;
        costOrigins = lookup;
        costOriginsLeaf = leaf;
      }
      if (owner !== generation || manager !== costOriginSession || sessionController.signal.aborted) return undefined;
      return costOrigins(id, cost);
    } catch {
      return undefined;
    }
  };
  pi.registerEntryRenderer<StampEntryData>(STAMP_ENTRY_TYPE, (entry, renderOptions, theme) => {
    const renderGeneration = generation;
    return createStampEntryRenderer(
      () => settingsRuntime.get().settings,
      (id, cost) => (renderGeneration === generation ? currentCostOrigin(id, cost) : undefined),
      renderCache,
    )(entry, renderOptions, theme);
  });
  let tuiSessionActive = false;
  let acceptingTurnEvents = true;
  let lastStampTimestamp: number | undefined;
  let activeAssistantTiming: AssistantTimingObservation | undefined;
  let finalizedAssistantTiming: FinalizedAssistantTiming | undefined;
  const activeToolTimings = new Map<string, ToolTimingObservation>();
  const pendingUserStamps: Array<{ role: "user"; timestamp: number }> = [];

  pi.registerCommand("stamp", {
    description: "Configure transcript timestamp and metadata stamps",
    handler: async (args, ctx) => {
      if (args.trim()) throw new Error("/stamp does not accept arguments.");
      if (ctx.mode === "print" || ctx.mode === "json") {
        throw new Error(`/stamp is unavailable in ${ctx.mode} mode; use TUI or RPC mode.`);
      }
      const commandGeneration = generation;
      const commandController = sessionController;
      await showStampMenu(ctx, settingsRuntime, {
        signal: commandController.signal,
        isCurrent: () =>
          commandGeneration === generation &&
          commandController === sessionController &&
          !commandController.signal.aborted,
      });
    },
  });

  const appendVersion2Stamp = (role: "user" | "assistant", timestamp: number): void => {
    const stamp: MessageStampDataV2 = {
      version: 2,
      role,
      timestamp,
      ...(lastStampTimestamp === undefined ? {} : { previousTimestamp: lastStampTimestamp }),
    };
    if (!isMessageStampData(stamp)) return;
    pi.appendEntry<MessageStampDataV2>(STAMP_ENTRY_TYPE, stamp);
    lastStampTimestamp = timestamp;
  };

  const appendAssistantStamp = (
    timestamp: number,
    timing: FinalizedAssistantTiming | undefined,
    message: unknown,
    ctx: ExtensionContext,
  ): void => {
    const matchingTiming = timing?.timestamp === timestamp ? timing : undefined;
    const metadata =
      settingsRuntime.get().settings.assistantMetadata === "off" ? undefined : captureAssistantMetadata(message);
    if (metadata) {
      const stamp: AssistantMessageStampDataV4 = {
        version: 4,
        role: "assistant",
        timestamp,
        ...(lastStampTimestamp === undefined ? {} : { previousTimestamp: lastStampTimestamp }),
        ...(matchingTiming
          ? {
              completedAt: matchingTiming.completedAt,
              ...(matchingTiming.firstContentAt === undefined ? {} : { firstContentAt: matchingTiming.firstContentAt }),
            }
          : {}),
        metadata,
      };
      if (isMessageStampData(stamp)) {
        const owner = generation;
        const origin = captureAssistantCostOrigin(message);
        // appendEntry is synchronous and returns void. Prove a single exact child
        // was appended to the native branch; timestamps are not identities.
        const before = optionalBranchSnapshot(ctx);
        pi.appendEntry<AssistantMessageStampDataV4>(STAMP_ENTRY_TYPE, stamp);
        if (owner === generation) lastStampTimestamp = timestamp;
        try {
          if (
            origin === undefined ||
            !before ||
            owner !== generation ||
            sessionController.signal.aborted ||
            ctx.signal?.aborted ||
            ctx.sessionManager.getSessionId() !== activeSessionId
          )
            return;
          const after = optionalBranchSnapshot(ctx);
          const entry = after?.entries.at(-1);
          if (
            !after ||
            !entry ||
            after.entries.length !== before.entries.length + 1 ||
            !before.entries.every((ancestor, index) => ancestor.id === after.entries[index]?.id) ||
            entry.parentId !== before.leaf ||
            before.entries.some((ancestor) => ancestor.id === entry.id) ||
            !isStampEntryId(entry.id) ||
            entry.type !== "custom" ||
            entry.customType !== STAMP_ENTRY_TYPE ||
            JSON.stringify(entry.data) !== JSON.stringify(stamp) ||
            before.sessionId !== after.sessionId ||
            after.sessionId !== activeSessionId ||
            ctx.sessionManager.getLeafId() !== entry.id ||
            ctx.signal?.aborted ||
            sessionController.signal.aborted ||
            owner !== generation
          )
            return;
          const cost = stamp.metadata.usage?.estimatedCost;
          if (cost === undefined) return;
          pi.appendEntry<CostOriginAnnotation>(COST_ORIGIN_ENTRY_TYPE, {
            version: 1,
            stampEntryId: entry.id,
            cost,
            origin,
          });
          if (owner === generation && !sessionController.signal.aborted) {
            costOriginsLeaf = undefined;
          }
        } catch {
          // Optional attribution must never invalidate a successfully persisted v4 stamp.
        }
        return;
      }
    }
    if (!matchingTiming) {
      appendVersion2Stamp("assistant", timestamp);
      return;
    }
    const stamp: AssistantMessageStampDataV3 = {
      version: 3,
      role: "assistant",
      timestamp,
      ...(lastStampTimestamp === undefined ? {} : { previousTimestamp: lastStampTimestamp }),
      completedAt: matchingTiming.completedAt,
      ...(matchingTiming.firstContentAt === undefined ? {} : { firstContentAt: matchingTiming.firstContentAt }),
    };
    if (!isMessageStampData(stamp)) {
      appendVersion2Stamp("assistant", timestamp);
      return;
    }
    pi.appendEntry<AssistantMessageStampDataV3>(STAMP_ENTRY_TYPE, stamp);
    lastStampTimestamp = timestamp;
  };

  const flushPendingUsers = (): void => {
    if (!tuiSessionActive) {
      pendingUserStamps.length = 0;
      return;
    }
    while (pendingUserStamps.length > 0) {
      const stamp = pendingUserStamps[0];
      if (!stamp) break;
      appendVersion2Stamp(stamp.role, stamp.timestamp);
      pendingUserStamps.shift();
    }
  };

  const flushToolStamps = (toolResults: readonly unknown[]): void => {
    try {
      if (!tuiSessionActive || !settingsRuntime.get().settings.toolStamps) return;
      for (const result of toolResults) {
        if (!isRecord(result) || typeof result.toolCallId !== "string" || typeof result.isError !== "boolean") continue;
        const timing = activeToolTimings.get(result.toolCallId);
        if (!timing || timing.completedAt === undefined) {
          continue;
        }
        activeToolTimings.delete(result.toolCallId);
        const stamp: ToolStampDataV1 = {
          version: 1,
          kind: "tool",
          toolCallId: timing.toolCallId,
          toolName: timing.toolName,
          startedAt: timing.startedAt,
          completedAt: timing.completedAt,
          // turn_end contains the finalized tool_result rewrite, unlike the
          // provisional execution event. Timings still come from execution.
          outcome: result.isError ? "error" : "success",
        };
        if (isToolStampData(stamp)) pi.appendEntry<ToolStampDataV1>(STAMP_ENTRY_TYPE, stamp);
      }
    } finally {
      activeToolTimings.clear();
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    sessionController.abort(new Error("pi-stamp session replaced"));
    sessionController = new AbortController();
    const controller = sessionController;
    const currentGeneration = ++generation;
    retireRenderCache();
    pendingUserStamps.length = 0;
    activeAssistantTiming = undefined;
    finalizedAssistantTiming = undefined;
    activeToolTimings.clear();
    tuiSessionActive = ctx.mode === "tui";
    acceptingTurnEvents = true;
    costOrigins = () => undefined;
    costOriginsLeaf = undefined;
    costOriginSession = ctx.sessionManager;
    activeSessionId = ctx.sessionManager.getSessionId();
    const branch = ctx.sessionManager.getBranch();
    lastStampTimestamp = lastStampTimestampFromBranch(branch);
    try {
      const state = await settingsRuntime.reload(controller.signal);
      if (controller.signal.aborted || currentGeneration !== generation || controller !== sessionController) {
        return;
      }
      if (state.issue && ctx.hasUI) {
        ctx.ui.notify(safeTerminalText(state.issue.message), "warning");
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (ctx.hasUI) {
        ctx.ui.notify(`Could not load pi-stamp settings: ${safeTerminalText(formatError(error))}`, "warning");
      }
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    // Navigation succeeded. Do not invalidate on session_before_tree: another
    // extension or the user may still cancel it.
    sessionController.abort(new Error("pi-stamp branch replaced"));
    sessionController = new AbortController();
    generation += 1;
    retireRenderCache();
    pendingUserStamps.length = 0;
    activeAssistantTiming = undefined;
    finalizedAssistantTiming = undefined;
    activeToolTimings.clear();
    acceptingTurnEvents = false;
    costOrigins = () => undefined;
    costOriginsLeaf = undefined;
    costOriginSession = ctx.sessionManager;
    activeSessionId = ctx.sessionManager.getSessionId();
    const branch = ctx.sessionManager.getBranch();
    lastStampTimestamp = lastStampTimestampFromBranch(branch);
  });

  pi.on("turn_start", () => {
    acceptingTurnEvents = true;
    activeAssistantTiming = undefined;
    finalizedAssistantTiming = undefined;
    activeToolTimings.clear();
  });

  pi.on("tool_execution_start", (event) => {
    if (
      event.parentToolCallId !== undefined ||
      !tuiSessionActive ||
      !acceptingTurnEvents ||
      !settingsRuntime.get().settings.toolStamps ||
      activeToolTimings.size >= MAX_TOOL_STAMP_OBSERVATIONS ||
      activeToolTimings.has(event.toolCallId) ||
      !isSafePersistedText(event.toolCallId)
    ) {
      return;
    }
    const toolName = sanitizeMetadataText(event.toolName);
    if (!toolName) return;
    const startedAt = now();
    if (!isValidTimestamp(startedAt)) return;
    activeToolTimings.set(event.toolCallId, {
      toolCallId: event.toolCallId,
      toolName,
      startedAt,
    });
  });

  pi.on("tool_execution_end", (event) => {
    if (event.parentToolCallId !== undefined) return;
    const timing = activeToolTimings.get(event.toolCallId);
    if (!tuiSessionActive || !timing || timing.completedAt !== undefined) return;
    const completedAt = now();
    if (!isValidTimestamp(completedAt) || completedAt < timing.startedAt) {
      activeToolTimings.delete(event.toolCallId);
      return;
    }
    timing.completedAt = completedAt;
  });

  pi.on("message_start", (event) => {
    if (event.message.role === "user" || event.message.role === "assistant") acceptingTurnEvents = true;
    flushPendingUsers();
    if (!tuiSessionActive || event.message.role !== "assistant" || !isValidTimestamp(event.message.timestamp)) {
      return;
    }
    activeAssistantTiming = { timestamp: event.message.timestamp };
    finalizedAssistantTiming = undefined;
  });

  pi.on("message_update", (event) => {
    if (
      !tuiSessionActive ||
      event.message.role !== "assistant" ||
      !activeAssistantTiming ||
      activeAssistantTiming.timestamp !== event.message.timestamp ||
      activeAssistantTiming.firstContentAt !== undefined ||
      !isMeaningfulAssistantUpdate(event.assistantMessageEvent)
    ) {
      return;
    }
    const firstContentAt = now();
    if (isValidTimestamp(firstContentAt)) activeAssistantTiming.firstContentAt = firstContentAt;
  });

  pi.on("message_end", (event) => {
    if (!tuiSessionActive || !acceptingTurnEvents || !isValidTimestamp(event.message.timestamp)) return;
    if (event.message.role === "user") {
      pendingUserStamps.push({ role: "user", timestamp: event.message.timestamp });
      return;
    }
    if (event.message.role !== "assistant") return;
    const completedAt = now();
    if (!isValidTimestamp(completedAt) || completedAt < event.message.timestamp) {
      activeAssistantTiming = undefined;
      finalizedAssistantTiming = undefined;
      return;
    }
    const firstContentAt =
      activeAssistantTiming?.timestamp === event.message.timestamp &&
      isValidTimestamp(activeAssistantTiming.firstContentAt) &&
      activeAssistantTiming.firstContentAt >= event.message.timestamp &&
      activeAssistantTiming.firstContentAt <= completedAt
        ? activeAssistantTiming.firstContentAt
        : undefined;
    finalizedAssistantTiming = {
      timestamp: event.message.timestamp,
      completedAt,
      ...(firstContentAt === undefined ? {} : { firstContentAt }),
    };
    activeAssistantTiming = undefined;
  });

  pi.on("turn_end", (event, ctx) => {
    if (!acceptingTurnEvents) return;
    const timing = finalizedAssistantTiming;
    activeAssistantTiming = undefined;
    finalizedAssistantTiming = undefined;
    if (tuiSessionActive && event.message.role === "assistant") {
      appendAssistantStamp(event.message.timestamp, timing, event.message, ctx);
    }
    flushToolStamps(event.toolResults);
  });

  pi.on("agent_end", () => {
    flushPendingUsers();
    activeAssistantTiming = undefined;
    finalizedAssistantTiming = undefined;
    activeToolTimings.clear();
  });

  pi.on("session_shutdown", async () => {
    sessionController.abort(new Error("pi-stamp session shut down"));
    generation += 1;
    retireRenderCache();
    costOrigins = () => undefined;
    costOriginsLeaf = undefined;
    costOriginSession = undefined;
    activeSessionId = undefined;
    flushPendingUsers();
    pendingUserStamps.length = 0;
    activeAssistantTiming = undefined;
    finalizedAssistantTiming = undefined;
    activeToolTimings.clear();
    tuiSessionActive = false;
    lastStampTimestamp = undefined;
    await settingsRuntime.flush();
  });
}

function metadataView(stamp: AssistantMessageStampDataV4, origin?: AssistantStampCostOrigin): AssistantMetadataData {
  if (origin !== "provider" && origin !== "estimated" && origin !== "unknown") return stamp.metadata;
  return { ...stamp.metadata, usage: { ...stamp.metadata.usage, costOrigin: origin } };
}

export function costOriginLookupFromBranch(entries: readonly unknown[]): CostOriginLookup {
  return buildCostOriginLookup(entries, (entry) => {
    if (
      !isRecord(entry) ||
      entry.type !== "custom" ||
      entry.customType !== STAMP_ENTRY_TYPE ||
      !isMessageStampData(entry.data) ||
      entry.data.version !== 4
    )
      return undefined;
    return entry.data.metadata.usage?.estimatedCost;
  });
}

function optionalBranchSnapshot(ctx: ExtensionContext) {
  try {
    const leaf = ctx.sessionManager.getLeafId();
    const entries = ctx.sessionManager.getBranch();
    if ((entries.at(-1)?.id ?? null) !== leaf) return undefined;
    return { leaf, entries, sessionId: ctx.sessionManager.getSessionId() };
  } catch {
    return undefined;
  }
}

function lastStampTimestampFromBranch(entries: readonly unknown[]): number | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      isRecord(entry) &&
      entry.type === "custom" &&
      entry.customType === STAMP_ENTRY_TYPE &&
      isMessageStampData(entry.data)
    ) {
      return entry.data.timestamp;
    }
  }
  return undefined;
}

function isMeaningfulAssistantUpdate(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "text_delta" || value.type === "thinking_delta" || value.type === "toolcall_delta") {
    return typeof value.delta === "string" && value.delta.length > 0;
  }
  if (value.type === "text_end" || value.type === "thinking_end") {
    return typeof value.content === "string" && value.content.length > 0;
  }
  return value.type === "toolcall_end" && isRecord(value.toolCall);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStampRole(value: unknown): value is MessageStampData["role"] {
  return value === "user" || value === "assistant";
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
}

function isSafePersistedText(value: unknown): value is string {
  return typeof value === "string" && sanitizeMetadataText(value) === value;
}

function safeTerminalText(value: string): string {
  return sanitizeTerminalText(value).trim();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
