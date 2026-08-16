import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import {
  type AdministrativePruneCandidate,
  addWorktree,
  administrativeHistoryOids,
  administrativePruneCandidates,
  currentWorktreePath,
  defaultWorktreePath,
  durableRefExists,
  durableRefsContaining,
  formatWorktree,
  listWorktrees,
  localBranchExists,
  localBranchRef,
  pathEntryExists,
  pathIdentity,
  pathsEqual,
  prunePreview,
  pruneWorktrees,
  resolveCommit,
  sameWorktreeIdentity,
  stripTerminalControls,
  symbolicBranch,
  unresolvableSymlinkAncestor,
  validateBranch,
  type WorktreeRecord,
  withWorktreeMutationLock,
  worktreeAdministrativeDirectory,
  worktreeForBranch,
  worktreeInventory,
} from "./git.js";
import { removeWorktreeSafely } from "./safe-remove.js";
import { switchToWorktree } from "./session.js";
import type { WorktreeSettingsRuntime } from "./settings.js";

const ACTION_ADD = "Add worktree";
const ACTION_SWITCH = "Switch worktree";
const ACTION_REMOVE = "Remove worktree";
const ACTION_PRUNE = "Prune stale metadata";
const ACTION_CONFIGURE_ROOT = "Configure worktree root";
const ACTIONS = {
  add: ACTION_ADD,
  switch: ACTION_SWITCH,
  remove: ACTION_REMOVE,
  prune: ACTION_PRUNE,
  configure: ACTION_CONFIGURE_ROOT,
} as const;

interface WorktreeMenuOwner {
  signal: AbortSignal;
  isCurrent(): boolean;
}

interface AdministrativeHistoryRisk {
  label: string;
  oids: string[];
}

/** The base commit the user approved, captured before the confirmation and re-checked after it. */
interface AddBaseProvenance {
  kind: "create" | "attach";
  /** Human-facing base, e.g. "main" for a new branch or "refs/heads/feature" for an attach. */
  label: string;
  /** Lowercased full OID that `label` resolved to when the preview was built. */
  oid: string;
}

export function registerWorktreeCommand(
  pi: ExtensionAPI,
  settings: WorktreeSettingsRuntime,
  getMenuOwner: () => WorktreeMenuOwner,
): void {
  pi.registerCommand("worktree", {
    description: "Interactively manage Git worktrees and their default root",
    handler: async (args, ctx) => {
      if (args.trim()) {
        safeNotify(ctx, "/worktree does not accept arguments; run it without arguments to open the menu.", "warning");
        return;
      }
      if (!ctx.hasUI) {
        safeNotify(ctx, "/worktree requires TUI or RPC mode.", "error");
        return;
      }

      try {
        await ctx.waitForIdle();
        const records = await listWorktrees(pi, ctx.cwd, ctx.signal);
        const currentPath = await currentWorktreePath(pi, ctx.cwd, ctx.signal);
        const root = settings.get();
        const warning = root.warning ? " — settings warning" : "";
        const owner = getMenuOwner();
        if (owner.signal.aborted || !owner.isCurrent()) return;
        const runFlow = async (flow: () => Promise<void>) => {
          try {
            await flow();
          } catch (error) {
            safeNotify(ctx, formatError(error), "error");
          }
          return { kind: "close" } as const;
        };
        type Screen = "main";
        type Action = keyof typeof ACTIONS;
        const menu = defineMenu<undefined, Screen, Action, ExtensionCommandContext>({
          start: "main",
          screens: {
            main: () => ({
              kind: "actions",
              title: "Git worktrees",
              lines: [
                `Registered: ${records.length}`,
                `Current: ${currentPath}`,
                `Worktree root: ${root.effectiveRoot} (${root.source})${warning}`,
              ],
              items: Object.entries(ACTIONS).map(([id, label]) => ({
                id,
                label,
                action: id as Action,
              })),
              hint: "close",
            }),
          },
          actions: {
            add: async () => runFlow(() => addFlow(pi, ctx, records, root.effectiveRoot)),
            switch: async ({ signal }) => runFlow(() => switchFlow(pi, ctx, records, currentPath, signal)),
            remove: async ({ signal }) => runFlow(() => removeFlow(pi, ctx, records, currentPath, signal)),
            prune: async () => runFlow(() => pruneFlow(pi, ctx, records)),
            configure: async () => runFlow(() => configureRootFlow(ctx, settings)),
          },
        });
        await runMenu(ctx, menu, {
          getState: () => undefined,
          signal: owner.signal,
          isCurrent: owner.isCurrent,
        });
      } catch (error) {
        safeNotify(ctx, formatError(error), "error");
      }
    },
  });
}

