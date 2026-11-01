import {
  chmodSync,
  closeSync,
  fstatSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as piHost from "@earendil-works/pi-coding-agent";
import { acquireClient } from "./client-leases.js";
import { collectSupportedFiles, resolveRoot, resolveSupportedFile } from "./files.js";
import type { LspClient } from "./lsp-client.js";
import { beginStatus } from "./status.js";
import { applyTextEdits, collectWorkspaceEdits, hasOverlappingTextEdits } from "./text-edits.js";
import type { CodeAction, DiagnosticEntry, LspServerAdapter, LspTextEdit, StatusContext } from "./types.js";

export const DEFAULT_FILE_LIMIT = 50;

export async function runDiagnostics(
  adapter: LspServerAdapter,
  params: { root?: string; paths?: string[]; limit?: number; files?: string[] },
  timeoutMs: number,
  signal: AbortSignal | undefined,
  ctx: StatusContext,
  statusKey: string,
  boundOutput = true,
) {
  throwIfAborted(signal, adapter);
  const root = resolveRoot(params.root);
  const command = adapter.defaultCommand;
  const files = params.files ?? collectSupportedFiles(adapter, root, params.paths, params.limit ?? DEFAULT_FILE_LIMIT);
  if (files.length === 0) {
    return textResult(`${adapter.name} LSP found no supported files to check.`, {
      root,
      command,
      files: [],
      summary: { files: 0, diagnostics: 0 },
    });
  }

  return withLspClient(
    adapter,
    root,
    timeoutMs,
    signal,
    ctx,
    statusKey,
    `${adapter.name} diagnostics`,
    async (client) => {
      const openedFiles: Array<{ file: string; uri: string }> = [];
      try {
        for (const file of files) {
          throwIfAborted(signal, adapter);
          const uri = pathToFileURL(file).href;
          const text = readFileSync(file, "utf8");
          client.didOpen(uri, text, adapter.languageIdFor(file));
          openedFiles.push({ file, uri });
        }

        const entries: DiagnosticEntry[] = await Promise.all(
          openedFiles.map(async ({ file, uri }) => ({
            path: path.relative(root, file) || file,
            uri,
            diagnostics: await client.diagnostics(uri),
          })),
        );
        throwIfAborted(signal, adapter);
        return textResult(
          formatDiagnostics(adapter, entries),
          { root, command, files: entries, summary: summarize(entries) },
          boundOutput,
        );
      } finally {
        for (const { uri } of openedFiles) client.didClose(uri);
      }
    },
  );
}

/**
 * Own one per-call server: lease admission, cancellation, status, start and
 * initialize, then confirmed cleanup. A cleanup error never replaces an
 * operation error.
 */
export async function withLspClient<T>(
  adapter: LspServerAdapter,
  root: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  ctx: StatusContext,
  statusKey: string,
  label: string,
  operation: (client: LspClient) => Promise<T>,
): Promise<T> {
  throwIfAborted(signal, adapter);
  const { client, releaseWhenClosed } = await acquireClient(adapter, root, timeoutMs);
  const abort = () => client.close();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();

  let finishStatus: (() => void) | undefined;
  let operationFailed = false;
  try {
    throwIfAborted(signal, adapter);
    finishStatus = beginStatus(ctx, statusKey, label);
    throwIfAborted(signal, adapter);
    await client.start();
    throwIfAborted(signal, adapter);
    await client.initialize(root);
    throwIfAborted(signal, adapter);
    return await operation(client);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      await shutdownClient(client, operationFailed);
    } finally {
      signal?.removeEventListener("abort", abort);
      releaseWhenClosed();
      finishStatus?.();
    }
    if (!operationFailed) throwIfAborted(signal, adapter);
  }
}

