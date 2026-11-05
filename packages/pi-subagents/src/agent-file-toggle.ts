/**
 * agent-file-toggle.ts — Pure helpers for `/agents` file-editing operations:
 * locating an agent's .md file, toggling its `enabled:` frontmatter flag, and
 * serializing an AgentConfig back to frontmatter for eject.
 *
 * Reading uses the same YAML parser as custom-agent loading. Editing stays
 * line-wise so hand-authored comments, key order, quoting, and line endings
 * survive untouched.
 */

import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./types.js";

export {
  agentFileLockOwnerPath,
  agentFileLockPath,
  atomicCreateFile,
  atomicReplaceFile,
  removeFileIfUnchanged,
  withAgentFileLock,
} from "./agent-file-mutations.js";

export type AgentFileLocation = "project" | "workspace" | "personal";

export const projectAgentsDir = (cwd: string = process.cwd()) => join(cwd, ".pi", "agents");
export const workspaceAgentsDir = (cwd: string = process.cwd()) => join(cwd, ".agents", "agents");
export const personalAgentsDir = () => join(getAgentDir(), "agents");

function samePath(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/**
 * Validate generated agent markdown with the same parser used by discovery.
 * Unlike discovery's forgiving loader, generation must reject plain prose,
 * missing delimiters, and model-added markdown fences before any write.
 */
export function validateAgentFileContent(content: string): void {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") {
    throw new Error("agent definition must start with YAML frontmatter");
  }
  const closeIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closeIndex === -1) {
    throw new Error("agent definition is missing the closing frontmatter delimiter");
  }

  const parsed = parseFrontmatter<Record<string, unknown>>(content);
  if (typeof parsed.frontmatter !== "object" || parsed.frontmatter === null || Array.isArray(parsed.frontmatter)) {
    throw new Error("agent frontmatter must be a YAML mapping");
  }
  if (Object.keys(parsed.frontmatter).length === 0) {
    throw new Error("agent frontmatter must contain at least one field");
  }
  if (!parsed.body.trim()) {
    throw new Error("agent definition must contain a system prompt body");
  }
}

/** Find an agent file in loader precedence order. */
export function findAgentFile(
  name: string,
  cwd: string = process.cwd(),
  /** When provided, use the source path of the config that actually loaded. */
  sourcePath?: string,
): { path: string; location: AgentFileLocation } | undefined {
  if (sourcePath !== undefined) {
    if (!existsSync(sourcePath)) return undefined;
    const candidates = [
      { path: join(projectAgentsDir(cwd), `${name}.md`), location: "project" as const },
      { path: join(workspaceAgentsDir(cwd), `${name}.md`), location: "workspace" as const },
      { path: join(personalAgentsDir(), `${name}.md`), location: "personal" as const },
    ];
    const candidate = candidates.find((entry) => samePath(entry.path, sourcePath));
    return { path: sourcePath, location: candidate?.location ?? "personal" };
  }

  const projectPath = join(projectAgentsDir(cwd), `${name}.md`);
  if (existsSync(projectPath)) return { path: projectPath, location: "project" };
  const workspacePath = join(workspaceAgentsDir(cwd), `${name}.md`);
  if (existsSync(workspacePath)) return { path: workspacePath, location: "workspace" };
  const personalPath = join(personalAgentsDir(), `${name}.md`);
  if (existsSync(personalPath)) return { path: personalPath, location: "personal" };
  return undefined;
}

export type DisableOutcome = "disabled" | "already-disabled" | "no-frontmatter" | "invalid";

