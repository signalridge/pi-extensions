import { closeSync, openSync, realpathSync, type Stats, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectSupportedFiles, displayPath, resolveSupportedFile } from "./files.js";
import { displayUri } from "./lsp-results.js";
import { runOnCapableServer } from "./navigation.js";
import { displayPosition, type PositionInput, resolvePosition } from "./positions.js";
import type { OperationRoute } from "./routes.js";
import {
  assertFixWorkspace,
  assertFreshFile,
  captureWorkspace,
  type FileMutationQueue,
  type FixSnapshot,
  type FixWorkspace,
  fileMutationQueue,
  readFixSnapshot,
  sameFile,
  staleFixError,
  textResult,
  throwIfAborted,
  writeFreshFix,
} from "./runner.js";
import {
  applyTextEdits,
  findInvalidTextEditRange,
  flattenWorkspaceEdit,
  hasOverlappingTextEdits,
  offsetAt,
} from "./text-edits.js";
import type { LspServerAdapter, LspTextEdit, StatusContext } from "./types.js";

const PREVIEW_TEXT_LIMIT = 80;
// Metadata only, never whole-project contents. Returned files outside this
// deterministic bounded inventory fail closed (including newly created files).
const MAX_BASELINE_FILES = 10_000;

export interface RenameParams extends PositionInput {
  newName: string;
  apply?: boolean;
}

interface PlannedFile {
  path: string;
  real: string;
  relativePath: string;
  snapshot: FixSnapshot;
  text: string;
  edits: LspTextEdit[];
  newText: string;
}

export async function runRename(
  route: OperationRoute,
  params: RenameParams,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  ctx: StatusContext,
  statusKey: string,
) {
  const [lead] = route.candidates;
  if (!lead) throw new Error(`No rename route supports ${route.file}.`);
  throwIfAborted(signal, lead);
  const root = route.root;
  const file = resolveSupportedFile(lead, root, route.file);
  const relativePath = displayPath(root, file);
  if (!params.newName.trim()) throw new Error("newName must not be blank.");
  const workspace = captureWorkspace(root);
  const baselines = new Map<string, { real: string; stat: Stats }>();
  for (const candidate of route.candidates) {
    for (const supported of collectSupportedFiles(candidate, root, undefined, MAX_BASELINE_FILES)) {
      const resolved = assertFixWorkspace(candidate, root, workspace, supported, "rename");
      const real = realpathSync(resolved);
      if (!baselines.has(resolved) && baselines.size < MAX_BASELINE_FILES)
        baselines.set(resolved, { real, stat: statSync(resolved) });
    }
  }
  // Always include the requested target, even beyond the inventory cap.
  const targetPath = assertFixWorkspace(lead, root, workspace, file, "rename");
  baselines.set(targetPath, { real: realpathSync(targetPath), stat: statSync(targetPath) });
  // The server sees exactly these bytes, so a later change to the target is always detected.
  const target = {
    file,
    real: realpathSync(file),
    snapshot: snapshotFile(file),
  };
  const text = target.snapshot.bytes.toString("utf8");
  const position = resolvePosition(text, params, relativePath);
  const uri = pathToFileURL(file).href;

  const { adapter, value } = await runOnCapableServer(
    route,
    "renameProvider",
    timeoutMs,
    signal,
    ctx,
    statusKey,
    async (client, adapter) => {
      assertFixWorkspace(adapter, root, workspace, file, "rename");
      client.didOpen(uri, text, adapter.languageIdFor(file));
      try {
        return await client.requestResult("textDocument/rename", {
          textDocument: { uri },
          position,
          newName: params.newName,
        });
      } finally {
        client.didClose(uri);
      }
    },
  );
  throwIfAborted(signal, adapter);

  let planned: PlannedFile[];
  try {
    planned = planWorkspaceEdit(adapter, root, workspace, value, target, baselines);
  } catch (error) {
    throw new Error(`lsp_rename wrote nothing: ${error instanceof Error ? error.message : String(error)}`);
  }
  const changed = planned.filter((plan) => plan.newText !== plan.text);
  const apply = params.apply === true;
  if (apply && changed.length) await writePlannedFiles(adapter, root, workspace, changed, signal);

  const subject = `${relativePath}:${displayPosition(position)}${params.symbol ? ` (${params.symbol})` : ""}`;
  const editCount = changed.reduce((total, plan) => total + plan.edits.length, 0);
  const summary = `${editCount} edit(s) in ${changed.length} file(s)`;
  const header = !changed.length
    ? `${adapter.name} rename of ${subject} to ${JSON.stringify(params.newName)} produced no changes.`
    : apply
      ? `${adapter.name} renamed ${subject} to ${JSON.stringify(params.newName)}: applied ${summary}.`
      : `${adapter.name} rename preview for ${subject} to ${JSON.stringify(params.newName)}: ${summary}. ` +
        "Nothing was written; repeat the call with apply: true to write these edits.";
  return textResult([header, ...changed.map(formatPlannedFile)].join("\n\n"), {
    root,
    path: relativePath,
    server: adapter.name,
    position: { line: position.line + 1, column: position.character + 1 },
    newName: params.newName,
    apply,
    changed: changed.length > 0,
    outcome: changed.length ? (apply ? "updated" : "preview") : "unchanged",
    files: changed.map((plan) => ({
      path: plan.relativePath,
      edits: plan.edits.length,
    })),
  });
}

