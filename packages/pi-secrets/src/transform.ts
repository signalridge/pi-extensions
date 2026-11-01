import type { ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";

type AgentMessage = ContextWithSystemEvent["messages"][number];
type MessageOf<Role extends AgentMessage["role"]> = Extract<AgentMessage, { role: Role }>;
type AssistantBlock = MessageOf<"assistant">["content"][number];
type TextLike = { type: string; text?: unknown };

export type TextMap = (text: string) => string;

/** Copy-on-write map over every string in a JSON value; returns the input when nothing changed. */
export function mapJsonStrings(value: unknown, map: TextMap): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const mapped = mapJsonStrings(item, map);
      if (mapped !== item) changed = true;
      return mapped;
    });
    return changed ? next : value;
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const mapped = mapJsonStrings(item, map);
      if (mapped !== item) changed = true;
      next[key] = mapped;
    }
    return changed ? next : value;
  }
  return value;
}

/**
 * Rewrite strings in place, deeply. Tool-call input must keep its identity:
 * Pi executes the object it handed to `tool_call` handlers.
 */
export function mapStringsInPlace(value: unknown, map: TextMap, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const item = record[key];
    if (typeof item === "string") {
      const mapped = map(item);
      if (mapped !== item) record[key] = mapped;
    } else {
      mapStringsInPlace(item, map, seen);
    }
  }
}

function mapTextParts<Part extends TextLike>(parts: readonly Part[], map: TextMap): readonly Part[] {
  let changed = false;
  const next = parts.map((part) => {
    if (part.type !== "text" || typeof part.text !== "string") return part;
    const text = map(part.text);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });
  return changed ? next : parts;
}

function mapContent<Part extends TextLike>(content: string | readonly Part[], map: TextMap): string | readonly Part[] {
  return typeof content === "string" ? map(content) : mapTextParts(content, map);
}

function mapAssistantBlock(block: AssistantBlock, map: TextMap): AssistantBlock {
  switch (block.type) {
    case "text": {
      const text = map(block.text);
      return text === block.text ? block : { ...block, text };
    }
    case "thinking": {
      if (block.redacted) return block;
      const thinking = map(block.thinking);
      // A signature covers the original bytes; replaying it over rewritten text is invalid.
      return thinking === block.thinking ? block : { ...block, thinking, thinkingSignature: undefined };
    }
    case "toolCall": {
      const args = mapJsonStrings(block.arguments, map) as typeof block.arguments;
      return args === block.arguments ? block : { ...block, arguments: args, thoughtSignature: undefined };
    }
    default:
      return block;
  }
}

/** Rewrite one message; system messages and unknown roles are returned unchanged. */
export function mapMessage(message: AgentMessage, map: TextMap): AgentMessage {
  switch (message.role) {
    case "user": {
      const content = mapContent(message.content, map);
      return content === message.content ? message : ({ ...message, content } as AgentMessage);
    }
    case "custom": {
      const content = mapContent(message.content, map);
      return content === message.content ? message : ({ ...message, content } as AgentMessage);
    }
    case "toolResult": {
      const content = mapTextParts(message.content, map);
      return content === message.content ? message : ({ ...message, content } as AgentMessage);
    }
    case "assistant": {
      let changed = false;
      const content = message.content.map((block) => {
        const mapped = mapAssistantBlock(block, map);
        if (mapped !== block) changed = true;
        return mapped;
      });
      return changed ? { ...message, content } : message;
    }
    case "bashExecution": {
      const command = map(message.command);
      const output = map(message.output);
      return command === message.command && output === message.output ? message : { ...message, command, output };
    }
    case "branchSummary":
    case "compactionSummary": {
      const summary = map(message.summary);
      return summary === message.summary ? message : { ...message, summary };
    }
    default:
      return message;
  }
}

/** Rewrite a request transcript without touching the input array or its messages. */
export function mapMessages(
  messages: readonly AgentMessage[],
  map: TextMap,
): { messages: AgentMessage[]; changed: boolean } {
  let changed = false;
  const next = messages.map((message) => {
    const mapped = mapMessage(message, map);
    if (mapped !== message) changed = true;
    return mapped;
  });
  return { messages: next, changed };
}
