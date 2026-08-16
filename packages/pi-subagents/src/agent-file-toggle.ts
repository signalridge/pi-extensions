/**
 * agent-file-toggle.ts — Pure helpers for `/agents` file-editing operations:
 * locating an agent's .md file, toggling its `enabled:` frontmatter flag, and
 * serializing an AgentConfig back to frontmatter for eject.
 *
 * Reading uses the same YAML parser as custom-agent loading. Editing stays
 * line-wise so hand-authored comments, key order, quoting, and line endings
 * survive untouched.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./types.js";

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

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function tempPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
}


function recoveryPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.recovery`);
}

function reserveTempFile(path: string, mode: number): { path: string; fd: number } {
  for (let attempt = 0; attempt < 8; attempt++) {
    const tempPath = tempPathFor(path);
    try {
      return { path: tempPath, fd: openSync(tempPath, "wx", mode) };
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  throw new Error(`Unable to create a unique temporary file beside ${path}`);
}

function assertSourceMatches(path: string, expectedSource: string): void {
  try {
    if (readFileSync(path, "utf-8") === expectedSource) return;
  } catch {
    // Treat disappearance or an unreadable replacement as a conflict too.
  }
  throw new Error(`Refusing to modify ${path}: source changed since it was read`);
}

function writeAndFlush(fd: number, content: string, mode?: number): void {
  // Existing-file replacements pass the exact original mode. New files leave
  // the mode returned by openSync untouched so the process umask is honored.
  if (mode !== undefined) fchmodSync(fd, mode);
  const bytes = Buffer.from(content, "utf-8");
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(fd, bytes, offset, bytes.length - offset, null);
  }
  fsyncSync(fd);
  closeSync(fd);
}

const LOCK_OWNER_PREFIX = "owner-";
const FILE_LOCK_MAX_ATTEMPTS = 12;
const FILE_LOCK_RETRY_DELAY_MS = 25;

interface FileMutationLock {
  lockPath: string;
  ownerPath: string;
  token: string;
  directoryIdentity: { dev: number; ino: number };
}

/** The package-local, non-expiring lock directory used by agent-file mutations. */
export function agentFileLockPath(path: string): string {
  return `${path}.lock`;
}

function ownerFileName(token: string): string {
  // The token is generated locally, but keep this path-safe so diagnostics and
  // future callers cannot turn the owner path into a nested path.
  return `${LOCK_OWNER_PREFIX}${token.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function lockOwnerNames(lockPath: string): string[] {
  try {
    return readdirSync(lockPath)
      .filter(name => name.startsWith(LOCK_OWNER_PREFIX))
      .sort();
  } catch {
    return [];
  }
}

/** Describe token owners without reading untrusted owner-file contents. */
function describeLockOwnership(lockPath: string): string {
  try {
    const owners = readdirSync(lockPath)
      .filter(name => name.startsWith(LOCK_OWNER_PREFIX))
      .sort();
    if (owners.length === 0) return "no token owner file is present (the lock may be incomplete or orphaned)";
    const shown = owners.slice(0, 8).map(name => JSON.stringify(name));
    const suffix = owners.length > shown.length ? `, … and ${owners.length - shown.length} more` : "";
    return `token owner file(s): ${shown.join(", ")}${suffix}`;
  } catch (error: unknown) {
    return `token ownership could not be enumerated (${errorCode(error) ?? "unreadable lock directory"})`;
  }
}

/**
 * Return a token-specific owner path. With no token, resolve the sole owner in
 * an existing lock directory for diagnostics and tests; there is deliberately
 * no generic owner filename on disk.
 */
export function agentFileLockOwnerPath(path: string, token?: string): string {
  const lockPath = agentFileLockPath(path);
  if (token !== undefined) return join(lockPath, ownerFileName(token));
  const owners = lockOwnerNames(lockPath);
  if (owners.length === 1) return join(lockPath, owners[0]!);
  return join(lockPath, `${LOCK_OWNER_PREFIX}unknown`);
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

function directoryIdentity(path: string): { dev: number; ino: number } {
  const stats = statSync(path);
  return { dev: stats.dev, ino: stats.ino };
}

function verifyLockDirectory(lock: FileMutationLock): void {
  let current: { dev: number; ino: number };
  try {
    current = directoryIdentity(lock.lockPath);
  } catch (error: unknown) {
    throw new Error(
      `Cannot release agent-file lock at ${lock.lockPath}: cannot verify its identity; ` +
      `the lock was left in place for inspection/removal.`,
      { cause: error },
    );
  }
  if (current.dev !== lock.directoryIdentity.dev || current.ino !== lock.directoryIdentity.ino) {
    throw new Error(
      `Cannot release agent-file lock at ${lock.lockPath}: its directory identity changed; ` +
      `refusing to remove another owner's lock. Inspect and remove the lock manually if needed.`,
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function manualLockRecovery(lockPath: string): string {
  return `Manual cleanup (only after verifying the lock is orphaned): rm -rf -- ${shellQuote(lockPath)}`;
}

function lockUnavailable(path: string, lockPath: string): Error {
  return new Error(
    `Cannot acquire cooperative agent-file lock for ${path} at ${lockPath}: ` +
    `${describeLockOwnership(lockPath)}; another writer may hold it or it may be orphaned. ` +
    `${manualLockRecovery(lockPath)}`,
  );
}

interface DeadLockCandidate {
  lockPath: string;
  ownerPath: string;
  token: string;
  directoryIdentity: { dev: number; ino: number };
  pid: number;
}

function isDeadProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    return errorCode(error) === "ESRCH";
  }
}

