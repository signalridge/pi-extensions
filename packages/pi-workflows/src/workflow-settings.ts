/** Small, package-owned workflow presentation and routing settings. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isManagedAgentTier } from "@signalridge/pi-subagents-protocol";
import { isWorkflowStrength, type WorkflowStrength, type WorkflowStrengthTable } from "./strengths.js";

export type WorkflowProgressMode = "compact" | "detailed";

export interface WorkflowSettings {
  progressMode?: WorkflowProgressMode;
  maxAgentsShown?: number;
  effort?: "off" | "high" | "ultra";
  keywordTriggerWord?: string;
  keywordTriggerEnabled?: boolean;
  /**
   * Which Agent tier each workflow strength runs on: all of workflow routing.
   *
   * A script names a strength — one of `low`/`medium`/`high`, this package's
   * own word for how much effort a step deserves — and this table is the only
   * thing that binds one to an Agent tier. A strength it does not define
   * dispatches with no tier at all and takes the agent's ordinary default.
   *
   * Absent entirely, the run uses `defaultStrengthTable()`: each strength on
   * the catalogue tier of the same name, wherever this host defines one. That
   * default is a table and not a fallback rule, so writing one here replaces it
   * outright and a strength this file omits stays unmapped even on a host that
   * defines a tier of the same name. Which is what keeps a 26-agent fan-out
   * re-priceable without dragging the Explore agent and everything else that
   * names the same tier: point the strength elsewhere, do not edit the tier.
   *
   * This is not the retired `workflow.tiers` key and must not become it. That
   * one carried its own model and thinking values, which made it a second model
   * policy resolved by a second resolver. Every value here is a *key in the
   * host's one catalogue* and nothing else: pi-subagents still owns every model,
   * every thinking level, and the only `resolveAgentTier()`. What this table
   * decides is which key a workflow asks for, and pi-subagents cannot tell that
   * choice apart from a script that named the key itself. No entry here may ever
   * grow a `model` or `thinking` field — that is the line between this and the
   * key that was deleted, and the name no longer states it, so this does.
   *
   * Any key the host defines is a legal value. There is no shortlist: the target
   * is checked against the live catalogue at run start, so a profile added to
   * subagents.json is usable here the moment it exists.
   *
   * A project that defines this table replaces the global one outright rather
   * than merging into it, so a project can shorten the table and not only
   * extend it; a project that omits it inherits the global table unchanged.
   */
  strengths?: WorkflowStrengthTable;
}

/**
 * Keep the entries a run could actually honor: a known strength, a usable key.
 *
 * The key side is the closed vocabulary, not a shape test. A word outside it
 * can never match what a script asks for, so storing one would put a line in
 * the file that looks like policy and can never fire. The value side is only a
 * shape test, because the catalogue belongs to the host and may gain the tier
 * later — the live check happens at run start.
 *
 * A strength mapped to its own spelling is kept, unlike every earlier revision
 * of this function. It stopped being a no-op when the passthrough went away:
 * `low → low` is the only way a written table can say "run this on the
 * catalogue tier that happens to share the name" — the shipped default says it
 * for a file that is absent, not for one that is present and omits the entry —
 * so dropping it as redundant would silently mean the opposite.
 *
 * Malformed entries are dropped rather than tombstoned, which is what every
 * other key in this file does — the catalogue that owns tombstones is the one
 * in pi-subagents, and inventing a second tombstone vocabulary for this table
 * would be a heavier promise than the table is worth.
 */
function sanitizeStrengths(raw: unknown): WorkflowStrengthTable | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  // An empty table is kept, because it is a statement: "map nothing; every
  // strength takes the agent's default". It became sayable — and worth saying —
  // once an absent key started meaning the shipped default instead of that. A
  // table whose every entry was dropped is not the same statement; it is a
  // broken file, and storing it as an explicit "map nothing" would promote a
  // typo to a policy, so that one still yields undefined below.
  if (Object.keys(raw).length === 0) return {};
  const strengths: Partial<Record<WorkflowStrength, string>> = {};
  // No entry cap: the vocabulary is closed, so the table cannot outgrow it.
  for (const [strength, tier] of Object.entries(raw as Record<string, unknown>)) {
    if (!isWorkflowStrength(strength) || !isManagedAgentTier(tier)) continue;
    strengths[strength] = tier;
  }
  return Object.keys(strengths).length > 0 ? strengths : undefined;
}

