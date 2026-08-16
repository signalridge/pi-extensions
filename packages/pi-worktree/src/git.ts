import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { lstat, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

const GIT_TIMEOUT_MS = 15_000;
const GIT_MUTATION_TIMEOUT_MS = 60_000;
const MUTATION_LOCK_WAIT_MS = 50;
const MUTATION_LOCK_TIMEOUT_MS = 120_000;
const MUTATION_LOCK_STALE_MS = 30_000;
const LOCAL_BRANCH_PREFIX = "refs/heads/";
const metadataPruneLocks = new Map<string, Promise<void>>();

export interface WorktreeRecord {
  path: string;
  head?: string;
  branchRef?: string;
  branch?: string;
  isMain: boolean;
  bare: boolean;
  detached: boolean;
  lockedReason?: string;
  prunableReason?: string;
}

export interface AddArguments {
  path: string;
  branch: string;
  startOid?: string;
}

export interface AdministrativePruneCandidate {
  id: string;
  administrativePath: string;
  head?: string;
  branchRef?: string;
  indexDirty: boolean;
}
interface MetadataIdentity {
  kind: "directory" | "leaf";
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  children?: Map<string, MetadataIdentity>;
}

const administrativeIdentities = new WeakMap<AdministrativePruneCandidate, MetadataIdentity>();

export interface GitClient {
  exec(command: string, args: string[], options?: GitExecOptions): Promise<ExecResult>;
}

interface GitExecOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeout?: number;
}

export class GitWorktreeError extends Error {
  readonly args?: readonly string[];

  constructor(message: string, args?: readonly string[]) {
    super(message);
    this.name = "GitWorktreeError";
    this.args = args;
  }
}
class MetadataDeletionRetainedError extends Error {
  readonly retainedPath: string;
  readonly outcomeUnknown: boolean;

  constructor(retainedPath: string, message: string, outcomeUnknown = false) {
    super(message);
    this.name = "MetadataDeletionRetainedError";
    this.retainedPath = retainedPath;
    this.outcomeUnknown = outcomeUnknown;
  }
}

export function parseWorktreePorcelain(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: Omit<WorktreeRecord, "isMain"> | undefined;

  const finish = () => {
    if (!current) return;
    records.push({ ...current, isMain: records.length === 0 });
    current = undefined;
  };

  for (const field of output.split("\0")) {
    if (field === "") {
      finish();
      continue;
    }
    const separator = field.indexOf(" ");
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? "" : field.slice(separator + 1);

    if (key === "worktree") {
      finish();
      if (!value) throw new GitWorktreeError("Worktree porcelain record is missing path.");
      current = { path: value, bare: false, detached: false };
      continue;
    }
    if (!current) {
      throw new GitWorktreeError(`Worktree porcelain field ${JSON.stringify(key)} appears before worktree.`);
    }

    switch (key) {
      case "HEAD":
        current.head = value;
        break;
      case "branch":
        current.branchRef = value;
        current.branch = value.startsWith(LOCAL_BRANCH_PREFIX) ? value.slice(LOCAL_BRANCH_PREFIX.length) : undefined;
        break;
      case "bare":
        current.bare = true;
        break;
      case "detached":
        current.detached = true;
        break;
      case "locked":
        current.lockedReason = value;
        break;
      case "prunable":
        current.prunableReason = value;
        break;
    }
  }
  finish();
  return records;
}

/**
 * Fully qualify a local branch. Provenance must be resolved through this ref rather than the bare
 * name: `git rev-parse` prefers `refs/tags/<name>`, so a same-named tag would otherwise yield the
 * OID of an object `git worktree add <path> <branch>` will not check out.
 */
export function localBranchRef(branch: string): string {
  return `${LOCAL_BRANCH_PREFIX}${branch}`;
}

export function worktreeForBranch(records: readonly WorktreeRecord[], branch: string): WorktreeRecord | undefined {
  const branchRef = localBranchRef(branch);
  return records.find((record) => record.branchRef === branchRef);
}

export function defaultWorktreePath(mainWorktreePath: string, branch: string, worktreeRoot: string): string {
  return resolve(worktreeRoot, basename(mainWorktreePath), branch.replaceAll("/", "-"));
}

export function buildAddArguments(input: AddArguments): string[] {
  return input.startOid
    ? ["worktree", "add", "-b", input.branch, input.path, input.startOid]
    : ["worktree", "add", input.path, input.branch];
}

export function pathIdentity(path: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return absolute;
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw new GitWorktreeError(`Cannot inspect filesystem path ${path}: ${formatError(error)}`);
  }
}

