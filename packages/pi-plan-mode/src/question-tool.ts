import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PLAN_MODE_QUESTION_TOOL_NAME = "plan_mode_question";

export type PlanModeQuestionOption = {
  label: string;
  description?: string;
};

export type PlanModeQuestion = {
  id: string;
  header: string;
  question: string;
  options: PlanModeQuestionOption[];
};

type PlanModeQuestionAnswer = {
  id: string;
  header: string;
  question: string;
  answer: string;
  wasCustom: boolean;
  optionIndex?: number;
};

type PlanModeQuestionReason = "cancelled" | "ui_unavailable" | "plan_mode_inactive" | "invalid_input";

type PlanModeQuestionDetails = {
  cancelled: boolean;
  reason?: PlanModeQuestionReason;
  questions: PlanModeQuestion[];
  answers?: PlanModeQuestionAnswer[];
};

export const PLAN_MODE_QUESTION_PARAMS = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      description: "Questions to show the user. Prefer 1 and do not exceed 3.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "header", "question", "options"],
        properties: {
          id: {
            type: "string",
            description: "Stable identifier for mapping answers (snake_case).",
          },
          header: {
            type: "string",
            description: "Short header label shown in the UI (12 or fewer chars).",
          },
          question: { type: "string", description: "Single-sentence prompt shown to the user." },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            description:
              "Provide 2-4 mutually exclusive choices. Put the recommended option first when there is a clear default.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "description"],
              properties: {
                label: { type: "string", description: "User-facing label (1-5 words)." },
                description: {
                  type: "string",
                  description: "One short sentence explaining impact/tradeoff if selected.",
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

type NormalizePlanModeQuestionParamsResult = { ok: true; questions: PlanModeQuestion[] } | { ok: false; error: string };

export function normalizePlanModeQuestionParams(input: unknown): NormalizePlanModeQuestionParamsResult {
  if (!isRecord(input) || !Array.isArray(input.questions)) {
    return { ok: false, error: "questions must be an array" };
  }
  if (input.questions.length < 1 || input.questions.length > 3) {
    return { ok: false, error: "questions must contain 1-3 items" };
  }

  const questions: PlanModeQuestion[] = [];
  for (const [questionIndex, rawQuestion] of input.questions.entries()) {
    if (!isRecord(rawQuestion)) {
      return { ok: false, error: `question ${questionIndex + 1} must be an object` };
    }
    const id = stringField(rawQuestion.id);
    const header = stringField(rawQuestion.header);
    const question = stringField(rawQuestion.question);
    if (!id || !header || !question) {
      return {
        ok: false,
        error: `question ${questionIndex + 1} requires non-empty id, header, and question`,
      };
    }
    if (!Array.isArray(rawQuestion.options)) {
      return { ok: false, error: `question ${questionIndex + 1} options must be an array` };
    }
    if (rawQuestion.options.length < 2 || rawQuestion.options.length > 4) {
      return { ok: false, error: `question ${questionIndex + 1} options must contain 2-4 items` };
    }
    const options: PlanModeQuestionOption[] = [];
    for (const [optionIndex, rawOption] of rawQuestion.options.entries()) {
      if (!isRecord(rawOption)) {
        return {
          ok: false,
          error: `question ${questionIndex + 1} option ${optionIndex + 1} must be an object`,
        };
      }
      const label = stringField(rawOption.label);
      if (!label) {
        return {
          ok: false,
          error: `question ${questionIndex + 1} option ${optionIndex + 1} requires a label`,
        };
      }
      const description = stringField(rawOption.description);
      if (!description) {
        return {
          ok: false,
          error: `question ${questionIndex + 1} option ${optionIndex + 1} requires a description`,
        };
      }
      options.push({ label, description });
    }
    questions.push({ id, header, question, options });
  }
  return { ok: true, questions };
}

export async function answerPlanModeQuestions(
  questions: PlanModeQuestion[],
  ctx: ExtensionContext,
  lifecycle: { isCurrent(): boolean; isEnabled(): boolean },
) {
  const answers = await askPlanModeQuestions(questions, ctx, () => lifecycle.isCurrent() && lifecycle.isEnabled());
  if (!lifecycle.isCurrent()) {
    return planModeQuestionCancelled(
      questions,
      "cancelled",
      "Plan-mode question cancelled because the session changed.",
    );
  }
  if (!lifecycle.isEnabled()) {
    return planModeQuestionCancelled(
      questions,
      "plan_mode_inactive",
      "Plan-mode question cancelled because Plan mode is no longer active.",
    );
  }
  if (!answers) {
    return planModeQuestionCancelled(questions, "cancelled", "User cancelled the Plan-mode question prompt.");
  }
  return planModeQuestionAnswered(questions, answers);
}

/** Shown when more than one question is being asked, so the run has an end in sight. */
const BACK_CHOICE = "← Back (change the previous answer)";

/**
 * Ask a batch of questions as a paged sequence rather than a one-way run.
 *
 * The questions arrive together and are answered one screen at a time, which is
 * the right shape — a single screen holding four multi-option questions does not
 * fit a terminal. What the one-way loop lacked was everything that makes a
 * sequence navigable: no sense of how many were left, and no way back, so a
 * misread option could only be fixed by cancelling the whole batch and making
 * the model ask again.
 *
 * Answers are therefore held BY POSITION, not appended: stepping back and
 * choosing again overwrites that slot instead of leaving a stale answer behind
 * a corrected one. Cancellation semantics are unchanged — `undefined` still
 * means "the user backed out", and `shouldContinue()` is still consulted after
 * every await, since plan mode can end while a prompt is open.
 */
export async function askPlanModeQuestions(
  questions: PlanModeQuestion[],
  ctx: ExtensionContext,
  shouldContinue: () => boolean = () => true,
): Promise<PlanModeQuestionAnswer[] | undefined> {
  const answers: (PlanModeQuestionAnswer | undefined)[] = new Array(questions.length).fill(undefined);
  // A single question has nothing to page through, so it keeps the plain title
  // and gains no Back affordance that would only ever cancel.
  const paged = questions.length > 1;

  let index = 0;
  while (index < questions.length) {
    const question = questions[index];
    if (!question) return undefined;
    const choices = question.options.map(formatPlanModeQuestionChoice);
    const otherChoice = `${question.options.length + 1}. Other (free-form)`;
    const options = [...choices, otherChoice, ...(paged && index > 0 ? [BACK_CHOICE] : [])];
    const position = paged ? `[${index + 1}/${questions.length}] ` : "";
    const choice = await ctx.ui.select(`${position}${question.header}: ${question.question}`, options);
    if (!shouldContinue() || !choice) return undefined;

    if (choice === BACK_CHOICE) {
      // The answer being revised is dropped now rather than on re-answer, so a
      // cancel from the previous screen cannot leave a half-corrected batch.
      index -= 1;
      answers[index] = undefined;
      continue;
    }

    if (choice === otherChoice) {
      const customAnswer = (await ctx.ui.editor(question.question, ""))?.trim();
      if (!shouldContinue()) return undefined;
      // An empty free-form answer returns to this question rather than
      // cancelling the batch: opening the editor and thinking better of it is
      // a correction, not a decision to abandon everything already answered.
      if (!customAnswer) continue;
      answers[index] = {
        id: question.id,
        header: question.header,
        question: question.question,
        answer: customAnswer,
        wasCustom: true,
      };
      index += 1;
      continue;
    }

    const optionIndex = choices.indexOf(choice);
    const option = question.options[optionIndex];
    if (!option) return undefined;
    answers[index] = {
      id: question.id,
      header: question.header,
      question: question.question,
      answer: option.label,
      wasCustom: false,
      optionIndex: optionIndex + 1,
    };
    index += 1;
  }

  // Every slot is filled: the loop only advances past a question after writing
  // one, and stepping back clears exactly the slot it returns to.
  return answers.filter((answer): answer is PlanModeQuestionAnswer => answer !== undefined);
}

function formatPlanModeQuestionChoice(option: PlanModeQuestionOption, index: number) {
  return `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`;
}

export function planModeQuestionAnswered(questions: PlanModeQuestion[], answers: PlanModeQuestionAnswer[]) {
  return {
    content: [{ type: "text" as const, text: formatPlanModeQuestionPayload({ cancelled: false, answers }) }],
    details: { cancelled: false, questions, answers } satisfies PlanModeQuestionDetails,
  };
}

export function planModeQuestionCancelled(
  questions: PlanModeQuestion[],
  reason: PlanModeQuestionReason,
  message: string,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: formatPlanModeQuestionPayload({ cancelled: true, reason, message }),
      },
    ],
    details: { cancelled: true, reason, questions } satisfies PlanModeQuestionDetails,
  };
}

function formatPlanModeQuestionPayload(payload: {
  cancelled: boolean;
  reason?: PlanModeQuestionReason;
  message?: string;
  answers?: PlanModeQuestionAnswer[];
}) {
  return JSON.stringify(payload, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: unknown) {
  return typeof value === "string" ? value.trim() : undefined;
}
