import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { powerlineExtensionSeparator } from "./powerline.js";
import { DEFAULT_EXTENSION_STATUS_ICONS } from "./settings.js";
import type { StatuslineConfig } from "./types.js";

export type ExtensionStatusIconAliasMap = ReadonlyMap<string, readonly string[]>;
export interface ExtensionStatusRuntime {
  duplicateExtensions: string[];
  extensionStatusIconAliases: ExtensionStatusIconAliasMap;
}

const STATUSLINE_KEY = "statusline";
const COMPATIBLE_STATUS_ICON_KEYS: Readonly<Record<string, string>> = {
  retry: "unknown-error-retry",
  sync: "pisync",
  "unknown-error-retry": "retry",
  pisync: "sync",
};
const EMPTY_EXTENSION_STATUS_ICON_ALIASES: ExtensionStatusIconAliasMap = new Map();
function extensionStatusSeparator(config: StatuslineConfig, theme: Theme): string {
  return powerlineExtensionSeparator(theme, config.palettePreset);
}

export function formatExtensionStatuses(
  statuses: ReadonlyMap<string, string>,
  theme: Theme,
  config: StatuslineConfig,
  runtime: ExtensionStatusRuntime,
  hiddenKeys: ReadonlySet<string> = new Set(),
): string {
  const separator = extensionStatusSeparator(config, theme);
  const visibleStatuses = [
    ...formatDuplicateExtensionStatus(runtime, theme),
    ...[...statuses.entries()]
      .filter(([key, value]) => key !== STATUSLINE_KEY && !hiddenKeys.has(key) && value.trim().length > 0)
      .map(([key, value]) => formatExtensionStatus(key, value, theme, config, runtime.extensionStatusIconAliases)),
  ].slice(0, 5);

  return visibleStatuses.join(separator);
}

export function formatExtensionStatus(
  key: string,
  value: string,
  theme: Theme,
  config: Pick<StatuslineConfig, "extensionStatusIcons">,
  extensionStatusIconAliases: ExtensionStatusIconAliasMap = EMPTY_EXTENSION_STATUS_ICON_ALIASES,
): string {
  // An extension hands its status over as display text, and several style it
  // first (pi-mcp-adapter wraps its whole line in theme.fg("accent", …)). The
  // footer owns its own semantic colors, so those are dropped rather than
  // nested — a nested reset would end this status's color early and leak into
  // the next one. Dropping them is also what lets the emoji strip below see a
  // leading badge at all, instead of a CSI introducer.
  const plain = stripStatusColor(value);
  // Badges come off before the key prefix, not after. `pi-mcp-adapter` writes
  // either "MCP: …" or "🔌 MCP: …" depending on one of its settings, and with
  // the badge still attached the value no longer starts with the key, so the
  // prefix survived in one form and was stripped in the other. Same input,
  // same output now — and the label added below is never doubled.
  const withoutBadges = stripStatusEmoji(splitExtensionStatusIcon(plain).text);
  const simplified = simplifyExtensionStatusText(stripExtensionStatusPrefix(key, withoutBadges));
  const text = simplified.length > 0 ? simplified : key;
  const color = extensionColor(key, plain);
  const textColor = color === "warning" ? "warning" : "muted";
  const icon = extensionStatusIcon(key, config.extensionStatusIcons, extensionStatusIconAliases);
  const renderedText = theme.fg(textColor, text);
  if (icon) return `${theme.fg(color, icon)} ${renderedText}`;
  // No icon: the key becomes the label. Something has to say whose status this
  // is, and with `extensionStatusIcons` empty by default nothing else does —
  // the footer would read "6 servers enabled · active · ready" with no way to
  // tell which extension is speaking. The key is also what the prefix strip
  // above removes from the text, so the label restores exactly what it took.
  // Skipped when the text is already the key (an all-emoji status falls back
  // to it), which would otherwise render the name twice.
  return text === key ? renderedText : `${theme.fg(color, key)} ${renderedText}`;
}

