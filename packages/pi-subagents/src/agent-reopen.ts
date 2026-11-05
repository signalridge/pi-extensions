/**
 * Branch-owned ordinary-agent reopen receipts. Never accept a caller's file path.
 * Local adaptation of tintinweb/pi-subagents' evicted-conversation reopening:
 * retain the existing runner, adding native ownership/leaf proofs, stable IDs,
 * and conservative isolation rather than importing its orchestration engine.
 */
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { assertSafeChildSession } from "./context-boundary.js";
import { type AgentReopenRoute, assertPlainReopenHistory, captureReopenRoute, parseReopenRoute, sameReopenRoute } from "./reopen-route.js";
import type { AgentRecord, ResumableAgentEntry } from "./types.js";
import type { WorktreeInfo } from "./worktree.js";

export const CHILD_IDENTITY_ENTRY_TYPE = "subagents:identity";

/** Only inert facts; current definitions and tier policy are resolved again on reopen. */
export interface AgentReopenMetadata {
  version: 1;
  /** Physical catalog identity only; never an issuer/profile replay authorization. */
  route?: AgentReopenRoute;
  handle: string;
  sessionFile: string;
  sessionId: string;
  leafId: string;
  rootSessionId: string;
  parentSessionFile: string;
  cwd: string;
  isolation: "off" | "worktree";
  /** Invocation restrictions can narrow current policy, never silently widen it. */
  isolated: boolean;
  supervisorQuestions: boolean;
  excludeTools?: string[];
  worktree?: WorktreeInfo;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function absolutePath(value: unknown): value is string {
  return bounded(value, 2_000) && isAbsolute(value);
}

/** Malformed receipts never authorize a file open. */
export function parseAgentReopenMetadata(value: unknown): AgentReopenMetadata | undefined {
  if (!record(value) || value.version !== 1 ||
    !bounded(value.handle, 128) || !/^[a-z0-9_-]+$/i.test(value.handle) || value.handle.toLowerCase() === "main" ||
    !bounded(value.sessionId, 128) || !bounded(value.leafId, 128) || !bounded(value.rootSessionId, 128) ||
    !absolutePath(value.sessionFile) || !absolutePath(value.parentSessionFile) || !absolutePath(value.cwd) ||
    (value.isolation !== "off" && value.isolation !== "worktree") ||
    typeof value.isolated !== "boolean" || typeof value.supervisorQuestions !== "boolean" ||
    (value.excludeTools !== undefined && (!Array.isArray(value.excludeTools) || value.excludeTools.length > 128 ||
      !value.excludeTools.every(name => bounded(name, 256))))) return undefined;
  let worktree: WorktreeInfo | undefined;
  if (value.worktree !== undefined) {
    const wt = value.worktree;
    if (!record(wt) || !absolutePath(wt.path) || !absolutePath(wt.workPath) || !absolutePath(wt.repoRoot) ||
      !bounded(wt.branch, 256) || !bounded(wt.baseSha, 128)) return undefined;
    worktree = { path: wt.path, workPath: wt.workPath, repoRoot: wt.repoRoot, branch: wt.branch, baseSha: wt.baseSha };
  }
  if ((value.isolation === "worktree") !== (worktree !== undefined)) return undefined;
  const route = parseReopenRoute(value.route);
  return {
    version: 1, handle: value.handle, sessionFile: value.sessionFile, sessionId: value.sessionId,
    leafId: value.leafId, rootSessionId: value.rootSessionId, parentSessionFile: value.parentSessionFile,
    cwd: value.cwd, isolation: value.isolation, isolated: value.isolated, supervisorQuestions: value.supervisorQuestions,
    ...(Array.isArray(value.excludeTools) ? { excludeTools: [...value.excludeTools] as string[] } : {}),
    ...(worktree ? { worktree } : {}),
    ...(route ? { route } : {}),
  };
}

/** Capture only a real native child belonging to this parent, never a managed/nested run. */
export function captureAgentReopenMetadata(agent: AgentRecord): AgentReopenMetadata | undefined {
  if (agent.owner || agent.parentAgentId || !agent.reopen) return undefined;
  // A cold run cancelled while queued has not opened or changed the child.
  // Its terminal receipt must retain the original leaf rather than erase it.
  if (!agent.session) return parseAgentReopenMetadata(agent.reopen);
  const manager = agent.session.sessionManager;
  const leafId = manager.getLeafId();
  if (!leafId) return undefined;
  // A live model change cannot mint a new route proof for the old history.
  const route = sameReopenRoute(agent.reopen.route, captureReopenRoute(agent.session.model)) ? agent.reopen.route : undefined;
  return parseAgentReopenMetadata({ ...agent.reopen, leafId, route });
}

/**
 * One native writer, across manager activations and processes. No timeout can
 * prove a provider stopped, so orphaned crash leases require explicit recovery.
 */
export function acquireAgentSessionLease(sessionFile: string): () => void {
  const path = `${sessionFile}.subagents-lock`;
  let descriptor: number;
  try { descriptor = openSync(path, "wx", 0o600); } catch {
    throw new Error(`Child session is reserved by another instance or an orphaned lease: ${path}. Wait for/close the owning agent. If its process has exited, inspect the lease and remove it explicitly before retrying; never remove a live owner's lease.`);
  }
  const identity = fstatSync(descriptor);
  try { writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token: randomUUID() })); } finally { closeSync(descriptor); }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const current = lstatSync(path);
      if (current.isFile() && current.dev === identity.dev && current.ino === identity.ino) unlinkSync(path);
    } catch { /* A missing/replaced lease cannot authorize deleting another owner's file. */ }
  };
}

