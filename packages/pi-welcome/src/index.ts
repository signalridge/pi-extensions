/**
 * Signalridge startup card for Pi.
 *
 * The card is a compact, rounded summary of the current workspace. It uses the
 * active Pi theme and semantic labels instead of a second palette or a bundled
 * font, so it stays legible in both dark and light terminals.
 *
 * It is meant to be the ONLY thing a session opens with. Pi's own startup is a
 * header, a key-hint block, and one `[Section]` per resource kind with a blank
 * line between each; stacking this card underneath produced two unrelated
 * designs and about forty-five lines of them. So the card carries the pieces
 * worth keeping — the key hints and a live resource inventory — and `quietStartup`
 * is turned on in settings to silence the rest. With `quietStartup: false` Pi
 * still prints its own block and the two appear together again.
 *
 * The card is a custom entry, not a widget: it lands in the transcript, scrolls
 * away as the conversation grows, and survives a reload. Workspace facts are
 * captured at session_start and stored in the entry; inventory is collected at
 * component creation, after Pi binds resources, including on resume.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";

import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type KeybindingHints,
  keyText,
  loadProjectContextFiles,
  SettingsManager,
  type Theme,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "welcome-card";

/**
 * A pi letterform: one beam over two legs, drawn in the accent color.
 *
 * The mark says the same thing as the title line beside it — one for the eye,
 * one for the reader — rather than being a texture that could belong to any
 * tool. The legs are solid blocks rather than thin verticals so the two rows
 * carry equal weight; hairlines wash out at small font sizes.
 *
 * Block Elements only. Each is exactly one column in every terminal font, while
 * an emoji or a private-use glyph falls back to something double-width on some
 * machines and shifts the text beside it out of alignment.
 */
const MARK = ["▄▄▄▄▄▄", "▐█  █▌"] as const;
const SUBTITLE = "A focused coding workspace";

/** Columns of padding inside the card. */
const PAD = 2;

/** Below this width, use a compact no-border layout rather than overflow. */
const MIN_WIDTH = 20;

/** Sentinel row rendered as a blank line, separating the card's groups. */
const GAP: [string, string] = ["", ""];

/**
 * Names to spell out in a resource row before collapsing the rest into `+N`.
 *
 * Pi's own listing prints every name and lets it wrap; with `quietStartup` on
 * that listing is gone and this card is the only place the inventory appears,
 * so it errs toward showing names rather than a bare count. Eight is what fits
 * on one line at a normal width without turning the card into the wall of text
 * the merge was meant to remove.
 */
const MAX_NAMES = 8;

interface WelcomeData {
  rows: [string, string][];
  /**
   * Legacy key hints (new entries store only facts). Kept as separate items rather than one joined
   * string so a narrow card can drop the trailing ones instead of wrapping a
   * separator onto a line of its own. Optional because an entry written before
   * this field existed replays without any.
   */
  hints?: string[];
}

// ─── Fact Collection ───────────────────────────────────────────────────────────

function tildify(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** `main [+392 -202]`, or undefined outside a repo. Best-effort and never throws. */
function gitSummary(cwd: string): string | undefined {
  const git = (args: string[]): string | undefined => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return undefined;
    }
  };

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) return undefined;

  // --numstat over HEAD covers staged + unstaged; untracked files are excluded
  // on purpose, matching what `git diff` itself reports.
  const numstat = git(["diff", "HEAD", "--numstat"]);
  if (!numstat) return branch;

  let added = 0;
  let removed = 0;
  for (const line of numstat.split("\n")) {
    const [a, r] = line.split("\t");
    // Binary files report "-" for both counts.
    added += Number.parseInt(a ?? "", 10) || 0;
    removed += Number.parseInt(r ?? "", 10) || 0;
  }
  return added || removed ? `${branch} [+${added} -${removed}]` : branch;
}

