import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { formatDirectoryPath } from "./directory.js";
import { type ExtensionStatusRuntime, formatExtensionStatuses, wrapExtensionStatusline } from "./extension-status.js";
import { formatGitBranchValue, type GitStatusSummary } from "./git-status.js";
import { renderPowerlineStatusline, renderTextStatusline } from "./powerline.js";
import { sanitizeTerminalText } from "./terminal.js";
import {
  LINE_BREAK_SEGMENT_NAME,
  type PowerlineBlockName,
  type RenderItem,
  type RenderSegment,
  type SegmentName,
  type StatuslineConfig,
  type TruncationDirection,
} from "./types.js";
import { emptyFooterUsageSummary, type FooterUsageSummary } from "./usage.js";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
export interface RuntimeState extends ExtensionStatusRuntime {
  homeDir?: string;
  turnCount: number;
  activeTools: Map<string, number>;
  isStreaming: boolean;
  thinkingLevel: ThinkingLevel;
  gitStatus?: GitStatusSummary;
  requestRender?: () => void;
  footerUsage?: FooterUsageSummary;
}
const GITHUB_PR_KEY = "github-pr";
const GITHUB_PR_STATUS_KEYS = new Set([GITHUB_PR_KEY]);
export function renderStatusline(
  width: number,
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
  theme: Theme,
  config: StatuslineConfig,
  runtime: RuntimeState,
): string {
  if (width <= 0) return "";

  const usageSummary = runtime.footerUsage ?? emptyFooterUsageSummary();
  const rows: Array<{ configuredSegments: number; segments: RenderSegment[] }> = [
    { configuredSegments: 0, segments: [] },
  ];
  for (const name of config.segments) {
    if (name === LINE_BREAK_SEGMENT_NAME) {
      rows.push({ configuredSegments: 0, segments: [] });
      continue;
    }

    const row = rows.at(-1);
    if (!row) continue;
    row.configuredSegments += 1;
    const rendered = buildSegment(name, ctx, footerData, config, runtime, usageSummary);
    if (rendered && rendered.text.length > 0) row.segments.push(rendered);
  }

  const segments: RenderItem[] = [];
  const renderedRows = rows.filter((row) => row.configuredSegments === 0 || row.segments.length > 0);
  for (const [index, row] of renderedRows.entries()) {
    if (index > 0) segments.push({ name: LINE_BREAK_SEGMENT_NAME });
    segments.push(...row.segments);
  }

  return config.palettePreset === "classic"
    ? renderTextStatusline(width, segments, theme, config)
    : renderPowerlineStatusline(width, segments, config);
}

export function renderExtensionStatusline(
  width: number,
  footerData: ReadonlyFooterDataProvider,
  theme: Theme,
  config: StatuslineConfig,
  runtime: RuntimeState,
  mainLine: string,
): string[] {
  const statuses = footerData.getExtensionStatuses();
  const prContext = prContextFromStatuses(statuses);
  const rendersPrInline = prContext !== undefined && mainLine.includes(prContext);
  const status = formatExtensionStatuses(
    statuses,
    theme,
    config,
    runtime,
    rendersPrInline ? GITHUB_PR_STATUS_KEYS : undefined,
  );
  return wrapExtensionStatusline(status, width);
}

