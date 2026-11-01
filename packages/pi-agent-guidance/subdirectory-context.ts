/**
 * Subdirectory context: Pi loads context files only from the working directory
 * and its ancestors. When the agent reads, edits or writes a file below the
 * working directory, deliver the context files of the directories in between
 * once, appended to that tool result.
 *
 * Delivery state is derived from the current branch's compaction-aware context
 * entries, never process memory, so compaction, tree navigation and resume
 * redeliver exactly what the model can no longer see.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  type Config,
  type ContextFile,
  coreContextFile,
  getCandidateFiles,
  getDirectories,
  isRecord,
  legacyContextFiles,
  readContextFile,
  resolvedPath,
  shouldLoad,
} from "./selection.js";

export const SUBDIRECTORY_ENTRY = "pi-agent-guidance:subdirectory-context";
export const MAX_FILE_BYTES = 16 * 1024;
export const MAX_TURN_BYTES = 32 * 1024;

const TOOLS = new Set(["read", "edit", "write"]);

type Content = NonNullable<ToolResultEventResult["content"]>;

interface DeliveredFile {
  path: string;
  sha256: string;
}

interface DeliveryRecord {
  version: 1;
  toolCallId: string;
  files: DeliveredFile[];
}

function isDeliveryRecord(value: unknown): value is DeliveryRecord {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.toolCallId === "string" &&
    Array.isArray(value.files) &&
    value.files.every((file) => isRecord(file) && typeof file.path === "string" && typeof file.sha256 === "string")
  );
}

function deliveryKey(file: DeliveredFile): string {
  return `${file.sha256}\0${file.path}`;
}

/**
 * Context files whose recorded content the model still sees. Pass the branch's
 * compaction-aware context entries: a record summarized away or on another
 * branch is absent, and a context edit of the carrying tool result voids it.
 */
export function deliveredFiles(entries: readonly SessionEntry[]): Set<string> {
  const edited = new Set<string>();
  const results = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type === "context_edit") edited.add(entry.targetId);
    else if (entry.type === "message" && entry.message.role === "toolResult") {
      results.set(entry.message.toolCallId, entry.id);
    }
  }
  const latest = new Map<string, DeliveredFile>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== SUBDIRECTORY_ENTRY || !isDeliveryRecord(entry.data)) continue;
    const result = results.get(entry.data.toolCallId);
    if (result !== undefined && edited.has(result)) continue;
    for (const file of entry.data.files) latest.set(file.path, file);
  }
  return new Set([...latest.values()].map(deliveryKey));
}

/** Resolve a tool path the way Pi's file tools do for the common forms. */
function toolPath(input: string, cwd: string): string {
  const stripped = input.startsWith("@") ? input.slice(1) : input;
  const expanded =
    stripped === "~" ? homedir() : stripped.startsWith("~/") ? path.join(homedir(), stripped.slice(2)) : stripped;
  return path.resolve(cwd, expanded);
}

/**
 * Directories strictly below `cwd` that contain `target`, outermost first, named
 * under `cwd`. Containment is checked on real paths, so a symlink cannot reach out.
 */
export function directoriesBetween(cwd: string, target: string): string[] {
  const relative = path.relative(resolvedPath(cwd), resolvedPath(path.dirname(target)));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return [];
  }
  const segments = relative.split(path.sep);
  // A dependency's own guidance is not this project's guidance.
  const dependency = segments.indexOf("node_modules");
  const kept = dependency === -1 ? segments : segments.slice(0, dependency);
  return kept.map((_, index) => path.join(cwd, ...kept.slice(0, index + 1)));
}

/** Candidate containment must be established before stat/read follows a symlink. */
function readCandidate(filePath: string, cwd: string): ContextFile | undefined {
  try {
    const realCwd = realpathSync(cwd);
    const realFile = realpathSync(filePath);
    const relative = path.relative(realCwd, realFile);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).includes("node_modules")
    ) {
      return undefined;
    }
    // Read the validated real path, retaining the candidate name for delivery and
    // resolved-path/content deduplication (including valid in-tree symlinks).
    const file = readContextFile(realFile);
    return file ? { ...file, path: filePath } : undefined;
  } catch {
    return undefined;
  }
}