/** Resolve trusted, merged settings with Pi's own defaults and model validation. */
function compactionTrigger(pi: ExtensionAPI, ctx: ExtensionContext): number | undefined {
  try {
    const settings = pi.getSettings?.();
    if (!settings || !ctx.model) return undefined;
    const compaction = SettingsManager.inMemory(settings).getCompactionSettings(ctx.model);
    const trigger = ctx.model.contextWindow - compaction.reserveTokens;
    return compaction.enabled && trigger > 0 ? trigger : undefined;
  } catch {
    // An invalid configuration (or older host without settings) is not a known
    // automatic trigger. Do not invent a budget from raw files or invalid values.
    return undefined;
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** `a, b, c +58` — the first few names, then how many were left out. */
function nameList(names: readonly string[], max = MAX_NAMES): string | undefined {
  if (names.length === 0) return undefined;
  const shown = names.slice(0, max).join(", ");
  const rest = names.length - max;
  return rest > 0 ? `${shown} +${rest}` : shown;
}

/** Sorted, de-duplicated, and free of empties — every row is built from this. */
function tidy(names: Iterable<string>): string[] {
  return [...new Set([...names].map((name) => name.trim()).filter((name) => name.length > 0))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/**
 * `ctrl+c` as `Ctrl+C`: key names read as proper nouns, the words after them
 * stay lowercase. Pi capitalizes the same way internally but does not export
 * the helper, so this repeats the one rule rather than reaching past the
 * package's public surface.
 */
function capitalizeKey(key: string): string {
  return key.replace(/[^+/]+/gu, (part) => part.charAt(0).toUpperCase() + part.slice(1));
}

/**
 * The key hints Pi's own header would have shown, as plain text.
 *
 * Renderers pass the host-injected formatter so remapped and unbound keys
 * reflect the host, even when the extension resolves a separate SDK copy.
 * The no-argument form remains available for existing callers. Use plain
 * `keyText`, not styled `keyHint`, so the card's supplied theme owns styling.
 */
export function collectHints(hints: Pick<KeybindingHints, "keyText"> = { keyText }): string[] {
  try {
    // Ordered most useful first: a narrow card keeps the head of this list.
    return [
      [capitalizeKey(hints.keyText("app.interrupt")), "interrupt"],
      ["/", "commands"],
      ["!", "bash"],
      [capitalizeKey(hints.keyText("app.clear")), "clear"],
      [capitalizeKey(hints.keyText("app.tools.expand")), "expand tools"],
    ]
      .filter(([key]) => key && key.length > 0)
      .map(([key, description]) => `${key} ${description}`);
  } catch {
    // If the formatter is unavailable, omit hints rather than invent bindings.
    return [];
  }
}

/** Configured packages are not proof of loaded extensions (skills-only is valid). */
function collectPackageNames(pi: ExtensionAPI): string[] {
  try {
    return tidy(
      (pi.getSettings?.().packages ?? [])
        .filter((entry) => {
          if (typeof entry === "string") return true;
          // Respect packages explicitly filtered to no resources. A skills-only
          // package still belongs here, even with extensions: [].
          return (["extensions", "skills", "prompts", "themes"] as const).some((kind) => {
            const patterns = entry[kind];
            if (patterns === undefined) return entry.autoload !== false;
            if (patterns.length === 0) return false;
            // Default autoload starts with all resources when filters contain
            // only exclusions; autoload:false starts empty and needs an include.
            return (
              entry.autoload !== false ||
              patterns.some((pattern) => !pattern.startsWith("!") && !pattern.startsWith("-"))
            );
          });
        })
        .map((entry) => {
          const source = typeof entry === "string" ? entry : entry.source;
          const spec = source.replace(/^npm:/u, "");
          const bare = (spec.startsWith("@") ? (spec.split("/")[1] ?? spec) : basename(spec)).replace(/@.*$/u, "");
          return bare.replace(/^pi-/u, "");
        }),
    );
  } catch {
    return [];
  }
}

/**
 * Live registered skills/prompts/tools, available themes, selected context
 * filenames, and configured packages. Not a claim that every package loaded.
 *
 * With `quietStartup` on those sections are gone and nothing brings them back
 * (`/reload` re-runs the same suppressed listing), so this card is the only
 * place the inventory appears and it names things rather than counting them.
 *
 * Skills and prompts come from `getCommands()`, not from `loadSkills()`: an
 * extension may contribute skill paths through `resources_discover`, which is
 * where most of them come from here, and the standalone loader cannot see those
 * — it reports zero on a session showing dozens. `getCommands()` reports what
 * Pi actually registered, which is the honest answer to "what loaded".
 */
export function collectResources(pi: ExtensionAPI, cwd: string, ui?: ExtensionContext["ui"]): [string, string][] {
  const rows: [string, string][] = [];
  const push = (label: string, value: string | undefined) => {
    if (value) rows.push([label, value]);
  };

  try {
    const files = loadProjectContextFiles({ cwd, agentDir: getAgentDir() });
    // Several scopes can contribute the same filename (a project AGENTS.md and
    // a global one); the card names kinds of context, not paths.
    push("Context", nameList(tidy(files.map((file) => basename(file.path)))));
  } catch {
    // One unreadable source drops its row; the card still renders the rest.
  }

  try {
    const commands = pi.getCommands?.() ?? [];
    const named = (source: string, prefix = "") =>
      tidy(
        commands
          .filter((command) => command.source === source)
          .map((command) => `${prefix}${source === "skill" ? command.name.replace(/^skill:/u, "") : command.name}`),
      );
    push("Skills", nameList(named("skill")));
    push("Prompts", nameList(named("prompt", "/")));
  } catch {
    // A host without these accessors simply contributes no rows.
  }

  push("Configured packages", nameList(collectPackageNames(pi)));
  try {
    push("Available themes", nameList(tidy((ui?.getAllThemes() ?? []).map((theme) => theme.name))));
  } catch {
    // Themes are a TUI surface; an older host may not provide it.
  }

  try {
    const all = pi.getAllTools?.() ?? [];
    const active = pi.getActiveTools?.() ?? [];
    if (all.length) push("Tools", `${active.length} active of ${all.length}`);
  } catch {
    // A host without these accessors simply contributes no rows.
  }

  return rows;
}

function collect(pi: ExtensionAPI, ctx: ExtensionContext): WelcomeData {
  const rows: [string, string][] = [];
  const push = (label: string, value: string | undefined) => {
    if (value) rows.push([label, value]);
  };

  const trusted = (() => {
    try {
      return ctx.isProjectTrusted() ? "" : "  (untrusted)";
    } catch {
      return "";
    }
  })();
  push("Directory", tildify(ctx.cwd) + trusted);
  push("Branch", gitSummary(ctx.cwd));

  // Keep the fresh-session label short; raw session ids add noise without
  // helping orientation — they are a timestamp glued to a uuid, identical in
  // shape every time.
  push("Session", pi.getSessionName?.() || "(new)");

  const model = ctx.model;
  if (model) {
    const id = model.id;
    const provider = model.provider;
    const thinking = ctx.thinkingLevel ? ` · thinking ${ctx.thinkingLevel}` : "";
    push("Model", `${provider ? `${provider} / ` : ""}${id}${thinking}`);

    const window = model.contextWindow;
    if (typeof window === "number" && window > 0) {
      // Pi compacts at contextWindow - reserveTokens; surfacing the trigger up
      // front is the one number that actually governs a long session.
      const threshold = compactionTrigger(pi, ctx);
      const trigger = threshold !== undefined ? ` · compacts at ${formatTokens(threshold)}` : "";
      push("Budget", `${formatTokens(window)}${trigger}`);
    }
  }

  return { rows }; // Keybindings are live presentation, not persisted workspace facts.
}

// ─── Card Component ────────────────────────────────────────────────────────────

/**
 * Card facts come from a directory name, a git branch name and a session name.
 * All three are attacker-controlled in a cloned repository, and the card is a
 * persisted entry, so a poisoned fact is replayed on every resume. Neutralize
 * C0/C1 controls and bidi overrides here, at the terminal boundary, so a stored
 * entry written before this landed is cleaned up on the way out too.
 *
 * Duplicated rather than shared, per the package boundary rule; `pi-stamp`'s
 * metadata sanitizer is the reference shape.
 */
export function sanitizeCardText(value: string): string {
  let safe = "";
  for (const character of value) {
    safe += isUnsafeTerminalCodePoint(character.codePointAt(0) ?? 0) ? " " : character;
  }
  return safe.replace(/\s+/gu, " ").trim();
}

function isUnsafeTerminalCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

/**
 * Join as many hints as fit on one line, dropping from the end.
 *
 * Wrapping would put a leading `·` at the start of the continuation, which
 * reads as a bullet for the line below it rather than a separator. Losing the
 * last hint costs less than that, and the list is ordered so the ones worth
 * keeping come first.
 */
export function fitHints(hints: readonly string[], width: number): string | undefined {
  for (let count = hints.length; count > 0; count--) {
    const line = hints.slice(0, count).join(" · ");
    if (visibleWidth(line) <= width) return line;
  }
  return undefined;
}

export class WelcomeCard implements Component {
  private readonly rows: [string, string][];
  private readonly hints: string[];

  constructor(
    data: WelcomeData,
    private readonly theme: Theme,
    private readonly keybindings?: Pick<KeybindingHints, "keyText">,
  ) {
    this.rows = data.rows.map(([label, value]) => [sanitizeCardText(label), sanitizeCardText(value)]);
    // The entry is replayed from a session file on disk, which an older build
    // (or a hand edit) may have written with a different shape for this field.
    this.hints = (Array.isArray(data.hints) ? data.hints : [])
      .filter((hint): hint is string => typeof hint === "string")
      .map(sanitizeCardText)
      .filter((hint) => hint.length > 0);
  }

  /** Pad or truncate a (possibly styled) string to exactly `width` columns. */
  private fit(text: string, width: number): string {
    const safeWidth = Math.max(0, width);
    const renderedWidth = visibleWidth(text);
    if (renderedWidth > safeWidth) return truncateToWidth(text, safeWidth, "");
    return text + " ".repeat(safeWidth - renderedWidth);
  }

  private renderCompact(width: number, hints: readonly string[]): string[] {
    const t = this.theme;
    const lines = [
      t.fg("muted", hints.length > 0 ? (hints[0] ?? "ready") : "ready"),
      ...this.rows.map(([label, value]) =>
        label === GAP[0] && value === GAP[1] ? "" : `${t.fg("dim", `${label}:`)} ${t.fg("text", value)}`,
      ),
    ];
    return lines.map((line) => truncateToWidth(line, Math.max(1, width), ""));
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const hints = this.keybindings ? collectHints(this.keybindings).map(sanitizeCardText) : this.hints;
    if (safeWidth < MIN_WIDTH) return this.renderCompact(safeWidth, hints);

    const t = this.theme;
    const border = (text: string) => t.fg("borderAccent", text);
    const inner = safeWidth - 2;
    const line = (content: string) => border("│") + this.fit(content, inner) + border("│");
    const blank = () => line("");
    const pad = " ".repeat(PAD);
    const body: string[] = [blank()];

    // The mark names pi, not a vendor: what a returning user needs from the top
    // of the card is which tool and which version, and a company name is
    // neither. The version rides the title line because it belongs to the same
    // fact.
    const markWidth = Math.max(...MARK.map(visibleWidth));
    body.push(
      line(pad + t.fg("accent", MARK[0].padEnd(markWidth)) + pad + t.bold(t.fg("text", `pi v${VERSION}`))),
      line(pad + t.fg("accent", MARK[1].padEnd(markWidth)) + pad + t.fg("muted", SUBTITLE)),
      blank(),
    );

    const hintLine = fitHints(hints, Math.max(1, inner - PAD * 2));
    if (hintLine) {
      // The whole line is dimmed rather than highlighting each key: this is
      // orientation, not a control the user is meant to look at.
      body.push(line(pad + t.fg("dim", hintLine)), blank());
    }

    const labelWidth = this.rows.length ? Math.max(...this.rows.map(([label]) => visibleWidth(label))) + 2 : 0;
    for (const [label, value] of this.rows) {
      if (label === GAP[0] && value === GAP[1]) {
        body.push(blank());
        continue;
      }

      const gutter = pad + `${label}:`.padEnd(labelWidth);
      const room = Math.max(1, inner - visibleWidth(gutter) - PAD);
      const [head, ...tail] = wrapTextWithAnsi(value, room);
      body.push(line(t.fg("dim", gutter) + t.fg("text", head ?? "")));
      for (const continuation of tail) {
        body.push(line(" ".repeat(visibleWidth(gutter)) + t.fg("text", continuation)));
      }
    }

    body.push(blank());
    const rule = (left: string, right: string) => border(left + "─".repeat(inner) + right);
    return [rule("╭", "╮"), ...body, rule("╰", "╯")];
  }

  invalidate(): void {}
}

// ─── Extension Entry ───────────────────────────────────────────────────────────

const INVENTORY_LABELS = new Set([
  "Inventory",
  "Context",
  "Skills",
  "Prompts",
  "Extensions",
  "Themes",
  "Tools",
  "Configured packages",
  "Available themes",
]);

function withLiveInventory(data: WelcomeData, pi: ExtensionAPI, ctx: ExtensionContext): WelcomeData {
  // Remove legacy persisted inventory too, while preserving original workspace
  // facts on resume. Do not rewrite the stored entry during rendering.
  const rows = data.rows.filter(([label]) => label !== "" && !INVENTORY_LABELS.has(label));
  const resources = collectResources(pi, ctx.cwd, ctx.ui);
  if (resources.length > 0) rows.push(GAP, ["Inventory", "live at render"], ...resources);
  return { ...data, rows };
}

export default function (pi: ExtensionAPI) {
  let currentContext: ExtensionContext | undefined;
  pi.registerEntryRenderer<WelcomeData>(ENTRY_TYPE, (entry, options, theme) => {
    const data = entry.data;
    if (!data?.rows?.length) return undefined;
    const live = currentContext ? withLiveInventory(data, pi, currentContext) : data;
    // Ignore legacy persisted hints on replay; never rewrite the stored entry.
    return new WelcomeCard(live, theme, options);
  });

  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx.mode === "tui" ? ctx : undefined;
    if (!currentContext) return;

    try {
      // The transcript uses the active, compaction-aware projection, not every
      // entry in the file. An off-branch or summarized card is not visible.
      const visible = ctx.sessionManager.buildContextEntries();
      if (visible.some((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE)) return;

      // Restore facts from this branch if compaction summarized its card. Never
      // borrow facts from an abandoned sibling branch.
      const original = ctx.sessionManager
        .getBranch()
        .find((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE);
      const data = original?.type === "custom" ? (original.data as WelcomeData | undefined) : undefined;
      pi.appendEntry<WelcomeData>(ENTRY_TYPE, data?.rows?.length ? data : collect(pi, ctx));
    } catch {
      // A missing card is not worth failing a session start over.
    }
  });
}