export async function runFix(
  adapter: LspServerAdapter,
  params: { root?: string; path: string; kind?: string; write?: boolean },
  timeoutMs: number,
  signal: AbortSignal | undefined,
  ctx: StatusContext,
  statusKey: string,
) {
  throwIfAborted(signal, adapter);
  const root = resolveRoot(params.root);
  const file = resolveSupportedFile(adapter, root, params.path);
  const workspace = captureWorkspace(root);
  const queue = fileMutationQueue();
  const run = () =>
    runFixWindow(adapter, { ...params, root, path: file }, timeoutMs, signal, ctx, statusKey, workspace);
  return params.write && queue ? queue(file, run) : run();
}

async function runFixWindow(
  adapter: LspServerAdapter,
  params: { root: string; path: string; kind?: string; write?: boolean },
  timeoutMs: number,
  signal: AbortSignal | undefined,
  ctx: StatusContext,
  statusKey: string,
  workspace: FixWorkspace,
) {
  const root = params.root;
  const file = params.path;
  const actionKind = params.kind?.trim() || "source.fixAll";

  throwIfAborted(signal, adapter);
  assertFixWorkspace(adapter, root, workspace, file);
  return withLspClient(adapter, root, timeoutMs, signal, ctx, statusKey, `${adapter.name} fix`, async (client) => {
    const uri = pathToFileURL(file).href;
    assertFixWorkspace(adapter, root, workspace, file);
    const fd = openSync(file, "r");
    let original: FixSnapshot;
    try {
      original = readFixSnapshot(fd, file);
    } finally {
      closeSync(fd);
    }
    assertFixWorkspace(adapter, root, workspace, file);
    if (!sameFile(original, statSync(file))) throw staleFixError(file);
    const text = original.bytes.toString("utf8");
    client.didOpen(uri, text, adapter.languageIdFor(file));
    let resolvedActions: CodeAction[];
    let selectedActions: CodeAction[];
    let edits: LspTextEdit[];
    let newText: string;
    try {
      const diagnostics = await client.diagnostics(uri);
      throwIfAborted(signal, adapter);
      const actions = await client.codeActions(uri, text, diagnostics, actionKind);
      throwIfAborted(signal, adapter);
      resolvedActions = await client.resolveActions(actions);
      throwIfAborted(signal, adapter);
      selectedActions = selectCodeActions(resolvedActions, actionKind);
      edits = selectedActions.flatMap((action) => collectWorkspaceEdits(action.edit, uri));
      if (hasOverlappingTextEdits(text, edits)) {
        const relativePath = path.relative(root, file) || file;
        throw new Error(
          `${adapter.name} LSP returned overlapping code-action edits for ${relativePath}; ` +
            "use a narrower action kind.",
        );
      }
      newText = applyTextEdits(text, edits);
    } finally {
      client.didClose(uri);
    }
    const changed = newText !== text;

    throwIfAborted(signal, adapter);
    if (params.write && changed) writeFreshFix(adapter, root, workspace, file, original, newText);

    return textResult(formatEditSummary(adapter, "fix", root, file, changed, params.write, newText), {
      path: path.relative(root, file) || file,
      uri,
      changed,
      write: params.write ?? false,
      outcome: changed ? (params.write ? "updated" : "preview") : "unchanged",
      kind: actionKind,
      actions: resolvedActions.map(({ title, kind }) => ({ title, kind })),
      appliedActions: selectedActions.map(({ title, kind }) => ({ title, kind })),
      edits,
      text: !params.write && changed ? newText : undefined,
    });
  });
}

export type FileMutationQueue = <T>(file: string, run: () => Promise<T>) => Promise<T>;

/** Pi's native per-file mutation queue, shared with the built-in edit and write tools. */
export function fileMutationQueue(): FileMutationQueue | undefined {
  // Namespace lookup keeps loading compatible with hosts predating the public queue.
  return (piHost as { withFileMutationQueue?: FileMutationQueue }).withFileMutationQueue;
}

export interface FixWorkspace {
  root: string;
  dev: number;
  ino: number;
}

export interface FixSnapshot {
  dev: number;
  ino: number;
  bytes: Buffer;
}

