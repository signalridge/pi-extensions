/**
 * Ralph Wiggum - Long-running agent loops for iterative development.
 * Port of Geoffrey Huntley's approach.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { captureOwner, extendsOwner, hasCompletionMarker, IterationOwnership, type LoopOwner } from "./ownership.ts";
import {
  invalidLoopControl,
  isLoopCount,
  LOOP_COUNT_BOUNDS,
  type LoopState,
  publishLoopState,
  readLoopState,
} from "./state-store.ts";

const RALPH_DIR = ".ralph";
const COMPLETE_MARKER = "<promise>COMPLETE</promise>";

const DEFAULT_TEMPLATE = `# Task

Describe your task here.

## Goals
- Goal 1
- Goal 2

## Checklist
- [ ] Item 1
- [ ] Item 2

## Verification
- Commands run, working directories, relevant environment variables, outputs, and preserved artifacts

## Final Verification
- Exact monitor-rerunnable command: <command>
- Working directory: <path>
- Required preserved artifacts: <paths>
- Result: <output summary>

## Notes
(Update this as you work)
`;

const DEFAULT_COMPLETION_GATE = `COMPLETION GATE

Do not output ${COMPLETE_MARKER} based only on checked checklist items.
Before completion:
1. Run a final verification command that an external monitor can rerun from the same worktree in a fresh shell.
2. Record the exact command, working directory, relevant environment variables, and output summary in the task file.
3. Preserve every artifact required by that command, including build directories, generated libraries, virtualenvs, caches, or copied dylibs.
4. If cleanup removes required artifacts, recreate them or update the final command before completing.
5. If the final command cannot be made externally rerunnable, mark the item blocked/deferred instead of complete.`;

const DEFAULT_STALE_PROMPT_GUARD = `STALE PROMPT GUARD

Before doing any work from a Ralph prompt, reload the loop state file named in the prompt (usually .ralph/<name>.state.json).
If the state status is not "active", do not edit files, do not run task commands, and do not call ralph_done. Reply briefly that the stale prompt was ignored because the loop is already completed.`;

const DEFAULT_REFLECT_INSTRUCTIONS = `REFLECTION CHECKPOINT

Pause and reflect on your progress:
1. What has been accomplished so far?
2. What's working well?
3. What's not working or blocking progress?
4. Should the approach be adjusted?
5. What are the next priorities?

Update the task file with your reflection, then continue working.`;

type LoopStatus = "active" | "paused" | "completed";

const STATUS_ICONS: Record<LoopStatus, string> = { active: "▶", paused: "⏸", completed: "✓" };

export default function (pi: ExtensionAPI) {
  let currentLoop: string | null = null;
  let sessionController = new AbortController();
  let activeSessionId: string | undefined;
  let liveOwner: LoopOwner | undefined;
  const ownership = new IterationOwnership();
  let outcome: { nonce: string; loop: string; iteration: number; complete: boolean } | undefined;

  let acceptedRun:
    | { ctx: ExtensionContext; signal: AbortSignal; nonce: string; loop: string; owner: LoopOwner }
    | undefined;
  function ownedAcceptedRun(ctx: ExtensionContext) {
    const run = acceptedRun;
    // Commands have no run signal. Only the accepted run's live context,
    // manager, native branch and nonce prove ownership of the operation.
    return run &&
      !run.signal.aborted &&
      run.loop === currentLoop &&
      ownership.ownsRun(run.nonce) &&
      extendsOwner(ctx, run.owner) &&
      extendsOwner(ctx, liveOwner) &&
      run.ctx.signal === run.signal
      ? run
      : undefined;
  }

  function retireOwnership(ctx?: ExtensionContext) {
    const run = ctx ? ownedAcceptedRun(ctx) : undefined;
    acceptedRun = undefined;
    outcome = undefined;
    // Never abort a new root through a captured old context.
    run?.ctx.abort();
    ownership.retire();
    liveOwner = undefined;
    currentLoop = null;
  }

  function claimLoop(ctx: ExtensionContext, state: LoopState) {
    // Activation has already validated its task and running-operation fence.
    // Recover duplicates only with positive session AND branch ownership proof.
    for (const other of listLoops(ctx)) {
      if (other.name !== state.name && other.status === "active" && isOwnedByCurrentSession(ctx, other)) {
        other.status = "paused";
        other.active = false;
        saveState(ctx, other);
      }
    }
    outcome = undefined;
    acceptedRun = undefined;
    ownership.retire();
    currentLoop = state.name;
    liveOwner = captureOwner(ctx);
    state.ownerSessionId = sessionId(ctx);
    state.ownerBranchIds = liveOwner?.branch;
  }

  function sendIteration(ctx: ExtensionContext, state: LoopState, content: string, reflection: boolean) {
    const token = ownership.send(
      state.name,
      state.iteration,
      buildPrompt(state, content, reflection),
      captureOwner(ctx),
    );
    ownership.finishIteration();
    pi.sendUserMessage(token, { deliverAs: "followUp" });
  }

  // --- File helpers ---

  const ralphDir = (ctx: ExtensionContext) => path.resolve(ctx.cwd, RALPH_DIR);
  const archiveDir = (ctx: ExtensionContext) => path.join(ralphDir(ctx), "archive");
  const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  const sessionId = (ctx: ExtensionContext) => ctx.sessionManager?.getSessionId?.();

  function getPath(ctx: ExtensionContext, name: string, ext: string, archived = false): string {
    const dir = archived ? archiveDir(ctx) : ralphDir(ctx);
    return path.join(dir, `${sanitize(name)}${ext}`);
  }

  /**
   * Canonicalize as much of `target` as exists on disk.
   *
   * A containment check that compares lexical paths is defeated by a symlink:
   * `.ralph/notes.md -> ../../../etc/notes.md` reads as inside the workspace
   * and is not. `realpathSync` answers that, but it throws on a path that does
   * not exist yet — which is the ordinary case here, since `/ralph start` is
   * usually creating the file. So resolve the deepest existing ancestor and
   * re-attach the not-yet-created suffix, which cannot itself be a link.
   *
   * Applied to both sides of the comparison, so a workspace that is itself
   * reached through a link (`/tmp` on macOS) still matches its own contents.
   */
  function realpathOfNearestExisting(target: string): string {
    let current = target;
    for (;;) {
      try {
        return path.resolve(fs.realpathSync(current), path.relative(current, target));
      } catch {
        const parent = path.dirname(current);
        // Filesystem root: nothing above it to canonicalize against.
        if (parent === current) return target;
        current = parent;
      }
    }
  }

  /**
   * Resolve a task-file path against the session cwd, refusing anything that
   * lands outside it.
   *
   * `/ralph start <name|path>` takes a raw path, and this extension drives long
   * unattended loops — the command is as likely to be issued by a model as
   * typed. Without this, `../../notes.md` silently `mkdir -p`s and creates a
   * file outside the project the user opened. Everything this extension owns
   * lives under the workspace, so anything else is a mistake, not a feature.
   */
  function resolveInWorkspace(ctx: ExtensionContext, taskFile: string): string | undefined {
    const root = realpathOfNearestExisting(path.resolve(ctx.cwd));
    const full = realpathOfNearestExisting(path.resolve(path.resolve(ctx.cwd), taskFile));
    const relative = path.relative(root, full);
    // "" is the root directory itself, which is not a task file. An escape
    // produces a `..` segment: match `..` exactly or followed by a separator,
    // never a bare `startsWith("..")` — that would also reject `..notes.md`,
    // an ordinary filename inside the workspace. `isAbsolute` catches the
    // Windows case where the two paths are on different drives and `relative`
    // cannot express a traversal at all.
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return undefined;
    }
    return full;
  }

  /** Read a persisted task file, or null when it is missing or escapes the workspace. */
  function readTaskFile(ctx: ExtensionContext, taskFile: string): string | null {
    const full = resolveInWorkspace(ctx, taskFile);
    return full ? tryRead(full) : null;
  }

  function ensureDir(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  function tryDelete(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }

  function tryRead(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  function safeMtimeMs(filePath: string): number {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return 0;
    }
  }

  function tryRemoveDir(dirPath: string): boolean {
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
      return true;
    } catch {
      return false;
    }
  }

  // --- State management ---

  function warnState(ctx: ExtensionContext, message: string) {
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    else console.warn(`[pi-ralph-wiggum] ${message}`);
  }

  function loadState(ctx: ExtensionContext, name: string, archived = false): LoopState | null {
    return readLoopState(getPath(ctx, name, ".state.json", archived), (message) => warnState(ctx, message));
  }

  function saveState(ctx: ExtensionContext, state: LoopState, archived = false): void {
    state.active = state.status === "active";
    const filePath = getPath(ctx, state.name, ".state.json", archived);
    if (fs.existsSync(filePath) && !loadState(ctx, state.name, archived)) {
      throw new Error(`Refusing to overwrite invalid Ralph state: ${filePath}`);
    }
    const owner = captureOwner(ctx);
    if (currentLoop === state.name && extendsOwner(ctx, liveOwner)) {
      liveOwner = owner;
      state.ownerBranchIds = owner?.branch;
    }
    publishLoopState(filePath, state);
  }

  function listLoops(ctx: ExtensionContext, archived = false): LoopState[] {
    const dir = archived ? archiveDir(ctx) : ralphDir(ctx);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".state.json"))
      .map((f) => readLoopState(path.join(dir, f), (message) => warnState(ctx, message)))
      .filter((s): s is LoopState => s !== null);
  }

  function isOwnedByCurrentSession(ctx: ExtensionContext, state: LoopState): boolean {
    const currentSessionId = sessionId(ctx);
    return Boolean(
      currentSessionId &&
        state.ownerSessionId === currentSessionId &&
        state.ownerBranchIds &&
        (state.ownerBranchIds.length > 0 || (currentLoop === state.name && liveOwner !== undefined)) &&
        extendsOwner(ctx, { sessionId: currentSessionId, branch: state.ownerBranchIds }),
    );
  }

  function getCurrentOwnedState(ctx: ExtensionContext): LoopState | null {
    if (!currentLoop) return null;
    const state = loadState(ctx, currentLoop);
    if (
      state?.status !== "active" ||
      !isOwnedByCurrentSession(ctx, state) ||
      !extendsOwner(ctx, liveOwner) ||
      (ownership.iteration && ownership.iteration.iteration !== state.iteration)
    ) {
      retireOwnership();
      return null;
    }
    liveOwner = captureOwner(ctx);
    return state;
  }

  function findActiveOwnedState(ctx: ExtensionContext): LoopState | undefined {
    if (!extendsOwner(ctx, liveOwner)) return undefined;
    return listLoops(ctx).find((state) => state.status === "active" && isOwnedByCurrentSession(ctx, state));
  }

  // --- Loop state transitions ---

  function pauseLoop(ctx: ExtensionContext, state: LoopState, message?: string): void {
    state.status = "paused";
    state.active = false;
    saveState(ctx, state);
    retireOwnership(ctx);
    updateUI(ctx);
    if (message && ctx.hasUI) ctx.ui.notify(message, "info");
  }

  function completeLoop(ctx: ExtensionContext, state: LoopState, banner: string): void {
    state.status = "completed";
    state.completedAt = new Date().toISOString();
    state.active = false;
    saveState(ctx, state);
    retireOwnership();
    updateUI(ctx);
    pi.sendMessage({ customType: "ralph-status", content: banner, display: true }, { triggerTurn: false });
  }

  function stopLoop(ctx: ExtensionContext, state: LoopState, message?: string): void {
    state.status = "completed";
    state.completedAt = new Date().toISOString();
    state.active = false;
    saveState(ctx, state);
    retireOwnership();
    updateUI(ctx);
    if (message && ctx.hasUI) ctx.ui.notify(message, "info");
  }

  // --- UI ---

  function formatLoop(l: LoopState): string {
    const status = `${STATUS_ICONS[l.status]} ${l.status}`;
    const iter = l.maxIterations > 0 ? `${l.iteration}/${l.maxIterations}` : `${l.iteration}`;
    return `${l.name}: ${status} (iteration ${iter})`;
  }

  function updateUI(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    const state = getCurrentOwnedState(ctx);
    if (!state) {
      ctx.ui.setStatus("ralph", undefined);
      ctx.ui.setWidget("ralph", undefined);
      return;
    }

    const { theme } = ctx.ui;
    const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";
    const reflection =
      state.reflectEvery > 0
        ? ` · 🪞 reflect in ${state.reflectEvery - ((state.iteration - 1) % state.reflectEvery)}`
        : "";
    const title = theme.fg("success", theme.bold("Ralph Wiggum"));
    const status = theme.fg(
      "dim",
      ` · 🔁 ${state.name} · ${STATUS_ICONS[state.status]} ${state.status} · 🔢 ${state.iteration}${maxStr} · 📄 ${state.taskFile}${reflection} · Esc pause · /ralph resume · /ralph-stop stop`,
    );

    ctx.ui.setStatus("ralph", `${title}${status}`);
    ctx.ui.setWidget("ralph", undefined);
  }

  // --- Prompt building ---

  function buildPrompt(state: LoopState, taskContent: string, isReflection: boolean): string {
    const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";
    const header = `───────────────────────────────────────────────────────────────────────
🔄 RALPH LOOP: ${state.name} | Iteration ${state.iteration}${maxStr}${isReflection ? " | 🪞 REFLECTION" : ""}
───────────────────────────────────────────────────────────────────────`;

    const parts = [header, ""];
    if (isReflection) parts.push(state.reflectInstructions, "\n---\n");

    parts.push(`## Current Task (from ${state.taskFile})\n\n${taskContent}\n\n---`);
    parts.push(`\n## Stale Prompt Guard\n\n${DEFAULT_STALE_PROMPT_GUARD}\n`);
    parts.push(`\n## Completion Gate\n\n${DEFAULT_COMPLETION_GATE}\n`);
    parts.push(`\n## Instructions\n`);
    parts.push(
      "User controls: ESC pauses the assistant. Use /ralph resume <name> to resume a paused or unbound loop. Run /ralph-stop when idle to stop the loop.\n",
    );
    parts.push(
      `You are in a Ralph loop (iteration ${state.iteration}${state.maxIterations > 0 ? ` of ${state.maxIterations}` : ""}).\n`,
    );

    if (state.itemsPerIteration > 0) {
      parts.push(`**THIS ITERATION: Process approximately ${state.itemsPerIteration} items, then call ralph_done.**\n`);
      parts.push(`1. Work on the next ~${state.itemsPerIteration} items from your checklist`);
    } else {
      parts.push(`1. Continue working on the task`);
    }
    parts.push(`2. Update the task file (${state.taskFile}) with your progress`);
    parts.push(`3. When FULLY COMPLETE and the completion gate is satisfied, respond with: ${COMPLETE_MARKER}`);
    parts.push(`4. Otherwise, call the ralph_done tool to proceed to next iteration`);

    return parts.join("\n");
  }

  // --- Arg parsing ---

  function parseArgs(argsStr: string) {
    const tokens = argsStr.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const result = {
      name: "",
      maxIterations: 50,
      itemsPerIteration: 0,
      reflectEvery: 0,
      reflectInstructions: DEFAULT_REFLECT_INSTRUCTIONS,
    };

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const next = tokens[i + 1];
      if (tok === "--max-iterations" || tok === "--items-per-iteration" || tok === "--reflect-every") {
        const token = next?.replace(/^"(.*)"$/u, "$1");
        // Check the integer token before Number(): fractions/exponents can round
        // or underflow to an accepted integer, including unlimited zero.
        const value = token !== undefined && /^\d+$/u.test(token) ? Number(token) : NaN;
        if (!isLoopCount(value)) throw new Error(`${tok} must be a nonnegative safe integer.`);
        const key =
          tok === "--max-iterations"
            ? "maxIterations"
            : tok === "--items-per-iteration"
              ? "itemsPerIteration"
              : "reflectEvery";
        result[key] = value;
        i++;
      } else if (tok === "--reflect-instructions" && next) {
        result.reflectInstructions = next.replace(/^"|"$/g, "");
        i++;
      } else if (!tok.startsWith("--")) {
        result.name = tok;
      }
    }
    return result;
  }

  // --- Commands ---

  const commands: Record<string, (rest: string, ctx: ExtensionContext) => void | Promise<void>> = {
    start(rest, ctx) {
      let args: ReturnType<typeof parseArgs>;
      try {
        args = parseArgs(rest);
      } catch (error: unknown) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      if (!args.name) {
        ctx.ui.notify(
          "Usage: /ralph start <name|path> [--items-per-iteration N] [--reflect-every N] [--max-iterations N]",
          "warning",
        );
        return;
      }

      if (ownedAcceptedRun(ctx)) {
        ctx.ui.notify("Ralph iteration is still running. Stop it or wait for it to settle before starting.", "warning");
        return;
      }

      const isPath = args.name.includes("/") || args.name.includes("\\");
      const loopName = isPath ? sanitize(path.basename(args.name, path.extname(args.name))) : args.name;
      const taskFile = isPath ? args.name : path.join(RALPH_DIR, `${loopName}.md`);

      const existing = loadState(ctx, loopName);
      if (!existing && fs.existsSync(getPath(ctx, loopName, ".state.json"))) return;
      if (existing?.status === "active") {
        ctx.ui.notify(`Loop "${loopName}" is already active. Use /ralph resume ${loopName}`, "warning");
        return;
      }

      const fullPath = resolveInWorkspace(ctx, taskFile);
      if (!fullPath) {
        ctx.ui.notify(`Task file must be inside the workspace: ${taskFile}`, "error");
        return;
      }
      if (!fs.existsSync(fullPath)) {
        ensureDir(fullPath);
        fs.writeFileSync(fullPath, DEFAULT_TEMPLATE, "utf-8");
        ctx.ui.notify(`Created task file: ${taskFile}`, "info");
      }

      const content = tryRead(fullPath);
      if (!content?.trim()) {
        ctx.ui.notify(`Task file must be readable and non-whitespace: ${taskFile}`, "error");
        return;
      }

      const state: LoopState = {
        name: loopName,
        taskFile,
        iteration: 1,
        maxIterations: args.maxIterations,
        itemsPerIteration: args.itemsPerIteration,
        reflectEvery: args.reflectEvery,
        reflectInstructions: args.reflectInstructions,
        active: true,
        status: "active",
        startedAt: existing?.startedAt || new Date().toISOString(),
        lastReflectionAt: 0,
        ownerSessionId: sessionId(ctx),
      };

      claimLoop(ctx, state);
      saveState(ctx, state);
      updateUI(ctx);

      sendIteration(ctx, state, content, false);
    },

    stop(_rest, ctx) {
      const state = getCurrentOwnedState(ctx) ?? findActiveOwnedState(ctx);
      if (!state) {
        ctx.ui.notify("No active Ralph loop owned by this session", "warning");
        updateUI(ctx);
        return;
      }
      pauseLoop(ctx, state, `Paused Ralph loop: ${state.name} (iteration ${state.iteration})`);
    },

    resume(rest, ctx) {
      const loopName = rest.trim();
      if (!loopName) {
        ctx.ui.notify("Usage: /ralph resume <name>", "warning");
        return;
      }

      // Do not retire a still-running accepted iteration: a later async tool
      // hook may already have passed Ralph's fence. Keep its abort authority.
      if (ownedAcceptedRun(ctx)) {
        ctx.ui.notify("Ralph iteration is still running. Stop it or wait for it to settle before resuming.", "warning");
        return;
      }

      const state = loadState(ctx, loopName);
      if (!state) {
        ctx.ui.notify(`Loop "${loopName}" not found`, "error");
        return;
      }
      if (state.status === "completed") {
        ctx.ui.notify(`Loop "${loopName}" is completed. Use /ralph start ${loopName} to restart`, "warning");
        return;
      }

      const content = readTaskFile(ctx, state.taskFile);
      if (!content?.trim()) {
        ctx.ui.notify(`Could not read task file with non-whitespace content: ${state.taskFile}`, "error");
        return;
      }

      state.status = "active";
      state.active = true;
      state.ownerSessionId = sessionId(ctx);
      state.iteration++;
      claimLoop(ctx, state);
      saveState(ctx, state);
      updateUI(ctx);

      ctx.ui.notify(`Resumed: ${loopName} (iteration ${state.iteration})`, "info");

      const needsReflection =
        state.reflectEvery > 0 && state.iteration > 1 && (state.iteration - 1) % state.reflectEvery === 0;
      sendIteration(ctx, state, content, needsReflection);
    },

    status(_rest, ctx) {
      const loops = listLoops(ctx);
      if (loops.length === 0) {
        ctx.ui.notify("No Ralph loops found.", "info");
        return;
      }
      ctx.ui.notify(`Ralph loops:\n${loops.map((l) => formatLoop(l)).join("\n")}`, "info");
    },

    cancel(rest, ctx) {
      const loopName = rest.trim();
      if (!loopName) {
        ctx.ui.notify("Usage: /ralph cancel <name>", "warning");
        return;
      }
      if (!loadState(ctx, loopName)) {
        ctx.ui.notify(`Loop "${loopName}" not found`, "error");
        return;
      }
      if (currentLoop === loopName) retireOwnership(ctx);
      tryDelete(getPath(ctx, loopName, ".state.json"));
      ctx.ui.notify(`Cancelled: ${loopName}`, "info");
      updateUI(ctx);
    },

    archive(rest, ctx) {
      const loopName = rest.trim();
      if (!loopName) {
        ctx.ui.notify("Usage: /ralph archive <name>", "warning");
        return;
      }
      const state = loadState(ctx, loopName);
      if (!state) {
        ctx.ui.notify(`Loop "${loopName}" not found`, "error");
        return;
      }
      if (state.status === "active") {
        ctx.ui.notify("Cannot archive active loop. Stop it first.", "warning");
        return;
      }

      if (currentLoop === loopName) retireOwnership();

      const srcState = getPath(ctx, loopName, ".state.json");
      const dstState = getPath(ctx, loopName, ".state.json", true);
      ensureDir(dstState);
      if (fs.existsSync(srcState)) fs.renameSync(srcState, dstState);

      const srcTask = resolveInWorkspace(ctx, state.taskFile);
      if (srcTask?.startsWith(ralphDir(ctx)) && !srcTask.startsWith(archiveDir(ctx))) {
        const dstTask = getPath(ctx, loopName, ".md", true);
        if (fs.existsSync(srcTask)) fs.renameSync(srcTask, dstTask);
      }

      ctx.ui.notify(`Archived: ${loopName}`, "info");
      updateUI(ctx);
    },

    clean(rest, ctx) {
      const all = rest.trim() === "--all";
      const completed = listLoops(ctx).filter((l) => l.status === "completed");

      if (completed.length === 0) {
        ctx.ui.notify("No completed loops to clean", "info");
        return;
      }

      for (const loop of completed) {
        tryDelete(getPath(ctx, loop.name, ".state.json"));
        if (all) tryDelete(getPath(ctx, loop.name, ".md"));
        if (currentLoop === loop.name) retireOwnership();
      }

      const suffix = all ? " (all files)" : " (state only)";
      ctx.ui.notify(
        `Cleaned ${completed.length} loop(s)${suffix}:\n${completed.map((l) => `  • ${l.name}`).join("\n")}`,
        "info",
      );
      updateUI(ctx);
    },

    list(rest, ctx) {
      const archived = rest.trim() === "--archived";
      const loops = listLoops(ctx, archived);

      if (loops.length === 0) {
        ctx.ui.notify(
          archived ? "No archived loops" : "No loops found. Use /ralph list --archived for archived.",
          "info",
        );
        return;
      }

      const label = archived ? "Archived loops" : "Ralph loops";
      ctx.ui.notify(`${label}:\n${loops.map((l) => formatLoop(l)).join("\n")}`, "info");
    },

    async nuke(rest, ctx) {
      const force = rest.trim() === "--yes";
      const warning = "This deletes all .ralph state, task, and archive files. External task files are not removed.";
      const controller = sessionController;
      const owner = sessionId(ctx);
      const branchOwner = captureOwner(ctx);
      const dir = ralphDir(ctx);
      // Test plain captured ownership before touching a possibly retired context.
      const isCurrent = () =>
        controller === sessionController &&
        !controller.signal.aborted &&
        owner === activeSessionId &&
        extendsOwner(ctx, branchOwner);
      let onAbort: (() => void) | undefined;
      try {
        if (!isCurrent()) return;
        if (!force) {
          if (!ctx.hasUI) {
            ctx.ui.notify(`Run /ralph nuke --yes to confirm. ${warning}`, "warning");
            return;
          }
          const cancelled = new Promise<false>((resolve) => {
            onAbort = () => resolve(false);
            controller.signal.addEventListener("abort", onAbort, { once: true });
          });
          const confirmed = await Promise.race([
            ctx.ui.confirm("Delete all Ralph loop files?", warning, { signal: controller.signal }),
            cancelled,
          ]);
          if (!isCurrent() || !confirmed) return;
        }
        if (!isCurrent() || sessionId(ctx) !== owner) return;
        if (force && ctx.hasUI) ctx.ui.notify(warning, "warning");
        if (!fs.existsSync(dir)) {
          if (ctx.hasUI) ctx.ui.notify("No .ralph directory found.", "info");
          return;
        }
        retireOwnership(ctx);
        const ok = tryRemoveDir(dir);
        if (ctx.hasUI) {
          ctx.ui.notify(ok ? "Removed .ralph directory." : "Failed to remove .ralph directory.", ok ? "info" : "error");
        }
        updateUI(ctx);
      } catch (error: unknown) {
        // Even reporting an error through an invalid context can throw.
        if (isCurrent()) {
          console.warn(`[pi-ralph-wiggum] nuke failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      }
    },
  };

  const HELP = `Ralph Wiggum - Long-running development loops

Commands:
  /ralph start <name|path> [options]  Start a new loop
  /ralph stop                         Pause current loop
  /ralph resume <name>                Resume a paused loop
  /ralph status                       Show all loops
  /ralph cancel <name>                Delete loop state
  /ralph archive <name>               Move loop to archive
  /ralph clean [--all]                Clean completed loops
  /ralph list --archived              Show archived loops
  /ralph nuke [--yes]                 Delete all .ralph data
  /ralph-stop                         Stop active loop (idle only)

Options:
  --items-per-iteration N  Suggest N items per turn (prompt hint)
  --reflect-every N        Reflect every N iterations
  --max-iterations N       Stop after N iterations (default 50)

To stop: press ESC to interrupt, then run /ralph-stop when idle

Examples:
  /ralph start my-feature
  /ralph start review --items-per-iteration 5 --reflect-every 10`;

  pi.registerCommand("ralph", {
    description: "Ralph Wiggum - long-running development loops",
    handler: async (args, ctx) => {
      const [cmd] = args.trim().split(/\s+/);
      const handler = commands[cmd];
      if (handler) {
        await handler(args.slice(cmd.length).trim(), ctx);
      } else {
        ctx.ui.notify(HELP, "info");
      }
    },
  });

  pi.registerCommand("ralph-stop", {
    description: "Stop active Ralph loop (idle only)",
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) {
        if (ctx.hasUI) {
          ctx.ui.notify("Agent is busy. Press ESC to interrupt, then run /ralph-stop.", "warning");
        }
        return;
      }

      const state = getCurrentOwnedState(ctx) ?? findActiveOwnedState(ctx);
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("No active Ralph loop owned by this session", "warning");
        updateUI(ctx);
        return;
      }

      stopLoop(ctx, state, `Stopped Ralph loop: ${state.name} (iteration ${state.iteration})`);
    },
  });

  // --- Tool for agent self-invocation ---

  pi.registerTool({
    name: "ralph_start",
    label: "Start Ralph Loop",
    description: "Start a long-running development loop. Use for complex multi-iteration tasks.",
    promptSnippet: "Start a persistent multi-iteration development loop with pacing and reflection controls.",
    promptGuidelines: [
      "Use this tool when the user explicitly wants an iterative loop, autonomous repeated passes, or paced multi-step execution.",
      "After starting a loop, continue each finished iteration with ralph_done unless the completion marker has already been emitted.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Loop name (e.g., 'refactor-auth')" }),
      taskContent: Type.String({ description: "Task in markdown with goals and checklist" }),
      itemsPerIteration: Type.Optional(
        Type.Integer({ ...LOOP_COUNT_BOUNDS, description: "Suggest N items per turn (0 = no limit)" }),
      ),
      reflectEvery: Type.Optional(Type.Integer({ ...LOOP_COUNT_BOUNDS, description: "Reflect every N iterations" })),
      maxIterations: Type.Optional(
        Type.Integer({ ...LOOP_COUNT_BOUNDS, description: "Max iterations (default: 50)", default: 50 }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Direct callers can bypass the host's schema validation. Reject before
      // touching task files, persisted state, or live iteration ownership.
      const invalid = invalidLoopControl(params);
      if (invalid) throw new Error(`${invalid} must be a nonnegative safe integer.`);
      if (typeof params.taskContent !== "string" || !params.taskContent.trim()) {
        throw new Error("taskContent must be non-whitespace text.");
      }
      if (ownedAcceptedRun(ctx)) {
        return {
          content: [
            {
              type: "text",
              text: "Ralph iteration is still running. Stop it or wait for it to settle before starting.",
            },
          ],
          details: {},
        };
      }
      const loopName = sanitize(params.name);
      const taskFile = path.join(RALPH_DIR, `${loopName}.md`);

      const existing = loadState(ctx, loopName);
      if (!existing && fs.existsSync(getPath(ctx, loopName, ".state.json"))) {
        return {
          content: [{ type: "text", text: `Invalid Ralph state for "${loopName}"; left unchanged.` }],
          details: {},
        };
      }
      if (existing?.status === "active") {
        return { content: [{ type: "text", text: `Loop "${loopName}" already active.` }], details: {} };
      }

      const fullPath = resolveInWorkspace(ctx, taskFile);
      if (!fullPath) {
        return {
          content: [{ type: "text", text: `Error: task file escapes the workspace: ${taskFile}` }],
          details: {},
        };
      }
      ensureDir(fullPath);
      fs.writeFileSync(fullPath, params.taskContent, "utf-8");

      const state: LoopState = {
        name: loopName,
        taskFile,
        iteration: 1,
        maxIterations: params.maxIterations ?? 50,
        itemsPerIteration: params.itemsPerIteration ?? 0,
        reflectEvery: params.reflectEvery ?? 0,
        reflectInstructions: DEFAULT_REFLECT_INSTRUCTIONS,
        active: true,
        status: "active",
        startedAt: new Date().toISOString(),
        lastReflectionAt: 0,
        ownerSessionId: sessionId(ctx),
      };

      claimLoop(ctx, state);
      saveState(ctx, state);
      updateUI(ctx);

      sendIteration(ctx, state, params.taskContent, false);

      return {
        content: [{ type: "text", text: `Started loop "${loopName}" (max ${state.maxIterations} iterations).` }],
        details: {},
      };
    },
  });

  // Tool for agent to signal iteration complete and request next
  pi.registerTool({
    name: "ralph_done",
    label: "Ralph Iteration Done",
    description:
      "Signal that you've completed this iteration of the Ralph loop. Call this after making progress to get the next iteration prompt. Do NOT call this if you've output the completion marker.",
    promptSnippet: "Advance an active Ralph loop after completing the current iteration.",
    promptGuidelines: [
      "Call this after making real iteration progress so Ralph can queue the next prompt.",
      "Do not call this if there is no active loop, if pending messages are already queued, or if the completion marker has already been emitted.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const state = getCurrentOwnedState(ctx);
      if (state?.status !== "active" || !ownership.current(ctx, currentLoop, state.iteration)) {
        updateUI(ctx);
        return { content: [{ type: "text", text: "No active Ralph loop owned by this session." }], details: {} };
      }

      if (ctx.hasPendingMessages()) {
        return {
          content: [{ type: "text", text: "Pending messages already queued. Skipping ralph_done." }],
          details: {},
        };
      }

      // The final iteration still owns its outcome until final settlement,
      // including any agent_before_settle continuation or automatic retry.
      if (state.maxIterations > 0 && state.iteration >= state.maxIterations) {
        return {
          content: [{ type: "text", text: "Max iterations reached. Loop will stop when this run settles." }],
          details: {},
        };
      }

      const content = readTaskFile(ctx, state.taskFile);
      if (!content?.trim()) {
        pauseLoop(ctx, state);
        return { content: [{ type: "text", text: `Error: Could not read task file: ${state.taskFile}` }], details: {} };
      }

      // Consume this iteration's authority before publishing the next one.
      ownership.finishIteration();
      state.iteration++;

      const needsReflection = state.reflectEvery > 0 && (state.iteration - 1) % state.reflectEvery === 0;
      if (needsReflection) state.lastReflectionAt = state.iteration;

      saveState(ctx, state);
      updateUI(ctx);

      // Queue next iteration - use followUp so user can still interrupt
      sendIteration(ctx, state, content, needsReflection);

      return {
        content: [{ type: "text", text: `Iteration ${state.iteration - 1} complete. Next iteration queued.` }],
        details: {},
      };
    },
  });

  // --- Event handlers ---

  pi.on("input", (event, ctx) => {
    getCurrentOwnedState(ctx);
    return ownership.input(event, ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    // Queued steers/follow-ups need not pass this boundary. Authorization is
    // bound to the accepted native message, never to the mere start of a run.
    getCurrentOwnedState(ctx);
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role === "user") acceptedRun = undefined;
    const state = getCurrentOwnedState(ctx);
    ownership.bind(event.message, state?.status === "active" ? currentLoop : null, liveOwner, ctx, state?.iteration);
  });

  pi.on("context", (event, ctx) => {
    const state = getCurrentOwnedState(ctx);
    const iteration = ownership.context(
      event.messages,
      ctx,
      state?.status === "active" ? currentLoop : null,
      liveOwner,
      state?.iteration,
    );
    if (ownership.rejected) {
      retireOwnership();
      if (!ctx.signal?.aborted) ctx.abort();
    }
    // Request-local guidance: native user text/images and history stay intact.
    const messages = event.messages.filter((message) => !ownership.isDelivery(message));
    if (!iteration || !state) {
      if (
        !acceptedRun ||
        ctx.signal !== acceptedRun.signal ||
        !ownership.ownsRun(acceptedRun.nonce) ||
        !extendsOwner(ctx, acceptedRun.owner)
      )
        acceptedRun = undefined;
      return { messages };
    }
    if (ctx.signal && iteration.owner && iteration.token) {
      acceptedRun = { ctx, signal: ctx.signal, nonce: iteration.nonce, loop: iteration.loop, owner: iteration.owner };
    }
    // Persist the positively accepted native path, including an initially empty
    // session's first anchor; a vacuous disk prefix is not reload proof.
    saveState(ctx, state);
    const content = iteration.body ?? buildPrompt(state, readTaskFile(ctx, state.taskFile) ?? "", false);
    iteration.body = undefined;
    return {
      messages: [
        ...messages,
        {
          role: "custom" as const,
          customType: "ralph-iteration-context",
          content: `[RALPH LOOP - ${state.name} - Iteration ${state.iteration}${state.maxIterations > 0 ? `/${state.maxIterations}` : ""}]\n\n${content}`,
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("tool_call", (_event, ctx) => {
    getCurrentOwnedState(ctx);
    if (!ownership.rejected) return;
    if (!ctx.signal?.aborted) ctx.abort();
    return { block: true, reason: "Retired Ralph iteration delivery." };
  });

  pi.on("session_tree", (_event, ctx) => {
    sessionController.abort();
    sessionController = new AbortController();
    retireOwnership();
    updateUI(ctx);
  });

  pi.on("agent_start", () => {
    // A continuation/retry replaces the preceding low-level run's candidate.
    outcome = undefined;
  });

  pi.on("agent_settled", (event, ctx) => {
    const candidate = outcome;
    outcome = undefined;
    const state = getCurrentOwnedState(ctx);
    const iteration = state && ownership.current(ctx, currentLoop, state.iteration);
    if (
      !event.aborted &&
      candidate &&
      state &&
      iteration &&
      candidate.nonce === iteration.nonce &&
      candidate.loop === state.name &&
      candidate.iteration === state.iteration &&
      !ctx.hasPendingMessages()
    ) {
      if (candidate.complete) {
        completeLoop(ctx, state, `RALPH LOOP COMPLETE: ${state.name} | ${state.iteration} iterations`);
      } else if (state.maxIterations > 0 && state.iteration >= state.maxIterations) {
        completeLoop(ctx, state, `RALPH LOOP STOPPED: ${state.name} | Max iterations (${state.maxIterations}) reached`);
      }
    }
    acceptedRun = undefined;
    ownership.settled();
  });

  pi.on("agent_end", async (event, ctx) => {
    outcome = undefined;
    const state = getCurrentOwnedState(ctx);
    if (state?.status !== "active" || !ownership.current(ctx, currentLoop, state.iteration)) {
      updateUI(ctx);
      return;
    }

    // Publish the final native branch anchor, without advancing the iteration.
    saveState(ctx, state);
    // Check for completion marker
    const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
    // Interrupted/failed turns and queued final prompts are not completed work.
    // Keep the loop active so the owner can retry or deliver the final iteration.
    if (!lastAssistant || lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted") return;
    if (ctx.hasPendingMessages()) return;
    const text =
      lastAssistant && Array.isArray(lastAssistant.content)
        ? lastAssistant.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n")
        : "";

    const iteration = ownership.current(ctx, currentLoop, state.iteration);
    if (iteration) {
      outcome = {
        nonce: iteration.nonce,
        loop: state.name,
        iteration: state.iteration,
        complete: hasCompletionMarker(text),
      };
    }
    // Only settlement can finalize this candidate. Do not auto-continue.
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionController.abort();
    sessionController = new AbortController();
    activeSessionId = sessionId(ctx);
    retireOwnership();
    const active = listLoops(ctx).filter((l) => l.status === "active");
    const owned = active.filter((state) => isOwnedByCurrentSession(ctx, state));

    // Rehydrate only loops that are owned by this Pi session. Older state
    // files do not have ownerSessionId, so a new unrelated session must use
    // /ralph resume <name> before Ralph injects loop instructions.
    if (!currentLoop && owned.length > 0) {
      const mostRecent = owned.reduce((best, candidate) => {
        const bestMtime = safeMtimeMs(getPath(ctx, best.name, ".state.json"));
        const candidateMtime = safeMtimeMs(getPath(ctx, candidate.name, ".state.json"));
        return candidateMtime > bestMtime ? candidate : best;
      });
      if (readTaskFile(ctx, mostRecent.taskFile)?.trim()) claimLoop(ctx, mostRecent);
    }

    if (active.length > 0 && ctx.hasUI) {
      const lines = active.map(
        (l) => `  • ${l.name} (iteration ${l.iteration}${l.maxIterations > 0 ? `/${l.maxIterations}` : ""})`,
      );
      ctx.ui.notify(`Active Ralph loops:\n${lines.join("\n")}\n\nUse /ralph resume <name> to continue`, "info");
    }
    updateUI(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    sessionController.abort();
    activeSessionId = undefined;
    const state = getCurrentOwnedState(ctx);
    if (state) saveState(ctx, state);
    retireOwnership();
  });
}
