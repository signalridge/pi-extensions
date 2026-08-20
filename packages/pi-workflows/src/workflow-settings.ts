/** Small, package-owned workflow presentation settings. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type WorkflowProgressMode = "compact" | "detailed";

export interface WorkflowSettings {
  progressMode?: WorkflowProgressMode;
  maxAgentsShown?: number;
  effort?: "off" | "high" | "ultra";
  keywordTriggerWord?: string;
  keywordTriggerEnabled?: boolean;
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

export function saveWorkflowSettings(settings: WorkflowSettings, cwd: string = process.cwd()): void {
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
  };
  const directory = projectDirectory(cwd);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "settings.json");
  const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(safe, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  renameSync(temporary, path);
}