/**
 * Return a reclaim candidate only when the lock has one well-formed owner,
 * that owner names the exact token file, and its PID is provably gone.
 */
function inspectDeadLock(lockPath: string): DeadLockCandidate | undefined {
  let identity: { dev: number; ino: number };
  try {
    const stats = lstatSync(lockPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return undefined;
    identity = { dev: stats.dev, ino: stats.ino };
  } catch {
    return undefined;
  }

  const owners = lockOwnerNames(lockPath);
  if (owners.length !== 1) return undefined;
  const ownerName = owners[0]!;
  const ownerPath = join(lockPath, ownerName);
  if (!ownerName.startsWith(LOCK_OWNER_PREFIX)) return undefined;

  let token: string;
  try {
    const ownerStats = lstatSync(ownerPath);
    if (!ownerStats.isFile() || ownerStats.isSymbolicLink()) return undefined;
    token = readFileSync(ownerPath, "utf-8");
  } catch {
    return undefined;
  }
  if (ownerFileName(token) !== ownerName) return undefined;

  const match = /^(\d+):([A-Za-z0-9_-]+)$/.exec(token);
  if (!match) return undefined;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 1 || !isDeadProcess(pid)) return undefined;

  return { lockPath, ownerPath, token, directoryIdentity: identity, pid };
}

/** Remove only the verified dead owner's token and then its empty lock directory. */
function reclaimDeadLock(lockPath: string): boolean {
  const candidate = inspectDeadLock(lockPath);
  if (!candidate) return false;

  try {
    const current = directoryIdentity(candidate.lockPath);
    if (current.dev !== candidate.directoryIdentity.dev || current.ino !== candidate.directoryIdentity.ino) return false;
    if (lockOwnerNames(candidate.lockPath).length !== 1) return false;
    if (readFileSync(candidate.ownerPath, "utf-8") !== candidate.token) return false;
    unlinkSync(candidate.ownerPath);
    const afterUnlink = directoryIdentity(candidate.lockPath);
    if (afterUnlink.dev !== candidate.directoryIdentity.dev || afterUnlink.ino !== candidate.directoryIdentity.ino) return false;
    if (readdirSync(candidate.lockPath).length !== 0) return false;
    rmdirSync(candidate.lockPath);
    return true;
  } catch {
    return false;
  }
}

