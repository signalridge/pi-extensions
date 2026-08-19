/**
 * agent-mention.ts — what `@` can address, and the suggestions pi renders for it.
 *
 * A subagent is addressable whether or not it is currently running: a live
 * record is messaged or resumed, an evicted one whose session is still on disk
 * is reopened, and an agent *type* with no instance at all is started. That is
 * the point of the handle — `@explore` means the Explore agent, not "the
 * Explore process that happens to exist right now" — so the roster below unions
 * all three, and the dispatcher and the popup read the same list.
 *
 * pi's `CombinedAutocompleteProvider` already owns `@`, where it means "attach a
 * file". Extensions can wrap it (`ctx.ui.addAutocompleteProvider`), so this
 * provider answers the `@` tokens that name an agent and delegates every other
 * one — including all of `applyCompletion`, whose `@`-branch already inserts
 * `item.value` plus a trailing space, which is exactly what a handle needs.
 *
 * Matching is case-insensitive prefix (not fuzzy), and when any agent matches,
 * files are dropped from the list rather than mixed in — an `@name` that names
 * an agent is never also a path.
 *
 * Every string that reaches a row passes through `sanitizeDisplayText` first:
 * an agent description comes from a `.pi/agents/*.md` file that may not be
 * trustworthy, and the popup draws into the user's terminal.
 */

import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.js";
import { handleBase, MENTION_TRIGGER } from "../mention.js";
import type { AgentRecordSnapshot, ResumableAgentEntry } from "../types.js";
import { sanitizeDisplayText, truncateCodePoints } from "./safe-text.js";

/**
 * One thing `@` can address, and what sending to it will do. `typeLabel` is the
 * agent's `display_name`, resolved by the caller: this module stays independent
 * of the type registry, but the popup must agree with FleetView and the widget,
 * which both render the label rather than the raw type.
 */
export type MentionTarget =
  | { kind: "record"; handle: string; record: AgentRecordSnapshot; typeLabel: string }
  | { kind: "resumable"; handle: string; entry: ResumableAgentEntry; typeLabel: string }
  | { kind: "type"; handle: string; type: string; description: string };

/** The registry facts the roster needs, so it stays independent of agent-types. */
export type TypeInfo = { name: string; description: string };

/**
 * Everything `@` can reach, in the order the popup lists it: steerable agents
 * first, then the other live ones earliest-launched, then evicted conversations
 * that can be reopened, then agent types with no live instance. A type whose
 * handle a record already holds is omitted — that name addresses the existing
 * agent, which is what makes `@explore` mean "message the one that's running"
 * and only otherwise "start one".
 */
export function mentionRoster(
  manager: AgentManager,
  types: readonly TypeInfo[],
  // Identity by default: a caller with no registry to consult gets the raw
  // type, which is also what the config lookup falls back to when no label is set.
  displayNameOf: (type: string) => string = (type) => type,
): MentionTarget[] {
  const isLive = (r: AgentRecordSnapshot) => r.status === "running" || r.status === "queued";
  const records = manager
    .listAgents()
    .filter((r) => r.handle !== undefined && r.parentAgentId === undefined)
    .sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || a.startedAt - b.startedAt);

  const taken = new Set<string>();
  const targets: MentionTarget[] = [];

  for (const record of records) {
    const handle = record.handle as string;
    taken.add(handle.toLowerCase());
    targets.push({ kind: "record", handle, record, typeLabel: displayNameOf(record.type) });
  }

  // Then agents that are gone but whose conversation can be reopened. After the
  // live ones: a running agent is the likelier target, and this keeps the
  // ordering "what exists now, then what can be brought back, then what can be
  // started".
  for (const entry of manager.listResumable()) {
    if (taken.has(entry.handle.toLowerCase())) continue;
    taken.add(entry.handle.toLowerCase());
    targets.push({ kind: "resumable", handle: entry.handle, entry, typeLabel: displayNameOf(entry.type) });
  }

  for (const type of types) {
    const handle = handleBase(type.name);
    if (taken.has(handle)) continue;
    taken.add(handle);
    targets.push({ kind: "type", handle, type: type.name, description: type.description });
  }
  return targets;
}

export function createMentionProvider(
  current: AutocompleteProvider,
  roster: () => MentionTarget[],
  isEnabled: () => boolean,
): AutocompleteProvider {
  return {
    // Only `@` — the contract is "characters that should naturally trigger THIS
    // provider", and pi unions each wrapper's own set onto the outermost one
    // itself, so re-declaring the wrapped provider's characters here would both
    // misreport us and duplicate that.
    triggerCharacters: ["@"],

    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const items = isEnabled() ? mentionItems(roster(), lines[cursorLine] ?? "", cursorCol) : null;
      if (items) return items;
      return current.getSuggestions(lines, cursorLine, cursorCol, options);
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

/** Suggestions for the `@…` token under the cursor, or null when it names no agent. */
export function mentionItems(
  roster: readonly MentionTarget[],
  line: string,
  cursorCol: number,
): AutocompleteSuggestions | null {
  const match = MENTION_TRIGGER.exec(line.slice(0, cursorCol));
  if (!match) return null;

  const typed = match[2].toLowerCase();
  const items: AutocompleteItem[] = [];
  for (const target of roster) {
    if (!target.handle.toLowerCase().startsWith(typed)) continue;
    items.push({ value: `@${target.handle}`, label: `@${target.handle}`, description: describeTarget(target) });
  }
  return items.length > 0 ? { items, prefix: `@${match[2]}` } : null;
}

/** Name the action that will actually happen, so the list never mispromises. */
function describeTarget(target: MentionTarget): string {
  if (target.kind === "type") return `start agent · ${summarize(target.description)}`;
  if (target.kind === "resumable") {
    // No status: the record is gone, and "completed" would imply one is still
    // being tracked. The type carries the identity the handle may not.
    return `resume · ${sanitizeDisplayText(target.typeLabel)} · ${summarize(target.entry.description)}`;
  }
  const { status, description } = target.record;
  const action = status === "running" || status === "queued" ? "send message" : "resume";
  return `${action} · ${status} · ${summarize(description)}`;
}

/**
 * First sentence of a description, sanitized then clipped — agent descriptions
 * run to paragraphs, and they come from files this extension did not write.
 * Sanitize BEFORE truncating: cutting first can sever an escape sequence and
 * leave a live introducer behind.
 */
function summarize(description: string): string {
  const first = (description.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? description).replace(/\s+/g, " ").trim();
  return truncateCodePoints(sanitizeDisplayText(first), 60, "…");
}