async function configureRootFlow(ctx: ExtensionCommandContext, settings: WorktreeSettingsRuntime): Promise<void> {
  const current = await settings.reload();
  if (!current.canSave) {
    throw new Error(current.warning ?? `Fix ${settings.getPath()} before changing pi-worktree settings.`);
  }
  const requested = await ctx.ui.input(
    "Worktree root (blank restores ~/.worktrees)",
    stripTerminalControls(current.configuredRoot ?? current.effectiveRoot),
  );
  if (requested === undefined) return;
  const configuredRoot = requested.trim() || undefined;
  const updated = await settings.save(configuredRoot);
  safeNotify(
    ctx,
    configuredRoot === undefined
      ? `Worktree root reset to ${updated.effectiveRoot}.`
      : `Worktree root saved as ${updated.effectiveRoot}.`,
    "info",
  );
}

async function addFlow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  records: readonly WorktreeRecord[],
  worktreeRoot: string,
): Promise<void> {
  const main = records[0];
  if (!main) throw new Error("Git returned no registered worktrees.");
  if (main.bare) {
    throw new Error("The main worktree is bare; pi-worktree cannot derive a safe default path.");
  }
  if (!existsSync(main.path)) {
    throw new Error(`The registered main worktree path is stale: ${main.path}. Repair it with Git first.`);
  }

  const requestedBranch = await ctx.ui.input("Branch for the new worktree", "feat/my-change");
  if (requestedBranch === undefined) return;
  const branchInput = requestedBranch.trim();
  if (!branchInput) throw new Error("Branch name is required.");
  const branch = await validateBranch(pi, ctx.cwd, branchInput, ctx.signal);
  const branchExists = await localBranchExists(pi, ctx.cwd, branch, ctx.signal);
  const occupied = worktreeForBranch(records, branch);
  if (occupied) {
    throw new Error(`Branch ${branch} is already checked out at ${occupied.path}.`);
  }

  // Capture the base commit for BOTH cases. The attach case never had one: argv is
  // ["worktree", "add", <path>, <branch>], so Git resolves the branch at exec time and a
  // concurrent `git branch -f` or rebase silently moved the base out from under the user.
  let provenance: AddBaseProvenance;
  if (branchExists) {
    const ref = localBranchRef(branch);
    provenance = {
      kind: "attach",
      label: ref,
      oid: (await resolveCommit(pi, ctx.cwd, ref, ctx.signal)).toLowerCase(),
    };
  } else {
    const defaultStart = await symbolicBranch(pi, ctx.cwd, ctx.signal);
    const requestedStart = await ctx.ui.input(
      stripTerminalControls(
        defaultStart
          ? `Start point for ${branch} (blank uses ${defaultStart})`
          : `Start point for ${branch} (required because HEAD is detached)`,
      ),
      stripTerminalControls(defaultStart ?? "commit-ish"),
    );
    if (requestedStart === undefined) return;
    const startLabel = requestedStart.trim() || defaultStart;
    if (!startLabel) throw new Error("An explicit start point is required from detached HEAD.");
    provenance = {
      kind: "create",
      label: startLabel,
      oid: (await resolveCommit(pi, ctx.cwd, startLabel, ctx.signal)).toLowerCase(),
    };
  }

  const suggestedPath = defaultWorktreePath(main.path, branch, worktreeRoot);
  const requestedPath = await ctx.ui.input(
    stripTerminalControls(`Worktree path (blank uses ${suggestedPath})`),
    stripTerminalControls(suggestedPath),
  );
  if (requestedPath === undefined) return;
  const targetPath = pathIdentity(requestedPath.trim() ? resolve(ctx.cwd, requestedPath.trim()) : suggestedPath);
  assertTargetFilesystemAvailable(targetPath);
  const pathCollision = records.find((record) => pathsEqual(record.path, targetPath));
  if (pathCollision) {
    throw new Error(`The target path is already registered as a worktree: ${pathCollision.path}.`);
  }

  // Sanitize each line, then join: stripTerminalControls maps a newline to a space, so stripping
  // the joined string would collapse the preview back onto one line.
  const summary = [
    provenance.kind === "attach" ? `Attach existing branch ${branch}.` : `Create branch ${branch}.`,
    `Branch:      ${branch}`,
    `Base:        ${provenance.label}`,
    `Base commit: ${provenance.oid}`,
    `Path:        ${targetPath}`,
  ]
    .map((line) => stripTerminalControls(line))
    .join("\n");
  if (!(await ctx.ui.confirm("Create Git worktree", summary))) return;

  // Re-check under the mutation lock, mirroring pruneFlow: `records` was captured when the menu
  // opened, so every pre-confirmation check above is stale by the whole menu lifetime. The lock
  // cannot stop an external `git branch -f` — that is what the base-OID check is for — but it does
  // shrink the window against this package's own flows, and it never spans a dialog.
  const created = await withWorktreeMutationLock(
    ctx.cwd,
    async () => {
      assertTargetFilesystemAvailable(targetPath);

      const latest = await listWorktrees(pi, ctx.cwd, ctx.signal);
      const occupiedNow = worktreeForBranch(latest, branch);
      if (occupiedNow) {
        throw new Error(`Branch ${branch} was checked out at ${occupiedNow.path} after confirmation; add was refused.`);
      }
      const collisionNow = latest.find((record) => pathsEqual(record.path, targetPath));
      if (collisionNow) {
        throw new Error(`The target path became a registered worktree after confirmation: ${collisionNow.path}.`);
      }

      const existsNow = await localBranchExists(pi, ctx.cwd, branch, ctx.signal);
      if (existsNow !== branchExists) {
        throw new Error(
          existsNow
            ? `Branch ${branch} was created by another process after confirmation; add was refused.`
            : `Branch ${branch} was deleted after confirmation; add was refused.`,
        );
      }

      const currentOid = (
        await resolveCommit(
          pi,
          ctx.cwd,
          provenance.kind === "attach" ? localBranchRef(branch) : provenance.label,
          ctx.signal,
        )
      ).toLowerCase();
      if (!sameOid(currentOid, provenance.oid)) {
        throw new Error(
          `${provenance.label} moved from ${provenance.oid} to ${currentOid} after confirmation; add was refused. Run Add again to approve the new base.`,
        );
      }

      await addWorktree(
        pi,
        ctx.cwd,
        {
          path: targetPath,
          branch,
          startOid: provenance.kind === "create" ? provenance.oid : undefined,
        },
        ctx.signal,
      );

      try {
        const updated = await listWorktrees(pi, ctx.cwd, ctx.signal);
        const verified = updated.find((record) => pathsEqual(record.path, targetPath));
        // branchRef is stricter than branch: a deleted branch shadowed by a same-named tag produces
        // a detached record whose branchRef is undefined.
        if (
          !verified ||
          verified.branchRef !== localBranchRef(branch) ||
          !verified.head ||
          !sameOid(verified.head, provenance.oid)
        ) {
          throw new Error("the expected path, branch, and base commit were not present in Git porcelain output");
        }
        return verified;
      } catch (error) {
        throw new Error(
          `Git add completed, so the worktree was retained at ${targetPath}, but verification failed: ${formatError(error)}. Inspect git worktree list before retrying.`,
        );
      }
    },
    ctx.signal,
  );
  safeNotify(ctx, `Created worktree ${targetPath} on branch ${branch} at ${provenance.oid}.`, "info");

  if (
    await ctx.ui.confirm("Switch Pi workspace?", stripTerminalControls(`Continue this conversation in ${targetPath}?`))
  ) {
    const latest = await revalidateWorktreeIdentity(pi, ctx, created);
    if (latest.prunableReason !== undefined || !existsSync(latest.path)) {
      throw new Error("The newly created worktree became unavailable; select it again.");
    }
    await switchToWorktree(ctx, latest.path);
  }
}