async function acquireFileMutationLock(path: string): Promise<FileMutationLock> {
  const lockPath = agentFileLockPath(path);
  const token = `${process.pid}:${randomUUID()}`;
  const ownerPath = agentFileLockOwnerPath(path, token);

  for (let attempt = 0; attempt < FILE_LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      // mkdir is the atomic ownership claim. An existing lock is reclaimed only
      // after exact token/PID verification proves that its owner is dead.
      mkdirSync(lockPath, { mode: 0o700 });
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (reclaimDeadLock(lockPath)) {
        attempt--;
        continue;
      }
      if (attempt === FILE_LOCK_MAX_ATTEMPTS - 1) throw lockUnavailable(path, lockPath);
      await new Promise<void>((resolve) => setTimeout(resolve, FILE_LOCK_RETRY_DELAY_MS));
      continue;
    }

    try {
      writeFileSync(ownerPath, token, { encoding: "utf-8", flag: "wx", mode: 0o600 });
      chmodSync(ownerPath, 0o600);
      return {
        lockPath,
        ownerPath,
        token,
        directoryIdentity: directoryIdentity(lockPath),
      };
    } catch (error: unknown) {
      throw new Error(
        `Cannot initialize cooperative agent-file lock at ${lockPath}; ` +
        `${describeLockOwnership(lockPath)}. ${manualLockRecovery(lockPath)}`,
        { cause: error },
      );
    }
  }

  throw lockUnavailable(path, lockPath);
}

function releaseFileMutationLock(lock: FileMutationLock): void {
  verifyLockDirectory(lock);

  let ownerToken: string;
  try {
    ownerToken = readFileSync(lock.ownerPath, "utf-8");
  } catch (error: unknown) {
    throw new Error(
      `Cannot release agent-file lock at ${lock.lockPath}: cannot verify token ${basename(lock.ownerPath)}; ` +
      `${describeLockOwnership(lock.lockPath)}. The lock was left in place for inspection/removal.`,
      { cause: error },
    );
  }
  if (ownerToken !== lock.token) {
    throw new Error(
      `Cannot release agent-file lock at ${lock.lockPath}: owner token mismatch at ${basename(lock.ownerPath)}; ` +
      `refusing to remove another owner's lock. Inspect and remove it manually if needed.`,
    );
  }

  // The owner filename contains the unguessable token. Even if this directory
  // is removed and replaced after the checks above, unlinking this path cannot
  // remove a replacement owner's different token file.
  try {
    unlinkSync(lock.ownerPath);
  } catch (error: unknown) {
    throw new Error(
      `Cannot release agent-file lock at ${lock.lockPath}: cannot remove token ${basename(lock.ownerPath)}; ` +
      `${describeLockOwnership(lock.lockPath)}. The lock was left in place for inspection/removal.`,
      { cause: error },
    );
  }

  // Re-check the directory before attempting rmdir. The rmdir itself is also
  // non-recursive: a replacement owner token makes it fail with ENOTEMPTY.
  verifyLockDirectory(lock);
  try {
    rmdirSync(lock.lockPath);
  } catch (error: unknown) {
    throw new Error(
      `Cannot release agent-file lock at ${lock.lockPath}: the lock directory was not empty or ` +
      `could not be removed; ${describeLockOwnership(lock.lockPath)}. ` +
      `Inspect and remove it manually only if it is orphaned.`,
      { cause: error },
    );
  }
}