export function unresolvableSymlinkAncestor(path: string): string | undefined {
  let current = dirname(resolve(path));
  while (true) {
    try {
      const stat = lstatSync(current);
      if (!stat.isSymbolicLink()) return undefined;
      try {
        realpathSync.native(current);
        return undefined;
      } catch (error) {
        if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ELOOP")) {
          return current;
        }
        throw new GitWorktreeError(`Cannot resolve filesystem ancestor ${current}: ${formatError(error)}`);
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        if (error instanceof GitWorktreeError) throw error;
        throw new GitWorktreeError(`Cannot inspect filesystem ancestor ${current}: ${formatError(error)}`);
      }
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

export function pathsEqual(left: string, right: string): boolean {
  return pathIdentity(left) === pathIdentity(right);
}

export function sameWorktreeIdentity(left: WorktreeRecord, right: WorktreeRecord): boolean {
  return (
    pathsEqual(left.path, right.path) &&
    left.head === right.head &&
    left.branchRef === right.branchRef &&
    left.detached === right.detached &&
    left.isMain === right.isMain &&
    left.bare === right.bare
  );
}

export async function listWorktrees(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  signal?: AbortSignal,
): Promise<WorktreeRecord[]> {
  const result = await runGit(pi, ["worktree", "list", "--porcelain", "-z"], cwd, signal);
  return parseWorktreePorcelain(result.stdout);
}

export async function currentWorktreePath(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runGit(pi, ["rev-parse", "--show-toplevel"], cwd, signal);
  const path = removeLineEnding(result.stdout);
  if (!path) throw new GitWorktreeError("Git did not return the current worktree path.");
  return pathIdentity(path);
}

export async function symbolicBranch(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await runGitAllowFailure(pi, ["symbolic-ref", "--quiet", "--short", "HEAD"], cwd, signal);
  if (result.killed) throw killedError(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (result.code !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

export async function validateBranch(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runGit(pi, ["check-ref-format", "--branch", branch], cwd, signal);
  const normalized = result.stdout.trim();
  if (!normalized) throw new GitWorktreeError("Git returned an empty branch name.");
  return normalized;
}

export async function localBranchExists(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  branch: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await runGitAllowFailure(pi, ["show-ref", "--verify", "--quiet", localBranchRef(branch)], cwd, signal);
  if (result.killed) throw killedError(["show-ref", "--verify", "--quiet"]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw gitFailure(["show-ref", "--verify", "--quiet"], result);
}

export async function resolveCommit(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  startPoint: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runGit(pi, ["rev-parse", "--verify", "--end-of-options", `${startPoint}^{commit}`], cwd, signal);
  const oid = result.stdout.trim();
  if (!/^[0-9a-fA-F]{40,64}$/u.test(oid)) {
    throw new GitWorktreeError(`Git returned an invalid commit object for ${startPoint}.`);
  }
  return oid;
}

export async function addWorktree(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  input: AddArguments,
  signal?: AbortSignal,
): Promise<void> {
  await runGit(pi, buildAddArguments(input), cwd, signal, GIT_MUTATION_TIMEOUT_MS);
}

export async function moveWorktree(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  path: string,
  newPath: string,
  signal?: AbortSignal,
): Promise<void> {
  await runGit(pi, ["worktree", "move", path, newPath], cwd, signal, GIT_MUTATION_TIMEOUT_MS);
}

export async function removeWorktree(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  await runGit(pi, ["worktree", "remove", path], cwd, signal, GIT_MUTATION_TIMEOUT_MS);
}

async function waitForMutationLock(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new GitWorktreeError("worktree mutation lock wait aborted.");
  await new Promise<void>((resolveLock, reject) => {
    let onAbort!: () => void;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolveLock();
    }, MUTATION_LOCK_WAIT_MS);
    onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new GitWorktreeError("worktree mutation lock wait aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function acquireFilesystemMutationLock(key: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  if (!existsSync(key)) return async () => {};
  const lockTarget = join(key, ".pi-worktree-mutation");
  const deadline = Date.now() + MUTATION_LOCK_TIMEOUT_MS;

  while (true) {
    if (signal?.aborted) throw new GitWorktreeError("worktree mutation lock wait aborted.");
    try {
      const releaseLock = await lockfile.lock(lockTarget, {
        realpath: false,
        retries: 0,
        stale: MUTATION_LOCK_STALE_MS,
        update: Math.floor(MUTATION_LOCK_STALE_MS / 3),
      });
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          await releaseLock();
        } catch (error: unknown) {
          throw new GitWorktreeError(`Cannot release worktree mutation lock: ${formatError(error)}`);
        }
      };
    } catch (error: unknown) {
      if (!isNodeError(error) || (error.code !== "ELOCKED" && error.code !== "EEXIST")) {
        throw new GitWorktreeError(`Cannot acquire worktree mutation lock: ${formatError(error)}`);
      }
      if (Date.now() >= deadline) {
        throw new GitWorktreeError(`Timed out waiting for worktree mutation lock ${lockTarget}.`);
      }
      await waitForMutationLock(signal);
    }
  }
}

async function withMetadataPruneLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = metadataPruneLocks.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  metadataPruneLocks.set(key, current);
  if (previous) await previous;
  try {
    return await operation();
  } finally {
    release();
    if (metadataPruneLocks.get(key) === current) metadataPruneLocks.delete(key);
  }
}

export function withWorktreeMutationLock<T>(
  cwd: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const key = worktreeMutationLockKey(cwd);
  return withMetadataPruneLock(key, async () => {
    const release = await acquireFilesystemMutationLock(key, signal);
    try {
      return await operation();
    } finally {
      await release();
    }
  });
}

function commonDirectoryForGitdir(gitdir: string): string {
  try {
    const value = removeLineEnding(readFileSync(join(gitdir, "commondir"), "utf8"));
    return value ? realpathSync(resolve(gitdir, value)) : realpathSync(gitdir);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return realpathSync(gitdir);
    throw error;
  }
}

function worktreeMutationLockKey(cwd: string): string {
  let current = resolve(cwd);
  while (true) {
    const gitEntry = join(current, ".git");
    try {
      const entry = lstatSync(gitEntry);
      if (entry.isDirectory()) return commonDirectoryForGitdir(gitEntry);
      if (entry.isFile() && !entry.isSymbolicLink()) {
        const gitdir = /^gitdir:\s*(.+)$/mu.exec(readFileSync(gitEntry, "utf8"))?.[1]?.trim();
        if (gitdir) return commonDirectoryForGitdir(realpathSync(resolve(current, gitdir)));
      }
    } catch {
      // Keep walking; Git may be invoked from a nested repository directory.
    }
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

function prunePreviewEntries(stdout: string): string[] {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("Removing "));
}

function hasAdministrativeWorktrees(cwd: string): boolean {
  return existsSync(join(worktreeMutationLockKey(cwd), "worktrees"));
}

async function administrativePruneCandidatesIfPresent(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  signal?: AbortSignal,
): Promise<AdministrativePruneCandidate[]> {
  return hasAdministrativeWorktrees(cwd) ? administrativePruneCandidates(pi, cwd, signal) : [];
}

/**
 * Deregister a worktree without asking Git to recursively delete its files.
 *
 * `git worktree remove <path>` is deliberately not used here: even a brief
 * absent-path window lets Git interpret a late-created directory as its delete
 * target. The caller reserves the registered path with a non-directory entry;
 * once the real tree has moved away, Git marks exactly that record prunable.
 * Refuse to prune when Git's complete dry-run preview contains any unrelated
 * stale administrative record, then use Git's metadata-only prune command and
 * verify the target disappeared. Calls in this process are serialized per cwd.
 */
export async function removeWorktreeMetadata(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  path: string,
  signal?: AbortSignal,
  onMetadataRemoved?: () => void,
  lockHeld = false,
): Promise<void> {
  const operation = async (): Promise<void> => {
    const before = await listWorktrees(pi, cwd, signal);
    const target = before.find((record) => pathsEqual(record.path, path));
    if (!target) {
      throw new GitWorktreeError(`Refusing metadata prune because the target record is absent: ${path}.`);
    }
    const stale = before.filter((record) => record.prunableReason);
    if (!target.prunableReason || stale.length !== 1 || stale[0] !== target) {
      throw new GitWorktreeError(`Refusing metadata prune for non-isolated worktree ${path}.`);
    }
    const administrativeBefore = await administrativePruneCandidatesIfPresent(pi, cwd, signal);
    const hasAdministrative = hasAdministrativeWorktrees(cwd);
    const targetAdministrative = administrativeBefore[0];
    if (hasAdministrative && (!targetAdministrative || administrativeBefore.length !== 1)) {
      throw new GitWorktreeError(
        `Refusing metadata prune because Git has ${administrativeBefore.length} stale administrative records.`,
      );
    }
    if (targetAdministrative) {
      const targetPath = administrativeCandidateWorktreePath(targetAdministrative);
      if (!targetPath || !pathsEqual(targetPath, path)) {
        throw new GitWorktreeError(`Refusing metadata prune because the stale administrative record is not ${path}.`);
      }
    }
    const preview = await runGit(
      pi,
      ["worktree", "prune", "--dry-run", "--verbose", "--expire", "now"],
      cwd,
      signal,
      GIT_MUTATION_TIMEOUT_MS,
    );
    const previewEntries = prunePreviewEntries(`${preview.stdout}\n${preview.stderr}`);
    if (
      previewEntries.length !== 1 ||
      (targetAdministrative && !previewEntries[0]?.includes(targetAdministrative.id))
    ) {
      throw new GitWorktreeError(`Refusing metadata prune because the stale-record preview changed.`);
    }
    if (targetAdministrative) {
      await removeAdministrativeRecord(targetAdministrative);
    } else {
      await runGit(pi, ["worktree", "prune", "--expire", "now"], cwd, signal, GIT_MUTATION_TIMEOUT_MS);
    }
    const after = await listWorktrees(pi, cwd, signal);
    if (after.some((record) => pathsEqual(record.path, path))) {
      throw new GitWorktreeError(`Git did not remove worktree metadata for ${path}.`);
    }
    const administrativeAfter = await administrativePruneCandidatesIfPresent(pi, cwd, signal);
    if (administrativeAfter.length !== 0) {
      throw new GitWorktreeError(`Git left stale administrative records after pruning ${path}.`);
    }
    onMetadataRemoved?.();
  };
  if (lockHeld) await operation();
  else await withWorktreeMutationLock(cwd, operation, signal);
}

export async function worktreeInventory(
  pi: Pick<ExtensionAPI, "exec">,
  path: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const statusArgs = [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignored=matching",
    "--ignore-submodules=none",
  ];
  const status = await runGit(pi, statusArgs, path, signal);
  const indexFlags = await runGit(pi, ["ls-files", "-v", "-z"], path, signal);
  const indexInventory = await indexFlagInventory(pi, indexFlags.stdout, path, signal);
  const submoduleStatus = await runGit(pi, ["submodule", "status", "--recursive"], path, signal);
  const initializedSubmodules = nonEmptyLines(submoduleStatus.stdout)
    .filter((line) => !line.startsWith("-"))
    .map((line) => `initialized submodule: ${line.slice(1).trimStart()}`);
  const submodules = await runGit(
    pi,
    [
      "submodule",
      "foreach",
      "--recursive",
      "--quiet",
      "git status --porcelain=v1 --untracked-files=all --ignored=matching --ignore-submodules=none",
    ],
    path,
    signal,
  );
  return [
    ...nonEmptyLines(status.stdout),
    ...indexInventory,
    ...initializedSubmodules,
    ...nonEmptyLines(submodules.stdout),
  ];
}

export async function worktreeAdministrativeDirectory(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runGit(pi, ["rev-parse", "--path-format=absolute", "--git-dir"], cwd, signal);
  const value = removeLineEnding(result.stdout);
  if (!value) throw new GitWorktreeError("Git did not return its worktree administrative path.");
  return resolve(cwd, value);
}

export async function administrativeHistoryOids(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  administrativePath: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const gitDirArgument = `--git-dir=${administrativePath}`;
  const values = readAdministrativeReflogOids(resolve(administrativePath, "logs"));

  const refs = await runGit(
    pi,
    [gitDirArgument, "for-each-ref", "--format=%(objectname)", "refs/worktree", "refs/rewritten", "refs/bisect"],
    cwd,
    signal,
  );
  values.push(...splitAdministrativeOids(refs.stdout, "per-worktree refs"));
  const reflogs = await runGit(pi, [gitDirArgument, "reflog", "--all", "--format=%H"], cwd, signal);
  values.push(...splitAdministrativeOids(reflogs.stdout, "Git reflogs"));

  for (const name of ["ORIG_HEAD", "MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_HEAD"]) {
    const contents = readAdministrativeFile(administrativePath, name);
    if (contents === undefined) continue;
    values.push(...splitAdministrativeOids(contents, name));
  }
  const fetchHead = readAdministrativeFile(administrativePath, "FETCH_HEAD");
  if (fetchHead !== undefined) {
    values.push(...splitFetchHeadOids(fetchHead));
  }
  return [...new Set(values)];
}

export async function administrativePruneCandidates(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  signal?: AbortSignal,
): Promise<AdministrativePruneCandidate[]> {
  const commonResult = await runGit(pi, ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd, signal);
  const commonValue = removeLineEnding(commonResult.stdout);
  if (!commonValue) throw new GitWorktreeError("Git did not return its common directory.");
  const commonDirectory = resolve(cwd, commonValue);
  const administrativeRoot = resolve(commonDirectory, "worktrees");
  if (!existsSync(administrativeRoot)) return [];

  const candidates: AdministrativePruneCandidate[] = [];
  const addCandidate = (candidate: AdministrativePruneCandidate): void => {
    candidates.push(candidate);
    administrativeIdentities.set(candidate, metadataSnapshot(candidate.administrativePath));
  };
  for (const entry of readdirSync(administrativeRoot, {
    withFileTypes: true,
  })) {
    const administrativePath = resolve(administrativeRoot, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new GitWorktreeError(`Unexpected Git worktree administrative entry: ${administrativePath}.`);
    }
    if (existsSync(resolve(administrativePath, "locked"))) continue;

    const gitdirPath = resolve(administrativePath, "gitdir");
    let registeredGitFile: string | undefined;
    try {
      registeredGitFile = removeLineEnding(readFileSync(gitdirPath, "utf8"));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    if (registeredGitFile) {
      const targetGitFile = resolve(administrativePath, registeredGitFile);
      if (existsSync(targetGitFile)) continue;
    }

    const headPath = resolve(administrativePath, "HEAD");
    let headValue: string;
    try {
      if (!lstatSync(headPath).isFile()) {
        throw new GitWorktreeError(`Git worktree administrative HEAD is not a file: ${headPath}.`);
      }
      headValue = removeLineEnding(readFileSync(headPath, "utf8"));
    } catch (error) {
      if (error instanceof GitWorktreeError) throw error;
      throw new GitWorktreeError(`Cannot inspect Git worktree administrative HEAD ${headPath}: ${formatError(error)}`);
    }
    const indexDirty = await administrativeIndexIsDirty(pi, cwd, administrativePath, signal);
    if (headValue.startsWith("ref: ")) {
      const branchRef = headValue.slice("ref: ".length);
      if (!branchRef) {
        throw new GitWorktreeError(`Git worktree administrative HEAD has an empty ref: ${headPath}.`);
      }
      addCandidate({
        id: entry.name,
        administrativePath,
        branchRef,
        indexDirty,
      });
      continue;
    }
    if (!/^[0-9a-fA-F]{40,64}$/u.test(headValue)) {
      throw new GitWorktreeError(`Git worktree administrative HEAD is malformed: ${headPath}.`);
    }
    addCandidate({
      id: entry.name,
      administrativePath,
      head: headValue,
      indexDirty,
    });
  }
  return candidates;
}
function metadataSnapshot(path: string): MetadataIdentity {
  const stat = lstatSync(path);
  const metadata = {
    kind: stat.isDirectory() ? ("directory" as const) : ("leaf" as const),
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
  if (metadata.kind === "leaf") return metadata;
  const children = new Map<string, MetadataIdentity>();
  for (const name of readdirSync(path)) children.set(name, metadataSnapshot(join(path, name)));
  return { ...metadata, children };
}

function sameMetadataIdentity(actual: MetadataIdentity, expected: MetadataIdentity): boolean {
  if (actual.kind !== expected.kind || actual.dev !== expected.dev || actual.ino !== expected.ino) return false;
  if (expected.kind === "directory") return true;
  return actual.size === expected.size && actual.mtimeMs === expected.mtimeMs && actual.ctimeMs === expected.ctimeMs;
}
function sameMetadataIdentityAfterRename(actual: MetadataIdentity, expected: MetadataIdentity): boolean {
  if (actual.kind !== expected.kind || actual.dev !== expected.dev || actual.ino !== expected.ino) return false;
  if (expected.kind === "directory") return true;
  return actual.size === expected.size && actual.mtimeMs === expected.mtimeMs;
}
async function claimMetadataDeletion(path: string, expected: MetadataIdentity): Promise<string> {
  const claimed = join(dirname(path), `.${randomUUID()}.pi-worktree-metadata-final-delete`);
  try {
    await rename(path, claimed);
    const stat = await lstat(claimed);
    const actual: MetadataIdentity = {
      kind: stat.isDirectory() ? "directory" : "leaf",
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
    if (!sameMetadataIdentityAfterRename(actual, expected)) {
      throw new MetadataDeletionRetainedError(claimed, `Git metadata changed before final deletion: ${path}.`);
    }
    return claimed;
  } catch (error: unknown) {
    if (error instanceof MetadataDeletionRetainedError) throw error;
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new MetadataDeletionRetainedError(
        claimed,
        `Git metadata disappeared before final deletion; removal outcome is unknown: ${path}.`,
        true,
      );
    }
    throw error;
  }
}

async function removeMetadataTree(path: string, expected: MetadataIdentity): Promise<void> {
  const stat = await lstat(path);
  const actual: MetadataIdentity = {
    kind: stat.isDirectory() ? "directory" : "leaf",
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
  if (!sameMetadataIdentity(actual, expected)) throw new Error(`Git metadata changed while removing ${path}.`);
  if (expected.kind === "leaf") {
    const claimed = await claimMetadataDeletion(path, expected);
    try {
      await unlink(claimed);
    } catch (error: unknown) {
      throw new MetadataDeletionRetainedError(
        claimed,
        `Git metadata could not be deleted after claiming ${path}: ${formatError(error)}.`,
        isNodeError(error) && error.code === "ENOENT",
      );
    }
    return;
  }
  const children = expected.children ?? new Map<string, MetadataIdentity>();
  const actualNames = await readdir(path);
  const expectedNames = new Set(children.keys());
  if (
    actualNames.some((name) => !expectedNames.has(name)) ||
    [...expectedNames].some((name) => !actualNames.includes(name))
  ) {
    throw new Error(`New Git metadata appeared while removing ${path}.`);
  }
  for (const [name, child] of children) await removeMetadataTree(join(path, name), child);
  const claimed = await claimMetadataDeletion(path, expected);
  try {
    await rmdir(claimed);
  } catch (error: unknown) {
    throw new MetadataDeletionRetainedError(
      claimed,
      `Git metadata directory could not be deleted after claiming ${path}: ${formatError(error)}.`,
      isNodeError(error) && error.code === "ENOENT",
    );
  }
}

async function removeAdministrativeRecord(candidate: AdministrativePruneCandidate): Promise<void> {
  const expected = administrativeIdentities.get(candidate);
  if (!expected) throw new GitWorktreeError(`Git metadata identity was not captured for ${candidate.id}.`);
  const source = candidate.administrativePath;
  const worktreePath = administrativeCandidateWorktreePath(candidate);
  const worktreeGitFile = worktreePath ? join(worktreePath, ".git") : undefined;
  const tombstone = join(dirname(source), `.${basename(source)}.${randomUUID()}.pi-worktree-metadata-delete`);
  let moved = false;
  try {
    if (worktreeGitFile && existsSync(worktreeGitFile)) {
      throw new Error(`worktree ${worktreePath} became valid before metadata removal`);
    }
    await rename(source, tombstone);
    moved = true;
    if (worktreeGitFile && existsSync(worktreeGitFile)) {
      await rename(tombstone, source);
      moved = false;
      throw new Error(`worktree ${worktreePath} became valid while claiming metadata`);
    }
    await removeMetadataTree(tombstone, expected);
  } catch (error: unknown) {
    const retainedPath =
      error instanceof MetadataDeletionRetainedError ? error.retainedPath : moved ? tombstone : undefined;
    const outcomeWarning =
      error instanceof MetadataDeletionRetainedError && error.outcomeUnknown
        ? " Metadata removal outcome is unknown."
        : "";
    throw new GitWorktreeError(
      `Git administrative metadata removal failed for ${candidate.id}${retainedPath ? `; retained at ${retainedPath}` : ""}.${outcomeWarning} ${formatError(error)}`,
    );
  }
}
function sameAdministrativeCandidate(left: AdministrativePruneCandidate, right: AdministrativePruneCandidate): boolean {
  return (
    left.id === right.id &&
    pathsEqual(left.administrativePath, right.administrativePath) &&
    left.head === right.head &&
    left.branchRef === right.branchRef &&
    left.indexDirty === right.indexDirty
  );
}
function administrativeCandidateWorktreePath(candidate: AdministrativePruneCandidate): string | undefined {
  try {
    const gitdir = removeLineEnding(readFileSync(join(candidate.administrativePath, "gitdir"), "utf8"));
    return gitdir ? dirname(resolve(candidate.administrativePath, gitdir)) : undefined;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new GitWorktreeError(
      `Cannot inspect Git worktree administrative gitdir for ${candidate.id}: ${formatError(error)}`,
    );
  }
}

async function administrativeIndexIsDirty(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  administrativePath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const args = [
    `--git-dir=${administrativePath}`,
    "diff",
    "--cached",
    "--quiet",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=none",
    "--",
  ];
  const result = await runGitAllowFailure(pi, args, cwd, signal);
  if (result.killed) throw killedError(args);
  if (result.code === 0) return false;
  if (result.code === 1) return true;
  throw gitFailure(args, result);
}

export async function durableRefExists(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  ref: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!ref.startsWith("refs/") || ref.includes("\0")) {
    throw new GitWorktreeError("Git worktree administrative HEAD contains an invalid ref.");
  }
  const result = await runGitAllowFailure(pi, ["show-ref", "--verify", "--quiet", ref], cwd, signal);
  if (result.killed) throw killedError(["show-ref", "--verify", "--quiet"]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw gitFailure(["show-ref", "--verify", "--quiet"], result);
}

export async function durableRefsContaining(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  head: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!/^[0-9a-fA-F]{40,64}$/u.test(head)) {
    throw new GitWorktreeError("Detached worktree has an invalid HEAD object.");
  }
  const result = await runGit(
    pi,
    ["for-each-ref", "--format=%(refname)", `--contains=${head}`, "refs/heads", "refs/tags", "refs/remotes"],
    cwd,
    signal,
  );
  return nonEmptyLines(result.stdout);
}

export async function prunePreview(pi: Pick<ExtensionAPI, "exec">, cwd: string, signal?: AbortSignal): Promise<string> {
  const result = await runGit(pi, ["worktree", "prune", "--dry-run", "--verbose"], cwd, signal);
  return combineOutput(result);
}

export async function pruneWorktrees(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  signal?: AbortSignal,
  lockHeld = false,
  approvedCandidates?: readonly AdministrativePruneCandidate[],
): Promise<string> {
  const operation = async (): Promise<string> => {
    const currentCandidates = await administrativePruneCandidates(pi, cwd, signal);
    const candidates = approvedCandidates
      ? approvedCandidates.map((approved) => {
          const current = currentCandidates.find((candidate) =>
            pathsEqual(candidate.administrativePath, approved.administrativePath),
          );
          if (!current || !sameAdministrativeCandidate(current, approved)) {
            throw new GitWorktreeError(`Git administrative metadata changed before pruning ${approved.id}.`);
          }
          return approved;
        })
      : currentCandidates;
    if (candidates.length === 0) {
      if (approvedCandidates?.length || hasAdministrativeWorktrees(cwd) || existsSync(worktreeMutationLockKey(cwd))) {
        throw new GitWorktreeError("No approved Git administrative records are available to prune.");
      }
      const result = await runGit(pi, ["worktree", "prune", "--verbose"], cwd, signal, GIT_MUTATION_TIMEOUT_MS);
      return combineOutput(result);
    }
    for (const candidate of candidates) await removeAdministrativeRecord(candidate);
    return candidates.map((candidate) => `Removed ${candidate.id}`).join("\n");
  };
  return lockHeld ? operation() : withWorktreeMutationLock(cwd, operation, signal);
}

export function formatWorktree(record: WorktreeRecord, currentPath?: string): string {
  const labels = [
    currentPath && pathsEqual(record.path, currentPath) ? "current" : undefined,
    record.isMain ? "main" : undefined,
    record.bare ? "bare" : undefined,
    record.detached ? "detached" : record.branch,
    record.lockedReason !== undefined ? `locked${record.lockedReason ? `: ${record.lockedReason}` : ""}` : undefined,
    record.prunableReason !== undefined
      ? `prunable${record.prunableReason ? `: ${record.prunableReason}` : ""}`
      : undefined,
  ].filter((label): label is string => Boolean(label));
  const head = record.head ? record.head.slice(0, 8) : "no HEAD";
  return stripTerminalControls(`${record.path}  [${labels.join(", ") || "unknown"}]  ${head}`);
}

/**
 * Layout-preserving sanitizer contract (the same shape pi-statusline implements, duplicated per the
 * package boundary rule; pi-recall implements the prose variant that also collapses whitespace):
 * - line separators become one space, so multi-line Git output stays readable as a single line
 *   instead of welding the end of one record onto the start of the next;
 * - every other unsafe code point (C0, DEL/C1, bidi overrides) is dropped with no replacement;
 * - whitespace is neither collapsed nor trimmed.
 * There is no escape-sequence parser here: dropping ESC and the C1 introducers already leaves any
 * residual payload as inert text, and consuming it would let one byte erase the rest of a
 * destructive confirmation prompt.
 */
export function stripTerminalControls(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      if (isLineSeparator(codePoint)) return " ";
      return isUnsafeTerminalCodePoint(codePoint) ? "" : character;
    })
    .join("");
}

// Git output is joined with newlines before it reaches a confirmation body. Dropping them outright
// glued "Removing a: reason" onto "Removing b: reason", changing what the user reads before
// approving an irreversible prune or removal.
function isLineSeparator(codePoint: number): boolean {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    codePoint === 0x85 ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  );
}

// Bidi controls reorder what the menu shows without changing the path we act on, so a removal
// prompt could name one worktree while the user reads another.
function isUnsafeTerminalCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

async function runGit(
  pi: Pick<ExtensionAPI, "exec">,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeout = GIT_TIMEOUT_MS,
): Promise<ExecResult> {
  const result = await runGitAllowFailure(pi, args, cwd, signal, timeout);
  if (result.killed) throw killedError(args);
  if (result.code !== 0) throw gitFailure(args, result);
  return result;
}

async function runGitAllowFailure(
  pi: Pick<ExtensionAPI, "exec">,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeout = GIT_TIMEOUT_MS,
): Promise<ExecResult> {
  try {
    return await pi.exec("git", args, { cwd, signal, timeout });
  } catch (error) {
    const message = formatError(error);
    if (/\bENOENT\b|not found/i.test(message)) {
      throw new GitWorktreeError("Git executable was not found. Install Git and retry.", args);
    }
    throw new GitWorktreeError(`Could not start git ${args.slice(0, 2).join(" ")}: ${message}`, args);
  }
}

function gitFailure(args: string[], result: ExecResult): GitWorktreeError {
  const detail = stripTerminalControls([result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n"));
  const hint = /not a git repository/i.test(detail)
    ? "The current Pi workspace is not inside a Git repository."
    : detail || `Git exited with code ${result.code}.`;
  return new GitWorktreeError(`git ${args.slice(0, 2).join(" ")} failed: ${hint}`, args);
}

function killedError(args: string[]): GitWorktreeError {
  return new GitWorktreeError(`git ${args.slice(0, 2).join(" ")} timed out or was cancelled.`, args);
}

function nonEmptyLines(value: string): string[] {
  return value.split(/\r?\n/u).filter((line) => line.length > 0);
}

interface IndexFlagEntry {
  path: string;
  skipWorktree: boolean;
  assumeUnchanged: boolean;
}

async function indexFlagInventory(
  pi: Pick<ExtensionAPI, "exec">,
  value: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const entries = parseIndexFlagEntries(value);
  const sparseManagedPaths = await sparseManagedSkipWorktreePaths(
    pi,
    cwd,
    entries.filter((entry) => entry.skipWorktree).map((entry) => entry.path),
    signal,
  );
  const inventory: string[] = [];
  for (const entry of entries) {
    const flags = [
      entry.skipWorktree && !sparseManagedPaths.has(entry.path) ? "skip-worktree" : undefined,
      entry.assumeUnchanged ? "assume-unchanged" : undefined,
    ].filter((flag): flag is string => flag !== undefined);
    if (flags.length > 0) inventory.push(`index flag ${flags.join("+")}: ${entry.path}`);
  }
  return inventory;
}

function parseIndexFlagEntries(value: string): IndexFlagEntry[] {
  const entries: IndexFlagEntry[] = [];
  for (const entry of value.split("\0")) {
    if (!entry) continue;
    if (entry.length < 3 || entry[1] !== " ") {
      throw new GitWorktreeError("Git returned malformed ls-files index-flag output.");
    }
    const tag = entry[0] ?? "";
    const skipWorktree = tag.toUpperCase() === "S";
    const assumeUnchanged = /[a-z]/u.test(tag);
    if (skipWorktree || assumeUnchanged) {
      entries.push({ path: entry.slice(2), skipWorktree, assumeUnchanged });
    }
  }
  return entries;
}

async function sparseManagedSkipWorktreePaths(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<ReadonlySet<string>> {
  if (paths.length === 0) return new Set();
  const configArgs = ["config", "--bool", "--get", "core.sparseCheckout"];
  const config = await runGitAllowFailure(pi, configArgs, cwd, signal);
  if (config.killed) throw killedError(configArgs);
  if (config.code !== 0 || config.stdout.trim() !== "true") return new Set();

  const candidates = new Set(paths);
  const checkArgs = ["sparse-checkout", "check-rules", "-z"];
  const checked = await runGitWithInputAllowFailure(checkArgs, cwd, `${[...candidates].join("\0")}\0`, signal);
  if (checked.killed) throw killedError(checkArgs);
  // Older Git versions lack check-rules; retain every flag rather than guessing.
  if (checked.code !== 0) return new Set();

  const included = new Set(nulSeparatedPaths(checked.stdout, "sparse-checkout rules"));
  if ([...included].some((path) => !candidates.has(path))) {
    throw new GitWorktreeError("Git returned an unexpected sparse-checkout path.");
  }
  return new Set([...candidates].filter((path) => !included.has(path)));
}

function runGitWithInputAllowFailure(
  args: string[],
  cwd: string,
  input: string,
  signal?: AbortSignal,
  timeout = GIT_TIMEOUT_MS,
): Promise<ExecResult> {
  if (signal?.aborted) {
    return Promise.resolve({ stdout: "", stderr: "", code: 1, killed: true });
  }
  return new Promise((resolveResult, reject) => {
    // ExtensionAPI.exec has no stdin channel, so this read-only check uses an argv-only child.
    const child = spawn("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", stop);
      resolveResult(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", stop);
      child.kill();
      const message = formatError(error);
      reject(
        /\bENOENT\b|not found/i.test(message)
          ? new GitWorktreeError("Git executable was not found. Install Git and retry.", args)
          : new GitWorktreeError(`Could not start git ${args.slice(0, 2).join(" ")}: ${message}`, args),
      );
    };
    const stop = () => {
      killed = true;
      child.kill();
    };
    const timeoutHandle = setTimeout(stop, timeout);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on("error", (error) => {
      if (!isNodeError(error) || error.code !== "EPIPE") fail(error);
    });
    child.once("error", fail);
    child.once("close", (code, closeSignal) => {
      finish({
        stdout,
        stderr,
        code: code ?? 1,
        killed: killed || closeSignal !== null,
      });
    });
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.stdin.end(input);
  });
}

function nulSeparatedPaths(value: string, source: string): string[] {
  if (value && !value.endsWith("\0")) {
    throw new GitWorktreeError(`Git returned malformed ${source} output.`);
  }
  return value.split("\0").filter(Boolean);
}

function combineOutput(result: ExecResult): string {
  return [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n");
}

function removeLineEnding(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

function splitAdministrativeOids(value: string, source: string): string[] {
  const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (!normalized) return [];
  const values = normalized.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (values.some((oid) => !/^[0-9a-fA-F]{40,64}$/u.test(oid))) {
    throw new GitWorktreeError(`Git returned malformed object IDs for ${source}.`);
  }
  return values;
}

function splitFetchHeadOids(value: string): string[] {
  const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (!normalized) return [];
  return normalized.split("\n").map((line) => {
    const match = /^([0-9a-fA-F]{40,64})\t/u.exec(line);
    if (!match?.[1]) {
      throw new GitWorktreeError("Git worktree administrative FETCH_HEAD is malformed.");
    }
    return match[1];
  });
}

function readAdministrativeFile(administrativePath: string, name: string): string | undefined {
  const path = resolve(administrativePath, name);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new GitWorktreeError(`Cannot inspect Git worktree administrative ${name}: ${formatError(error)}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new GitWorktreeError(`Git worktree administrative ${name} must be a regular file: ${path}.`);
  }
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new GitWorktreeError(`Cannot inspect Git worktree administrative ${name}: ${formatError(error)}`);
  }
}

function readAdministrativeReflogOids(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(logPath);
  } catch (error) {
    throw new GitWorktreeError(`Cannot inspect Git reflog path ${logPath}: ${formatError(error)}`);
  }
  if (stat.isSymbolicLink()) {
    throw new GitWorktreeError(`Git reflog path must not be a symbolic link: ${logPath}.`);
  }
  if (stat.isDirectory()) {
    const values: string[] = [];
    for (const entry of readdirSync(logPath, { withFileTypes: true })) {
      values.push(...readAdministrativeReflogOids(resolve(logPath, entry.name)));
    }
    return values;
  }
  if (!stat.isFile()) {
    throw new GitWorktreeError(`Unexpected Git reflog entry type: ${logPath}.`);
  }

  let contents: string;
  try {
    contents = readFileSync(logPath, "utf8");
  } catch (error) {
    throw new GitWorktreeError(`Cannot read Git reflog ${logPath}: ${formatError(error)}`);
  }
  const normalized = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  if (!normalized) return [];
  const values: string[] = [];
  for (const line of normalized.split("\n")) {
    const match = /^([0-9a-fA-F]{40,64}) ([0-9a-fA-F]{40,64}) /u.exec(line);
    if (!match?.[1] || !match[2] || match[1].length !== match[2].length) {
      throw new GitWorktreeError(`Git worktree reflog is malformed: ${logPath}.`);
    }
    for (const oid of [match[1], match[2]]) {
      if (!/^0+$/u.test(oid)) values.push(oid);
    }
  }
  return values;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