function extensionStatusIcon(
  key: string,
  configuredIcons: Record<string, string>,
  extensionStatusIconAliases: ExtensionStatusIconAliasMap,
) {
  if (Object.hasOwn(configuredIcons, key)) return configuredIcons[key];
  const namespaceIcon = configuredNamespaceIcon(key, configuredIcons);
  if (namespaceIcon !== undefined) return namespaceIcon;
  const compatibleKey = COMPATIBLE_STATUS_ICON_KEYS[key];
  if (compatibleKey && Object.hasOwn(configuredIcons, compatibleKey)) {
    return configuredIcons[compatibleKey];
  }
  for (const alias of extensionStatusAliasesForKey(key, extensionStatusIconAliases)) {
    if (Object.hasOwn(configuredIcons, alias)) return configuredIcons[alias];
  }
  // A status may still opt into a badge through JSON, but source-provided
  // icons and generic fallback plugs are intentionally suppressed by default.
  return Object.hasOwn(DEFAULT_EXTENSION_STATUS_ICONS, key) ? DEFAULT_EXTENSION_STATUS_ICONS[key] : "";
}

function configuredNamespaceIcon(key: string, configuredIcons: Readonly<Record<string, string>>): string | undefined {
  let match: { baseLength: number; icon: string } | undefined;
  for (const [selector, icon] of Object.entries(configuredIcons)) {
    if (!selector.endsWith(":*")) continue;
    const base = selector.slice(0, -2);
    if (!base || !key.startsWith(`${base}:`)) continue;
    if (!match || base.length > match.baseLength) match = { baseLength: base.length, icon };
  }
  return match?.icon;
}

function extensionStatusAliasesForKey(
  key: string,
  extensionStatusIconAliases: ExtensionStatusIconAliasMap,
): readonly string[] {
  for (const [statusBase, aliases] of extensionStatusIconAliases) {
    if (statusKeyMatchesStatusBase(key, statusBase)) return aliases;
  }
  return [];
}

function statusKeyMatchesStatusBase(key: string, statusBase: string): boolean {
  return key === statusBase || key.startsWith(`${statusBase}:`) || key.startsWith(`${statusBase}/`);
}

export function wrapExtensionStatusline(status: string, width: number): string[] {
  if (!status || width <= 0) return [];
  return wrapTextWithAnsi(status, width);
}

function formatDuplicateExtensionStatus(runtime: ExtensionStatusRuntime, theme: Theme): string[] {
  if (runtime.duplicateExtensions.length === 0) return [];
  const names = runtime.duplicateExtensions.slice(0, 2).join(", ");
  const suffix = runtime.duplicateExtensions.length > 2 ? ` +${runtime.duplicateExtensions.length - 2}` : "";
  return [`${theme.fg("warning", `duplicate ${names}${suffix}`)}`];
}

/**
 * Code points an emoji sequence is built from. Written once and shared by the
 * three matchers below so a badge cannot be recognized by one and missed by
 * another. Joiners and variation selectors are included because they belong to
 * a sequence, not because either alone makes one — `isEmojiOnlyToken` is what
 * requires a real pictograph to be present.
 */
const EMOJI_CODE_POINT =
  "(?:\\p{Extended_Pictographic}|\\p{Emoji_Modifier}|\\p{Regional_Indicator}|\\u200d|\\ufe0f|[0-9#*]\\ufe0f?\\u20e3)";

/**
 * SGR (color and text-attribute) sequences only — a CSI whose final byte is
 * `m`. Deliberately not the whole-escape sanitizer used for footer segments:
 * `github-pr` publishes its PR number as an OSC 8 hyperlink, and dropping
 * every escape would turn a clickable link into plain digits.
 */
// Assembled from a variable rather than written as a regex literal: an escape
// for a control character is rejected inside one, and a plain string argument
// to RegExp would be auto-rewritten back into a literal.
const ESC = "\u001b";
const SGR_SEQUENCE = new RegExp(`${ESC}\\[[0-9;:]*m`, "gu");

/** Drop an extension's own colors, keeping hyperlinks and text intact. */
export function stripStatusColor(value: string): string {
  return value.replace(SGR_SEQUENCE, "");
}