/** Hold the non-expiring cooperative lock across the complete mutation. */
export async function withAgentFileLock<T>(path: string, operation: () => T | PromiseLike<T>): Promise<T> {
  const lock = await acquireFileMutationLock(path);
  let operationFailed = false;
  let operationError: unknown;
  let result!: T;
  try {
    result = await operation();
  } catch (error: unknown) {
    operationFailed = true;
    operationError = error;
  }

  let releaseFailed = false;
  let releaseError: unknown;
  try {
    releaseFileMutationLock(lock);
  } catch (error: unknown) {
    releaseFailed = true;
    releaseError = error;
  }

  if (operationFailed) {
    if (releaseFailed) {
      throw new AggregateError(
        [operationError, releaseError],
        `Agent-file mutation failed and its lock could not be released: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
      );
    }
    throw operationError;
  }
  if (releaseFailed) throw releaseError;
  return result;
}

/**
 * Replace an existing agent file without exposing a partial write or discarding
 * an uncooperative editor save. The displaced inode stays in a hidden recovery
 * file: an editor with an already-open descriptor therefore writes recovery
 * data, while an atomic editor save recreates `path` and makes linkSync fail.
 * `expectedSource` is the content read before any UI or other work began.
 */
export async function atomicReplaceFile(path: string, content: string, expectedSource: string): Promise<void> {
  await withAgentFileLock(path, () => {
    assertSourceMatches(path, expectedSource);
    const mode = statSync(path).mode & 0o7777;
    const reserved = reserveTempFile(path, mode);
    let fd = reserved.fd;
    let tempPath: string | undefined = reserved.path;
    const recoveryPath = recoveryPathFor(path);
    let displaced = false;
    try {
      writeAndFlush(fd, content, mode);
      fd = -1;
      assertSourceMatches(path, expectedSource);
      renameSync(path, recoveryPath);
      displaced = true;
      // Unlike rename, link creation never replaces a target recreated by an
      // editor after the source was displaced.
      linkSync(tempPath, path);
      unlinkSync(tempPath);
      tempPath = undefined;
    } catch (error: unknown) {
      if (displaced) {
        throw new Error(
          `Refusing to publish replacement for ${path}: displaced source preserved at ${recoveryPath}`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      if (fd !== -1) {
        try { closeSync(fd); } catch { /* preserve the original write error */ }
      }
      if (tempPath !== undefined) {
        try { unlinkSync(tempPath); } catch { /* best-effort generated-temp cleanup */ }
      }
    }
  });
}

/** Write a newly-generated file atomically without clobbering an existing target. */
export async function atomicCreateFile(path: string, content: string): Promise<void> {
  await withAgentFileLock(path, () => {
    const reserved = reserveTempFile(path, 0o666);
    let fd = reserved.fd;
    let tempPath: string | undefined = reserved.path;
    try {
      // Do not fchmod a new file: openSync already applied process.umask().
      writeAndFlush(fd, content);
      fd = -1;
      if (existsSync(path)) {
        throw new Error(`Refusing to create ${path}: file already exists`);
      }
      // A hard-link creation is atomic and fails with EEXIST if another writer
      // created the target after the check. Both paths are in the same directory.
      linkSync(tempPath, path);
      unlinkSync(tempPath);
      tempPath = undefined;
    } finally {
      if (fd !== -1) {
        try { closeSync(fd); } catch { /* preserve the original write error */ }
      }
      if (tempPath !== undefined) {
        try { unlinkSync(tempPath); } catch { /* best-effort temp cleanup */ }
      }
    }
  });
}

/**
 * Remove an agent override only if the confirmed source is still unchanged.
 * The displaced inode remains in a hidden recovery file so an editor holding an
 * open descriptor cannot have a late save unlinked underneath it.
 */
export async function removeFileIfUnchanged(path: string, expectedSource: string): Promise<void> {
  await withAgentFileLock(path, () => {
    assertSourceMatches(path, expectedSource);
    const recoveryPath = recoveryPathFor(path);
    assertSourceMatches(path, expectedSource);
    renameSync(path, recoveryPath);
    if (existsSync(path)) {
      throw new Error(
        `Refusing to remove ${path}: a concurrent writer recreated it; displaced source preserved at ${recoveryPath}`,
      );
    }
  });
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
  model?: string;
  thinking?: string;
  systemPrompt: string;
}

/** Serialize the manual wizard's free-text fields safely as YAML scalars. */
export function buildNewAgentFile(input: NewAgentInput): string {
  const modelLine = input.model ? `\nmodel: ${JSON.stringify(input.model)}` : "";
  const thinkingLine = input.thinking ? `\nthinking: ${formatYamlScalar(input.thinking)}` : "";
  return `---
description: ${JSON.stringify(input.description)}
tools: ${formatYamlScalar(input.tools)}${modelLine}${thinkingLine}
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
  fmFields.push(`tools: ${formatYamlScalar(formatToolsField(cfg))}`);
  // Never model:/thinking: — the loader ignores them, so writing them back
  // would recreate a pin that looks effective and is not.
  if (cfg.agentTier) fmFields.push(`tier: ${formatYamlScalar(cfg.agentTier)}`);
  if (cfg.maxTurns) fmFields.push(`max_turns: ${cfg.maxTurns}`);
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
  if (cfg.inheritContext) fmFields.push("inherit_context: true");
  if (cfg.runInBackground) fmFields.push("run_in_background: true");
  if (cfg.outputTranscript === false) fmFields.push("output_transcript: false");
  if (cfg.isolated) fmFields.push("isolated: true");
  if (cfg.memory) fmFields.push(`memory: ${cfg.memory}`);
  if (cfg.isolation) fmFields.push(`isolation: ${cfg.isolation}`);

  return `---\n${fmFields.join("\n")}\n---\n\n${cfg.systemPrompt}\n`;
}