function sameOid(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function assertTargetFilesystemAvailable(targetPath: string): void {
  if (pathEntryExists(targetPath)) {
    throw new Error(`The target path already exists: ${targetPath}.`);
  }
  const unsafeAncestor = unresolvableSymlinkAncestor(targetPath);
  if (unsafeAncestor) {
    throw new Error(`The target path has an unresolvable symbolic-link ancestor: ${unsafeAncestor}.`);
  }
}

async function switchFlow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  records: readonly WorktreeRecord[],
  currentPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const candidates = records.filter(
    (record) =>
      !record.bare &&
      record.prunableReason === undefined &&
      existsSync(record.path) &&
      !pathsEqual(record.path, currentPath),
  );
  const selected = await selectWorktree(ctx, "Switch to worktree", candidates, currentPath, signal);
  if (!selected) return;
  const latest = await revalidateWorktreeIdentity(pi, ctx, selected);
  if (
    latest.bare ||
    latest.prunableReason !== undefined ||
    !existsSync(latest.path) ||
    pathsEqual(latest.path, currentPath)
  ) {
    throw new Error("The selected worktree changed state; select it again.");
  }
  await switchToWorktree(ctx, latest.path);
}

async function removeFlow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  records: readonly WorktreeRecord[],
  currentPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const candidates = records.filter(
    (record) => !record.isMain && !record.bare && !pathsEqual(record.path, currentPath),
  );
  const selected = await selectWorktree(ctx, "Remove linked worktree", candidates, currentPath, signal);
  if (!selected) return;
  if (selected.lockedReason !== undefined) {
    throw new Error(
      `Worktree is locked${selected.lockedReason ? `: ${selected.lockedReason}` : "."} Unlock it explicitly with Git before removal.`,
    );
  }
  if (selected.prunableReason !== undefined || !existsSync(selected.path)) {
    throw new Error("The selected worktree path is stale. Use prune instead of remove.");
  }

  const selectedFilesystemIdentity = removableFilesystemIdentity(selected.path);
  const inventory = classifyRemovalInventory(await worktreeInventory(pi, selected.path, ctx.signal));
  if (inventory.protected.length > 0) {
    throw new Error(
      `Removal refused because ${selected.path} contains tracked, untracked, index-flagged, or submodule data:\n${inventory.protected.join("\n")}`,
    );
  }
  if (inventory.ignored.length > 0) {
    throw new Error(
      `Removal refused because ${selected.path} contains ignored local data that would be deleted:\n${inventory.ignored.join("\n")}\nRemove it manually before removing the worktree.`,
    );
  }
  await assertDetachedHeadIsDurable(pi, ctx, selected);
  const administrativePath = await worktreeAdministrativeDirectory(pi, selected.path, ctx.signal);
  const approvedHistoryRisks = historyRisks(
    selected.path,
    await unreachableAdministrativeHistoryOids(pi, ctx, administrativePath),
  );
  const recoveryWarning = formatAdministrativeRecoveryWarning(approvedHistoryRisks);
  const removalWarning = recoveryWarning;
  const confirmationTitle = recoveryWarning ? "Remove worktree and discard recovery history" : "Remove Git worktree";
  if (
    !(await ctx.ui.confirm(
      confirmationTitle,
      `Delete the worktree directory ${stripTerminalControls(selected.path)}? The branch will be preserved.${removalWarning}`,
    ))
  ) {
    return;
  }

  await assertAdministrativeHistoryUnchanged(pi, ctx, selected.path, administrativePath, approvedHistoryRisks);

  const beforeRemoval = await listWorktrees(pi, ctx.cwd, ctx.signal);
  const latest = beforeRemoval.find((record) => pathsEqual(record.path, selected.path));
  if (!latest) throw new Error(`Worktree ${selected.path} is no longer registered.`);
  if (!sameWorktreeIdentity(selected, latest)) {
    throw new Error(`Worktree ${selected.path} changed identity; select it again.`);
  }
  if (latest.isMain || latest.lockedReason !== undefined || latest.prunableReason !== undefined) {
    throw new Error(`Worktree ${selected.path} changed state after confirmation; removal was refused.`);
  }
  if (removableFilesystemIdentity(latest.path) !== selectedFilesystemIdentity) {
    throw new Error(`Worktree ${selected.path} changed filesystem identity; select it again.`);
  }
  const latestInventory = classifyRemovalInventory(await worktreeInventory(pi, latest.path, ctx.signal));
  if (latestInventory.protected.length > 0) {
    throw new Error(
      `Removal refused because new protected local data appeared after confirmation:\n${latestInventory.protected.join("\n")}`,
    );
  }
  if (!sameInventory(inventory.ignored, latestInventory.ignored)) {
    throw new Error(
      `Removal refused because ignored data changed after confirmation:\n${latestInventory.ignored.join("\n") || "(none)"}`,
    );
  }
  await assertDetachedHeadIsDurable(pi, ctx, latest);
  await assertAdministrativeHistoryUnchanged(pi, ctx, latest.path, administrativePath, approvedHistoryRisks);
  const finalInventory = classifyRemovalInventory(await worktreeInventory(pi, latest.path, ctx.signal));
  if (finalInventory.protected.length > 0) {
    throw new Error(
      `Removal refused because new protected local data appeared before deletion:\n${finalInventory.protected.join("\n")}`,
    );
  }
  if (!sameInventory(inventory.ignored, finalInventory.ignored)) {
    throw new Error(
      `Removal refused because ignored data changed before deletion:\n${finalInventory.ignored.join("\n") || "(none)"}`,
    );
  }
  if (removableFilesystemIdentity(latest.path) !== selectedFilesystemIdentity) {
    throw new Error(`Worktree ${selected.path} changed filesystem identity before deletion.`);
  }
  await removeWorktreeSafely(
    pi,
    ctx.cwd,
    latest.path,
    ctx.signal,
    async (quarantinePath) => {
      const quarantineInventory = classifyRemovalInventory(await worktreeInventory(pi, quarantinePath, ctx.signal));
      if (quarantineInventory.protected.length > 0) {
        throw new Error(
          `Removal refused because protected local data appeared after quarantine:\n${quarantineInventory.protected.join("\\n")}`,
        );
      }
      if (quarantineInventory.ignored.length > 0) {
        throw new Error(
          `Removal refused because ignored local data appeared after quarantine:\n${quarantineInventory.ignored.join("\\n")}`,
        );
      }
    },
    undefined,
    async () => {
      const locked = (await listWorktrees(pi, ctx.cwd, ctx.signal)).find((record) =>
        pathsEqual(record.path, latest.path),
      );
      if (
        !locked ||
        !sameWorktreeIdentity(latest, locked) ||
        locked.isMain ||
        locked.lockedReason !== undefined ||
        locked.prunableReason !== undefined
      ) {
        throw new Error(`Worktree ${selected.path} changed identity while waiting for removal; removal was refused.`);
      }
      if (removableFilesystemIdentity(locked.path) !== selectedFilesystemIdentity) {
        throw new Error(`Worktree ${selected.path} changed filesystem identity while waiting for removal.`);
      }
      await assertDetachedHeadIsDurable(pi, ctx, locked);
      await assertAdministrativeHistoryUnchanged(pi, ctx, locked.path, administrativePath, approvedHistoryRisks);
    },
  );
  const updated = await listWorktrees(pi, ctx.cwd, ctx.signal);
  if (updated.some((record) => pathsEqual(record.path, selected.path))) {
    throw new Error(`Git remove returned success, but ${selected.path} is still registered.`);
  }
  safeNotify(ctx, `Removed worktree ${selected.path}. Its branch was preserved.`, "info");
}

