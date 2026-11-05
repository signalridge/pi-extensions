import type { ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";

type AgentMessage = ContextWithSystemEvent["messages"][number];
type MessageOf<Role extends AgentMessage["role"]> = Extract<AgentMessage, { role: Role }>;
type AssistantBlock = MessageOf<"assistant">["content"][number];
type TextLike = { type: string; text?: unknown };

export type TextMap = (text: string) => string;

/** JSON looks up toJSON before enumerating data, even on unchanged objects. Never execute it. */
function rejectJsonHook(value: object): void {
  for (let owner: object | null = value; owner !== null; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, "toJSON");
    if (!descriptor) continue;
    if (!("value" in descriptor) || typeof descriptor.value === "function") {
      throw new Error("Non-data JSON serialization hook");
    }
    // An inert own value shadows any inherited hook and remains ordinary JSON data.
    return;
  }
}

/** Copy-on-write map over every string in a JSON value; returns the input when nothing changed. */
export function mapJsonStrings(value: unknown, map: TextMap): unknown {
  if (value !== null && (typeof value === "object" || typeof value === "function")) rejectJsonHook(value);
  if (typeof value === "string") return map(value);
  if (value !== null && typeof value === "object") {
    let changed = false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = descriptors[key];
      // JSON arrays include indexed data even when an index is non-enumerable.
      const jsonIndex = Array.isArray(value) && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length;
      if (!descriptor?.enumerable && !jsonIndex) continue;
      if (!descriptor || !("value" in descriptor)) throw new Error("Non-data JSON property");
      const mapped = mapJsonStrings(descriptor.value, map);
      if (mapped !== descriptor.value) changed = true;
      descriptor.value = mapped;
    }
    if (!changed) return value;
    // Define own properties, never assign: __proto__ is JSON data, not a setter.
    // Copy descriptors before definition so even frozen originals can be projected.
    const next = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
    return Object.defineProperties(next, descriptors);
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
      // Pi appends this path when converting truncated ! output to provider text.
      const fullOutputPath = message.fullOutputPath === undefined ? undefined : map(message.fullOutputPath);
      return command === message.command && output === message.output && fullOutputPath === message.fullOutputPath
        ? message
        : {
            ...message,
            command,
            output,
            ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
          };
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