/** Pi omits details on ordinary complete reads; malformed truncation is not proof of completeness. */
function readIsComplete(details: unknown): boolean {
  if (details === undefined) return true;
  if (!isRecord(details)) return false;
  const truncation = details.truncation;
  return truncation === undefined || (isRecord(truncation) && truncation.truncated === false);
}

function render(file: ContextFile): string {
  const bytes = Buffer.from(file.content, "utf8");
  let content = file.content;
  let notice = "";
  if (bytes.length > MAX_FILE_BYTES) {
    content = bytes
      .subarray(0, MAX_FILE_BYTES)
      .toString("utf8")
      .replace(/\uFFFD$/u, "");
    notice = `\n\n[Truncated to ${MAX_FILE_BYTES} of ${bytes.length} bytes; read ${file.path} for the rest.]`;
  }
  return `Context file ${file.path} applies to files below ${path.dirname(file.path)}:\n\n${content}${notice}`;
}

export interface SubdirectoryContext {
  /** Record the context files the current run's system prompt already carries. */
  observe(loaded: readonly ContextFile[]): void;
  startTurn(): void;
  onToolResult(event: ToolResultEvent, ctx: ExtensionContext): ToolResultEventResult | undefined;
}

export function createSubdirectoryContext(pi: ExtensionAPI, config: Config, agentDir: string): SubdirectoryContext {
  let loaded: readonly ContextFile[] | undefined;
  let turnBytes = 0;

  function candidates(directories: readonly string[], ctx: ExtensionContext): ContextFile[] {
    const provider = ctx.model?.provider;
    const names = provider ? getCandidateFiles(ctx.model?.id, provider, config) : [];
    const known = loaded ?? legacyContextFiles(getDirectories(ctx.cwd, agentDir));
    const files: ContextFile[] = [];
    const read = (filePath: string) => readCandidate(filePath, ctx.cwd);
    for (const dir of directories) {
      for (const file of [coreContextFile(dir, read), ...names.map((name) => read(path.join(dir, name)))]) {
        if (file && shouldLoad(file, [...known, ...files])) files.push(file);
      }
    }
    return files;
  }

  return {
    observe(files) {
      loaded = files;
    },
    startTurn() {
      turnBytes = 0;
    },
    onToolResult(event, ctx) {
      if (config.subdirectoryContext === false || event.isError || event.parentToolCallId !== undefined) return;
      const input = event.input.path;
      if (!TOOLS.has(event.toolName) || typeof input !== "string" || input === "") return;
      // Nested files in an untrusted checkout are a prompt-injection vector.
      if (!ctx.isProjectTrusted()) return;
      const target = resolvedPath(toolPath(input, ctx.cwd));
      const directories = directoriesBetween(ctx.cwd, target);
      if (directories.length === 0) return;

      const delivered = deliveredFiles(ctx.sessionManager.buildContextEntries());
      // A full read or a write already shows the model the operated-on file.
      const showsTarget =
        event.toolName === "write" ||
        (event.toolName === "read" &&
          event.input.offset === undefined &&
          event.input.limit === undefined &&
          readIsComplete(event.details));
      const record: DeliveredFile[] = [];
      const blocks: Content = [];
      const deferred: string[] = [];
      for (const file of candidates(directories, ctx)) {
        const delivery = { path: file.path, sha256: createHash("sha256").update(file.content).digest("hex") };
        if (delivered.has(deliveryKey(delivery))) continue;
        if (resolvedPath(file.path) === target) {
          if (showsTarget) record.push(delivery);
          continue;
        }
        const text = render(file);
        const bytes = Buffer.byteLength(text, "utf8");
        // Stop at the first file over budget so later turns keep outer-to-inner order.
        if (deferred.length > 0 || turnBytes + bytes > MAX_TURN_BYTES) {
          deferred.push(file.path);
          continue;
        }
        turnBytes += bytes;
        blocks.push({ type: "text", text });
        record.push(delivery);
      }
      if (deferred.length > 0) {
        blocks.push({
          type: "text",
          text: `Context files deferred by the per-turn size limit; they load with the next read, edit or write below them, or read them directly: ${deferred.join(", ")}`,
        });
      }
      if (record.length > 0) {
        pi.appendEntry<DeliveryRecord>(SUBDIRECTORY_ENTRY, { version: 1, toolCallId: event.toolCallId, files: record });
      }
      if (blocks.length === 0) return;
      return {
        content: [...event.content, ...blocks],
        ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
      };
    },
  };
}