async function pruneFlow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  records: readonly WorktreeRecord[],
): Promise<void> {
  for (const record of records.filter((candidate) => candidate.prunableReason !== undefined && candidate.detached)) {
    await assertDetachedHeadIsDurable(pi, ctx, record);
  }
  const approvedAdministrativeCandidates = await administrativePruneCandidates(pi, ctx.cwd, ctx.signal);
  const approvedHistoryRisks = await inspectAdministrativePruneCandidates(pi, ctx, approvedAdministrativeCandidates);
  const preview = await prunePreview(pi, ctx.cwd, ctx.signal);
  if (!preview) {
    ctx.ui.notify("Git found no stale worktree metadata to prune.", "info");
    return;
  }
  const safePreview = stripTerminalControls(preview);
  const recoveryWarning = formatAdministrativeRecoveryWarning(approvedHistoryRisks);
  const administrativeSummary = formatAdministrativeCandidateSummary(approvedAdministrativeCandidates);
  ctx.ui.notify(`git worktree prune --dry-run --verbose\n${safePreview}${administrativeSummary}`, "warning");
  if (
    !(await ctx.ui.confirm(
      recoveryWarning ? "Prune metadata and discard recovery history" : "Prune stale worktree metadata",
      stripTerminalControls(`${safePreview}${administrativeSummary}${recoveryWarning}`),
    ))
  ) {
    return;
  }
  const output = await withWorktreeMutationLock(
    ctx.cwd,
    async () => {
      const latest = await listWorktrees(pi, ctx.cwd, ctx.signal);
      for (const record of latest.filter((candidate) => candidate.prunableReason !== undefined && candidate.detached)) {
        await assertDetachedHeadIsDurable(pi, ctx, record);
      }
      const beforePreviewHistoryRisks = await inspectAdministrativePruneCandidates(pi, ctx);
      if (!sameAdministrativeHistoryRisks(approvedHistoryRisks, beforePreviewHistoryRisks)) {
        throw new Error("Stale worktree metadata changed after confirmation; run prune again.");
      }
      const latestPreview = await prunePreview(pi, ctx.cwd, ctx.signal);
      const finalHistoryRisks = await inspectAdministrativePruneCandidates(pi, ctx);
      if (latestPreview !== preview || !sameAdministrativeHistoryRisks(approvedHistoryRisks, finalHistoryRisks)) {
        throw new Error("Stale worktree metadata changed after confirmation; run prune again.");
      }
      const approvedWorktreePaths = latest
        .filter((record) => record.prunableReason !== undefined)
        .map((record) => record.path);
      const approvedAdministrativePaths = approvedAdministrativeCandidates.map(
        (candidate) => candidate.administrativePath,
      );
      const output = await pruneWorktrees(pi, ctx.cwd, ctx.signal, true, approvedAdministrativeCandidates);
      const remaining = await listWorktrees(pi, ctx.cwd, ctx.signal);
      if (
        remaining.some((record) => approvedWorktreePaths.some((approvedPath) => pathsEqual(approvedPath, record.path)))
      ) {
        throw new Error("Git did not remove every approved stale worktree record; no success was reported.");
      }
      if (remaining.some((record) => record.prunableReason !== undefined)) {
        throw new Error("Git left stale worktree metadata after pruning; no success was reported.");
      }
      if (approvedAdministrativePaths.some((path) => existsSync(path))) {
        throw new Error("Git did not remove every approved administrative record; no success was reported.");
      }
      if ((await administrativePruneCandidates(pi, ctx.cwd, ctx.signal)).length > 0) {
        throw new Error("Git left stale administrative records after pruning; no success was reported.");
      }
      return output;
    },
    ctx.signal,
  );
  safeNotify(ctx, output ? `Pruned stale worktree metadata:\n${output}` : "Pruned stale worktree metadata.", "info");
}

