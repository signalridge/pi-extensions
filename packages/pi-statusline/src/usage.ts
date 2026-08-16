import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

export interface FooterUsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  latestCacheHitRate?: number;
}

export function emptyFooterUsageSummary(): FooterUsageSummary {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
}

function usageForEntry(entry: SessionEntry): { usage: UsageLike; assistant: boolean } | undefined {
  if (entry.type === "message" && entry.message.role === "assistant" && entry.message.usage) {
    return { usage: entry.message.usage, assistant: true };
  }
  if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
    return { usage: entry.message.usage, assistant: false };
  }
  if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
    return { usage: entry.usage, assistant: false };
  }
  return undefined;
}

function usageForMessage(message: AgentMessage): { usage: UsageLike; assistant: boolean } | undefined {
  if (message.role === "assistant" && message.usage) return { usage: message.usage, assistant: true };
  if (message.role === "toolResult" && message.usage) return { usage: message.usage, assistant: false };
  return undefined;
}

interface Contribution extends FooterUsageSummary {
  assistant: boolean;
}

function contribution(usage: UsageLike, assistant: boolean): Contribution {
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const promptTokens = input + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost: usage.cost?.total ?? 0,
    latestCacheHitRate: assistant && promptTokens > 0 ? (cacheRead / promptTokens) * 100 : undefined,
    assistant,
  };
}

function addContribution(target: FooterUsageSummary, value: Contribution, direction: 1 | -1): void {
  target.input += direction * value.input;
  target.output += direction * value.output;
  target.cacheRead += direction * value.cacheRead;
  target.cacheWrite += direction * value.cacheWrite;
  target.cost += direction * value.cost;
}

/**
 * Runtime-owned usage state for the footer. Rebuilding is intentionally
 * explicit at session/tree/compaction boundaries; normal rendering reads only
 * the immutable-looking snapshot and never scans session history.
 */
export class FooterUsageAccumulator {
  private summary: FooterUsageSummary = emptyFooterUsageSummary();
  private readonly messageContributions = new Map<string, Contribution>();
  private readonly objectKeys = new WeakMap<object, string>();
  private nextObjectKey = 0;
  private anonymousAssistantKey = "assistant:anonymous:0";
  private turnKey = "turn:0";
  private nextTurn = 0;

  reset(entries: readonly SessionEntry[]): void {
    this.summary = emptyFooterUsageSummary();
    this.messageContributions.clear();
    this.anonymousAssistantKey = "assistant:anonymous:0";
    this.nextObjectKey = 0;
    this.turnKey = "turn:0";
    this.nextTurn = 0;
    let lastAnonymousAssistantKey: string | undefined;
    let sessionMessageIndex = 0;
    for (const entry of entries) {
      if (entry.type === "message") {
        if (entry.message.role === "assistant") this.turnKey = `session-turn:${sessionMessageIndex}`;
        const key = this.sessionMessageKey(entry.message, sessionMessageIndex);
        if (key && entry.message.role === "assistant" && !entry.message.responseId) {
          lastAnonymousAssistantKey = key;
        }
        this.updateMessage(entry.message, key);
        sessionMessageIndex += 1;
        continue;
      }
      const value = usageForEntry(entry);
      if (value) addContribution(this.summary, contribution(value.usage, value.assistant), 1);
    }
    if (lastAnonymousAssistantKey) this.anonymousAssistantKey = lastAnonymousAssistantKey;
  }

  /** Start a stable fallback identity for an assistant turn without responseId. */
  beginTurn(): void {
    this.turnKey = `turn:${++this.nextTurn}`;
    this.anonymousAssistantKey = `assistant:anonymous:${this.nextTurn}`;
  }

  updateMessage(message: AgentMessage, keyOverride?: string): void {
    const value = usageForMessage(message);
    if (!value) return;
    const key = keyOverride ?? this.messageKey(message);
    const next = contribution(value.usage, value.assistant);
    const previous = this.messageContributions.get(key);
    if (previous) addContribution(this.summary, previous, -1);
    addContribution(this.summary, next, 1);
    this.messageContributions.set(key, next);
    if (value.assistant) {
      this.summary.latestCacheHitRate = next.latestCacheHitRate;
    }
  }

  updateTurn(message: AgentMessage, toolResults: readonly AgentMessage[]): void {
    this.updateMessage(message);
    for (const toolResult of toolResults) this.updateMessage(toolResult);
  }

  private sessionMessageKey(message: AgentMessage, index: number): string | undefined {
    return message.role === "assistant" && !message.responseId && typeof message.timestamp !== "number"
      ? `session:${index}`
      : undefined;
  }

  snapshot(): FooterUsageSummary {
    return { ...this.summary };
  }

  private messageKey(message: AgentMessage): string {
    if (message.role === "assistant" && message.responseId) {
      return `assistant:${message.provider}:${message.api}:${message.model}:${message.responseId}`;
    }
    if (message.role === "assistant" && typeof message.timestamp === "number") {
      return `assistant:${message.provider}:${message.api}:${message.model}:timestamp:${message.timestamp}`;
    }
    if (message.role === "assistant") return this.anonymousAssistantKey;
    if (message.role === "toolResult" && message.toolCallId) return `tool:${this.turnKey}:${message.toolCallId}`;
    if (typeof message !== "object" || message === null) return `message:${String(message)}`;
    const existing = this.objectKeys.get(message);
    if (existing) return existing;
    const key = `message:${++this.nextObjectKey}`;
    this.objectKeys.set(message, key);
    return key;
  }
}

export function summarizeFooterUsage(entries: readonly SessionEntry[]): FooterUsageSummary {
  const totals = emptyFooterUsageSummary();

  for (const entry of entries) {
    const value = usageForEntry(entry);
    if (!value) continue;
    const current = contribution(value.usage, value.assistant);
    addContribution(totals, current, 1);
    if (current.assistant) totals.latestCacheHitRate = current.latestCacheHitRate;
  }

  return totals;
}