/** Validate pre-request metadata, then capture touched bytes before anything is written. */
function planWorkspaceEdit(
  adapter: LspServerAdapter,
  root: string,
  workspace: FixWorkspace,
  edit: unknown,
  target: { real: string; snapshot: FixSnapshot },
  baselines: ReadonlyMap<string, { real: string; stat: Stats }>,
) {
  const { files, resourceOperations } = flattenWorkspaceEdit(edit);
  if (resourceOperations.length) {
    const described = resourceOperations.map(
      ({ kind, uris }) => `${kind} ${uris.map((uri) => displayUri(root, uri)).join(" to ")}`,
    );
    throw new Error(
      `${adapter.name} returned file operations that lsp_rename does not apply: ${described.join("; ")}. ` +
        "Move or create those files separately, then rename again.",
    );
  }
  const planned = new Map<string, PlannedFile>();
  for (const { uri, edits } of files) {
    let filePath: string;
    try {
      filePath = fileURLToPath(uri);
    } catch {
      throw new Error(`${adapter.name} returned an edit for a non-file URI: ${uri}.`);
    }
    // Only regular files inside the captured workspace that route to this server.
    const resolved = assertFixWorkspace(adapter, root, workspace, filePath, "rename");
    const real = realpathSync(resolved);
    const relativePath = displayPath(root, resolved);
    if (planned.has(real)) throw new Error(`${adapter.name} edited ${relativePath} through more than one URI.`);
    const captured = baselines.get(resolved);
    if (!captured)
      throw new Error(
        `${relativePath} has no pre-request rename baseline (inventory limit ${MAX_BASELINE_FILES}); retry in a smaller workspace.`,
      );
    const baseline = captured.stat;
    const assertBaseline = () => {
      if (captured.real !== realpathSync(resolved)) throw staleFixError(resolved, "rename");
      const current = statSync(resolved);
      if (
        !sameFile(baseline, current) ||
        baseline.size !== current.size ||
        baseline.mtimeMs !== current.mtimeMs ||
        baseline.ctimeMs !== current.ctimeMs
      ) {
        throw staleFixError(resolved, "rename");
      }
    };
    assertBaseline();
    const snapshot = real === target.real ? target.snapshot : snapshotFile(resolved);
    assertBaseline();
    assertFreshFile(adapter, root, workspace, resolved, snapshot, "rename");
    const text = snapshot.bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(snapshot.bytes)) throw new Error(`${relativePath} is not valid UTF-8.`);
    const invalid = findInvalidTextEditRange(text, edits);
    if (invalid) {
      throw new Error(
        `${adapter.name} returned edit range ${invalid}, which does not exist in ${relativePath}; ` +
          "the file may have changed. Retry the rename.",
      );
    }
    if (hasOverlappingTextEdits(text, edits)) {
      throw new Error(`${adapter.name} returned overlapping rename edits for ${relativePath}.`);
    }
    planned.set(real, {
      path: resolved,
      real,
      relativePath,
      snapshot,
      text,
      edits,
      newText: applyTextEdits(text, edits),
    });
  }
  return [...planned.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

/**
 * Hold Pi's mutation queue for every file, acquired in one global order so two
 * multi-file writers cannot deadlock, and verify all files before writing any.
 */
async function writePlannedFiles(
  adapter: LspServerAdapter,
  root: string,
  workspace: FixWorkspace,
  files: PlannedFile[],
  signal: AbortSignal | undefined,
) {
  const write = async () => {
    throwIfAborted(signal, adapter);
    for (const plan of files) assertFreshFile(adapter, root, workspace, plan.path, plan.snapshot, "rename");
    const updated: string[] = [];
    for (const plan of files) {
      try {
        writeFreshFix(adapter, root, workspace, plan.path, plan.snapshot, plan.newText, "rename");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message} Files already updated by this rename: ${updated.join(", ") || "none"}.`);
      }
      updated.push(plan.relativePath);
    }
  };
  const queue = fileMutationQueue();
  const keys = files.map((plan) => plan.real).sort();
  return queue ? withQueues(queue, keys, write) : write();
}

function withQueues(queue: FileMutationQueue, files: string[], run: () => Promise<void>): Promise<void> {
  const [first, ...rest] = files;
  return first === undefined ? run() : queue(first, () => withQueues(queue, rest, run));
}

function snapshotFile(file: string) {
  const fd = openSync(file, "r");
  try {
    const snapshot = readFixSnapshot(fd, file, "rename");
    if (!sameFile(snapshot, statSync(file))) throw staleFixError(file, "rename");
    return snapshot;
  } finally {
    closeSync(fd);
  }
}

function formatPlannedFile(plan: PlannedFile) {
  const edits = plan.edits
    .map((edit) => ({
      edit,
      start: offsetAt(plan.text, edit.range.start),
      end: offsetAt(plan.text, edit.range.end),
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .map(
      ({ edit, start, end }) =>
        `  ${displayPosition(edit.range.start)} ${quote(plan.text.slice(start, end))} -> ${quote(edit.newText)}`,
    );
  return [`${plan.relativePath} (${plan.edits.length} edit(s))`, ...edits].join("\n");
}

function quote(text: string) {
  return JSON.stringify(text.length > PREVIEW_TEXT_LIMIT ? `${text.slice(0, PREVIEW_TEXT_LIMIT)}…` : text);
}
