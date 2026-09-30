import type { AgentSession } from "@earendil-works/pi-coding-agent";

export const INHERIT_CONTEXT_UNAVAILABLE =
  "Raw `inherit_context: true` is unavailable on this Pi host: the parent context hooks run after the session projection, " +
  "and a child request cannot pin the same physical provider endpoint. Start a new Agent with `inherit_context: false` " +
  "and put an explicitly sanitized summary in its task prompt, or persist a context_edit before starting it.";

export const INHERITED_SESSION_UNSAFE =
  "This child session contains previously inherited parent history and cannot be resumed safely. " +
  "Start a new Agent session with `inherit_context: false` and an explicitly sanitized summary in its task prompt.";

export function assertNoRawInheritance(inheritContext: boolean | undefined): void {
  if (inheritContext === true) throw new Error(INHERIT_CONTEXT_UNAVAILABLE);
}

const PARENT_CONTEXT_MARKER = "# Parent Conversation Context\n";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasInheritedPrompt(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.inheritContext === true || value.inherit_context === true) return true;
  if (value.role === "user") {
    const content = value.content;
    if (typeof content === "string") return content.includes(PARENT_CONTEXT_MARKER);
    if (Array.isArray(content)) return content.some((block) =>
      isRecord(block) && block.type === "text" &&
      typeof block.text === "string" && block.text.includes(PARENT_CONTEXT_MARKER));
  }
  return false;
}

/** Guard both the live view and the un-compacted journal before any new prompt. */
export function assertSafeChildSession(
  session: Pick<AgentSession, "messages" | "sessionManager">,
  inheritedMetadata = false,
): void {
  if (inheritedMetadata) throw new Error(INHERITED_SESSION_UNSAFE);
  const manager = session.sessionManager;
  const entries = manager?.getEntries?.() ?? manager?.getBranch?.() ?? [];
  if (entries.some((entry: unknown) => isRecord(entry) &&
    (hasInheritedPrompt(entry) || hasInheritedPrompt(entry.message) ||
      hasInheritedPrompt(entry.data) ||
      (isRecord(entry.data) && hasInheritedPrompt(entry.data.invocation)) ||
      (isRecord(entry.message) && hasInheritedPrompt(entry.message.metadata))))) {
    throw new Error(INHERITED_SESSION_UNSAFE);
  }
  if (session.messages?.some((message: unknown) => hasInheritedPrompt(message) ||
    (isRecord(message) && hasInheritedPrompt(message.metadata)))) {
    throw new Error(INHERITED_SESSION_UNSAFE);
  }
}
