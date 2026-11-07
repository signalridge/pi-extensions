/**
 * supervisor.ts — `contact_supervisor`, the child→parent direction.
 *
 * `steer_subagent` sends guidance downward. This sends one bounded question
 * upward, to the MAIN AGENT through parent-questions.ts — never to the human.
 * A child sees only its own task, so it cannot judge whether a gap is a real
 * user decision or an internal coordination failure (a missing file, an
 * unavailable report, a failed handoff). The main agent can: it resolves what
 * it can itself and decides whether, and how, to ask the user.
 *
 * Only a fresh, non-isolated, top-level background Agent gets the channel, and
 * only while the Supervisor questions setting is on. Every other child gets no
 * tool and reports blockers in its final result. Permission/approval tools are
 * unaffected: they still reach the human through their own gates.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ParentQuestionHandler } from "./parent-questions.js";

/** Longest question a child may put to the main agent, in characters. */
const MAX_QUESTION = 2_000;
/** Longest option label offered in a choice question. */
const MAX_OPTION = 200;
/** Most options a child may offer. */
const MAX_OPTIONS = 8;

/** @deprecated Compatibility type only; child-to-human clarification is disabled. */
export interface SupervisorAsk {
  input(title: string, placeholder?: string): Promise<string | undefined>;
  select(title: string, options: string[]): Promise<string | undefined>;
}

export interface SupervisorToolContext {
  /** @deprecated Ignored; never called or used as a human fallback. */
  ask?: SupervisorAsk;
  /** @deprecated Ignored; retained for source-level callers. */
  agentLabel?: string;
  /** Manager-issued background-only clarification channel, not approval. */
  parentQuestion?: ParentQuestionHandler;
}

/**
 * Build `contact_supervisor`, or nothing without a manager-issued channel.
 *
 * Returning an empty array rather than a tool that always fails is deliberate,
 * and matches how nested tools are handled: injecting a tool whose every call
 * is an error spends context to teach the model an affordance it does not have.
 */
export function createSupervisorTool(context: SupervisorToolContext) {
  const parentQuestion = context.parentQuestion;
  if (!parentQuestion) return [];

  return [
    defineTool({
      name: "contact_supervisor",
      label: "Ask Supervisor",
      description: "Ask the main agent an ordinary task clarification and await its answer. Only use for missing information or ambiguous requirements you cannot resolve or defer. Never use this channel for permission, destructive-action confirmation, or approval; the main agent cannot authorize new actions or override a human denial. Prefer stating an assumption and continuing. A timeout, cancellation, or decline is no answer, not approval.",
      parameters: Type.Object({
        question: Type.String({
          description: "A self-contained ordinary clarification. Only this explicit bounded question reaches the main agent; do not include credentials or request permission.",
          maxLength: MAX_QUESTION,
        }),
        options: Type.Optional(
          Type.Array(Type.String({ maxLength: MAX_OPTION }), {
            description: `Offer up to ${MAX_OPTIONS} concrete choices instead of free text. Prefer this when the answers are known.`,
            maxItems: MAX_OPTIONS,
          }),
        ),
      }),
      execute: async (_toolCallId, params, signal) => {
        const reply = await parentQuestion(params.question, params.options, signal);
        return {
          content: [{ type: "text" as const, text: reply.status === "answered"
            ? `${params.options?.length ? "Main agent selected child-authored option" : "Main agent clarification"} (NOT human approval or a permission grant): ${reply.answer}`
            : `No answer (${reply.reason}). Proceed only within existing authorization, state any safe assumption, or stop and report the blocker in your final result if human authorization is required.` }],
          details: reply,
        };
      },
    }),
  ];
}