async function assertAdministrativeHistoryUnchanged(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  selectedPath: string,
  approvedAdministrativePath: string,
  approvedHistoryRisks: readonly AdministrativeHistoryRisk[],
): Promise<void> {
  const latestAdministrativePath = await worktreeAdministrativeDirectory(pi, selectedPath, ctx.signal);
  const latestHistoryRisks = historyRisks(
    selectedPath,
    await unreachableAdministrativeHistoryOids(pi, ctx, latestAdministrativePath),
  );
  if (
    !pathsEqual(approvedAdministrativePath, latestAdministrativePath) ||
    !sameAdministrativeHistoryRisks(approvedHistoryRisks, latestHistoryRisks)
  ) {
    throw new Error(
      `Worktree ${selectedPath} administrative recovery history changed after confirmation; select it again.`,
    );
  }
}

async function inspectAdministrativePruneCandidates(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  candidates?: readonly AdministrativePruneCandidate[],
): Promise<AdministrativeHistoryRisk[]> {
  const risks: AdministrativeHistoryRisk[] = [];
  for (const candidate of candidates ?? (await administrativePruneCandidates(pi, ctx.cwd, ctx.signal))) {
    if (candidate.indexDirty) {
      throw new Error(
        `Prune refused because administrative worktree ${candidate.id} contains staged-only index changes.`,
      );
    }
    if (candidate.head) {
      const refs = await durableRefsContaining(pi, ctx.cwd, candidate.head, ctx.signal);
      if (refs.length === 0) {
        throw new Error(
          `Prune refused because administrative worktree ${candidate.id} has detached HEAD ${candidate.head}, which is not reachable from a durable ref.`,
        );
      }
    } else if (!candidate.branchRef || !(await durableRefExists(pi, ctx.cwd, candidate.branchRef, ctx.signal))) {
      throw new Error(
        `Prune refused because administrative worktree ${candidate.id} does not resolve to a durable ref.`,
      );
    }
    risks.push(
      ...historyRisks(candidate.id, await unreachableAdministrativeHistoryOids(pi, ctx, candidate.administrativePath)),
    );
  }
  return normalizeAdministrativeHistoryRisks(risks);
}