/** A frontmatter line that sets `enabled: false`, including YAML spellings/comments. */
const ENABLED_FALSE = /^(?:enabled|"enabled"|'enabled')[ \t]*:[ \t]*false(?:[ \t]+#.*)?[ \t]*$/i;
const ENABLED_KEY = /^((?:enabled|"enabled"|'enabled')[ \t]*:[ \t]*)(.*)$/;
const FENCE = /^---[ \t]*$/;

/** Split a file into the frontmatter block while preserving line terminators. */
function splitFrontmatter(content: string):
  | { lines: string[]; closeIdx: number; eol: string }
  | undefined {
  const lines = content.split(/(?<=\n)/);
  if (lines.length === 0 || !FENCE.test(lines[0].replace(/\r?\n$/, ""))) return undefined;
  const closeIdx = lines.findIndex((line, index) => index > 0 && FENCE.test(line.replace(/\r?\n$/, "")));
  if (closeIdx === -1) return undefined;
  return { lines, closeIdx, eol: lines[0].endsWith("\r\n") ? "\r\n" : "\n" };
}

/** Ask the loader's parser whether the file is disabled. */
export function isDisabledContent(content: string): boolean {
  try {
    return parseFrontmatter<Record<string, unknown>>(content).frontmatter.enabled === false;
  } catch {
    return false;
  }
}

/** Validate a generated edit through the same parser used by custom-agent loading. */
function validateModifiedContent(content: string, expected: "disabled" | "enabled"): string | undefined {
  try {
    const parsed = parseFrontmatter<Record<string, unknown>>(content).frontmatter;
    if (expected === "disabled" && parsed.enabled !== false) {
      return 'the parser did not read enabled: false from the modified frontmatter';
    }
    if (expected === "enabled" && parsed.enabled === false) {
      return 'the parser still reads enabled: false from the modified frontmatter';
    }
    return undefined;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return reason;
  }
}

/** Add `enabled: false` without duplicating an existing YAML key. */
export function disableInContent(content: string): { content: string; outcome: DisableOutcome; error?: string } {
  const block = splitFrontmatter(content);
  if (!block) return { content, outcome: "no-frontmatter" };
  if (isDisabledContent(content)) return { content, outcome: "already-disabled" };

  const lines = [...block.lines];
  const existingIndex = lines.findIndex(
    (line, index) => index > 0 && index < block.closeIdx && ENABLED_KEY.test(line.replace(/\r?\n$/, "")),
  );
  if (existingIndex >= 0) {
    const raw = lines[existingIndex].replace(/\r?\n$/, "");
    const match = raw.match(ENABLED_KEY);
    if (!match) return { content, outcome: "invalid", error: "could not identify the enabled frontmatter key" };
    const suffix = match[2];
    const comment = suffix.match(/[ \t]+#.*$/)?.[0] ?? suffix.match(/[ \t]*$/)?.[0] ?? "";
    lines[existingIndex] = `${match[1]}false${comment}${block.eol}`;
  } else {
    lines.splice(1, 0, `enabled: false${block.eol}`);
  }
  const updated = lines.join("");
  const error = validateModifiedContent(updated, "disabled");
  return error
    ? { content, outcome: "invalid", error }
    : { content: updated, outcome: "disabled" };
}

/** Remove a parser-recognized `enabled: false` key from the frontmatter block. */
export function enableInContent(content: string): { content: string; changed: boolean; error?: string } {
  const block = splitFrontmatter(content);
  if (!block) return { content, changed: false };
  const kept = block.lines.filter(
    (line, index) => !(index > 0 && index < block.closeIdx && ENABLED_FALSE.test(line.replace(/\r?\n$/, ""))),
  );
  if (kept.length === block.lines.length) return { content, changed: false };
  const updated = kept.join("");
  const error = validateModifiedContent(updated, "enabled");
  return error
    ? { content, changed: false, error }
    : { content: updated, changed: true };
}

/** Is this the empty stub used to disable an embedded default agent? */
export function isEmptyStub(content: string): boolean {
  return content.replace(/\r\n/g, "\n").trim() === "---\n---";
}

/** Keep ordinary CSV-like values readable while quoting YAML-sensitive free text. */
function formatYamlScalar(value: string): string {
  if (
    value.length > 0 &&
    value === value.trim() &&
    /^[A-Za-z0-9_.,+*/:@ -]+$/.test(value) &&
    !/^[?\-:!&*#{}[\],|>@`]/.test(value) &&
    !value.includes("#") &&
    !/:\s|:$/.test(value)
  ) {
    return value;
  }
  return JSON.stringify(value);
}

/** Inputs collected by the manual agent wizard. */
export interface NewAgentInput {
  description: string;
  tools: string;
  /** @deprecated Retired and ignored; use tier instead. */
  model?: string;
  /** @deprecated Retired and ignored; use tier instead. */
  thinking?: string;
  tier?: string;
  systemPrompt: string;
}

/** Serialize the manual wizard's free-text fields safely as YAML scalars. */
export function buildNewAgentFile(input: NewAgentInput): string {
  for (const key of ["model", "thinking"] as const) {
    if (key in input) {
      console.warn(`[pi-subagents] manual agent input "${key}" is retired and ignored; use "tier" instead.`);
    }
  }
  const tierLine = input.tier ? `\ntier: ${formatYamlScalar(input.tier)}` : "";
  return `---
description: ${JSON.stringify(input.description)}
tools: ${formatYamlScalar(input.tools)}${tierLine}
prompt_mode: replace
---

${input.systemPrompt}
`;
}

/** Preserve absent-vs-empty built-in scope and extension-only selectors. */
function formatToolsField(cfg: AgentConfig): string {
  const builtins = cfg.builtinToolNames;
  const extensionSelectors = cfg.extSelectors ?? [];
  if (builtins === undefined) return ["all", ...extensionSelectors].join(", ");
  if (builtins.length === 0) return extensionSelectors.length > 0 ? extensionSelectors.join(", ") : "none";
  return [...builtins, ...extensionSelectors].join(", ");
}

/** Serialize an AgentConfig to a complete .md file for eject. */
export function serializeAgentFile(cfg: AgentConfig): string {
  const fmFields: string[] = [];
  fmFields.push(`description: ${JSON.stringify(cfg.description)}`);
  if (cfg.displayName) fmFields.push(`display_name: ${JSON.stringify(cfg.displayName)}`);
  if (cfg.color) fmFields.push(`color: ${formatYamlScalar(cfg.color)}`);
  fmFields.push(`tools: ${formatYamlScalar(formatToolsField(cfg))}`);
  // Never model:/thinking: — the loader ignores them, so writing them back
  // would recreate a pin that looks effective and is not.
  if (cfg.agentTier) fmFields.push(`tier: ${formatYamlScalar(cfg.agentTier)}`);
  if (cfg.maxTurns) fmFields.push(`max_turns: ${cfg.maxTurns}`);
  // Written when explicitly set, INCLUDING an explicit 0: for the budgets, 0
  // means "unlimited" and is a real opt-out of a project default, so dropping
  // it on eject would silently re-impose that default on the ejected copy.
  if (cfg.maxTokens !== undefined) fmFields.push(`max_tokens: ${cfg.maxTokens}`);
  if (cfg.maxToolCalls !== undefined) fmFields.push(`max_tool_calls: ${cfg.maxToolCalls}`);
  if (cfg.persistSession) fmFields.push("persist_session: true");
  if (cfg.sessionDir) fmFields.push(`session_dir: ${JSON.stringify(cfg.sessionDir)}`);
  if (cfg.allowedSubagents !== undefined) {
    fmFields.push(`allowed_subagents: ${formatYamlScalar(cfg.allowedSubagents === "all" ? "all" : cfg.allowedSubagents.join(", "))}`);
  }
  fmFields.push(`prompt_mode: ${cfg.promptMode}`);
  if (cfg.extensions === false) fmFields.push("extensions: false");
  else if (Array.isArray(cfg.extensions)) fmFields.push(`extensions: ${formatYamlScalar(cfg.extensions.join(", "))}`);
  if (cfg.excludeExtensions?.length) fmFields.push(`exclude_extensions: ${formatYamlScalar(cfg.excludeExtensions.join(", "))}`);
  if (cfg.skills === false) fmFields.push("skills: false");
  else if (Array.isArray(cfg.skills)) fmFields.push(`skills: ${formatYamlScalar(cfg.skills.join(", "))}`);
  if (cfg.disallowedTools?.length) fmFields.push(`disallowed_tools: ${formatYamlScalar(cfg.disallowedTools.join(", "))}`);
  if (cfg.askTools?.length) fmFields.push(`ask_tools: ${formatYamlScalar(cfg.askTools.join(", "))}`);
  if (cfg.gate) fmFields.push(`gate: ${formatYamlScalar(cfg.gate)}`);
  if (cfg.inheritContext) fmFields.push("inherit_context: true");
  if (cfg.runInBackground) fmFields.push("run_in_background: true");
  if (cfg.outputTranscript === false) fmFields.push("output_transcript: false");
  if (cfg.isolated) fmFields.push("isolated: true");
  if (cfg.memory) fmFields.push(`memory: ${cfg.memory}`);
  if (cfg.isolation) fmFields.push(`isolation: ${cfg.isolation}`);

  return `---\n${fmFields.join("\n")}\n---\n\n${cfg.systemPrompt}\n`;
}

