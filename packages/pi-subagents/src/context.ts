/**
 * context.ts — Extract parent conversation context for subagent inheritance.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ProjectedMessage = ReturnType<ExtensionContext["sessionManager"]["buildSessionProjection"]>["messages"][number];

const HEADER = `# Parent Conversation Context
The following is the conversation history from the parent session that spawned you.
Use this context to understand what has been discussed and decided so far.

`;
const FOOTER = `

---
# Your Task (below)
`;
const MAX_CONTEXT_CHARS = 32_000;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_TOOL_CHARS = 2_000;
const CLIPPED = "...[truncated]...";

/** Extract text from a message content block array. */
export function extractText(content: unknown[]): string {
  return content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text ?? "")
    .join("\n");
}

/** Clip without first joining or copying arbitrarily large tool outputs. */
function clipText(text: string, limit: number, preserveTail = false): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  if (limit <= CLIPPED.length) return text.slice(-limit);
  const available = limit - CLIPPED.length;
  if (preserveTail) {
    const head = Math.min(300, Math.floor(available / 3));
    return `${text.slice(0, head)}${CLIPPED}${text.slice(-(available - head))}`;
  }
  return `${text.slice(0, available)}${CLIPPED}`;
}

function boundedContent(content: string | unknown[], limit: number, preserveTail = false): string {
  if (typeof content === "string") return clipText(content, limit, preserveTail).trim();
  // Inspect each block only up to the remaining budget, never join a full tool
  // result just to discard it. Reverse order retains failure/truncation tails.
  const selected: string[] = [];
  let remaining = limit;
  for (let i = 0; i < content.length && remaining > 0; i++) {
    const block = content[preserveTail ? content.length - 1 - i : i];
    if (typeof block !== "object" || block === null || !("type" in block) || block.type !== "text" ||
        !("text" in block) || typeof block.text !== "string") continue;
    const text = clipText(block.text, remaining, preserveTail);
    selected.push(text);
    remaining -= text.length + 1;
  }
  const joined = (preserveTail ? selected.reverse() : selected).join("\n");
  return clipText(joined, limit, preserveTail).trim();
}

/** Include shell commands shown to the model, with their outcome even on huge output. */
function boundedBash(msg: Extract<ProjectedMessage, { role: "bashExecution" }>): string {
  const command = clipText(msg.command, 200);
  const outcome = msg.cancelled ? "\n\n(command cancelled)"
    : msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0
      ? `\n\nCommand exited with code ${msg.exitCode}` : "";
  const truncation = msg.truncated && msg.fullOutputPath
    ? `\n\n[Output truncated. Full output: ${clipText(msg.fullOutputPath, 200)}]` : "";
  const prefix = `Ran \`${command}\`\n`;
  const suffix = `${outcome}${truncation}`;
  const remaining = Math.max(0, MAX_TOOL_CHARS - prefix.length - suffix.length - 8);
  const output = msg.output
    ? `\`\`\`\n${clipText(msg.output, remaining, msg.cancelled || msg.truncated || msg.exitCode !== 0)}\n\`\`\``
    : "(no output)";
  return `${prefix}${output}${suffix}`;
}

/**
 * Build a text representation of the parent conversation context. The child
 * still needs room for its own prompt, tools and answer, so inherited context
 * is at most one character per four context tokens (also capped for large
 * models). This is conservative even for one-character-per-token content.
 */
export function buildParentContext(ctx: ExtensionContext, childContextWindow = ctx.model?.contextWindow): string {
  const window = childContextWindow && Number.isFinite(childContextWindow) && childContextWindow > 0
    ? childContextWindow : 128_000;
  const budget = Math.max(0, Math.min(MAX_CONTEXT_CHARS, Math.floor(window / 4)) - HEADER.length - FOOTER.length);
  if (!budget) return "";
  const entries: { position: number; order: number; text: string }[] = [];
  let used = 0;
  const add = (position: number, order: number, label: string, content: string | unknown[], limit: number, tail = false): void => {
    const room = Math.min(limit, budget - used - label.length - (entries.length ? 2 : 0));
    if (room <= 0) return;
    const text = boundedContent(content, room, tail);
    if (!text) return;
    entries.push({ position, order, text: `${label}${text}` });
    used += label.length + text.length + (entries.length > 1 ? 2 : 0);
  };

  const sessionManager = ctx.sessionManager;
  // Older Pi has no provenance-preserving projection, but buildSessionContext
  // still applies compaction and branch selection. Its messages are precisely
  // what the host sends to the model; getBranch() includes summarized raw turns.
  const legacyManager = sessionManager as typeof sessionManager & {
    buildSessionContext(): { messages: ProjectedMessage[] };
  };
  const projected: ProjectedMessage[][] = typeof sessionManager.buildSessionProjection === "function"
    ? sessionManager.buildSessionProjection().entries.map((entry) => entry.messages)
    : legacyManager.buildSessionContext().messages.map((message) => [message]);
  // Reserve up to a quarter for recent summaries before spending the rest on
  // recent turns. A long tool result must not evict the only compaction summary.
  const summaryLimit = Math.floor(budget / 4);
  for (let i = projected.length - 1; i >= 0 && used < summaryLimit; i--) {
    for (let j = projected[i].length - 1; j >= 0 && used < summaryLimit; j--) {
      const msg = projected[i][j];
      if (msg.role === "compactionSummary" || msg.role === "branchSummary") {
        add(i, j, "[Summary]: ", msg.summary, summaryLimit - used, true);
      }
    }
  }
  for (let i = projected.length - 1; i >= 0 && used < budget; i--) {
    for (let j = projected[i].length - 1; j >= 0 && used < budget; j--) {
      const msg = projected[i][j];
      if (msg.role === "bashExecution") {
        if (!msg.excludeFromContext) add(i, j, "[Bash Execution]: ", boundedBash(msg), MAX_TOOL_CHARS);
      } else if (msg.role === "user" || msg.role === "assistant" || msg.role === "custom" || msg.role === "toolResult") {
        // Provider transforms omit failed assistant attempts; a pure utility
        // should not render them as successful model-visible context.
        if (msg.role === "assistant" && (msg.stopReason === "error" || msg.stopReason === "aborted")) continue;
        const label = msg.role === "toolResult" ? `[Tool Result (${msg.toolName})]: `
          : msg.role === "custom" ? "[Context]: " : msg.role === "user" ? "[User]: " : "[Assistant]: ";
        add(i, j, label, msg.content, msg.role === "toolResult" ? MAX_TOOL_CHARS : MAX_MESSAGE_CHARS, msg.role === "toolResult");
      }
      // System messages are supplied by the child's own prompt policy.
    }
  }

  if (entries.length === 0) return "";
  entries.sort((a, b) => a.position - b.position || a.order - b.order);
  return `${HEADER}${entries.map((entry) => entry.text).join("\n\n")}${FOOTER}`;
}
