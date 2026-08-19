/**
 * ask-tools.ts — `ask_tools:`, the third answer between allow and deny.
 *
 * `tools:` and `disallowed_tools:` are static: a tool is available for the whole
 * run or never. That forces a bad choice for the tools that are usually fine and
 * occasionally not — grant `bash` and hope, or withhold it and cripple the
 * agent. `ask_tools:` names the tools whose every call needs a person to agree.
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
 * Build the per-call approval gate, or `undefined` when nothing needs asking.
 *
 * Returns a function that resolves to a block decision when the call must not
 * proceed, and `undefined` when it may.
 */
export function createAskGate(
  context: AskGateContext,
): ((toolName: string, input: unknown) => Promise<AskGateDecision | undefined>) | undefined {
  const gated = new Set(context.askTools.map((name) => name.trim().toLowerCase()).filter(Boolean));
  if (gated.size === 0) return undefined;

  /** Tools the user has approved for the rest of this run. */
  const approvedForRun = new Set<string>();

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

    let approved: boolean;
    try {
      approved = await context.confirm(
        `${context.agentLabel} wants to use ${toolName}`,
        `${describeInput(input)}\n\nAllow this call?`,
      );
    } catch {
      // A prompt that cannot be shown is not an approval.
      return {
        block: true,
        reason: `Tool "${toolName}" requires approval (ask_tools) and the prompt could not be shown.`,
      };
    }

    if (!approved) {
      return {
        block: true,
        reason: `The user declined the "${toolName}" call. Do not retry it; continue without that tool or explain what you cannot do.`,
      };
    }
    // Approved for the remainder of the run rather than for this call alone:
    // re-asking on every call of a tool the user just allowed trains them to
    // approve without reading, which is how an approval prompt stops working.
    approvedForRun.add(key);
    return undefined;
  };
}

/**
 * One-line, bounded, inert rendering of a tool call's arguments.
 *
 * The user is being asked to approve a specific call, so the arguments are the
 * whole point — but they are model-authored and about to be drawn into a
 * terminal, so they are sanitized before truncation, never after.
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
