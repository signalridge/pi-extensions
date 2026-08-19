/**
 * supervisor.ts — `contact_supervisor`, the child→parent direction.
 *
 * `steer_subagent` sends guidance downward. Nothing sent anything upward: a
 * subagent that hit a genuine fork in the road could only guess, finish wrong,
 * and have the guess discovered later in its result.
 *
 * The answer comes from the HUMAN, not from a supervising model. Our subagents
 * share the parent's `ExtensionContext`, so the parent's UI is directly
 * reachable — asking the person who is sitting there is both cheaper and more
 * correct than delegating the judgement to another model, and it is the same
 * reason this package has no LLM arbitrator anywhere else.
 *
 * That reachability is also why this is ~80 lines rather than a filesystem
 * channel with a poller on each end: in-process, the question is one promise.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { sanitizeDisplayText, truncateCodePoints } from "./ui/safe-text.js";

/** Longest question a child may put to the parent, in characters. */
const MAX_QUESTION = 2_000;
/** Longest option label offered in a choice prompt. */
const MAX_OPTION = 200;
/** Most options a child may offer, so the picker stays usable. */
const MAX_OPTIONS = 8;

export interface SupervisorAsk {
  /** Prompt the human with a free-text question; undefined = dismissed. */
  input(title: string, placeholder?: string): Promise<string | undefined>;
  /** Prompt the human to pick one option; undefined = dismissed. */
  select(title: string, options: string[]): Promise<string | undefined>;
}

export interface SupervisorToolContext {
  /** The parent's UI. Omitted when there is no human to ask. */
  ask?: SupervisorAsk;
  /** Display name of the asking agent, for the prompt title. */
  agentLabel: string;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError, details: {} };
}

/**
 * Build the `contact_supervisor` tool, or nothing when no human can answer.
 *
 * Returning an empty array rather than a tool that always fails is deliberate,
 * and matches how nested tools are handled: injecting a tool whose every call
 * is an error spends context to teach the model an affordance it does not have.
 * Headless and RPC sessions therefore see no such tool at all.
 */
export function createSupervisorTool(context: SupervisorToolContext) {
  if (!context.ask) return [];
  const ask = context.ask;

  return [
    defineTool({
      name: "contact_supervisor",
      label: "Ask Supervisor",
      description:
        "Ask the human who started you a question and wait for their answer. Use ONLY for a decision you cannot make yourself and cannot defer: an ambiguous requirement where the readings lead to materially different work, a destructive step that needs confirmation, or missing information nothing available to you can supply. It interrupts a person, so prefer stating an assumption and continuing. Returns their answer, or tells you they declined — in which case proceed on your best judgement and say what you assumed.",
      parameters: Type.Object({
        question: Type.String({
          description: "The question, self-contained. The human cannot see your conversation.",
          maxLength: MAX_QUESTION,
        }),
        options: Type.Optional(
          Type.Array(Type.String({ maxLength: MAX_OPTION }), {
            description: `Offer up to ${MAX_OPTIONS} concrete choices instead of free text. Prefer this when the answers are known.`,
            maxItems: MAX_OPTIONS,
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        // Both the question and any option labels are model-authored text about
        // to be drawn into the user's terminal, so they are sanitized and
        // bounded here — the same treatment any other child-supplied string
        // gets before it reaches a UI surface.
        const question = truncateCodePoints(sanitizeDisplayText(params.question), MAX_QUESTION, "…").trim();
        if (!question) return textResult("Ask a non-empty question.", true);

        const title = `${context.agentLabel} asks`;
        const options = (params.options ?? [])
          .map((option) => truncateCodePoints(sanitizeDisplayText(option), MAX_OPTION, "…").trim())
          .filter((option) => option.length > 0)
          .slice(0, MAX_OPTIONS);

        let answer: string | undefined;
        try {
          answer =
            options.length > 0
              ? await ask.select(`${title}: ${question}`, options)
              : await ask.input(title, question);
        } catch (error: unknown) {
          // A dialog that cannot open must not fail the child's whole run; it
          // is told nobody answered and carries on under its own judgement.
          return textResult(
            `Could not reach the supervisor (${error instanceof Error ? error.message : String(error)}). Proceed on your best judgement and state the assumption you made.`,
          );
        }

        const reply = answer?.trim();
        if (!reply) {
          return textResult(
            "The supervisor did not answer. Proceed on your best judgement and state the assumption you made.",
          );
        }
        return textResult(`Supervisor answered: ${reply}`);
      },
    }),
  ];
}