function buildSegment(
  name: SegmentName,
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
  config: StatuslineConfig,
  runtime: RuntimeState,
  usageSummary: FooterUsageSummary,
): RenderSegment | undefined {
  switch (name) {
    case "brand":
      return segment(name, "π", config, "accent", "header", true);
    case "provider":
      return segment(name, sanitizeTerminalText(ctx.model?.provider ?? "no-provider"), config, "accent", "header");
    case "model": {
      const presentation = config.segmentText.model;
      const model = truncateModel(
        shortenModel(ctx.model?.id ?? "no-model"),
        presentation.truncationLength,
        presentation.truncationSymbol,
        presentation.truncationDirection,
      );
      return segment(name, model, config, "accent", "header");
    }
    case "thinking":
      if (runtime.thinkingLevel === "off") return undefined;
      return segment(name, runtime.thinkingLevel, config, thinkingColor(runtime.thinkingLevel), "header");
    case "branch": {
      const branch = footerData.getGitBranch();
      const pr = branch ? prContextFromStatuses(footerData.getExtensionStatuses()) : undefined;
      return segment(
        name,
        formatGitBranchValue(branch, runtime.gitStatus, pr),
        config,
        gitBranchColor(runtime.gitStatus),
        "git",
      );
    }
    case "cwd":
      return segment(
        name,
        formatDirectoryPath(ctx.cwd, runtime.homeDir, runtime.gitStatus?.root),
        config,
        "muted",
        "directory",
      );
    case "tools": {
      const activity = formatToolActivity(runtime);
      return activity ? segment(name, activity, config, "accent", "runtime") : undefined;
    }
    case "context": {
      const usage = ctx.getContextUsage();
      const percentage =
        usage?.percent === null || usage?.percent === undefined
          ? "?"
          : config.palettePreset === "classic"
            ? `${Math.round(usage.percent)}%`
            : `${usage.percent.toFixed(1)}%`;
      const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
      const value = config.palettePreset === "classic" ? percentage : `${percentage}/${formatCount(contextWindow)}`;
      return segment(name, value, config, contextColor(usage?.percent), "runtime");
    }
    case "tokens": {
      const value =
        usageSummary.input === 0 && usageSummary.output === 0
          ? "tok 0"
          : `↑${formatCount(usageSummary.input)} ↓${formatCount(usageSummary.output)}`;
      return segment(name, value, config, "accent", "runtime");
    }
    case "cache": {
      if (usageSummary.cacheRead === 0 && usageSummary.cacheWrite === 0) return undefined;
      const values: string[] = [];
      if (usageSummary.cacheRead > 0) values.push(`R${formatCount(usageSummary.cacheRead)}`);
      if (usageSummary.cacheWrite > 0) values.push(`W${formatCount(usageSummary.cacheWrite)}`);
      if (usageSummary.latestCacheHitRate !== undefined) {
        values.push(`CH${usageSummary.latestCacheHitRate.toFixed(1)}%`);
      }
      return segment(name, values.join(" "), config, "accent", "runtime");
    }
    case "cost": {
      const subscription = isSubscriptionBacked(ctx) ? " (sub)" : "";
      return segment(
        name,
        `${usageSummary.cost.toFixed(usageSummary.cost >= 1 ? 2 : 3)}${subscription}`,
        config,
        "accent",
        "meter",
      );
    }
    case "time":
      return segment(name, formatTime(), config, "accent", "meter");
    case "turn":
      return segment(name, `${runtime.turnCount}`, config, "accent", "meter");
  }
}

function segment(
  name: SegmentName,
  value: string,
  config: StatuslineConfig,
  color: RenderSegment["color"],
  block: PowerlineBlockName,
  emphasis = false,
): RenderSegment {
  return {
    name,
    text: formatConfiguredSegment(name, value, config),
    color,
    block,
    emphasis,
  };
}

export function formatConfiguredSegment(
  name: SegmentName,
  value: string,
  config: Pick<StatuslineConfig, "segmentText">,
): string {
  const presentation = config.segmentText[name];
  return `${presentation.prefix}${value}${presentation.suffix}`;
}

function thinkingColor(level: ThinkingLevel): ThemeColor {
  switch (level as string) {
    case "off":
      return "dim";
    case "minimal":
      return "thinkingMinimal";
    case "low":
      return "thinkingLow";
    case "medium":
      return "thinkingMedium";
    case "high":
      return "thinkingHigh";
    case "xhigh":
      return "thinkingXhigh";
    case "max":
      return "thinkingMax" as ThemeColor;
    default:
      return "dim";
  }
}

export function contextColor(percent: number | null | undefined): ThemeColor {
  if (percent === null || percent === undefined) return "dim";
  if (percent >= 90) return "error";
  if (percent >= 70) return "warning";
  return "muted";
}