export function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function staleFixError(file: string, action: "fix" | "rename" = "fix") {
  const computed = action === "fix" ? "fixes" : "rename edits";
  return new Error(`File changed while computing LSP ${computed}; left unchanged: ${file}. Retry the ${action}.`);
}

export function captureWorkspace(root: string): FixWorkspace {
  const rootStat = statSync(root);
  return { root: realpathSync(root), dev: rootStat.dev, ino: rootStat.ino };
}

export function readFixSnapshot(fd: number, file: string, action: "fix" | "rename" = "fix"): FixSnapshot {
  const before = fstatSync(fd);
  if (!before.isFile()) throw staleFixError(file, action);
  const bytes = readFileSync(fd);
  const after = fstatSync(fd);
  if (
    !after.isFile() ||
    !sameFile(before, after) ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    bytes.length !== after.size
  )
    throw staleFixError(file, action);
  return { dev: after.dev, ino: after.ino, bytes };
}

export function assertFixWorkspace(
  adapter: LspServerAdapter,
  root: string,
  workspace: FixWorkspace,
  file: string,
  action: "fix" | "rename" = "fix",
) {
  if (realpathSync(root) !== workspace.root || !sameFile(workspace, statSync(root))) throw staleFixError(file, action);
  // Containment is relative to the captured boundary, never a retargeted root.
  return resolveSupportedFile(adapter, workspace.root, file);
}

/** Read-only form of the final write check, so a multi-file write can verify every file first. */
export function assertFreshFile(
  adapter: LspServerAdapter,
  root: string,
  workspace: FixWorkspace,
  file: string,
  original: FixSnapshot,
  action: "fix" | "rename" = "fix",
) {
  assertFixWorkspace(adapter, root, workspace, file, action);
  const fd = openSync(file, "r");
  try {
    const current = readFixSnapshot(fd, file, action);
    assertFixWorkspace(adapter, root, workspace, file, action);
    if (!sameFile(original, current) || !sameFile(current, statSync(file)) || !original.bytes.equals(current.bytes))
      throw staleFixError(file, action);
  } finally {
    closeSync(fd);
  }
}

export function writeFreshFix(
  adapter: LspServerAdapter,
  root: string,
  workspace: FixWorkspace,
  file: string,
  original: FixSnapshot,
  text: string,
  action: "fix" | "rename" = "fix",
) {
  assertFixWorkspace(adapter, root, workspace, file, action);
  // Open without truncation, then validate both the descriptor and its live
  // workspace path. Write through this descriptor, not a newly followed link.
  const fd = openSync(file, "r+");
  try {
    const current = readFixSnapshot(fd, file, action);
    assertFixWorkspace(adapter, root, workspace, file, action);
    if (!sameFile(original, current) || !sameFile(current, statSync(file)) || !original.bytes.equals(current.bytes))
      throw staleFixError(file, action);
    const bytes = Buffer.from(text, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    }
    ftruncateSync(fd, bytes.length);
  } finally {
    closeSync(fd);
  }
}

async function shutdownClient(client: LspClient, operationFailed: boolean) {
  try {
    await client.shutdown();
  } catch (error) {
    // Cleanup failure must not replace the original protocol/request error.
    if (!operationFailed) throw error;
  }
}

function selectCodeActions(actions: CodeAction[], requestedKind: string) {
  return actions.filter((action) => action.kind === requestedKind || action.kind?.startsWith(`${requestedKind}.`));
}

function formatDiagnostics(adapter: LspServerAdapter, entries: DiagnosticEntry[]) {
  const lines = entries.flatMap((entry) => {
    if (entry.diagnostics.length === 0) return [`${entry.path}: no diagnostics`];

    return entry.diagnostics.map((diagnostic) => {
      const line = diagnostic.range.start.line + 1;
      const column = diagnostic.range.start.character + 1;
      const severity = severityName(diagnostic.severity);
      const source = diagnostic.source ?? adapter.name;
      const code = diagnostic.code === undefined ? "" : ` ${diagnostic.code}`;
      return `${entry.path}:${line}:${column}: ${severity} ${source}${code}: ${diagnostic.message}`;
    });
  });

  const summary = summarize(entries);
  return [
    `${adapter.name} LSP diagnostics: ${summary.diagnostics} diagnostic(s) across ${summary.files} file(s).`,
    "",
    ...lines,
  ].join("\n");
}

