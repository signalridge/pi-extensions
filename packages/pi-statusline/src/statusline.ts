import { homedir } from "node:os";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getCapabilities, type TUI } from "@earendil-works/pi-tui";
import { type CommandOwner, isOwnerCurrent } from "./command-owner.js";
import { registerStatuslineCommand, type StatuslineCommandOptions } from "./commands.js";
import { CONTEXT_CONFIDENCE_ENTRY, CONTEXT_CONFIDENCE_UNKNOWN, ContextConfidence } from "./context-confidence.js";
import {
  buildExtensionStatusIconAliases,
  type ExtensionStatusIconAliasMap,
  findDuplicateExtensions,
  readInstalledExtensionPackages,
} from "./extension-status.js";
import { type GitStatusSummary, gitStatusSummaryEqual, readGitStatus } from "./git-status.js";
import { type RuntimeState, renderExtensionStatusline, renderStatusline } from "./render.js";
import {
  consumeStatuslineSettingsNotice,
  type LoadedStatuslineSettings,
  loadStatuslineSettings,
  loadStatuslineSettingsForAgent,
  settingsFilePath,
} from "./settings.js";
import { inspectStatuses, type StatusReader } from "./status-inspector.js";
import { type TerminalLifetime, terminalLifetime } from "./terminal-lifetime.js";
import type { PalettePreset } from "./types.js";
import { FooterUsageAccumulator, summarizeFooterUsage } from "./usage.js";

const STATUSLINE_KEY = "statusline";
const GIT_STATUS_REFRESH_INTERVAL_MS = 30_000;
const USAGE_REFRESH_INTERVAL_MS = 5_000;
const GIT_STATUS_EVENT_DEBOUNCE_MS = 250;
const EMPTY_EXTENSION_STATUS_ICON_ALIASES: ExtensionStatusIconAliasMap = new Map();