const DEFAULT_SETTINGS: Required<
  Pick<WorkflowSettings, "progressMode" | "maxAgentsShown" | "effort" | "keywordTriggerEnabled">
> = {
  progressMode: "compact",
  maxAgentsShown: 6,
  effort: "off",
  keywordTriggerEnabled: true,
};

function projectDirectory(cwd: string): string {
  const absolute = resolve(cwd);
  const digest = createHash("sha256").update(absolute).digest("hex").slice(0, 12);
  return join(getAgentDir(), "workflows", "projects", `${basename(absolute) || "root"}-${digest}`);
}

function readSettings(path: string): WorkflowSettings {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const value = parsed as Record<string, unknown>;
    const strengths = sanitizeStrengths(value.strengths);
    return {
      ...(value.progressMode === "compact" || value.progressMode === "detailed"
        ? { progressMode: value.progressMode }
        : {}),
      ...(typeof value.maxAgentsShown === "number" &&
      Number.isInteger(value.maxAgentsShown) &&
      value.maxAgentsShown >= 1 &&
      value.maxAgentsShown <= 32
        ? { maxAgentsShown: value.maxAgentsShown }
        : {}),
      ...(value.effort === "off" || value.effort === "high" || value.effort === "ultra"
        ? { effort: value.effort }
        : {}),
      ...(typeof value.keywordTriggerWord === "string" &&
      /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(value.keywordTriggerWord)
        ? { keywordTriggerWord: value.keywordTriggerWord.toLowerCase() }
        : {}),
      ...(typeof value.keywordTriggerEnabled === "boolean"
        ? { keywordTriggerEnabled: value.keywordTriggerEnabled }
        : {}),
      ...(strengths ? { strengths } : {}),
    };
  } catch {
    return {};
  }
}

export function loadWorkflowSettings(
  cwd: string = process.cwd(),
): WorkflowSettings & Required<Pick<WorkflowSettings, "progressMode" | "maxAgentsShown" | "effort">> {
  const globalPath = join(getAgentDir(), "workflows", "settings.json");
  const projectPath = join(projectDirectory(cwd), "settings.json");
  return { ...DEFAULT_SETTINGS, ...readSettings(globalPath), ...readSettings(projectPath) };
}

/**
 * Only what this project's own file says, with no global or default layered in.
 *
 * What a command has to edit, because {@link saveWorkflowSettings} writes the
 * project file wholesale: handed the merged view, it would copy every global
 * value and every default into the project on the first edit, and the project
 * would stop tracking the global file from then on. That is loud for
 * `strengths`, which a project replaces outright rather than merging.
 */
export function loadProjectWorkflowSettings(cwd: string = process.cwd()): WorkflowSettings {
  return readSettings(join(projectDirectory(cwd), "settings.json"));
}

/** Replace this project's settings file. Pass project scope, never the merged view. */
export function saveWorkflowSettings(settings: WorkflowSettings, cwd: string = process.cwd()): void {
  const savedStrengths = sanitizeStrengths(settings.strengths);
  const safe: WorkflowSettings = {
    ...(settings.progressMode === "compact" || settings.progressMode === "detailed"
      ? { progressMode: settings.progressMode }
      : {}),
    ...(typeof settings.maxAgentsShown === "number" &&
    Number.isInteger(settings.maxAgentsShown) &&
    settings.maxAgentsShown >= 1 &&
    settings.maxAgentsShown <= 32
      ? { maxAgentsShown: settings.maxAgentsShown }
      : {}),
    ...(settings.effort === "off" || settings.effort === "high" || settings.effort === "ultra"
      ? { effort: settings.effort }
      : {}),
    ...(typeof settings.keywordTriggerWord === "string" &&
    /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(settings.keywordTriggerWord)
      ? { keywordTriggerWord: settings.keywordTriggerWord.toLowerCase() }
      : {}),
    ...(typeof settings.keywordTriggerEnabled === "boolean"
      ? { keywordTriggerEnabled: settings.keywordTriggerEnabled }
      : {}),
    ...(savedStrengths ? { strengths: savedStrengths } : {}),
  };
  const directory = projectDirectory(cwd);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "settings.json");
  const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(safe, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  renameSync(temporary, path);
}
