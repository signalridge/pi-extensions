/**
 * ask-tools.ts — `ask_tools:`, the third answer between allow and deny.
 *
 * `tools:` and `disallowed_tools:` are static: a tool is available for the whole
 * run or never. That forces a bad choice for the tools that are usually fine and
 * occasionally not — grant `bash` and hope, or withhold it and cripple the
 * agent. `ask_tools:` names tools whose first call needs a person's approval
 * for the current in-memory child, including resumed turns. A reopened child
 * gets a new gate and must ask again.
 *
 * The approver is the HUMAN, deliberately. Upstream projects put an LLM in this
 * seat because their subagents run headless in another process and cannot reach
 * a person; ours share the parent's `ExtensionContext`, so a real approver is
 * one dialog away. Asking a model whether a model should be allowed to do
 * something is a security regression wherever a person is reachable, so this
 * module contains no arbitrator — only the rule vocabulary and a prompt.
 */

import { sanitizeDisplayText, truncateCodePoints } from "./ui/safe-text.js";

/** Longest tool-argument preview shown in the approval prompt. */
const MAX_PREVIEW = 300;

export interface AskGateDecision {
  block: true;
  reason: string;
}

export interface AskGateContext {
  /** Tool names requiring approval. Matched case-insensitively. */
  askTools: readonly string[];
  /** Prompt the human. Omitted when no human can be reached. */
  confirm?: (title: string, message: string) => Promise<boolean>;
  /** Display name of the agent asking, for the prompt. */
  agentLabel: string;
}

/**
 * Build the session-scoped approval gate, or `undefined` when nothing needs asking.
 *
 * Returns a function that resolves to a block decision when the call must not
 * proceed, and `undefined` when it may.
 */
export function createAskGate(
  context: AskGateContext,
): ((toolName: string, input: unknown) => Promise<AskGateDecision | undefined>) | undefined {
  const gated = new Set(context.askTools.map((name) => name.trim().toLowerCase()).filter(Boolean));
  if (gated.size === 0) return undefined;

  /** Tools approved for this in-memory child; never persisted on disk. */
  const approvedForRun = new Set<string>();
  const pendingApprovals = new Map<string, Promise<{ approved: boolean; failed: boolean }>>();

  return async (toolName, input) => {
    const key = toolName.toLowerCase();
    if (!gated.has(key)) return undefined;
    if (approvedForRun.has(key)) return undefined;

    // No approver, no approval. Failing OPEN here would silently delete the
    // rule the user wrote — the one case where it matters most is the one where
    // nobody is watching. A headless run of an agent with `ask_tools:` is
    // therefore refused, with a reason that says how to fix it.
    if (!context.confirm) {
      return {
        block: true,
        reason:
          `Tool "${toolName}" requires approval (ask_tools), and there is no interactive session to approve it. ` +
          "Run this agent interactively, or move the tool to `tools:`/`disallowed_tools:` to decide it statically.",
      };
    }

    // Parallel first calls share one decision for this tool. Otherwise the
    // second dialog can be declined after the first one granted the same
    // session-wide permission, making the two answers contradictory.
    let pending = pendingApprovals.get(key);
    if (!pending) {
      const confirm = context.confirm;
      pending = Promise.resolve()
        .then(() => confirm(
          `${context.agentLabel} wants to use ${toolName}`,
          `Current call: ${describeInput(input)}\n\nAllow ${toolName} for this in-memory agent session, including resumed turns? Later calls in this session will not ask again. Reopening the child from disk or restarting Pi will ask again.`,
        ))
        .then((approved) => ({ approved, failed: false }), () => ({ approved: false, failed: true }));
      pendingApprovals.set(key, pending);
      const decision = pending;
      void decision.then(() => {
        if (pendingApprovals.get(key) === decision) pendingApprovals.delete(key);
      });
    }

    const { approved, failed } = await pending;
    if (!approved) {
      return {
        block: true,
        reason: failed
          ? `Tool "${toolName}" requires approval (ask_tools) and the prompt could not be shown.`
          : `The user declined the "${toolName}" call. Do not retry it; continue without that tool or explain what you cannot do.`,
      };
    }
    // Re-asking on every call of a tool the user just allowed trains them to
    // approve without reading, which is how an approval prompt stops working.
    approvedForRun.add(key);
    return undefined;
  };
}

/**
 * One-line, bounded, inert rendering of a tool call's arguments.
 *
 * The first call's arguments show what prompted the session-wide request.
 * They are model-authored and about to be drawn into a terminal, so they are
 * sanitized before truncation, never after.
 */
function describeInput(input: unknown): string {
  if (input === undefined || input === null) return "(no arguments)";
  let rendered: string;
  try {
    rendered = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    return "(arguments could not be displayed)";
  }
  if (!rendered) return "(no arguments)";
  return truncateCodePoints(sanitizeDisplayText(rendered).replace(/\s+/g, " ").trim(), MAX_PREVIEW, "…");
}