/** Verify native ownership and the exact saved child leaf, before loading any child resources. */
export function validateAgentReopen(entry: ResumableAgentEntry, ctx: ExtensionContext): void {
  const receipt = parseAgentReopenMetadata(entry.reopen);
  if (!receipt) throw new Error("This saved agent has no supported reopen receipt. Start a new Agent with a sanitized task summary.");
  const parentFile = ctx.sessionManager.getSessionFile();
  if (receipt.rootSessionId !== ctx.sessionManager.getSessionId() || !parentFile ||
    realpathSync(parentFile) !== realpathSync(receipt.parentSessionFile)) {
    throw new Error("Saved agent belongs to another parent session; cross-parent continuation is not supported. Start a new Agent.");
  }
  let child: SessionManager;
  try {
    const file = lstatSync(receipt.sessionFile);
    if (!file.isFile() || file.size === 0) throw new Error("not a nonempty regular session file");
    if (realpathSync(receipt.sessionFile) === realpathSync(parentFile)) throw new Error("parent is not a child session");
    child = SessionManager.open(receipt.sessionFile);
  } catch (error) {
    throw new Error(`Cannot reopen saved child session: ${error instanceof Error ? error.message : String(error)}. Restore its original session file or start a new Agent.`);
  }
  const header = child.getHeader();
  if (!header || header.id !== receipt.sessionId || !header.parentSession ||
    realpathSync(header.parentSession) !== realpathSync(parentFile) || header.cwd !== receipt.cwd ||
    child.getLeafId() !== receipt.leafId) {
    throw new Error("Saved child ownership or leaf is stale/mismatched. Return to its latest owning branch or start a new Agent; no history was replayed.");
  }
  const identities = child.getEntries().filter(item => item.type === "custom" && item.customType === CHILD_IDENTITY_ENTRY_TYPE);
  if (identities.length !== 1) throw new Error("Saved child has missing or ambiguous native ownership metadata. Start a new Agent.");
  const identity = identities[0];
  const data = identity.type === "custom" ? identity.data : undefined;
  if (!record(data) || data.id !== entry.id || data.type !== entry.type || data.rootSessionId !== receipt.rootSessionId ||
    data.parentSessionFile !== receipt.parentSessionFile || data.handle !== receipt.handle || data.cwd !== receipt.cwd || data.isolation !== receipt.isolation ||
    data.isolated !== receipt.isolated || data.supervisorQuestions !== receipt.supervisorQuestions ||
    JSON.stringify(data.excludeTools) !== JSON.stringify(receipt.excludeTools)) {
    throw new Error("Saved child is foreign or managed, not this ordinary agent. Use its owner's recovery controls or start a new Agent.");
  }
  if (receipt.worktree) {
    const nativeWorktree = data.worktree;
    if (!record(nativeWorktree) || ["path", "workPath", "repoRoot", "branch", "baseSha"].some(key =>
      nativeWorktree[key] !== Reflect.get(receipt.worktree!, key)) ||
      ![receipt.worktree.path, receipt.worktree.workPath].some(path => path === receipt.cwd)) {
      throw new Error("Saved isolation metadata does not match the original native child checkout. Restore its original checkout or start a new isolated Agent.");
    }
  } else if (data.worktree !== undefined) {
    throw new Error("Saved continuation cannot downgrade the native child's worktree isolation. Restore its original checkout or start a new Agent.");
  }
  assertSafeChildSession({ messages: [], sessionManager: child });
  if (!receipt.route || !sameReopenRoute(receipt.route, parseReopenRoute(data.route))) {
    throw new Error("Saved child has missing or mismatched native route proof. Start a fresh Agent with inherit_context: false and an explicitly sanitized task summary.");
  }
  assertPlainReopenHistory(child, receipt.route);
}