function formatEditSummary(
  adapter: LspServerAdapter,
  action: "fix",
  root: string,
  file: string,
  changed: boolean,
  write: boolean | undefined,
  text: string,
) {
  const relativePath = path.relative(root, file) || file;
  const status = changed ? (write ? "updated" : "computed changes for") : "left unchanged";
  const summary = `${adapter.name} LSP ${action} ${status} ${relativePath}.`;
  if (write || !changed) return summary;
  return `${summary}\n\n${text}`;
}

function summarize(entries: DiagnosticEntry[]) {
  return {
    files: entries.length,
    diagnostics: entries.reduce((total, entry) => total + entry.diagnostics.length, 0),
  };
}

function severityName(severity: number | undefined) {
  if (severity === 1) return "error";
  if (severity === 2) return "warning";
  if (severity === 3) return "info";
  if (severity === 4) return "hint";
  return "diagnostic";
}

export function throwIfAborted(signal: AbortSignal | undefined, adapter: LspServerAdapter) {
  if (signal?.aborted) throw new Error(`${adapter.name} LSP request aborted.`);
}

export function textResult(text: string, details: unknown, boundOutput = true) {
  // Unbounded sections are internal only; the complete diagnostics aggregate is bounded once.
  if (!boundOutput) return { content: [{ type: "text" as const, text }], details };
  const truncation = piHost.truncateHead(text);
  const serializedDetails = JSON.stringify(details);
  const oversizedDetails =
    serializedDetails !== undefined && Buffer.byteLength(serializedDetails) > piHost.DEFAULT_MAX_BYTES;
  if (!truncation.truncated && !oversizedDetails) {
    return { content: [{ type: "text" as const, text }], details };
  }

  const directory = mkdtempSync(path.join(tmpdir(), "pi-lsp-output-"));
  const outputPath = path.join(directory, "output.txt");
  const detailsPath = oversizedDetails ? path.join(directory, "details.json") : undefined;
  try {
    chmodSync(directory, 0o700);
    writeFileSync(outputPath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (detailsPath && serializedDetails !== undefined) {
      writeFileSync(detailsPath, serializedDetails, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const notice = [
    truncation.truncated
      ? `[Output truncated at the ${piHost.DEFAULT_MAX_LINES}-line / 50 KiB limit. Full output: ${outputPath}]`
      : `[Full output: ${outputPath}]`,
    ...(detailsPath ? [`[Details exceeded the 50 KiB limit. Full details: ${detailsPath}]`] : []),
  ].join("\n");
  // Budget both notices too, including when one huge line cannot fit in the preview.
  const preview = piHost.truncateHead(text, {
    maxBytes: piHost.DEFAULT_MAX_BYTES - Buffer.byteLength(notice) - 2,
    maxLines: piHost.DEFAULT_MAX_LINES - notice.split("\n").length - 2,
  });
  return {
    content: [{ type: "text" as const, text: `${preview.content}\n\n${notice}` }],
    // Session persistence gets only compact metadata, never the bulky text/edits/messages.
    details: { ...compactDetails(details), outputPath, detailsPath, truncation: { ...preview, content: undefined } },
  };
}

function compactDetails(details: unknown): Record<string, unknown> {
  if (!details || typeof details !== "object") return {};
  const source = details as Record<string, unknown>;
  const compact: Record<string, unknown> = {};
  for (const key of ["outcome", "path", "uri", "changed", "write", "kind", "root"]) {
    const value = source[key];
    if (typeof value === "string") {
      compact[key] = piHost.truncateHead(value, { maxBytes: 1024, maxLines: 4 }).content;
    } else if (typeof value === "boolean" || typeof value === "number") {
      compact[key] = value;
    }
  }
  return compact;
}
