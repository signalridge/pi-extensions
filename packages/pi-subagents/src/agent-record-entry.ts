/**
 * agent-record-entry.ts — the `subagents:record` session entry a finished
 * top-level agent leaves behind, and `get_subagent_result`'s reader for it.
 *
 * The live record is evicted about ten minutes after the agent finishes, read
 * or not, and is gone after a reload. Its completion notification carries only
 * a preview and points at `get_subagent_result` for the rest, so that answer
 * has to outlive the record.
 */

import { parseAgentReopenMetadata } from "./agent-reopen.js";
import type { ResumableAgentEntry } from "./types.js";

/** `customType` of the session entry a finished top-level agent appends. */
export const AGENT_RECORD_ENTRY_TYPE = "subagents:record";

/** The persisted fields `get_subagent_result` reads back. Writers add more. */
export interface SavedAgentRecord {
  id: string;
  type: string;
  description: string;
  status: string;
  result?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

/** Every status a terminal record can be saved with, including recovered managed runs. */
const SAVED_STATUSES = new Set(["completed", "steered", "aborted", "stopped", "error", "interrupted"]);

const optionalString = (value: unknown): boolean => value === undefined || typeof value === "string";

/**
 * Any extension can append an entry with this `customType`, so only a
 * well-formed terminal record is answered from; anything else is not found.
 */
function isSavedAgentRecord(data: unknown): data is SavedAgentRecord {
  if (typeof data !== "object" || data === null) return false;
  const { id, type, description, status, result, error, startedAt, completedAt } = data as Record<string, unknown>;
  return typeof id === "string" && id.length > 0 && typeof type === "string" && typeof description === "string" &&
    typeof status === "string" && SAVED_STATUSES.has(status) && optionalString(result) && optionalString(error) &&
    typeof startedAt === "number" && Number.isFinite(startedAt) &&
    (completedAt === undefined || (typeof completedAt === "number" && Number.isFinite(completedAt)));
}

/**
 * The latest saved record of agent `id` on the current branch. A resumed agent
 * appends a new entry on each finish, so the last one wins; an entry on an
 * abandoned branch is not this conversation's.
 */
export function findSavedAgentRecord(branch: readonly unknown[], id: string): SavedAgentRecord | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index] as { type?: unknown; customType?: unknown; data?: unknown } | null;
    if (entry?.type !== "custom" || entry.customType !== AGENT_RECORD_ENTRY_TYPE) continue;
    if (isSavedAgentRecord(entry.data) && entry.data.id === id) return entry.data;
  }
  return undefined;
}

/** Latest eligible ordinary receipts only, bounded like the live eviction index. */
export function savedResumableAgents(branch: readonly unknown[], rootSessionId: string): ResumableAgentEntry[] {
  const seen = new Set<string>();
  const entries: ResumableAgentEntry[] = [];
  for (let index = branch.length - 1; index >= 0 && entries.length < 128; index--) {
    const item = branch[index] as { type?: unknown; customType?: unknown; data?: unknown } | null;
    if (item?.type !== "custom" || item.customType !== AGENT_RECORD_ENTRY_TYPE ||
      typeof item.data !== "object" || item.data === null) continue;
    const data = item.data as Record<string, unknown>;
    if (typeof data.id !== "string" || seen.has(data.id)) continue;
    seen.add(data.id); // A later unsupported receipt must invalidate an earlier one.
    if (!isSavedAgentRecord(data) || data.owner !== undefined || data.parentAgentId !== undefined ||
      !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(data.id) || data.type.length > 256 || data.description.length > 1_000) continue;
    const reopen = parseAgentReopenMetadata(data.reopen);
    if (!reopen || reopen.rootSessionId !== rootSessionId) continue;
    entries.push({ id: data.id, type: data.type, description: data.description,
      handle: reopen.handle, sessionFile: reopen.sessionFile, completedAt: data.completedAt ?? data.startedAt, reopen });
  }
  return entries;
}
