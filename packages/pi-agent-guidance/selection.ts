/**
 * Context-file selection shared by provider guidance and subdirectory context:
 * configuration, model-family candidates, core precedence and deduplication.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const PROVIDER_FILES: Record<string, string[]> = {
  anthropic: ["CLAUDE.md"],
  openai: ["CODEX.md"],
  "openai-codex": ["CODEX.md"],
  "github-copilot": ["CODEX.md"],
  google: ["GEMINI.md"],
  "google-gemini-cli": ["GEMINI.md"],
  "google-antigravity": ["GEMINI.md"],
  "google-vertex": ["GEMINI.md"],
};

/** Pi Core's per-directory precedence: the first readable regular file wins. */
const CORE_CONTEXT_FILES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

export interface Config {
  providers?: Record<string, string[]>;
  models?: Record<string, string[]>;
  subdirectoryContext?: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileMapping(value: unknown): value is Record<string, string[]> {
  return (
    isRecord(value) &&
    Object.values(value).every((files) => Array.isArray(files) && files.every((file) => typeof file === "string"))
  );
}

export function loadConfig(agentDir: string): Config {
  const configPath = path.join(agentDir, "agent-guidance.json");
  try {
    const config: unknown = JSON.parse(fs.readFileSync(configPath, "utf-8").replace(/^\uFEFF/u, ""));
    if (!isRecord(config)) throw new Error("expected an object");
    for (const key of ["providers", "models"]) {
      if (key in config && !isFileMapping(config[key])) throw new Error(`${key} must map names to string arrays`);
    }
    if ("subdirectoryContext" in config && typeof config.subdirectoryContext !== "boolean") {
      throw new Error("subdirectoryContext must be a boolean");
    }
    return {
      providers: isFileMapping(config.providers) ? config.providers : undefined,
      models: isFileMapping(config.models) ? config.models : undefined,
      subdirectoryContext: typeof config.subdirectoryContext === "boolean" ? config.subdirectoryContext : undefined,
    };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return {};
    // Configuration is loaded once per extension instance, so invalid bytes
    // produce one diagnostic, not one warning per model request.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`agent-guidance: invalid ${configPath}: ${message}; using defaults`);
    return {};
  }
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i").test(value);
}

export function getCandidateFiles(modelId: string | undefined, provider: string, config: Config): string[] {
  // Model-specific patterns take priority
  if (modelId && config.models) {
    for (const [pattern, files] of Object.entries(config.models)) {
      if (globMatch(pattern, modelId)) return files;
    }
  }
  // Then provider config, then defaults
  if (config.providers && Object.hasOwn(config.providers, provider)) return config.providers[provider];
  return Object.hasOwn(PROVIDER_FILES, provider) ? PROVIDER_FILES[provider] : [];
}

export interface ContextFile {
  path: string;
  content: string;
}

export function readContextFile(filePath: string): ContextFile | undefined {
  try {
    if (!fs.statSync(filePath).isFile()) return undefined;
    return { path: filePath, content: fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/u, "") };
  } catch {
    return undefined;
  }
}

export function resolvedPath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/** The file Pi Core selects for one directory, including its unreadable/non-file skips. */
export function coreContextFile(dir: string): ContextFile | undefined {
  for (const name of CORE_CONTEXT_FILES) {
    const file = readContextFile(path.join(dir, name));
    if (file) return file;
  }
  return undefined;
}

// Older hosts do not expose systemPromptOptions. Match core selection, including
// unreadable/non-file candidates, rather than inferring selection from existence.
export function legacyContextFiles(directories: string[]): ContextFile[] {
  return directories.flatMap((dir) => {
    const file = coreContextFile(dir);
    return file ? [file] : [];
  });
}

export function shouldLoad(file: ContextFile, contextFiles: readonly ContextFile[]): boolean {
  const candidatePath = resolvedPath(file.path);
  return !contextFiles.some((loaded) => resolvedPath(loaded.path) === candidatePath || loaded.content === file.content);
}

export function getDirectories(cwd: string, agentDir: string): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();

  // Global agent dir first
  if (fs.existsSync(agentDir)) {
    dirs.push(agentDir);
    seen.add(agentDir);
  }

  // Walk up from cwd to root
  let current = cwd;
  const ancestors: string[] = [];
  while (true) {
    if (!seen.has(current)) {
      ancestors.unshift(current);
      seen.add(current);
    }
    const parent = path.resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }

  dirs.push(...ancestors);
  return dirs;
}
