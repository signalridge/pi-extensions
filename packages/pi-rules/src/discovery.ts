import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseRule, type Rule, type RuleSource } from "./rule.js";

export interface RuleDirectory {
  source: RuleSource;
  dir: string;
  extension: ".md" | ".mdc";
  project: boolean;
  label: string;
}

export interface Diagnostic {
  level: "error" | "warning" | "info";
  message: string;
}

export interface RuleSet {
  /** Effective rules in precedence order: source order, then file name. */
  rules: readonly Rule[];
  shadowed: readonly { path: string; source: RuleSource; by: string }[];
  disabled: readonly { name: string; path: string; source: RuleSource }[];
  diagnostics: readonly Diagnostic[];
  projectTrusted: boolean;
}

export const MAX_RULE_FILE_BYTES = 64 * 1024;
export const MAX_RULE_FILES_PER_DIRECTORY = 200;

export const SOURCE_LABELS: Record<RuleSource, string> = {
  "project-pi": ".pi/rules",
  "project-agents": ".agents/rules",
  "project-cursor": ".cursor/rules",
  user: "user rules",
};

/** Rule directories in precedence order: project before user, Pi before the shared and Cursor formats. */
export function ruleDirectories(cwd: string, agentDir: string): RuleDirectory[] {
  return [
    {
      source: "project-pi",
      dir: join(cwd, ".pi", "rules"),
      extension: ".md",
      project: true,
      label: ".pi/rules",
    },
    {
      source: "project-agents",
      dir: join(cwd, ".agents", "rules"),
      extension: ".md",
      project: true,
      label: ".agents/rules",
    },
    {
      source: "project-cursor",
      dir: join(cwd, ".cursor", "rules"),
      extension: ".mdc",
      project: true,
      label: ".cursor/rules",
    },
    {
      source: "user",
      dir: join(agentDir, "rules"),
      extension: ".md",
      project: false,
      label: join(agentDir, "rules"),
    },
  ];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rule file names in one directory, sorted so discovery order never depends on the filesystem. */
function listRuleFiles(directory: RuleDirectory, diagnostics: Diagnostic[]): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory.dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR")
      diagnostics.push({
        level: "error",
        message: `${directory.label}: cannot list rules: ${errorText(error)}`,
      });
    return [];
  }
  const names = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(directory.extension))
    .map((entry) => entry.name)
    .sort();
  if (names.length > MAX_RULE_FILES_PER_DIRECTORY) {
    diagnostics.push({
      level: "error",
      message: `${directory.label}: ${names.length} rule files; only the first ${MAX_RULE_FILES_PER_DIRECTORY} by name are read`,
    });
    return names.slice(0, MAX_RULE_FILES_PER_DIRECTORY);
  }
  return names;
}

function readRuleText(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("not a regular file");
  if (stat.size > MAX_RULE_FILE_BYTES) throw new Error(`larger than ${MAX_RULE_FILE_BYTES / 1024} KiB`);
  return readFileSync(path, "utf8");
}

export interface LoadRulesOptions {
  cwd: string;
  agentDir: string;
  /** `ctx.isProjectTrusted()`: project rule directories are read only when it is true. */
  projectTrusted: boolean;
}

/**
 * Discover rule files and deduplicate them by name. The first file with a
 * name wins; a file that fails to parse still claims its name, so a broken
 * project rule never silently hands its name to a user rule.
 */
export function loadRules(options: LoadRulesOptions): RuleSet {
  const diagnostics: Diagnostic[] = [];
  const rules: Rule[] = [];
  const shadowed: { path: string; source: RuleSource; by: string }[] = [];
  const disabled: { name: string; path: string; source: RuleSource }[] = [];
  const claimed = new Map<string, string>();
  for (const directory of ruleDirectories(options.cwd, options.agentDir)) {
    const files = listRuleFiles(directory, diagnostics);
    if (directory.project && !options.projectTrusted) {
      if (files.length > 0)
        diagnostics.push({
          level: "info",
          message: `${directory.label}: ${files.length} rule file(s) not loaded because the project is not trusted`,
        });
      continue;
    }
    for (const file of files) {
      const path = join(directory.dir, file);
      const name = file.slice(0, -directory.extension.length);
      const owner = claimed.get(name);
      if (owner !== undefined) {
        shadowed.push({ path, source: directory.source, by: owner });
        continue;
      }
      let text: string;
      try {
        text = readRuleText(path);
      } catch (error) {
        claimed.set(name, path);
        diagnostics.push({
          level: "error",
          message: `${path}: ${errorText(error)}`,
        });
        continue;
      }
      const result = parseRule(name, path, directory.source, text);
      if (result.kind === "disabled") {
        disabled.push({ name, path, source: directory.source });
        continue;
      }
      claimed.set(name, path);
      if (result.kind === "error") {
        diagnostics.push({
          level: "error",
          message: `${path}: ${result.error}`,
        });
        continue;
      }
      rules.push(result.rule);
      for (const warning of result.rule.warnings)
        diagnostics.push({ level: "warning", message: `${path}: ${warning}` });
    }
  }
  return {
    rules,
    shadowed,
    disabled,
    diagnostics,
    projectTrusted: options.projectTrusted,
  };
}