async function unreachableAdministrativeHistoryOids(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  administrativePath: string,
): Promise<string[]> {
  const unreachable: string[] = [];
  for (const oid of await administrativeHistoryOids(pi, ctx.cwd, administrativePath, ctx.signal)) {
    const refs = await durableRefsContaining(pi, ctx.cwd, oid, ctx.signal);
    if (refs.length === 0) unreachable.push(oid);
  }
  return [...new Set(unreachable)].sort();
}

function historyRisks(label: string, oids: string[]): AdministrativeHistoryRisk[] {
  return oids.length > 0 ? [{ label, oids }] : [];
}

function normalizeAdministrativeHistoryRisks(risks: readonly AdministrativeHistoryRisk[]): AdministrativeHistoryRisk[] {
  return risks
    .map((risk) => ({ label: risk.label, oids: [...new Set(risk.oids)].sort() }))
    .filter((risk) => risk.oids.length > 0)
    .sort((left, right) => left.label.localeCompare(right.label));
}

function sameAdministrativeHistoryRisks(
  left: readonly AdministrativeHistoryRisk[],
  right: readonly AdministrativeHistoryRisk[],
): boolean {
  return (
    JSON.stringify(normalizeAdministrativeHistoryRisks(left)) ===
    JSON.stringify(normalizeAdministrativeHistoryRisks(right))
  );
}

