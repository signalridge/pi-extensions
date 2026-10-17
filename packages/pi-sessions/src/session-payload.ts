import type { SessionEntry } from "@earendil-works/pi-coding-agent";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function content(value: unknown): boolean {
  return (
    typeof value === "string" ||
    (Array.isArray(value) &&
      value.every((part: unknown) => {
        if (!record(part)) return false;
        switch (part.type) {
          case "text":
            return typeof part.text === "string";
          case "image":
            return typeof part.data === "string" && typeof part.mimeType === "string";
          case "thinking":
            return typeof part.thinking === "string";
          case "toolCall":
            return typeof part.id === "string" && typeof part.name === "string" && record(part.arguments);
          default:
            return false;
        }
      }))
  );
}
function arrayContent(value: unknown, kinds: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    content(value) &&
    value.every((part: unknown) => record(part) && typeof part.type === "string" && kinds.includes(part.type))
  );
}
function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}
function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}
function numericFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof value[field] === "number" && Number.isFinite(value[field]));
}
function usage(value: unknown): boolean {
  return (
    record(value) &&
    numericFields(value, ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) &&
    record(value.cost) &&
    numericFields(value.cost, ["input", "output", "cacheRead", "cacheWrite", "total"]) &&
    ["cacheWrite1h", "reasoning"].every((field) => value[field] === undefined || numericFields(value, [field]))
  );
}
function systemContent(value: unknown): boolean {
  return (
    typeof value === "string" ||
    (Array.isArray(value) &&
      value.every((part: unknown) => record(part) && part.type === "text" && typeof part.text === "string"))
  );
}

function systemMessage(value: unknown): boolean {
  return (
    record(value) &&
    value.role === "system" &&
    numericFields(value, ["timestamp"]) &&
    systemContent(value.content) &&
    (value.sections === undefined ||
      (record(value.sections) &&
        Object.values(value.sections).every((section) => section === null || typeof section === "string"))) &&
    (value.toolsAdded === undefined ||
      (Array.isArray(value.toolsAdded) &&
        value.toolsAdded.every(
          (tool: unknown) =>
            record(tool) &&
            typeof tool.name === "string" &&
            typeof tool.description === "string" &&
            record(tool.parameters),
        ))) &&
    (value.toolsRemoved === undefined ||
      (Array.isArray(value.toolsRemoved) &&
        value.toolsRemoved.every((tool: unknown) => record(tool) && typeof tool.name === "string")))
  );
}

/** Validate fields consumed by native restoration before disposing the source.
 * Arbitrary custom data/details remain opaque; this is not a provider schema. */
export function validateEntryPayload(value: Record<string, unknown>, byId: ReadonlyMap<string, SessionEntry>): void {
  let valid = false;
  switch (value.type) {
    case "message": {
      const message = value.message;
      if (!record(message) || !numericFields(message, ["timestamp"])) break;
      switch (message.role) {
        case "assistant":
          valid =
            arrayContent(message.content, ["text", "thinking", "toolCall"]) &&
            usage(message.usage) &&
            optionalString(message.errorMessage);
          break;
        case "toolResult":
          valid =
            arrayContent(message.content, ["text", "image"]) && (message.usage === undefined || usage(message.usage));
          break;
        case "user":
          valid = typeof message.content === "string" || arrayContent(message.content, ["text", "image"]);
          break;
        case "system":
          valid = systemMessage(message);
          break;
        case "custom":
          valid =
            typeof message.customType === "string" &&
            typeof message.display === "boolean" &&
            (typeof message.content === "string" || arrayContent(message.content, ["text", "image"]));
          break;
        case "bashExecution":
          valid =
            typeof message.command === "string" &&
            typeof message.output === "string" &&
            typeof message.cancelled === "boolean" &&
            typeof message.truncated === "boolean" &&
            optionalString(message.fullOutputPath) &&
            optionalBoolean(message.excludeFromContext) &&
            (message.exitCode === undefined ||
              (typeof message.exitCode === "number" && Number.isSafeInteger(message.exitCode)));
          break;
        case "branchSummary":
          valid =
            typeof message.summary === "string" && (message.fromId === null || typeof message.fromId === "string");
          break;
        case "compactionSummary":
          valid = typeof message.summary === "string" && numericFields(message, ["tokensBefore"]);
          break;
      }
      break;
    }
    case "context_edit": {
      const target = typeof value.targetId === "string" ? byId.get(value.targetId) : undefined;
      const editable =
        target?.type === "custom_message" ||
        (target?.type === "message" && ["user", "assistant", "toolResult"].includes(target.message.role));
      valid =
        editable && (value.replacement === null || (record(value.replacement) && content(value.replacement.content)));
      break;
    }
    case "model_change":
      valid = typeof value.provider === "string" && typeof value.modelId === "string";
      break;
    case "thinking_level_change":
      valid = typeof value.thinkingLevel === "string";
      break;
    case "usage":
      valid =
        typeof value.kind === "string" &&
        typeof value.provider === "string" &&
        typeof value.model === "string" &&
        usage(value.usage) &&
        optionalString(value.note);
      break;
    case "compaction":
      valid =
        typeof value.summary === "string" &&
        typeof value.firstKeptEntryId === "string" &&
        typeof value.tokensBefore === "number" &&
        Number.isFinite(value.tokensBefore) &&
        value.tokensBefore >= 0 &&
        (value.usage === undefined || usage(value.usage)) &&
        (value.systemMessage === undefined || systemMessage(value.systemMessage));
      break;
    case "branch_summary":
      valid =
        typeof value.summary === "string" &&
        typeof value.fromId === "string" &&
        (value.usage === undefined || usage(value.usage));
      break;
    case "custom":
      valid = typeof value.customType === "string";
      break;
    case "custom_message":
      valid = typeof value.customType === "string" && content(value.content) && typeof value.display === "boolean";
      break;
    case "label":
      valid = typeof value.targetId === "string" && optionalString(value.label);
      break;
    case "session_info":
      valid = optionalString(value.name);
      break;
  }
  if (!valid) throw new Error("Malformed native session payload");
}