function gitBranchColor(status: GitStatusSummary | undefined): ThemeColor {
  if (status?.conflicts && status.conflicts > 0) return "error";
  return "muted";
}

export function formatToolActivity(runtime: RuntimeState): string | undefined {
  const active = [...runtime.activeTools.entries()];
  if (active.length > 0) {
    const [name, count] = active[0] ?? ["tool", 1];
    const suffix = count > 1 ? `×${count}` : active.length > 1 ? `+${active.length - 1}` : "";
    // MCP tool names are chosen by whichever server the user connected, so they are external input.
    return `${sanitizeTerminalText(name)}${suffix}`;
  }

  return runtime.isStreaming ? "thinking" : undefined;
}

export function prLinkFromStatuses(statuses: ReadonlyMap<string, string>): string | undefined {
  const value = statuses.get(GITHUB_PR_KEY);
  if (!value) return undefined;
  // Extract the OSC 8 hyperlink span (the clickable "#123"); skip non-PR states
  // like "PR gh missing" that carry no link. github-pr emits exactly one link, so the
  // first OSC 8 span is the PR number.
  const open = value.indexOf("\x1b]8;;");
  if (open === -1) return undefined;
  const closeMarker = "\x1b]8;;\x07";
  const close = value.indexOf(closeMarker, open + 1);
  return close === -1 ? undefined : value.slice(open, close + closeMarker.length);
}

export function prContextFromStatuses(statuses: ReadonlyMap<string, string>): string | undefined {
  const value = statuses.get(GITHUB_PR_KEY);
  const link = prLinkFromStatuses(statuses);
  if (!value || !link) return undefined;

  const state = compactPrState(value.replace(link, ""));
  return state ? `${link} · ${state}` : undefined;
}

function compactPrState(value: string): string | undefined {
  if (/:\s*merged\s*$/.test(value)) return "merged";
  if (/:\s*closed\s*$/.test(value)) return "closed";
  if (/\bdraft\b/.test(value)) return "draft";

  const failing = /\bchecks failing \((\d+)\)/.exec(value);
  if (failing) return `${failing[1]} failing`;
  if (/\bchanges requested\b/.test(value)) return "changes requested";

  const pending = /\bchecks pending \((\d+)\)/.exec(value);
  if (pending) return `${pending[1]} pending`;
  if (/\bapproved\b/.test(value)) return "approved";
  if (/\breview required\b/.test(value)) return "review required";
  if (/\bchecks passing\b/.test(value)) return "checks passing";
  if (/\bno checks\b/.test(value)) return "no checks";
  return undefined;
}

function isSubscriptionBacked(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  return model !== undefined && (model.provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(model));
}

export function formatCount(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatTime(): string {
  const now = new Date();
  const hours = now.getHours().toString().padStart(2, "0");
  const minutes = now.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

export function truncateModel(model: string, length: number, symbol: string, direction: TruncationDirection): string {
  const safeModel = sanitizeTerminalText(model);
  if (length === 0) return safeModel;
  const graphemes = [...graphemeSegmenter.segment(safeModel)].map(({ segment }) => segment);
  if (graphemes.length <= length) return safeModel;
  const safeSymbol = sanitizeTerminalText(symbol);

  switch (direction) {
    case "start":
      return `${safeSymbol}${graphemes.slice(-length).join("")}`;
    case "middle": {
      const headLength = Math.ceil(length / 2);
      const tailLength = Math.floor(length / 2);
      const tail = tailLength > 0 ? graphemes.slice(-tailLength).join("") : "";
      return `${graphemes.slice(0, headLength).join("")}${safeSymbol}${tail}`;
    }
    case "end":
      return `${graphemes.slice(0, length).join("")}${safeSymbol}`;
  }
}

export function shortenModel(model: string): string {
  return model
    .replace(/^claude-/, "")
    .replace(/-20\d{6}$/, "")
    .replace(/-latest$/, "");
}