export default function statusline(pi: ExtensionAPI) {
  let loaded: LoadedStatuslineSettings | undefined;
  let previewPalettePreset: PalettePreset | undefined;
  let activeSessionManager: ExtensionContext["sessionManager"] | undefined;
  let activeTerminal: TerminalLifetime | undefined;
  let observedUsageLeafId: string | null = null;
  const footerUsage = new FooterUsageAccumulator();
  const contextConfidence = new ContextConfidence();
  let confidenceLeaf: string | null = null;
  let confidenceBranchRetired = false;
  const runtime: RuntimeState = {
    turnCount: 0,
    activeTools: new Map(),
    isStreaming: false,
    thinkingLevel: "off",
    duplicateExtensions: [],
    extensionStatusIconAliases: EMPTY_EXTENSION_STATUS_ICON_ALIASES,
    footerUsage: footerUsage.snapshot(),
  };

  const rebuildFooterUsage = (ctx: ExtensionContext) => {
    footerUsage.reset(ctx.sessionManager.getEntries());
    observedUsageLeafId = ctx.sessionManager.getLeafId();
    runtime.footerUsage = footerUsage.snapshot();
  };

  const updateFooterUsage = (message: Parameters<FooterUsageAccumulator["updateMessage"]>[0]) => {
    footerUsage.updateMessage(message);
    runtime.footerUsage = footerUsage.snapshot();
  };

  const showsUsage = () =>
    loaded?.config.segments.some((segment) => segment === "tokens" || segment === "cache" || segment === "cost");
  const refreshStandaloneUsage = (ctx: ExtensionContext) => {
    const leafId = ctx.sessionManager.getLeafId();
    if (leafId === observedUsageLeafId) return false;
    observedUsageLeafId = leafId;
    if (!footerUsage.updateUsageEntries(ctx.sessionManager.getEntries())) return false;
    runtime.footerUsage = footerUsage.snapshot();
    return true;
  };

  let sessionGeneration = 0;
  let menuController = new AbortController();
  let gitStatusRequestId = 0;
  let activeGitStatusTarget:
    | { cwd: string; generation: number; ctx: ExtensionContext; ui: ExtensionContext["ui"] }
    | undefined;
  let activeFooterRetire: (() => void) | undefined;
  let readExtensionStatuses: StatusReader | undefined;
  let footerTui: TUI | undefined;
  let inspectorOpen = false;
  let gitStatusRefreshInFlight = false;
  let gitStatusAbortController: AbortController | undefined;
  let gitStatusDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingGitStatusRefresh: { cwd: string; generation: number; requestId: number } | undefined;

  const refresh = () => runtime.requestRender?.();
  const ownsRuntime = (ctx: ExtensionContext) => {
    try {
      return ctx.sessionManager === activeSessionManager;
    } catch {
      return false;
    }
  };

  const syncContextConfidence = () => {
    runtime.contextUsageUnknown = contextConfidence.unknown;
  };
  const retireContextConfidence = () => {
    confidenceBranchRetired = true;
    contextConfidence.invalidate();
    syncContextConfidence();
    refresh();
    return false;
  };
  const ownsContextConfidence = (ctx: ExtensionContext) => {
    if (!ownsRuntime(ctx) || confidenceBranchRetired) return false;
    try {
      if (ctx.mode !== "tui" || !ctx.hasUI || ctx.ui !== activeGitStatusTarget?.ui) return false;
      if (!isActiveGitStatusTarget(ctx.cwd, sessionGeneration)) return false;
      const leaf = ctx.sessionManager.getLeafId();
      if (leaf !== confidenceLeaf) {
        // Navigation can replace the branch before session_tree is dispatched.
        // Walk only the new suffix, never rescan the full branch or render history.
        let ancestor = leaf;
        const visited = new Set<string>();
        while (ancestor !== confidenceLeaf) {
          if (ancestor === null || visited.has(ancestor)) return retireContextConfidence();
          visited.add(ancestor);
          const entry = ctx.sessionManager.getEntry(ancestor);
          if (!entry || entry.id !== ancestor || (entry.parentId !== null && typeof entry.parentId !== "string")) {
            return retireContextConfidence();
          }
          ancestor = entry.parentId;
        }
        confidenceLeaf = leaf;
      }
      contextConfidence.selectModel(ctx.model);
      syncContextConfidence();
      return true;
    } catch {
      return retireContextConfidence();
    }
  };

  const updateFooterTurnUsage = (
    message: Parameters<FooterUsageAccumulator["updateMessage"]>[0],
    toolResults: readonly Parameters<FooterUsageAccumulator["updateMessage"]>[0][],
  ) => {
    footerUsage.updateTurn(message, toolResults);
    runtime.footerUsage = footerUsage.snapshot();
  };

  const setGitStatus = (summary: GitStatusSummary | undefined) => {
    if (gitStatusSummaryEqual(runtime.gitStatus, summary)) return;
    runtime.gitStatus = summary;
    refresh();
  };

  const clearGitStatusDebounce = () => {
    if (!gitStatusDebounceTimer) return;
    clearTimeout(gitStatusDebounceTimer);
    gitStatusDebounceTimer = undefined;
  };

  const abortGitStatusRefresh = (reason: string) => {
    gitStatusAbortController?.abort(new DOMException(reason, "AbortError"));
  };

  const retireRuntime = (generation: number) => {
    if (generation !== sessionGeneration) return;
    // Invalidate before cleanup: an abort or unsubscribe may synchronously call back.
    activeGitStatusTarget = undefined;
    activeSessionManager = undefined;
    readExtensionStatuses = undefined;
    footerTui = undefined;
    gitStatusRequestId += 1;
    pendingGitStatusRefresh = undefined;
    runtime.requestRender = undefined;
    runtime.gitStatus = undefined;
    runtime.duplicateExtensions = [];
    runtime.extensionStatusIconAliases = EMPTY_EXTENSION_STATUS_ICON_ALIASES;
    for (const cleanup of [
      clearGitStatusDebounce,
      () => abortGitStatusRefresh("Statusline owner retired"),
      () => menuController.abort(new DOMException("Statusline owner retired", "AbortError")),
    ]) {
      try {
        cleanup();
      } catch {
        /* independent cleanup must still run */
      }
    }
  };

  const isActiveGitStatusTarget = (cwd: string, generation: number) => {
    const target = activeGitStatusTarget;
    if (!target || target.cwd !== cwd || target.generation !== generation || generation !== sessionGeneration)
      return false;
    try {
      if (
        target.ctx.mode === "tui" &&
        target.ctx.hasUI &&
        target.ctx.cwd === cwd &&
        target.ctx.sessionManager === activeSessionManager &&
        target.ctx.ui === target.ui
      )
        return true;
    } catch {
      // SDK dispose invalidates getters without delivering session_shutdown.
    }
    // A live SDK mode rebind precedes our lifecycle handler. Retire only the
    // captured generation, never a replacement footer or UI.
    activeFooterRetire?.();
    retireRuntime(generation);
    return false;
  };

  const isCurrentGitStatusRequest = (cwd: string, generation: number, requestId: number) =>
    isActiveGitStatusTarget(cwd, generation) && requestId === gitStatusRequestId;

  const runGitStatusRefresh = (cwd: string, generation: number, requestId: number) => {
    if (!isCurrentGitStatusRequest(cwd, generation, requestId)) return;
    if (gitStatusRefreshInFlight) {
      pendingGitStatusRefresh = { cwd, generation, requestId };
      return;
    }

    gitStatusRefreshInFlight = true;
    const abortController = new AbortController();
    gitStatusAbortController = abortController;
    void (async () => {
      try {
        const summary = await readGitStatus(pi, cwd, abortController.signal);
        if (isCurrentGitStatusRequest(cwd, generation, requestId)) setGitStatus(summary);
      } catch {
        if (isCurrentGitStatusRequest(cwd, generation, requestId)) setGitStatus(undefined);
      } finally {
        gitStatusRefreshInFlight = false;
        if (gitStatusAbortController === abortController) gitStatusAbortController = undefined;
        const pending = pendingGitStatusRefresh;
        pendingGitStatusRefresh = undefined;
        if (pending) runGitStatusRefresh(pending.cwd, pending.generation, pending.requestId);
      }
    })();
  };

  const refreshGitStatus = (cwd: string, generation = sessionGeneration) => {
    if (!isActiveGitStatusTarget(cwd, generation)) return;
    runGitStatusRefresh(cwd, generation, ++gitStatusRequestId);
  };

  const scheduleGitStatusRefresh = (cwd: string, generation = sessionGeneration) => {
    if (!isActiveGitStatusTarget(cwd, generation)) return;
    const requestId = ++gitStatusRequestId;
    clearGitStatusDebounce();
    gitStatusDebounceTimer = setTimeout(() => {
      gitStatusDebounceTimer = undefined;
      runGitStatusRefresh(cwd, generation, requestId);
    }, GIT_STATUS_EVENT_DEBOUNCE_MS);
    gitStatusDebounceTimer.unref?.();
  };

  const scheduleGitStatusRefreshForContext = (ctx: ExtensionContext) => {
    if (!activeGitStatusTarget || activeGitStatusTarget.cwd !== ctx.cwd) return;
    scheduleGitStatusRefresh(activeGitStatusTarget.cwd, activeGitStatusTarget.generation);
  };

  const installFooter = (ctx: ExtensionContext) => {
    activeFooterRetire?.();
    retireRuntime(sessionGeneration);
    const generation = ++sessionGeneration;
    menuController.abort(new DOMException("Statusline session context replaced", "AbortError"));
    menuController = new AbortController();
    // Manual commands retain session identity in all modes, without allocating
    // a terminal owner or performing ambient UI effects for print/RPC.
    activeSessionManager = ctx.sessionManager;
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    const cwd = ctx.cwd;
    rebuildFooterUsage(ctx);
    const branch = ctx.sessionManager.getBranch();
    contextConfidence.rebuild(branch, ctx.model);
    confidenceLeaf = ctx.sessionManager.getLeafId();
    confidenceBranchRetired = false;
    syncContextConfidence();
    runtime.homeDir = homedir();
    previewPalettePreset = undefined;
    abortGitStatusRefresh("Statusline session context replaced");
    clearGitStatusDebounce();
    activeGitStatusTarget = { cwd, generation, ctx, ui: ctx.ui };
    runtime.gitStatus = undefined;
    runtime.duplicateExtensions = [];
    runtime.extensionStatusIconAliases = EMPTY_EXTENSION_STATUS_ICON_ALIASES;
    ctx.ui.setStatus(STATUSLINE_KEY, undefined);
    if (!activeGitStatusTarget || !loaded) return;
    const installedPackages = readInstalledExtensionPackages(cwd);
    runtime.duplicateExtensions = findDuplicateExtensions(installedPackages);
    runtime.extensionStatusIconAliases = buildExtensionStatusIconAliases(installedPackages);
    ctx.ui.setFooter((tui, theme, footerData) => {
      if (!isActiveGitStatusTarget(cwd, generation)) return { dispose() {}, invalidate() {}, render: () => [] };
      activeTerminal = terminalLifetime(tui);
      runtime.requestRender = () => {
        if (isActiveGitStatusTarget(cwd, generation)) tui.requestRender();
      };

      let retired = false;
      const isCurrent = () => !retired && isActiveGitStatusTarget(cwd, generation);
      footerTui = tui;
      readExtensionStatuses = () => (isCurrent() ? footerData.getExtensionStatuses() : new Map());
      const refreshFooterGitStatus = () => refreshGitStatus(cwd, generation);
      const branchUnsubscribe = footerData.onBranchChange(() => {
        if (!isCurrent()) return;
        runtime.gitStatus = undefined;
        abortGitStatusRefresh("Statusline Git branch changed");
        clearGitStatusDebounce();
        refreshFooterGitStatus();
        tui.requestRender();
      });
      const clock = setInterval(() => {
        if (!isCurrent()) return;
        clearGitStatusDebounce();
        refreshFooterGitStatus();
        tui.requestRender();
      }, GIT_STATUS_REFRESH_INTERVAL_MS);
      clock.unref?.();
      // Pi persists standalone usage without a corresponding extension event.
      // Its append-only leaf is a cheap change signal; getEntries() copies the entire history.
      const usageClock = setInterval(() => {
        if (!isCurrent() || !showsUsage()) return;
        try {
          if (refreshStandaloneUsage(ctx)) tui.requestRender();
        } catch {
          retire();
        }
      }, USAGE_REFRESH_INTERVAL_MS);
      usageClock.unref?.();

      const retire = () => {
        if (retired) return;
        retired = true;
        // Every resource is attempted even if one cleanup operation throws.
        for (const cleanup of [
          () => retireRuntime(generation),
          () => clearInterval(clock),
          () => clearInterval(usageClock),
          branchUnsubscribe,
        ]) {
          try {
            cleanup();
          } catch {
            /* retirement cannot escape an async callback */
          }
        }
        if (activeFooterRetire === retire) activeFooterRetire = undefined;
      };
      activeFooterRetire = retire;

      return {
        dispose: retire,
        invalidate() {},
        render(width: number): string[] {
          if (!isCurrent() || !loaded) return [];
          const config = previewPalettePreset
            ? { ...loaded.config, palettePreset: previewPalettePreset }
            : loaded.config;
          const trueColor = getCapabilities().trueColor;
          const mainLine = renderStatusline(width, ctx, footerData, theme, config, runtime, trueColor);
          const lines = mainLine ? mainLine.split("\n") : [];
          lines.push(...renderExtensionStatusline(width, footerData, theme, config, runtime, mainLine, trueColor));
          return lines;
        },
      };
    });
    refreshGitStatus(cwd, generation);
  };

  const getMenuOwner = (): CommandOwner => {
    const generation = sessionGeneration;
    const controller = menuController;
    const terminal = activeTerminal;
    const target = activeGitStatusTarget;
    // A branch may append while a dialog is open. Only replacement of the
    // captured prefix retires it; session_tree can be delivered much later.
    const prefix = target?.ctx.sessionManager.getBranch().map((entry) => entry.id);
    return {
      signal: controller.signal,
      isCurrent: () => {
        if (generation !== sessionGeneration || controller.signal.aborted) return false;
        if (!target) return true; // Manual settings reports also work headlessly.
        if (!isActiveGitStatusTarget(target.cwd, generation)) return false;
        const branch = target.ctx.sessionManager.getBranch();
        if (prefix?.some((id, index) => branch[index]?.id !== id)) {
          controller.abort(new DOMException("Statusline branch replaced", "AbortError"));
          previewPalettePreset = undefined;
          return false;
        }
        return true;
      },
      isHostActive: () => terminal?.active === true,
    };
  };
  const inspect = async (ctx: ExtensionContext) => {
    if (inspectorOpen || ctx.mode !== "tui" || !ctx.hasUI || !ownsRuntime(ctx)) return;
    const reader = readExtensionStatuses;
    if (!reader) return;
    const baseOwner = getMenuOwner();
    const owner: CommandOwner = {
      ...baseOwner,
      isCurrent: () => baseOwner.isCurrent() && ctx.mode === "tui" && ctx.hasUI && ownsRuntime(ctx),
    };
    if (!isOwnerCurrent(owner)) return;
    inspectorOpen = true;
    try {
      await inspectStatuses(pi, ctx, owner, reader);
    } finally {
      inspectorOpen = false;
    }
  };
  pi.registerShortcut("ctrl+alt+s", {
    description: "Inspect extension statuses",
    handler: async (ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI || inspectorOpen || !ownsRuntime(ctx)) return;
      // Public capability detection only. Unknown focus fails closed; the
      // slash command remains available on hosts without these capabilities.
      try {
        const host = footerTui;
        if (
          !host ||
          !("getFocusedComponent" in host) ||
          typeof host.getFocusedComponent !== "function" ||
          typeof host.hasOverlay !== "function" ||
          host.hasOverlay()
        )
          return;
        const focused: unknown = host.getFocusedComponent();
        if (
          !focused ||
          typeof focused !== "object" ||
          !("isShowingAutocomplete" in focused) ||
          typeof focused.isShowingAutocomplete !== "function" ||
          focused.isShowingAutocomplete() !== false
        )
          return;
        await inspect(ctx);
      } catch {
        /* stale host or nonconforming focus: leave the draft alone */
      }
    },
  });

  const agentDir = getAgentDir();
  const configPath = settingsFilePath(agentDir);
  const commandOptions: StatuslineCommandOptions = {
    settingsPath: configPath,
    getLoaded: () => loaded ?? loadStatuslineSettings(configPath),
    getUsage: (ctx) => {
      // Headless sessions do not install/rebuild a footer; report persisted usage on demand.
      if (ctx.mode !== "tui" || !ctx.hasUI) return summarizeFooterUsage(ctx.sessionManager.getEntries());
      refreshStandaloneUsage(ctx);
      return footerUsage.snapshot();
    },
    getMenuOwner,
    inspect,
    apply(next, ctx) {
      if (ctx.sessionManager !== activeSessionManager) return;
      previewPalettePreset = undefined;
      loaded = next;
      if (ctx.mode === "tui" && showsUsage()) refreshStandaloneUsage(ctx);
      refresh();
    },
    preview(palettePreset, ctx) {
      if (ctx.sessionManager !== activeSessionManager) return;
      previewPalettePreset = palettePreset;
      refresh();
    },
    isCurrentSession: (ctx) => ctx.sessionManager === activeSessionManager,
  };
  registerStatuslineCommand(pi, commandOptions);

  pi.on("session_start", (_event, ctx) => {
    activeFooterRetire?.();
    retireRuntime(sessionGeneration);
    runtime.turnCount = 0;
    runtime.activeTools.clear();
    runtime.isStreaming = false;
    loaded = loadStatuslineSettingsForAgent(agentDir);
    const settingsNotice = consumeStatuslineSettingsNotice();
    if (ctx.mode === "tui" && ctx.hasUI) {
      if (settingsNotice) ctx.ui.notify(settingsNotice, "warning");
      if (loaded.diagnostics.length > 0) ctx.ui.notify(formatSettingsDiagnostics(loaded), "warning");
    }
    runtime.thinkingLevel = pi.getThinkingLevel();
    installFooter(ctx);
  });

  const closeCommandsBeforeNavigation = () => {
    menuController.abort(new DOMException("Statusline navigation started", "AbortError"));
    menuController = new AbortController();
    previewPalettePreset = undefined;
    refresh();
  };
  pi.on("session_before_switch", () => closeCommandsBeforeNavigation());
  pi.on("session_before_tree", () => closeCommandsBeforeNavigation());
  pi.on("session_before_fork", () => closeCommandsBeforeNavigation());

  pi.on("session_tree", (_event, ctx) => {
    if (!ownsRuntime(ctx)) return;
    installFooter(ctx);
    refresh();
  });

  pi.on("session_compact", (_event, ctx) => {
    if (!ownsContextConfidence(ctx)) return;
    contextConfidence.invalidate();
    syncContextConfidence();
    rebuildFooterUsage(ctx);
    refresh();
  });

  pi.on("session_compact_failed", (_event, ctx) => {
    if (!ownsContextConfidence(ctx)) return;
    contextConfidence.invalidate();
    syncContextConfidence();
    // Pi does not persist this event. Journal only our display latch, not the
    // provider error or token history, on the currently owned session branch.
    try {
      pi.appendEntry(CONTEXT_CONFIDENCE_ENTRY, CONTEXT_CONFIDENCE_UNKNOWN);
    } finally {
      refresh();
    }
  });

  pi.on("session_shutdown", (event, ctx) => {
    if (!ownsRuntime(ctx)) return;
    // Only quit ends the terminal lifetime; new/resume/fork/reload retire just
    // this session's commands. Mark quit before aborting any pending dialog.
    if (event.reason === "quit" && activeTerminal) activeTerminal.active = false;
    activeFooterRetire?.();
    sessionGeneration += 1;
    menuController.abort(new DOMException("Statusline session shut down", "AbortError"));
    activeSessionManager = undefined;
    previewPalettePreset = undefined;
    activeGitStatusTarget = undefined;
    abortGitStatusRefresh("Statusline session shut down");
    clearGitStatusDebounce();
    pendingGitStatusRefresh = undefined;
    runtime.gitStatus = undefined;
    runtime.activeTools.clear();
    runtime.isStreaming = false;
    runtime.duplicateExtensions = [];
    runtime.extensionStatusIconAliases = EMPTY_EXTENSION_STATUS_ICON_ALIASES;
    footerUsage.reset([]);
    runtime.footerUsage = footerUsage.snapshot();
    if (ctx.mode === "tui" && ctx.hasUI) {
      ctx.ui.setFooter(undefined);
      ctx.ui.setStatus(STATUSLINE_KEY, undefined);
    }
    runtime.requestRender = undefined;
  });

  pi.on("model_select", (_event, ctx) => {
    if (!ownsContextConfidence(ctx)) return;
    refresh();
  });

  pi.on("thinking_level_select", (event) => {
    runtime.thinkingLevel = event.level;
    refresh();
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!ownsRuntime(ctx)) return;
    runtime.isStreaming = true;
    refresh();
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!ownsRuntime(ctx)) return;
    runtime.activeTools.clear();
    scheduleGitStatusRefreshForContext(ctx);
    refresh();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!ownsRuntime(ctx)) return;
    runtime.isStreaming = false;
    runtime.activeTools.clear();
    refresh();
  });

  pi.on("turn_start", (_event, ctx) => {
    if (!ownsRuntime(ctx)) return;
    footerUsage.beginTurn();
    runtime.turnCount += 1;
    runtime.isStreaming = true;
    refresh();
  });

  pi.on("turn_end", (event, ctx) => {
    if (!ownsRuntime(ctx)) return;
    updateFooterTurnUsage(event.message, event.toolResults);
    scheduleGitStatusRefreshForContext(ctx);
    refresh();
  });

  pi.on("message_update", (event, ctx) => {
    if (!ownsRuntime(ctx)) return;
    updateFooterUsage(event.message);
    refresh();
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "assistant" || !ownsContextConfidence(ctx)) return;
    contextConfidence.start(event.message);
  });

  pi.on("message_end", (event, ctx) => {
    if (!ownsRuntime(ctx)) return;
    if (event.message.role === "assistant" && ownsContextConfidence(ctx)) {
      contextConfidence.finish(event.message);
      syncContextConfidence();
    }
    updateFooterUsage(event.message);
    refresh();
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (!ownsRuntime(ctx)) return;
    const currentCount = runtime.activeTools.get(event.toolName) ?? 0;
    runtime.activeTools.set(event.toolName, currentCount + 1);
    refresh();
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!ownsRuntime(ctx)) return;
    const currentCount = runtime.activeTools.get(event.toolName) ?? 0;
    if (currentCount <= 1) runtime.activeTools.delete(event.toolName);
    else runtime.activeTools.set(event.toolName, currentCount - 1);

    scheduleGitStatusRefreshForContext(ctx);
    refresh();
  });
}

function formatSettingsDiagnostics(loaded: LoadedStatuslineSettings): string {
  const details = loaded.diagnostics.slice(0, 5).map((item) => item.message);
  const remaining = loaded.diagnostics.length - details.length;
  return [`pi-statusline settings: ${details.join("; ")}`, ...(remaining > 0 ? [`+${remaining} more`] : [])].join(" ");
}

export {
  buildExtensionStatusIconAliases,
  type ExtensionStatusIconAliasMap,
  extensionColor,
  formatExtensionStatus,
  npmPackageName,
  simplifyExtensionStatusText,
  splitExtensionStatusIcon,
  stripExtensionStatusPrefix,
  stripStatusEmoji,
  wrapExtensionStatusline,
} from "./extension-status.js";
export {
  formatGitBranchText,
  formatGitBranchValue,
  formatGitStatusSummary,
  type GitStatusSummary,
  parseGitRoot,
  parseGitStatusPorcelain,
  readGitStatus,
} from "./git-status.js";
export {
  contextColor,
  formatCount,
  formatToolActivity,
  prContextFromStatuses,
  prLinkFromStatuses,
  shortenModel,
} from "./render.js";
export {
  normalizeStatuslineSettings,
  readStatuslineSettings,
} from "./settings.js";