/** One run of emoji code points, anchored at the start of the string. */
const LEADING_EMOJI_RUN = new RegExp(`^${EMOJI_CODE_POINT}+`, "u");

/** Every run of emoji code points, anywhere in the string. */
const ANY_EMOJI_RUN = new RegExp(`${EMOJI_CODE_POINT}+`, "gu");

/**
 * Peel the leading badge off a status value.
 *
 * The run is matched by code point rather than by whitespace token: an
 * extension that writes `🔌MCP: 6 servers` means the same badge as one that
 * writes `🔌 MCP: 6 servers`, and only the spaced form used to be recognized.
 * Consecutive badges are all removed; `icon` reports the first, which is the
 * one a caller would render as the status's own glyph.
 */
export function splitExtensionStatusIcon(value: string): {
  icon?: string;
  text: string;
} {
  let text = value.trim();
  let icon: string | undefined;
  for (;;) {
    const run = LEADING_EMOJI_RUN.exec(text)?.[0];
    // isEmojiOnlyToken rejects a run of pure modifiers (a stray VS16 or ZWJ),
    // which is not a badge and must stay with the text it decorates.
    if (!run || !isEmojiOnlyToken(run)) break;
    icon ??= run;
    text = text.slice(run.length).trim();
  }
  return icon ? { icon, text } : { text };
}

/**
 * Drop every remaining emoji from a status text.
 *
 * `extensionStatusIcons` is the one supported way to put a glyph in the footer,
 * and it is empty by default: the badge is the user's choice, never the
 * extension's. Stripping only the leading run left mid-string and trailing
 * decorations behind, which is what made the footer read as a pile of
 * unrelated icons. An emoji-only status would collapse to nothing, so it falls
 * back to its own key rather than rendering as an empty segment.
 */
export function stripStatusEmoji(value: string, fallback = ""): string {
  const stripped = value
    .replace(ANY_EMOJI_RUN, (run) => (isEmojiOnlyToken(run) ? " " : run))
    .replace(/\s+/gu, " ")
    .trim();
  return stripped.length > 0 ? stripped : fallback;
}

const EMOJI_ONLY_TOKEN = new RegExp(
  `^(?=.*(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator}|[0-9#*]\\ufe0f?\\u20e3))${EMOJI_CODE_POINT}+$`,
  "u",
);

function isEmojiOnlyToken(value: string): boolean {
  return EMOJI_ONLY_TOKEN.test(value);
}

export function extensionColor(key: string, value: string): ThemeColor {
  const normalized = `${key} ${value}`.toLowerCase();
  if (/missing|error|fail|conflict|duplicate|unavailable/.test(normalized)) return "warning";
  if (normalized.includes("codex")) return "accent";
  if (/ready|active|running|enabled|awake|ok/.test(normalized)) return "success";
  return "muted";
}