function formatAdministrativeRecoveryWarning(risks: readonly AdministrativeHistoryRisk[]): string {
  if (risks.length === 0) return "";
  const entries = risks
    .map((risk) => `${stripTerminalControls(risk.label)}: ${risk.oids.map(stripTerminalControls).join(", ")}`)
    .join("; ");
  return ` Administrative recovery warning: these commits are not reachable from a branch, tag, or remote ref: ${entries}. Discarding their recovery pointers means they may later be garbage-collected.`;
}
function formatAdministrativeCandidateSummary(candidates: readonly AdministrativePruneCandidate[]): string {
  if (candidates.length === 0) return "";
  const ids = candidates.map((candidate) => stripTerminalControls(candidate.id)).join(", ");
  return ` Administrative metadata records selected for deletion: ${ids}.`;
}

interface RemovalInventory {
  ignored: string[];
  protected: string[];
}

function classifyRemovalInventory(lines: readonly string[]): RemovalInventory {
  const ignored: string[] = [];
  const protectedData: string[] = [];
  for (const line of lines) {
    (line.startsWith("!! ") ? ignored : protectedData).push(line);
  }
  return {
    ignored: normalizeInventory(ignored),
    protected: normalizeInventory(protectedData),
  };
}

function removableFilesystemIdentity(path: string): string {
  const identities: string[] = [];
  const original = resolve(path);
  let current = original;
  while (true) {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch (error) {
      throw new Error(`Cannot inspect worktree path ${current}: ${formatError(error)}`);
    }
    if (current === original && stat.isSymbolicLink()) {
      throw new Error(`Refusing to remove worktree through symbolic-link path ${current}.`);
    }
    if (current === original && !stat.isDirectory()) {
      throw new Error(`The selected worktree path is not a directory: ${current}.`);
    }
    identities.push(`${current}:${stat.dev}:${stat.ino}:${stat.mode}`);
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return identities.join("|");
}
function normalizeInventory(lines: readonly string[]): string[] {
  return [...new Set(lines)].sort();
}

function sameInventory(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(normalizeInventory(left)) === JSON.stringify(normalizeInventory(right));
}

async function assertDetachedHeadIsDurable(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  record: WorktreeRecord,
): Promise<void> {
  if (!record.detached) return;
  if (!record.head) throw new Error(`Detached worktree ${record.path} has no HEAD object; refusing.`);
  const refs = await durableRefsContaining(pi, ctx.cwd, record.head, ctx.signal);
  if (refs.length === 0) {
    throw new Error(
      `Detached HEAD ${record.head} at ${record.path} is not reachable from a local branch, tag, or remote ref. Preserve it before continuing.`,
    );
  }
}

async function revalidateWorktreeIdentity(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  selected: WorktreeRecord,
): Promise<WorktreeRecord> {
  const latest = (await listWorktrees(pi, ctx.cwd, ctx.signal)).find((record) =>
    pathsEqual(record.path, selected.path),
  );
  if (!latest) throw new Error(`Worktree ${selected.path} is no longer registered.`);
  if (!sameWorktreeIdentity(selected, latest)) {
    throw new Error(`Worktree ${selected.path} changed identity; select it again.`);
  }
  return latest;
}

async function selectWorktree(
  ctx: ExtensionCommandContext,
  title: string,
  records: readonly WorktreeRecord[],
  currentPath: string,
  signal?: AbortSignal,
): Promise<WorktreeRecord | undefined> {
  if (records.length === 0) {
    ctx.ui.notify("No eligible worktrees are available for this action.", "info");
    return undefined;
  }
  if (signal?.aborted || ctx.signal?.aborted) return undefined;
  let selected: WorktreeRecord | undefined;
  const menu = defineMenu<undefined, "worktrees", "choose", ExtensionCommandContext>({
    start: "worktrees",
    screens: {
      worktrees: () => ({
        kind: "choice",
        title,
        items: records.map((record, index) => ({
          id: record.path,
          label: `${index + 1}. ${formatWorktree(record, currentPath)}`,
        })),
        action: "choose",
        hint: "close",
      }),
    },
    actions: {
      choose: async ({ itemId }) => {
        selected = records.find((record) => record.path === itemId);
        return selected ? { kind: "close" } : { kind: "rejected" };
      },
    },
  });
  await runMenu(ctx, menu, {
    getState: () => undefined,
    signal,
    isCurrent: () => !signal?.aborted,
  });
  return selected;
}

function safeNotify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(stripTerminalControls(message), level);
  } catch {
    console.error(message);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