export function stripExtensionStatusPrefix(key: string, value: string): string {
  return value.trim().replace(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*`, "iu"), "");
}

export function simplifyExtensionStatusText(value: string): string {
  return value
    .trim()
    .replace(/,\s*/g, " ")
    .replace(/\s+\([^)]*\)\s*$/, "")
    .replace(/\s+/g, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface InstalledExtensionPackage {
  packageName: string;
  source: string;
  identity: string;
}

export function readInstalledExtensionPackages(cwd: string): InstalledExtensionPackage[] {
  const packages: InstalledExtensionPackage[] = [];
  const settingsFiles = extensionSettingsFiles(cwd);

  for (const settingsFile of settingsFiles) {
    const baseDirectory = dirname(settingsFile);
    for (const rawSource of readPackageSources(settingsFile)) {
      const source = rawSource.trim();
      if (!source) continue;
      const packageName = packageNameForSource(source, baseDirectory);
      if (!packageName) continue;
      packages.push({
        packageName,
        source,
        identity: sourceIdentity(source, baseDirectory),
      });
    }
  }

  return packages;
}

function extensionSettingsFiles(cwd: string): string[] {
  return [join(getAgentDir(), "settings.json"), join(cwd, ".pi", "settings.json")].filter((file) => existsSync(file));
}

export function findDuplicateExtensions(installedPackages: readonly InstalledExtensionPackage[]): string[] {
  const sourcesByPackage = new Map<string, Set<string>>();

  for (const extensionPackage of installedPackages) {
    const sources = sourcesByPackage.get(extensionPackage.packageName) ?? new Set<string>();
    sources.add(extensionPackage.identity);
    sourcesByPackage.set(extensionPackage.packageName, sources);
  }

  return [...sourcesByPackage.entries()]
    .filter(([, sources]) => sources.size > 1)
    .map(([packageName]) => packageName.replace(/^@[^/]+\//, "").replace(/^pi-/, ""));
}

export function buildExtensionStatusIconAliases(
  installedPackages: readonly { packageName: string; source?: string }[],
): Map<string, string[]> {
  const packageAliasesByStatusBase = new Map<string, Map<string, string[]>>();

  for (const extensionPackage of installedPackages) {
    const candidate = extensionStatusIconAliasCandidate(extensionPackage.packageName, extensionPackage.source);
    if (!candidate) continue;
    const aliasesByPackage = packageAliasesByStatusBase.get(candidate.statusBase) ?? new Map<string, string[]>();
    const existingAliases = aliasesByPackage.get(extensionPackage.packageName) ?? [];
    aliasesByPackage.set(extensionPackage.packageName, uniqueStrings([...existingAliases, ...candidate.aliases]));
    packageAliasesByStatusBase.set(candidate.statusBase, aliasesByPackage);
  }

  const aliases = new Map<string, string[]>();
  for (const [statusBase, aliasesByPackage] of packageAliasesByStatusBase) {
    if (aliasesByPackage.size === 1) aliases.set(statusBase, [...aliasesByPackage.values()][0] ?? []);
  }
  return aliases;
}

function extensionStatusIconAliasCandidate(
  packageName: string,
  source?: string,
): { statusBase: string; aliases: string[] } | undefined {
  const packageBase = packageBaseName(packageName);
  const statusBase = statusBaseFromPackageBase(packageBase);
  if (!statusBase) return undefined;

  const sourceAliases = source?.startsWith("npm:") ? [source, `npm:${npmPackageName(source)}`] : [];
  return {
    statusBase,
    aliases: uniqueStrings([...sourceAliases, packageName, packageBase, statusBase]),
  };
}

function packageBaseName(packageName: string): string {
  const slashIndex = packageName.lastIndexOf("/");
  return slashIndex === -1 ? packageName : packageName.slice(slashIndex + 1);
}

function statusBaseFromPackageBase(packageBase: string): string {
  return packageBase.startsWith("pi-") && packageBase.length > "pi-".length
    ? packageBase.slice("pi-".length)
    : packageBase;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function readPackageSources(settingsFile: string): string[] {
  try {
    const settings = JSON.parse(readFileSync(settingsFile, "utf8")) as {
      packages?: unknown[];
    };
    return (settings.packages ?? [])
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string") {
          return (entry as { source: string }).source;
        }
        return undefined;
      })
      .filter((source): source is string => source !== undefined);
  } catch {
    return [];
  }
}

function packageNameForSource(source: string, baseDirectory: string): string | undefined {
  if (source.startsWith("npm:")) return npmPackageName(source);
  const packageJson = join(resolveSourcePath(source, baseDirectory), "package.json");
  try {
    const packageData = JSON.parse(readFileSync(packageJson, "utf8")) as {
      name?: unknown;
    };
    return typeof packageData.name === "string" ? packageData.name : undefined;
  } catch {
    return undefined;
  }
}

export function npmPackageName(source: string): string {
  const spec = source.slice("npm:".length);
  if (spec.startsWith("@")) return spec.split("@").slice(0, 2).join("@");
  return spec.split("@")[0] ?? spec;
}

function sourceIdentity(source: string, baseDirectory: string): string {
  if (source.startsWith("npm:")) return `npm:${npmPackageName(source)}`;
  return resolveSourcePath(source, baseDirectory);
}

function resolveSourcePath(source: string, baseDirectory: string): string {
  return isAbsolute(source) ? source : resolve(baseDirectory, source);
}
